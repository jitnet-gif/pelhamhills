-- 티시트: 날짜마다 첫 티타임·마지막 티타임을 직원이 정한다(2026-10-29 클럽 요청).
--
-- 왜: "티시트의 타임을 막을 수 있는 기능 — 오픈 티타임과 마지막 티타임을 조정할 수 있도록".
--   0051 은 첫 티 = 일출, 마지막 티 = 일몰 2시간 전으로 자동이었고, 바꾸려면 칸을 하나씩 블록·릴리스했다.
--   이제 그날의 첫 티·마지막 티를 한 번에 정한다(토너먼트로 늦게 여는 날, 일찍 닫는 날).
--
-- 바꾸는 것:
--   - 표 `pelham_tee_day_hours(booking_date, first_tee, last_tee)` — 분(클럽 현지). null = 자동(일출·일몰-120).
--   - `pelham_tee_window(날짜)` — 이 표가 있으면 그 값. 자동 판정(`pelham_tee_auto_open`)·트리거·웹 빈 시간·
--     직원 시트·칸 블록이 모두 이 함수를 보므로 그대로 따라온다. 칸마다 블록·릴리스(0051)는 그 위에 얹힌다.
--   - 트리거 `pelham_tee_daylight_guard` — 문구만 "첫 티/마지막 티" 로(정한 시각을 말한다).
--   - 직원 함수 `pelham_staff_tee_hours(from, to)`·`pelham_staff_tee_hours_set(p)`. 직원이면 누구나(칸 블록과 같다).
--     시각을 정하면 그날의 수동 칸 설정 중 새 창 밖의 것과 릴리스(창 안이면 이미 열림)는 지운다 —
--     "8시에 연다" 고 했는데 7시 칸이 예전 릴리스로 열려 있지 않게. 창 안의 블록은 남는다.
--   이미 잡힌 예약은 옮기지 않는다(트리거는 시각을 바꿀 때만 본다). 창 밖에 남은 예약 수를 돌려준다.
--
-- 격자(6:40 + 9분, 일출 칸)는 그대로다. 첫 티·마지막 티는 그날 격자 위의 시각만 고를 수 있다.
--
-- 전제: 0051. 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다.

do $$
begin
  if to_regprocedure('public.pelham_tee_grid(date)') is null then
    raise exception '0131 needs 0051 first (pelham_tee_grid is missing).';
  end if;
end;
$$;

create table if not exists public.pelham_tee_day_hours (
  booking_date  date primary key,
  first_tee     integer check (first_tee between 0 and 1439),
  last_tee      integer check (last_tee between 0 and 1439),
  updated_by    text,
  updated_at    timestamptz not null default now(),
  check (first_tee is null or last_tee is null or first_tee <= last_tee)
);

alter table public.pelham_tee_day_hours enable row level security;
revoke all on public.pelham_tee_day_hours from anon, authenticated;
-- 전화 비서(백엔드, 서비스 키)는 PostgREST 로 읽는다.
grant select on public.pelham_tee_day_hours to service_role;

-- 첫 티·마지막 티: 직원이 정한 값, 없으면 일출 ~ 일몰 2시간 전.
create or replace function public.pelham_tee_window(p_date date, out first_tee integer, out last_tee integer)
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(h.first_tee, s.sunrise), coalesce(h.last_tee, s.sunset - 120)
    from public.pelham_tee_sun(p_date) s
    left join public.pelham_tee_day_hours h on h.booking_date = p_date
$$;

-- 0051 과 같고 창 밖 문구만 바뀐다.
create or replace function public.pelham_tee_daylight_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_minutes integer;
  v_win record;
begin
  if new.booking_date is null or new.tee_time is null
     or coalesce(new.status, '') in ('cancelled', 'blocked')
     or jsonb_array_length(coalesce(new.doc->'players', '[]'::jsonb)) = 0
     or new.booking_date < public.pelham_local_now()::date then
    return new;
  end if;
  if tg_op = 'UPDATE'
     and old.booking_date = new.booking_date
     and old.tee_time = new.tee_time
     and coalesce(old.status, '') not in ('cancelled', 'blocked') then
    return new;
  end if;

  v_minutes := public.pelham_tee_minutes(new.tee_time);
  if v_minutes is null or public.pelham_tee_slot_open(new.booking_date, v_minutes) then
    return new;
  end if;
  if exists (select 1 from public.pelham_tee_slot_locks l
              where l.booking_date = new.booking_date and l.minutes = v_minutes and l.locked) then
    perform public.pelham_fail('422', format(
      '%s on %s is blocked on the tee sheet. Release it first.',
      new.tee_time, to_char(new.booking_date, 'YYYY-MM-DD')));
  end if;
  v_win := public.pelham_tee_window(new.booking_date);
  if v_minutes < v_win.first_tee then
    perform public.pelham_fail('422', format(
      '%s on %s is before the first tee time (%s).',
      new.tee_time, to_char(new.booking_date, 'YYYY-MM-DD'), public.pelham_tee_label(v_win.first_tee)));
  end if;
  perform public.pelham_fail('422', format(
    '%s on %s is after the last tee time (%s).',
    new.tee_time, to_char(new.booking_date, 'YYYY-MM-DD'), public.pelham_tee_label(v_win.last_tee)));
  return new;
end;
$$;

-- 보이는 주의 직원 설정. [{date, first, last}] — first·last 는 분, null = 자동.
create or replace function public.pelham_staff_tee_hours(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.pelham_require_staff();
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 62 then
    perform public.pelham_fail('422', 'Give a date range of at most 62 days.');
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'date', to_char(h.booking_date, 'YYYY-MM-DD'),
             'first', h.first_tee,
             'last', h.last_tee
           ) order by h.booking_date)
      from public.pelham_tee_day_hours h
     where h.booking_date between p_from and p_to
  ), '[]'::jsonb);
end;
$$;

-- p: {date, first: "8:00 AM" | null, last: "3:58 PM" | null}. null(또는 빈 값) = 자동으로 되돌린다.
-- 돌려주는 것: {date, first, last(분, null = 자동), outside: 창 밖에 남은 예약 수}.
create or replace function public.pelham_staff_tee_hours_set(p jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_date date;
  v_first integer;
  v_last integer;
  v_by text;
  v_win record;
  v_outside integer;
begin
  perform public.pelham_require_staff();
  begin
    v_date := (p->>'date')::date;
  exception when others then
    perform public.pelham_fail('422', '''date'' must be an ISO date (YYYY-MM-DD)');
  end;
  if v_date is null then
    perform public.pelham_fail('422', '''date'' must be an ISO date (YYYY-MM-DD)');
  end if;
  if nullif(btrim(coalesce(p->>'first', '')), '') is not null then
    v_first := public.pelham_tee_require_slot(v_date, p->>'first');
  end if;
  if nullif(btrim(coalesce(p->>'last', '')), '') is not null then
    v_last := public.pelham_tee_require_slot(v_date, p->>'last');
  end if;
  select lower(u.email) into v_by from auth.users u where u.id = auth.uid();

  if v_first is null and v_last is null then
    delete from public.pelham_tee_day_hours h where h.booking_date = v_date;
  else
    insert into public.pelham_tee_day_hours as t (booking_date, first_tee, last_tee, updated_by)
    values (v_date, v_first, v_last, v_by)
    on conflict (booking_date) do update
      set first_tee = excluded.first_tee, last_tee = excluded.last_tee,
          updated_by = excluded.updated_by, updated_at = now();
  end if;

  v_win := public.pelham_tee_window(v_date);
  if v_win.first_tee > v_win.last_tee then
    perform public.pelham_fail('422', format(
      'The first tee time (%s) must not be after the last tee time (%s).',
      public.pelham_tee_label(v_win.first_tee), public.pelham_tee_label(v_win.last_tee)));
  end if;

  -- 새 창 밖의 수동 설정과 (창 안이면 이미 열린) 릴리스는 지운다. 창 안의 블록만 남는다.
  delete from public.pelham_tee_slot_locks l
   where l.booking_date = v_date
     and (not l.locked or l.minutes < v_win.first_tee or l.minutes > v_win.last_tee);

  select count(*) into v_outside
    from public.pelham_tee_bookings b
   where b.booking_date = v_date
     and coalesce(b.status, '') not in ('cancelled', 'blocked')
     and jsonb_array_length(coalesce(b.doc->'players', '[]'::jsonb)) > 0
     and (public.pelham_tee_minutes(b.tee_time) < v_win.first_tee
          or public.pelham_tee_minutes(b.tee_time) > v_win.last_tee);

  return jsonb_build_object(
    'date', to_char(v_date, 'YYYY-MM-DD'),
    'first', v_first,
    'last', v_last,
    'outside', v_outside);
end;
$$;

revoke all on function public.pelham_tee_window(date) from public, anon, authenticated;
revoke all on function public.pelham_tee_daylight_guard() from public, anon, authenticated;
revoke all on function public.pelham_staff_tee_hours(date, date) from public, anon, authenticated;
revoke all on function public.pelham_staff_tee_hours_set(jsonb) from public, anon, authenticated;
grant execute on function public.pelham_staff_tee_hours(date, date) to authenticated;
grant execute on function public.pelham_staff_tee_hours_set(jsonb) to authenticated;

notify pgrst, 'reload schema';

-- ===== 확인 ============================================================
-- 오늘부터 7일의 첫 티·마지막 티. 표에 줄이 없으면 일출·일몰-2시간.

select current_date + i as day,
       public.pelham_tee_label(w.first_tee) as first_tee,
       public.pelham_tee_label(w.last_tee) as last_tee,
       exists (select 1 from public.pelham_tee_day_hours h where h.booking_date = current_date + i) as set_by_staff
  from generate_series(0, 6) i
 cross join lateral public.pelham_tee_window(current_date + i) w;
