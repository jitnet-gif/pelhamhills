-- Reports 열람 사이트(/view) 의 계정 — 아이디 없이 비밀번호 숫자만 넣고 Reports 를 본다(2026-10-24 클럽 요청).
--
-- 화면(frontend/app/view/page.tsx)은 숫자를 받으면 reports-view@pelhamhills.ca 로 로그인한다. 비밀번호는
-- 'pelham-view-' + 숫자 다(Supabase 비밀번호는 여섯 자 이상이라 앞말을 붙인다).
--
-- 하는 일
-- 1. 계정이 없으면 만든다(이메일 확인 끝난 상태). 있으면 비밀번호만 바꾼다 — 숫자를 바꿀 때 이 파일을 새 숫자로 다시 실행한다.
-- 2. 이메일 로그인 identity 를 맞춘다(없으면 GoTrue 가 로그인을 거절한다).
-- 3. Reports 명단(0046)에 넣는다 — 현금까지 보인다.
-- 4. 데이터 백업(0100)에서는 뺀다 — 0102 의 pelham_is_backup_manager 에 이 계정을 더한다(proshop@ 도 그대로 막는다).
--
-- 숫자: 저장소가 공개라 여기 적지 않는다. 붙여 넣은 뒤 아래 'PIN_HERE' 를 실제 숫자로 바꿔 실행한다. 그대로 실행하면 막는다.
--
-- 전제: 0046, 0100. 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다.

do $$
declare
  v_email text := 'reports-view@pelhamhills.ca';
  v_pin text := 'PIN_HERE';
  v_hash text;
  v_id uuid;
begin
  if v_pin = 'PIN_HERE' or v_pin !~ '^[0-9]{4,}$' then
    raise exception '0103: replace PIN_HERE with the real number (digits only) before running.';
  end if;
  if to_regprocedure('public.pelham_is_backup_manager()') is null then
    raise exception '0103 needs 0100 first (pelham_is_backup_manager is missing).';
  end if;
  v_hash := extensions.crypt('pelham-view-' || v_pin, extensions.gen_salt('bf'));

  select id into v_id from auth.users where lower(email) = v_email;

  if v_id is null then
    v_id := gen_random_uuid();
    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
      confirmation_token, recovery_token, email_change_token_new, email_change)
    values (
      '00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated', v_email, v_hash, now(),
      '{"provider":"email","providers":["email"]}', '{}', now(), now(),
      '', '', '', '');
  else
    update auth.users
       set encrypted_password = v_hash,
           email_confirmed_at = coalesce(email_confirmed_at, now()),
           updated_at = now()
     where id = v_id;
  end if;

  if not exists (select 1 from auth.identities where user_id = v_id and provider = 'email') then
    insert into auth.identities (id, user_id, provider_id, provider, identity_data, last_sign_in_at, created_at, updated_at)
    values (gen_random_uuid(), v_id, v_id::text, 'email',
            jsonb_build_object('sub', v_id::text, 'email', v_email, 'email_verified', true),
            now(), now(), now());
  end if;

  insert into public.pelham_cash_viewers (email) values (v_email) on conflict do nothing;
end;
$$;

create or replace function public.pelham_is_backup_manager()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.pelham_is_account_admin()
      or (public.pelham_is_cash_viewer()
          and not exists (select 1
                            from auth.users u
                           where u.id = auth.uid()
                             and lower(u.email) in ('proshop@pelhamhills.ca', 'reports-view@pelhamhills.ca')))
$$;

revoke all on function public.pelham_is_backup_manager() from public, anon, authenticated;

notify pgrst, 'reload schema';

-- 확인: 'auth user' · 'identity' · 'reports list' 세 줄이 나와야 한다.
select 'auth user' as what, email from auth.users where lower(email) = 'reports-view@pelhamhills.ca'
union all
select 'identity', i.identity_data->>'email' from auth.identities i
  join auth.users u on u.id = i.user_id
 where lower(u.email) = 'reports-view@pelhamhills.ca' and i.provider = 'email'
union all
select 'reports list', email from public.pelham_cash_viewers where lower(email) = 'reports-view@pelhamhills.ca';
