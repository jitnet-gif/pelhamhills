-- 주말·공휴일은 9홀 예약을 받지 않는다.
--
-- 왜(2026-10-18): 0034 는 주말·공휴일 9홀을 오후 3시부터 받았다. 클럽이 주말·공휴일에는 9홀을
-- 받지 않기로 했다(18홀만).
--
-- 규칙:
--   - `pelham_tee_nine_from(date)` — 평일 10:00 AM(600분), 주말·공휴일 24:00(1440분). 마지막 티타임이
--     6:58 PM 이라 어느 티타임도 1440 에 닿지 않는다 → 그 날은 9홀이 없다.
--     그래서 0034 의 함수들이 고칠 것 없이 따라온다:
--       · 빈 티타임 목록(`pelham_tee_availability`)의 `nineHoles` 가 주말·공휴일 내내 false → 예약 화면이 9홀 버튼을 끈다.
--       · 손님 웹 예약(`pelham_tee_book`)·손님 변경(`pelham_tee_guest_update`)은 9홀이면 422.
--   - `pelham_tee_require_nine` 의 문구만 주말·공휴일용으로 바꾼다.
--   - **직원 시트는 막지 않는다**(0034 그대로, 프로 샵 재량). 직원이 주말에 9홀로 잡으면 요금은
--     `pelham_tee_rate_for` 의 38.94 가 자동값으로 적힌다.
--   - 이미 잡힌 주말·공휴일 9홀 예약은 그대로 둔다. 손님은 이름·전화는 고칠 수 있고, 날짜·시각·홀 수를
--     바꾸면서 9홀로 남기는 것은 막힌다.
--
-- 같은 규칙이 `backend/api/routes/tee_sheet.py` 의 NINE_HOLE_FROM_MINUTES, `frontend/lib/greenFee.ts` 에 있다.
-- 바꾸면 셋을 같이 고쳐라.
--
-- 전제: 0034. 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다.

do $$
begin
  if to_regprocedure('public.pelham_tee_require_nine(date, integer)') is null then
    raise exception '0037 needs 0034 first (pelham_tee_require_nine is missing).';
  end if;
end;
$$;

-- 그 날 9홀을 칠 수 있는 첫 티타임(자정부터 분). 주말·공휴일은 1440 — 9홀 없음.
create or replace function public.pelham_tee_nine_from(p_date date)
returns integer
language sql
stable
set search_path = ''
as $$
  select case when public.pelham_tee_day_type(p_date) = 'weekday' then 10 * 60 else 24 * 60 end
$$;

-- 손님 쪽 문지기: 9홀 시작 시각보다 이른 티타임이면 422.
create or replace function public.pelham_tee_require_nine(p_date date, p_minutes integer)
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if p_minutes < public.pelham_tee_nine_from(p_date) then
    perform public.pelham_fail('422', case when public.pelham_tee_day_type(p_date) = 'weekday'
      then 'Nine holes can be booked from 10:00 AM on weekdays. Please pick a later tee time or 18 holes.'
      else 'Nine holes are not available on weekends or holidays. Please book 18 holes or pick a weekday.'
    end);
  end if;
end;
$$;

revoke all on function public.pelham_tee_nine_from(date) from public, anon, authenticated;
revoke all on function public.pelham_tee_require_nine(date, integer) from public, anon, authenticated;
