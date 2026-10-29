-- 티 시트 폴링: 바뀌었을 때만 일주일치 예약을 받는다(2026-10-29, Supabase 전송량 초과).
--
-- 왜: 직원 티 시트(useTeeSheet)가 5초마다 이번 주 예약을 통째로(약 100 KB) 다시 읽었다. 10/23 하루 19,186번,
--   Egress 2.27 GB. 이번 달 11.45 GB 로 Free 한도(5 GB)를 넘어 프로젝트가 막혔다.
--
-- 바꾸는 것: 직원 함수 `pelham_staff_bookings_stamp(from, to)` — 같은 구간의 `pelham_staff_bookings` 결과를
--   md5 로 줄인 32자 글자. 화면은 이것만 자주 묻고, 지난번과 다를 때만 예약 목록을 받는다.
--   결과 그 자체를 요약하므로 어떤 변경도 놓치지 않는다 — 홀드가 시간이 지나 사라지는 것도(그 함수가
--   now() 로 거른다), updated_at 을 안 건드리는 서버 수정도.
--   서버는 예전처럼 일주일치를 읽어 계산하지만(가볍다), 밖으로 나가는 건 32자뿐이다.
--
-- 전제: 0004. 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다.
-- 이 SQL 전에 화면이 배포돼도 괜찮다 — 함수가 없으면 화면은 30초마다 통째로 읽는다.

do $$
begin
  if to_regprocedure('public.pelham_staff_bookings(date, date)') is null then
    raise exception '0134 needs 0004 first (pelham_staff_bookings is missing).';
  end if;
end;
$$;

create or replace function public.pelham_staff_bookings_stamp(p_from date, p_to date)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  -- 직원 확인은 pelham_staff_bookings 안에서 한다.
  select md5(public.pelham_staff_bookings(p_from, p_to)::text)
$$;

revoke all on function public.pelham_staff_bookings_stamp(date, date) from public, anon, authenticated;
grant execute on function public.pelham_staff_bookings_stamp(date, date) to authenticated;

notify pgrst, 'reload schema';

-- ===== 확인 ============================================================
-- 함수가 있고 직원(authenticated)이 부를 수 있어야 한다. SQL editor 는 직원 로그인이 아니라서
-- 여기서 직접 부르면 "직원 아님" 으로 거절되는 게 정상이다.

select p.proname, has_function_privilege('authenticated', p.oid, 'execute') as staff_can_call
  from pg_proc p
 where p.proname = 'pelham_staff_bookings_stamp';
