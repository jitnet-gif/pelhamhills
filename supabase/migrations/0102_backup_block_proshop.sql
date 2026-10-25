-- 데이터 백업에서 proshop@ 를 뺀다 — Reports 명단(0046)에 있어도 백업·내려받기·복원을 못 한다.
--
-- 왜(2026-10-24): 클럽이 proshop@pelhamhills.ca 는 백업과 내려받기를 막자고 했다. 프로샵 계정은 매장 컴퓨터에서
-- 여러 사람이 같이 쓰므로 클럽 데이터 전체를 받아 갈 수 없게 한다.
--
-- 백업 함수(0100)는 전부 pelham_is_backup_manager 로 사람을 가린다 — 메뉴(pelham_backup_access), 목록, 내보내기,
-- 복원, 기록, 그리고 로그인 자동 백업(0101, 화면이 pelham_backup_access 를 먼저 본다). 그래서 이 함수 하나만 바꾼다.
-- 계정 관리자(0074)는 막지 않는다.
--
-- 전제: 0100. 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다.

do $$
begin
  if to_regprocedure('public.pelham_is_backup_manager()') is null then
    raise exception '0102 needs 0100 first (pelham_is_backup_manager is missing).';
  end if;
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
                             and lower(u.email) in ('proshop@pelhamhills.ca')))
$$;

revoke all on function public.pelham_is_backup_manager() from public, anon, authenticated;

notify pgrst, 'reload schema';

-- ===== 확인 ============================================================

-- 백업할 수 있는 계정. proshop@ 는 나오지 않아야 한다.
select email, 'manager (Reports)' as why from public.pelham_cash_viewers
 where email not in ('proshop@pelhamhills.ca')
union all
select email, 'account manager' from public.pelham_account_admins
order by 1;
