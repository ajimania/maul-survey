-- 이메일 내보내기 함수 (비밀번호로 잠금)
-- Supabase SQL Editor에서 실행하세요.
--   ⚠️ 아래 'CHANGE_ME_여기에_비밀번호'를 원하는 비밀번호로 바꿔서 실행!
--   나중에 비밀번호를 바꾸려면 이 스크립트를 새 비밀번호로 다시 실행하면 됩니다.
--
-- 동작: 대시보드의 "이메일 내보내기" 버튼이 이 함수를 호출합니다.
--       올바른 비밀번호일 때만 이메일 목록을 반환하고, 틀리면 거부합니다.
--       (익명 키로 실행 가능하지만, 비밀번호를 모르면 이메일을 볼 수 없습니다.)

create or replace function public.export_hamyang_contacts(pass text)
returns table (id bigint, created_at timestamptz, email text, popup_intent text, region_interest int)
language plpgsql
security definer
set search_path = public
as $$
begin
  if pass is distinct from 'CHANGE_ME_여기에_비밀번호' then
    raise exception 'unauthorized';
  end if;
  return query
    select h.id, h.created_at, h.email, h.popup_intent, h.region_interest
    from public.hamyang_survey h
    where h.email is not null and h.email <> ''
    order by h.id;
end;
$$;

-- 익명 키로 호출 허용(비밀번호 검사는 함수 내부에서 함)
revoke all on function public.export_hamyang_contacts(text) from public;
grant execute on function public.export_hamyang_contacts(text) to anon;
