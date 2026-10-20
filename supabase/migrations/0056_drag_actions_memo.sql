-- 티 시트 드래그 앤 드롭(레인체크 · 환불 · 선수 삭제)의 적요(사유)와 승인 매니저를 예약 기록에 남긴다.
--
-- 왜(2026-10-20): 선수 카드를 끌어다 Rain check · Refund · Delete 에 놓으면 매니저 PIN(0024)을 받는다.
-- 그런데 예약의 History 에는 "Player removed: Kim." 만 남고 왜 지웠는지, 누가 승인했는지가 없었다.
-- 레인체크도 메모(note)는 종이에만 찍히고 기록에는 없었다. 환불은 사유는 남지만 승인자가 없었다.
--
-- 바뀌는 것:
--   1) pelham_staff_player_remove(p_id, p_player, p_reason) — 사유를 받는 새 오버로드. 사유는 필수.
--      기록: "Player removed: Kim — Double booked (approved by Francis)."
--      예전 2인자 함수는 그대로 둔다(옛 화면이 아직 부를 수 있다).
--   2) 레인체크 발행 기록에 메모와 승인자를 붙인다:
--      "Rain check RC-… issued to Kim: $45.00, valid through 2027-04-18. Note: Lightning (approved by Francis)."
--   3) 계산서 환불 기록에 승인자를 붙인다: "Refunded bill R-…: Rain out (approved by Francis)."
--
-- 2) · 3) 은 0024 의 게이트 함수를 다시 정의한다. **0024 를 다시 실행하면 이 파일도 다시 실행해야 한다.**
-- 전제: 0004, 0005, 0011, 0024. 실행: SQL editor 에 이 파일 전체를 붙여 한 번(다시 실행해도 안전하다).

do $$
begin
  if to_regprocedure('public.pelham_require_manager(text, text, text)') is null then
    raise exception '0056 needs 0024 first (pelham_require_manager is missing).';
  end if;
  if to_regprocedure('public.pelham_staff_player_remove_ungated(text, text)') is null then
    raise exception '0056 needs 0024 first (pelham_staff_player_remove_ungated is missing).';
  end if;
end;
$$;

-- ===== 헬퍼 ============================================================

-- 지금 직원에게 이 일을 승인한 매니저 이름(10분 안의 가장 최근 것). 없으면 null.
create or replace function public.pelham_manager_of(p_action text, p_ref text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select m.name
    from public.pelham_manager_approvals a
    join public.pelham_managers m on m.id = a.manager_id
   where a.ok and a.requested_by is not distinct from auth.uid()
     and a.action = p_action and a.ref = p_ref
     and a.created_at > now() - interval '10 minutes'
   order by a.created_at desc
   limit 1
$$;

-- 예약 기록의 맨 위 줄이 p_prefix 로 시작하면 끝의 마침표를 떼고 p_suffix 를 붙인다. 고친 doc 을 돌려준다.
create or replace function public.pelham_tee_audit_append(p_booking text, p_prefix text, p_suffix text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_doc jsonb;
  v_msg text;
begin
  select t.doc into v_doc from public.pelham_tee_bookings t where t.id = p_booking for update;
  if v_doc is null or coalesce(btrim(p_suffix), '') = '' then
    return v_doc;
  end if;
  v_msg := v_doc #>> '{audit,0,message}';
  if v_msg is null or left(v_msg, length(p_prefix)) <> p_prefix then
    return v_doc;
  end if;
  v_msg := regexp_replace(v_msg, '\.\s*$', '') || p_suffix || '.';
  v_doc := jsonb_set(v_doc, '{audit,0,message}', to_jsonb(v_msg));
  perform public.pelham_tee_save(v_doc);
  return v_doc;
end;
$$;

-- ===== 1) 선수 삭제 + 사유 ===============================================

create or replace function public.pelham_staff_player_remove(p_id text, p_player text, p_reason text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_reason text := btrim(coalesce(p_reason, ''));
  v_manager text;
  v_doc jsonb;
begin
  perform public.pelham_require_staff();
  if v_reason = '' then
    perform public.pelham_fail('422', 'Give a reason for removing this player.');
  end if;
  perform public.pelham_require_manager('remove_player', coalesce(p_id, ''), 'removing this player');
  v_manager := public.pelham_manager_of('remove_player', coalesce(p_id, ''));
  v_doc := public.pelham_staff_player_remove_ungated(p_id, p_player);
  return coalesce(
    public.pelham_tee_audit_append(
      p_id, 'Player removed:',
      format(' — %s', left(v_reason, 200)) || coalesce(format(' (approved by %s)', v_manager), '')),
    v_doc);
end;
$$;
comment on function public.pelham_staff_player_remove(text, text, text) is 'pelham manager gate';

-- ===== 2) 레인체크 발행: 메모 + 승인자 ======================================

create or replace function public.pelham_staff_rain_check_issue(p jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_booking text := coalesce(p->>'booking_id', '');
  v_note text := btrim(coalesce(p->>'note', ''));
  v_manager text;
  v_result jsonb;
begin
  perform public.pelham_require_staff();
  perform public.pelham_require_manager('rain_check', v_booking, 'a rain check');
  v_manager := public.pelham_manager_of('rain_check', v_booking);
  v_result := public.pelham_staff_rain_check_issue_ungated(p);
  perform public.pelham_tee_audit_append(
    v_booking, 'Rain check ',
    case when v_note <> '' then format(' Note: %s', left(v_note, 200)) else '' end
      || coalesce(format(' (approved by %s)', v_manager), ''));
  return v_result;
end;
$$;
comment on function public.pelham_staff_rain_check_issue(jsonb) is 'pelham manager gate';

-- ===== 3) 계산서 환불: 승인자 ==============================================

create or replace function public.pelham_staff_bill_refund(p_bill bigint, p_reason text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_manager text;
  v_result jsonb;
  v_booking text;
begin
  perform public.pelham_require_staff();
  perform public.pelham_require_manager('refund', p_bill::text, 'this refund');
  v_manager := public.pelham_manager_of('refund', p_bill::text);
  v_result := public.pelham_staff_bill_refund_ungated(p_bill, p_reason);
  if v_manager is not null then
    for v_booking in
      select distinct li.booking_id from public.pelham_bill_lines li
       where li.bill_id = p_bill and li.kind = 'tee_player' and li.booking_id is not null
    loop
      perform public.pelham_tee_audit_append(v_booking, 'Refunded bill ', format(' (approved by %s)', v_manager));
    end loop;
  end if;
  return v_result;
end;
$$;
comment on function public.pelham_staff_bill_refund(bigint, text) is 'pelham manager gate';

-- ===== 권한 ============================================================

revoke all on function public.pelham_manager_of(text, text) from public, anon, authenticated;
revoke all on function public.pelham_tee_audit_append(text, text, text) from public, anon, authenticated;
revoke all on function public.pelham_staff_player_remove(text, text, text) from public, anon, authenticated;
revoke all on function public.pelham_staff_rain_check_issue(jsonb) from public, anon, authenticated;
revoke all on function public.pelham_staff_bill_refund(bigint, text) from public, anon, authenticated;

grant execute on function public.pelham_staff_player_remove(text, text, text) to authenticated;
grant execute on function public.pelham_staff_rain_check_issue(jsonb) to authenticated;
grant execute on function public.pelham_staff_bill_refund(bigint, text) to authenticated;

notify pgrst, 'reload schema';
