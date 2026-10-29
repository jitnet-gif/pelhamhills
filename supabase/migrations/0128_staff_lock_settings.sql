-- 어드민 숫자판·잠금 설정 — 배포 없이 이 표 한 줄로 바꾼다(2026-10-28 클럽 요청).
--
-- 왜: 숫자판 로그인(2c83b17)은 잠금 시간(1분)과 공용 직원 계정(staff@pelhamhills.ca)이 코드에 있었다.
-- 클럽이 "배포 없이 데이터베이스만으로" 바꾸고 싶다고 했다.
--
-- 바꾸는 것:
-- - pelham_staff_lock_settings — 한 줄짜리 표.
--     idle_lock_seconds : 손대지 않고 이만큼 지나면 어드민 화면이 잠긴다. 0 이면 잠그지 않는다. 15~3600.
--     pin_email         : 직원 ID 숫자판으로 들어가는 공용 계정. FastAPI 가 service_role 로 읽는다.
-- - pelham_staff_lock_settings() — 직원 화면이 잠금 시간을 읽는다.
--
-- staff@ 의 비밀번호는 Supabase Auth 에만 있다. 숫자판 서버는 비밀번호 없이 세션을 받으므로 비밀번호를 바꿔도
-- 손댈 곳이 없다.
--
-- 바꾸는 법(예: 2분):
--   update public.pelham_staff_lock_settings set idle_lock_seconds = 120;
-- 열려 있는 화면은 다음에 새로 열 때부터 따른다.
--
-- 전제: 0004. 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다(값은 덮어쓰지 않는다).

create table if not exists public.pelham_staff_lock_settings (
  id boolean primary key default true check (id),
  idle_lock_seconds integer not null default 60
    check (idle_lock_seconds = 0 or idle_lock_seconds between 15 and 3600),
  pin_email text not null default 'staff@pelhamhills.ca' check (pin_email = lower(pin_email) and pin_email like '%@%'),
  updated_at timestamptz not null default now()
);

alter table public.pelham_staff_lock_settings enable row level security;
revoke all on table public.pelham_staff_lock_settings from public, anon, authenticated;

insert into public.pelham_staff_lock_settings (id) values (true) on conflict do nothing;

create or replace function public.pelham_staff_lock_settings()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_seconds integer;
begin
  perform public.pelham_require_staff();
  select idle_lock_seconds into v_seconds from public.pelham_staff_lock_settings where id;
  return jsonb_build_object('idle_lock_seconds', coalesce(v_seconds, 60));
end;
$$;

revoke all on function public.pelham_staff_lock_settings() from public, anon;
grant execute on function public.pelham_staff_lock_settings() to authenticated;

notify pgrst, 'reload schema';

-- ===== 확인 ============================================================

select idle_lock_seconds, pin_email from public.pelham_staff_lock_settings;
