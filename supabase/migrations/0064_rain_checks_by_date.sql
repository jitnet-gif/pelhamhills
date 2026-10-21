-- 티 시트 격자의 ☂ 표시용 — 보이는 날짜(티타임 날짜) 범위의 레인체크를 한 번에 읽는다.
--
-- 왜(2026-10-21): 결제한 손님에게 레인체크를 내줘도 격자에는 아무 표시가 없었다. 0011 의
-- `pelham_staff_rain_checks(p_booking)` 은 예약 하나씩만 읽어서, 예약이 수십 개 보이는 격자가
-- 부르기에는 맞지 않는다.
--
--   pelham_staff_rain_checks_between(p_from, p_to) — tee_date 가 기간 안인 레인체크(무효 제외).
--     각 줄은 0011 `pelham_rc_json` 그대로다(status · expired 로 화면이 파랑/회색을 고른다).
--
-- (0063 은 고객 회원권 파일이 먼저 썼다.) 기간은 최대 62일(주간 뷰는 7일). 전제: 0011. 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다.

do $$
begin
  if to_regclass('public.pelham_rain_checks') is null then
    raise exception '0064 needs 0011 first (pelham_rain_checks is missing).';
  end if;
end;
$$;

create index if not exists pelham_rain_checks_tee_date_idx on public.pelham_rain_checks (tee_date);

create or replace function public.pelham_staff_rain_checks_between(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.pelham_require_staff();
  if p_from is null or p_to is null or p_to < p_from then
    perform public.pelham_fail('422', 'Pick a From date on or before the To date.');
  end if;
  if p_to - p_from > 62 then
    perform public.pelham_fail('422', 'Pick 62 days or fewer.');
  end if;
  return coalesce((
    select jsonb_agg(public.pelham_rc_json(r) order by r.issued_at, r.id)
      from public.pelham_rain_checks r
     where r.tee_date between p_from and p_to
       and r.status <> 'void'
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.pelham_staff_rain_checks_between(date, date) from public, anon;
grant execute on function public.pelham_staff_rain_checks_between(date, date) to authenticated;

notify pgrst, 'reload schema';
