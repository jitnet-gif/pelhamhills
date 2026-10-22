-- 계정 설정(Account Setup) — 로그인 계정을 화면에서 만들고, 고치고, 지운다(2026-10-22).
--
-- 왜: 직원 계정을 만들거나 비밀번호를 바꾸려면 매번 SQL editor 에 0073 같은 파일을 붙여야 했다.
-- 이제 계정 관리자(아래 명단, 지금은 Emmeline 의 admin@pelhamhills.ca 하나)가 `/admin/accounts` 에서 한다.
--
-- 비밀번호는 **볼 수 없다**. auth.users 에는 bcrypt 해시만 있고 원래 글자는 어디에도 남지 않는다.
-- 그래서 화면은 "새 비밀번호 정하기"만 한다. 바꾸면 그 계정의 다른 기기 로그인은 끊긴다.
--
-- 바뀌는 것:
--   pelham_account_admins            — 새 명단(이메일). 여기 있고 직원(0004)이어야 계정 화면이 열린다.
--   pelham_staff_accounts_access()   — 지금 계정이 계정 화면을 쓸 수 있는가(메뉴를 띄울지 정한다).
--   pelham_staff_accounts_list()     — 모든 로그인 계정(auth.users)과 직원·Reports 여부.
--   pelham_staff_account_save(...)   — p_id 가 null 이면 만들고, 있으면 이메일·비밀번호·직원·Reports 를 고친다.
--   pelham_staff_account_delete(id)  — 계정을 지운다. 자기 계정은 지우지 못한다.
--
-- 명단은 SQL editor 에서 바꾼다(화면에는 일부러 없다 — 계정 관리자가 자기 권한을 넓히지 못하게):
--   insert into public.pelham_account_admins (email) values ('someone@example.com') on conflict do nothing;
--   delete from public.pelham_account_admins where email = 'someone@example.com';
--
-- 전제: 0004, 0046, 0073(계정이 있어야 화면을 연다). 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다.

do $$
begin
  if to_regprocedure('public.pelham_require_staff()') is null then
    raise exception '0074 needs 0004 first (pelham_require_staff is missing).';
  end if;
  if to_regclass('public.pelham_cash_viewers') is null then
    raise exception '0074 needs 0046 first (pelham_cash_viewers is missing).';
  end if;
  if to_regclass('public.scorecard_admins') is null then
    raise exception '0074 needs the staff list (public.scorecard_admins) first.';
  end if;
end;
$$;

-- ===== 명단 ============================================================

create table if not exists public.pelham_account_admins (
  email       text primary key check (email = lower(btrim(email)) and email <> ''),
  created_at  timestamptz not null default now()
);

alter table public.pelham_account_admins enable row level security;
revoke all on public.pelham_account_admins from anon, authenticated;

insert into public.pelham_account_admins (email) values ('admin@pelhamhills.ca') on conflict do nothing;

-- ===== 판정 ============================================================

-- 직원이면서 명단에 있는가. 이메일은 토큰이 아니라 auth.users 에서 읽는다(0046 과 같다).
create or replace function public.pelham_is_account_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.pelham_is_staff()
     and exists (select 1
                   from auth.users u
                   join public.pelham_account_admins a on a.email = lower(u.email)
                  where u.id = auth.uid())
$$;

create or replace function public.pelham_require_account_admin()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.pelham_require_staff();
  if not public.pelham_is_account_admin() then
    perform public.pelham_fail('403', 'Account Setup is for the account manager only.');
  end if;
end;
$$;

create or replace function public.pelham_staff_accounts_access()
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.pelham_require_staff();
  return public.pelham_is_account_admin();
end;
$$;

-- ===== 목록 ============================================================

create or replace function public.pelham_staff_accounts_list()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.pelham_require_account_admin();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', u.id,
             'email', u.email,
             'created_at', u.created_at,
             'last_sign_in_at', u.last_sign_in_at,
             'confirmed', u.email_confirmed_at is not null,
             'staff', exists (select 1 from public.scorecard_admins s where s.user_id = u.id),
             'reports', exists (select 1 from public.pelham_cash_viewers v where v.email = lower(u.email)),
             'account_admin', exists (select 1 from public.pelham_account_admins a where a.email = lower(u.email)),
             'is_me', u.id = auth.uid())
           order by lower(u.email))
      from auth.users u
     where u.deleted_at is null
  ), '[]'::jsonb);
end;
$$;

-- ===== 만들기·고치기 =====================================================

-- p_id null → 새 계정(p_password 필수). 아니면 고친다 — p_password 가 비었으면 비밀번호는 그대로.
create or replace function public.pelham_staff_account_save(
  p_id uuid,
  p_email text,
  p_password text,
  p_staff boolean,
  p_reports boolean
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_password text := coalesce(p_password, '');
  v_old_email text;
  v_id uuid := p_id;
begin
  perform public.pelham_require_account_admin();

  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    perform public.pelham_fail('422', 'Enter a valid email address.');
  end if;
  if v_password <> '' and length(v_password) < 8 then
    perform public.pelham_fail('422', 'The password must be at least 8 characters.');
  end if;
  if exists (select 1 from auth.users where lower(email) = v_email and id is distinct from v_id) then
    perform public.pelham_fail('409', format('%s already has an account.', v_email));
  end if;

  if v_id is null then
    if v_password = '' then
      perform public.pelham_fail('422', 'Set a password for the new account.');
    end if;
    v_id := gen_random_uuid();
    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
      confirmation_token, recovery_token, email_change_token_new, email_change)
    values (
      '00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated', v_email,
      extensions.crypt(v_password, extensions.gen_salt('bf')), now(),
      '{"provider":"email","providers":["email"]}', '{}', now(), now(),
      '', '', '', '');
  else
    select lower(email) into v_old_email from auth.users where id = v_id;
    if not found then
      perform public.pelham_fail('404', 'That account no longer exists.');
    end if;
    -- 자기 계정에서 직원을 끄면 이 화면에서 바로 잠긴다.
    if v_id = auth.uid() and not p_staff then
      perform public.pelham_fail('422', 'You can''t turn off Staff on your own account.');
    end if;

    update auth.users
       set email = v_email,
           email_confirmed_at = coalesce(email_confirmed_at, now()),
           encrypted_password = case when v_password = '' then encrypted_password
                                     else extensions.crypt(v_password, extensions.gen_salt('bf')) end,
           updated_at = now()
     where id = v_id;

    if v_old_email is distinct from v_email then
      update auth.identities
         set identity_data = identity_data || jsonb_build_object('email', v_email),
             updated_at = now()
       where user_id = v_id and provider = 'email';
      update public.pelham_cash_viewers set email = v_email where email = v_old_email;
      update public.pelham_account_admins set email = v_email where email = v_old_email;
    end if;

    -- 새 비밀번호면 다른 기기의 로그인을 끊는다(자기 계정은 지금 화면이 끊기지 않게 둔다).
    if v_password <> '' and v_id <> auth.uid() then
      delete from auth.sessions where user_id = v_id;
    end if;
  end if;

  -- 이메일 로그인 identity 가 없으면 GoTrue 가 로그인을 거절한다(0073).
  if not exists (select 1 from auth.identities where user_id = v_id and provider = 'email') then
    insert into auth.identities (id, user_id, provider_id, provider, identity_data, last_sign_in_at, created_at, updated_at)
    values (gen_random_uuid(), v_id, v_id::text, 'email',
            jsonb_build_object('sub', v_id::text, 'email', v_email, 'email_verified', true),
            null, now(), now());
  end if;

  if p_staff then
    insert into public.scorecard_admins (user_id) values (v_id) on conflict do nothing;
  else
    delete from public.scorecard_admins where user_id = v_id;
  end if;

  if p_reports then
    insert into public.pelham_cash_viewers (email) values (v_email) on conflict do nothing;
  else
    delete from public.pelham_cash_viewers where email = v_email;
  end if;

  return jsonb_build_object('id', v_id, 'email', v_email);
end;
$$;

-- ===== 지우기 ==========================================================

create or replace function public.pelham_staff_account_delete(p_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_email text;
begin
  perform public.pelham_require_account_admin();

  if p_id = auth.uid() then
    perform public.pelham_fail('422', 'You can''t delete the account you are signed in with.');
  end if;

  select lower(email) into v_email from auth.users where id = p_id;
  if not found then
    perform public.pelham_fail('404', 'That account no longer exists.');
  end if;

  delete from public.pelham_cash_viewers where email = v_email;
  delete from public.pelham_account_admins where email = v_email;
  -- identities·sessions·scorecard_admins 는 FK(on delete cascade)로 같이 지워진다.
  begin
    delete from auth.users where id = p_id;
  exception when foreign_key_violation then
    perform public.pelham_fail('409', 'This account is still linked to other records. Turn off Staff instead of deleting it.');
  end;
end;
$$;

-- ===== 권한 ============================================================

revoke all on function public.pelham_is_account_admin() from public, anon, authenticated;
revoke all on function public.pelham_require_account_admin() from public, anon, authenticated;
revoke all on function public.pelham_staff_accounts_access() from public, anon, authenticated;
revoke all on function public.pelham_staff_accounts_list() from public, anon, authenticated;
revoke all on function public.pelham_staff_account_save(uuid, text, text, boolean, boolean) from public, anon, authenticated;
revoke all on function public.pelham_staff_account_delete(uuid) from public, anon, authenticated;

grant execute on function public.pelham_staff_accounts_access() to authenticated;
grant execute on function public.pelham_staff_accounts_list() to authenticated;
grant execute on function public.pelham_staff_account_save(uuid, text, text, boolean, boolean) to authenticated;
grant execute on function public.pelham_staff_account_delete(uuid) to authenticated;

notify pgrst, 'reload schema';

-- 확인: admin@pelhamhills.ca 한 줄이 나와야 한다.
select email from public.pelham_account_admins;
