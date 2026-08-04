-- 남가좌 × 함양 팝업 · 마을공동체 사전주문 (hamyang-preorder.html)
--
-- ⚠️ 기존 hamyang_survey / hamyang_popup 테이블·뷰·정책은 일절 건드리지 않습니다.
--    이 파일이 만드는 것은 아래 5개뿐입니다.
--      table  hamyang_preorder_slot     날짜별 판매 가능 수량 (운영자가 여기서 조절)
--      table  hamyang_preorder          주문 1건 = 1행 (이름·연락처 포함, 익명 접근 차단)
--      view   hamyang_preorder_slots    날짜별 잔여 수량만 공개
--      func   hamyang_preorder_create   잔여 확인 + 저장을 한 번에 (초과 주문 차단)
--      view   hamyang_preorder_admin    운영자용 주문 목록 (익명 접근 없음)
--
-- Supabase SQL Editor에 전체를 붙여넣고 실행하세요. 여러 번 실행해도 안전합니다.


-- ─────────────────────────────────────────────
-- 1) 날짜별 정원
-- ─────────────────────────────────────────────
create table if not exists public.hamyang_preorder_slot (
  pickup_date date primary key,
  cap_emotion int  not null default 5,   -- 정서함양 하루 정원
  cap_energy  int  not null default 5,   -- 체력함양 하루 정원
  is_open     boolean not null default true,
  sort        int  not null default 0
);

insert into public.hamyang_preorder_slot (pickup_date, cap_emotion, cap_energy, sort) values
  ('2026-08-07', 5, 5, 1),
  ('2026-08-08', 5, 5, 2),
  ('2026-08-11', 5, 5, 3),
  ('2026-08-12', 5, 5, 4),
  ('2026-08-13', 5, 5, 5)
on conflict (pickup_date) do nothing;

-- 정원을 바꾸려면:  update public.hamyang_preorder_slot set cap_emotion = 8 where pickup_date = '2026-08-08';
-- 하루를 닫으려면:  update public.hamyang_preorder_slot set is_open = false where pickup_date = '2026-08-11';


-- ─────────────────────────────────────────────
-- 2) 주문 테이블
-- ─────────────────────────────────────────────
create table if not exists public.hamyang_preorder (
  id         bigint generated always as identity primary key,
  created_at timestamptz not null default now()
);

alter table public.hamyang_preorder add column if not exists pickup_date  date;
alter table public.hamyang_preorder add column if not exists qty_emotion  int  default 0;   -- 정서함양
alter table public.hamyang_preorder add column if not exists qty_energy   int  default 0;   -- 체력함양
alter table public.hamyang_preorder add column if not exists total_price  int;              -- 9,500 × 총 수량
alter table public.hamyang_preorder add column if not exists name         text;
alter table public.hamyang_preorder add column if not exists phone        text;
alter table public.hamyang_preorder add column if not exists community    text;             -- 소속 모임 (선택)
alter table public.hamyang_preorder add column if not exists note         text;             -- 남길 말 (선택)
alter table public.hamyang_preorder add column if not exists status       text default 'pending'; -- pending | picked | canceled
alter table public.hamyang_preorder add column if not exists src          text;             -- 유입 구분 (?src=)

create index if not exists hamyang_preorder_date_idx    on public.hamyang_preorder (pickup_date);
create index if not exists hamyang_preorder_created_idx on public.hamyang_preorder (created_at desc);

-- RLS 켜고 정책은 하나도 두지 않습니다.
-- → 익명 키로는 이 테이블을 읽지도 쓰지도 못합니다. 저장은 아래 함수를 통해서만 일어납니다.
alter table public.hamyang_preorder      enable row level security;
alter table public.hamyang_preorder_slot enable row level security;


-- ─────────────────────────────────────────────
-- 3) 잔여 수량 공개 뷰 — 날짜·정원·남은 개수만. 개인정보 없음
-- ─────────────────────────────────────────────
drop view if exists public.hamyang_preorder_slots;
create view public.hamyang_preorder_slots
with (security_invoker = off) as
  select
    s.pickup_date,
    s.is_open,
    s.cap_emotion,
    s.cap_energy,
    greatest(s.cap_emotion - coalesce(o.e, 0), 0) as left_emotion,
    greatest(s.cap_energy  - coalesce(o.n, 0), 0) as left_energy,
    s.sort
  from public.hamyang_preorder_slot s
  left join (
    select pickup_date,
           sum(coalesce(qty_emotion, 0)) as e,
           sum(coalesce(qty_energy,  0)) as n
      from public.hamyang_preorder
     where coalesce(status, 'pending') <> 'canceled'
     group by pickup_date
  ) o on o.pickup_date = s.pickup_date;

grant select on public.hamyang_preorder_slots to anon, authenticated;


-- ─────────────────────────────────────────────
-- 4) 주문 저장 함수 — 잔여 확인과 저장이 한 트랜잭션 안에서 일어납니다
--    같은 날짜에 대해 잠금을 걸므로, 두 사람이 동시에 마지막 한 개를 눌러도 한 명만 성공합니다
-- ─────────────────────────────────────────────
create or replace function public.hamyang_preorder_create(
  p_date      date,
  p_emotion   int,
  p_energy    int,
  p_name      text,
  p_phone     text default null,   -- 현재 페이지는 보내지 않음 (운영자가 나중에 채울 수 있게 컬럼만 남김)
  p_community text default null,
  p_note      text default null,
  p_src       text default null
) returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_slot public.hamyang_preorder_slot%rowtype;
  v_e int; v_n int; v_id bigint;
  v_name text := btrim(coalesce(p_name, ''));
  v_phone text := btrim(coalesce(p_phone, ''));
begin
  p_emotion := coalesce(p_emotion, 0);
  p_energy  := coalesce(p_energy,  0);

  if p_emotion < 0 or p_energy < 0 then
    return json_build_object('ok', false, 'error', 'bad_qty');
  end if;
  if p_emotion + p_energy = 0 then
    return json_build_object('ok', false, 'error', 'empty');
  end if;
  if p_emotion > 5 or p_energy > 5 then
    return json_build_object('ok', false, 'error', 'bad_qty');
  end if;
  if v_name = '' then
    return json_build_object('ok', false, 'error', 'no_contact');
  end if;
  if length(v_name) > 40 or length(v_phone) > 40
     or length(coalesce(p_community, '')) > 60
     or length(coalesce(p_note, '')) > 300 then
    return json_build_object('ok', false, 'error', 'too_long');
  end if;

  select * into v_slot from public.hamyang_preorder_slot where pickup_date = p_date;
  if not found or not v_slot.is_open then
    return json_build_object('ok', false, 'error', 'closed');
  end if;

  -- 이 날짜에 대해 줄을 세운다
  perform pg_advisory_xact_lock(hashtext('hamyang_preorder:' || p_date::text));

  select coalesce(sum(coalesce(qty_emotion, 0)), 0),
         coalesce(sum(coalesce(qty_energy,  0)), 0)
    into v_e, v_n
    from public.hamyang_preorder
   where pickup_date = p_date
     and coalesce(status, 'pending') <> 'canceled';

  if p_emotion > v_slot.cap_emotion - v_e or p_energy > v_slot.cap_energy - v_n then
    return json_build_object(
      'ok', false, 'error', 'sold_out',
      'left_emotion', greatest(v_slot.cap_emotion - v_e, 0),
      'left_energy',  greatest(v_slot.cap_energy  - v_n, 0));
  end if;

  insert into public.hamyang_preorder
    (pickup_date, qty_emotion, qty_energy, total_price, name, phone, community, note, src)
  values
    (p_date, p_emotion, p_energy, (p_emotion + p_energy) * 9500,
     v_name, nullif(v_phone, ''),
     nullif(btrim(coalesce(p_community, '')), ''),
     nullif(btrim(coalesce(p_note, '')), ''),
     nullif(btrim(coalesce(p_src, '')), ''))
  returning id into v_id;

  return json_build_object(
    'ok', true, 'id', v_id,
    'left_emotion', v_slot.cap_emotion - v_e - p_emotion,
    'left_energy',  v_slot.cap_energy  - v_n - p_energy);
end $$;

revoke all on function public.hamyang_preorder_create(date, int, int, text, text, text, text, text) from public;
grant execute on function public.hamyang_preorder_create(date, int, int, text, text, text, text, text) to anon, authenticated;


-- ─────────────────────────────────────────────
-- 5) 운영자용 — 익명 접근 없음. 대시보드에서만 보입니다
-- ─────────────────────────────────────────────
drop view if exists public.hamyang_preorder_admin;
create view public.hamyang_preorder_admin as
  select id, created_at, pickup_date,
         qty_emotion, qty_energy, (coalesce(qty_emotion,0) + coalesce(qty_energy,0)) as qty_total,
         total_price, name, phone, community, note, status, src
    from public.hamyang_preorder
   order by pickup_date, created_at;

-- 날짜별 준비 수량 한눈에 보기:
--   select pickup_date, sum(qty_emotion) 정서, sum(qty_energy) 체력, sum(total_price) 금액
--     from public.hamyang_preorder where status <> 'canceled' group by 1 order by 1;


-- ─────────────────────────────────────────────
-- 6) 운영자 페이지(hamyang-preorder-admin.html)용
--    ⚠️ 이 뷰는 익명 읽기가 열립니다. 이름·수량·상태만 나가고 연락처 컬럼은 뺐습니다.
--       비밀번호 없이 링크만으로 보는 화면이라 의도된 개방입니다.
-- ─────────────────────────────────────────────
drop view if exists public.hamyang_preorder_list;
create view public.hamyang_preorder_list
with (security_invoker = off) as
  select id, created_at, pickup_date, qty_emotion, qty_energy, total_price, name, status
    from public.hamyang_preorder;

grant select on public.hamyang_preorder_list to anon, authenticated;

-- 운영자 페이지에서 상태만 바꾸는 함수 (수령완료 / 취소 / 되돌리기)
create or replace function public.hamyang_preorder_set_status(
  p_id     bigint,
  p_status text
) returns json
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_status not in ('pending', 'picked', 'canceled') then
    return json_build_object('ok', false, 'error', 'bad_status');
  end if;
  update public.hamyang_preorder set status = p_status where id = p_id;
  if not found then
    return json_build_object('ok', false, 'error', 'not_found');
  end if;
  return json_build_object('ok', true);
end $$;

revoke all on function public.hamyang_preorder_set_status(bigint, text) from public;
grant execute on function public.hamyang_preorder_set_status(bigint, text) to anon, authenticated;
