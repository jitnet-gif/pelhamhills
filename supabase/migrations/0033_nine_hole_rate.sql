-- 9홀 그린피 — 직원 시트에서 홀 수를 바꾸면 그린피도 따라 바뀐다.
--
-- 왜(2026-10-18): 예약 상세에서 18 → 9홀로 바꿔도 그린피가 58.41 그대로 남았다. 요금표
-- (`pelham_tee_rate`, 0025)에 홀 수가 없었기 때문이다. 클럽 결정: 9홀 = 그날 18홀 요금의 절반
-- (평일 23.90, 주말·공휴일 29.21, 공휴일 개별 요금도 절반). 확정 가격이 따로 나오면
-- `pelham_tee_rate_for` 한 곳만 고친다.
--
-- 규칙(0004 의 카트 요금과 같은 꼴):
--   - 홀 수를 바꿀 때 그린피가 아직 "옛 홀 수의 자동값" 이면 새 홀 수의 자동값으로 바꾼다.
--     사람이 손으로 고친 금액은 그대로 둔다.
--   - 결제한 사람이 한 명이라도 있으면 그대로 둔다 — 그린피는 예약 하나에 한 금액이라, 바꾸면
--     이미 받은 돈과 재인쇄 영수증이 달라진다.
--   - 같은 요청에 rate 를 직접 보냈으면 그 값이 이긴다(매니저 승인도 그대로 받는다).
--   - 자동으로 따라가는 것은 매니저 승인을 묻지 않는다. 감사 기록에는 "Rate set to $..." 가 남는다.
--
-- 손님 쪽도 같다(0012 의 두 함수를 다시 정의한다 — 바뀐 곳은 요금 줄뿐):
--   - 웹 예약 `pelham_tee_book`: 9홀로 예약하면 9홀 요금이 적힌다. 온라인 결제(0020)는 예약에 적힌
--     요금으로 청구하므로 따로 고칠 것이 없다.
--   - 예약 변경 `pelham_tee_guest_update`: 홀 수를 바꾸거나 날짜를 옮기면 그 날·그 홀 수의 요금으로.
--     손님은 결제한 예약을 바꿀 수 없으므로(guest_block) 결제 금액과 어긋나지 않는다.
--   이미 받은 예약의 요금은 건드리지 않는다.
--
-- 전제: 0004, 0012, 0024, 0025. 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다.

do $$
begin
  if to_regprocedure('public.pelham_staff_booking_patch_ungated(text, jsonb)') is null then
    raise exception '0033 needs 0024 first (pelham_staff_booking_patch_ungated is missing).';
  end if;
  if to_regclass('public.pelham_tee_holidays') is null then
    raise exception '0033 needs 0025 first (pelham_tee_holidays is missing).';
  end if;
end;
$$;

-- 그날, 그 홀 수의 1인 그린피(세전). 18홀은 `pelham_tee_rate` 그대로, 9홀은 그 절반(센트 반올림).
create or replace function public.pelham_tee_rate_for(p_date date, p_holes integer)
returns numeric
language sql
stable
set search_path = ''
as $$
  select case when p_holes = 9 then round(public.pelham_tee_rate(p_date) / 2, 2)
              else public.pelham_tee_rate(p_date) end
$$;

-- 0024 의 문지기 + 홀 수 변경 시 그린피 따라가기. 본문(_ungated)은 그대로다.
create or replace function public.pelham_staff_booking_patch(p_id text, p jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_doc jsonb;
  v_date date;
  v_old_holes integer;
  v_new_holes integer;
begin
  perform public.pelham_require_staff();
  -- 그린피(예약 하나에 한 금액)를 바꿀 때만. 날짜·시간·홀·메모 같은 다른 수정은 그대로 둔다.
  if p ? 'rate' and jsonb_typeof(p->'rate') = 'number' and exists (
       select 1 from public.pelham_tee_bookings t
        where t.id = p_id
          and round(coalesce((t.doc->>'rate')::numeric, 0), 2) <> round((p->>'rate')::numeric, 2)) then
    perform public.pelham_require_manager('price', coalesce(p_id, ''), 'changing the green fee');
  end if;

  -- 홀 수만 바뀌면 자동 그린피도 새 홀 수로. 잘못된 holes 값은 _ungated 가 422 로 거른다.
  if not (p ? 'rate' and jsonb_typeof(p->'rate') = 'number') and coalesce(p->>'holes', '') in ('9', '18') then
    select t.doc into v_doc from public.pelham_tee_bookings t where t.id = p_id;
    if v_doc is not null then
      v_date := (v_doc->>'date')::date;
      v_old_holes := coalesce((v_doc->>'holes')::integer, 18);
      v_new_holes := (p->>'holes')::integer;
      if v_new_holes <> v_old_holes
         and public.pelham_same_money((v_doc->>'rate')::numeric, public.pelham_tee_rate_for(v_date, v_old_holes))
         and not exists (
           select 1 from jsonb_array_elements(coalesce(v_doc->'players', '[]'::jsonb)) pl
            where coalesce((pl.value->>'paid')::boolean, false)) then
        p := p || jsonb_build_object('rate', public.pelham_tee_rate_for(v_date, v_new_holes));
      end if;
    end if;
  end if;

  return public.pelham_staff_booking_patch_ungated(p_id, p);
end;
$$;

comment on function public.pelham_staff_booking_patch(text, jsonb) is 'pelham manager gate';

-- ===== 손님 예약 (0012 에서 요금 줄만 바꿈) ==============================

-- 0012 그대로. 요금만 `pelham_tee_rate_for(v_date, v_holes)`.
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

-- 0012 그대로. 날짜 이동·홀 수 변경 때 요금을 그 날·그 홀 수의 값으로.
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

revoke all on function public.pelham_tee_rate_for(date, integer) from public, anon, authenticated;
revoke all on function public.pelham_staff_booking_patch(text, jsonb) from public, anon, authenticated;
grant execute on function public.pelham_staff_booking_patch(text, jsonb) to authenticated;

-- 0003·0012 와 같은 권한.
revoke all on function public.pelham_tee_book(jsonb) from public;
revoke all on function public.pelham_tee_guest_update(text, text, jsonb) from public;
grant execute on function public.pelham_tee_book(jsonb) to anon, authenticated;
grant execute on function public.pelham_tee_guest_update(text, text, jsonb) to anon, authenticated;
