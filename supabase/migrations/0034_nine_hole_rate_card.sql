-- 9홀 요금표 — 평일 $28.31(오전 10시~마감), 주말·공휴일 $38.94(오후 3시~마감). 세전.
--
-- 왜(2026-10-18): 0033 은 "확정 가격이 나올 때까지" 9홀을 18홀의 절반으로 매겼다. 클럽이 요금표를
-- 확정했다. 9홀은 정해진 시각부터만 칠 수 있다.
--
-- 규칙:
--   - 요금: `pelham_tee_rate_for(date, 9)` — 평일 28.31, 주말·공휴일 38.94. 공휴일에 18홀 개별 요금이
--     있어도 9홀은 38.94 다(클럽 결정). 18홀은 그대로 `pelham_tee_rate`.
--   - 시각: `pelham_tee_nine_from(date)` — 평일 10:00 AM(600분), 주말·공휴일 3:00 PM(900분).
--     손님 웹 예약(`pelham_tee_book`)과 손님 변경(`pelham_tee_guest_update`)은 그보다 이른 티타임을
--     9홀로 잡지 못한다(422). **직원 시트는 막지 않는다** — 프로 샵 재량이다. 요금은 시각과 무관하게
--     9홀 요금이 자동값으로 적히고, 직원이 고칠 수 있다.
--   - 빈 티타임 목록(`pelham_tee_availability`)은 시각마다 `rate9`, `dayType`, `nineHoles` 를 더 준다.
--     예약 화면이 이 값으로 9홀 버튼을 끄고 금액을 미리 보여 준다.
--   - 이미 적힌 예약의 요금은 건드리지 않는다. 직원 시트에서 홀 수를 바꿀 때 자동값을 따라가는 규칙
--     (0033 의 `pelham_staff_booking_patch`)은 새 `pelham_tee_rate_for` 를 그대로 쓴다. 단, 0033 규칙대로
--     요금이 "옛 홀 수의 자동값" 일 때만 따라가므로, 0033 때 적힌 9홀 예약(23.90/29.21)을 18홀로 되돌리면
--     그 금액은 자동값이 아니어서 그대로 남는다 — 그런 예약은 직원이 그린피를 고친다.
--
-- 같은 값이 세 곳에 있다 — 여기, `backend/api/routes/tee_sheet.py` 의 NINE_HOLE_*, `frontend/lib/greenFee.ts`.
-- 요금을 바꾸면 셋을 같이 고쳐라.
--
-- 전제: 0003, 0004, 0012, 0025, 0033. 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다.

do $$
begin
  if to_regprocedure('public.pelham_tee_rate_for(date, integer)') is null then
    raise exception '0034 needs 0033 first (pelham_tee_rate_for is missing).';
  end if;
  if to_regprocedure('public.pelham_tee_day_type(date)') is null then
    raise exception '0034 needs 0025 first (pelham_tee_day_type is missing).';
  end if;
end;
$$;

-- 그 날 9홀을 칠 수 있는 첫 티타임(자정부터 분). 공휴일은 주말과 같다.
create or replace function public.pelham_tee_nine_from(p_date date)
returns integer
language sql
stable
set search_path = ''
as $$
  select case when public.pelham_tee_day_type(p_date) = 'weekday' then 10 * 60 else 15 * 60 end
$$;

-- 그날, 그 홀 수의 1인 그린피(세전). 9홀은 평일·주말 고정 요금, 18홀은 `pelham_tee_rate` 그대로.
create or replace function public.pelham_tee_rate_for(p_date date, p_holes integer)
returns numeric
language sql
stable
set search_path = ''
as $$
  select case when p_holes <> 9 then public.pelham_tee_rate(p_date)
              when public.pelham_tee_day_type(p_date) = 'weekday' then 28.31
              else 38.94 end
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
      else 'Nine holes can be booked from 3:00 PM on weekends and holidays. Please pick a later tee time or 18 holes.'
    end);
  end if;
end;
$$;

-- ===== 빈 티타임 목록 (0003 + rate9 · dayType · nineHoles) ================

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
           'rate', public.pelham_tee_rate(p_date),
           'rate9', public.pelham_tee_rate_for(p_date, 9),
           'dayType', public.pelham_tee_day_type(p_date),
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


-- ===== 손님 예약 (0033 + 9홀 시각 확인) ==================================

-- 0033 그대로. v_holes 확인 뒤에 `pelham_tee_require_nine` 한 줄.
create or replace function public.pelham_tee_book(p jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  local_now timestamp := public.pelham_local_now();
  v_date date;
  v_time text := btrim(coalesce(p->>'time', ''));
  v_minutes integer;
  v_holes integer;
  v_carts integer;
  v_first text := btrim(coalesce(p->>'firstName', ''));
  v_last text := btrim(coalesce(p->>'lastName', ''));
  v_email text := btrim(coalesce(p->>'email', ''));
  v_phone text := btrim(coalesce(p->>'phone', ''));
  v_notes text := btrim(coalesce(p->>'notes', ''));
  v_party integer;
  v_taken integer;
  v_now text := public.pelham_iso(now());
  v_id text := gen_random_uuid()::text;
  v_players jsonb := '[]'::jsonb;
  v_doc jsonb;
  i integer;
begin
  if coalesce(p->>'date', '') !~ '^\d{4}-\d{2}-\d{2}$' then
    perform public.pelham_fail('422', '''date'' must be an ISO date (YYYY-MM-DD)');
  end if;
  begin
    v_date := (p->>'date')::date;
  exception when others then
    perform public.pelham_fail('422', format('''date'' is not a real calendar date: %s', p->>'date'));
  end;

  select g.m into v_minutes
    from generate_series(6 * 60 + 40, 18 * 60 + 58, 9) as g(m)
   where public.pelham_tee_label(g.m) = v_time;
  if v_minutes is null then
    perform public.pelham_fail('422', format('%s is not a bookable tee time on %s', v_time, p->>'date'));
  end if;
  if v_date < local_now::date
     or (v_date = local_now::date and v_minutes <= extract(hour from local_now) * 60 + extract(minute from local_now)) then
    perform public.pelham_fail('422', 'That tee time has already passed. Please pick a later time.');
  end if;
  if v_date > local_now::date + 365 then
    perform public.pelham_fail('422', 'Online booking opens up to one year ahead.');
  end if;

  v_holes := coalesce(nullif(p->>'holes', ''), '18')::integer;
  if v_holes not in (9, 18) then
    perform public.pelham_fail('422', 'Holes must be 9 or 18.');
  end if;
  -- 9홀은 그날의 9홀 시작 시각부터(0034).
  if v_holes = 9 then
    perform public.pelham_tee_require_nine(v_date, v_minutes);
  end if;
  v_party := coalesce(nullif(p->>'players', ''), '0')::integer;
  if v_party not between 1 and 4 then
    perform public.pelham_fail('422', 'A tee time holds 1 to 4 players.');
  end if;
  v_carts := coalesce(nullif(p->>'cartCount', ''), '0')::integer;
  if v_carts not between 0 and 4 then
    perform public.pelham_fail('422', 'Carts must be between 0 and 4.');
  end if;
  if v_first = '' and v_last = '' then
    perform public.pelham_fail('422', 'Name is required.');
  end if;
  if v_email = '' or position('@' in v_email) = 0 then
    perform public.pelham_fail('422', 'A valid email is required.');
  end if;
  if length(v_first) + length(v_last) > 120 or length(v_email) > 254
     or length(v_phone) > 40 or length(v_notes) > 1000 then
    perform public.pelham_fail('422', 'Please shorten your name, phone or notes.');
  end if;

  -- 이 티타임의 정원 확인과 기록을 한 잠금 안에서.
  perform pg_advisory_xact_lock(hashtext('pelham_tee:' || v_date::text || ' ' || v_time));

  if exists (
    select 1 from public.pelham_tee_bookings t
     where t.booking_date = v_date and t.tee_time = v_time and t.status = 'blocked'
  ) then
    perform public.pelham_fail('409', format('%s on %s is not available', v_time, p->>'date'));
  end if;

  select coalesce(sum(jsonb_array_length(coalesce(t.doc->'players', '[]'::jsonb))), 0) into v_taken
    from public.pelham_tee_bookings t
   where t.booking_date = v_date
     and t.tee_time = v_time
     and coalesce(t.status, '') <> 'cancelled'
     and (t.hold_expires_at is null or t.hold_expires_at > now());
  if v_taken + v_party > 4 then
    perform public.pelham_fail('409', format(
      '%s on %s only holds 4 players; %s are already taken and %s more were requested',
      v_time, p->>'date', v_taken, v_party));
  end if;

  for i in 1..v_party loop
    v_players := v_players || jsonb_build_object(
      'id', gen_random_uuid()::text,
      'name', case when i = 1 then btrim(v_first || ' ' || v_last) else 'Guest' end,
      'firstName', case when i = 1 then v_first else 'Guest' end,
      'lastName', case when i = 1 then v_last else '' end,
      'email', case when i = 1 then v_email else '' end,
      'phone', case when i = 1 then v_phone else '' end,
      'type', 'Guest',
      'ratePlan', 'Public',
      'arrived', false,
      'paid', false,
      'cancelled', false,
      'no_show', false,
      'cart', false,
      'cartFee', 0.0,
      'paidAt', null
    );
  end loop;

  v_doc := jsonb_build_object(
    'id', v_id,
    'date', to_char(v_date, 'YYYY-MM-DD'),
    'time', v_time,
    'holes', v_holes,
    'rate', public.pelham_tee_rate_for(v_date, v_holes),
    'span', 1,
    'color', 'gold',
    'title', btrim(v_first || ' ' || v_last),
    'status', 'reserved',
    'cartCount', v_carts,
    'notes', case when v_notes = '' then 'Booked online at pelhamhills.com.'
                  else v_notes || E'\n\nBooked online at pelhamhills.com.' end,
    'players', v_players,
    'audit', jsonb_build_array(jsonb_build_object(
      'id', gen_random_uuid()::text,
      'ts', v_now,
      'message', format('Reservation created for %s %s.', to_char(v_date, 'YYYY-MM-DD'), v_time)
    )),
    'cancelReason', null,
    'source', 'web',
    'holdExpiresAt', null,
    'createdAt', v_now,
    'updatedAt', v_now
  );

  insert into public.pelham_tee_bookings
    (id, booking_date, tee_time, status, source, title, hold_expires_at, created_at, updated_at, doc, synced_at)
  values
    (v_id, v_date, v_time, 'reserved', 'web', v_doc->>'title', null, now(), now(), v_doc, now())
  returning doc into v_doc;

  return v_doc;
end;
$$;


-- 0033 그대로. 시각·날짜 블록 앞에 `pelham_tee_require_nine`.
create or replace function public.pelham_tee_guest_update(p_code text, p_email text, p jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  local_now timestamp := public.pelham_local_now();
  v_now text := public.pelham_iso(now());
  seen public.pelham_tee_bookings := public.pelham_tee_guest_row(p_code, p_email);
  v public.pelham_tee_bookings;
  v_doc jsonb;
  v_date date;
  v_time text;
  v_minutes integer;
  v_holes integer;
  v_party integer;
  v_first text;
  v_last text;
  v_phone text;
  v_contact integer;
  v_players jsonb;
  v_keep jsonb := '[]'::jsonb;
  v_drop integer;
  v_changes text[] := '{}';
  c jsonb;
  e jsonb;
  i integer;
begin
  if seen.id is null then
    perform public.pelham_guest_not_found();
  end if;
  p := coalesce(p, '{}'::jsonb);

  if p ? 'date' then
    if coalesce(p->>'date', '') !~ '^\d{4}-\d{2}-\d{2}$' then
      perform public.pelham_fail('422', '''date'' must be an ISO date (YYYY-MM-DD)');
    end if;
    begin
      v_date := (p->>'date')::date;
    exception when others then
      perform public.pelham_fail('422', format('''date'' is not a real calendar date: %s', p->>'date'));
    end;
  else
    v_date := seen.booking_date;
  end if;
  v_time := coalesce(btrim(p->>'time'), seen.tee_time);
  v_minutes := public.pelham_tee_require_slot(v_date, v_time);

  if p ? 'holes' and coalesce(p->>'holes', '') !~ '^(9|18)$' then
    perform public.pelham_fail('422', 'Holes must be 9 or 18.');
  end if;
  if p ? 'players' and coalesce(p->>'players', '') !~ '^[1-4]$' then
    perform public.pelham_fail('422', 'A tee time holds 1 to 4 players.');
  end if;

  perform public.pelham_tee_lock_slots(seen.booking_date, seen.tee_time, v_date, v_time);
  v := public.pelham_tee_guest_relock(seen);
  v_doc := v.doc;
  v_players := coalesce(v_doc->'players', '[]'::jsonb);
  v_contact := public.pelham_tee_contact_index(v_doc);
  c := v_players->v_contact;

  v_holes := coalesce((p->>'holes')::integer, (v_doc->>'holes')::integer, 18);
  v_party := coalesce((p->>'players')::integer, jsonb_array_length(v_players));
  v_first := coalesce(btrim(p->>'firstName'), c->>'firstName', '');
  v_last := coalesce(btrim(p->>'lastName'), c->>'lastName', '');
  v_phone := coalesce(btrim(p->>'phone'), c->>'phone', '');
  if v_first = '' and v_last = '' then
    perform public.pelham_fail('422', 'Name is required.');
  end if;
  if length(v_first) + length(v_last) > 120 or length(v_phone) > 40 then
    perform public.pelham_fail('422', 'Please shorten your name or phone.');
  end if;

  -- 9홀은 그날의 9홀 시작 시각부터(0034). 홀 수·날짜·시각 중 하나라도 바꿀 때만 본다 —
  -- 직원이 이른 시각에 잡아 준 9홀 예약도 이름·전화만 고치는 것은 막지 않는다.
  if v_holes = 9
     and (v_holes <> coalesce((v_doc->>'holes')::integer, 18)
          or v_date <> v.booking_date or v_time <> v.tee_time) then
    perform public.pelham_tee_require_nine(v_date, v_minutes);
  end if;

  -- 시각·날짜
  if v_date <> v.booking_date or v_time <> v.tee_time then
    if v_date < local_now::date
       or (v_date = local_now::date and v_minutes <= extract(hour from local_now) * 60 + extract(minute from local_now)) then
      perform public.pelham_fail('422', 'That tee time has already passed. Please pick a later time.');
    end if;
    if v_date > local_now::date + 365 then
      perform public.pelham_fail('422', 'Online booking opens up to one year ahead.');
    end if;
    if exists (select 1 from public.pelham_tee_bookings t
                where t.booking_date = v_date and t.tee_time = v_time and t.status = 'blocked') then
      perform public.pelham_fail('409', format('%s on %s is not available.', v_time, to_char(v_date, 'YYYY-MM-DD')));
    end if;
    v_changes := v_changes || format('moved from %s %s', to_char(v.booking_date, 'YYYY-MM-DD'), v.tee_time);
    v_doc := v_doc || jsonb_build_object('date', to_char(v_date, 'YYYY-MM-DD'), 'time', v_time,
                                         'rate', public.pelham_tee_rate_for(v_date, v_holes));
  end if;

  -- 홀 수가 바뀌면 그린피도 그 날·그 홀 수의 요금으로. 결제한 예약은 guest_block 이 이미 막았다.
  if v_holes <> coalesce((v.doc->>'holes')::integer, 18) then
    v_changes := v_changes || format('%s → %s holes', coalesce((v.doc->>'holes')::integer, 18), v_holes);
    v_doc := v_doc || jsonb_build_object('holes', v_holes, 'rate', public.pelham_tee_rate_for(v_date, v_holes));
  end if;

  -- 인원: 늘리면 Guest 를 뒤에 붙이고, 줄이면 연락 담당이 아닌 사람을 뒤에서부터 뺀다.
  if v_party <> jsonb_array_length(v_players) then
    v_changes := v_changes || format('%s → %s players', jsonb_array_length(v_players), v_party);
    if v_party > jsonb_array_length(v_players) then
      for i in 1..(v_party - jsonb_array_length(v_players)) loop
        v_players := v_players || public.pelham_tee_player(
          jsonb_build_object('firstName', 'Guest', 'type', 'Guest', 'ratePlan', 'Public'),
          v_holes, gen_random_uuid()::text, v_now);
      end loop;
    else
      v_drop := jsonb_array_length(v_players) - v_party;
      for e, i in
        select x.e, (x.i - 1)::integer
          from jsonb_array_elements(v_players) with ordinality x(e, i)
         order by x.i desc
      loop
        if v_drop > 0 and i <> v_contact then
          v_drop := v_drop - 1;
        else
          v_keep := e || v_keep;
        end if;
      end loop;
      v_players := v_keep;
    end if;
  end if;
  -- 연락 담당 앞의 사람이 빠졌으면 위치가 바뀐다.
  v_contact := public.pelham_tee_contact_index(jsonb_build_object('players', v_players));

  perform public.pelham_tee_require_capacity(v_date, v_time, v_party, v.id);

  -- 연락 담당 이름·전화
  c := v_players->v_contact;
  if v_first <> coalesce(c->>'firstName', '') or v_last <> coalesce(c->>'lastName', '')
     or v_phone <> coalesce(c->>'phone', '') then
    v_changes := v_changes || 'contact details'::text;
    c := c || jsonb_build_object('firstName', v_first, 'lastName', v_last,
                                 'name', btrim(v_first || ' ' || v_last), 'phone', v_phone);
    v_players := jsonb_set(v_players, array[v_contact::text], c);
    v_doc := v_doc || jsonb_build_object('title', btrim(v_first || ' ' || v_last));
  end if;

  if cardinality(v_changes) = 0 then
    return public.pelham_tee_guest_json(v);
  end if;

  v_doc := jsonb_set(v_doc, '{players}', v_players);
  v_doc := public.pelham_tee_audit(v_doc,
             format('Changed online by guest: %s.', array_to_string(v_changes, ', ')), v_now);
  perform public.pelham_tee_save(v_doc);

  select * into v from public.pelham_tee_bookings where id = v.id;
  return public.pelham_tee_guest_json(v);
end;
$$;


-- ===== 권한 ============================================================

revoke all on function public.pelham_tee_nine_from(date) from public, anon, authenticated;
revoke all on function public.pelham_tee_rate_for(date, integer) from public, anon, authenticated;
revoke all on function public.pelham_tee_require_nine(date, integer) from public, anon, authenticated;

-- 0003·0012 와 같은 권한.
revoke all on function public.pelham_tee_availability(date) from public;
revoke all on function public.pelham_tee_book(jsonb) from public;
revoke all on function public.pelham_tee_guest_update(text, text, jsonb) from public;
grant execute on function public.pelham_tee_availability(date) to anon, authenticated;
grant execute on function public.pelham_tee_book(jsonb) to anon, authenticated;
grant execute on function public.pelham_tee_guest_update(text, text, jsonb) to anon, authenticated;
