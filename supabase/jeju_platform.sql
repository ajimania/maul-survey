-- 제주 청년정책 연구 · 실무자 브리핑+설문 (jeju-platform.html)
-- v2 — 사전 발급 코드 방식 → 아이디 + 숫자 4자리 비밀번호 방식
-- 여러 번 실행해도 안전. 이전 버전(코드 방식)의 테이블·함수는 제거하고 다시 만듭니다.
--
-- 구조:
--   jp_responses : 응답 (아이디당 1행, 전체 스냅샷 jsonb)
--   RPC jp_signin(uid, pw)  : 처음이면 계정 생성, 재방문이면 비밀번호 확인 후 응답 반환
--   RPC jp_save(uid, pw, payload, step, submit) : 비밀번호 확인 후 저장
--   RPC jp_admin(pass)      : 관리자 전체 조회 (jeju-platform-stats.html)
--
-- RLS는 전부 차단. anon 접근은 위 RPC(security definer)로만 가능.
-- 비밀번호(pw)는 그대로 저장됩니다 — 응답자가 잊으면 관리자가 이 테이블에서 확인해 안내하세요.
-- ★ 실행 전, 맨 아래 jp_admin 안의 'jeju-cw-2026' 을 쓰시던 관리자 비밀번호로 바꾸세요.

-- 0) 이전 버전 정리
drop function if exists public.jp_login(text);
drop function if exists public.jp_save(text, jsonb, int, boolean);
drop table if exists public.jp_responses;
drop table if exists public.jp_participants;

-- 1) 응답
create table public.jp_responses (
  id           bigint generated always as identity primary key,
  uid          text not null unique,   -- 응답자가 정한 아이디
  pw           text not null,          -- 숫자 4자리
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  submitted_at timestamptz,
  step         int not null default 0, -- 도달한 최고 단계 (0~5)
  org          text,                   -- 입력한 소속 (payload에서 추출)
  name         text,
  payload      jsonb not null default '{}'::jsonb
);

alter table public.jp_responses enable row level security;

-- 2) 입장: 처음이면 생성, 재방문이면 비밀번호 확인
create or replace function public.jp_signin(p_uid text, p_pw text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid text := trim(p_uid);
  v_row public.jp_responses%rowtype;
begin
  if v_uid = '' or p_pw !~ '^[0-9]{4}$' then
    return jsonb_build_object('ok', false, 'reason', 'input');
  end if;

  select * into v_row from public.jp_responses where uid = v_uid;

  if not found then
    insert into public.jp_responses (uid, pw) values (v_uid, p_pw);
    return jsonb_build_object('ok', true, 'created', true,
      'step', 0, 'submitted', false, 'payload', '{}'::jsonb);
  end if;

  if v_row.pw is distinct from p_pw then
    return jsonb_build_object('ok', false, 'reason', 'pw');
  end if;

  return jsonb_build_object('ok', true, 'created', false,
    'step', v_row.step, 'submitted', v_row.submitted_at is not null,
    'payload', v_row.payload);
end;
$$;

-- 3) 저장: 비밀번호 확인 후 전체 스냅샷 덮어쓰기
create or replace function public.jp_save(
  p_uid text, p_pw text, p_payload jsonb, p_step int, p_submit boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_n int;
begin
  update public.jp_responses set
    payload      = coalesce(p_payload, payload),
    step         = greatest(step, coalesce(p_step, 0)),
    org          = coalesce(nullif(p_payload->>'org',''), org),
    name         = coalesce(nullif(p_payload->>'name',''), name),
    submitted_at = case when p_submit then coalesce(submitted_at, now()) else submitted_at end,
    updated_at   = now()
  where uid = trim(p_uid) and pw = p_pw;
  get diagnostics v_n = row_count;
  return jsonb_build_object('ok', v_n = 1);
end;
$$;

-- 4) 관리자 조회 (jeju-platform-stats.html)
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
      'uid', r.uid, 'org', r.org, 'name', r.name, 'step', r.step,
      'created_at', r.created_at, 'updated_at', r.updated_at,
      'submitted_at', r.submitted_at, 'payload', r.payload
    ) order by r.updated_at desc)
    from public.jp_responses r
  ), '[]'::jsonb));
end;
$$;

grant execute on function public.jp_signin(text, text) to anon;
grant execute on function public.jp_save(text, text, jsonb, int, boolean) to anon;
grant execute on function public.jp_admin(text) to anon;
