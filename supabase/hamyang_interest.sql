-- 함양 to 남가좌 팝업 · 메일 수신자용 예약 (hamyang-interest.html)
--
--   · 날짜별 정원 없음 (원하는 날짜에 얼마든지 예약 가능)
--   · 1인당 총 2개까지 (종류 무관)
--   · 이름 + 전화번호를 받습니다
--
-- 정원 검사가 없어 원자적 처리가 필요 없으므로 저장 함수를 쓰지 않고
-- 익명 insert 정책 + CHECK 제약으로만 처리합니다.
--
-- ⚠️ 기존 hamyang_survey / hamyang_popup / hamyang_preorder 는 일절 건드리지 않습니다.
-- 여러 번 실행해도 안전합니다.

create table if not exists public.hamyang_interest (
  id         bigint generated always as identity primary key,
  created_at timestamptz not null default now()
);

alter table public.hamyang_interest add column if not exists pickup_date date;
alter table public.hamyang_interest add column if not exists qty_emotion int default 0;   -- 정서함양
alter table public.hamyang_interest add column if not exists qty_energy  int default 0;   -- 체력함양
alter table public.hamyang_interest add column if not exists party_size  int;             -- 함께 오는 인원
alter table public.hamyang_interest add column if not exists name        text;
alter table public.hamyang_interest add column if not exists phone       text;
alter table public.hamyang_interest add column if not exists status      text default 'open';  -- open | came | canceled
alter table public.hamyang_interest add column if not exists src         text;

create index if not exists hamyang_interest_created_idx on public.hamyang_interest (created_at desc);

-- 값 검증 (1인 2개 제한 포함)
alter table public.hamyang_interest drop constraint if exists hamyang_interest_sane;
alter table public.hamyang_interest add constraint hamyang_interest_sane check (name is not null and phone is not null and pickup_date is not null and qty_emotion >= 0 and qty_energy >= 0 and qty_emotion + qty_energy between 1 and 2);

-- 익명은 저장만. 읽기 정책은 두지 않습니다 (연락처 보호)
alter table public.hamyang_interest enable row level security;

drop policy if exists "anon can insert" on public.hamyang_interest;
create policy "anon can insert" on public.hamyang_interest
  for insert to anon with check (true);

-- 명단 뷰 — 연락처는 뒤 4자리만. 전체 번호는 Table Editor에서만
drop view if exists public.hamyang_interest_list;
create view public.hamyang_interest_list
with (security_invoker = off) as
  select id, created_at, pickup_date, qty_emotion, qty_energy, party_size, name, status,
         case when phone is null then null
              else '···' || right(regexp_replace(phone, '[^0-9]', '', 'g'), 4) end as phone_tail
    from public.hamyang_interest;

grant select on public.hamyang_interest_list to anon, authenticated;

-- 수령 / 취소 처리
create or replace function public.hamyang_interest_set_status(p_id bigint, p_status text) returns json
language plpgsql security definer set search_path = public as $$
begin
  if p_status not in ('open','came','canceled') then return json_build_object('ok',false,'error','bad_status'); end if;
  update public.hamyang_interest set status = p_status where id = p_id;
  if not found then return json_build_object('ok',false,'error','not_found'); end if;
  return json_build_object('ok',true);
end $$;

grant execute on function public.hamyang_interest_set_status(bigint, text) to anon, authenticated;

-- 정원 방식에서 쓰던 것 정리
drop function if exists public.hamyang_interest_reserve(date, int, int, text, text, int, text);
drop view if exists public.hamyang_interest_slots;
drop table if exists public.hamyang_interest_slot;
