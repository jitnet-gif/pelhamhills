-- 예약 사이트(/book/login) 회원 로그인. 회원은 이름으로 자기 회원권을 찾아 고른 뒤,
-- 기록에 있는 이메일 또는 전화로 본인 확인을 하고 비밀번호를 정해 등록한다. 그 뒤로는
-- 이메일 + 비밀번호로 로그인하고, 로그인한 채로 잡은 티타임은 곧바로 회원 요금으로 들어간다.
--
-- 왜(2026-10-25): 0109 는 예약할 때마다 이메일·전화를 회원 기록과 맞춰 봐야 했다. 한 번 등록해
-- 두면 매번 확인하지 않아도 되고, 이름·연락처도 다시 칠 필요가 없다.
--
-- 직원 로그인(Supabase Auth · auth.users)과는 **따로** 둔다. 회원 계정이 authenticated 가 되면
-- 직원용 함수 권한과 섞일 수 있어서, 회원은 이 파일의 표·함수로만 들어온다(공개 키 + 세션 토큰).
--
-- 바꾸는 것:
-- - `pelham_member_logins`: 사람 하나에 계정 하나(명부 번호, 없으면 이름 — 0109 검색과 같은 열쇠).
--   비밀번호는 bcrypt 해시만. 5번 틀리면 15분 잠근다.
-- - `pelham_member_sessions`: 로그인 토큰의 sha256 만 적는다(토큰 원문은 브라우저에만). 60일.
-- - `pelham_member_register(p_member, p_email, p_phone, p_password)` · `pelham_member_login(p_email, p_password)`
--   · `pelham_member_me(p_token)` · `pelham_member_logout(p_token)` (공개).
-- - `pelham_tee_book_signed_in(p, p_token)`(공개): 로그인한 회원 이름·이메일·전화로 `pelham_tee_book` 예약을 만들고,
--   그날 살아 있는 회원권이 있으면 첫 선수를 회원에 연결한다(0109 와 같은 칸). 없으면 일반 예약 + 프로 샵 노트.
--
-- 비밀번호를 잊은 회원: 아직 화면이 없다. SQL editor 에서 그 회원 줄을 지우면
--   (`delete from public.pelham_member_logins where lower(email) = '...';`) 다시 등록할 수 있다.
--
-- 전제: 0034, 0053, 0069, 0109. 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다.

do $$
begin
  if to_regprocedure('public.pelham_tee_member_lookup(text)') is null then
    raise exception '0111 needs 0109 first (pelham_tee_member_lookup is missing).';
  end if;
  if to_regprocedure('public.pelham_membership_rate_plan(text, text)') is null then
    raise exception '0111 needs 0053 first (pelham_membership_rate_plan is missing).';
  end if;
end;
$$;

-- ===== 표 ==============================================================

create table if not exists public.pelham_member_logins (
  id              uuid primary key default gen_random_uuid(),
  -- 명부 번호(customer_ref), 없으면 'name:' || 소문자 이름. 시즌이 바뀌어도 같은 사람이다.
  person_key      text not null unique,
  -- 등록할 때 고른 회원권. 명부 번호가 없는 회원은 이 줄의 이름으로 다음 시즌 회원권을 찾는다.
  membership_id   uuid references public.pelham_memberships (id) on delete set null,
  customer_ref    text,
  member_name     text not null,
  email           text not null,
  phone           text not null default '',
  password_hash   text not null,
  failed_attempts integer not null default 0,
  locked_until    timestamptz,
  created_at      timestamptz not null default now(),
  last_login_at   timestamptz
);

create unique index if not exists pelham_member_logins_email_key
  on public.pelham_member_logins (lower(email));

create table if not exists public.pelham_member_sessions (
  token_hash  text primary key,
  login_id    uuid not null references public.pelham_member_logins (id) on delete cascade,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null
);

create index if not exists pelham_member_sessions_login_idx on public.pelham_member_sessions (login_id);

-- 공개 키로는 표를 못 읽는다 — 아래 함수만 통로다.
alter table public.pelham_member_logins enable row level security;
alter table public.pelham_member_sessions enable row level security;
revoke all on table public.pelham_member_logins from anon, authenticated;
revoke all on table public.pelham_member_sessions from anon, authenticated;

-- ===== 안쪽 도우미 (공개 아님) ===========================================

-- 사람의 그날 살아 있는 회원권(가장 최근 시즌). 없으면 null 줄.
create or replace function public.pelham_member_live_membership(p_login public.pelham_member_logins, p_on date)
returns public.pelham_memberships
language sql
stable
security definer
set search_path = ''
as $$
  select m.*
    from public.pelham_memberships m
   where m.status <> 'cancelled'
     and (m.expires_on is null or m.expires_on >= p_on)
     and (case when p_login.customer_ref is not null
               then m.customer_ref = p_login.customer_ref
               else m.customer_ref is null and lower(btrim(m.member_name)) = lower(btrim(p_login.member_name)) end
          or m.id = p_login.membership_id)
   order by m.season desc, m.created_at desc
   limit 1;
$$;

-- 새 세션을 만들고 화면이 들고 있을 꼴로 돌려준다.
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
    -- 지난 세션은 그때그때 치운다.
    delete from public.pelham_member_sessions where login_id = v_l.id and expires_at < now();
  end if;

  return jsonb_strip_nulls(jsonb_build_object(
    'token', v_token,
    'member', jsonb_build_object(
      'name', v_l.member_name,
      'email', v_l.email,
      'phone', v_l.phone,
      'membershipType', v_m.membership_type,
      'season', v_m.season
    )
  ));
end;
$$;

-- 토큰 → 로그인 줄. 없거나 지났으면 null 줄.
create or replace function public.pelham_member_from_token(p_token text)
returns public.pelham_member_logins
language sql
stable
security definer
set search_path = ''
as $$
  select l.*
    from public.pelham_member_sessions s
    join public.pelham_member_logins l on l.id = s.login_id
   where s.token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex')
     and s.expires_at > now();
$$;

-- ===== 등록 ============================================================

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
  if exists (select 1 from public.pelham_member_logins l where lower(l.email) = v_email) then
    raise exception 'That email is already used for another member sign-in.' using errcode = 'PT409';
  end if;

  insert into public.pelham_member_logins
    (person_key, membership_id, customer_ref, member_name, email, phone, password_hash, last_login_at)
  values
    (v_key, v_m.id, v_m.customer_ref, v_name, v_email, btrim(coalesce(p_phone, '')),
     extensions.crypt(p_password, extensions.gen_salt('bf')), now())
  returning id into v_id;

  return public.pelham_member_session_doc(v_id, true);
end;
$$;

-- ===== 로그인 · 확인 · 로그아웃 ===========================================

create or replace function public.pelham_member_login(p_email text, p_password text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_l public.pelham_member_logins;
begin
  -- 실패는 raise 하지 않고 {error} 로 돌려준다 — raise 하면 아래 실패 횟수 기록까지 되돌려진다.
  select * into v_l from public.pelham_member_logins l where lower(l.email) = lower(btrim(coalesce(p_email, '')));
  if v_l.id is not null and v_l.locked_until > now() then
    return jsonb_build_object('error', 'Too many tries. Please wait 15 minutes and try again.');
  end if;
  if v_l.id is null or v_l.password_hash <> extensions.crypt(coalesce(p_password, ''), v_l.password_hash) then
    if v_l.id is not null then
      update public.pelham_member_logins
         set failed_attempts = case when failed_attempts >= 4 then 0 else failed_attempts + 1 end,
             locked_until = case when failed_attempts >= 4 then now() + interval '15 minutes' else locked_until end
       where id = v_l.id;
    end if;
    return jsonb_build_object('error', 'Email or password is not right.');
  end if;

  update public.pelham_member_logins
     set failed_attempts = 0, locked_until = null, last_login_at = now()
   where id = v_l.id;
  return public.pelham_member_session_doc(v_l.id, true);
end;
$$;

-- 화면을 다시 열 때. 토큰이 지났으면 null — 화면은 로그아웃 상태로 돌아간다.
create or replace function public.pelham_member_me(p_token text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_l public.pelham_member_logins := public.pelham_member_from_token(p_token);
begin
  if v_l.id is null then
    return null;
  end if;
  return public.pelham_member_session_doc(v_l.id, false);
end;
$$;

create or replace function public.pelham_member_logout(p_token text)
returns boolean
language sql
volatile
security definer
set search_path = ''
as $$
  delete from public.pelham_member_sessions
   where token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex');
  select true;
$$;

-- ===== 로그인한 회원의 예약 ==============================================

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
revoke all on function public.pelham_member_from_token(text) from public, anon, authenticated;

revoke all on function public.pelham_member_register(uuid, text, text, text) from public;
revoke all on function public.pelham_member_login(text, text) from public;
revoke all on function public.pelham_member_me(text) from public;
revoke all on function public.pelham_member_logout(text) from public;
revoke all on function public.pelham_tee_book_signed_in(jsonb, text) from public;
grant execute on function public.pelham_member_register(uuid, text, text, text) to anon, authenticated;
grant execute on function public.pelham_member_login(text, text) to anon, authenticated;
grant execute on function public.pelham_member_me(text) to anon, authenticated;
grant execute on function public.pelham_member_logout(text) to anon, authenticated;
grant execute on function public.pelham_tee_book_signed_in(jsonb, text) to anon, authenticated;

notify pgrst, 'reload schema';
