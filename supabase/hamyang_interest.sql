-- 함양 to 남가좌 팝업 · 사전 수요조사 (hamyang-interest.html)
--
-- 정원·마감이 없는 수요조사라 원자적 수량 검사가 필요 없습니다.
-- 그래서 저장 함수 없이 익명 insert 정책 + CHECK 제약으로만 처리합니다.
-- (기존 hamyang_survey / hamyang_popup 과 같은 방식)
--
-- ⚠️ 기존 hamyang_survey / hamyang_popup / hamyang_preorder 는 일절 건드리지 않습니다.
-- 여러 번 실행해도 안전합니다.

create table if not exists public.hamyang_interest (
  id         bigint generated always as identity primary key,
  created_at timestamptz not null default now()
);

alter table public.hamyang_interest add column if not exists pickup_date date;              -- null = 아직 못 정함
alter table public.hamyang_interest add column if not exists qty_emotion int default 0;     -- 정서함양
alter table public.hamyang_interest add column if not exists qty_energy  int default 0;     -- 체력함양
alter table public.hamyang_interest add column if not exists est_price   int;               -- 8,500(할인가) × 총 수량
alter table public.hamyang_interest add column if not exists party_size  int;               -- 함께 오는 인원
alter table public.hamyang_interest add column if not exists name        text;
alter table public.hamyang_interest add column if not exists phone       text;
alter table public.hamyang_interest add column if not exists status      text default 'open';
alter table public.hamyang_interest add column if not exists src         text;

create index if not exists hamyang_interest_created_idx on public.hamyang_interest (created_at desc);

-- 값 검증 (함수 대신)
-- 연락처는 받지 않습니다. phone 컬럼은 남겨두되 검사하지 않습니다.
alter table public.hamyang_interest drop constraint if exists hamyang_interest_sane;
alter table public.hamyang_interest add constraint hamyang_interest_sane check (
  name is not null
  and length(btrim(name)) between 1 and 40
  and qty_emotion between 0 and 20
  and qty_energy between 0 and 20
  and qty_emotion + qty_energy > 0
  and (party_size is null or party_size between 1 and 20)
);

-- 익명은 저장만. 읽기 정책은 두지 않습니다 (연락처 보호)
alter table public.hamyang_interest enable row level security;

drop policy if exists "anon can insert" on public.hamyang_interest;
create policy "anon can insert" on public.hamyang_interest
  for insert to anon with check (true);

-- 결과 화면용 뷰
drop view if exists public.hamyang_interest_list;
create view public.hamyang_interest_list
with (security_invoker = off) as
  select id, created_at, pickup_date, qty_emotion, qty_energy, est_price, party_size, name, status
    from public.hamyang_interest;

grant select on public.hamyang_interest_list to anon, authenticated;

-- 이전 버전에서 만든 함수가 있으면 정리
drop function if exists public.hamyang_interest_create(date, int, int, text, text, int, text);

-- 날짜별 수요 한눈에 보기:
--   select coalesce(pickup_date::text, '미정') 날짜, count(*) 건수,
--          sum(qty_emotion) 정서, sum(qty_energy) 체력, sum(party_size) 인원
--     from public.hamyang_interest group by 1 order by 1;
