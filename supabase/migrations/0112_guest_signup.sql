-- 예약 사이트(/book/login) 일반 회원가입 — 회원권이 없는 손님도 이름·이메일·전화·비밀번호로 계정을 만든다.
-- 로그인한 손님은 티타임 폼에 이름·연락처를 다시 치지 않는다. 요금은 일반(Public) 그대로다.
--
-- 왜(2026-10-25): 0111 은 회원만 등록할 수 있었다. 자주 오는 일반 손님도 로그인해서 빨리 예약하게.
--
-- 바꾸는 것:
-- - `pelham_member_logins.kind`: 'member' | 'guest'. 손님 계정은 회원권과 절대 이어지지 않는다
--   (`pelham_member_live_membership` 이 guest 면 빈 줄 — 같은 이름의 회원 요금을 받지 않게).
-- - `pelham_guest_register(p_name, p_email, p_phone, p_password)`(공개): 손님 계정 + 로그인.
-- - `pelham_member_register`: 그 이메일이 손님 계정이면 새로 만들지 않고 **회원 계정으로 바꾼다**
--   (본인 확인은 0111 과 같다 — 기록의 이메일 또는 전화). 비밀번호는 새로 정한 것으로.
-- - 세션 doc 에 `kind` 를 붙인다. `pelham_tee_book_signed_in` 은 손님이면 "회원권 없음" 노트를 남기지 않는다.
--
-- 전제: 0111. 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다.

do $$
begin
  if to_regclass('public.pelham_member_logins') is null then
    raise exception '0112 needs 0111 first (pelham_member_logins is missing).';
  end if;
end;
$$;

alter table public.pelham_member_logins
  add column if not exists kind text not null default 'member' check (kind in ('member', 'guest'));

-- ===== 안쪽 도우미 (0111 을 바꿔 쓴다) ====================================

create or replace function public.pelham_member_live_membership(p_login public.pelham_member_logins, p_on date)
returns public.pelham_memberships
language sql
stable
security definer
set search_path = ''
as $$
  select m.*
    from public.pelham_memberships m
   where p_login.kind = 'member'
     and m.status <> 'cancelled'
     and (m.expires_on is null or m.expires_on >= p_on)
     and (case when p_login.customer_ref is not null
               then m.customer_ref = p_login.customer_ref
               else m.customer_ref is null and lower(btrim(m.member_name)) = lower(btrim(p_login.member_name)) end
          or m.id = p_login.membership_id)
   order by m.season desc, m.created_at desc
   limit 1;
$$;

create or replace function public.pelham_member_session_doc(p_login_id uuid, p_new_session boolean)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_l public.pelham_member_logins;
  v_m public.pelham_memberships;
  v_token text;
begin
  select * into v_l from public.pelham_member_logins where id = p_login_id;
  if v_l.id is null then
    return null;
  end if;
  v_m := public.pelham_member_live_membership(v_l, public.pelham_local_now()::date);

  if p_new_session then
    v_token := encode(extensions.gen_random_bytes(32), 'hex');
    insert into public.pelham_member_sessions (token_hash, login_id, expires_at)
    values (encode(extensions.digest(v_token, 'sha256'), 'hex'), v_l.id, now() + interval '60 days');
    delete from public.pelham_member_sessions where login_id = v_l.id and expires_at < now();
  end if;

  return jsonb_strip_nulls(jsonb_build_object(
    'token', v_token,
    'member', jsonb_build_object(
      'kind', v_l.kind,
      'name', v_l.member_name,
      'email', v_l.email,
      'phone', v_l.phone,
      'membershipType', v_m.membership_type,
      'season', v_m.season
    )
  ));
end;
$$;

-- ===== 일반 가입 ========================================================

create or replace function public.pelham_guest_register(p_name text, p_email text, p_phone text, p_password text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_name text := regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g');
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_id uuid;
begin
  if length(v_name) < 2 or length(v_name) > 80 then
    raise exception 'Enter your full name.' using errcode = 'PT400';
  end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'Enter a valid email address.' using errcode = 'PT400';
  end if;
  if length(coalesce(p_password, '')) < 8 then
    raise exception 'Choose a password of at least 8 characters.' using errcode = 'PT400';
  end if;
  if exists (select 1 from public.pelham_member_logins l where lower(l.email) = v_email) then
    raise exception 'That email already has an account. Sign in instead.' using errcode = 'PT409';
  end if;

  insert into public.pelham_member_logins
    (kind, person_key, member_name, email, phone, password_hash, last_login_at)
  values
    ('guest', 'guest:' || v_email, v_name, v_email, btrim(coalesce(p_phone, '')),
     extensions.crypt(p_password, extensions.gen_salt('bf')), now())
  returning id into v_id;

  return public.pelham_member_session_doc(v_id, true);
end;
$$;

-- ===== 회원 등록 (손님 계정이면 회원으로 바꾼다) ===========================

create or replace function public.pelham_member_register(p_member uuid, p_email text, p_phone text, p_password text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_phone text := right(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), 10);
  v_m public.pelham_memberships;
  v_c public.pelham_customers;
  v_key text;
  v_name text;
  v_id uuid;
  v_existing public.pelham_member_logins;
begin
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'Enter a valid email address.' using errcode = 'PT400';
  end if;
  if length(coalesce(p_password, '')) < 8 then
    raise exception 'Choose a password of at least 8 characters.' using errcode = 'PT400';
  end if;

  select * into v_m from public.pelham_memberships m
   where m.id = p_member and m.status <> 'cancelled'
     and (m.expires_on is null or m.expires_on >= public.pelham_local_now()::date);
  if v_m.id is null then
    raise exception 'That membership is not active. Please call the pro shop.' using errcode = 'PT400';
  end if;
  if v_m.customer_ref is not null then
    select * into v_c from public.pelham_customers c where c.customer_ref = v_m.customer_ref;
  end if;

  -- 0109 와 같은 본인 확인: 이메일이 같거나, 전화 끝 7자리 이상(최대 10자리)이 같다.
  if not ((v_email in (lower(btrim(coalesce(v_m.email, ''))), lower(btrim(coalesce(v_c.email, '')))))
          or (length(v_phone) >= 7 and v_phone in (
                right(regexp_replace(coalesce(v_m.phone, ''), '\D', '', 'g'), 10),
                right(regexp_replace(coalesce(v_c.phone, ''), '\D', '', 'g'), 10)))) then
    raise exception 'The email or phone does not match our member record. Please call the pro shop to update it.'
      using errcode = 'PT403';
  end if;

  v_key := coalesce(v_m.customer_ref, 'name:' || lower(btrim(v_m.member_name)));
  v_name := coalesce(nullif(btrim(v_c.display_name), ''),
                     nullif(btrim(concat_ws(' ', v_c.first_name, v_c.last_name)), ''),
                     btrim(v_m.member_name));

  if exists (select 1 from public.pelham_member_logins l where l.person_key = v_key) then
    raise exception 'This member is already registered. Sign in, or call the pro shop to reset the password.'
      using errcode = 'PT409';
  end if;

  select * into v_existing from public.pelham_member_logins l where lower(l.email) = v_email;
  if v_existing.id is not null and v_existing.kind <> 'guest' then
    raise exception 'That email is already used for another member sign-in.' using errcode = 'PT409';
  end if;

  if v_existing.id is not null then
    -- 손님으로 먼저 가입한 사람. 같은 계정을 회원으로 바꾼다 — 열려 있던 로그인도 그대로 회원이 된다.
    update public.pelham_member_logins
       set kind = 'member', person_key = v_key, membership_id = v_m.id, customer_ref = v_m.customer_ref,
           member_name = v_name,
           phone = coalesce(nullif(btrim(coalesce(p_phone, '')), ''), phone),
           password_hash = extensions.crypt(p_password, extensions.gen_salt('bf')),
           failed_attempts = 0, locked_until = null, last_login_at = now()
     where id = v_existing.id
     returning id into v_id;
  else
    insert into public.pelham_member_logins
      (kind, person_key, membership_id, customer_ref, member_name, email, phone, password_hash, last_login_at)
    values
      ('member', v_key, v_m.id, v_m.customer_ref, v_name, v_email, btrim(coalesce(p_phone, '')),
       extensions.crypt(p_password, extensions.gen_salt('bf')), now())
    returning id into v_id;
  end if;

  return public.pelham_member_session_doc(v_id, true);
end;
$$;

-- ===== 로그인한 사람의 예약 (손님이면 노트 없이 일반 예약) ===================

create or replace function public.pelham_tee_book_signed_in(p jsonb, p_token text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_l public.pelham_member_logins := public.pelham_member_from_token(p_token);
  v_parts text[];
  v_doc jsonb;
  v_id text;
  v_date date;
  v_m public.pelham_memberships;
  v_c public.pelham_customers;
  v_label text;
  v_plan text;
  v_players jsonb;
begin
  if v_l.id is null then
    raise exception 'Your sign-in has expired. Please sign in again.' using errcode = 'PT401';
  end if;

  -- 예약자 이름·이메일·전화는 로그인 계정 것으로. 화면이 보낸 값은 쓰지 않는다.
  v_parts := regexp_split_to_array(btrim(v_l.member_name), '\s+');
  v_doc := public.pelham_tee_book(p || jsonb_build_object(
    'firstName', v_parts[1],
    'lastName', array_to_string(v_parts[2:], ' '),
    'email', v_l.email,
    'phone', v_l.phone));
  v_id := v_doc->>'id';
  v_date := (v_doc->>'date')::date;

  if v_l.kind = 'guest' then
    return v_doc;
  end if;

  v_m := public.pelham_member_live_membership(v_l, v_date);
  v_plan := case when v_m.id is null then '' else public.pelham_membership_rate_plan(v_m.membership_type, v_m.cart_package) end;

  if v_m.id is null or v_plan = '' then
    update public.pelham_tee_bookings t
       set doc = t.doc || jsonb_build_object('notes', btrim(coalesce(t.doc->>'notes', '') || E'\n\n' || format(
                   'Signed-in member %s has no active membership on this date — booked at the regular rate, please check at the pro shop.',
                   v_l.member_name))),
           synced_at = now()
     where t.id = v_id
     returning doc into v_doc;
    return v_doc || jsonb_build_object('memberVerified', false);
  end if;

  if v_m.customer_ref is not null then
    select * into v_c from public.pelham_customers c where c.customer_ref = v_m.customer_ref;
  end if;
  v_label := initcap(replace(v_m.membership_type, '_', ' ')) || ' ' || v_m.season;

  v_players := jsonb_set(v_doc->'players', '{0}', (v_doc->'players'->0) || jsonb_build_object(
    'type', 'Existing Customer',
    'ratePlan', v_plan,
    'customerRef', coalesce(v_m.customer_ref, ''),
    'memberNumber', coalesce(nullif(btrim(v_m.member_number), ''), nullif(btrim(v_c.member_number), ''), '')
  ));
  update public.pelham_tee_bookings t
     set doc = t.doc
               || jsonb_build_object('players', v_players)
               || jsonb_build_object('audit', coalesce(t.doc->'audit', '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
                    'id', gen_random_uuid()::text,
                    'ts', public.pelham_iso(now()),
                    'message', format('Booked online by signed-in member %s (%s).', v_l.member_name, v_label)))),
         synced_at = now()
   where t.id = v_id
   returning doc into v_doc;
  return v_doc || jsonb_build_object('memberVerified', true);
end;
$$;

-- ===== 권한 ============================================================

revoke all on function public.pelham_member_live_membership(public.pelham_member_logins, date) from public, anon, authenticated;
revoke all on function public.pelham_member_session_doc(uuid, boolean) from public, anon, authenticated;

revoke all on function public.pelham_guest_register(text, text, text, text) from public;
grant execute on function public.pelham_guest_register(text, text, text, text) to anon, authenticated;

notify pgrst, 'reload schema';
