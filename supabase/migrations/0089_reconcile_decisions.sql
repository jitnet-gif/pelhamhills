-- Stripe check 의 한 줄을 눌러 정한다 — 이 카드 돈을 매출로 반영할 것인가, 말 것인가(2026-10-23).
--
-- 왜: Stripe check(0027)는 어긋남을 보여 주기만 했다. "Card charged … but it is not a payment on any bill"
-- (계산서 void), "the bill is still open", "The bill was refunded here, but … is still on the card" 를 보고도
-- 고치려면 계산대·Stripe 대시보드를 따로 돌아다녀야 했다. 이제 줄을 눌러 상세 창에서 정한다.
--
-- 정하는 것(화면 `ReconcileDetail.tsx`):
--   sale   — 매출로 반영. 단말기 승인을 그 계산서의 카드 결제로 붙이고 계산서를 paid 로 끝낸다
--            (`pelham_staff_reconcile_keep`). void 계산서는 다시 열고 줄을 되살린 뒤 결제한다.
--            결제는 `pelham_staff_bill_pay` 를 그대로 부른다 — 재고·티 시트·심·회원권 처리가 계산대와 같다.
--            계산서 합계 ≠ 카드 금액이면(나눠 낸 계산서) 여기서 끝내지 않고 계산대에서 열라고 한다.
--            영수증 번호와 영업일은 **오늘**(결제한 날)이다.
--   refund — 매출 아님. 카드 환불은 기존 단말기 환불(FastAPI `/payments/terminal/refund`, 0021·0024)이 하고,
--            끝나면 화면이 여기 한 줄을 남긴다(`pelham_staff_reconcile_decide`).
--   note   — 그대로 둔다(예: 손님에게 현금으로 돌려줬다). 돈은 움직이지 않고 이유만 남는다.
--            Stripe check 에서 그 줄은 Reviewed 로 바뀐다(문제 수에서 빠진다).
--
-- sale·note 는 Pelham Shift ID 승인('reconcile', ref = PaymentIntent)을 받는다 — 누가 정했는지 남는다.
-- refund 는 카드 환불 자체가 'refund' 승인을 받는다(0024).
--
-- 바뀌는 것:
--   pelham_reconcile_decisions             — 새 표. 결정 한 번 = 한 줄(지우지 않는다).
--   pelham_shift_approve(...)              — 승인할 수 있는 일에 'reconcile' 을 더한다(나머지는 0079 그대로).
--   pelham_staff_reconcile_keep(txn, note) — 매출로 반영.
--   pelham_staff_reconcile_decide(p)       — refund·note 기록.
--   pelham_staff_reconcile_decisions(ids)  — PaymentIntent 별 마지막 결정. FastAPI 대사가 읽는다.
--
-- 확인: 이 파일 끝의 select 가 결정 기록을 보여 준다(처음엔 비어 있다).
--
-- 전제: 0019, 0021, 0024, 0077, 0079. 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다.
-- **0077·0079 를 다시 실행하면 이 파일도 다시 실행해야 한다**('reconcile' 승인이 빠진다).

do $$
begin
  if to_regprocedure('public.pelham_shift_approve(uuid, text, text, text)') is null
     or to_regprocedure('public.pelham_manager_of(text, text)') is null then
    raise exception '0089 needs 0077 and 0079 first (pelham_shift_approve is missing).';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'pelham_terminal_transactions'
                    and column_name = 'payment_intent') then
    raise exception '0089 needs 0021 first (pelham_terminal_transactions.payment_intent is missing).';
  end if;
end;
$$;

-- ===== 표 ==============================================================

create table if not exists public.pelham_reconcile_decisions (
  id               bigint generated always as identity primary key,
  payment_intent   text not null check (payment_intent ~ '^pi_[A-Za-z0-9_]{1,60}$'),
  terminal_txn_id  bigint references public.pelham_terminal_transactions (id),
  decision         text not null check (decision in ('sale', 'refund', 'note')),
  note             text check (note is null or length(note) <= 500),
  -- 승인한 직원(Pelham Shift). refund 는 카드 환불의 승인 이름.
  staff_name       text,
  bill_id          bigint references public.pelham_bills (id),
  amount           integer not null default 0,
  created_by       uuid,
  created_at       timestamptz not null default now()
);

create index if not exists pelham_reconcile_decisions_pi_idx
  on public.pelham_reconcile_decisions (payment_intent, created_at desc);

alter table public.pelham_reconcile_decisions enable row level security;
revoke all on public.pelham_reconcile_decisions from anon, authenticated;

create or replace function public.pelham_reconcile_decision_json(d public.pelham_reconcile_decisions)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', d.id,
    'payment_intent', d.payment_intent,
    'terminal_txn_id', d.terminal_txn_id,
    'decision', d.decision,
    'note', d.note,
    'staff_name', d.staff_name,
    'bill_id', d.bill_id,
    'amount', d.amount,
    'created_at', public.pelham_iso(d.created_at)
  )
$$;

-- ===== 승인 ============================================================

-- 0079 와 같고 'reconcile' 만 더한다.
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
       ('refund', 'rain_check', 'remove_player', 'mark_unpaid', 'price', 'customer', 'delete_booking',
        'reconcile') then
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

-- ===== 매출로 반영 ======================================================

-- 단말기 승인 하나를 그 계산서의 카드 결제로 붙여 계산서를 끝낸다.
-- 반환: {bill: pelham_pos_bill_json, decision}.
create or replace function public.pelham_staff_reconcile_keep(p_txn bigint, p_note text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  t public.pelham_terminal_transactions;
  b public.pelham_bills;
  v_note text := nullif(left(btrim(coalesce(p_note, '')), 500), '');
  v_staff text;
  v_bill jsonb;
  d public.pelham_reconcile_decisions;
begin
  perform public.pelham_require_staff();
  select * into t from public.pelham_terminal_transactions where id = p_txn and kind = 'sale';
  if t.id is null then
    perform public.pelham_fail('404', 'Terminal approval not found.');
  end if;
  if t.payment_intent is null then
    perform public.pelham_fail('409', 'This approval has no Stripe payment.');
  end if;
  perform public.pelham_require_manager('reconcile', t.payment_intent, 'counting this card payment as a sale');
  v_staff := public.pelham_manager_of('reconcile', t.payment_intent);

  -- 계산서 → 승인 순서로 잠근다(pelham_staff_bill_pay 와 같은 순서).
  select * into b from public.pelham_bills where id = t.bill_id for update;
  select * into t from public.pelham_terminal_transactions where id = p_txn for update;
  if b.id is null then
    perform public.pelham_fail('409', 'This approval is not on a bill. Ring it up at the register instead.');
  end if;
  if not t.approved then
    perform public.pelham_fail('409', 'This card payment was not approved.');
  end if;
  if t.voided_at is not null then
    perform public.pelham_fail('409', 'This card payment was already reversed on the reader.');
  end if;
  if t.bill_payment_id is not null then
    perform public.pelham_fail('409', 'This card payment is already on the bill.');
  end if;
  if exists (select 1 from public.pelham_terminal_transactions r
              where r.refund_of = t.id and (r.approved or r.result = 'pending')) then
    perform public.pelham_fail('409', 'This card payment was refunded (or a refund is in progress).');
  end if;
  if b.status not in ('open', 'void') then
    perform public.pelham_fail('409', format(
      'Bill %s is already %s. It cannot take this card payment as well — refund the card instead.',
      coalesce(b.receipt_no, '#' || b.id), b.status));
  end if;
  if exists (select 1 from public.pelham_bill_payments p where p.bill_id = b.id) then
    perform public.pelham_fail('409', 'This bill already has payments. Open it at the register to finish it.');
  end if;

  -- void 계산서를 되살린다. 줄을 지우면 행이 사라지므로(0005) void 계산서의 줄은 void 직전 그대로다.
  if b.status = 'void' then
    begin
      update public.pelham_bill_lines set active = true where bill_id = b.id;
    exception when unique_violation then
      perform public.pelham_fail('409',
        'A player or item on this bill is on another open bill now. Remove it there first.');
    end;
    update public.pelham_bills set status = 'open', voided_at = null where id = b.id;
  end if;

  perform public.pelham_pos_recalc(b.id);
  select * into b from public.pelham_bills where id = b.id;
  if b.total <> t.requested_amount then
    perform public.pelham_fail('409', format(
      'The bill total is %s but the card paid %s. Open the bill at the register to take the difference.',
      to_char(b.total / 100.0, 'FM$999,990.00'), to_char(t.requested_amount / 100.0, 'FM$999,990.00')));
  end if;

  -- auth_code·card_last4 도 넘긴다: 운영 DB 의 결제 함수가 terminal_txn 을 모르는 판이어도(0087 참고)
  -- 손으로 친 카드처럼 받아 준다. 그 경우 승인 줄은 0087 트리거나 아래에서 묶인다.
  v_bill := public.pelham_staff_bill_pay(b.id, jsonb_build_object(
    'checkout_id', gen_random_uuid(),
    'payments', jsonb_build_array(jsonb_build_object(
      'method', case when t.card_type = 'debit' then 'debit' else 'card' end,
      'amount', t.requested_amount,
      'tip', t.tip,
      'terminal_txn', t.id,
      'auth_code', left(coalesce(t.auth_code, t.transaction_id, t.payment_intent), 32),
      'card_last4', t.card_last4))));

  update public.pelham_terminal_transactions s
     set bill_payment_id = (select p.id from public.pelham_bill_payments p
                             where p.bill_id = b.id order by p.id desc limit 1)
   where s.id = t.id and s.bill_payment_id is null;
  update public.pelham_bill_payments p
     set terminal_txn_id = t.id
   where p.bill_id = b.id and p.terminal_txn_id is null
     and p.id = (select s.bill_payment_id from public.pelham_terminal_transactions s where s.id = t.id);

  insert into public.pelham_reconcile_decisions
    (payment_intent, terminal_txn_id, decision, note, staff_name, bill_id, amount, created_by)
  values (t.payment_intent, t.id, 'sale', v_note, v_staff, b.id, t.total_amount, auth.uid())
  returning * into d;
  return jsonb_build_object('bill', v_bill, 'decision', public.pelham_reconcile_decision_json(d));
end;
$$;

-- ===== 환불·그대로 둠 기록 =================================================

-- p: {payment_intent, decision: 'refund' | 'note', note, terminal_txn?, amount?}
-- refund: 카드 환불이 끝난 뒤 화면이 부른다. 승인 줄에 승인된 환불이 있어야 한다.
-- note: 이유가 있어야 하고 Shift ID 승인을 받는다.
create or replace function public.pelham_staff_reconcile_decide(p jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_pi text := btrim(coalesce(p->>'payment_intent', ''));
  v_decision text := coalesce(p->>'decision', '');
  v_note text := nullif(left(btrim(coalesce(p->>'note', '')), 500), '');
  v_txn bigint;
  v_amount integer;
  t public.pelham_terminal_transactions;
  v_staff text;
  d public.pelham_reconcile_decisions;
begin
  perform public.pelham_require_staff();
  if v_pi !~ '^pi_[A-Za-z0-9_]{1,60}$' then
    perform public.pelham_fail('422', 'payment_intent must be a Stripe payment (pi_…).');
  end if;
  begin
    v_txn := nullif(p->>'terminal_txn', '')::bigint;
    v_amount := coalesce(nullif(p->>'amount', '')::integer, 0);
  exception when others then
    perform public.pelham_fail('422', 'terminal_txn and amount must be numbers.');
  end;
  if v_txn is not null then
    select * into t from public.pelham_terminal_transactions where id = v_txn and kind = 'sale';
    if t.id is null or t.payment_intent is distinct from v_pi then
      perform public.pelham_fail('409', 'That terminal approval is not this Stripe payment.');
    end if;
  end if;

  if v_decision = 'refund' then
    if t.id is null then
      perform public.pelham_fail('422', 'Which card payment was refunded?');
    end if;
    select r.total_amount into v_amount from public.pelham_terminal_transactions r
     where r.refund_of = t.id and r.approved order by r.id desc limit 1;
    if v_amount is null then
      perform public.pelham_fail('409', 'The card refund has not gone through yet.');
    end if;
    v_staff := public.pelham_manager_of('refund', t.bill_id::text);
  elsif v_decision = 'note' then
    if v_note is null then
      perform public.pelham_fail('422', 'Say why it stays as it is.');
    end if;
    perform public.pelham_require_manager('reconcile', v_pi, 'leaving this card payment as it is');
    v_staff := public.pelham_manager_of('reconcile', v_pi);
  else
    perform public.pelham_fail('422', 'decision must be refund or note.');
  end if;

  insert into public.pelham_reconcile_decisions
    (payment_intent, terminal_txn_id, decision, note, staff_name, bill_id, amount, created_by)
  values (v_pi, t.id, v_decision, v_note, v_staff, t.bill_id, v_amount, auth.uid())
  returning * into d;
  return public.pelham_reconcile_decision_json(d);
end;
$$;

-- PaymentIntent 별 마지막 결정(직원). FastAPI 대사가 Stripe 에서 본 pi_ 들로 부른다.
create or replace function public.pelham_staff_reconcile_decisions(p_ids text[])
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.pelham_require_staff();
  if cardinality(coalesce(p_ids, '{}')) > 5000 then
    perform public.pelham_fail('422', 'Too many Stripe ids. Pick a shorter range.');
  end if;
  return coalesce((
    select jsonb_object_agg(x.payment_intent, public.pelham_reconcile_decision_json(x.d))
      from (select distinct on (d.payment_intent) d.payment_intent, d
              from public.pelham_reconcile_decisions d
             where d.payment_intent = any(coalesce(p_ids, '{}'))
             order by d.payment_intent, d.created_at desc, d.id desc) x
  ), '{}'::jsonb);
end;
$$;

-- ===== 권한 ============================================================

revoke all on function public.pelham_reconcile_decision_json(public.pelham_reconcile_decisions) from public, anon, authenticated;
revoke all on function public.pelham_shift_approve(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.pelham_staff_reconcile_keep(bigint, text) from public, anon, authenticated;
revoke all on function public.pelham_staff_reconcile_decide(jsonb) from public, anon, authenticated;
revoke all on function public.pelham_staff_reconcile_decisions(text[]) from public, anon, authenticated;
grant execute on function public.pelham_shift_approve(uuid, text, text, text) to service_role;
grant execute on function public.pelham_staff_reconcile_keep(bigint, text) to authenticated;
grant execute on function public.pelham_staff_reconcile_decide(jsonb) to authenticated;
grant execute on function public.pelham_staff_reconcile_decisions(text[]) to authenticated;

notify pgrst, 'reload schema';

-- ===== 확인 ============================================================

select d.id, d.created_at, d.payment_intent, d.decision, d.amount, d.staff_name, d.note
  from public.pelham_reconcile_decisions d
 order by d.id desc
 limit 20;
