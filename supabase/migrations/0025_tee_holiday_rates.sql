-- 티타임 요금: 주중 · 주말 · 공휴일.
--
-- 왜(2026-10-14): 요금은 "토·일 58.41, 그 외 47.79" 두 가지뿐이라 공휴일(예: 10-12 Thanksgiving 월요일)이
-- 평일 요금으로 팔렸다. 티 시트가 행마다 그 날 요금을 보여 주고, 공휴일은 공휴일 요금을 받는다.
--
-- 공휴일 요금은 기본 58.41(주말과 같다). 날마다 다르게 받으려면 `rate` 를 채운다:
--   update public.pelham_tee_holidays set rate = 62.00 where holiday_date = '2027-07-01';
--   insert into public.pelham_tee_holidays (holiday_date, name) values ('2027-06-20', 'Club Day');  -- 추가
--   delete from public.pelham_tee_holidays where holiday_date = '2027-08-02';                       -- 빼기
--
-- `pelham_tee_rate(date)` 의 이름·인자·반환형은 그대로다 — 손님 예약(0003)·직원 예약(0004)·
-- 예약 변경(0012)이 모두 이 함수 하나를 부르므로 고치는 곳이 여기 한 곳이다. 이미 받은 예약의
-- `rate` 는 건드리지 않는다(예약 doc 에 적힌 금액이 그대로 남는다).
--
-- 규칙은 0004 와 같다. 전제: 0003, 0004. 실행: SQL editor 에 이 파일 전체를 붙여 한 번(다시 실행해도 안전).

create table if not exists public.pelham_tee_holidays (
  holiday_date date primary key,
  name         text not null check (btrim(name) <> ''),
  -- null = 공휴일 기본 요금(pelham_tee_rate 참조)
  rate         numeric(8,2) check (rate is null or rate >= 0)
);

alter table public.pelham_tee_holidays enable row level security;
revoke all on public.pelham_tee_holidays from public, anon, authenticated;

-- 온타리오 법정 공휴일 + Civic Holiday(8월 첫 월요일 — 법정은 아니지만 골프장은 붐빈다).
insert into public.pelham_tee_holidays (holiday_date, name) values
  ('2026-01-01', 'New Year''s Day'),
  ('2026-02-16', 'Family Day'),
  ('2026-04-03', 'Good Friday'),
  ('2026-05-18', 'Victoria Day'),
  ('2026-07-01', 'Canada Day'),
  ('2026-08-03', 'Civic Holiday'),
  ('2026-09-07', 'Labour Day'),
  ('2026-10-12', 'Thanksgiving'),
  ('2026-12-25', 'Christmas Day'),
  ('2026-12-26', 'Boxing Day'),
  ('2027-01-01', 'New Year''s Day'),
  ('2027-02-15', 'Family Day'),
  ('2027-03-26', 'Good Friday'),
  ('2027-05-24', 'Victoria Day'),
  ('2027-07-01', 'Canada Day'),
  ('2027-08-02', 'Civic Holiday'),
  ('2027-09-06', 'Labour Day'),
  ('2027-10-11', 'Thanksgiving'),
  ('2027-12-25', 'Christmas Day'),
  ('2027-12-26', 'Boxing Day')
on conflict (holiday_date) do nothing;

-- 'holiday' > 'weekend' > 'weekday'. 공휴일이 토·일에 걸려도 공휴일이다.
create or replace function public.pelham_tee_day_type(p_date date)
returns text
language sql
stable
set search_path = ''
as $$
  select case
           when exists (select 1 from public.pelham_tee_holidays h where h.holiday_date = p_date) then 'holiday'
           when extract(isodow from p_date) in (6, 7) then 'weekend'
           else 'weekday'
         end
$$;

-- 표에서 읽으므로 immutable 이 아니라 stable 이다.
create or replace function public.pelham_tee_rate(p_date date)
returns numeric
language sql
stable
set search_path = ''
as $$
  select coalesce(
           (select coalesce(h.rate, 58.41) from public.pelham_tee_holidays h where h.holiday_date = p_date),
           case when extract(isodow from p_date) in (6, 7) then 58.41 else 47.79 end
         )
$$;

-- 0004 의 슬롯 함수 + 슬롯마다 dayType · holiday. 화면이 요금 옆에 "Holiday · Thanksgiving" 을 단다.
create or replace function public.pelham_staff_slots(p_date date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_slots jsonb;
  v_rate numeric;
  v_type text;
  v_holiday text;
begin
  perform public.pelham_require_staff();
  if p_date is null then
    perform public.pelham_fail('422', '''date'' must be an ISO date (YYYY-MM-DD)');
  end if;

  v_rate := public.pelham_tee_rate(p_date);
  v_type := public.pelham_tee_day_type(p_date);
  select h.name into v_holiday from public.pelham_tee_holidays h where h.holiday_date = p_date;

  select jsonb_agg(jsonb_build_object(
           'time', public.pelham_tee_label(g.m),
           'minutes', g.m,
           'rate', v_rate,
           'cartsTotal', 4,
           'dayType', v_type,
           'holiday', v_holiday
         ) order by g.m)
    into v_slots
    from generate_series(400, 1138, 9) as g(m);

  return jsonb_build_object('date', to_char(p_date, 'YYYY-MM-DD'), 'slots', coalesce(v_slots, '[]'::jsonb));
end;
$$;

-- 기간의 날짜별 요금 — 요일 탭과 주간 격자의 열 머리에 쓴다. 한 번에 최대 62일.
create or replace function public.pelham_staff_rate_days(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v jsonb;
begin
  perform public.pelham_require_staff();
  if p_from is null or p_to is null or p_to < p_from then
    perform public.pelham_fail('422', '''from'' and ''to'' must be ISO dates with from <= to');
  end if;
  if p_to - p_from > 61 then
    perform public.pelham_fail('422', 'rate range is limited to 62 days');
  end if;

  select jsonb_agg(jsonb_build_object(
           'date', to_char(d::date, 'YYYY-MM-DD'),
           'rate', public.pelham_tee_rate(d::date),
           'dayType', public.pelham_tee_day_type(d::date),
           'holiday', (select h.name from public.pelham_tee_holidays h where h.holiday_date = d::date)
         ) order by d)
    into v
    from generate_series(p_from, p_to, interval '1 day') as d;

  return coalesce(v, '[]'::jsonb);
end;
$$;

revoke all on function public.pelham_tee_day_type(date) from public, anon, authenticated;
revoke all on function public.pelham_tee_rate(date) from public, anon, authenticated;
revoke all on function public.pelham_staff_slots(date) from public, anon, authenticated;
revoke all on function public.pelham_staff_rate_days(date, date) from public, anon, authenticated;
grant execute on function public.pelham_staff_slots(date) to authenticated;
grant execute on function public.pelham_staff_rate_days(date, date) to authenticated;
