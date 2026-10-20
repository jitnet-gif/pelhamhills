-- 티타임 창: **일출 ~ 일몰 2시간 전**, 일출 시각에 첫 티. 그리고 직원이 칸마다 블록·릴리스.
--
-- 왜(2026-10-20): 0048 은 "일출 ~ 일몰" 이었고 첫 칸은 9분 격자에서 일출 뒤 첫 칸이었다. 클럽 요청:
--   1) 일몰 2시간 전부터는 예약을 받지 않는다(18홀을 해 있을 때 끝내도록).
--   2) 일출 시각에 바로 첫 티. 그날 격자에 **일출 칸 하나를 더한다**(예: 일출 7:36 → 7:36, 7:43, 7:52 …).
--      나머지 격자(6:40 + 9분)는 그대로라 이미 잡힌 예약의 시각은 바뀌지 않는다.
--   3) 직원 누구나(매니저 PIN 없이) 칸을 블록(닫기)·릴리스(열기)할 수 있다. 수동 설정이 자동 판정보다 앞선다.
--      웹·전화 비서·대기자 제안도 같은 판정을 따른다.
--
-- 일출·일몰 식은 0048 의 `pelham_tee_sun` 그대로(화면 `lib/teeSheet/sun.ts`, 백엔드 `tee_sheet.sun_minutes` 와 같다).
--
-- 칸 하나가 열려 있나 = `pelham_tee_slot_open(날짜, 분)`:
--   `pelham_tee_slot_locks` 에 줄이 있으면 그 값(locked=true 블록, false 릴리스), 없으면 일출 <= 분 <= 일몰-120.
--
-- 바뀌는 것:
--   - `pelham_tee_grid(날짜)` 새 함수 — 6:40~6:58 PM 9분 격자 + 그날 일출 칸.
--   - `pelham_tee_require_slot` — 위 격자로 검사(직원 생성·이동, 손님 변경).
--   - `pelham_tee_book`(손님 웹) — 함수 안의 고정 격자를 위 격자로 바꾼다. 본문을 복사하지 않고
--     지금 DB 에 있는 정의(0034)를 읽어 그 한 줄만 바꿔 다시 만든다.
--   - `pelham_tee_availability`·`pelham_staff_slots` — 위 격자 + 열린 칸 판정. 직원 시트는 잠긴 칸도
--     돌려주고 `dark`(자동으로 잠김)·`locked`(실제로 잠김)·`lock`('blocked'|'released'|null) 를 붙인다.
--   - 트리거 `pelham_tee_daylight_guard`(0048) — 위 판정으로 막는다. 지난 날짜·blocked 예약·시각을
--     바꾸지 않는 수정은 여전히 보지 않는다.
--   - 직원 함수 `pelham_staff_slot_locks(from, to)`·`pelham_staff_slot_lock_set(p)`.
--   0049 는 이 파일이 대신한다(돌렸든 안 돌렸든 이 파일만 돌리면 된다).
--
-- 전제: 0034, 0045, 0048. 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다.

do $$
begin
  if to_regprocedure('public.pelham_tee_sun(date)') is null then
    raise exception '0051 needs 0048 first (pelham_tee_sun is missing).';
  end if;
  if to_regprocedure('public.pelham_tee_rate_for(date, integer)') is null then
    raise exception '0051 needs 0045 first (pelham_tee_rate_for is missing).';
  end if;
end;
$$;

-- ===== 수동 블록·릴리스 =====================================================

create table if not exists public.pelham_tee_slot_locks (
  booking_date  date not null,
  minutes       integer not null check (minutes between 0 and 1439),
  locked        boolean not null,
  updated_by    text,
  updated_at    timestamptz not null default now(),
  primary key (booking_date, minutes)
);

alter table public.pelham_tee_slot_locks enable row level security;
revoke all on public.pelham_tee_slot_locks from anon, authenticated;

-- ===== 창·격자·판정 =========================================================

-- 자동으로 열리는 구간: 일출 ~ 일몰 2시간 전(분, 클럽 현지).
create or replace function public.pelham_tee_window(p_date date, out first_tee integer, out last_tee integer)
language sql
stable
set search_path = ''
as $$
  select s.sunrise, s.sunset - 120 from public.pelham_tee_sun(p_date) s
$$;

-- 그날의 칸: 9분 격자 + 일출 칸(격자 안쪽이고 격자 위가 아닐 때).
create or replace function public.pelham_tee_grid(p_date date)
returns setof integer
language sql
stable
set search_path = ''
as $$
  select g from generate_series(400, 1138, 9) g
  union
  select s.sunrise from public.pelham_tee_sun(p_date) s where s.sunrise > 400 and s.sunrise < 1138
$$;

create or replace function public.pelham_tee_auto_open(p_date date, p_minutes integer)
returns boolean
language sql
stable
set search_path = ''
as $$
  select p_minutes between w.first_tee and w.last_tee from public.pelham_tee_window(p_date) w
$$;

create or replace function public.pelham_tee_slot_open(p_date date, p_minutes integer)
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce(
    (select not l.locked from public.pelham_tee_slot_locks l
      where l.booking_date = p_date and l.minutes = p_minutes),
    public.pelham_tee_auto_open(p_date, p_minutes))
$$;

-- 라벨 모양과 그날 격자 위 여부(0004 와 같은 오류, 격자만 그날 것).
create or replace function public.pelham_tee_require_slot(p_date date, p_time text)
returns integer
language plpgsql
stable
set search_path = ''
as $$
declare
  v integer;
begin
  if p_time is null or btrim(p_time) !~ '^\d{1,2}:\d{2} (AM|PM)$' then
    perform public.pelham_fail('422', format('''%s'' is not a valid tee time label', coalesce(p_time, '')));
  end if;
  select g.m into v
    from public.pelham_tee_grid(p_date) as g(m)
   where public.pelham_tee_label(g.m) = btrim(p_time);
  if v is null then
    perform public.pelham_fail('422', format('%s is not a bookable tee time on %s',
                                             btrim(p_time), to_char(p_date, 'YYYY-MM-DD')));
  end if;
  return v;
end;
$$;

-- ===== 손님 웹 예약: 고정 격자 → 그날 격자 =====================================

do $$
declare
  v_def text := pg_get_functiondef('public.pelham_tee_book(jsonb)'::regprocedure);
  v_old text := 'from generate_series(6 * 60 + 40, 18 * 60 + 58, 9) as g(m)';
  v_new text := 'from public.pelham_tee_grid(v_date) as g(m)';
begin
  if position(v_new in v_def) > 0 then
    return;  -- 이미 바꿨다
  end if;
  if position(v_old in v_def) = 0 then
    raise exception '0051: pelham_tee_book does not look like 0034 (grid line not found). Run 0034 first.';
  end if;
  execute replace(v_def, v_old, v_new);
end;
$$;

-- ===== 쓰기 막기 (0048 트리거 함수를 새 판정으로) ===============================

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
  -- 시각이 그대로이고 원래도 자리를 차지하던 줄이면 통과(옛 예약의 메모·인원 수정).
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
      '%s on %s is before sunrise (%s). Tee times start at sunrise.',
      new.tee_time, to_char(new.booking_date, 'YYYY-MM-DD'), public.pelham_tee_label(v_win.first_tee)));
  end if;
  perform public.pelham_fail('422', format(
    '%s on %s is too close to sunset. The last tee time is %s (2 hours before sunset).',
    new.tee_time, to_char(new.booking_date, 'YYYY-MM-DD'), public.pelham_tee_label(v_win.last_tee)));
  return new;
end;
$$;

-- ===== 빈 티타임 목록 (0048 그대로 + 그날 격자·열린 칸) =========================

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
      from public.pelham_tee_grid(p_date) as m
     where public.pelham_tee_slot_open(p_date, m)
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

-- ===== 직원 시트 슬롯 (그날 격자 전부 + 잠김 표시) ==============================

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

-- ===== 직원: 블록·릴리스 ===================================================

-- 보이는 주의 수동 설정. [{date, time, minutes, locked}]
create or replace function public.pelham_staff_slot_locks(p_from date, p_to date)
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
             'date', to_char(l.booking_date, 'YYYY-MM-DD'),
             'time', public.pelham_tee_label(l.minutes),
             'minutes', l.minutes,
             'locked', l.locked
           ) order by l.booking_date, l.minutes)
      from public.pelham_tee_slot_locks l
     where l.booking_date between p_from and p_to
  ), '[]'::jsonb);
end;
$$;

-- p: {date, time, locked: true(블록) | false(릴리스)}. 자동 판정과 같은 값이면 수동 설정을 지운다.
-- 직원이면 누구나 — 매니저 PIN 은 필요 없다.
create or replace function public.pelham_staff_slot_lock_set(p jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_date date;
  v_minutes integer;
  v_locked boolean;
  v_by text;
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
  if jsonb_typeof(p->'locked') <> 'boolean' then
    perform public.pelham_fail('422', '''locked'' must be true (block) or false (release).');
  end if;
  v_minutes := public.pelham_tee_require_slot(v_date, p->>'time');
  v_locked := (p->>'locked')::boolean;
  select lower(u.email) into v_by from auth.users u where u.id = auth.uid();

  if v_locked = not public.pelham_tee_auto_open(v_date, v_minutes) then
    delete from public.pelham_tee_slot_locks l where l.booking_date = v_date and l.minutes = v_minutes;
  else
    insert into public.pelham_tee_slot_locks as t (booking_date, minutes, locked, updated_by)
    values (v_date, v_minutes, v_locked, v_by)
    on conflict (booking_date, minutes) do update
      set locked = excluded.locked, updated_by = excluded.updated_by, updated_at = now();
  end if;

  return jsonb_build_object(
    'date', to_char(v_date, 'YYYY-MM-DD'),
    'time', public.pelham_tee_label(v_minutes),
    'minutes', v_minutes,
    'locked', not public.pelham_tee_slot_open(v_date, v_minutes));
end;
$$;

-- ===== 권한 ============================================================

revoke all on function public.pelham_tee_window(date) from public, anon, authenticated;
revoke all on function public.pelham_tee_grid(date) from public, anon, authenticated;
revoke all on function public.pelham_tee_auto_open(date, integer) from public, anon, authenticated;
revoke all on function public.pelham_tee_slot_open(date, integer) from public, anon, authenticated;
revoke all on function public.pelham_tee_require_slot(date, text) from public, anon, authenticated;
revoke all on function public.pelham_tee_daylight_guard() from public, anon, authenticated;
revoke all on function public.pelham_tee_availability(date) from public;
revoke all on function public.pelham_tee_book(jsonb) from public;
revoke all on function public.pelham_staff_slots(date) from public, anon, authenticated;
revoke all on function public.pelham_staff_slot_locks(date, date) from public, anon, authenticated;
revoke all on function public.pelham_staff_slot_lock_set(jsonb) from public, anon, authenticated;

grant execute on function public.pelham_tee_availability(date) to anon, authenticated;
grant execute on function public.pelham_tee_book(jsonb) to anon, authenticated;
grant execute on function public.pelham_staff_slots(date) to authenticated;
grant execute on function public.pelham_staff_slot_locks(date, date) to authenticated;
grant execute on function public.pelham_staff_slot_lock_set(jsonb) to authenticated;
-- 전화 비서(백엔드, 서비스 키)는 표를 PostgREST 로 읽는다.
grant select on public.pelham_tee_slot_locks to service_role;

notify pgrst, 'reload schema';
