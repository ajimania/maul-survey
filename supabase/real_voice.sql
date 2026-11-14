-- 리얼 보이스 (real-voice*.html, api/real-voice.js)
-- 여러 번 실행해도 안전합니다. 기존 데이터는 지우지 않습니다.
--
-- 구조:
--   rv_docs   : 문서 한 가지 모양 (kind, id, parent, data jsonb)
--               kind = project(사업) · interview(인터뷰) · turn(발화) · audio(녹음) · lead(신청) · settings(단가·규칙)
--   rv_config : 서버 비밀값의 SHA-256 (store_secret_sha256)
--   RPC rv_get / rv_put / rv_list : 비밀값이 맞을 때만 동작
--
-- RLS는 전부 차단. 브라우저는 이 표에 직접 닿지 않고, Vercel 함수(api/real-voice.js)만 RPC를 부릅니다.
-- 비밀값은 이 파일에도 DB에도 적지 않습니다. DB에는 비밀값의 SHA-256 값만 넣습니다.
-- 비밀값 자체는 Vercel 환경변수 RV_STORE_SECRET 에 있습니다. 실행 후 아래 한 줄을 따로 실행합니다.
--   insert into public.rv_config (key, value) values ('store_secret_sha256', '비밀값의-sha256-16진수')
--     on conflict (key) do update set value = excluded.value;
--   (값 구하기: printf '%s' "비밀값" | shasum -a 256)

create table if not exists public.rv_docs (
  kind       text not null,
  id         text not null,
  parent     text,
  data       jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (kind, id)
);
create index if not exists rv_docs_parent on public.rv_docs (kind, parent, created_at);
alter table public.rv_docs enable row level security;

create table if not exists public.rv_config (
  key   text primary key,
  value text not null
);
alter table public.rv_config enable row level security;

create or replace function public.rv_ok(p_secret text)
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (select 1 from public.rv_config
    where key = 'store_secret_sha256' and value = encode(sha256(convert_to(coalesce(p_secret, ''), 'UTF8')), 'hex'));
$$;

create or replace function public.rv_get(p_secret text, p_kind text, p_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.rv_ok(p_secret) then return jsonb_build_object('ok', false); end if;
  return jsonb_build_object('ok', true, 'doc', (
    select jsonb_build_object('kind', d.kind, 'id', d.id, 'parent', d.parent, 'data', d.data,
      'created_at', d.created_at, 'updated_at', d.updated_at)
    from public.rv_docs d where d.kind = p_kind and d.id = p_id));
end;
$$;

create or replace function public.rv_put(p_secret text, p_kind text, p_id text, p_parent text, p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.rv_ok(p_secret) then return jsonb_build_object('ok', false); end if;
  insert into public.rv_docs (kind, id, parent, data) values (p_kind, p_id, p_parent, coalesce(p_data, '{}'::jsonb))
  on conflict (kind, id) do update set data = excluded.data, parent = excluded.parent, updated_at = now();
  return jsonb_build_object('ok', true);
end;
$$;

-- 녹음(audio)은 크기가 커서 목록으로 내주지 않는다. 하나씩 rv_get 으로만 읽는다.
create or replace function public.rv_list(p_secret text, p_kind text, p_parent text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.rv_ok(p_secret) or p_kind = 'audio' then return jsonb_build_object('ok', false); end if;
  return jsonb_build_object('ok', true, 'docs', coalesce((
    select jsonb_agg(jsonb_build_object('kind', d.kind, 'id', d.id, 'parent', d.parent, 'data', d.data,
      'created_at', d.created_at, 'updated_at', d.updated_at) order by d.created_at)
    from public.rv_docs d
    where d.kind = p_kind and (p_parent is null or d.parent = p_parent)
  ), '[]'::jsonb));
end;
$$;

revoke all on function public.rv_ok(text) from public, anon, authenticated;
grant execute on function public.rv_get(text, text, text) to anon;
grant execute on function public.rv_put(text, text, text, text, jsonb) to anon;
grant execute on function public.rv_list(text, text, text) to anon;
