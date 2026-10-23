-- 신분증으로 손님 등록 → 개인 QR → QR 을 찍으면 체크인. GPS 앱은 같은 QR 로 계정을 잇는다.
--
-- 왜(2026-10-23): 클럽이 체크인을 두 가지로 하자고 했다 — 신분증 스캔, 또는 캐셔 수동(지금 버튼 그대로).
-- 처음 온 손님은 카운터 스캐너(DS2208)로 운전면허증 뒷면 바코드를 읽어 이름·생년월일을 손님 기록에 넣고
-- 그 사람만의 QR 을 만든다. 다음부터는 그 QR 을 찍으면 오늘 예약에서 그 사람을 Arrived 로 바꾼다.
-- GPS 앱(golf-gps-pelhamhills-seven, 같은 Supabase 프로젝트)은 손님이 QR 주소를 열고 생년월일을
-- 확인하면 그 로그인 계정을 손님 기록에 잇고, 앱 안에서 QR 을 보여 준다.
--
-- 남기는 것: 이름·생년월일(`date_of_birth`, 0001 부터 있던 칸)·QR 토큰. 면허 번호·주소·사진은
-- 화면이 읽고 버린다 — 이 파일 어디에도 그 칸이 없다.
--
-- QR 에 담기는 것: `https://<GPS 앱>/me?c=PHC-<토큰 10자>`. 토큰은 무작위라 이름·번호를 담지 않는다.
-- 토큰만으로는 체크인(직원 화면)만 되고, 계정 잇기는 생년월일이 같이 맞아야 한다.
--
-- 바뀌는 것
-- 1. `pelham_customers` 에 qr_token, gps_user_id, id_checked_at 칸.
-- 2. 직원: `pelham_staff_id_find`(면허로 읽은 이름·생년월일 → 후보), `pelham_staff_id_register`(후보에 넣거나 새로 만들기),
--    `pelham_staff_customer_qr`(QR 다시 보기), `pelham_staff_customer_checkin`(QR·ID 로 오늘 예약 체크인).
-- 3. GPS 앱(로그인한 손님): `pelham_gps_me`, `pelham_gps_link`.
--
-- 전제: 0001, 0004, 0053, 0054, 0077. 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다.

do $$
begin
  if to_regprocedure('public.pelham_require_manager(text, text, text)') is null then
    raise exception '0084 needs 0077 first (pelham_require_manager is missing).';
  end if;
  if to_regclass('public.pelham_customer_ref_seq') is null then
    raise exception '0084 needs 0054 first (pelham_customer_ref_seq is missing).';
  end if;
end;
$$;

-- ===== 테이블 ==========================================================

alter table public.pelham_customers add column if not exists qr_token text;
alter table public.pelham_customers add column if not exists gps_user_id uuid;
alter table public.pelham_customers add column if not exists id_checked_at timestamptz;

create unique index if not exists pelham_customers_qr_token_key on public.pelham_customers (qr_token);
create unique index if not exists pelham_customers_gps_user_key on public.pelham_customers (gps_user_id);
create index if not exists pelham_customers_name_idx
  on public.pelham_customers (lower(last_name), lower(first_name));

-- ===== 헬퍼 ============================================================

-- 토큰 10자. 헷갈리는 글자(0 O 1 I L U)는 뺀다 — 손으로 칠 일도 있다.
create or replace function public.pelham_customer_qr_token()
returns text
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_abc constant text := '23456789ABCDEFGHJKMNPQRSTVWXYZ';
  v_bytes bytea;
  v_out text;
  i integer;
begin
  loop
    v_bytes := decode(md5(gen_random_uuid()::text || clock_timestamp()::text), 'hex');
    v_out := '';
    for i in 0..9 loop
      v_out := v_out || substr(v_abc, (get_byte(v_bytes, i) % length(v_abc)) + 1, 1);
    end loop;
    exit when not exists (select 1 from public.pelham_customers c where c.qr_token = v_out);
  end loop;
  return v_out;
end;
$$;

-- 'PHC-ABCD234567' 이나 그것이 든 주소 → 토큰. 모양이 아니면 null.
create or replace function public.pelham_customer_qr_parse(p_code text)
returns text
language sql
immutable
set search_path = ''
as $$
  select (regexp_match(upper(coalesce(p_code, '')), 'PHC-([2-9A-HJKMNP-TV-Z]{10})'))[1]
$$;

create or replace function public.pelham_customer_qr_ensure(p_ref text)
returns text
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_token text;
begin
  select c.qr_token into v_token from public.pelham_customers c where c.customer_ref = p_ref for update;
  if v_token is null then
    v_token := public.pelham_customer_qr_token();
    update public.pelham_customers c set qr_token = v_token, updated_at = now() where c.customer_ref = p_ref;
  end if;
  return v_token;
end;
$$;

-- 화면에 돌려주는 손님 한 명.
create or replace function public.pelham_customer_card(p_ref text)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
           'customerRef', c.customer_ref,
           'name', coalesce(nullif(btrim(concat_ws(' ', c.first_name, c.last_name)), ''), c.display_name),
           'firstName', c.first_name,
           'lastName', c.last_name,
           'dateOfBirth', to_char(c.date_of_birth, 'YYYY-MM-DD'),
           'email', c.email,
           'phone', c.phone,
           'memberNumber', c.member_number,
           'isMember', c.is_member,
           'qrCode', case when c.qr_token is not null then 'PHC-' || c.qr_token end,
           'gpsLinked', c.gps_user_id is not null,
           'idCheckedAt', public.pelham_iso(c.id_checked_at)
         )
    from public.pelham_customers c
   where c.customer_ref = p_ref
$$;

-- ===== 직원: 면허로 읽은 사람 찾기 ==========================================

-- 이름이 같거나(성·이름), 성과 생년월일이 같은 손님. 생년월일이 다르게 적힌 손님은 dobConflict.
create or replace function public.pelham_staff_id_find(p_first text, p_last text, p_dob date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_first text := lower(btrim(coalesce(p_first, '')));
  v_last text := lower(btrim(coalesce(p_last, '')));
begin
  perform public.pelham_require_staff();
  if v_last = '' and v_first = '' then
    perform public.pelham_fail('422', 'The ID did not have a name on it.');
  end if;

  return jsonb_build_object('customers', coalesce((
    select jsonb_agg(public.pelham_customer_card(x.customer_ref)
                     || jsonb_build_object('dobMatch', x.dob_match, 'dobConflict', x.dob_conflict)
                     order by x.dob_match desc, x.rounds desc)
      from (
        select c.customer_ref,
               c.rounds_booked_played as rounds,
               p_dob is not null and c.date_of_birth = p_dob as dob_match,
               p_dob is not null and c.date_of_birth is not null and c.date_of_birth <> p_dob as dob_conflict
          from public.pelham_customers c
         where (lower(btrim(coalesce(c.last_name, ''))) = v_last
                and lower(btrim(coalesce(c.first_name, ''))) = v_first)
            or (p_dob is not null and c.date_of_birth = p_dob
                and lower(btrim(coalesce(c.last_name, ''))) = v_last)
         order by 3 desc, c.rounds_booked_played desc
         limit 10
      ) x
  ), '[]'::jsonb));
end;
$$;

-- ===== 직원: 손님 기록에 넣기 =============================================

-- p_ref 가 있으면 그 손님에 생년월일을 넣고(비어 있을 때만), 없으면 새 손님을 만든다(매니저 승인 — 0054 와 같다).
-- p: {first_name, last_name, date_of_birth: 'YYYY-MM-DD', email?, phone?}
create or replace function public.pelham_staff_id_register(p_ref text, p jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_ref text := nullif(btrim(coalesce(p_ref, '')), '');
  v_first text := nullif(btrim(coalesce(p->>'first_name', '')), '');
  v_last text := nullif(btrim(coalesce(p->>'last_name', '')), '');
  v_dob date;
  v_phone text := regexp_replace(coalesce(p->>'phone', ''), '\D', '', 'g');
  v_email text := nullif(lower(btrim(coalesce(p->>'email', ''))), '');
  v_row public.pelham_customers;
begin
  perform public.pelham_require_staff();
  p := coalesce(p, '{}'::jsonb);
  if v_first is null and v_last is null then
    perform public.pelham_fail('422', 'The ID did not have a name on it.');
  end if;
  if coalesce(p->>'date_of_birth', '') !~ '^\d{4}-\d{2}-\d{2}$' then
    perform public.pelham_fail('422', 'The ID did not have a date of birth on it.');
  end if;
  v_dob := (p->>'date_of_birth')::date;
  if v_dob > public.pelham_local_now()::date or v_dob < date '1900-01-01' then
    perform public.pelham_fail('422', format('%s is not a real date of birth.', p->>'date_of_birth'));
  end if;
  if length(v_phone) = 11 and left(v_phone, 1) = '1' then
    v_phone := substr(v_phone, 2);
  end if;
  if v_phone = '' then
    v_phone := null;
  elsif length(v_phone) <> 10 then
    perform public.pelham_fail('422', 'A phone number has 10 digits.');
  end if;
  if v_email is not null and v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    perform public.pelham_fail('422', format('''%s'' is not an email address.', v_email));
  end if;

  if v_ref is null then
    perform public.pelham_require_manager('customer', 'new', 'adding a customer');
    loop
      v_ref := 'PH' || lpad(nextval('public.pelham_customer_ref_seq')::text, 5, '0');
      exit when not exists (select 1 from public.pelham_customers c where c.customer_ref = v_ref);
    end loop;
    insert into public.pelham_customers (
      customer_ref, first_name, last_name, display_name, email, phone, date_of_birth,
      user_created_on, source, provenance, id_checked_at)
    values (
      v_ref, v_first, v_last, btrim(concat_ws(' ', v_first, v_last)), v_email, v_phone, v_dob,
      public.pelham_local_now()::date, 'id_scan',
      jsonb_build_object('created_by', (select lower(u.email) from auth.users u where u.id = auth.uid())),
      now());
  else
    select * into v_row from public.pelham_customers c where c.customer_ref = v_ref for update;
    if v_row.customer_ref is null then
      perform public.pelham_fail('404', format('Customer %s was not found.', v_ref));
    end if;
    -- 기록의 생년월일이 다르면 다른 사람이다. 덮어쓰지 않는다.
    if v_row.date_of_birth is not null and v_row.date_of_birth <> v_dob then
      perform public.pelham_fail('409', format(
        '%s has a different date of birth on file. Pick another customer or add a new one.',
        coalesce(nullif(btrim(concat_ws(' ', v_row.first_name, v_row.last_name)), ''), v_ref)));
    end if;
    -- 이름은 기록 그대로 둔다(클럽이 부르는 이름일 수 있다). 빈칸만 채운다.
    update public.pelham_customers c
       set date_of_birth = v_dob,
           email = coalesce(c.email, v_email),
           phone = coalesce(c.phone, v_phone),
           id_checked_at = now(),
           updated_at = now()
     where c.customer_ref = v_ref;
  end if;

  perform public.pelham_customer_qr_ensure(v_ref);
  return public.pelham_customer_card(v_ref);
end;
$$;

-- QR 다시 보기(손님 화면·문자 다시 보내기). 없으면 만든다.
create or replace function public.pelham_staff_customer_qr(p_ref text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform public.pelham_require_staff();
  if not exists (select 1 from public.pelham_customers c where c.customer_ref = p_ref) then
    perform public.pelham_fail('404', format('Customer %s was not found.', coalesce(p_ref, '')));
  end if;
  perform public.pelham_customer_qr_ensure(p_ref);
  return public.pelham_customer_card(p_ref);
end;
$$;

-- ===== 직원: 체크인 =====================================================

-- 오늘 예약에서 이 손님인 선수를 Arrived 로. p_how = 'qr'(p_key 는 QR 값) | 'id_scan'(p_key 는 customer_ref).
-- 선수 찾기: 연결된 customerRef, 같은 이메일, 같은 전화, 또는 연결 안 된 자리의 같은 성·이름.
-- 여러 예약이면 지금 시각에 가장 가까운 티타임.
-- 돌려주는 것: {status: 'checked_in' | 'already' | 'none', customer, bookingId?, date?, time?, player?}
create or replace function public.pelham_staff_customer_checkin(p_key text, p_how text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_ref text;
  v_c public.pelham_customers;
  v_now_ts timestamp := public.pelham_local_now();
  v_today date := v_now_ts::date;
  v_now_min integer := extract(hour from v_now_ts)::integer * 60 + extract(minute from v_now_ts)::integer;
  v_now text := public.pelham_iso(now());
  v_id text;
  v_player text;
  v_already boolean := false;
  v_doc jsonb;
  v_players jsonb := '[]'::jsonb;
  v_name text;
  pl jsonb;
begin
  perform public.pelham_require_staff();
  if p_how = 'qr' then
    select c.customer_ref into v_ref from public.pelham_customers c
     where c.qr_token = public.pelham_customer_qr_parse(p_key);
    if v_ref is null then
      perform public.pelham_fail('404', 'This QR code is not on file.');
    end if;
  elsif p_how = 'id_scan' then
    v_ref := nullif(btrim(coalesce(p_key, '')), '');
  else
    perform public.pelham_fail('422', 'Check-in must be by QR or ID scan.');
  end if;
  select * into v_c from public.pelham_customers c where c.customer_ref = v_ref;
  if v_c.customer_ref is null then
    perform public.pelham_fail('404', 'Customer not found.');
  end if;

  -- 후보 자리. (예약, 선수, Arrived 인지, 티타임 거리)
  with seat as (
    select t.id, p->>'id' as player, coalesce((p->>'arrived')::boolean, false) as arrived,
           abs(coalesce(public.pelham_tee_minutes(t.tee_time), 0) - v_now_min) as gap
      from public.pelham_tee_bookings t
     cross join lateral jsonb_array_elements(coalesce(t.doc->'players', '[]'::jsonb)) p
     where t.booking_date = v_today
       and coalesce(t.status, '') not in ('cancelled', 'no_show', 'blocked')
       and not coalesce((p->>'cancelled')::boolean, false)
       and (
         p->>'customerRef' = v_ref
         or (coalesce(p->>'customerRef', '') = '' and (
               (v_c.email is not null and lower(btrim(coalesce(p->>'email', ''))) = v_c.email)
               or (v_c.phone is not null and right(regexp_replace(coalesce(p->>'phone', ''), '\D', '', 'g'), 10) = v_c.phone)
               or (lower(btrim(coalesce(p->>'firstName', ''))) = lower(btrim(coalesce(v_c.first_name, '')))
                   and lower(btrim(coalesce(p->>'lastName', ''))) = lower(btrim(coalesce(v_c.last_name, '')))
                   and coalesce(v_c.last_name, '') <> '')))
       )
  )
  select s.id, s.player, s.arrived into v_id, v_player, v_already
    from seat s
   -- 가까운 티타임이 먼저다. 그 자리가 이미 Arrived 면 'already' — 두 번 찍어도 오후 예약까지 체크인되지 않는다.
   order by s.gap, s.arrived
   limit 1;

  v_name := coalesce(nullif(btrim(concat_ws(' ', v_c.first_name, v_c.last_name)), ''), v_c.display_name);
  if v_id is null then
    return jsonb_build_object('status', 'none', 'customer', public.pelham_customer_card(v_ref));
  end if;

  select t.doc into v_doc from public.pelham_tee_bookings t where t.id = v_id;
  if not v_already then
    perform public.pelham_tee_lock((v_doc->>'date')::date, v_doc->>'time');
    select t.doc into v_doc from public.pelham_tee_bookings t where t.id = v_id;
    for pl in select value from jsonb_array_elements(coalesce(v_doc->'players', '[]'::jsonb)) loop
      if pl->>'id' = v_player then
        v_already := coalesce((pl->>'arrived')::boolean, false);
        pl := pl || jsonb_build_object('arrived', true, 'no_show', false, 'customerRef', v_ref)
                  || case when coalesce(pl->>'memberNumber', '') = '' and v_c.member_number is not null
                          then jsonb_build_object('memberNumber', v_c.member_number) else '{}'::jsonb end;
      end if;
      v_players := v_players || pl;
    end loop;
    if not v_already then
      v_doc := jsonb_set(v_doc, '{players}', v_players);
      v_doc := public.pelham_tee_audit(v_doc, format('Checked in by %s: %s.',
                 case p_how when 'qr' then 'QR code' else 'ID scan' end, v_name), v_now);
      perform public.pelham_tee_save(v_doc);
    end if;
  end if;

  return jsonb_build_object(
    'status', case when v_already then 'already' else 'checked_in' end,
    'customer', public.pelham_customer_card(v_ref),
    'bookingId', v_id,
    'date', v_doc->>'date',
    'time', v_doc->>'time',
    'player', v_player
  );
end;
$$;

-- ===== GPS 앱(로그인한 손님) =============================================

-- 내 손님 기록. 잇지 않았으면 null.
create or replace function public.pelham_gps_me()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_ref text;
begin
  if auth.uid() is null then
    perform public.pelham_fail('401', 'Sign in first.');
  end if;
  select c.customer_ref into v_ref from public.pelham_customers c where c.gps_user_id = auth.uid();
  if v_ref is null then
    return null;
  end if;
  return public.pelham_customer_card(v_ref) - 'email' - 'phone' - 'idCheckedAt';
end;
$$;

-- QR 값 + 생년월일이 맞으면 이 로그인 계정을 그 손님에 잇는다. 다른 계정에 이미 이어져 있으면 거절.
create or replace function public.pelham_gps_link(p_code text, p_dob date)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me uuid := auth.uid();
  v_c public.pelham_customers;
begin
  if v_me is null then
    perform public.pelham_fail('401', 'Sign in first.');
  end if;
  select * into v_c from public.pelham_customers c
   where c.qr_token = public.pelham_customer_qr_parse(p_code)
   for update;
  -- 틀린 코드와 틀린 생년월일을 같은 말로 거절한다 — 어느 쪽이 틀렸는지 알려 주지 않는다.
  if v_c.customer_ref is null or p_dob is null or v_c.date_of_birth is distinct from p_dob then
    perform public.pelham_fail('422', 'That QR code and date of birth don''t match. Ask the pro shop.');
  end if;
  if v_c.gps_user_id is not null and v_c.gps_user_id <> v_me then
    perform public.pelham_fail('409', 'This QR code is already linked to another account. Ask the pro shop.');
  end if;
  -- 한 계정은 한 사람. 다른 손님에 이어져 있었으면 옮긴다.
  update public.pelham_customers c set gps_user_id = null, updated_at = now()
   where c.gps_user_id = v_me and c.customer_ref <> v_c.customer_ref;
  update public.pelham_customers c set gps_user_id = v_me, updated_at = now()
   where c.customer_ref = v_c.customer_ref;
  return public.pelham_customer_card(v_c.customer_ref) - 'email' - 'phone' - 'idCheckedAt';
end;
$$;

-- ===== 권한 ============================================================

revoke all on function public.pelham_customer_qr_token() from public, anon, authenticated;
revoke all on function public.pelham_customer_qr_parse(text) from public, anon, authenticated;
revoke all on function public.pelham_customer_qr_ensure(text) from public, anon, authenticated;
revoke all on function public.pelham_customer_card(text) from public, anon, authenticated;
revoke all on function public.pelham_staff_id_find(text, text, date) from public, anon, authenticated;
revoke all on function public.pelham_staff_id_register(text, jsonb) from public, anon, authenticated;
revoke all on function public.pelham_staff_customer_qr(text) from public, anon, authenticated;
revoke all on function public.pelham_staff_customer_checkin(text, text) from public, anon, authenticated;
revoke all on function public.pelham_gps_me() from public, anon, authenticated;
revoke all on function public.pelham_gps_link(text, date) from public, anon, authenticated;

grant execute on function public.pelham_staff_id_find(text, text, date) to authenticated;
grant execute on function public.pelham_staff_id_register(text, jsonb) to authenticated;
grant execute on function public.pelham_staff_customer_qr(text) to authenticated;
grant execute on function public.pelham_staff_customer_checkin(text, text) to authenticated;
grant execute on function public.pelham_gps_me() to authenticated;
grant execute on function public.pelham_gps_link(text, date) to authenticated;

notify pgrst, 'reload schema';
