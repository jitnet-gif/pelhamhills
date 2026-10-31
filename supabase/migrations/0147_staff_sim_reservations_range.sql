-- Reports > Bookings (live) 조회 속도(2026-10-30 클럽 요청).
--
-- 왜: 베이 장부에 기간 함수가 없어서 화면이 날짜 수만큼 따로 불렀다. 7일이면 7번, 31일이면 31번을 30초마다.
--   요청 하나의 왕복만 0.2초가 넘어서 화면이 가장 늦은 요청을 기다렸다.
--
-- 바꾸는 것: 직원 함수 `pelham_staff_sim_reservations_range(from, to)` 하나 — 기간 전체를 한 번에 돌려준다.
--   기존 함수·표는 그대로다. 줄 모양은 `pelham_staff_sim_reservations`(0007) 와 같다.
--
-- 전제: 0007. 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다.
-- 이 SQL 전에 화면이 배포돼도 괜찮다 — 함수가 없으면 화면은 예전처럼 하루씩 읽는다.

do $$
begin
  if to_regprocedure('public.pelham_staff_sim_reservations(date)') is null then
    raise exception '0147 needs 0007 first (pelham_staff_sim_reservations is missing).';
  end if;
end;
$$;

create or replace function public.pelham_staff_sim_reservations_range(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.pelham_require_staff();
  if p_from is null or p_to is null or p_to < p_from then
    perform public.pelham_fail('422', 'Give a date range.');
  end if;
  return coalesce((
    select jsonb_agg(public.pelham_sim_reservation_json(r) order by r.booking_date, r.start_minutes, r.bay_id)
      from public.pelham_sim_reservations r
     where r.booking_date between p_from and p_to
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.pelham_staff_sim_reservations_range(date, date) from public, anon, authenticated;
grant execute on function public.pelham_staff_sim_reservations_range(date, date) to authenticated;

notify pgrst, 'reload schema';

-- ===== 확인 ============================================================
-- 함수가 있고 직원(authenticated)이 부를 수 있어야 한다. SQL editor 는 직원 로그인이 아니라서
-- 여기서 직접 부르면 "직원 아님" 으로 거절되는 게 정상이다.

select p.proname, has_function_privilege('authenticated', p.oid, 'execute') as staff_can_call
  from pg_proc p
 where p.proname = 'pelham_staff_sim_reservations_range';
