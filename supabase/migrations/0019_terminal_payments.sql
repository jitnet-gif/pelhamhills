-- 카드 단말기 연동: J.P. Morgan Payment Terminal Application(PTA, 반통합 semi-integrated).
--
-- 왜(2026-10-09): 지금까지는 직원이 DX8000 에 금액을 손으로 치고 전표의 승인번호를 앱에 옮겨
-- 적었다(`entry = 'keyed'`). 이제 계산대 브라우저가 매장 LAN 의 단말기(`wss://<단말기 IP>:8443`)에
-- 직접 금액을 보내고, 단말기가 돌려준 승인 결과를 그대로 기록한다(`entry = 'integrated'`).
-- 단말기와의 통신은 브라우저가 한다(`frontend/lib/pos/terminal.ts`). 서버는 단말기에 닿지 않는다.
--
-- 흐름
--   1) 결제 줄을 더할 때 브라우저가 단말기로 SALE 을 보낸다. 손님이 카드를 대고 승인이 나면
--      브라우저가 **곧바로** 그 결과를 `pelham_staff_terminal_record` 로 남긴다 — 아직 Charge 전이다.
--      브라우저가 꺼져도 돈 받은 기록이 사라지지 않게 하려는 것이다.
--   2) 화면을 다시 열면 `pelham_staff_terminal_pending` 이 "승인됐는데 아직 계산서에 안 쓰인" 줄을
--      돌려주고, 화면이 그 줄을 결제 줄로 되살린다.
--   3) Charge 때 결제 줄은 `terminal_txn`(이 표의 id)을 들고 온다. `pelham_staff_bill_pay` 가 그 줄을
--      잠그고 금액·팁·수단이 단말기 결과와 같은지 본 뒤 결제와 같은 트랜잭션에서 묶는다.
--   4) Charge 전에 결제 줄을 지우면 화면이 단말기에서 VOID 하고 `voided` 로 남긴다.
--
-- 저장하는 것: 승인번호·거래 ID·배치 번호·카드 브랜드·끝 4자리·입력 방식. 카드 토큰, 전표 원문,
-- EMV 태그는 저장하지 않는다(화면이 보내지도 않는다).
--
-- 전제: 0005, 0011(0011 이 다시 정의한 `pelham_staff_bill_pay` 를 이 파일이 한 번 더 정의한다).
-- 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다.

-- ===== 먼저 확인 ======================================================
do $$
declare
  v_missing text[] := '{}';
  v_name text;
begin
  foreach v_name in array array['pelham_fail', 'pelham_iso', 'pelham_require_staff', 'pelham_pos_today',
                                 'pelham_pos_lock_open', 'pelham_pos_recalc', 'pelham_pos_move',
                                 'pelham_pos_find_player', 'pelham_tee_audit', 'pelham_tee_save', 'pelham_tee_lock',
                                 'pelham_pos_bill_json', 'pelham_staff_bill_pay', 'pelham_rc_json'] loop
    if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                    where n.nspname = 'public' and p.proname = v_name) then
      v_missing := v_missing || (v_name || '()');
    end if;
  end loop;
  if to_regclass('public.pelham_rain_checks') is null then
    v_missing := v_missing || 'pelham_rain_checks'::text;
  end if;
  if cardinality(v_missing) > 0 then
    raise exception '0019 needs 0005 and 0011 first. Missing: %', array_to_string(v_missing, ', ');
  end if;
end;
$$;

-- ===== 테이블 ==========================================================

-- 단말기에 보낸 거래 하나 = 한 줄. 승인·거절 모두 남긴다(거절은 대사용, 계산서에 쓰이지 않는다).
create table if not exists public.pelham_terminal_transactions (
  id                 bigint generated always as identity primary key,
  -- 화면이 매긴 POS 참조번호(영숫자 12자, 단말기 배치 안에서 유일). 단말기 전표의 RRN 자리에 찍힌다.
  reference          text not null check (reference ~ '^[A-Z0-9]{1,12}$'),
  kind               text not null check (kind in ('sale', 'void', 'refund')),
  bill_id            bigint references public.pelham_bills (id),
  -- 단말기 응답. 금액은 센트.
  result             text not null,
  approved           boolean not null default false,
  requested_amount   integer not null default 0 check (requested_amount >= 0),
  tip                integer not null default 0 check (tip >= 0),
  total_amount       integer not null default 0 check (total_amount >= 0),
  auth_code          text check (auth_code is null or length(auth_code) <= 32),
  original_auth_code text check (original_auth_code is null or length(original_auth_code) <= 32),
  transaction_id     text check (transaction_id is null or length(transaction_id) <= 40),
  batch_number       text check (batch_number is null or length(batch_number) <= 20),
  response_code      text check (response_code is null or length(response_code) <= 10),
  host_message       text check (host_message is null or length(host_message) <= 200),
  card_brand         text check (card_brand is null or length(card_brand) <= 30),
  card_last4         text check (card_last4 is null or card_last4 ~ '^[0-9]{4}$'),
  -- cardTypeProcessed: 1 credit, 2 debit, 3 gift, 4 EBT.
  card_type          text check (card_type is null or card_type in ('credit', 'debit', 'gift', 'ebt')),
  entry_mode         text check (entry_mode is null or length(entry_mode) <= 20),
  terminal_id        text check (terminal_id is null or length(terminal_id) <= 20),
  -- Charge 에서 쓰인 결제 줄. 하나의 승인은 한 번만 쓰인다.
  bill_payment_id    bigint unique,
  -- Charge 전에 단말기에서 VOID 한 승인.
  voided_at          timestamptz,
  created_by         uuid,
  created_at         timestamptz not null default now(),
  unique (reference, kind)
);

create index if not exists pelham_terminal_transactions_bill_idx
  on public.pelham_terminal_transactions (bill_id) where bill_id is not null;

alter table public.pelham_terminal_transactions enable row level security;
revoke all on public.pelham_terminal_transactions from anon, authenticated;

alter table public.pelham_bill_payments
  add column if not exists terminal_txn_id bigint references public.pelham_terminal_transactions (id);

-- ===== 함수 ============================================================

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
    'approved', t.approved,
    'requested_amount', t.requested_amount,
    'tip', t.tip,
    'total_amount', t.total_amount,
    'auth_code', t.auth_code,
    'original_auth_code', t.original_auth_code,
    'transaction_id', t.transaction_id,
    'batch_number', t.batch_number,
    'card_brand', t.card_brand,
    'card_last4', t.card_last4,
    'card_type', t.card_type,
    'entry_mode', t.entry_mode,
    'used', t.bill_payment_id is not null,
    'voided_at', public.pelham_iso(t.voided_at),
    'created_at', public.pelham_iso(t.created_at)
  )
$$;

-- 단말기 결과 한 건을 남긴다. 같은 (reference, kind) 가 다시 오면(재시도) 처음 것을 그대로 돌려준다.
-- p.cancels = 이 VOID·REFUND 가 무르는 SALE 의 id(Charge 전에 지운 결제 줄).
create or replace function public.pelham_staff_terminal_record(p jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_row public.pelham_terminal_transactions;
  v_ref text := upper(btrim(coalesce(p->>'reference', '')));
  v_kind text := coalesce(p->>'kind', '');
  v_bill bigint := nullif(p->>'bill_id', '')::bigint;
  v_last4 text := nullif(p->>'card_last4', '');
  v_type text := nullif(p->>'card_type', '');
begin
  perform public.pelham_require_staff();
  if v_ref !~ '^[A-Z0-9]{1,12}$' then
    perform public.pelham_fail('422', 'reference must be 1-12 letters or digits.');
  end if;
  if v_kind not in ('sale', 'void', 'refund') then
    perform public.pelham_fail('422', 'kind must be sale, void or refund.');
  end if;
  if v_bill is not null and not exists (select 1 from public.pelham_bills where id = v_bill) then
    perform public.pelham_fail('404', 'Bill not found');
  end if;
  if v_last4 is not null and v_last4 !~ '^[0-9]{4}$' then
    v_last4 := null;
  end if;
  if v_type is not null and v_type not in ('credit', 'debit', 'gift', 'ebt') then
    v_type := null;
  end if;

  insert into public.pelham_terminal_transactions
    (reference, kind, bill_id, result, approved, requested_amount, tip, total_amount, auth_code, original_auth_code,
     transaction_id, batch_number, response_code, host_message, card_brand, card_last4, card_type, entry_mode,
     terminal_id, created_by)
  values
    (v_ref, v_kind, v_bill, left(coalesce(p->>'result', ''), 10), coalesce((p->>'approved')::boolean, false),
     greatest(coalesce((p->>'requested_amount')::integer, 0), 0), greatest(coalesce((p->>'tip')::integer, 0), 0),
     greatest(coalesce((p->>'total_amount')::integer, 0), 0),
     left(nullif(btrim(coalesce(p->>'auth_code', '')), ''), 32),
     left(nullif(btrim(coalesce(p->>'original_auth_code', '')), ''), 32),
     left(nullif(p->>'transaction_id', ''), 40), left(nullif(p->>'batch_number', ''), 20),
     left(nullif(p->>'response_code', ''), 10), left(nullif(btrim(coalesce(p->>'host_message', '')), ''), 200),
     left(nullif(p->>'card_brand', ''), 30), v_last4, v_type, left(nullif(p->>'entry_mode', ''), 20),
     left(nullif(p->>'terminal_id', ''), 20), auth.uid())
  on conflict (reference, kind) do nothing
  returning * into v_row;

  if v_row.id is null then
    select * into v_row from public.pelham_terminal_transactions where reference = v_ref and kind = v_kind;
    return public.pelham_terminal_json(v_row);
  end if;

  -- Charge 전에 지운 결제 줄: 그 SALE 을 VOID(신용) 또는 REFUND(체크카드) 했다. 승인됐으면 되살리지 않게 표시한다.
  -- 이미 계산서에 쓰인 승인은 건드리지 않는다(그때는 계산서 환불이 따로 기록한다).
  if v_kind in ('void', 'refund') and v_row.approved and nullif(p->>'cancels', '') is not null then
    update public.pelham_terminal_transactions s
       set voided_at = now()
     where s.id = (p->>'cancels')::bigint
       and s.kind = 'sale' and s.approved and s.voided_at is null and s.bill_payment_id is null
       and s.bill_id is not distinct from v_row.bill_id;
  end if;

  return public.pelham_terminal_json(v_row);
end;
$$;

-- 이 계산서에서 승인됐지만 아직 Charge 에 쓰이지 않고 VOID 되지도 않은 SALE. 화면이 결제 줄로 되살린다.
create or replace function public.pelham_staff_terminal_pending(p_bill bigint)
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
     where t.bill_id = p_bill and t.kind = 'sale' and t.approved
       and t.bill_payment_id is null and t.voided_at is null
  ), '[]'::jsonb);
end;
$$;

-- 한 계산서에 걸린 단말기 거래 전부(환불 화면이 VOID·REFUND 했는지 본다).
create or replace function public.pelham_staff_terminal_for_bill(p_bill bigint)
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
     where t.bill_id = p_bill
  ), '[]'::jsonb);
end;
$$;

-- ===== 결제 (0011 의 정의에 단말기 연동을 더했다) =====================

-- 결제. 한 트랜잭션 안에서: 금액 재계산 → 결제 검증 → 재고 차감 → 티 시트 paid → 영수증 번호.
-- p: {checkout_id, payments: [{method, amount, tip?, auth_code?, card_last4?, rain_check_code?, terminal_txn?}]}
-- 0019: terminal_txn = `pelham_terminal_transactions.id`. 있으면 승인번호·끝 4자리는 단말기 기록에서 읽는다.
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
        'Card and debit payments need the approval code printed by the Chase terminal.');
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
            case when v_txn.id is not null then 'DX8000 (J.P. Morgan PTA)'
                 when v_method in ('card', 'debit') then 'Chase DX8000' end,
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
-- 다시 정의한 `pelham_staff_bill_pay` 는 `create or replace` 라 권한이 그대로다.

revoke all on function public.pelham_terminal_json(public.pelham_terminal_transactions) from public, anon, authenticated;
revoke all on function public.pelham_staff_terminal_record(jsonb) from public, anon, authenticated;
revoke all on function public.pelham_staff_terminal_pending(bigint) from public, anon, authenticated;
revoke all on function public.pelham_staff_terminal_for_bill(bigint) from public, anon, authenticated;

grant execute on function public.pelham_staff_terminal_record(jsonb) to authenticated;
grant execute on function public.pelham_staff_terminal_pending(bigint) to authenticated;
grant execute on function public.pelham_staff_terminal_for_bill(bigint) to authenticated;

notify pgrst, 'reload schema';
