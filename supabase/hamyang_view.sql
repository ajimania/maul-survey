-- 함양 팝업 페이지 방문 기록 (링크를 몇 명이 열어봤는지)
--
-- 개인정보를 남기지 않습니다. 브라우저마다 무작위 id 하나만 만들어
-- 같은 사람이 여러 번 열어본 것과 서로 다른 사람이 열어본 것을 구분합니다.
--
-- ⚠️ 기존 테이블은 일절 건드리지 않습니다. 여러 번 실행해도 안전합니다.

create table if not exists public.hamyang_view (
  id         bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  page       text,   -- interest | preorder ...
  src        text,   -- ?src= 값 (mail 등)
  sid        text    -- 브라우저별 무작위 id (개인 식별 아님)
);

create index if not exists hamyang_view_created_idx on public.hamyang_view (created_at desc);

alter table public.hamyang_view enable row level security;

drop policy if exists "anon can insert" on public.hamyang_view;
create policy "anon can insert" on public.hamyang_view
  for insert to anon with check (true);

-- 집계 뷰 — 개별 기록은 공개하지 않고 숫자만
drop view if exists public.hamyang_view_stats;
create view public.hamyang_view_stats
with (security_invoker = off) as
  select page,
         coalesce(nullif(btrim(src), ''), '(직접)') as src,
         count(*)            as views,
         count(distinct sid) as visitors,
         min(created_at)     as first_at,
         max(created_at)     as last_at
    from public.hamyang_view
   group by 1, 2;

grant select on public.hamyang_view_stats to anon, authenticated;
