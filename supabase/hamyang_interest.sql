-- 함양 to 남가좌 팝업 · 메일 수신자용 예약 (hamyang-interest.html)
--
-- 수요조사에서 **예약**으로 바뀌었습니다.
--   · 정원은 마공 사전주문(hamyang_preorder_slot)과 별개로 둡니다
--   · 1인당 총 2개까지 (종류 무관)
--   · 이름 + 전화번호를 받습니다
--
-- ⚠️ 기존 hamyang_survey / hamyang_popup / hamyang_preorder 는 일절 건드리지 않습니다.
-- 여러 번 실행해도 안전합니다.


-- ── 1) 날짜별 정원 (이 페이지 전용) ──────────────────
create table if not exists public.hamyang_interest_slot (
  pickup_date date primary key,
  cap_emotion int not null default 5,
  cap_energy  int not null default 5,
  is_open     boolean not null default true,
  sort        int not null default 0
);

insert into public.hamyang_interest_slot (pickup_date, cap_emotion, cap_energy, sort) values
  ('2026-08-07', 5, 5, 1), ('2026-08-08', 5, 5, 2), ('2026-08-11', 5, 5, 3),
  ('2026-08-12', 5, 5, 4), ('2026-08-13', 5, 5, 5)
on conflict (pickup_date) do nothing;

-- 정원 조절:  update public.hamyang_interest_slot set cap_emotion = 8 where pickup_date = '2026-08-08';
-- 하루 닫기:  update public.hamyang_interest_slot set is_open = false where pickup_date = '2026-08-11';

alter table public.hamyang_interest_slot enable row level security;


-- ── 2) 예약 테이블 정리 ──────────────────────────────
-- 수요조사 때 들어온 데이터는 성격이 달라 비웁니다.
truncate table public.hamyang_interest restart identity;

-- 함수로만 저장하도록 익명 insert 정책을 거둡니다 (정원 초과 방지)
drop policy if exists "anon can insert" on public.hamyang_interest;

alter table public.hamyang_interest drop constraint if exists hamyang_interest_sane;
alter table public.hamyang_interest add constraint hamyang_interest_sane check (name is not null and phone is not null and length(btrim(name)) between 1 and 40 and length(btrim(phone)) between 1 and 40 and pickup_date is not null and qty_emotion >= 0 and qty_energy >= 0 and qty_emotion + qty_energy between 1 and 2 and (party_size is null or party_size between 1 and 20));


-- ── 3) 잔여 수량 공개 뷰 ─────────────────────────────
drop view if exists public.hamyang_interest_slots;
create view public.hamyang_interest_slots
with (security_invoker = off) as
  select s.pickup_date, s.is_open, s.cap_emotion, s.cap_energy, s.sort,
         greatest(s.cap_emotion - coalesce(o.e, 0), 0) as left_emotion,
         greatest(s.cap_energy  - coalesce(o.n, 0), 0) as left_energy
    from public.hamyang_interest_slot s
    left join (select pickup_date, sum(coalesce(qty_emotion,0)) e, sum(coalesce(qty_energy,0)) n
                 from public.hamyang_interest
                where coalesce(status,'open') <> 'canceled'
                group by pickup_date) o on o.pickup_date = s.pickup_date;

grant select on public.hamyang_interest_slots to anon, authenticated;


-- ── 4) 명단 뷰 (연락처는 뒤 4자리만) ─────────────────
drop view if exists public.hamyang_interest_list;
create view public.hamyang_interest_list
with (security_invoker = off) as
  select id, created_at, pickup_date, qty_emotion, qty_energy, party_size, name, status,
         case when phone is null or btrim(phone) = '' then null
              else '···' || right(regexp_replace(phone, '[^0-9]', '', 'g'), 4) end as phone_tail
    from public.hamyang_interest;

grant select on public.hamyang_interest_list to anon, authenticated;


-- ── 5) 예약 저장 함수 (정원 확인 + 저장을 한 번에) ───
create or replace function public.hamyang_interest_reserve(
  p_date date, p_emotion int, p_energy int,
  p_name text, p_phone text, p_party int default null, p_src text default null
) returns json
language plpgsql security definer set search_path = public as $$
declare
  v_slot public.hamyang_interest_slot%rowtype;
  v_e int; v_n int; v_id bigint;
  v_name text := btrim(coalesce(p_name, ''));
  v_phone text := btrim(coalesce(p_phone, ''));
begin
  p_emotion := coalesce(p_emotion, 0);
  p_energy := coalesce(p_energy, 0);
  if p_emotion < 0 or p_energy < 0 or p_emotion + p_energy not between 1 and 2 then
    return json_build_object('ok', false, 'error', 'bad_qty');
  end if;
  if v_name = '' or v_phone = '' then
    return json_build_object('ok', false, 'error', 'no_contact');
  end if;
  if length(v_name) > 40 or length(v_phone) > 40 then
    return json_build_object('ok', false, 'error', 'too_long');
  end if;

  select * into v_slot from public.hamyang_interest_slot where pickup_date = p_date;
  if not found or not v_slot.is_open then
    return json_build_object('ok', false, 'error', 'closed');
  end if;

  perform pg_advisory_xact_lock(hashtext('hamyang_interest:' || p_date::text));

  select coalesce(sum(coalesce(qty_emotion,0)),0), coalesce(sum(coalesce(qty_energy,0)),0)
    into v_e, v_n from public.hamyang_interest
   where pickup_date = p_date and coalesce(status,'open') <> 'canceled';

  if p_emotion > v_slot.cap_emotion - v_e or p_energy > v_slot.cap_energy - v_n then
    return json_build_object('ok', false, 'error', 'sold_out',
      'left_emotion', greatest(v_slot.cap_emotion - v_e, 0),
      'left_energy', greatest(v_slot.cap_energy - v_n, 0));
  end if;

  insert into public.hamyang_interest
    (pickup_date, qty_emotion, qty_energy, party_size, name, phone, src)
  values (p_date, p_emotion, p_energy, p_party, v_name, v_phone,
          nullif(btrim(coalesce(p_src, '')), ''))
  returning id into v_id;

  return json_build_object('ok', true, 'id', v_id);
end $$;

revoke all on function public.hamyang_interest_reserve(date, int, int, text, text, int, text) from public;
grant execute on function public.hamyang_interest_reserve(date, int, int, text, text, int, text) to anon, authenticated;


-- ── 6) 상태 바꾸기 (수령 / 취소) ─────────────────────
create or replace function public.hamyang_interest_set_status(p_id bigint, p_status text)
returns json
language plpgsql security definer set search_path = public as $$
begin
  if p_status not in ('open', 'came', 'canceled') then
    return json_build_object('ok', false, 'error', 'bad_status');
  end if;
  update public.hamyang_interest set status = p_status where id = p_id;
  if not found then
    return json_build_object('ok', false, 'error', 'not_found');
  end if;
  return json_build_object('ok', true);
end $$;

revoke all on function public.hamyang_interest_set_status(bigint, text) from public;
grant execute on function public.hamyang_interest_set_status(bigint, text) to anon, authenticated;

-- 더 이상 쓰지 않는 것 정리
drop function if exists public.hamyang_interest_create(date, int, int, text, text, int, text);
