-- 청년 건강권 자가진단 응답 테이블 (여러 번 실행해도 안전 · idempotent)
-- 문항 출처: 한국보건사회연구원 「청년 건강 실태와 정책과제」(연구보고서 2025-29, 2025)
--            WHO 건강불평등 발생 기전 모형(2008)의 6개 영역
-- Supabase SQL Editor에 전체 붙여넣고 실행하세요.
-- 개인식별정보 없음: 이름·연락처·이메일·IP 어느 것도 저장하지 않습니다.

-- 1) 테이블
create table if not exists public.health_rights (
  id         bigint generated always as identity primary key,
  created_at timestamptz not null default now()
);

-- 2) 컬럼
alter table public.health_rights add column if not exists cohort text;  -- 워크숍 회차 (?w=20260910)

-- 문항별 원점수 0~3 (Q1~Q30)
do $$
begin
  for i in 1..30 loop
    execute format('alter table public.health_rights add column if not exists q%s smallint', i);
  end loop;
end $$;

-- 영역별 합계 0~15 (보고서 5장 조사영역과 동일)
alter table public.health_rights add column if not exists s_body    smallint; -- 몸   · 행동 요인 (Q1~5)
alter table public.health_rights add column if not exists s_mind    smallint; -- 마음 · 정신적 요인 (Q6~10)
alter table public.health_rights add column if not exists s_place   smallint; -- 터전 · 물리적 환경 요인 (Q11~15)
alter table public.health_rights add column if not exists s_care    smallint; -- 의료 · 보건의료 요인 (Q16~20)
alter table public.health_rights add column if not exists s_social  smallint; -- 관계 · 사회적 요인 (Q21~25)
alter table public.health_rights add column if not exists s_context smallint; -- 시대 · 사회경제정치적 맥락 (Q26~30)

-- 종합
alter table public.health_rights add column if not exists personal_pct    smallint; -- 개인축(몸·마음) %
alter table public.health_rights add column if not exists condition_pct   smallint; -- 조건축(터전·의료·관계·시대) %
alter table public.health_rights add column if not exists total_pct       smallint; -- 100점 환산
alter table public.health_rights add column if not exists type_key        text;     -- hh/hl/lh/ll
alter table public.health_rights add column if not exists lowest_area     text;     -- body/mind/place/care/social/context

create index if not exists health_rights_cohort_idx on public.health_rights (cohort, created_at desc);

-- 3) RLS
alter table public.health_rights enable row level security;

drop policy if exists "anon can insert" on public.health_rights;
create policy "anon can insert" on public.health_rights
  for insert to anon with check (true);

-- 개인식별정보가 전혀 없으므로 익명 조회를 허용합니다(집계·통계 페이지용).
-- 워크숍 응답을 비공개로 두려면 아래 두 줄만 지우세요.
drop policy if exists "anon can read" on public.health_rights;
create policy "anon can read" on public.health_rights
  for select to anon using (true);

-- 4) 회차별 집계 뷰 (워크숍 진행자용)
drop view if exists public.health_rights_summary;
create or replace view public.health_rights_summary
with (security_invoker = off) as
  select
    coalesce(cohort,'(회차 없음)') as cohort,
    count(*)                                      as n,
    round(avg(total_pct))                         as avg_total,
    round(avg(personal_pct))                      as avg_personal,
    round(avg(condition_pct))                     as avg_condition,
    round(avg(personal_pct) - avg(condition_pct)) as gap,
    round(avg(s_body),1)    as avg_body,
    round(avg(s_mind),1)    as avg_mind,
    round(avg(s_place),1)   as avg_place,
    round(avg(s_care),1)    as avg_care,
    round(avg(s_social),1)  as avg_social,
    round(avg(s_context),1) as avg_context,
    count(*) filter (where type_key='hl') as type_hl,  -- 혼자 힘으로 버티는 중
    count(*) filter (where type_key='hh') as type_hh,  -- 볕이 드는 자리
    count(*) filter (where type_key='lh') as type_lh,  -- 잠깐 쉬어갈 때
    count(*) filter (where type_key='ll') as type_ll   -- 혼자 감당할 일이 아닙니다
  from public.health_rights
  group by 1
  order by 1 desc;

grant select on public.health_rights_summary to anon;
