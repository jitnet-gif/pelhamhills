-- 고객 삭제. 고객 목록(`/admin/customers`)의 Delete 버튼이 부른다. 매니저 PIN 이 있어야 된다.
--
-- 왜(2026-10-22): 잘못 넣었거나 겹친 고객을 명부에서 지울 방법이 없었다.
--
-- 바뀌는 것:
--   - `pelham_staff_customer_delete(p_ref)` — 매니저 승인(0024) 뒤 고객 한 명을 지운다.
--     승인은 action 'customer'(0054 가 이미 허용) · ref 'delete:<customer_ref>' 다. 수정 승인('customer' ·
--     '<customer_ref>')과 ref 가 달라서, 방금 고친 고객을 PIN 없이 지울 수는 없다.
--   - 그 사람의 회원권은 지우지 않고 cancelled 로 둔다(결제 기록은 남긴다). FK(0040)가 customer_ref 를
--     비운다 — 취소가 아니면 티시트 검색(0053)이 "명부에 없는 새 회원"으로 다시 보여 주기 때문이다.
--   - 마케팅 수신 동의(0047)는 FK 로 같이 지워진다. 다른 고객의 possible_duplicate_of 에서도 뺀다.
--   - 변경 기록(0057): 삭제는 트리거가 "지우기 전" 줄 전체로 이미 남긴다. 다만 누가 승인했는지는 없었다.
--     `pelham_change_log_capture` 가 트랜잭션 안의 `pelham.change_note` 설정을 label 뒤에 붙이게 하고,
--     삭제 함수가 거기에 "Deleted from Customers · approved by <매니저>" 를 넣는다. 같은 삭제로 생긴
--     회원권 취소·수신 동의 삭제·중복 의심 정리 줄에도 같은 메모가 붙는다. 다른 변경은 그대로다.
--     pelham_customers 에 트리거가 없으면(0057 뒤에 테이블이 다시 만들어졌을 때) 다시 붙인다.
--
-- 전제: 0054, 0057, 0070. 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다.

do $$
begin
  if to_regprocedure('public.pelham_staff_customer_save(text, jsonb)') is null then
    raise exception '0071 needs 0054 first (pelham_staff_customer_save is missing).';
  end if;
  if to_regprocedure('public.pelham_change_log_capture()') is null then
    raise exception '0071 needs 0057 first (pelham_change_log_capture is missing).';
  end if;
end;
$$;

-- ===== 변경 기록 (0057 + 메모) =============================================

-- 0057 과 같고, label 뒤에 `pelham.change_note`(이 트랜잭션에서만 유효)를 붙이는 것만 다르다.
create or replace function public.pelham_change_log_capture()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old jsonb;
  v_new jsonb;
  v_row jsonb;
  v_key text;
  v_changed text[];
  v_uid uuid := auth.uid();
  v_email text;
  v_note text := nullif(btrim(coalesce(current_setting('pelham.change_note', true), '')), '');
begin
  if tg_op in ('UPDATE', 'DELETE') then
    v_old := public.pelham_change_log_clean(to_jsonb(old));
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    v_new := public.pelham_change_log_clean(to_jsonb(new));
  end if;

  if tg_op = 'UPDATE' then
    select array_agg(k order by k) into v_changed
      from (select key as k from jsonb_each(v_old) union select key from jsonb_each(v_new)) keys
     where k <> 'updated_at' and (v_old->k) is distinct from (v_new->k);
    if v_changed is null then
      return null;
    end if;
  end if;

  v_row := coalesce(v_new, v_old);
  select string_agg(v_row->>btrim(c), ':') into v_key
    from unnest(string_to_array(coalesce(tg_argv[0], 'id'), ',')) c;

  if v_uid is not null then
    select u.email into v_email from auth.users u where u.id = v_uid;
  end if;

  insert into public.pelham_change_log
    (table_name, row_key, op, label, before_row, after_row, changed, actor_id, actor_email)
  values (tg_table_name, v_key, lower(tg_op),
          nullif(concat_ws(' · ', public.pelham_change_log_label(v_row), v_note), ''),
          v_old, v_new, v_changed, v_uid, v_email);
  return null;
end;
$$;

do $$
begin
  if not exists (select 1 from pg_trigger t
                  where t.tgrelid = 'public.pelham_customers'::regclass and t.tgname = 'pelham_change_log') then
    create trigger pelham_change_log after insert or update or delete on public.pelham_customers
      for each row execute function public.pelham_change_log_capture('customer_ref');
  end if;
end;
$$;

-- ===== 삭제 ============================================================

create or replace function public.pelham_staff_customer_delete(p_ref text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_ref text := nullif(btrim(coalesce(p_ref, '')), '');
  v_manager text;
begin
  perform public.pelham_require_staff();
  if v_ref is null or not exists (select 1 from public.pelham_customers c where c.customer_ref = v_ref) then
    perform public.pelham_fail('404', format('Customer %s was not found.', coalesce(v_ref, '')));
  end if;

  perform public.pelham_require_manager('customer', 'delete:' || v_ref, 'deleting this customer');

  -- 변경 기록에 남길 승인자: 방금 이 삭제를 승인한 매니저.
  select mg.name into v_manager
    from public.pelham_manager_approvals a
    join public.pelham_managers mg on mg.id = a.manager_id
   where a.ok and a.requested_by is not distinct from auth.uid()
     and a.action = 'customer' and a.ref = 'delete:' || v_ref
   order by a.created_at desc
   limit 1;
  perform set_config('pelham.change_note',
                     concat_ws(' · ', 'Deleted from Customers', 'approved by ' || v_manager), true);

  update public.pelham_memberships m
     set status = 'cancelled', updated_at = now()
   where m.customer_ref = v_ref and m.status <> 'cancelled';

  delete from public.pelham_customers c where c.customer_ref = v_ref;

  -- 남은 고객의 중복 의심에서 뺀다. 다른 검토 사유가 없으면 Review 표시도 내린다.
  update public.pelham_customers c
     set possible_duplicate_of = array_remove(c.possible_duplicate_of, v_ref),
         needs_review = cardinality(c.review_reasons) > 0
                        or cardinality(array_remove(c.possible_duplicate_of, v_ref)) > 0
   where v_ref = any(c.possible_duplicate_of);

  perform set_config('pelham.change_note', '', true);
  return jsonb_build_object('customer_ref', v_ref, 'deleted', true);
end;
$$;

revoke all on function public.pelham_change_log_capture() from public, anon, authenticated;
revoke all on function public.pelham_staff_customer_delete(text) from public, anon, authenticated;
grant execute on function public.pelham_staff_customer_delete(text) to authenticated;

notify pgrst, 'reload schema';
