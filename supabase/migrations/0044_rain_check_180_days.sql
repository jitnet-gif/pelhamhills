-- 레인체크 만료일 기본값: 발행일 + 180일 (0011 은 + 1년이었다).
--
-- 클럽 정책이 정해졌다(2026-10-19). 0011 이 "정책이 정해지면 여기 한 곳만 바꾼다" 고 남겨 둔 헬퍼만 바꾼다.
-- 발행 창은 서버가 주는 `default_expires_on` 을 그대로 쓰므로 화면은 바꿀 것이 없다.
-- 이미 발행한 레인체크의 만료일은 그대로다(종이에 찍힌 날짜와 달라지면 안 된다).
--
-- 전제: 0011. 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다.

create or replace function public.pelham_rc_default_expiry(p_issued date)
returns date
language sql
immutable
set search_path = ''
as $$
  select p_issued + 180
$$;

revoke all on function public.pelham_rc_default_expiry(date) from public, anon, authenticated;

notify pgrst, 'reload schema';
