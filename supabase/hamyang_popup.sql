-- 남가좌 × 함양 팝업 · 참여 웹페이지 (hamyang-popup.html)
-- 여러 번 실행해도 안전 (idempotent). Supabase SQL Editor에 전체 붙여넣고 실행하세요.
--
-- ver2 — 흐름 전면 교체 (생산자 카드 → 식경험 분기 → 가격/지불의사 → 편지 → 참여의사 → 구매페이지)
-- ver1 컬럼(ate, taste_score, revisit, stop_reason, map_*, ing_*, visit_intent,
-- neighbor, contact_name, contact_phone)은 데이터 보존을 위해 지우지 않고 그대로 둡니다.
-- 사용하지 않으니 무시하시면 됩니다.

-- 1) 테이블
create table if not exists public.hamyang_popup (
  id         bigint generated always as identity primary key,
  created_at timestamptz not null default now()
);

-- 2) 컬럼
alter table public.hamyang_popup add column if not exists sid          text;    -- 익명 세션 ID
alter table public.hamyang_popup add column if not exists src          text;    -- wrap | onion | map | (직접)

-- ① 생산자 카드 — 뒤집어서 이야기를 실제로 읽었는가
alter table public.hamyang_popup add column if not exists flip_onion   boolean; -- 양파 카드 뒤집음
alter table public.hamyang_popup add column if not exists flip_wheat   boolean; -- 우리밀 카드 뒤집음

-- ② 식경험 분기 (핵심)
alter table public.hamyang_popup add column if not exists experience   text;    -- sandwich | jam | both | none

-- ③-A 샌드위치 (판매가 9,500원)
alter table public.hamyang_popup add column if not exists sw_type      text;    -- 베이컨&마스카포네 | 브리&양파잼
alter table public.hamyang_popup add column if not exists sw_score     int;     -- 맛 1~5
alter table public.hamyang_popup add column if not exists sw_price     text;    -- 가격 평가
alter table public.hamyang_popup add column if not exists sw_revisit   text;    -- 재구매 의향
alter table public.hamyang_popup add column if not exists sw_free      text;    -- 주관식 — 한 가지만 바꾼다면

-- ③-B 양파잼 (미출시 · 순수 지불의사)
alter table public.hamyang_popup add column if not exists jam_score    int;     -- 맛 1~5
alter table public.hamyang_popup add column if not exists jam_buy      text;    -- 구매 의사
alter table public.hamyang_popup add column if not exists jam_wtp      int;     -- 200g 한 병 지불의사(원)
alter table public.hamyang_popup add column if not exists jam_free     text;    -- 주관식

-- ④ 편지
alter table public.hamyang_popup add column if not exists letter_to          text; -- onion | wheat | both | each
alter table public.hamyang_popup add column if not exists letter_body        text; -- (each일 때는 양파 농부용)
alter table public.hamyang_popup add column if not exists letter_body_wheat  text; -- each일 때 우리밀용

-- ⑤ 체감 거리 · 참여 의사 · 연락처
alter table public.hamyang_popup add column if not exists closeness_km int;   -- 함양이 얼마나 가까워졌나 (남은 거리 km, 0~300)
alter table public.hamyang_popup add column if not exists interests    text;    -- 복수 선택(쉼표)
alter table public.hamyang_popup add column if not exists email        text;    -- 모임 안내용
alter table public.hamyang_popup add column if not exists phone        text;    -- 무지개양파 추첨 발송용(선택)

-- ⑥ 구매 페이지 클릭 (관계 → 재소비)
alter table public.hamyang_popup add column if not exists shop_click   text;    -- onion,wheat

alter table public.hamyang_popup add column if not exists finished     boolean default false;
alter table public.hamyang_popup add column if not exists steps        jsonb;   -- 화면별 도달 시각

create index if not exists hamyang_popup_created_idx on public.hamyang_popup (created_at desc);

-- 3) RLS — 익명은 저장만. 이메일이 있으므로 base 테이블은 절대 읽기 개방 금지
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

-- ⚠️ base 테이블에 익명 select 정책을 만들지 마세요 (이메일 노출).
-- 실제 이메일은 대시보드 Table Editor / service_role 키로만 조회하세요.

-- 4) 편지 벽 공개 뷰 — 편지 본문만. id·연락처 등 일절 노출 안 함
--    '각각 따로' 작성분은 수신자별로 한 줄씩 펼쳐서 내보냅니다.
drop view if exists public.hamyang_popup_letters;
create or replace view public.hamyang_popup_letters
with (security_invoker = off) as
  select created_at,
         case when letter_to = 'each' then 'onion' else letter_to end as letter_to,
         letter_body
    from public.hamyang_popup
   where letter_body is not null and btrim(letter_body) <> ''
  union all
  select created_at, 'wheat' as letter_to, letter_body_wheat as letter_body
    from public.hamyang_popup
   where letter_body_wheat is not null and btrim(letter_body_wheat) <> '';

grant select on public.hamyang_popup_letters to anon;

-- 5) 통계 대시보드용 공개 뷰 — 이메일 제외, 남겼는지 여부만
drop view if exists public.hamyang_popup_public;
create or replace view public.hamyang_popup_public
with (security_invoker = off) as
  select
    id, created_at, src,
    flip_onion, flip_wheat, experience,
    sw_type, sw_score, sw_price, sw_revisit, sw_free,
    jam_score, jam_buy, jam_wtp, jam_free,
    letter_to, closeness_km, interests, shop_click, finished, steps,
    (email is not null and btrim(email) <> '') as has_email,
    (phone is not null and btrim(phone) <> '') as has_phone
  from public.hamyang_popup;

grant select on public.hamyang_popup_public to anon;
