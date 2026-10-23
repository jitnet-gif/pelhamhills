-- 단말기 승인(`pelham_terminal_transactions`)을 그 승인으로 받은 계산서 결제 줄에 묶는다.
--
-- 왜(2026-10-23): Card payments 대사에서 계산대 S700 결제가 계산서는 paid 인데 전부
-- "Card charged … but it is not a payment on any bill." 이었다. 대사(0027)는 승인 줄의 `bill_payment_id` 로
-- 계산서에 붙었는지 보는데, 운영 DB 의 `pelham_staff_bill_pay` 가 0021 글자 그대로가 아니어서(0085 참고)
-- 결제 줄만 만들고 승인 줄에 되돌려 적지 않았다.
--
-- 바뀌는 것
-- 1. `pelham_bill_payments` 에 트리거 — 새 결제 줄이 생기면 승인 줄의 `bill_payment_id` 를 채운다.
--    결제 함수의 글자에 기대지 않는다. 함수가 이미 채웠으면 아무것도 하지 않는다.
--    결제 줄에 `terminal_txn_id` 가 없으면 같은 계산서·같은 금액·같은 팁의 아직 안 묶인 승인이 딱 하나일 때만 묶는다.
-- 2. 이미 결제된 것을 같은 규칙으로 채운다.
-- 3. 끝의 확인 쿼리: 계산서는 끝났는데 아직 안 묶인 승인(남는 것은 직접 볼 것 — 예: 계산서 void).
--
-- 전제: 0019, 0021. 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다.

do $$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'pelham_bill_payments'
                    and column_name = 'terminal_txn_id') then
    raise exception '0087 needs 0019 first (pelham_bill_payments.terminal_txn_id is missing).';
  end if;
end;
$$;

-- ===== 묶기 ============================================================

-- 결제 줄 하나에 맞는 승인 줄 id. 없거나 여럿이면 null.
create or replace function public.pelham_terminal_for_payment(pm public.pelham_bill_payments)
returns bigint
language plpgsql
stable
set search_path = ''
as $$
declare
  v_ids bigint[];
begin
  if pm.terminal_txn_id is not null then
    return pm.terminal_txn_id;
  end if;
  if pm.method not in ('card', 'debit') then
    return null;
  end if;
  select array_agg(t.id) into v_ids
    from public.pelham_terminal_transactions t
   where t.bill_id = pm.bill_id and t.kind = 'sale' and t.approved and t.voided_at is null
     and t.bill_payment_id is null
     and t.requested_amount = pm.amount and t.tip = pm.tip
     and not exists (select 1 from public.pelham_bill_payments o where o.terminal_txn_id = t.id);
  return case when cardinality(v_ids) = 1 then v_ids[1] end;
end;
$$;

revoke all on function public.pelham_terminal_for_payment(public.pelham_bill_payments) from public, anon, authenticated;

create or replace function public.pelham_bill_payment_link_terminal()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_txn bigint := public.pelham_terminal_for_payment(new);
begin
  if v_txn is null then
    return new;
  end if;
  update public.pelham_terminal_transactions
     set bill_payment_id = new.id
   where id = v_txn and bill_payment_id is null;
  if new.terminal_txn_id is null then
    update public.pelham_bill_payments set terminal_txn_id = v_txn where id = new.id;
  end if;
  return new;
end;
$$;

revoke all on function public.pelham_bill_payment_link_terminal() from public, anon, authenticated;

drop trigger if exists pelham_bill_payment_link_terminal on public.pelham_bill_payments;
create trigger pelham_bill_payment_link_terminal
  after insert on public.pelham_bill_payments
  for each row execute function public.pelham_bill_payment_link_terminal();

-- ===== 지난 기록 ==========================================================

-- 한 줄씩(같은 계산서에 같은 금액이 둘이면 앞 줄이 묶인 뒤 다음 줄은 하나만 남는다).
do $$
declare
  pm public.pelham_bill_payments;
  v_txn bigint;
  v_linked integer := 0;
begin
  for pm in
    select p.* from public.pelham_bill_payments p
     where p.method in ('card', 'debit')
       and not exists (select 1 from public.pelham_terminal_transactions t where t.bill_payment_id = p.id)
     order by p.id
  loop
    v_txn := public.pelham_terminal_for_payment(pm);
    continue when v_txn is null;
    update public.pelham_terminal_transactions
       set bill_payment_id = pm.id
     where id = v_txn and bill_payment_id is null;
    continue when not found;
    if pm.terminal_txn_id is null then
      update public.pelham_bill_payments set terminal_txn_id = v_txn where id = pm.id;
    end if;
    v_linked := v_linked + 1;
  end loop;
  raise notice '0087: linked % terminal approvals to bill payments.', v_linked;
end;
$$;

-- ===== 확인 ============================================================

-- 계산서가 open 이 아닌데 아직 안 묶인 승인. 비어 있어야 한다(void 계산서의 승인은 카드 환불을 직접 확인).
select t.id as terminal_txn, t.created_at, t.requested_amount, t.tip, t.card_last4,
       b.receipt_no, b.status as bill_status
  from public.pelham_terminal_transactions t
  left join public.pelham_bills b on b.id = t.bill_id
 where t.kind = 'sale' and t.approved and t.voided_at is null and t.bill_payment_id is null
   and coalesce(b.status, '') <> 'open'
 order by t.id;
