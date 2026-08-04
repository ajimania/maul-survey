-- 함양 to 남가좌 팝업 · 사전 수요조사 (hamyang-interest.html)
--
-- 함양 인지도 조사에 이메일을 남긴 분들께 보내는 안내 메일의 도착 페이지입니다.
-- 마공 가족용 사전주문(hamyang_preorder)과 달리 **정원·마감이 없습니다.**
-- 예약이 아니라 "얼마나 준비할지" 가늠하는 수요조사이므로 수량 검사도 하지 않습니다.
--
-- ⚠️ 기존 hamyang_survey / hamyang_popup / hamyang_preorder 는 일절 건드리지 않습니다.
-- Supabase SQL Editor에 전체를 붙여넣고 실행하세요. 여러 번 실행해도 안전합니다.


-- ─────────────────────────────────────────────
-- 1) 테이블
-- ─────────────────────────────────────────────
create table if not exists public.hamyang_interest (
  id         bigint generated always as identity primary key,
  created_at timestamptz not null default now()
);

alter table public.hamyang_interest add column if not exists pickup_date  date;   -- null = 아직 못 정함
alter table public.hamyang_interest add column if not exists qty_emotion  int  default 0;  -- 정서함양
alter table public.hamyang_interest add column if not exists qty_energy   int  default 0;  -- 체력함양
alter table public.hamyang_interest add column if not exists est_price    int;             -- 9,500 × 총 수량 (참고용)
alter table public.hamyang_interest add column if not exists party_size   int;             -- 함께 오는 인원
alter table public.hamyang_interest add column if not exists name         text;
alter table public.hamyang_interest add column if not exists phone        text;
alter table public.hamyang_interest add column if not exists status       text default 'open'; -- open | came | closed
alter table public.hamyang_interest add column if not exists src          text;            -- 유입 구분 (?src=mail 등)

create index if not exists hamyang_interest_date_idx    on public.hamyang_interest (pickup_date);
create index if not exists hamyang_interest_created_idx on public.hamyang_interest (created_at desc);

-- RLS 켜고 정책은 두지 않습니다 → 익명 키로 직접 읽기·쓰기 불가.
-- 저장은 아래 함수로만, 조회는 아래 뷰로만 이뤄집니다.
alter table public.hamyang_interest enable row level security;


-- ─────────────────────────────────────────────
-- 2) 저장 함수 — 정원 검사 없음. 값 검증만 합니다
-- ─────────────────────────────────────────────
create or replace function public.hamyang_interest_create(
  p_date    date default null,
  p_emotion int  default 0,
  p_energy  int  default 0,
  p_name    text default null,
  p_phone   text default null,
  p_party   int  default null,
  p_src     text default null
) returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id bigint;
  v_name  text := btrim(coalesce(p_name, ''));
  v_phone text := btrim(coalesce(p_phone, ''));
begin
  p_emotion := coalesce(p_emotion, 0);
  p_energy  := coalesce(p_energy,  0);

  if p_emotion < 0 or p_energy < 0 or p_emotion > 20 or p_energy > 20 then
    return json_build_object('ok', false, 'error', 'bad_qty');
  end if;
  if p_emotion + p_energy = 0 then
    return json_build_object('ok', false, 'error', 'empty');
  end if;
  if v_name = '' or v_phone = '' then
    return json_build_object('ok', false, 'error', 'no_contact');
  end if;
  if length(v_name) > 40 or length(v_phone) > 40 then
    return json_build_object('ok', false, 'error', 'too_long');
  end if;
  if p_party is not null and (p_party < 1 or p_party > 20) then
    return json_build_object('ok', false, 'error', 'bad_party');
  end if;

  insert into public.hamyang_interest
    (pickup_date, qty_emotion, qty_energy, est_price, party_size, name, phone, src)
  values
    (p_date, p_emotion, p_energy, (p_emotion + p_energy) * 9500, p_party,
     v_name, v_phone, nullif(btrim(coalesce(p_src, '')), ''))
  returning id into v_id;

  return json_build_object('ok', true, 'id', v_id);
end $$;

revoke all on function public.hamyang_interest_create(date, int, int, text, text, int, text) from public;
grant execute on function public.hamyang_interest_create(date, int, int, text, text, int, text) to anon, authenticated;


-- ─────────────────────────────────────────────
-- 3) 운영자 명단용 뷰
--    ⚠️ 익명 읽기가 열립니다. 여기는 모르는 분들의 연락처가 들어오므로
--       **연락처는 뒤 4자리만** 남기고 가립니다. 전체 번호는 대시보드에서만 보세요.
-- ─────────────────────────────────────────────
drop view if exists public.hamyang_interest_list;
create view public.hamyang_interest_list
with (security_invoker = off) as
  select
    id, created_at, pickup_date, qty_emotion, qty_energy, est_price, party_size, name, status,
    case
      when phone is null or btrim(phone) = '' then null
      else '···' || right(regexp_replace(phone, '[^0-9]', '', 'g'), 4)
    end as phone_tail
  from public.hamyang_interest;

grant select on public.hamyang_interest_list to anon, authenticated;


-- ─────────────────────────────────────────────
-- 4) 운영자 전용 — 익명 접근 없음. 전체 연락처는 여기서만
-- ─────────────────────────────────────────────
drop view if exists public.hamyang_interest_admin;
create view public.hamyang_interest_admin as
  select id, created_at, pickup_date,
         qty_emotion, qty_energy, (coalesce(qty_emotion,0) + coalesce(qty_energy,0)) as qty_total,
         est_price, party_size, name, phone, status, src
    from public.hamyang_interest
   order by pickup_date nulls last, created_at;

-- 날짜별 수요 한눈에 보기:
--   select coalesce(pickup_date::text, '미정') as 날짜, count(*) 건수,
--          sum(qty_emotion) 정서, sum(qty_energy) 체력, sum(party_size) 인원
--     from public.hamyang_interest group by 1 order by 1;
