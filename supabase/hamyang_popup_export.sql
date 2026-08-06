-- 팝업 참여자 연락처 내보내기 (비밀번호로 잠금)
-- Supabase SQL Editor에서 실행하세요.
--   ⚠️ 아래 'CHANGE_ME_여기에_비밀번호'를 원하는 비밀번호로 바꿔서 실행!
--   비밀번호를 바꾸려면 이 스크립트를 새 비밀번호로 다시 실행하면 됩니다.
--
-- 동작: 결과 페이지(hamyang-popup-stats.html)의 "연락처 내보내기" 버튼이 이 함수를 호출합니다.
--       올바른 비밀번호일 때만 목록을 반환하고, 틀리면 거부합니다.
--       (익명 키로 호출은 되지만 비밀번호를 모르면 연락처를 볼 수 없습니다.)

create or replace function public.export_hamyang_popup_contacts(pass text)
returns table (
  id bigint, created_at timestamptz,
  email text, phone text, interests text, experience text
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if pass is distinct from 'CHANGE_ME_여기에_비밀번호' then
    raise exception 'unauthorized';
  end if;
  return query
    select h.id, h.created_at, h.email, h.phone, h.interests, h.experience
    from public.hamyang_popup h
    where (h.email is not null and btrim(h.email) <> '')
       or (h.phone is not null and btrim(h.phone) <> '')
    order by h.id;
end;
$$;

revoke all on function public.export_hamyang_popup_contacts(text) from public;
grant execute on function public.export_hamyang_popup_contacts(text) to anon;
