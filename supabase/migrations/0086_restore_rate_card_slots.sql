-- 티 시트 요금을 요금표(0045)로 되돌린다.
--
-- 왜(2026-10-23): 운영 티 시트가 하루 종일 평일 $47.79·주말 $58.41 을 보였다. Lightspeed 는 10/23(금)
-- 평일 숄더 요금 2 PM 전 $40.71, 2 PM 부터 $35.40. 이 모양은 0025 를 다시 붙여 실행했을 때와 같다 —
-- 0025 가 `pelham_tee_rate`(토·일 58.41, 그 외 47.79)와 `pelham_staff_slots`(하루 한 가격)를
-- 옛 정의로 덮어쓴다. 예약 그린피는 0045 트리거(`pelham_tee_rate_at`)가 매기므로 0025 가 건드리지 않았다.
--
-- 바뀌는 것
-- 1. `pelham_tee_rate` — 0045 정의(그날 요금표의 첫 가격대). 요일 탭 머리(`pelham_staff_rate_days`)가 이 값을 쓴다.
-- 2. `pelham_staff_slots` — 0051 정의(칸마다 `pelham_tee_rate_at`, 9홀·일출·블록 정보).
-- 3. 미결제 예약의 rate 를 그 시각 요금표 값으로 맞춘다(0045 와 같은 방식, 오늘 이후·취소 아님·미결제).
--    직원 시트에서 새로 잡은 예약은 칸의 47.79 를 들고 왔고, 트리거(0055)는 요금표 값(40.71)과 다르니
--    직원이 적은 금액으로 보고 그대로 뒀다. 그 예약들이 여기서 고쳐진다.
-- 4. 끝의 확인 쿼리 두 개: 오늘 2 PM 전·후 요금, 옛 고정값으로 이미 결제된 숄더 시즌 예약.
--
-- 다시 실행하지 말 것: 0025 이하의 옛 파일. 요금은 0045 의 표(`pelham_tee_rate_bands`)에서 바꾼다.
--
-- 전제: 0045, 0051. 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다.

do $$
begin
  if to_regclass('public.pelham_tee_rate_bands') is null
     or to_regprocedure('public.pelham_tee_rate_at(date, integer, integer)') is null then
    raise exception '0086 needs 0045 first (pelham_tee_rate_bands / pelham_tee_rate_at is missing).';
  end if;
  if to_regprocedure('public.pelham_tee_grid(date)') is null
     or to_regprocedure('public.pelham_tee_slot_open(date, integer)') is null then
    raise exception '0086 needs 0051 first (pelham_tee_grid / pelham_tee_slot_open is missing).';
  end if;
end;
$$;

-- 1. 0045 그대로.
create or replace function public.pelham_tee_rate(p_date date)
returns numeric
language sql
stable
set search_path = ''
as $$
  select public.pelham_tee_rate_at(p_date, 0, 18)
$$;
revoke all on function public.pelham_tee_rate(date) from public, anon, authenticated;

-- 2. 0051 그대로.
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
           'holiday', v_holiday,
           'dark', not public.pelham_tee_auto_open(p_date, g.m),
           'locked', not public.pelham_tee_slot_open(p_date, g.m),
           'lock', (select case when l.locked then 'blocked' else 'released' end
                      from public.pelham_tee_slot_locks l
                     where l.booking_date = p_date and l.minutes = g.m)
         ) order by g.m)
    into v_slots
    from public.pelham_tee_grid(p_date) as g(m);

  return jsonb_build_object('date', to_char(p_date, 'YYYY-MM-DD'), 'slots', coalesce(v_slots, '[]'::jsonb));
end;
$$;
revoke all on function public.pelham_staff_slots(date) from public, anon, authenticated;
grant execute on function public.pelham_staff_slots(date) to authenticated;

-- 3. 0045 와 같은 재계산. 자동값(요금표·옛 기본값)인 미결제 예약만, 직원이 손으로 적은 금액은 그대로.
--    같은 UPDATE 로 트리거(0055)가 선수별 greenFee·카트를 다시 매긴다.
update public.pelham_tee_bookings t
   set doc = case
               when jsonb_typeof(t.doc->'rate') = 'number'
                    and round((t.doc->>'rate')::numeric, 2) in (40.71, 35.40, 51.33, 46.02, 28.31, 38.94, 47.79, 58.41)
                    and public.pelham_tee_minutes(coalesce(t.tee_time, t.doc->>'time')) is not null
               then jsonb_set(t.doc, '{rate}', to_jsonb(public.pelham_tee_rate_at(
                      t.booking_date,
                      public.pelham_tee_minutes(coalesce(t.tee_time, t.doc->>'time')),
                      case when coalesce(nullif(t.doc->>'holes', '')::integer, 18) = 9 then 9 else 18 end)))
               else t.doc
             end
 where t.booking_date >= public.pelham_local_now()::date
   and coalesce(t.status, '') not in ('paid', 'cancelled', 'blocked')
   and not exists (select 1 from jsonb_array_elements(
                     case when jsonb_typeof(t.doc->'players') = 'array' then t.doc->'players' else '[]'::jsonb end) p
                    where coalesce((p.value->>'paid')::boolean, false));

-- 확인: 오늘 2 PM 전·후 요금. 평일 숄더면 40.71 / 35.40.
select public.pelham_tee_card(public.pelham_local_now()::date) as card,
       public.pelham_tee_rate(public.pelham_local_now()::date) as day_rate,
       public.pelham_tee_rate_at(public.pelham_local_now()::date, 13 * 60 + 52, 18) as at_1_52pm,
       public.pelham_tee_rate_at(public.pelham_local_now()::date, 14 * 60 + 1, 18) as at_2_01pm;

-- 확인: 숄더 시즌(10/1~)에 옛 고정값 47.79·58.41 로 결제까지 끝난 예약. 3번은 결제된 예약을 고치지 않으니
-- 여기 나오는 줄은 손님에게 더 받았는지 직원이 확인한다.
select t.booking_date, t.tee_time, t.status, t.doc->>'rate' as rate, t.doc->>'title' as title
  from public.pelham_tee_bookings t
 where t.booking_date >= date '2026-10-01'
   and public.pelham_tee_card(t.booking_date) in ('weekday_shoulder', 'weekend_shoulder')
   and jsonb_typeof(t.doc->'rate') = 'number'
   and round((t.doc->>'rate')::numeric, 2) in (47.79, 58.41)
   and (coalesce(t.status, '') = 'paid'
        or exists (select 1 from jsonb_array_elements(
                     case when jsonb_typeof(t.doc->'players') = 'array' then t.doc->'players' else '[]'::jsonb end) p
                    where coalesce((p.value->>'paid')::boolean, false)))
 order by t.booking_date, t.tee_time;
