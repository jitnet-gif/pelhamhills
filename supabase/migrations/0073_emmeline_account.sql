-- Emmeline 계정(admin@pelhamhills.ca) — Reports 를 보는 유일한 계정(2026-10-22).
--
-- 왜: Reports 메뉴는 현금 리포트 명단(0046 의 pelham_cash_viewers)에 있는 계정에만 뜬다. 명단에는 있었지만
-- 로그인 계정(auth.users)이 없어서 들어올 수 없었다.
--
-- 하는 일
-- 1. 계정이 없으면 만든다(이메일 확인 끝난 상태). 있으면 비밀번호만 바꾼다.
-- 2. 이메일 로그인 identity 를 맞춘다(없으면 GoTrue 가 로그인을 거절한다).
-- 3. Reports 명단에 넣는다.
--
-- 비밀번호: 저장소가 공개라 여기 적지 않는다. 붙여 넣은 뒤 아래 'PASSWORD_HERE' 를 실제 비밀번호로 바꿔 실행한다.
-- 그대로 실행하면 막는다.
--
-- 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다.
-- 직원 명단(scorecard_admins — pelham_is_staff 가 읽는다)은 이 파일이 건드리지 않는다. 직원으로 넣는 것은 따로 실행한다.

do $$
declare
  v_email text := 'admin@pelhamhills.ca';
  v_password text := 'PASSWORD_HERE';
  v_hash text;
  v_id uuid;
begin
  if v_password = 'PASSWORD_HERE' or length(v_password) < 8 then
    raise exception '0073: replace PASSWORD_HERE with the real password before running.';
  end if;
  v_hash := extensions.crypt(v_password, extensions.gen_salt('bf'));

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

-- 확인: 'auth user' · 'identity' · 'reports list' 세 줄이 나와야 한다.
select 'auth user' as what, email from auth.users where lower(email) = 'admin@pelhamhills.ca'
union all
select 'identity', i.identity_data->>'email' from auth.identities i
  join auth.users u on u.id = i.user_id
 where lower(u.email) = 'admin@pelhamhills.ca' and i.provider = 'email'
union all
select 'reports list', email from public.pelham_cash_viewers where lower(email) = 'admin@pelhamhills.ca';
