-- 로그인 자동 백업 — 매니저(Reports 명단)와 계정 관리자가 어드민에 로그인하면 클럽 데이터를 ZIP 으로 받는다(0100).
--
-- 왜(2026-10-24): 클럽이 Emmeline 과 매니저가 로그인할 때마다 자동으로 백업되게 하자고 했다. 백업 자체는 화면
-- (frontend/lib/backupAuto.ts)이 0100 의 함수로 하고, 여기서는 기록에 'login' 종류만 더한다 — 로그인이 남아 있는
-- 날 "오늘 이미 받았나" 를 이 기록으로 본다.
--
-- 전제: 0100. 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다.

do $$
begin
  if to_regclass('public.pelham_backup_runs') is null then
    raise exception '0101 needs 0100 first (pelham_backup_runs is missing).';
  end if;
end;
$$;

alter table public.pelham_backup_runs drop constraint if exists pelham_backup_runs_source_check;
alter table public.pelham_backup_runs
  add constraint pelham_backup_runs_source_check check (source in ('web', 'daily', 'script', 'login'));

-- ===== 확인 ============================================================

select pg_get_constraintdef(oid) as source_check
  from pg_constraint
 where conrelid = 'public.pelham_backup_runs'::regclass and conname = 'pelham_backup_runs_source_check';
