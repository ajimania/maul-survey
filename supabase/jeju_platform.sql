-- 제주 청년정책 연구 · 실무자 브리핑+설문 (jeju-platform.html)
-- 여러 번 실행해도 안전 (idempotent). Supabase SQL Editor에 전체 붙여넣고 실행하세요.
--
-- 구조:
--   jp_participants : 배포 코드 명단 (사람 단위, 20개 발급 · org/memo는 배정 시 채움)
--   jp_responses    : 응답 (코드당 1행, 전체 스냅샷 jsonb)
--   RPC jp_login(code)                  : 코드 검증 + 기존 응답 반환 (없으면 행 생성)
--   RPC jp_save(code, payload, step, submit) : 스냅샷 저장
--   RPC jp_admin(pass)                  : 관리자 전체 조회 (스탯 페이지용)
--
-- RLS는 두 테이블 모두 '전부 차단'. anon 접근은 위 RPC(security definer)로만 가능.
-- ★ 관리자 비밀번호는 아래 jp_admin 안의 'jeju-cw-2026' 을 원하는 값으로 바꾸세요.

-- 1) 참여자 코드
create table if not exists public.jp_participants (
  code       text primary key,
  org        text,          -- 소속 기관 (배정 시 채움)
  person     text,          -- 담당자 이름 (배정 시 채움)
  memo       text,          -- 연구진 메모
  created_at timestamptz not null default now()
);

insert into public.jp_participants (code) values
  ('JEJU-K3TM'), ('JEJU-9FWA'), ('JEJU-P7DN'), ('JEJU-4HXR'),
  ('JEJU-B8QS'), ('JEJU-M2VE'), ('JEJU-6TCG'), ('JEJU-XW5H'),
  ('JEJU-R9JP'), ('JEJU-D4KU'), ('JEJU-7NZB'), ('JEJU-EQ3F'),
  ('JEJU-S6MW'), ('JEJU-2GYD'), ('JEJU-HV8T'), ('JEJU-N5RC'),
  ('JEJU-UB7K'), ('JEJU-3DPX'), ('JEJU-WK9G'), ('JEJU-F2SN')
on conflict (code) do nothing;

-- 2) 응답
create table if not exists public.jp_responses (
  id           bigint generated always as identity primary key,
  code         text not null unique references public.jp_participants(code),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  submitted_at timestamptz,
  step         int not null default 0,   -- 도달한 최고 단계 (0~9)
  org          text,                     -- 응답자가 입력한 소속 (payload에서 추출)
  name         text,                     -- 응답자가 입력한 이름 (payload에서 추출)
  payload      jsonb not null default '{}'::jsonb
);

-- 3) RLS — 전부 차단 (정책 없음 = anon 직접 접근 불가)
alter table public.jp_participants enable row level security;
alter table public.jp_responses    enable row level security;

-- 4) 로그인: 코드 검증 + 기존 응답 반환 (없으면 행 생성)
create or replace function public.jp_login(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text := upper(trim(p_code));
  v_part public.jp_participants%rowtype;
  v_resp public.jp_responses%rowtype;
begin
  select * into v_part from public.jp_participants where code = v_code;
  if not found then
    return jsonb_build_object('ok', false);
  end if;

  insert into public.jp_responses (code) values (v_code)
  on conflict (code) do nothing;

  select * into v_resp from public.jp_responses where code = v_code;

  return jsonb_build_object(
    'ok', true,
    'org', v_part.org,
    'person', v_part.person,
    'step', v_resp.step,
    'submitted', v_resp.submitted_at is not null,
    'payload', v_resp.payload
  );
end;
$$;

-- 5) 저장: 전체 스냅샷 덮어쓰기
create or replace function public.jp_save(
  p_code text, p_payload jsonb, p_step int, p_submit boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text := upper(trim(p_code));
  v_n int;
begin
  update public.jp_responses set
    payload      = coalesce(p_payload, payload),
    step         = greatest(step, coalesce(p_step, 0)),
    org          = coalesce(nullif(p_payload->>'org',''), org),
    name         = coalesce(nullif(p_payload->>'name',''), name),
    submitted_at = case when p_submit then coalesce(submitted_at, now()) else submitted_at end,
    updated_at   = now()
  where code = v_code;
  get diagnostics v_n = row_count;
  return jsonb_build_object('ok', v_n = 1);
end;
$$;

-- 6) 관리자 조회 (jeju-platform-stats.html)
--    ★ 비밀번호를 바꾸려면 아래 'jeju-cw-2026' 을 수정 후 다시 실행하세요.
create or replace function public.jp_admin(p_pass text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_pass is distinct from 'jeju-cw-2026' then
    return jsonb_build_object('ok', false);
  end if;
  return jsonb_build_object('ok', true, 'rows', coalesce((
    select jsonb_agg(jsonb_build_object(
      'code', p.code, 'assigned_org', p.org, 'assigned_person', p.person, 'memo', p.memo,
      'started', r.id is not null,
      'step', r.step, 'org', r.org, 'name', r.name,
      'created_at', r.created_at, 'updated_at', r.updated_at,
      'submitted_at', r.submitted_at, 'payload', r.payload
    ) order by r.updated_at desc nulls last, p.code)
    from public.jp_participants p
    left join public.jp_responses r on r.code = p.code
  ), '[]'::jsonb));
end;
$$;

grant execute on function public.jp_login(text) to anon;
grant execute on function public.jp_save(text, jsonb, int, boolean) to anon;
grant execute on function public.jp_admin(text) to anon;
