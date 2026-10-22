-- 티 시트에서 예약을 통째로 지우는 것(상세 패널 🗑 → Delete permanently)도 Pelham Shift ID 승인을 받는다(2026-10-22 클럽 요청).
--
-- 왜: 선수 삭제·환불·레인체크는 0024/0077 로 승인을 받는데, 예약 삭제만 아무 확인 없이 바로 지워졌다.
-- 이제 지우려 하면 화면이 Shift ID 창을 띄우고(0077 과 같은 흐름 — 화면은 고칠 것이 없다), 그 직원 이름으로 승인이 남는다.
-- 지운 예약의 전 내용은 Change log(0057)에 남고, 누가 승인했는지는 pelham_manager_approvals 에 남는다.
--
-- 바뀌는 것:
--   pelham_shift_approve(...)         — 승인할 수 있는 일에 'delete_booking' 을 더한다(나머지는 0077 그대로).
--   pelham_staff_booking_delete(p_id) — 지우기 전에 pelham_require_manager('delete_booking', p_id, …).
--   pelham_manager_of(action, ref)    — 승인한 이름을 Shift ID 이름(staff_name)에서 먼저 찾는다.
--                                       0077 뒤로 선수 삭제·레인체크·환불 기록의 "(approved by …)" 가 빠지던 것을 고친다.
--
-- 전제: 0004, 0056, 0077. 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다.
-- **0004·0077 을 다시 실행하면 이 파일도 다시 실행해야 한다.**

do $$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'pelham_manager_approvals'
                    and column_name = 'staff_name') then
    raise exception '0079 needs 0077 first (pelham_manager_approvals.staff_name is missing).';
  end if;
  if to_regprocedure('public.pelham_manager_of(text, text)') is null then
    raise exception '0079 needs 0056 first (pelham_manager_of is missing).';
  end if;
end;
$$;

-- ===== 승인 ============================================================

-- 0077 과 같고 'delete_booking' 만 더한다.
create or replace function public.pelham_shift_approve(p_uid uuid, p_name text, p_action text, p_ref text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_name text := nullif(left(regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g'), 80), '');
  v_at timestamptz := now();
begin
  if p_uid is null then
    perform public.pelham_fail('401', 'Sign in with a pro shop account.');
  end if;
  if p_action is null or p_action not in
       ('refund', 'rain_check', 'remove_player', 'mark_unpaid', 'price', 'customer', 'delete_booking') then
    perform public.pelham_fail('422', 'Unknown approval.');
  end if;
  if coalesce(btrim(p_ref), '') = '' then
    perform public.pelham_fail('422', 'Nothing to approve.');
  end if;
  if (select count(*) from public.pelham_manager_approvals a
       where not a.ok and a.requested_by = p_uid
         and a.created_at > now() - interval '10 minutes') >= 5 then
    perform public.pelham_fail('429', 'Too many wrong IDs. Wait 10 minutes and try again.');
  end if;

  insert into public.pelham_manager_approvals (ok, staff_name, action, ref, requested_by, created_at)
  values (v_name is not null, v_name, p_action, btrim(p_ref), p_uid, v_at);

  if v_name is null then
    -- 실패 기록은 남아야 한다 — 예외로 끝내면 위 insert 가 같이 되돌려진다. 그래서 값으로 알린다.
    return jsonb_build_object('approved', false, 'message', 'No staff member has that Pelham Shift ID.');
  end if;
  return jsonb_build_object(
    'approved', true,
    'name', v_name,
    'action', p_action,
    'ref', btrim(p_ref),
    'expires_at', public.pelham_iso(v_at + interval '10 minutes'));
end;
$$;

-- 0056 과 같고 Shift ID 승인(staff_name)을 먼저 본다. 옛 PIN 승인은 매니저 이름.
create or replace function public.pelham_manager_of(p_action text, p_ref text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(a.staff_name, m.name)
    from public.pelham_manager_approvals a
    left join public.pelham_managers m on m.id = a.manager_id
   where a.ok and a.requested_by is not distinct from auth.uid()
     and a.action = p_action and a.ref = p_ref
     and a.created_at > now() - interval '10 minutes'
   order by a.created_at desc
   limit 1
$$;

-- ===== 예약 삭제 =======================================================

-- 0004 와 같고 승인 한 줄이 더해진다.
create or replace function public.pelham_staff_booking_delete(p_id text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_doc jsonb;
begin
  perform public.pelham_require_staff();

  select t.doc into v_doc from public.pelham_tee_bookings t where t.id = p_id;
  if v_doc is null then
    perform public.pelham_fail('404', 'Booking not found');
  end if;

  perform public.pelham_require_manager('delete_booking', p_id, 'deleting this reservation');

  perform public.pelham_tee_lock((v_doc->>'date')::date, v_doc->>'time');
  delete from public.pelham_tee_bookings t where t.id = p_id;
end;
$$;
comment on function public.pelham_staff_booking_delete(text) is 'pelham manager gate';

-- ===== 권한 ============================================================

revoke all on function public.pelham_shift_approve(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.pelham_manager_of(text, text) from public, anon, authenticated;
revoke all on function public.pelham_staff_booking_delete(text) from public, anon, authenticated;
grant execute on function public.pelham_shift_approve(uuid, text, text, text) to service_role;
grant execute on function public.pelham_staff_booking_delete(text) to authenticated;

notify pgrst, 'reload schema';
