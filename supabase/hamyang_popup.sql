-- 남가좌 × 함양 팝업 · 참여 웹페이지 (hamyang-popup.html)
-- 여러 번 실행해도 안전 (idempotent). Supabase SQL Editor에 전체 붙여넣고 실행하세요.

-- 1) 테이블
create table if not exists public.hamyang_popup (
  id         bigint generated always as identity primary key,
  created_at timestamptz not null default now()
);

-- 2) 컬럼
alter table public.hamyang_popup add column if not exists sid            text;    -- 익명 세션 ID
alter table public.hamyang_popup add column if not exists src            text;    -- wrap | onion | map | (직접)
alter table public.hamyang_popup add column if not exists ate            boolean; -- ② 샌드위치를 먹었는가 (핵심 대조군)
alter table public.hamyang_popup add column if not exists taste_score    int;     -- ③A 맛 별점 1~5
alter table public.hamyang_popup add column if not exists revisit        text;    -- ③A 재구매 의향
alter table public.hamyang_popup add column if not exists stop_reason    text;    -- ③B 멈춰선 이유
alter table public.hamyang_popup add column if not exists map_pick       text;    -- ④ 지도에서 고른 지역
alter table public.hamyang_popup add column if not exists map_correct    boolean; -- ④ 정답 여부
alter table public.hamyang_popup add column if not exists ing_pick       text;    -- ⑤ 고른 재료(쉼표)
alter table public.hamyang_popup add column if not exists ing_correct    boolean; -- ⑤ 정답 여부 (화덕빵+양파잼)
alter table public.hamyang_popup add column if not exists letter_to      text;    -- ⑦ 수신자 onion | wheat
alter table public.hamyang_popup add column if not exists letter_body    text;    -- ⑦ 편지 본문
alter table public.hamyang_popup add column if not exists visit_intent   text;    -- ⑨ 방문 의향 (핵심 전환 지표)
alter table public.hamyang_popup add column if not exists neighbor       text;    -- ⑨ 동네 주민 여부
alter table public.hamyang_popup add column if not exists contact_name   text;    -- ⑨ 이름 (선택)
alter table public.hamyang_popup add column if not exists contact_phone  text;    -- ⑨ 연락처 (선택)
alter table public.hamyang_popup add column if not exists interests      text;    -- ⑨ 관심 프로그램(쉼표)
alter table public.hamyang_popup add column if not exists finished       boolean default false; -- ⑩ 완료 도달
alter table public.hamyang_popup add column if not exists steps          jsonb;   -- 화면별 도달 시각 (이탈 지점)

create index if not exists hamyang_popup_created_idx on public.hamyang_popup (created_at desc);

-- 3) RLS — 익명은 저장만. 연락처가 있으므로 base 테이블은 절대 읽기 개방 금지
alter table public.hamyang_popup enable row level security;

drop policy if exists "anon can insert" on public.hamyang_popup;
create policy "anon can insert" on public.hamyang_popup
  for insert to anon with check (true);

-- 진행 중인 세션이 자기 행을 갱신 (id를 아는 경우에만 · 6시간 이내 행으로 제한)
drop policy if exists "anon can update recent" on public.hamyang_popup;
create policy "anon can update recent" on public.hamyang_popup
  for update to anon
  using (created_at > now() - interval '6 hours')
  with check (created_at > now() - interval '6 hours');

-- ⚠️ base 테이블에 익명 select 정책을 만들지 마세요 (연락처 노출).
-- 실제 연락처는 대시보드 Table Editor / service_role 키로만 조회하세요.

-- 4) 편지 벽 공개 뷰 — 편지 본문만. id·연락처 등 일절 노출 안 함
drop view if exists public.hamyang_popup_letters;
create or replace view public.hamyang_popup_letters
with (security_invoker = off) as
  select created_at, letter_to, letter_body
  from public.hamyang_popup
  where letter_body is not null and btrim(letter_body) <> ''
  order by created_at desc;

grant select on public.hamyang_popup_letters to anon;

-- 5) 통계 대시보드용 공개 뷰 — 연락처 제외, 남겼는지 여부만
drop view if exists public.hamyang_popup_public;
create or replace view public.hamyang_popup_public
with (security_invoker = off) as
  select
    id, created_at, src, ate, taste_score, revisit, stop_reason,
    map_pick, map_correct, ing_pick, ing_correct,
    letter_to, visit_intent, neighbor, interests, finished, steps,
    (contact_phone is not null and btrim(contact_phone) <> '') as has_contact
  from public.hamyang_popup;

grant select on public.hamyang_popup_public to anon;
