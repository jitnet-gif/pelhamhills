-- 해 뜨기 전·해 진 뒤의 티타임은 예약할 수 없다.
--
-- 왜(2026-10-20): 격자는 1년 내내 6:40 AM ~ 6:58 PM 인데, 가을·겨울에는 해가 7시 넘어 뜨고
-- 6시 반 전에 진다. 어두운 시간에 웹·전화로 예약이 들어오면 안 된다.
--
-- 일출·일몰은 티시트 상단(`frontend/components/teesheet/DateNav.tsx` 의 `sunMinutes`)과 **같은 식**
-- (NOAA, 천정각 90.833°, 클럽 위치 43.03N 79.29W, America/Toronto)으로 계산하고, 분 아래는 버린다.
-- 그래서 화면에 "Sunrise 7:31" 이 보이면 7:31 이후 첫 칸부터, "Sunset 6:24" 면 6:24 까지의 칸만 열린다.
-- 백엔드(`backend/api/routes/tee_sheet.py` 의 `sun_minutes`)도 같은 식이다.
--
-- 막는 곳:
--   - `pelham_tee_availability`(손님 웹) — 어두운 칸을 목록에서 뺀다.
--   - `pelham_staff_slots`(직원 시트) — 어두운 칸을 시트에서 뺀다. 이미 그 시각에 있던 예약은
--     시트 아래 "no slot" 줄에 그대로 보인다(사라지지 않는다).
--   - 트리거 `pelham_tee_daylight_guard` — 누가 어떤 길로 쓰든(웹·직원·손님 변경·전화 비서) 오늘 이후
--     날짜에 어두운 시각으로 **새로 자리를 잡는** 쓰기를 PT422 로 거절한다. 지난 날짜(나중에 적는
--     전화 예약, 옛 기록)와 막힌 슬롯(`blocked`)은 보지 않는다. 시각을 바꾸지 않는 수정(메모·인원)도
--     막지 않는다.
--
-- 전제: 0003, 0004, 0045. 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다.

do $$
begin
  if to_regprocedure('public.pelham_tee_rate_for(date, integer)') is null then
    raise exception '0048 needs 0045 first (pelham_tee_rate_for is missing).';
  end if;
end;
$$;

-- ===== 일출·일몰 (클럽 현지 자정부터의 분) ===================================

create or replace function public.pelham_tee_sun(p_date date, out sunrise integer, out sunset integer)
language plpgsql
stable
set search_path = ''
as $$
declare
  g double precision := 2 * pi() / 365 * (extract(doy from p_date) - 1);
  eq_time double precision;
  decl double precision;
  lat double precision := radians(43.03);
  ha double precision;
  noon_utc double precision;
  t timestamp;
begin
  eq_time := 229.18 * (0.000075 + 0.001868 * cos(g) - 0.032077 * sin(g)
                       - 0.014615 * cos(2 * g) - 0.040849 * sin(2 * g));
  decl := 0.006918 - 0.399912 * cos(g) + 0.070257 * sin(g) - 0.006758 * cos(2 * g)
          + 0.000907 * sin(2 * g) - 0.002697 * cos(3 * g) + 0.00148 * sin(3 * g);
  ha := degrees(acos(cos(radians(90.833)) / (cos(lat) * cos(decl)) - tan(lat) * tan(decl)));
  noon_utc := 720 - 4 * (-79.29) - eq_time;

  t := ((p_date::timestamp + make_interval(secs => (noon_utc - 4 * ha) * 60)) at time zone 'UTC')
       at time zone 'America/Toronto';
  sunrise := extract(hour from t)::integer * 60 + extract(minute from t)::integer;
  t := ((p_date::timestamp + make_interval(secs => (noon_utc + 4 * ha) * 60)) at time zone 'UTC')
       at time zone 'America/Toronto';
  sunset := extract(hour from t)::integer * 60 + extract(minute from t)::integer;
end;
$$;

create or replace function public.pelham_tee_in_daylight(p_date date, p_minutes integer)
returns boolean
language sql
stable
set search_path = ''
as $$
  select p_minutes between s.sunrise and s.sunset from public.pelham_tee_sun(p_date) s
$$;

-- ===== 쓰기 막기 ==========================================================

create or replace function public.pelham_tee_daylight_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_minutes integer;
  v_sun record;
begin
  if new.booking_date is null or new.tee_time is null
     or coalesce(new.status, '') in ('cancelled', 'blocked')
     or jsonb_array_length(coalesce(new.doc->'players', '[]'::jsonb)) = 0
     or new.booking_date < public.pelham_local_now()::date then
    return new;
  end if;
  -- 시각이 그대로이고 원래도 자리를 차지하던 줄이면 통과(옛 예약의 메모·인원 수정).
  if tg_op = 'UPDATE'
     and old.booking_date = new.booking_date
     and old.tee_time = new.tee_time
     and coalesce(old.status, '') not in ('cancelled', 'blocked') then
    return new;
  end if;

  v_minutes := public.pelham_tee_minutes(new.tee_time);
  if v_minutes is null or public.pelham_tee_in_daylight(new.booking_date, v_minutes) then
    return new;
  end if;
  v_sun := public.pelham_tee_sun(new.booking_date);
  if v_minutes < v_sun.sunrise then
    perform public.pelham_fail('422', format(
      '%s on %s is before sunrise (%s). Tee times start at sunrise.',
      new.tee_time, to_char(new.booking_date, 'YYYY-MM-DD'), public.pelham_tee_label(v_sun.sunrise)));
  end if;
  perform public.pelham_fail('422', format(
    '%s on %s is after sunset (%s). Tee times end at sunset.',
    new.tee_time, to_char(new.booking_date, 'YYYY-MM-DD'), public.pelham_tee_label(v_sun.sunset)));
  return new;
end;
$$;

drop trigger if exists pelham_tee_daylight_guard on public.pelham_tee_bookings;
create trigger pelham_tee_daylight_guard
  before insert or update on public.pelham_tee_bookings
  for each row execute function public.pelham_tee_daylight_guard();

-- ===== 빈 티타임 목록 (0045 그대로 + 해 있는 칸만) ============================

create or replace function public.pelham_tee_availability(p_date date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  local_now timestamp := public.pelham_local_now();
  now_min integer := extract(hour from local_now) * 60 + extract(minute from local_now);
  v_nine_from integer;
  v_rate9 numeric;
  v_base numeric;
  result jsonb;
begin
  if p_date is null then
    perform public.pelham_fail('422', '''date'' must be an ISO date (YYYY-MM-DD)');
  end if;
  v_nine_from := public.pelham_tee_nine_from(p_date);
  v_rate9 := public.pelham_tee_rate_for(p_date, 9);
  v_base := public.pelham_tee_rate(p_date);

  with grid as (
    select m as minutes, public.pelham_tee_label(m) as label
      from generate_series(6 * 60 + 40, 18 * 60 + 58, 9) as m
     where public.pelham_tee_in_daylight(p_date, m)
  ),
  day as (
    select t.tee_time,
           t.status,
           jsonb_array_length(coalesce(t.doc->'players', '[]'::jsonb)) as seats
      from public.pelham_tee_bookings t
     where t.booking_date = p_date
       and coalesce(t.status, '') <> 'cancelled'
       and (t.hold_expires_at is null or t.hold_expires_at > now())
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'time', g.label,
           'minutes', g.minutes,
           'rate', public.pelham_tee_rate_at(p_date, g.minutes, 18),
           'rate9', v_rate9,
           'nineFrom', v_nine_from,
           'dayType', public.pelham_tee_day_type(p_date),
           'twilight', public.pelham_tee_rate_at(p_date, g.minutes, 18) <> v_base,
           'nineHoles', g.minutes >= v_nine_from,
           'remaining', greatest(4 - coalesce((select sum(d.seats) from day d where d.tee_time = g.label), 0), 0)
         ) order by g.minutes), '[]'::jsonb)
    into result
    from grid g
   where not exists (select 1 from day d where d.tee_time = g.label and d.status = 'blocked')
     and (p_date > local_now::date or (p_date = local_now::date and g.minutes > now_min));

  return jsonb_build_object('date', to_char(p_date, 'YYYY-MM-DD'), 'times', result);
end;
$$;

-- ===== 직원 시트 슬롯 (0045 그대로 + 해 있는 칸만) ============================

create or replace function public.pelham_staff_slots(p_date date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_slots jsonb;
  v_type text;
  v_holiday text;
  v_card text;
  v_rate9 numeric;
  v_nine_from integer;
begin
  perform public.pelham_require_staff();
  if p_date is null then
    perform public.pelham_fail('422', '''date'' must be an ISO date (YYYY-MM-DD)');
  end if;

  v_type := public.pelham_tee_day_type(p_date);
  select h.name into v_holiday from public.pelham_tee_holidays h where h.holiday_date = p_date;
  select c.name into v_card from public.pelham_tee_rate_cards c where c.code = public.pelham_tee_card(p_date);
  v_rate9 := public.pelham_tee_rate_for(p_date, 9);
  v_nine_from := public.pelham_tee_nine_from(p_date);

  select jsonb_agg(jsonb_build_object(
           'time', public.pelham_tee_label(g.m),
           'minutes', g.m,
           'rate', public.pelham_tee_rate_at(p_date, g.m, 18),
           'rate9', v_rate9,
           'nineFrom', v_nine_from,
           'rateCard', v_card,
           'cartsTotal', 4,
           'dayType', v_type,
           'holiday', v_holiday
         ) order by g.m)
    into v_slots
    from generate_series(400, 1138, 9) as g(m)
   where public.pelham_tee_in_daylight(p_date, g.m);

  return jsonb_build_object('date', to_char(p_date, 'YYYY-MM-DD'), 'slots', coalesce(v_slots, '[]'::jsonb));
end;
$$;

-- ===== 권한 ============================================================

revoke all on function public.pelham_tee_sun(date) from public, anon, authenticated;
revoke all on function public.pelham_tee_in_daylight(date, integer) from public, anon, authenticated;
revoke all on function public.pelham_tee_daylight_guard() from public, anon, authenticated;
revoke all on function public.pelham_tee_availability(date) from public;
revoke all on function public.pelham_staff_slots(date) from public, anon, authenticated;
grant execute on function public.pelham_tee_availability(date) to anon, authenticated;
grant execute on function public.pelham_staff_slots(date) to authenticated;

notify pgrst, 'reload schema';
