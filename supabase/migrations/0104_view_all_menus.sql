-- /view 의 숫자로 어드민 메뉴 전체를 연다 — 열람 계정(reports-view@, 0103)에 화면 권한을 모두 준다(2026-10-24 클럽 요청).
--
-- 화면은 숫자가 맞으면 그 계정으로 프로 샵 로그인 칸에 들어가 /admin 으로 간다(frontend/app/view/page.tsx).
-- 직원 명단과 Reports 명단은 0103 이 넣었다 — 티 시트·POS·Reports·Tee Times & Pricing 은 이미 열린다.
-- 여기서는 나머지 명단에 넣는다: Marketing(0047), AI Manager Marketing(0094), Dynamic Pricing·Events·Promotions·Calls(0098).
--
-- 주지 않는 것: Account Setup(0074, 계정 만들기·비밀번호 바꾸기)과 Data Backup(0100·0103). 네 자리 숫자로 계정을
-- 다루게 되면 클럽 시스템 전체를 넘겨주는 셈이라서다.
--
-- 명단이 아직 없는 마이그레이션(0094·0098 을 안 돌렸으면)은 건너뛴다 — 그 마이그레이션을 돌린 뒤 이 파일을 다시 실행한다.
-- 전제: 0103. 실행: SQL editor 에 이 파일 전체를 붙여 한 번(글자를 선택하지 않은 채 Run). 다시 실행해도 안전하다.

do $$
declare
  v_email text := 'reports-view@pelhamhills.ca';
begin
  if not exists (select 1 from auth.users where lower(email) = v_email) then
    raise exception '0104 needs 0103 first (% is missing).', v_email;
  end if;

  if to_regclass('public.pelham_marketing_viewers') is not null then
    insert into public.pelham_marketing_viewers (email) values (v_email) on conflict do nothing;
  end if;
  if to_regclass('public.pelham_ai_marketing_viewers') is not null then
    execute 'insert into public.pelham_ai_marketing_viewers (email) values ($1) on conflict do nothing' using v_email;
  end if;
  if to_regclass('public.pelham_screen_viewers') is not null then
    execute 'insert into public.pelham_screen_viewers (email, screen)
             select $1, s from unnest(array[''dynamic_pricing'', ''events'', ''promotions'', ''calls'']) s
             on conflict do nothing' using v_email;
  end if;
end;
$$;

-- 확인: 들어간 명단마다 한 줄. 0094·0098 을 안 돌렸으면 그 줄은 없다.
select 'marketing' as list, email from public.pelham_marketing_viewers where email = 'reports-view@pelhamhills.ca';
