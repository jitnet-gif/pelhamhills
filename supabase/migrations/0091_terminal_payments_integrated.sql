-- 단말기(S700) 승인에 묶인 결제 줄은 'integrated' 다 — "Keyed by hand" 로 세지 않는다.
--
-- 왜(2026-10-23): Daily close 의 "Card & debit vs. Stripe" 가 카드·체크카드 $1,828.08 전부를
-- "Keyed by hand — not in Stripe" 로, Register reader (S700) 를 $0.00 으로 보였다. 그래서 "Should be charged in
-- Stripe" 가 $0 이고 Stripe 가 받은 $2,006.09 전부가 차이로 나왔다.
-- 운영 DB 의 `pelham_staff_bill_pay` 는 0021 글자 그대로가 아니라 terminal_txn 을 모른다(0085·0087 참고).
-- 그래서 S700 으로 받은 결제도 손으로 친 전표처럼 `entry = 'keyed'`, `terminal = 'Card terminal'` 로 적힌다.
-- 0087 이 승인 줄을 결제 줄에 묶어(`terminal_txn_id`) Stripe check 는 맞췄지만 `entry` 는 그대로 두었다.
-- Daily close 의 카드 표(CardSales)는 `entry` 로 단말기·온라인·손으로 친 것을 나눈다.
--
-- 바뀌는 것
-- 1. `pelham_bill_payments` 에 BEFORE 트리거 — `terminal_txn_id` 가 있는 카드·체크카드 줄은 언제나
--    entry 'integrated', terminal 'Stripe Terminal', 승인번호·끝 4자리는 비어 있으면 승인 줄에서.
--    결제 함수의 글자에 기대지 않는다. 0087 트리거가 나중에 terminal_txn_id 를 채우는 UPDATE 에도 걸린다.
-- 2. 이미 묶인 지난 결제 줄을 같은 규칙으로 고친다.
-- 3. 끝의 확인 쿼리 두 개.
--
-- 전제: 0019, 0087. 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다.

do $$
begin
  if to_regprocedure('public.pelham_bill_payment_link_terminal()') is null then
    raise exception '0091 needs 0087 first (pelham_bill_payment_link_terminal is missing).';
  end if;
end;
$$;

-- ===== 트리거 ==========================================================

create or replace function public.pelham_bill_payment_entry_from_terminal()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.pelham_terminal_transactions;
begin
  if new.terminal_txn_id is null or new.method not in ('card', 'debit') then
    return new;
  end if;
  select * into t from public.pelham_terminal_transactions where id = new.terminal_txn_id;
  new.entry := 'integrated';
  new.terminal := 'Stripe Terminal';
  new.auth_code := coalesce(nullif(btrim(coalesce(new.auth_code, '')), ''), t.auth_code);
  new.card_last4 := coalesce(nullif(new.card_last4, ''), t.card_last4);
  return new;
end;
$$;

revoke all on function public.pelham_bill_payment_entry_from_terminal() from public, anon, authenticated;

drop trigger if exists pelham_bill_payment_entry_from_terminal on public.pelham_bill_payments;
create trigger pelham_bill_payment_entry_from_terminal
  before insert or update of terminal_txn_id on public.pelham_bill_payments
  for each row execute function public.pelham_bill_payment_entry_from_terminal();

-- ===== 지난 기록 ==========================================================

do $$
declare
  v_fixed integer;
begin
  update public.pelham_bill_payments p
     set entry = 'integrated',
         terminal = 'Stripe Terminal',
         auth_code = coalesce(nullif(btrim(coalesce(p.auth_code, '')), ''), t.auth_code),
         card_last4 = coalesce(nullif(p.card_last4, ''), t.card_last4)
    from public.pelham_terminal_transactions t
   where t.id = p.terminal_txn_id
     and p.method in ('card', 'debit')
     and p.entry <> 'integrated';
  get diagnostics v_fixed = row_count;
  raise notice '0091: % card payment(s) from the S700 were marked keyed — now integrated.', v_fixed;
end;
$$;

-- ===== 확인 ============================================================

-- 1) 오늘 카드·체크카드를 어디서 받았는지. 'keyed' 는 정말 손으로 친 전표만 남아야 한다.
select p.entry, p.terminal, count(*) as payments, sum(p.amount + p.tip) / 100.0 as charged_with_tips
  from public.pelham_bill_payments p
  join public.pelham_bills b on b.id = p.bill_id
 where p.method in ('card', 'debit')
   and b.business_date = public.pelham_pos_today()
   and b.status in ('paid', 'refunded')
 group by p.entry, p.terminal
 order by p.entry;

-- 2) 아직 'keyed' 인데 같은 계산서에 승인된 S700 거래가 있는 줄 — 금액·팁이 달라 0087 이 못 묶은 것. 비어 있어야 한다.
--    남으면 Stripe check 에서 그 줄을 눌러 정한다(0089).
select p.id as bill_payment, b.receipt_no, p.amount, p.tip,
       t.id as terminal_txn, t.requested_amount, t.tip as txn_tip, t.bill_payment_id
  from public.pelham_bill_payments p
  join public.pelham_bills b on b.id = p.bill_id
  join public.pelham_terminal_transactions t on t.bill_id = p.bill_id and t.kind = 'sale' and t.approved
 where p.method in ('card', 'debit') and p.entry = 'keyed'
 order by p.id desc
 limit 50;
