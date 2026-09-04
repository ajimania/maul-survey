-- 2026 미라클헬씨모닝 · 참여자 소개/출석 (레포 루트 miracle-healthy-morning.html)
-- 여러 번 실행해도 안전 (idempotent). Supabase SQL Editor에 전체 붙여넣고 실행하세요.
--
-- 구조:
--   mhm_members : 참여자 18명 (이름 PK, 소개 text, 출석 jsonb)
--   RPC mhm_load()                    : 18명 전체를 {이름: {intro, att}} 한 덩어리로 반환
--   RPC mhm_save(name, intro, att)    : 한 명 덮어쓰기 (명단에 없는 이름은 거부)
--
-- RLS 전부 차단. anon 접근은 위 RPC(security definer)로만 가능.
-- 익명 키로 테이블에 직접 insert/upsert 하지 말 것 — 401로 막힌다.

-- 1) 참여자
create table if not exists public.mhm_members (
  name       text primary key,
  intro      text  not null default '',
  att        jsonb not null default '{}'::jsonb,  -- {s1,s2,s3,s4: boolean}
  updated_at timestamptz not null default now()
);

insert into public.mhm_members (name) values
  ('이상권'), ('지예슬'), ('이지연'), ('황창현'), ('김기훈'), ('박지연'),
  ('정광훈'), ('박상범'), ('전창환'), ('변종희'), ('임미나'), ('최형규'),
  ('이용진'), ('유정은'), ('강민구'), ('배정란'), ('이영우'), ('최주원')
on conflict (name) do nothing;

-- 2) RLS — 전부 차단 (정책 없음 = anon 직접 접근 불가)
alter table public.mhm_members enable row level security;

-- 3) 불러오기: 전체를 이름 키 객체 하나로
create or replace function public.mhm_load()
returns jsonb
language sql
security definer
set search_path = public
as $$
  select coalesce(
    jsonb_object_agg(name, jsonb_build_object('intro', intro, 'att', att)),
    '{}'::jsonb
  )
  from public.mhm_members;
$$;

-- 4) 저장: 한 명 덮어쓰기
create or replace function public.mhm_save(
  p_name text, p_intro text, p_att jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.mhm_members
     set intro      = coalesce(p_intro, ''),
         att        = coalesce(p_att, '{}'::jsonb),
         updated_at = now()
   where name = p_name;

  if not found then
    -- 명단에 없는 이름은 만들지 않는다 (장난 행 방지)
    return jsonb_build_object('ok', false, 'reason', 'unknown_member');
  end if;

  return jsonb_build_object('ok', true);
end;
$$;

grant execute on function public.mhm_load() to anon;
grant execute on function public.mhm_save(text, text, jsonb) to anon;
