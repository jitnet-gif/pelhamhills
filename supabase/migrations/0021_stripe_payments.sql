-- 결제사를 Stripe 로 바꾼다: 온라인 결제(Checkout)와 계산대 단말기(Stripe Terminal, 서버 주도).
--
-- 왜(2026-10-09): 온라인은 Authorize.net, 계산대는 DX8000(J.P. Morgan PTA)이었지만 둘 다 Stripe 하나로
-- 모은다. 장부의 규칙(금액은 SQL 이 정한다, 승인은 Charge 전에 남는다, 기록할 수 없는 승인은 되돌린다)은
-- 그대로이고, 바뀌는 것은 카드사와 말하는 쪽뿐이다.
--
-- 온라인 (0020 위에)
--   - 거래 ID 가 숫자(Authorize.net transId)에서 Stripe id(`pi_…`, 환불은 `re_…`)로 바뀐다.
--   - `gateway_session` = Checkout 세션(`cs_…`). 결과 화면이 이 세션을 Stripe 에 다시 물어 확인한다.
--   - 계산서·티 시트에 남는 문구가 "Stripe" 가 된다.
--
-- 계산대 (0019 위에)
--   - 단말기와 말하는 것이 계산대 브라우저가 아니라 **FastAPI** 다(Stripe API → 리더). 그래서 승인 결과도
--     FastAPI 가 Stripe 에 다시 물어 확인한 값만 기록한다(`pelham_terminal_settle`, service_role 전용).
--     브라우저가 결과를 써 넣던 `pelham_staff_terminal_record` 는 직원에게서 거둔다 — 승인을 지어낼 수 없게.
--   - 흐름: `pelham_staff_terminal_begin`(직원 확인 + pending 한 줄) → FastAPI 가 PaymentIntent 를 만들어
--     리더로 보냄 → 결과 확인 → settle. 이 줄의 id 가 지금처럼 결제 줄의 `terminal_txn` 이다.
--   - 결제 줄 삭제·환불은 kind `refund` 한 줄(원 거래 `refund_of`). Charge 전이면 원 승인을 voided 로 둔다.
--
-- 전제: 0019, 0020. 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다.

-- ===== 먼저 확인 ======================================================
do $$
begin
  if to_regclass('public.pelham_terminal_transactions') is null then
    raise exception '0021 needs 0019 (card terminal) first.';
  end if;
  if to_regclass('public.pelham_online_payments') is null then
    raise exception '0021 needs 0020 (online payments) first.';
  end if;
end;
$$;

-- ===== 온라인: 표 ======================================================

-- 이름 없는 check 는 정의로 찾아 바꾼다(0020 과 같은 방식).
do $$
declare
  c record;
begin
  for c in
    select conname from pg_constraint
     where conrelid = 'public.pelham_online_payments'::regclass and contype = 'c'
       and pg_get_constraintdef(oid) like '%trans_id%~%'
  loop
    execute format('alter table public.pelham_online_payments drop constraint %I', c.conname);
  end loop;
  alter table public.pelham_online_payments add constraint pelham_online_payments_trans_id_check
    check (trans_id is null or trans_id ~ '^[A-Za-z0-9_]{1,64}$');
  alter table public.pelham_online_payments add constraint pelham_online_payments_refund_trans_id_check
    check (refund_trans_id is null or refund_trans_id ~ '^[A-Za-z0-9_]{1,64}$');
end;
$$;

alter table public.pelham_online_payments add column if not exists gateway_session text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'pelham_online_payments_gateway_session_check') then
    alter table public.pelham_online_payments add constraint pelham_online_payments_gateway_session_check
      check (gateway_session is null or gateway_session ~ '^cs_[A-Za-z0-9_]{1,250}$');
  end if;
end;
$$;

-- ===== 온라인: 함수 ====================================================

create or replace function public.pelham_op_json(r public.pelham_online_payments)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'invoice', r.invoice,
    'kind', r.kind,
    'confirmation_code', r.confirmation_code,
    'description', r.description,
    'subtotal', r.subtotal,
    'tax', r.tax,
    'amount', r.amount,
    'status', r.status,
    'response_text', r.response_text,
    'trans_id', r.trans_id,
    'gateway_session', r.gateway_session,
    'card_brand', r.card_brand,
    'card_last4', r.card_last4,
    'receipt_no', (select b.receipt_no from public.pelham_bills b where b.id = r.bill_id),
    'refund_kind', r.refund_kind,
    'refund_pending', r.refund_started_at is not null and r.status = 'approved',
    'created_at', public.pelham_iso(r.created_at),
    'approved_at', public.pelham_iso(r.approved_at),
    'refunded_at', public.pelham_iso(r.refunded_at)
  )
$$;

-- Checkout 세션을 연 뒤 그 id 를 적는다. 결과 화면·웹훅이 이것으로 Stripe 에 다시 묻는다.
create or replace function public.pelham_online_pay_session(p_invoice text, p_session text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  o public.pelham_online_payments;
begin
  if coalesce(p_session, '') !~ '^cs_[A-Za-z0-9_]{1,250}$' then
    perform public.pelham_fail('422', 'session must be a Stripe Checkout session id.');
  end if;
  update public.pelham_online_payments
     set gateway_session = p_session, updated_at = now()
   where invoice = upper(btrim(coalesce(p_invoice, ''))) and status = 'pending'
  returning * into o;
  if o.id is null then
    perform public.pelham_fail('404', 'No pending online payment with that invoice.');
  end if;
  return public.pelham_op_json(o);
end;
$$;

-- 승인된 거래를 계산서로 기록한다(0020 과 같고, 남기는 문구만 Stripe).
create or replace function public.pelham_op_attach(o public.pelham_online_payments, p_auth text, p_last4 text,
                                                   p_brand text)
returns bigint
language plpgsql
volatile
set search_path = ''
as $$
declare
  t public.pelham_tee_bookings;
  r public.pelham_sim_reservations;
  v_doc jsonb;
  v_quote jsonb;
  v_bill bigint;
  v_total integer;
  v_date date := public.pelham_pos_today();
  v_no integer;
  v_receipt text;
  v_now text := public.pelham_iso(now());
  v_players jsonb;
  v_names text[];
  pl jsonb;
begin
  -- 잠금 순서는 직원 결제(0005·0008)와 같다: 예약의 advisory 키 → 예약 행.
  if o.kind = 'tee' then
    select * into t from public.pelham_tee_bookings where id = o.booking_id;
    if t.id is null then
      perform public.pelham_fail('409', 'The booking no longer exists.');
    end if;
    perform public.pelham_tee_lock((t.doc->>'date')::date, t.doc->>'time');
    select * into t from public.pelham_tee_bookings where id = o.booking_id for update;
    v_quote := public.pelham_op_tee_quote(t);
  else
    select * into r from public.pelham_sim_reservations where id = o.sim_reservation_id;
    if r.id is null then
      perform public.pelham_fail('409', 'The booking no longer exists.');
    end if;
    perform pg_advisory_xact_lock(hashtext('pelham_sim:' || r.booking_date::text));
    select * into r from public.pelham_sim_reservations where id = o.sim_reservation_id for update;
    v_quote := public.pelham_op_sim_quote(r);
  end if;
  if not (v_quote->>'payable')::boolean then
    perform public.pelham_fail('409', v_quote->>'reason');
  end if;
  if (v_quote->>'total')::integer <> o.amount then
    perform public.pelham_fail('409', format('The price changed from %s to %s cents after checkout started.',
                                             o.amount, v_quote->>'total'));
  end if;

  insert into public.pelham_bills (station, label, cashier, note)
  values ('online', 'Online ' || o.confirmation_code, 'Online',
          format('Paid online · Stripe %s · invoice %s', o.trans_id, o.invoice))
  returning id into v_bill;

  if o.kind = 'tee' then
    for pl in select e from jsonb_array_elements(coalesce(t.doc->'players', '[]'::jsonb)) e loop
      if coalesce((pl->>'cancelled')::boolean, false) then
        continue;
      end if;
      insert into public.pelham_bill_lines
        (bill_id, kind, sku, name, category, quantity, unit_price, line_total,
         booking_id, player_id, tee_date, tee_time)
      values
        (v_bill, 'tee_player', 'TEE', public.pelham_pos_tee_line_name(t.doc, pl), 'Green Fees',
         1, public.pelham_pos_tee_price(t.doc, pl), public.pelham_pos_tee_price(t.doc, pl),
         t.id, pl->>'id', (t.doc->>'date')::date, t.doc->>'time');
    end loop;
  else
    insert into public.pelham_bill_lines
      (bill_id, kind, sku, name, category, quantity, unit_price, line_total,
       sim_reservation_id, tee_date, tee_time)
    values
      (v_bill, 'sim_booking', 'SIM', public.pelham_pos_sim_line_name(r), 'Simulator',
       1, (v_quote->>'subtotal')::integer, (v_quote->>'subtotal')::integer,
       r.id, r.booking_date, public.pelham_pos_sim_time(r.start_minutes));
  end if;

  perform public.pelham_pos_recalc(v_bill);
  select b.total into v_total from public.pelham_bills b where b.id = v_bill;
  if v_total <> o.amount then
    perform public.pelham_fail('409', format('The bill came to %s cents, not %s.', v_total, o.amount));
  end if;

  insert into public.pelham_receipt_counters as c (business_date, last_no) values (v_date, 1)
  on conflict (business_date) do update set last_no = c.last_no + 1
  returning last_no into v_no;
  v_receipt := format('PH-%s-%s', to_char(v_date, 'YYYYMMDD'), lpad(v_no::text, 4, '0'));

  insert into public.pelham_bill_payments (bill_id, method, amount, tip, entry, auth_code, card_last4, terminal)
  values (v_bill, 'card', o.amount, 0, 'online', coalesce(nullif(btrim(p_auth), ''), o.trans_id),
          p_last4, left('Stripe' || coalesce(' · ' || nullif(btrim(p_brand), ''), ''), 60));

  -- 실내 골프 예약은 이 update 의 트리거(0008 `pelham_pos_sim_on_bill`)가 paid 로 바꾼다.
  update public.pelham_bills
     set status = 'paid', checkout_id = gen_random_uuid(), receipt_no = v_receipt, business_date = v_date,
         tip = 0, paid_at = now()
   where id = v_bill;

  if o.kind = 'tee' then
    select coalesce(jsonb_agg(
             case when exists (select 1 from public.pelham_bill_lines li
                                where li.bill_id = v_bill and li.player_id = e.value->>'id'
                                  and li.kind = 'tee_player' and li.active)
                  then e.value || jsonb_build_object('paid', true, 'paidAt', v_now)
                  else e.value end
             order by e.ord), '[]'::jsonb)
      into v_players
      from jsonb_array_elements(coalesce(t.doc->'players', '[]'::jsonb)) with ordinality as e(value, ord);
    select array_agg(li.name order by li.id) into v_names
      from public.pelham_bill_lines li where li.bill_id = v_bill and li.kind = 'tee_player';
    v_doc := jsonb_set(t.doc, '{players}', v_players);
    v_doc := public.pelham_tee_audit(v_doc,
               format('Paid online (Stripe %s) on bill %s: %s.', o.trans_id, v_receipt,
                      array_to_string(v_names, ', ')), v_now);
    perform public.pelham_tee_save(v_doc);
  else
    update public.pelham_sim_reservations
       set notes = btrim(coalesce(notes, '') || E'\n' || format('[%s] Paid online on bill %s.',
                         to_char(public.pelham_local_now(), 'YYYY-MM-DD HH24:MI'), v_receipt)),
           updated_at = now()
     where id = r.id;
  end if;

  return v_bill;
end;
$$;

-- Stripe 가 돌려준(FastAPI 가 다시 확인한) 결과를 기록한다(0020 과 같고, 거래 ID 가 Stripe id).
create or replace function public.pelham_online_pay_complete(p jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  o public.pelham_online_payments;
  v_trans text := nullif(btrim(coalesce(p->>'trans_id', '')), '');
  v_code text := btrim(coalesce(p->>'response_code', ''));
  v_amount integer;
  v_last4 text := nullif(right(regexp_replace(coalesce(p->>'card_last4', ''), '[^0-9]', '', 'g'), 4), '');
  v_brand text := left(nullif(btrim(coalesce(p->>'card_brand', '')), ''), 30);
  v_auth text := left(nullif(btrim(coalesce(p->>'auth_code', '')), ''), 12);
  v_text text := left(nullif(btrim(coalesce(p->>'response_text', '')), ''), 300);
  v_bill bigint;
  v_err text;
begin
  if v_trans is null or v_trans !~ '^[A-Za-z0-9_]{1,64}$' then
    perform public.pelham_fail('422', 'trans_id is required.');
  end if;
  if v_last4 is not null and length(v_last4) <> 4 then
    v_last4 := null;
  end if;
  begin
    v_amount := (p->>'amount')::integer;
  exception when others then
    perform public.pelham_fail('422', 'amount must be cents.');
  end;

  select * into o from public.pelham_online_payments where invoice = upper(btrim(coalesce(p->>'invoice', ''))) for update;
  if o.id is null then
    perform public.pelham_fail('404', 'No online payment with that invoice.');
  end if;

  -- 이미 다른 거래가 이 invoice 로 기록됐다(같은 폼을 두 번 낸 경우 등). 이 거래는 기록하지 않고 돌려준다.
  if o.trans_id is not null and o.trans_id <> v_trans then
    return public.pelham_op_json(o) || jsonb_build_object(
      'needs_reversal', v_code = '1', 'reversal_trans_id', v_trans,
      'note', 'A different transaction already belongs to this invoice.');
  end if;
  -- 같은 거래가 다시 왔다. 처음 결과 그대로.
  if o.status in ('approved', 'orphaned', 'voided', 'refunded') then
    return public.pelham_op_json(o) || jsonb_build_object(
      'needs_reversal', o.status = 'orphaned', 'reversal_trans_id', case when o.status = 'orphaned' then o.trans_id end);
  end if;

  if v_code <> '1' then
    update public.pelham_online_payments
       set status = case v_code when '2' then 'declined' when '4' then 'held' else 'error' end,
           response_code = v_code, response_text = v_text, trans_id = v_trans, auth_code = v_auth,
           card_brand = v_brand, card_last4 = v_last4, updated_at = now()
     where id = o.id
    returning * into o;
    return public.pelham_op_json(o) || jsonb_build_object('needs_reversal', false, 'reversal_trans_id', null);
  end if;

  update public.pelham_online_payments
     set response_code = v_code, response_text = v_text, trans_id = v_trans, auth_code = v_auth,
         card_brand = v_brand, card_last4 = v_last4, updated_at = now()
   where id = o.id
  returning * into o;

  if v_amount is distinct from o.amount then
    v_err := format('Approved amount %s cents does not match %s.', coalesce(v_amount::text, '?'), o.amount);
  else
    -- 기록이 실패하면(예약 취소됨, 프로 샵이 먼저 받음, 가격 변경) 이 블록 안의 쓰기는 전부 되돌아간다.
    begin
      v_bill := public.pelham_op_attach(o, v_auth, v_last4, v_brand);
    exception when others then
      v_err := sqlerrm;
    end;
  end if;

  if v_err is not null then
    update public.pelham_online_payments
       set status = 'orphaned', response_text = left('Not recorded: ' || v_err, 300), updated_at = now()
     where id = o.id
    returning * into o;
    return public.pelham_op_json(o) || jsonb_build_object('needs_reversal', true, 'reversal_trans_id', o.trans_id);
  end if;

  update public.pelham_online_payments
     set status = 'approved', bill_id = v_bill, approved_at = now(), updated_at = now()
   where id = o.id
  returning * into o;
  return public.pelham_op_json(o) || jsonb_build_object('needs_reversal', false, 'reversal_trans_id', null);
end;
$$;

-- 온라인 계산서를 POS 의 Refund 로 닫지 못하게 한다(0020 과 같고, 안내 문구만 Stripe).
create or replace function public.pelham_op_guard_bill()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status = 'paid' and new.status <> 'paid'
     and exists (select 1 from public.pelham_online_payments o
                  where o.bill_id = new.id and o.status = 'approved') then
    perform public.pelham_fail('409',
      'This bill was paid online. Refund it in the Stripe Dashboard — the bill updates itself.');
  end if;
  return new;
end;
$$;

-- ===== 계산대: 표 ======================================================

alter table public.pelham_terminal_transactions
  add column if not exists payment_intent text,
  add column if not exists reader_id      text,
  add column if not exists refund_of      bigint references public.pelham_terminal_transactions (id),
  add column if not exists cancels        bigint references public.pelham_terminal_transactions (id),
  add column if not exists updated_at     timestamptz not null default now();

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'pelham_terminal_transactions_payment_intent_check') then
    alter table public.pelham_terminal_transactions add constraint pelham_terminal_transactions_payment_intent_check
      check (payment_intent is null or payment_intent ~ '^pi_[A-Za-z0-9_]{1,60}$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'pelham_terminal_transactions_reader_check') then
    alter table public.pelham_terminal_transactions add constraint pelham_terminal_transactions_reader_check
      check (reader_id is null or reader_id ~ '^tmr_[A-Za-z0-9_]{1,60}$');
  end if;
end;
$$;

-- 판매 하나에 PaymentIntent 하나. 환불 줄은 원 판매의 PaymentIntent 를 같이 적으므로 판매에만 유일.
create unique index if not exists pelham_terminal_transactions_sale_pi_idx
  on public.pelham_terminal_transactions (payment_intent) where payment_intent is not null and kind = 'sale';
create index if not exists pelham_terminal_transactions_pending_idx
  on public.pelham_terminal_transactions (bill_id) where result = 'pending';

-- ===== 계산대: 함수 ====================================================

create or replace function public.pelham_terminal_json(t public.pelham_terminal_transactions)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', t.id,
    'reference', t.reference,
    'kind', t.kind,
    'bill_id', t.bill_id,
    'result', t.result,
    'pending', t.result = 'pending',
    'approved', t.approved,
    'requested_amount', t.requested_amount,
    'tip', t.tip,
    'total_amount', t.total_amount,
    'auth_code', t.auth_code,
    'original_auth_code', t.original_auth_code,
    'transaction_id', t.transaction_id,
    'payment_intent', t.payment_intent,
    'reader_id', t.reader_id,
    'refund_of', t.refund_of,
    'response_code', t.response_code,
    'host_message', t.host_message,
    'card_brand', t.card_brand,
    'card_last4', t.card_last4,
    'card_type', t.card_type,
    'entry_mode', t.entry_mode,
    'used', t.bill_payment_id is not null,
    'voided_at', public.pelham_iso(t.voided_at),
    'created_at', public.pelham_iso(t.created_at)
  )
$$;

-- 단말기 거래를 시작한다(직원). FastAPI 가 직원의 토큰으로 부른다 — 직원 확인은 여기서 한다.
-- p: {bill_id, kind: 'sale' | 'refund', amount (센트), refund_of (refund 일 때 원 판매 id), reader_id}
-- 반환: pelham_terminal_json (result 'pending'). FastAPI 가 이어서 Stripe 로 보낸다.
create or replace function public.pelham_staff_terminal_begin(p jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_kind text := coalesce(p->>'kind', '');
  v_bill bigint;
  v_amount integer;
  v_reader text := nullif(btrim(coalesce(p->>'reader_id', '')), '');
  v_bill_row public.pelham_bills;
  o public.pelham_terminal_transactions;
  v_row public.pelham_terminal_transactions;
  v_ref text := upper(substr(md5(gen_random_uuid()::text), 1, 12));
begin
  perform public.pelham_require_staff();
  begin
    v_bill := nullif(p->>'bill_id', '')::bigint;
    v_amount := nullif(p->>'amount', '')::integer;
  exception when others then
    perform public.pelham_fail('422', 'bill_id and amount must be numbers.');
  end;
  if v_reader is not null and v_reader !~ '^tmr_[A-Za-z0-9_]{1,60}$' then
    perform public.pelham_fail('422', 'Pick a card reader first.');
  end if;
  select * into v_bill_row from public.pelham_bills where id = v_bill;
  if v_bill_row.id is null then
    perform public.pelham_fail('404', 'Bill not found');
  end if;

  if v_kind = 'sale' then
    if v_reader is null then
      perform public.pelham_fail('422', 'Pick a card reader first.');
    end if;
    if v_bill_row.status <> 'open' then
      perform public.pelham_fail('409', format('This bill is %s.', v_bill_row.status));
    end if;
    if coalesce(v_amount, 0) <= 0 then
      perform public.pelham_fail('422', 'Enter an amount above $0.00.');
    end if;
    if v_amount > v_bill_row.total then
      perform public.pelham_fail('422', format('The bill total is only %s cents.', v_bill_row.total));
    end if;
    insert into public.pelham_terminal_transactions
      (reference, kind, bill_id, result, approved, requested_amount, reader_id, created_by)
    values (v_ref, 'sale', v_bill, 'pending', false, v_amount, v_reader, auth.uid())
    returning * into v_row;
    return public.pelham_terminal_json(v_row);
  end if;

  if v_kind <> 'refund' then
    perform public.pelham_fail('422', 'kind must be sale or refund.');
  end if;
  select * into o from public.pelham_terminal_transactions
   where id = nullif(p->>'refund_of', '')::bigint and kind = 'sale' for update;
  if o.id is null then
    perform public.pelham_fail('404', 'Terminal approval not found.');
  end if;
  if o.bill_id is distinct from v_bill then
    perform public.pelham_fail('409', 'That terminal approval belongs to another bill.');
  end if;
  if not o.approved or o.payment_intent is null then
    perform public.pelham_fail('409', 'That terminal transaction was not approved.');
  end if;
  if o.voided_at is not null then
    perform public.pelham_fail('409', 'That terminal approval was already reversed.');
  end if;
  if exists (select 1 from public.pelham_terminal_transactions r
              where r.refund_of = o.id and (r.approved or r.result = 'pending')) then
    perform public.pelham_fail('409', 'That payment is already refunded (or a refund is in progress).');
  end if;
  v_amount := coalesce(v_amount, o.total_amount);
  if v_amount <= 0 or v_amount > o.total_amount then
    perform public.pelham_fail('422', format('Refund between 1 and %s cents.', o.total_amount));
  end if;
  -- Interac 환불은 손님이 리더에 카드를 다시 대야 한다. 신용카드는 리더가 필요 없다.
  if o.card_type = 'debit' and v_reader is null then
    perform public.pelham_fail('422', 'Interac refunds need the card reader. Pick a reader first.');
  end if;
  insert into public.pelham_terminal_transactions
    (reference, kind, bill_id, result, approved, requested_amount, original_auth_code, payment_intent, reader_id,
     refund_of, cancels, card_brand, card_last4, card_type, created_by)
  values (v_ref, 'refund', v_bill, 'pending', false, v_amount, o.auth_code, o.payment_intent,
          case when o.card_type = 'debit' then v_reader end, o.id,
          -- Charge 전에 지운 결제 줄이면 그 승인을 되살리지 않게 voided 로 둔다(settle 이 한다).
          case when o.bill_payment_id is null then o.id end,
          o.card_brand, o.card_last4, o.card_type, auth.uid())
  returning * into v_row;
  return public.pelham_terminal_json(v_row);
end;
$$;

-- 한 줄(직원). FastAPI 가 직원 확인 겸 부른다.
create or replace function public.pelham_staff_terminal_get(p_id bigint)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_row public.pelham_terminal_transactions;
begin
  perform public.pelham_require_staff();
  select * into v_row from public.pelham_terminal_transactions where id = p_id;
  if v_row.id is null then
    perform public.pelham_fail('404', 'Terminal transaction not found.');
  end if;
  return public.pelham_terminal_json(v_row);
end;
$$;

-- 이 계산서에서 아직 결과를 모르는 거래(직원). 화면을 다시 열면 FastAPI 가 Stripe 에 물어 마무리한다.
create or replace function public.pelham_staff_terminal_in_flight(p_bill bigint)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.pelham_require_staff();
  return coalesce((
    select jsonb_agg(public.pelham_terminal_json(t) order by t.id)
      from public.pelham_terminal_transactions t
     where t.bill_id = p_bill and t.result = 'pending'
  ), '[]'::jsonb);
end;
$$;

-- Stripe 에 다시 물어 확인한 결과를 기록한다(service_role 전용 — 브라우저는 부를 수 없다).
-- p: {id, payment_intent?, reader_id?, final?: true, approved, result, auth_code, transaction_id, response_code,
--     host_message, card_brand, card_last4, card_type, entry_mode, tip, total_amount}
-- final 이 없으면 PaymentIntent·리더만 적는다(보낸 직후). final 은 pending 일 때 한 번만 — 몇 번 와도 같다.
create or replace function public.pelham_terminal_settle(p jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_row public.pelham_terminal_transactions;
  v_last4 text := nullif(p->>'card_last4', '');
  v_type text := nullif(p->>'card_type', '');
  v_ok boolean := coalesce((p->>'approved')::boolean, false);
begin
  select * into v_row from public.pelham_terminal_transactions
   where id = nullif(p->>'id', '')::bigint for update;
  if v_row.id is null then
    perform public.pelham_fail('404', 'Terminal transaction not found.');
  end if;
  if v_row.result <> 'pending' then
    return public.pelham_terminal_json(v_row);
  end if;
  if v_last4 is not null and v_last4 !~ '^[0-9]{4}$' then
    v_last4 := null;
  end if;
  if v_type is not null and v_type not in ('credit', 'debit', 'gift', 'ebt') then
    v_type := null;
  end if;

  if not coalesce((p->>'final')::boolean, false) then
    update public.pelham_terminal_transactions
       set payment_intent = coalesce(nullif(p->>'payment_intent', ''), payment_intent),
           reader_id = coalesce(nullif(p->>'reader_id', ''), reader_id),
           updated_at = now()
     where id = v_row.id
    returning * into v_row;
    return public.pelham_terminal_json(v_row);
  end if;

  update public.pelham_terminal_transactions
     set result = left(coalesce(nullif(p->>'result', ''), case when v_ok then 'succeeded' else 'failed' end), 10),
         approved = v_ok,
         payment_intent = coalesce(nullif(p->>'payment_intent', ''), payment_intent),
         auth_code = coalesce(left(nullif(btrim(coalesce(p->>'auth_code', '')), ''), 32), auth_code),
         transaction_id = coalesce(left(nullif(p->>'transaction_id', ''), 40), transaction_id),
         response_code = left(nullif(p->>'response_code', ''), 10),
         host_message = left(nullif(btrim(coalesce(p->>'host_message', '')), ''), 200),
         card_brand = coalesce(left(nullif(p->>'card_brand', ''), 30), card_brand),
         card_last4 = coalesce(v_last4, card_last4),
         card_type = coalesce(v_type, card_type),
         entry_mode = coalesce(left(nullif(p->>'entry_mode', ''), 20), entry_mode),
         tip = greatest(coalesce((p->>'tip')::integer, 0), 0),
         total_amount = greatest(coalesce((p->>'total_amount')::integer, case when v_ok then requested_amount else 0 end), 0),
         updated_at = now()
   where id = v_row.id
  returning * into v_row;

  -- Charge 전에 지운 결제 줄의 환불이 됐다 → 원 승인을 되살리지 않게 표시(0019 의 cancels 와 같다).
  if v_row.kind = 'refund' and v_row.approved and v_row.cancels is not null then
    update public.pelham_terminal_transactions s
       set voided_at = now(), updated_at = now()
     where s.id = v_row.cancels and s.kind = 'sale' and s.approved and s.voided_at is null
       and s.bill_payment_id is null;
  end if;
  return public.pelham_terminal_json(v_row);
end;
$$;

-- 한 줄(service_role): id 또는 PaymentIntent 로. 웹훅이 쓴다. 없으면 null.
create or replace function public.pelham_terminal_find(p jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_row public.pelham_terminal_transactions;
begin
  if nullif(p->>'id', '') is not null then
    select * into v_row from public.pelham_terminal_transactions where id = (p->>'id')::bigint;
  elsif nullif(p->>'payment_intent', '') is not null then
    select * into v_row from public.pelham_terminal_transactions
     where payment_intent = p->>'payment_intent' and kind = 'sale';
  end if;
  if v_row.id is null then
    return null;
  end if;
  return public.pelham_terminal_json(v_row);
end;
$$;

-- 아직 결과를 모르는 거래(service_role). 웹훅을 놓쳤을 때 FastAPI 가 정리한다.
create or replace function public.pelham_terminal_pending_refunds(p_refund_of bigint)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(public.pelham_terminal_json(t) order by t.id), '[]'::jsonb)
    from public.pelham_terminal_transactions t
   where t.refund_of = p_refund_of and t.result = 'pending'
$$;

-- ===== 결제 (0019 와 같고, 결제 줄에 남는 단말기 이름만 Stripe) ===========

create or replace function public.pelham_staff_bill_pay(p_bill bigint, p jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_bill public.pelham_bills;
  v_checkout uuid;
  v_payments jsonb := coalesce(p->'payments', '[]'::jsonb);
  pay jsonb;
  v_method text;
  v_amount integer;
  v_sum integer := 0;
  v_tips integer := 0;
  l record;
  v_doc jsonb;
  v_player jsonb;
  v_players jsonb;
  v_now text := public.pelham_iso(now());
  v_date date := public.pelham_pos_today();
  v_no integer;
  v_receipt text;
  v_booking text;
  v_names text[];
  v_stock integer;
  v_active boolean;
  -- 0011: 레인체크 결제.
  v_rc public.pelham_rain_checks;
  v_rc_codes text[] := '{}';
  v_rc_ids bigint[] := '{}';
  v_code text;
  -- 0019: 단말기 연동 결제.
  v_txn public.pelham_terminal_transactions;
  v_txn_ids bigint[] := '{}';
  v_txn_id bigint;
  v_pay_id bigint;
begin
  perform public.pelham_require_staff();
  p := coalesce(p, '{}'::jsonb);

  begin
    v_checkout := nullif(p->>'checkout_id', '')::uuid;
  exception when others then
    perform public.pelham_fail('422', 'checkout_id must be a UUID.');
  end;
  if v_checkout is null then
    perform public.pelham_fail('422', 'checkout_id is required (one per Charge press).');
  end if;

  -- 계산서를 먼저 잠그고 나서 멱등 키를 본다. 거꾸로 하면 동시에 온 재시도 두 개 중
  -- 뒤의 것이 "이미 결제됨" 오류를 받는다 — 돈은 받았는데 계산대에 빨간 오류가 뜬다.
  select * into v_bill from public.pelham_bills where id = p_bill for update;
  if v_bill.id is null then
    perform public.pelham_fail('404', 'Bill not found');
  end if;
  -- 같은 결제가 두 번 왔다(응답이 끊겨 화면이 다시 보냄). 첫 결과를 그대로 돌려준다.
  if v_bill.checkout_id = v_checkout then
    return public.pelham_pos_bill_json(v_bill.id);
  end if;
  if exists (select 1 from public.pelham_bills where checkout_id = v_checkout and id <> p_bill) then
    perform public.pelham_fail('409', 'This checkout_id belongs to another bill.');
  end if;

  v_bill := public.pelham_pos_lock_open(p_bill);
  if not exists (select 1 from public.pelham_bill_lines where bill_id = p_bill and active) then
    perform public.pelham_fail('422', 'The bill is empty.');
  end if;

  -- 1) 그린피 줄: 예약마다 잠그고, 플레이어가 아직 낼 수 있는 상태인지 본다.
  for v_booking in
    select distinct li.booking_id from public.pelham_bill_lines li
     where li.bill_id = p_bill and li.kind = 'tee_player' and li.active
     order by 1
  loop
    select t.doc into v_doc from public.pelham_tee_bookings t where t.id = v_booking;
    if v_doc is null then
      perform public.pelham_fail('409', 'A reservation on this bill no longer exists. Remove its line.');
    end if;
    perform public.pelham_tee_lock((v_doc->>'date')::date, v_doc->>'time');
    select t.doc into v_doc from public.pelham_tee_bookings t where t.id = v_booking for update;
    for l in select * from public.pelham_bill_lines li
              where li.bill_id = p_bill and li.booking_id = v_booking and li.kind = 'tee_player' and li.active loop
      v_player := public.pelham_pos_find_player(v_doc, l.player_id);
      if v_player is null then
        perform public.pelham_fail('409', format('%s was removed from the reservation. Remove the line.', l.name));
      end if;
      if coalesce((v_player->>'cancelled')::boolean, false) then
        perform public.pelham_fail('409', format('%s is cancelled. Remove the line.', l.name));
      end if;
      if coalesce((v_player->>'paid')::boolean, false) then
        perform public.pelham_fail('409', format('%s was already marked paid on the tee sheet. Remove the line.', l.name));
      end if;
    end loop;
  end loop;

  perform public.pelham_pos_recalc(p_bill);
  select * into v_bill from public.pelham_bills where id = p_bill;

  -- 2) 결제 검증. 합이 계산서 합계와 같아야 한다(거스름돈은 화면이 계산한다).
  if jsonb_typeof(v_payments) <> 'array' then
    perform public.pelham_fail('422', 'payments must be a list.');
  end if;
  for pay in select value from jsonb_array_elements(v_payments) loop
    v_method := pay->>'method';
    if v_method is null or v_method not in ('cash', 'card', 'debit', 'member_account', 'gift_card', 'rain_check') then
      perform public.pelham_fail('422', format('''%s'' is not a payment method', coalesce(v_method, '')));
    end if;
    v_amount := coalesce((pay->>'amount')::integer, 0);
    if v_amount <= 0 then
      perform public.pelham_fail('422', 'Each payment needs an amount above zero (cents).');
    end if;
    if coalesce((pay->>'tip')::integer, 0) < 0 then
      perform public.pelham_fail('422', 'Tip cannot be negative.');
    end if;
    -- 0019: 단말기가 승인한 줄. 기록을 잠그고 금액·팁·수단이 단말기 결과와 같은지 본다.
    if nullif(pay->>'terminal_txn', '') is not null then
      if v_method not in ('card', 'debit') then
        perform public.pelham_fail('422', 'Only card and debit payments come from the terminal.');
      end if;
      begin
        v_txn_id := (pay->>'terminal_txn')::bigint;
      exception when others then
        perform public.pelham_fail('422', 'terminal_txn must be a number.');
      end;
      if v_txn_id = any(v_txn_ids) then
        perform public.pelham_fail('422', 'The same terminal approval is on this payment twice.');
      end if;
      select * into v_txn from public.pelham_terminal_transactions where id = v_txn_id for update;
      if v_txn.id is null or v_txn.kind <> 'sale' then
        perform public.pelham_fail('404', 'Terminal approval not found.');
      end if;
      if not v_txn.approved then
        perform public.pelham_fail('409', 'That terminal transaction was not approved.');
      end if;
      if v_txn.voided_at is not null then
        perform public.pelham_fail('409', 'That terminal approval was voided. Remove the payment.');
      end if;
      if v_txn.bill_payment_id is not null then
        perform public.pelham_fail('409', 'That terminal approval is already used on another payment.');
      end if;
      if v_txn.bill_id is distinct from p_bill then
        perform public.pelham_fail('409', 'That terminal approval belongs to another bill.');
      end if;
      if v_txn.requested_amount <> v_amount or v_txn.tip <> coalesce((pay->>'tip')::integer, 0) then
        perform public.pelham_fail('422', format('The terminal approved %s + tip %s (cents), not %s + %s.',
                                                 v_txn.requested_amount, v_txn.tip, v_amount,
                                                 coalesce((pay->>'tip')::integer, 0)));
      end if;
      if (v_txn.card_type = 'debit' and v_method <> 'debit') or (v_txn.card_type = 'credit' and v_method <> 'card') then
        perform public.pelham_fail('422', format('The terminal ran this as %s, not %s.', v_txn.card_type, v_method));
      end if;
      v_txn_ids := v_txn_ids || v_txn_id;
    elsif v_method in ('card', 'debit') and length(btrim(coalesce(pay->>'auth_code', ''))) = 0 then
      perform public.pelham_fail('422',
        'Card and debit payments need the approval code printed by the card terminal.');
    end if;
    if nullif(pay->>'card_last4', '') is not null and (pay->>'card_last4') !~ '^[0-9]{4}$' then
      perform public.pelham_fail('422', 'Card last 4 must be four digits.');
    end if;
    -- 0011: 레인체크는 코드로 잠그고 상태·만료일(매장 현지 날짜)·금액을 본다. 팁은 받지 않는다.
    if v_method = 'rain_check' then
      v_code := upper(btrim(coalesce(pay->>'rain_check_code', '')));
      if v_code = '' then
        perform public.pelham_fail('422', 'A rain check payment needs the code printed on the rain check.');
      end if;
      if v_code = any(v_rc_codes) then
        perform public.pelham_fail('422', format('Rain check %s is on this payment twice.', v_code));
      end if;
      select * into v_rc from public.pelham_rain_checks where code = v_code for update;
      if v_rc.id is null then
        perform public.pelham_fail('404', format('No rain check %s', v_code));
      end if;
      if v_rc.status <> 'issued' then
        perform public.pelham_fail('409', format('Rain check %s is already %s.', v_code, v_rc.status));
      end if;
      if v_rc.expires_on < v_date then
        perform public.pelham_fail('409', format('Rain check %s expired on %s.', v_code, to_char(v_rc.expires_on, 'YYYY-MM-DD')));
      end if;
      if v_amount > v_rc.amount then
        perform public.pelham_fail('422', format('Rain check %s is worth %s cents, not %s.', v_code, v_rc.amount, v_amount));
      end if;
      if coalesce((pay->>'tip')::integer, 0) > 0 then
        perform public.pelham_fail('422', 'Tips cannot be paid with a rain check.');
      end if;
      v_rc_codes := v_rc_codes || v_code;
      v_rc_ids := v_rc_ids || v_rc.id;
    end if;
    v_sum := v_sum + v_amount;
    v_tips := v_tips + coalesce((pay->>'tip')::integer, 0);
  end loop;
  if v_sum <> v_bill.total then
    perform public.pelham_fail('422', format('Payments add up to %s but the bill total is %s (cents).',
                                             v_sum, v_bill.total));
  end if;

  -- 3) 재고. 상품 id 순으로 잠가 두 계산대가 서로를 기다리다 멈추지 않게 한다.
  for l in
    select li.product_id, sum(li.quantity)::integer as qty, min(li.name) as name
      from public.pelham_bill_lines li
     where li.bill_id = p_bill and li.kind = 'product' and li.active
     group by li.product_id order by li.product_id
  loop
    select p2.stock, p2.is_active into v_stock, v_active
      from public.pelham_retail_products p2 where p2.id = l.product_id for update;
    if not v_active then
      perform public.pelham_fail('409', format('%s is no longer for sale. Remove the line.', l.name));
    end if;
    if v_stock is not null and v_stock < l.qty then
      perform public.pelham_fail('409', format('Not enough stock: %s (need %s, %s on hand).', l.name, l.qty, v_stock));
    end if;
  end loop;

  -- 4) 영수증 번호.
  insert into public.pelham_receipt_counters as c (business_date, last_no) values (v_date, 1)
  on conflict (business_date) do update set last_no = c.last_no + 1
  returning last_no into v_no;
  v_receipt := format('PH-%s-%s', to_char(v_date, 'YYYYMMDD'), lpad(v_no::text, 4, '0'));

  -- 5) 기록. 여기부터는 실패할 이유가 없다.
  for l in
    select li.product_id, sum(li.quantity)::integer as qty
      from public.pelham_bill_lines li
     where li.bill_id = p_bill and li.kind = 'product' and li.active
     group by li.product_id order by li.product_id
  loop
    perform public.pelham_pos_move(l.product_id, -l.qty, 'sale', p_bill, v_receipt);
  end loop;

  for pay in select value from jsonb_array_elements(v_payments) loop
    v_method := pay->>'method';
    v_txn := null;
    if nullif(pay->>'terminal_txn', '') is not null then
      select * into v_txn from public.pelham_terminal_transactions where id = (pay->>'terminal_txn')::bigint;
    end if;
    insert into public.pelham_bill_payments (bill_id, method, amount, tip, entry, auth_code, card_last4, terminal, created_by,
                                             rain_check_id, terminal_txn_id)
    values (p_bill, v_method, (pay->>'amount')::integer, coalesce((pay->>'tip')::integer, 0),
            case when v_txn.id is not null then 'integrated'
                 when v_method in ('card', 'debit') then 'keyed' else 'none' end,
            case when v_txn.id is not null then v_txn.auth_code
                 else nullif(btrim(coalesce(pay->>'auth_code', '')), '') end,
            case when v_txn.id is not null then v_txn.card_last4 else nullif(pay->>'card_last4', '') end,
            case when v_txn.id is not null then 'Stripe Terminal'
                 when v_method in ('card', 'debit') then 'Card terminal' end,
            auth.uid(),
            -- 0011
            case when v_method = 'rain_check' then
              (select r.id from public.pelham_rain_checks r
                where r.code = upper(btrim(coalesce(pay->>'rain_check_code', '')))) end,
            v_txn.id)
    returning id into v_pay_id;
    -- 0019: 승인 하나는 결제 줄 하나에만 묶인다.
    if v_txn.id is not null then
      update public.pelham_terminal_transactions set bill_payment_id = v_pay_id where id = v_txn.id;
    end if;
  end loop;

  -- 0011: 쓴 레인체크를 이 계산서에 묶는다.
  update public.pelham_rain_checks
     set status = 'redeemed', redeemed_bill_id = p_bill, redeemed_at = now()
   where id = any(v_rc_ids);

  update public.pelham_bills
     set status = 'paid', checkout_id = v_checkout, receipt_no = v_receipt, business_date = v_date,
         tip = v_tips, paid_at = now()
   where id = p_bill;

  -- 티 시트: 계산서에 담긴 사람만 paid. 결제 시각은 서버가 찍는다(0004 와 같다).
  for v_booking in
    select distinct li.booking_id from public.pelham_bill_lines li
     where li.bill_id = p_bill and li.kind = 'tee_player' and li.active
  loop
    select t.doc into v_doc from public.pelham_tee_bookings t where t.id = v_booking;
    select coalesce(jsonb_agg(
             case when exists (select 1 from public.pelham_bill_lines li
                                where li.bill_id = p_bill and li.booking_id = v_booking
                                  and li.player_id = e.value->>'id' and li.kind = 'tee_player' and li.active)
                  then e.value || jsonb_build_object('paid', true, 'paidAt', v_now)
                  else e.value end
             order by e.ord), '[]'::jsonb)
      into v_players
      from jsonb_array_elements(coalesce(v_doc->'players', '[]'::jsonb)) with ordinality as e(value, ord);
    select array_agg(li.name order by li.id) into v_names
      from public.pelham_bill_lines li
     where li.bill_id = p_bill and li.booking_id = v_booking and li.kind = 'tee_player' and li.active;
    v_doc := jsonb_set(v_doc, '{players}', v_players);
    v_doc := public.pelham_tee_audit(v_doc,
               format('Paid on bill %s: %s.', v_receipt, array_to_string(v_names, ', ')), v_now);
    perform public.pelham_tee_save(v_doc);
  end loop;

  return public.pelham_pos_bill_json(p_bill);
end;
$$;

-- ===== 권한 ============================================================
-- 다시 정의한 함수(`pelham_op_*`, `pelham_online_pay_complete`, `pelham_staff_bill_pay`)는
-- `create or replace` 라 0019·0020 의 권한이 그대로다.

revoke all on function public.pelham_online_pay_session(text, text) from public, anon, authenticated;
grant execute on function public.pelham_online_pay_session(text, text) to service_role;

-- 브라우저가 단말기 결과를 써 넣던 길을 닫는다. 이제 결과는 Stripe 에 확인한 FastAPI 만 쓴다.
revoke all on function public.pelham_staff_terminal_record(jsonb) from public, anon, authenticated;

revoke all on function public.pelham_staff_terminal_begin(jsonb) from public, anon, authenticated;
revoke all on function public.pelham_staff_terminal_get(bigint) from public, anon, authenticated;
revoke all on function public.pelham_staff_terminal_in_flight(bigint) from public, anon, authenticated;
revoke all on function public.pelham_terminal_settle(jsonb) from public, anon, authenticated;
revoke all on function public.pelham_terminal_find(jsonb) from public, anon, authenticated;
revoke all on function public.pelham_terminal_pending_refunds(bigint) from public, anon, authenticated;

grant execute on function public.pelham_staff_terminal_begin(jsonb) to authenticated;
grant execute on function public.pelham_staff_terminal_get(bigint) to authenticated;
grant execute on function public.pelham_staff_terminal_in_flight(bigint) to authenticated;
grant execute on function public.pelham_terminal_settle(jsonb) to service_role;
grant execute on function public.pelham_terminal_find(jsonb) to service_role;
grant execute on function public.pelham_terminal_pending_refunds(bigint) to service_role;

notify pgrst, 'reload schema';
