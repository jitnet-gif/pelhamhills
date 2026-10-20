-- Lightspeed(Chronogolf) 2026 요금표를 그대로: 날짜 → 요금표, 시각 → 가격대, 요금제 → 1인 그린피·카트.
--
-- 왜(2026-10-19): 클럽이 Lightspeed 관리자의 활성 요금표 17개를 정리한 요금 정책
-- (https://claude.ai/artifact/E4hw145aCiExyuuaUHcjjC)을 "이대로 티시트에 적용" 하라고 했다.
-- 지금까지는 평일/주말 두 값 + 오후 2시 트와일라잇(0041)뿐이라 정규 시즌(5/8–9/30)의 가격,
-- 오후 5시 가격대, 금요일·공휴일 요금표, 9홀 시각, 회원 $0 이 없었다.
--
-- 규칙(요금은 모두 세전, HST 13% 별도):
--   1) 날짜 → 요금표 하나 (`pelham_tee_card`)
--        공휴일   Victoria Day → victoria, Canada Day → weekend, 그 밖의 공휴일 → friday(Civic·Labour·Thanksgiving 표)
--        정규 시즌 5/8–9/30: 월–목 weekday, 금 friday(6월 금요일은 june_friday), 토·일 weekend,
--                  2026-06-25~06-30 월–목은 sixty(60주년 스페셜)
--        그 밖(가을 숄더 10/1–12/15, 오픈 숄더 4/26–5/7, 비시즌): 월–금 weekday_shoulder, 토·일 weekend_shoulder
--   2) 요금표 → 시각별 18홀 가격 (`pelham_tee_rate_bands`, from_minutes 이후 그 가격)
--   3) 9홀은 요금표마다 한 가격과 판매 시작 시각 (`pelham_tee_rate_cards.nine_*`)
--   4) 공휴일 행에 `rate` 를 따로 적은 날은 18홀이 하루 내내 그 값 (0025 그대로)
--   5) 플레이어 요금제 → 1인 그린피 (`pelham_tee_plan_fee`). null 이면 예약의 rate(퍼블릭가)를 낸다.
--        회원 등급 $0 · 시니어 $40.71/$30.97(가을 주말 숄더 제외) · 주니어 · Friends & Family · LS League
--        이용 시간 밖(9홀 회원의 주말 18홀, 트와일라잇 회원 15시 전, 직원 주말 16시 전)은 퍼블릭가.
--        Lightspeed 는 이 칸을 $1 로 막아 두었다 — 여기서는 막는 대신 퍼블릭가를 받는다.
--   6) 카트 (`pelham_tee_cart_fee_on`): 7 Day Cart 회원 $0, Weekday Cart 회원 평일 $0,
--        시니어 평일 $17.70/$9.74, 그 외 하프카트 $19.47/$11.50.
--
-- 저장: 선수 doc 에 `greenFee`(세전 달러)가 붙는다. 없으면 예약 `rate` 를 낸다.
--   `pelham_pos_tee_price` 가 이것을 읽으므로 계산서·온라인 결제·레인 체크가 같이 따라온다.
--   예약을 쓰는 함수들은 고치지 않는다 — `pelham_tee_bookings` 의 BEFORE 트리거가 저장 직전에 맞춘다:
--     - 예약 rate 가 자동값(그 날·그 홀 수의 기본값, 또는 이전 날짜·시각의 자동값)이면 그 시각의 가격으로.
--       직원이 손으로 적은 금액, 결제가 시작된 예약은 그대로.
--     - 결제 안 된 선수마다 greenFee 를 요금제로 다시 매기고, 카트 요금이 자동값이면 요일에 맞춘다.
--
-- 이 파일은 0041(트와일라잇)을 대신한다. 0041 을 아직 안 돌렸어도 이것만 돌리면 된다.
-- 같은 값이 `frontend/lib/rateCard.ts`, `backend/api/routes/tee_sheet.py` 에도 있다. 바꾸면 같이 고쳐라.
--
-- 마지막에 오늘 이후의 결제 안 된 예약을 새 요금으로 한 번 다시 매긴다(결제된 예약·선수는 그대로).
--
-- 전제: 0004, 0005, 0025, 0026, 0034. 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다.

do $$
begin
  if to_regclass('public.pelham_tee_holidays') is null then
    raise exception '0045 needs 0025 first (pelham_tee_holidays is missing).';
  end if;
  if to_regprocedure('public.pelham_tee_minutes(text)') is null then
    raise exception '0045 needs 0004 first (pelham_tee_minutes is missing).';
  end if;
  if to_regprocedure('public.pelham_tee_extras_total(jsonb)') is null then
    raise exception '0045 needs 0026 first (pelham_tee_extras_total is missing).';
  end if;
end;
$$;

-- ===== 요금표 ============================================================

create table if not exists public.pelham_tee_rate_cards (
  code        text primary key,
  name        text not null,
  -- 9홀 1인 가격과 판매 시작(자정부터 분). null = 9홀 없음.
  nine_rate   numeric(8,2),
  nine_from   integer,
  sort        integer not null default 0
);

create table if not exists public.pelham_tee_rate_bands (
  card          text not null references public.pelham_tee_rate_cards(code) on delete cascade,
  from_minutes  integer not null check (from_minutes >= 0),
  rate          numeric(8,2) not null check (rate >= 0),
  primary key (card, from_minutes)
);

alter table public.pelham_tee_rate_cards enable row level security;
alter table public.pelham_tee_rate_bands enable row level security;
revoke all on public.pelham_tee_rate_cards from public, anon, authenticated;
revoke all on public.pelham_tee_rate_bands from public, anon, authenticated;

insert into public.pelham_tee_rate_cards (code, name, nine_rate, nine_from, sort) values
  ('weekday',          'Weekday 2026',                 34.52, 600, 1),
  ('friday',           'Weekend Friday''s / Holiday',  35.40, 960, 2),
  ('weekend',          'Weekend 2026',                 35.40, 960, 3),
  ('june_friday',      'WE June Friday''s',            35.40, 960, 4),
  ('sixty',            '60th Anniversary Special',     34.52, 600, 5),
  ('victoria',         'Victoria Day',                 34.52, 600, 6),
  ('weekday_shoulder', 'Weekday Shoulder',             28.31, 600, 7),
  ('weekend_shoulder', 'Weekend Shoulder',             38.94, 960, 8)
on conflict (code) do update
  set name = excluded.name, nine_rate = excluded.nine_rate, nine_from = excluded.nine_from, sort = excluded.sort;

delete from public.pelham_tee_rate_bands
 where card in (select code from public.pelham_tee_rate_cards);

insert into public.pelham_tee_rate_bands (card, from_minutes, rate) values
  ('weekday',            0, 47.79), ('weekday',          840, 38.94), ('weekday',          1020, 34.52),
  ('friday',             0, 58.41), ('friday',           840, 46.90), ('friday',           1020, 39.94),
  ('weekend',            0, 58.41), ('weekend',          840, 46.90), ('weekend',          1020, 38.94),
  ('june_friday',        0, 58.41), ('june_friday',      720, 49.56), ('june_friday',      1020, 38.94),
  ('sixty',              0, 47.79), ('sixty',            780, 38.94), ('sixty',            1020, 34.52),
  ('victoria',           0, 47.79), ('victoria',         840, 38.94),
  ('weekday_shoulder',   0, 40.71), ('weekday_shoulder', 840, 35.40),
  ('weekend_shoulder',   0, 51.33), ('weekend_shoulder', 840, 46.02);

-- ===== 날짜 → 요금표 =======================================================

create or replace function public.pelham_tee_card(p_date date)
returns text
language sql
stable
set search_path = ''
as $$
  select case
    when h.name = 'Victoria Day' then 'victoria'
    when h.name = 'Canada Day' then 'weekend'
    when h.name is not null then 'friday'
    when to_char(p_date, 'MM-DD') between '05-08' and '09-30' then
      case
        when p_date between date '2026-06-25' and date '2026-06-30' and extract(isodow from p_date) between 1 and 4 then 'sixty'
        when extract(isodow from p_date) = 5 and extract(month from p_date) = 6 then 'june_friday'
        when extract(isodow from p_date) = 5 then 'friday'
        when extract(isodow from p_date) in (6, 7) then 'weekend'
        else 'weekday'
      end
    when extract(isodow from p_date) in (6, 7) then 'weekend_shoulder'
    else 'weekday_shoulder'
  end
  from (select (select x.name from public.pelham_tee_holidays x where x.holiday_date = p_date) as name) h
$$;

-- 그날, 그 시각, 그 홀 수의 퍼블릭 1인 그린피.
create or replace function public.pelham_tee_rate_at(p_date date, p_minutes integer, p_holes integer)
returns numeric
language sql
stable
set search_path = ''
as $$
  select case
    when p_holes = 9 then (select c.nine_rate from public.pelham_tee_rate_cards c where c.code = public.pelham_tee_card(p_date))
    else coalesce(
      (select h.rate from public.pelham_tee_holidays h where h.holiday_date = p_date and h.rate is not null),
      (select b.rate from public.pelham_tee_rate_bands b
        where b.card = public.pelham_tee_card(p_date) and b.from_minutes <= coalesce(p_minutes, 0)
        order by b.from_minutes desc limit 1))
  end
$$;

-- 0025 이후의 이름 그대로: 그날의 기본(첫 가격대) 18홀 요금. 예약을 처음 쓰는 함수들이 이 값을 적고,
-- 아래 트리거가 그 시각의 가격으로 바꾼다.
create or replace function public.pelham_tee_rate(p_date date)
returns numeric
language sql
stable
set search_path = ''
as $$
  select public.pelham_tee_rate_at(p_date, 0, 18)
$$;

create or replace function public.pelham_tee_rate_for(p_date date, p_holes integer)
returns numeric
language sql
stable
set search_path = ''
as $$
  select public.pelham_tee_rate_at(p_date, 0, case when p_holes = 9 then 9 else 18 end)
$$;

-- 9홀 판매 시작(분). 9홀이 없는 요금표는 24:00(어느 티타임도 닿지 않는다).
create or replace function public.pelham_tee_nine_from(p_date date)
returns integer
language sql
stable
set search_path = ''
as $$
  select coalesce((select c.nine_from from public.pelham_tee_rate_cards c
                    where c.code = public.pelham_tee_card(p_date) and c.nine_rate is not null), 24 * 60)
$$;

create or replace function public.pelham_tee_require_nine(p_date date, p_minutes integer)
returns void
language plpgsql
stable
set search_path = ''
as $$
declare
  v_from integer := public.pelham_tee_nine_from(p_date);
begin
  if p_minutes < v_from then
    perform public.pelham_fail('422', case when v_from >= 24 * 60
      then 'Nine holes are not available on this day. Please book 18 holes.'
      else format('Nine holes can be booked from %s on this day. Please pick a later tee time or 18 holes.',
                  public.pelham_tee_label(v_from))
    end);
  end if;
end;
$$;

-- 토·일·공휴일 = 회원·직원·카트 혜택의 "주말". 금요일은 평일이다.
create or replace function public.pelham_tee_weekendish(p_date date)
returns boolean
language sql
stable
set search_path = ''
as $$
  select public.pelham_tee_day_type(p_date) <> 'weekday'
$$;

-- ===== 요금제 → 1인 그린피 =================================================
-- null = 예약의 rate(퍼블릭가)를 낸다. p_public 은 그 예약의 rate.

create or replace function public.pelham_tee_plan_fee(p_plan text, p_date date, p_minutes integer, p_holes integer, p_public numeric)
returns numeric
language sql
stable
set search_path = ''
as $$
  with x as (
    select lower(btrim(coalesce(p_plan, ''))) as plan,
           public.pelham_tee_weekendish(p_date) as wkend,
           public.pelham_tee_card(p_date) as card,
           coalesce(p_minutes, 0) as m,
           p_holes = 9 as nine
  )
  select case
    when plan in ('', 'public', 'golfnow') or plan like '%golfnow%' then null
    when plan like '%staff%' then case when wkend and m < 960 then null else 0.00 end
    when plan like '%9 hole%member%' then
      case when not wkend then 0.00 when nine and m >= 960 then 0.00 else null end
    when plan like '%twilight%member%' then case when m >= 900 then 0.00 else null end
    when plan like '%member%' then 0.00
    when plan like '%friends%' then least(case when nine then 22.12 else 44.25 end, p_public)
    when plan like '%league%' then case when nine then null else 45.00 end
    when plan like '%senior%' then
      case when card = 'weekend_shoulder' then null
           else least(case when nine then 30.97 else 40.71 end, p_public) end
    when plan like '%junior%' then
      least(case when nine then 25.67
                 when m >= 840 then 32.75
                 when wkend then 34.40
                 else 35.40 end, p_public)
    else null
  end
  from x
$$;

-- 그날의 1인 카트 요금(세전). 0039 의 날짜 없는 `pelham_tee_cart_fee` 는 함수들이 처음 채우는 값으로 남고,
-- 트리거가 이 값으로 맞춘다.
create or replace function public.pelham_tee_cart_fee_on(p_plan text, p_holes integer, p_date date)
returns numeric
language sql
stable
set search_path = ''
as $$
  with x as (select lower(coalesce(p_plan, '')) as plan, public.pelham_tee_weekendish(p_date) as wkend)
  select case
    when plan like '%weekday cart%' and not wkend then 0.00
    when plan like '%cart%' and plan not like '%weekday cart%' then 0.00
    when plan like '%senior%' and plan not like '%member%' and not wkend then case when p_holes = 9 then 9.74 else 17.70 end
    when p_holes = 9 then 11.50
    else 19.47
  end
  from x
$$;

-- ===== 한 사람 몫 ==========================================================

-- 0026 그대로, 그린피만 선수의 greenFee 가 있으면 그것.
create or replace function public.pelham_pos_tee_price(p_doc jsonb, p_player jsonb)
returns integer
language sql
immutable
set search_path = ''
as $$
  select round((coalesce(case when jsonb_typeof(p_player->'greenFee') = 'number'
                              then (p_player->>'greenFee')::numeric end,
                         (p_doc->>'rate')::numeric, 0)
                + case when coalesce((p_player->>'cart')::boolean, false)
                       then coalesce((p_player->>'cartFee')::numeric, 0) else 0 end
                + public.pelham_tee_extras_total(p_player)) * 100)::integer
$$;

-- ===== 빈 티타임 목록 (0041 그대로 + 9홀 가격·시각을 요금표에서) =============

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

-- ===== 직원 시트 슬롯 (0041 그대로 + 요금표 이름·9홀) =========================

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
    from generate_series(400, 1138, 9) as g(m);

  return jsonb_build_object('date', to_char(p_date, 'YYYY-MM-DD'), 'slots', coalesce(v_slots, '[]'::jsonb));
end;
$$;

-- ===== 저장 직전에 요금표대로 ==============================================

create or replace function public.pelham_tee_bookings_time_rate()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_holes integer;
  v_minutes integer;
  v_rate numeric;
  v_want numeric;
  v_auto boolean;
  v_players jsonb := '[]'::jsonb;
  pl jsonb;
  v_old_pl jsonb;
  v_fee numeric;
  v_cart numeric;
  v_old_holes integer;
  v_old_minutes integer;
begin
  if new.doc is null or coalesce(new.status, '') in ('blocked', 'cancelled') then
    return new;
  end if;

  v_holes := case when coalesce(nullif(new.doc->>'holes', '')::integer, 18) = 9 then 9 else 18 end;
  v_minutes := public.pelham_tee_minutes(coalesce(new.tee_time, new.doc->>'time'));
  if v_minutes is null then
    return new;
  end if;
  if tg_op = 'UPDATE' then
    v_old_holes := case when coalesce(nullif(old.doc->>'holes', '')::integer, 18) = 9 then 9 else 18 end;
    v_old_minutes := public.pelham_tee_minutes(coalesce(old.tee_time, old.doc->>'time'));
  end if;

  -- 1) 예약 rate(퍼블릭가): 자동값일 때만, 결제가 시작되지 않은 예약만.
  --    수정(UPDATE)은 날짜·시각·홀 수가 바뀐 경우에만 — 직원이 일부러 적은 금액은 그대로 둔다(0041 과 같다).
  if jsonb_typeof(new.doc->'rate') = 'number'
     and (tg_op = 'INSERT'
          or new.booking_date is distinct from old.booking_date
          or v_minutes is distinct from v_old_minutes
          or v_holes is distinct from v_old_holes)
     and coalesce(new.status, '') <> 'paid'
     and not exists (select 1 from jsonb_array_elements(
                       case when jsonb_typeof(new.doc->'players') = 'array' then new.doc->'players' else '[]'::jsonb end) p
                      where coalesce((p.value->>'paid')::boolean, false)) then
    v_rate := (new.doc->>'rate')::numeric;
    v_want := public.pelham_tee_rate_at(new.booking_date, v_minutes, v_holes);
    v_auto := public.pelham_same_money(v_rate, public.pelham_tee_rate_for(new.booking_date, v_holes));
    if not v_auto and tg_op = 'UPDATE' then
      v_auto := public.pelham_same_money(v_rate, public.pelham_tee_rate_at(old.booking_date, v_old_minutes, v_old_holes))
                or public.pelham_same_money(v_rate, public.pelham_tee_rate_for(old.booking_date, v_old_holes));
    end if;
    if v_auto and v_want is not null and not public.pelham_same_money(v_rate, v_want) then
      new.doc := jsonb_set(new.doc, '{rate}', to_jsonb(v_want));
    end if;
  end if;

  -- 2) 선수마다: 요금제 그린피, 카트 요금(자동값일 때만).
  if jsonb_typeof(new.doc->'players') <> 'array' then
    return new;
  end if;
  v_rate := coalesce((new.doc->>'rate')::numeric, 0);

  for pl in select value from jsonb_array_elements(new.doc->'players') loop
    if not coalesce((pl->>'paid')::boolean, false) then
      v_fee := public.pelham_tee_plan_fee(pl->>'ratePlan', new.booking_date, v_minutes, v_holes, v_rate);
      if v_fee is null then
        pl := pl - 'greenFee';
      else
        pl := pl || jsonb_build_object('greenFee', v_fee);
      end if;

      if coalesce((pl->>'cart')::boolean, false) and jsonb_typeof(pl->'cartFee') = 'number' then
        v_cart := (pl->>'cartFee')::numeric;
        v_old_pl := null;
        if tg_op = 'UPDATE' and jsonb_typeof(old.doc->'players') = 'array' then
          select o.value into v_old_pl from jsonb_array_elements(old.doc->'players') o
           where o.value->>'id' = pl->>'id' limit 1;
        end if;
        if public.pelham_same_money(v_cart, public.pelham_tee_cart_fee(pl->>'ratePlan', v_holes))
           or (v_old_pl is not null and public.pelham_same_money(v_cart,
                 public.pelham_tee_cart_fee_on(v_old_pl->>'ratePlan', v_old_holes, old.booking_date))) then
          pl := pl || jsonb_build_object('cartFee', public.pelham_tee_cart_fee_on(pl->>'ratePlan', v_holes, new.booking_date));
        end if;
      end if;
    end if;
    v_players := v_players || jsonb_build_array(pl);
  end loop;

  if v_players is distinct from new.doc->'players' then
    new.doc := jsonb_set(new.doc, '{players}', v_players);
  end if;
  return new;
end;
$$;

drop trigger if exists pelham_tee_bookings_time_rate on public.pelham_tee_bookings;
create trigger pelham_tee_bookings_time_rate
  before insert or update on public.pelham_tee_bookings
  for each row execute function public.pelham_tee_bookings_time_rate();

revoke all on function public.pelham_tee_card(date) from public, anon, authenticated;
revoke all on function public.pelham_tee_rate_at(date, integer, integer) from public, anon, authenticated;
revoke all on function public.pelham_tee_rate(date) from public, anon, authenticated;
revoke all on function public.pelham_tee_rate_for(date, integer) from public, anon, authenticated;
revoke all on function public.pelham_tee_nine_from(date) from public, anon, authenticated;
revoke all on function public.pelham_tee_require_nine(date, integer) from public, anon, authenticated;
revoke all on function public.pelham_tee_weekendish(date) from public, anon, authenticated;
revoke all on function public.pelham_tee_plan_fee(text, date, integer, integer, numeric) from public, anon, authenticated;
revoke all on function public.pelham_tee_cart_fee_on(text, integer, date) from public, anon, authenticated;
revoke all on function public.pelham_pos_tee_price(jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.pelham_tee_bookings_time_rate() from public, anon, authenticated;

-- ===== 오늘 이후 결제 안 된 예약을 새 요금으로 =================================
-- 예약 rate 가 예전 자동값(평일·주말·트와일라잇·9홀 기본값)이면 그 시각의 가격으로 바꾸고,
-- 같은 UPDATE 로 트리거가 선수별 greenFee·카트를 매긴다. 직원이 손으로 적은 금액은 그대로.
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
