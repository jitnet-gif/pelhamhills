-- 어드민 화면 잠금 시간을 Settings 화면에서 바꾼다(2026-10-30 클럽 요청: "어드민 화면에 매니져 이상 계정에서 볼수 있도록").
--
-- 왜: 0128 은 잠금 시간을 표 한 줄로 두었지만 바꾸려면 SQL editor 에서 update 를 쳐야 했다.
--
-- 누가: pelham_is_backup_manager 와 같다 — 매니저(Reports 명단, 0046)와 계정 관리자(0074).
-- proshop@(여러 사람이 같이 쓰는 계정, 0102)과 reports-view@(열람 계정, 0103)는 뺀다. 직원이 자기가 쓰는 화면의
-- 잠금을 끌 수 없어야 하기 때문이다.
--
-- 값 범위는 표의 check(0128)와 같다: 0(잠그지 않음) 또는 15~3600초.
-- 읽기는 0128 의 pelham_staff_lock_settings() 그대로다.
-- 저장한 화면은 바로 따르고, 다른 화면은 다음에 새로 열 때부터 따른다.
--
-- 전제: 0128, 0103. 실행: SQL editor 에 이 파일 전체를 붙여 한 번. Vercel 배포보다 먼저. 다시 실행해도 안전하다.

do $$
begin
  if to_regclass('public.pelham_staff_lock_settings') is null then
    raise exception '0143 needs 0128 first (pelham_staff_lock_settings is missing).';
  end if;
  if to_regprocedure('public.pelham_is_backup_manager()') is null then
    raise exception '0143 needs 0100 first (pelham_is_backup_manager is missing).';
  end if;
end;
$$;

create or replace function public.pelham_staff_lock_settings_set(p_idle_lock_seconds integer)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_seconds integer;
begin
  perform public.pelham_require_staff();
  if not public.pelham_is_backup_manager() then
    perform public.pelham_fail('403', 'Only managers can change the screen lock.');
  end if;
  if p_idle_lock_seconds is null or not (p_idle_lock_seconds = 0 or p_idle_lock_seconds between 15 and 3600) then
    perform public.pelham_fail('422', 'Lock time must be off, or between 15 seconds and 1 hour.');
  end if;

  update public.pelham_staff_lock_settings
     set idle_lock_seconds = p_idle_lock_seconds, updated_at = now()
   where id
  returning idle_lock_seconds into v_seconds;

  return jsonb_build_object('idle_lock_seconds', v_seconds);
end;
$$;

revoke all on function public.pelham_staff_lock_settings_set(integer) from public, anon;
grant execute on function public.pelham_staff_lock_settings_set(integer) to authenticated;

notify pgrst, 'reload schema';

-- ===== 확인 ============================================================
-- 한 줄이 나와야 한다.
select proname from pg_proc where proname = 'pelham_staff_lock_settings_set';
