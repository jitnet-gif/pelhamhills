-- Account Setup 에서 화면 다섯 개의 권한을 계정마다 준다 — Marketing, Dynamic Pricing, Events, Promotions, Calls & SMS.
--
-- 왜(2026-10-24): 이 다섯 메뉴는 직원 계정이면 다 보였거나(Events·Promotions·Calls & SMS), Reports 체크를 따라갔거나
-- (Dynamic Pricing), SQL editor 에서만 바꾸는 명단(Marketing, 0047)이었다. 클럽이 Account Setup 의 체크로 권한을
-- 주자고 했다. 체크가 없는 계정에는 메뉴가 뜨지 않고, 주소로 들어와도 이유만 보인다.
--
-- 어디에 적나:
--   marketing                              0047 의 pelham_marketing_viewers 그대로(마케팅 사이트를 서버가 막는 명단).
--   dynamic_pricing, events, promotions,   새 명단 pelham_screen_viewers (email, screen).
--   calls
--
-- 처음 실행하면 지금 상태에서 이어지게 채운다: 매니저(Reports 명단, 0046)와 계정 관리자(0074)는 네 화면 모두.
-- 다른 직원 계정은 Events · Promotions · Calls & SMS 가 이제 꺼진다 — Account Setup 에서 켜 준다.
--
-- 화면(메뉴)만 막는다. 프로모 코드를 계산서에 적용하는 함수(0078)는 계산대가 쓰고, 통화 목록은 FastAPI 가
-- 직원 확인만 하고 읽는다 — 0096 과 같다.
--
-- 전제: 0004, 0046, 0047, 0074. 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다
-- (명단 채우기는 처음 한 번만 — 이미 줄이 있으면 건너뛴다).

do $$
begin
  if to_regprocedure('public.pelham_is_account_admin()') is null then
    raise exception '0098 needs 0074 first (pelham_is_account_admin is missing).';
  end if;
  if to_regprocedure('public.pelham_is_marketing_viewer()') is null then
    raise exception '0098 needs 0047 first (pelham_is_marketing_viewer is missing).';
  end if;
end;
$$;

-- ===== 명단 ============================================================

create table if not exists public.pelham_screen_viewers (
  email       text not null check (email = lower(btrim(email)) and email <> ''),
  screen      text not null check (screen in ('dynamic_pricing', 'events', 'promotions', 'calls')),
  created_at  timestamptz not null default now(),
  primary key (email, screen)
);

alter table public.pelham_screen_viewers enable row level security;
revoke all on public.pelham_screen_viewers from anon, authenticated;

do $$
begin
  if not exists (select 1 from public.pelham_screen_viewers) then
    insert into public.pelham_screen_viewers (email, screen)
    select e.email, s.screen
      from (select email from public.pelham_cash_viewers
            union
            select email from public.pelham_account_admins) e
     cross join (values ('dynamic_pricing'), ('events'), ('promotions'), ('calls')) s(screen)
    on conflict do nothing;
  end if;
end;
$$;

-- 변경 기록(0057)이 있으면 이 명단도 남긴다.
do $$
begin
  if to_regprocedure('public.pelham_change_log_capture()') is not null then
    drop trigger if exists pelham_change_log on public.pelham_screen_viewers;
    create trigger pelham_change_log after insert or update or delete on public.pelham_screen_viewers
      for each row execute function public.pelham_change_log_capture('email,screen');
  end if;
end;
$$;

-- ===== 판정 ============================================================

-- 이 이메일이 가진 화면들. 순서는 메뉴 순서.
create or replace function public.pelham_screens_of(p_email text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(s.screen order by s.ord), '[]'::jsonb)
    from (values ('dynamic_pricing', 1), ('events', 2), ('promotions', 3), ('calls', 4), ('marketing', 5)) s(screen, ord)
   where case when s.screen = 'marketing'
              then exists (select 1 from public.pelham_marketing_viewers m where m.email = lower(p_email))
              else exists (select 1 from public.pelham_screen_viewers v
                            where v.email = lower(p_email) and v.screen = s.screen) end
$$;

-- 지금 계정이 열 수 있는 화면들(메뉴를 가린다). 예: ["events", "calls"].
create or replace function public.pelham_staff_screen_access()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_email text;
begin
  perform public.pelham_require_staff();
  select lower(email) into v_email from auth.users where id = auth.uid();
  return public.pelham_screens_of(v_email);
end;
$$;

-- ===== 목록(0074 에 screens 를 더한다) =====================================

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
             'screens', public.pelham_screens_of(u.email),
             'is_me', u.id = auth.uid())
           order by lower(u.email))
      from auth.users u
     where u.deleted_at is null
  ), '[]'::jsonb);
end;
$$;

-- ===== 고치기 ==========================================================

-- 계정의 화면 권한을 통째로 바꾼다. 화면은 pelham_staff_account_save(0074) 뒤에 따로 부른다 —
-- 0074 의 저장 함수 모양을 바꾸지 않으려고(이 SQL 을 돌리기 전 화면도 계정 저장은 된다).
create or replace function public.pelham_staff_account_screens_set(p_id uuid, p_screens text[])
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_email text;
  v_screens text[] := coalesce(p_screens, '{}');
  v_bad text;
begin
  perform public.pelham_require_account_admin();

  select lower(email) into v_email from auth.users where id = p_id and deleted_at is null;
  if not found then
    perform public.pelham_fail('404', 'That account no longer exists.');
  end if;

  select x into v_bad
    from unnest(v_screens) x
   where x not in ('marketing', 'dynamic_pricing', 'events', 'promotions', 'calls')
   limit 1;
  if v_bad is not null then
    perform public.pelham_fail('422', format('Unknown screen: %s', v_bad));
  end if;

  delete from public.pelham_screen_viewers
   where email = v_email and screen <> all (v_screens);
  insert into public.pelham_screen_viewers (email, screen)
  select v_email, x from unnest(v_screens) x where x <> 'marketing'
  on conflict do nothing;

  if 'marketing' = any (v_screens) then
    insert into public.pelham_marketing_viewers (email) values (v_email) on conflict do nothing;
  else
    delete from public.pelham_marketing_viewers where email = v_email;
  end if;

  -- 이메일을 바꾸거나 계정을 지우면 옛 이메일 줄이 남는다. 계정이 없는 줄은 여기서 치운다.
  delete from public.pelham_screen_viewers v
   where not exists (select 1 from auth.users u where lower(u.email) = v.email and u.deleted_at is null);

  return public.pelham_screens_of(v_email);
end;
$$;

-- ===== 권한 ============================================================

revoke all on function public.pelham_screens_of(text) from public, anon, authenticated;
revoke all on function public.pelham_staff_screen_access() from public, anon, authenticated;
revoke all on function public.pelham_staff_accounts_list() from public, anon, authenticated;
revoke all on function public.pelham_staff_account_screens_set(uuid, text[]) from public, anon, authenticated;

grant execute on function public.pelham_staff_screen_access() to authenticated;
grant execute on function public.pelham_staff_accounts_list() to authenticated;
grant execute on function public.pelham_staff_account_screens_set(uuid, text[]) to authenticated;

notify pgrst, 'reload schema';

-- ===== 확인 ============================================================

-- 계정마다 화면 권한. admin@pelhamhills.ca 는 다섯 개 모두여야 한다.
select u.email, public.pelham_screens_of(u.email) as screens
  from auth.users u
 where exists (select 1 from public.scorecard_admins s where s.user_id = u.id)
 order by lower(u.email);
