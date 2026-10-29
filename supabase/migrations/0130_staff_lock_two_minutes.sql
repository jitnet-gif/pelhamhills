-- 어드민 화면 잠금 시간 1분 → 2분(2026-10-29 클럽 요청: "화면스크린 닫히는 시간 2분으로 늘려줘").
--
-- 0128 표의 값을 120초로 바꾸고, 기본값·못 읽을 때 값도 120초로 맞춘다.
-- 열려 있는 화면은 다음에 새로 열 때(또는 다시 로그인할 때)부터 2분을 따른다.
--
-- 전제: 0128. 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다.

do $$
begin
  if to_regclass('public.pelham_staff_lock_settings') is null then
    raise exception '0130 needs 0128 first (pelham_staff_lock_settings is missing).';
  end if;
end;
$$;

alter table public.pelham_staff_lock_settings alter column idle_lock_seconds set default 120;

update public.pelham_staff_lock_settings set idle_lock_seconds = 120, updated_at = now() where id;

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
  return jsonb_build_object('idle_lock_seconds', coalesce(v_seconds, 120));
end;
$$;

revoke all on function public.pelham_staff_lock_settings() from public, anon;
grant execute on function public.pelham_staff_lock_settings() to authenticated;

notify pgrst, 'reload schema';

-- ===== 확인 ============================================================

select idle_lock_seconds, pin_email from public.pelham_staff_lock_settings;
