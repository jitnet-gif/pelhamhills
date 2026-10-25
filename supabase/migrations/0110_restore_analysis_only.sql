-- 데이터 복원은 analysis@pelhamhills.ca 한 계정만 — 백업·내려받기는 지금처럼 매니저·계정 관리자(0100·0102).
--
-- 왜(2026-10-25 클럽 요청): 복원은 클럽 데이터 전체를 옛날 값으로 덮거나(merge) 지운다(replace). 한 사람만 하게 한다.
--
-- 복원 함수(0100)의 pelham_backup_restore · pelham_backup_prune 은 둘 다 pelham_backup_require_restorable 로 사람을
-- 가린다. 그래서 이 함수 하나만 바꾼다. analysis@ 는 권한 명단 표(*_viewers 등)도 복원할 수 있다 — 복원하는 사람이
-- 그 한 명뿐이므로. 화면(/admin/backup)은 다른 계정에 복원 칸 대신 안내만 보인다. 스크립트(pelham_restore.mjs)도
-- analysis@ 로 로그인해야 한다.
--
-- 전제: 0100. 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다.

do $$
begin
  if to_regprocedure('public.pelham_backup_require_restorable(text)') is null then
    raise exception '0110 needs 0100 first (pelham_backup_require_restorable is missing).';
  end if;
end;
$$;

-- 복원할 수 있는 계정인가(화면이 복원 칸을 가릴 때도 쓴다).
create or replace function public.pelham_backup_can_restore()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1
                   from auth.users u
                  where u.id = auth.uid()
                    and lower(u.email) = 'analysis@pelhamhills.ca')
$$;

create or replace function public.pelham_backup_require_restorable(p_table text)
returns oid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_oid oid;
begin
  perform public.pelham_require_backup_manager();
  if not public.pelham_backup_can_restore() then
    perform public.pelham_fail('403', 'Only analysis@pelhamhills.ca can restore a backup.');
  end if;
  v_oid := public.pelham_backup_table_oid(p_table);
  if p_table = 'pelham_backup_runs' then
    perform public.pelham_fail('422', 'The backup history is not restored.');
  end if;
  return v_oid;
end;
$$;

revoke all on function public.pelham_backup_can_restore() from public, anon, authenticated;
revoke all on function public.pelham_backup_require_restorable(text) from public, anon, authenticated;
grant execute on function public.pelham_backup_can_restore() to authenticated;

notify pgrst, 'reload schema';

-- ===== 확인 ============================================================

-- analysis@ 가 백업 계정(매니저 또는 계정 관리자)에 있어야 복원이 된다. 한 줄 이상 나오면 정상이다.
select email, 'manager (Reports)' as why from public.pelham_cash_viewers where lower(email) = 'analysis@pelhamhills.ca'
union all
select email, 'account manager' from public.pelham_account_admins where lower(email) = 'analysis@pelhamhills.ca';
