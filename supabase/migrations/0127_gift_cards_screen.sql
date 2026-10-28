-- Account Setup 의 Screens 에 Gift Cards 체크를 더한다. 체크가 있는 계정만 기프트카드를 발행·무효하고 메뉴를 본다.
--
-- 왜(2026-10-28): 0120 은 발행 권한을 매니저(Reports 명단)와 계정 관리자로 정해 두었다(proshop@ 제외).
-- 클럽이 다른 화면(0098)처럼 Account Setup 에서 계정마다 켜고 끄자고 했다. ai@pelhamhills.ca 에 켠다.
--
-- 바꾸는 것:
-- - pelham_screen_viewers(0098) 의 screen 에 'gift_cards'.
-- - pelham_screens_of · pelham_staff_account_screens_set(0098) 이 gift_cards 를 읽고 쓴다.
-- - pelham_is_gift_card_manager(0120) 는 이제 이 체크만 본다. 결제(카드 쓰기)는 그대로 직원 누구나.
--
-- 처음 실행하면 지금 상태에서 이어지게 채운다: 지금 발행할 수 있는 계정(매니저 + 계정 관리자, proshop@ 제외)과
-- ai@pelhamhills.ca 에 체크를 켠다.
--
-- 전제: 0098, 0120. 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다
-- (명단 채우기는 처음 한 번만 — 이미 gift_cards 줄이 있으면 건너뛴다. ai@ 는 매번 켠다).

do $$
begin
  if to_regclass('public.pelham_screen_viewers') is null then
    raise exception '0127 needs 0098 first (pelham_screen_viewers is missing).';
  end if;
  if to_regprocedure('public.pelham_is_gift_card_manager()') is null then
    raise exception '0127 needs 0120 first (pelham_is_gift_card_manager is missing).';
  end if;
end;
$$;

-- ===== 명단 ============================================================

alter table public.pelham_screen_viewers drop constraint if exists pelham_screen_viewers_screen_check;
alter table public.pelham_screen_viewers add constraint pelham_screen_viewers_screen_check
  check (screen in ('dynamic_pricing', 'events', 'promotions', 'calls', 'gift_cards'));

do $$
begin
  if not exists (select 1 from public.pelham_screen_viewers where screen = 'gift_cards') then
    insert into public.pelham_screen_viewers (email, screen)
    select e.email, 'gift_cards'
      from (select email from public.pelham_cash_viewers
            union
            select email from public.pelham_account_admins) e
     where e.email <> 'proshop@pelhamhills.ca'
    on conflict do nothing;
  end if;
end;
$$;

insert into public.pelham_screen_viewers (email, screen)
values ('ai@pelhamhills.ca', 'gift_cards')
on conflict do nothing;

-- ===== 판정 ============================================================

create or replace function public.pelham_screens_of(p_email text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(s.screen order by s.ord), '[]'::jsonb)
    from (values ('dynamic_pricing', 1), ('events', 2), ('promotions', 3), ('calls', 4), ('marketing', 5),
                 ('gift_cards', 6)) s(screen, ord)
   where case when s.screen = 'marketing'
              then exists (select 1 from public.pelham_marketing_viewers m where m.email = lower(p_email))
              else exists (select 1 from public.pelham_screen_viewers v
                            where v.email = lower(p_email) and v.screen = s.screen) end
$$;

-- 발행·무효(0120). Account Setup 의 Gift Cards 체크.
create or replace function public.pelham_is_gift_card_manager()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1
                   from auth.users u
                   join public.pelham_screen_viewers v on v.email = lower(u.email) and v.screen = 'gift_cards'
                  where u.id = auth.uid())
$$;

-- ===== 고치기(0098 그대로, 화면 목록에 gift_cards) ===========================

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
   where x not in ('marketing', 'dynamic_pricing', 'events', 'promotions', 'calls', 'gift_cards')
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

revoke all on function public.pelham_screens_of(text) from public, anon, authenticated;
revoke all on function public.pelham_is_gift_card_manager() from public, anon, authenticated;
revoke all on function public.pelham_staff_account_screens_set(uuid, text[]) from public, anon, authenticated;
grant execute on function public.pelham_staff_account_screens_set(uuid, text[]) to authenticated;

notify pgrst, 'reload schema';

-- ===== 확인 ============================================================

-- Gift Cards 체크가 있는 계정. ai@pelhamhills.ca 가 있어야 한다(계정이 아직 없으면 줄은 남지만 쓸 데가 없다).
select v.email, exists (select 1 from auth.users u where lower(u.email) = v.email and u.deleted_at is null) as account_exists
  from public.pelham_screen_viewers v
 where v.screen = 'gift_cards'
 order by v.email;
