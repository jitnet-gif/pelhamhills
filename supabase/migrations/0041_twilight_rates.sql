-- 트와일라잇 요금: 오후 2시부터 18홀 — 평일 $35.40, 주말·공휴일 $46.02 (세전).
--
-- 왜(2026-10-19): Chronogolf 가을 요금표에 트와일라잇이 있다. Chronogolf 마켓플레이스 API(club 19671,
-- Public)에서 읽은 값: 평일 14:01 티타임부터 $35.40 + tax = $40.00, 토·일 14:01 부터 $46.02 + tax = $52.00.
-- 9홀에는 트와일라잇이 없다(오후에도 평일 $28.31).
--
-- 규칙:
--   - 기준 시각은 오후 2시(840분). 그 시각 이후 첫 티타임부터 트와일라잇이다.
--   - 공휴일은 주말 트와일라잇($46.02). `pelham_tee_holidays.rate` 를 따로 채운 날은 그 값이 하루 내내 간다.
--   - 요금은 이제 날짜만이 아니라 시각에 따라 다르다. 그래서
--       * 빈 티타임 목록(`pelham_tee_availability`)과 직원 시트 슬롯(`pelham_staff_slots`)이 슬롯마다
--         그 시각의 요금을 준다. 손님 예약 화면과 직원 예약 창은 이 값을 그대로 쓴다.
--       * 예약을 쓰는 함수(손님 예약·변경, 직원 예약·변경, 음성 예약)는 날짜 요금을 적는다. 함수마다 고치는 대신
--         `pelham_tee_bookings` 의 BEFORE 트리거가 저장 직전에 맞춘다: 18홀 그린피가 **자동값**(그 날의
--         기본 요금 또는 트와일라잇 요금)일 때만 그 시각의 요금으로 바꾼다. 직원이 손으로 적은 금액,
--         결제가 끝난 예약은 건드리지 않는다.
--       * 수정(UPDATE) 때는 날짜·시각·홀 수가 바뀐 경우에만 맞춘다 — 직원이 오후 예약에 일부러
--         기본 요금을 적어 넣은 것은 그대로 둔다.
--   - 이미 적힌 예약은 이 파일을 실행해도 바뀌지 않는다(트리거는 다음 저장부터 돈다).
--
-- 같은 값이 `backend/api/routes/tee_sheet.py`(TWILIGHT_*), `frontend/app/golf/rates/page.tsx` 에도 있다.
-- 바꾸면 같이 고쳐라.
--
-- 전제: 0025, 0034, 0040. 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다.

do $$
begin
  if to_regprocedure('public.pelham_tee_rate_for(date, integer)') is null then
    raise exception '0041 needs 0034 first (pelham_tee_rate_for is missing).';
  end if;
  if to_regprocedure('public.pelham_tee_minutes(text)') is null then
    raise exception '0041 needs 0004 first (pelham_tee_minutes is missing).';
  end if;
end;
$$;

-- ===== 요금 ============================================================

-- 그 날의 18홀 트와일라잇 요금. 공휴일에 따로 적은 요금이 있으면 null(하루 내내 그 요금).
create or replace function public.pelham_tee_twilight_rate(p_date date)
returns numeric
language sql
stable
set search_path = ''
as $$
  select case when exists (select 1 from public.pelham_tee_holidays h
                            where h.holiday_date = p_date and h.rate is not null) then null
              when public.pelham_tee_day_type(p_date) = 'weekday' then 35.40
              else 46.02 end
$$;

-- 그날, 그 시각, 그 홀 수의 1인 그린피(세전).
create or replace function public.pelham_tee_rate_at(p_date date, p_minutes integer, p_holes integer)
returns numeric
language sql
stable
set search_path = ''
as $$
  select case when p_holes <> 9 and p_minutes >= 14 * 60
               and public.pelham_tee_twilight_rate(p_date) is not null
              then public.pelham_tee_twilight_rate(p_date)
              else public.pelham_tee_rate_for(p_date, p_holes) end
$$;

-- ===== 빈 티타임 목록 (0034 그대로, rate 만 슬롯 시각별) ====================

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
  result jsonb;
begin
  if p_date is null then
    perform public.pelham_fail('422', '''date'' must be an ISO date (YYYY-MM-DD)');
  end if;

  with grid as (
    select m as minutes, public.pelham_tee_label(m) as label
      from generate_series(6 * 60 + 40, 18 * 60 + 58, 9) as m
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
           'rate9', public.pelham_tee_rate_for(p_date, 9),
           'dayType', public.pelham_tee_day_type(p_date),
           'twilight', public.pelham_tee_rate_at(p_date, g.minutes, 18) <> public.pelham_tee_rate(p_date),
           'nineHoles', g.minutes >= public.pelham_tee_nine_from(p_date),
           'remaining', greatest(4 - coalesce((select sum(d.seats) from day d where d.tee_time = g.label), 0), 0)
         ) order by g.minutes), '[]'::jsonb)
    into result
    from grid g
   where not exists (select 1 from day d where d.tee_time = g.label and d.status = 'blocked')
     and (p_date > local_now::date or (p_date = local_now::date and g.minutes > now_min));

  return jsonb_build_object('date', to_char(p_date, 'YYYY-MM-DD'), 'times', result);
end;
$$;

-- ===== 직원 시트 슬롯 (0025 그대로, rate 만 슬롯 시각별) ==================

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
begin
  perform public.pelham_require_staff();
  if p_date is null then
    perform public.pelham_fail('422', '''date'' must be an ISO date (YYYY-MM-DD)');
  end if;

  v_type := public.pelham_tee_day_type(p_date);
  select h.name into v_holiday from public.pelham_tee_holidays h where h.holiday_date = p_date;

  select jsonb_agg(jsonb_build_object(
           'time', public.pelham_tee_label(g.m),
           'minutes', g.m,
           'rate', public.pelham_tee_rate_at(p_date, g.m, 18),
           'cartsTotal', 4,
           'dayType', v_type,
           'holiday', v_holiday
         ) order by g.m)
    into v_slots
    from generate_series(400, 1138, 9) as g(m);

  return jsonb_build_object('date', to_char(p_date, 'YYYY-MM-DD'), 'slots', coalesce(v_slots, '[]'::jsonb));
end;
$$;

-- ===== 저장 직전에 그 시각의 요금으로 ======================================

create or replace function public.pelham_tee_bookings_time_rate()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_holes integer;
  v_minutes integer;
  v_rate numeric;
  v_day numeric;
  v_twilight numeric;
  v_want numeric;
begin
  if new.doc is null or jsonb_typeof(new.doc->'rate') <> 'number' then
    return new;
  end if;
  if coalesce(new.status, '') in ('blocked', 'cancelled', 'paid') then
    return new;
  end if;
  v_holes := coalesce(nullif(new.doc->>'holes', '')::integer, 18);
  if tg_op = 'UPDATE'
     and new.booking_date is not distinct from old.booking_date
     and new.tee_time is not distinct from old.tee_time
     and (new.doc->>'holes') is not distinct from (old.doc->>'holes') then
    return new;
  end if;
  if v_holes = 9 then
    return new;
  end if;
  if exists (select 1 from jsonb_array_elements(
               case when jsonb_typeof(new.doc->'players') = 'array' then new.doc->'players' else '[]'::jsonb end) pl
              where coalesce((pl.value->>'paid')::boolean, false)) then
    return new;
  end if;

  v_minutes := public.pelham_tee_minutes(coalesce(new.tee_time, new.doc->>'time'));
  if v_minutes is null then
    return new;
  end if;

  v_rate := (new.doc->>'rate')::numeric;
  v_day := public.pelham_tee_rate(new.booking_date);
  v_twilight := public.pelham_tee_twilight_rate(new.booking_date);
  -- 자동값(그 날의 기본 요금이나 트와일라잇 요금)일 때만. 손으로 적은 금액은 그대로.
  if not (public.pelham_same_money(v_rate, v_day)
          or (v_twilight is not null and public.pelham_same_money(v_rate, v_twilight))) then
    return new;
  end if;

  v_want := public.pelham_tee_rate_at(new.booking_date, v_minutes, 18);
  if not public.pelham_same_money(v_rate, v_want) then
    new.doc := jsonb_set(new.doc, '{rate}', to_jsonb(v_want));
  end if;
  return new;
end;
$$;

drop trigger if exists pelham_tee_bookings_time_rate on public.pelham_tee_bookings;
create trigger pelham_tee_bookings_time_rate
  before insert or update on public.pelham_tee_bookings
  for each row execute function public.pelham_tee_bookings_time_rate();

revoke all on function public.pelham_tee_twilight_rate(date) from public, anon, authenticated;
revoke all on function public.pelham_tee_rate_at(date, integer, integer) from public, anon, authenticated;
revoke all on function public.pelham_tee_bookings_time_rate() from public, anon, authenticated;
