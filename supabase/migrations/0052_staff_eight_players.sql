-- 직원 시트: 한 티타임에 4명을 넘어 **4명 더(최대 8명)** 넣을 수 있게 한다.
--
-- 왜(2026-10-20): 클럽이 단체·동반 손님 때문에 꽉 찬 티타임에도 직원이 몇 명 더 끼워 넣길 원했다.
-- 손님이 직접 잡는 길(웹 예약 0003/0034, 손님 변경 0012/0034, 전화·문자·대기자 백엔드)은
-- 여전히 4자리만 판다 — 그 함수들은 각자 `> 4` 로 세거나, 아래 `pelham_tee_require_capacity`
-- 에서 직원이 아니면 4 를 받는다.
--
-- 바꾸는 것:
-- - `pelham_tee_require_capacity`: 직원이면 8, 아니면 4.
-- - `pelham_tee_capacity_guard`(0017 트리거): 마지막 방어선을 8 로. 손님 길의 4 는 위 함수와
--   백엔드 `require_tee_time_capacity` 가 지킨다.
-- - `pelham_staff_booking_create` / `pelham_staff_player_add`: 예약 한 건 최대 인원 4 → 8.
--   본문은 0004 그대로, 그 숫자만 다르다.
--
-- 전제: 0004, 0017. 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다.

-- ===== 정원 검사 =======================================================

create or replace function public.pelham_tee_require_capacity(
  p_date date, p_time text, p_incoming integer, p_exclude text
)
returns void
language plpgsql
stable
set search_path = ''
as $$
declare
  v_taken integer := public.pelham_tee_seats(p_date, p_time, p_exclude);
  v_limit integer := case when public.pelham_is_staff() then 8 else 4 end;
begin
  if v_taken + p_incoming > v_limit then
    perform public.pelham_fail('409', format(
      '%s on %s only holds %s players; %s are already taken and %s more were requested',
      p_time, to_char(p_date, 'YYYY-MM-DD'), v_limit, v_taken, p_incoming));
  end if;
end;
$$;

-- ===== 트리거 (0017 그대로, 4 → 8) ======================================

create or replace function public.pelham_tee_capacity_guard()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_seats integer;
  v_old   integer := 0;
  v_taken integer;
begin
  -- 이 줄이 지금 자리를 차지하지 않으면 볼 것이 없다(취소·만료 홀드·시각 없음).
  if new.booking_date is null or new.tee_time is null
     or coalesce(new.status, '') = 'cancelled'
     or (new.hold_expires_at is not null and new.hold_expires_at <= now()) then
    return null;
  end if;
  v_seats := jsonb_array_length(coalesce(new.doc->'players', '[]'::jsonb));
  if v_seats = 0 then
    return null;
  end if;

  -- 같은 티타임에서 원래도 자리를 차지했고 인원이 늘지 않았다면 통과.
  -- 홀드였던 줄은 늘 다시 센다: `now()` 는 트랜잭션 시작 시각이라, 만료 직전에 시작한 확정과
  -- 만료 직후에 시작한 웹 예약이 서로를 세지 않고 둘 다 통과할 수 있다. 홀드는 몇 건뿐이다.
  if tg_op = 'UPDATE'
     and old.booking_date = new.booking_date
     and old.tee_time = new.tee_time
     and coalesce(old.status, '') <> 'cancelled'
     and old.hold_expires_at is null then
    v_old := jsonb_array_length(coalesce(old.doc->'players', '[]'::jsonb));
    if v_seats <= v_old then
      return null;
    end if;
  end if;

  -- 잠금 뒤의 문장은 새 스냅숏으로 읽는다: 먼저 잠금을 쥐었던 쪽이 커밋한 줄까지 보인다.
  perform pg_advisory_xact_lock(
    hashtext('pelham_tee:' || new.booking_date::text || ' ' || new.tee_time));
  select coalesce(sum(jsonb_array_length(coalesce(t.doc->'players', '[]'::jsonb))), 0)::integer
    into v_taken
    from public.pelham_tee_bookings t
   where t.booking_date = new.booking_date
     and t.tee_time = new.tee_time
     and coalesce(t.status, '') <> 'cancelled'
     and (t.hold_expires_at is null or t.hold_expires_at > now());

  if v_taken > 8 then
    raise exception using
      errcode = 'PT409',
      message = format(
        '%s on %s only holds 8 players; %s are already taken and %s more were requested',
        new.tee_time, to_char(new.booking_date, 'YYYY-MM-DD'),
        v_taken - v_seats, v_seats);
  end if;
  return null;
end;
$$;

-- ===== 직원 새 예약 (0004 그대로, 4 → 8) ================================

create or replace function public.pelham_staff_booking_create(p jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_date date;
  v_time text;
  v_title text;
  v_holes integer;
  v_rate numeric;
  v_span integer;
  v_carts integer;
  v_color text;
  v_notes text;
  v_status text := 'reserved';
  v_in jsonb := coalesce(p->'players', '[]'::jsonb);
  v_players jsonb := '[]'::jsonb;
  v_now text := public.pelham_iso(now());
  v_id text := gen_random_uuid()::text;
  v_doc jsonb;
  pl jsonb;
begin
  perform public.pelham_require_staff();

  -- 본문 검증이 먼저다 (FastAPI 는 pydantic 이 슬롯 검사보다 앞선다).
  v_title := coalesce(p->>'title', '');
  if v_title = '' then
    perform public.pelham_fail('422', '''title'' is required - it is the name shown on the tee sheet');
  end if;
  v_holes := coalesce(nullif(p->>'holes', ''), '18')::integer;
  if v_holes not in (9, 18) then
    perform public.pelham_fail('422', 'Holes must be 9 or 18.');
  end if;
  v_span := coalesce(nullif(p->>'span', ''), '1')::integer;
  if v_span not between 1 and 7 then
    perform public.pelham_fail('422', 'Span must be between 1 and 7.');
  end if;
  v_carts := coalesce(nullif(p->>'cartCount', ''), '0')::integer;
  if v_carts not between 0 and 4 then
    perform public.pelham_fail('422', 'Carts must be between 0 and 4.');
  end if;
  v_color := coalesce(nullif(p->>'color', ''), 'gold');
  if v_color not in ('blue', 'gold', 'gray') then
    perform public.pelham_fail('422', 'Colour must be blue, gold or gray.');
  end if;
  v_notes := coalesce(p->>'notes', '');
  if jsonb_typeof(v_in) <> 'array' then
    perform public.pelham_fail('422', '''players'' must be a list');
  end if;
  if jsonb_array_length(v_in) > 8 then
    perform public.pelham_fail('422', 'A tee time can contain at most 8 players');
  end if;

  if coalesce(p->>'date', '') !~ '^\d{4}-\d{2}-\d{2}$' then
    perform public.pelham_fail('422', '''date'' must be an ISO date (YYYY-MM-DD)');
  end if;
  begin
    v_date := (p->>'date')::date;
  exception when others then
    perform public.pelham_fail('422', format('''date'' is not a real calendar date: %s', p->>'date'));
  end;

  perform public.pelham_tee_require_slot(v_date, p->>'time');
  v_time := btrim(p->>'time');

  -- rate 를 주지 않으면 그날의 요금표(주말/평일)를 쓴다. 준 값은 그대로 존중한다
  -- (단체·이벤트 요금을 직원이 손으로 적는다).
  v_rate := coalesce(nullif(p->>'rate', '')::numeric, public.pelham_tee_rate(v_date));

  for pl in select value from jsonb_array_elements(v_in) loop
    v_players := v_players || public.pelham_tee_player(
      pl, v_holes, coalesce(nullif(pl->>'id', ''), gen_random_uuid()::text), v_now);
  end loop;

  -- 이 티타임의 정원 확인과 기록을 한 잠금 안에서.
  perform public.pelham_tee_lock(v_date, v_time);
  perform public.pelham_tee_require_capacity(v_date, v_time, jsonb_array_length(v_players), null);

  v_doc := jsonb_build_object(
    'id', v_id,
    'date', to_char(v_date, 'YYYY-MM-DD'),
    'time', v_time,
    'holes', v_holes,
    'rate', v_rate,
    'span', v_span,
    'color', v_color,
    'title', v_title,
    'status', v_status,
    'cartCount', v_carts,
    'notes', v_notes,
    'players', v_players,
    'audit', '[]'::jsonb,
    'cancelReason', null,
    'source', 'staff',
    'holdExpiresAt', null,
    'createdAt', v_now,
    'updatedAt', v_now
  );
  v_doc := public.pelham_tee_audit(
    v_doc, format('Reservation created for %s %s.', to_char(v_date, 'YYYY-MM-DD'), v_time), v_now);

  insert into public.pelham_tee_bookings
    (id, booking_date, tee_time, status, source, title, hold_expires_at, created_at, updated_at, doc, synced_at)
  values
    (v_id, v_date, v_time, v_status, 'staff', v_title, null, now(), now(), v_doc, now());

  return v_doc;
end;
$$;

-- ===== 직원 플레이어 추가 (0004 그대로, 4 → 8) ============================

create or replace function public.pelham_staff_player_add(p_id text, p jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_doc jsonb;
  v_date date;
  v_time text;
  v_now text := public.pelham_iso(now());
  v_player jsonb;
begin
  perform public.pelham_require_staff();

  select t.doc into v_doc from public.pelham_tee_bookings t where t.id = p_id;
  if v_doc is null then
    perform public.pelham_fail('404', 'Booking not found');
  end if;
  v_date := (v_doc->>'date')::date;
  v_time := v_doc->>'time';

  perform public.pelham_tee_lock(v_date, v_time);

  select t.doc into v_doc from public.pelham_tee_bookings t where t.id = p_id;
  if v_doc is null then
    perform public.pelham_fail('404', 'Booking not found');
  end if;

  if jsonb_array_length(coalesce(v_doc->'players', '[]'::jsonb)) >= 8 then
    perform public.pelham_fail('422', 'A tee time can contain at most 8 players');
  end if;

  -- 취소된 예약은 자리를 잡지 않으므로 (2) 를 물어볼 이유가 없다. 물어보면
  -- "취소된 예약에 사람을 더할 수 있는가" 가 무관한 다른 예약의 인원수에 좌우된다.
  if v_doc->>'status' <> 'cancelled' then
    if (v_doc->>'date')::date <> v_date or v_doc->>'time' <> v_time then
      perform public.pelham_fail('409',
        'This reservation changed while it was being edited. Reload and try again.');
    end if;
    -- exclude 를 주지 않는다: taken 에 이 예약의 인원이 이미 들어가야 incoming=1 이 맞다.
    perform public.pelham_tee_require_capacity(v_date, v_time, 1, null);
  end if;

  v_player := public.pelham_tee_player(
    coalesce(p, '{}'::jsonb), (v_doc->>'holes')::integer, gen_random_uuid()::text, v_now);
  v_doc := jsonb_set(v_doc, '{players}', coalesce(v_doc->'players', '[]'::jsonb) || v_player);
  v_doc := public.pelham_tee_audit(v_doc, format('Player added: %s.', v_player->>'name'), v_now);

  perform public.pelham_tee_save(v_doc);
  return v_doc;
end;
$$;

-- ===== 권한 (0004·0017 과 같다) ============================================

revoke all on function public.pelham_tee_require_capacity(date, text, integer, text) from public, anon, authenticated;
revoke all on function public.pelham_tee_capacity_guard() from public, anon, authenticated;
revoke all on function public.pelham_staff_booking_create(jsonb) from public, anon, authenticated;
revoke all on function public.pelham_staff_player_add(text, jsonb) from public, anon, authenticated;
grant execute on function public.pelham_staff_booking_create(jsonb) to authenticated;
grant execute on function public.pelham_staff_player_add(text, jsonb) to authenticated;

notify pgrst, 'reload schema';
