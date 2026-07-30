-- 함양 인지도 조사 응답 테이블 (여러 번 실행해도 안전 · idempotent)
-- Supabase SQL Editor에 전체 붙여넣고 실행하세요.

-- 1) 테이블 (없으면 생성)
create table if not exists public.hamyang_survey (
  id         bigint generated always as identity primary key,
  created_at timestamptz not null default now()
);

-- 2) 컬럼 (이미 있으면 건너뜀 — 기존 테이블에도 안전하게 최신 컬럼 반영)
alter table public.hamyang_survey add column if not exists q_location          text;   -- 지도에서 고른 지역
alter table public.hamyang_survey add column if not exists q_location_correct  boolean;-- 정답(함양) 여부
alter table public.hamyang_survey add column if not exists visited             text;   -- 함양 방문 경험
alter table public.hamyang_survey add column if not exists neighbor_cities     text;   -- 이웃 도시 방문(복수)
alter table public.hamyang_survey add column if not exists contact_points      text;   -- 접점(복수)
alter table public.hamyang_survey add column if not exists ingredients         text;   -- 고른 식재료(복수)
alter table public.hamyang_survey add column if not exists ingredient_accuracy int;    -- 식재료 정답률(%) 정답: 흑돼지·양파·우리밀
alter table public.hamyang_survey add column if not exists popup_intent        text;   -- 샌드위치 팝업 먹어보고 싶은지
alter table public.hamyang_survey add column if not exists email               text;   -- 팝업 소식 이메일(선택)
alter table public.hamyang_survey add column if not exists region_interest     int;    -- 테스트 후 함양 관심도 1~5
alter table public.hamyang_survey add column if not exists age                 text;
alter table public.hamyang_survey add column if not exists gender              text;
alter table public.hamyang_survey add column if not exists region              text;
alter table public.hamyang_survey add column if not exists level               text;   -- 함양 레벨
alter table public.hamyang_survey add column if not exists score               int;    -- 함양 점수 0~100

-- 3) RLS + 정책 (익명은 저장만, 조회 불가 → 이메일 보호)
alter table public.hamyang_survey enable row level security;
drop policy if exists "anon can insert" on public.hamyang_survey;
create policy "anon can insert" on public.hamyang_survey
  for insert to anon with check (true);

-- ⚠️ base 테이블에 익명 읽기 정책을 만들지 마세요(이메일 노출됨).
-- 실제 이메일은 대시보드 Table Editor / service_role 키로만 조회하세요.

-- 4) 통계 대시보드용 공개 뷰: email 제외, 이메일 남겼는지 여부(has_email)만 노출
drop view if exists public.hamyang_survey_public;
create or replace view public.hamyang_survey_public
with (security_invoker = off) as
  select
    id, created_at,
    q_location, q_location_correct, visited, neighbor_cities, contact_points,
    ingredients, ingredient_accuracy, popup_intent, region_interest,
    age, gender, region, level, score,
    (email is not null and email <> '') as has_email
  from public.hamyang_survey;

grant select on public.hamyang_survey_public to anon;
