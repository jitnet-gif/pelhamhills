-- 온라인 결제(Authorize.net Accept Hosted): 손님이 예약 사이트에서 티타임·실내 골프 요금을 미리 낸다.
--
-- 결정(2026-10-09)
-- - **선택 결제.** 예약은 지금처럼 바로 확정된다. 확정 화면과 `/book/lookup` 에 "Pay now" 가 생기고,
--   안 내면 지금처럼 프로 샵에서 낸다.
-- - 티타임과 실내 골프 둘 다. 티타임은 **예약 전체**(취소 안 된 플레이어 모두)를 한 번에 낸다.
-- - 온라인으로 낸 예약을 손님이 마감(시작 24시간 전) 전에 취소하면 **자동 전액 환불**.
-- - 비밀 키는 Fly 의 FastAPI(`backend/api/routes/payments.py`)에만 있다. 이 파일의 함수는 전부
--   **service_role 전용**이다 — 브라우저(anon)는 부를 수 없고, FastAPI 가 부른다(0016 과 같은 방식).
--
-- 흐름
--   1) 손님이 Pay now → FastAPI `/payments/online/checkout` → `pelham_online_pay_start` 가 금액을 정하고
--      `pending` 한 줄(invoice `PHW` + 16진수 12자)을 남긴다 → FastAPI 가 Authorize.net 에서 결제 폼 토큰을
--      받고 → 브라우저가 Authorize.net 결제 폼으로 간다. **카드 번호는 우리 서버·DB 를 지나지 않는다.**
--   2) 승인 결과는 두 길로 온다: Authorize.net 웹훅, 그리고 돌아온 화면의 상태 확인(미정산 거래 목록에서
--      invoice 로 찾는다). 어느 쪽이든 FastAPI 가 거래 상세를 **Authorize.net 에 다시 물어** 확인한 값으로
--      `pelham_online_pay_complete` 를 부른다. 두 번 와도 한 번만 기록된다.
--   3) complete 는 한 트랜잭션에서: 금액·예약 상태를 다시 보고 → 계산서(station `online`)를 만들고 →
--      결제 줄(card, entry `online`, Authorize.net 승인번호) → 계산서 paid → 티타임 플레이어 paid /
--      실내 골프 예약 paid(0008 트리거). 계산서로 받는다는 원칙(0005·0008)을 그대로 따른다.
--   4) 그 사이 예약이 취소됐거나, 프로 샵에서 먼저 받았거나, 금액이 바뀌었으면 기록하지 않고 `orphaned`
--      로 둔다 → FastAPI 가 그 거래를 곧바로 void/refund 한다 → `pelham_online_refund_finish`.
--   5) 취소 환불: `pelham_online_refund_begin`(본인 확인·마감 확인, 진행 표시) → FastAPI 가 Authorize.net 에서
--      void(정산 전) 또는 refund(정산 후) → `pelham_online_refund_finish`(계산서 환불 + 예약 취소).
--      카드사 쪽이 실패하면 `pelham_online_refund_abort` 로 되돌리고 손님에게 전화 안내.
--   6) 직원이 Authorize.net 관리 화면에서 직접 환불·void 하면 웹훅이 와서 같은 finish 를 부른다
--      (예약은 취소하지 않고 계산서만 환불, 플레이어는 미결제로).
--
-- 계산서 보호: 온라인으로 받은 계산서를 POS 의 Refund 로 닫으면 장부만 환불되고 카드에는 돈이 안 돌아간다.
-- 그래서 그 길은 막는다 — 온라인 결제가 Authorize.net 에서 환불·void 된 뒤에만 계산서가 refunded 가 된다.
--
-- 저장하는 것: 거래 ID, 승인번호, 카드 브랜드, 끝 4자리. 카드 번호·유효기간은 받지도 않는다.
--
-- 규칙은 0005 와 같다: `pelham_` 접두사, 테이블 RLS 켜고 정책 없음, 금액은 센트, 세금은 계산서에 한 번,
-- 오류는 PTxxx. 전제: 0005, 0007, 0008, 0012. (0011·0019 와는 독립이다.)
-- 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다.

-- ===== 먼저 확인 ======================================================
do $$
declare
  v_missing text[] := '{}';
  v_name text;
begin
  foreach v_name in array array['pelham_fail', 'pelham_iso', 'pelham_local_now', 'pelham_pos_today',
                                 'pelham_pos_tax', 'pelham_pos_tee_price', 'pelham_pos_tee_line_name',
                                 'pelham_pos_find_player', 'pelham_pos_recalc', 'pelham_pos_sim_line_name',
                                 'pelham_pos_sim_time', 'pelham_tee_lock', 'pelham_tee_audit', 'pelham_tee_save',
                                 'pelham_tee_apply_status', 'pelham_tee_minutes', 'pelham_tee_guest_row',
                                 'pelham_sim_guest_row', 'pelham_guest_deadline'] loop
    if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                    where n.nspname = 'public' and p.proname = v_name) then
      v_missing := v_missing || (v_name || '()');
    end if;
  end loop;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'pelham_bill_lines'
                    and column_name = 'sim_reservation_id') then
    v_missing := v_missing || 'pelham_bill_lines.sim_reservation_id'::text;
  end if;
  if cardinality(v_missing) > 0 then
    raise exception '0020 needs 0005, 0008 and 0012 first. Missing: %', array_to_string(v_missing, ', ');
  end if;
end;
$$;

-- ===== 테이블 ==========================================================

-- 결제 시도 하나 = 한 줄. Authorize.net 의 invoiceNumber 가 이 줄의 invoice 다.
create table if not exists public.pelham_online_payments (
  id                 bigint generated always as identity primary key,
  invoice            text not null unique check (invoice ~ '^PHW[0-9A-F]{12}$'),
  kind               text not null check (kind in ('tee', 'sim')),
  booking_id         text,
  sim_reservation_id bigint references public.pelham_sim_reservations (id),
  confirmation_code  text not null,
  customer_name      text,
  customer_email     text,
  description        text not null,
  -- 시작할 때 정한 금액(센트). 승인 금액이 이것과 다르면 기록하지 않는다.
  subtotal           integer not null check (subtotal >= 0),
  tax                integer not null check (tax >= 0),
  amount             integer not null check (amount > 0),
  -- pending: 결제 폼으로 보냄 / approved: 계산서에 기록됨 / declined·error·held: 카드사 응답
  -- orphaned: 승인됐지만 기록할 수 없어 되돌려야 함 / voided·refunded: 카드에 돌려줌
  status             text not null default 'pending'
                     check (status in ('pending', 'approved', 'declined', 'error', 'held',
                                       'orphaned', 'voided', 'refunded')),
  response_code      text,
  response_text      text check (response_text is null or length(response_text) <= 300),
  trans_id           text check (trans_id is null or trans_id ~ '^[0-9]{1,20}$'),
  auth_code          text check (auth_code is null or length(auth_code) <= 12),
  card_brand         text check (card_brand is null or length(card_brand) <= 30),
  card_last4         text check (card_last4 is null or card_last4 ~ '^[0-9]{4}$'),
  bill_id            bigint unique references public.pelham_bills (id),
  refund_kind        text check (refund_kind is null or refund_kind in ('void', 'refund')),
  refund_trans_id    text check (refund_trans_id is null or refund_trans_id ~ '^[0-9]{1,20}$'),
  refund_reason      text,
  -- 환불을 시작했다(카드사 호출 중). 같은 예약을 두 번 환불하지 않게.
  refund_started_at  timestamptz,
  created_at         timestamptz not null default now(),
  approved_at        timestamptz,
  refunded_at        timestamptz,
  updated_at         timestamptz not null default now(),
  check ((kind = 'tee') = (booking_id is not null)),
  check ((kind = 'sim') = (sim_reservation_id is not null)),
  check ((status = 'approved') <= (bill_id is not null))
);
create unique index if not exists pelham_online_payments_trans_idx
  on public.pelham_online_payments (trans_id) where trans_id is not null;
create index if not exists pelham_online_payments_booking_idx
  on public.pelham_online_payments (booking_id) where booking_id is not null;
create index if not exists pelham_online_payments_sim_idx
  on public.pelham_online_payments (sim_reservation_id) where sim_reservation_id is not null;

alter table public.pelham_online_payments enable row level security;
revoke all on public.pelham_online_payments from anon, authenticated;

-- 계산서 station `online`, 결제 entry `online`. 이름 없는 check 는 정의로 찾아 바꾼다(0008·0011 과 같은 방식).
do $$
declare
  c record;
begin
  for c in
    select conname from pg_constraint
     where conrelid = 'public.pelham_bills'::regclass and contype = 'c'
       and pg_get_constraintdef(oid) like '%station = ANY%'
  loop
    execute format('alter table public.pelham_bills drop constraint %I', c.conname);
  end loop;
  alter table public.pelham_bills add constraint pelham_bills_station_check
    check (station in ('pro_shop', 'snack_bar', 'tee_sheet', 'simulator', 'online'));

  for c in
    select conname from pg_constraint
     where conrelid = 'public.pelham_bill_payments'::regclass and contype = 'c'
       and pg_get_constraintdef(oid) like '%entry = ANY%'
  loop
    execute format('alter table public.pelham_bill_payments drop constraint %I', c.conname);
  end loop;
  alter table public.pelham_bill_payments add constraint pelham_bill_payments_entry_check
    check (entry in ('keyed', 'integrated', 'none', 'online'));
end;
$$;

-- ===== 헬퍼 (실행 권한을 아무에게도 주지 않는다) ========================

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

-- 티타임 한 건을 지금 온라인으로 낼 수 있는가, 낸다면 얼마인가.
-- {payable, reason, lines:[{name, amount}], subtotal, tax, total}
-- 예약 전체를 한 번에 낸다: 이미 낸 사람이 있거나 프로 샵이 계산서를 시작했으면 온라인 결제는 닫는다
-- (나눠 받으면 취소·환불이 꼬인다). 카트는 온라인 예약에서 플레이어에 붙지 않으므로(0012) 그린피만이다.
create or replace function public.pelham_op_tee_quote(t public.pelham_tee_bookings)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_lines jsonb := '[]'::jsonb;
  v_subtotal integer := 0;
  v_price integer;
  pl jsonb;
  v_reason text;
  v_minutes integer := public.pelham_tee_minutes(t.tee_time);
begin
  for pl in select e from jsonb_array_elements(coalesce(t.doc->'players', '[]'::jsonb)) e loop
    if coalesce((pl->>'cancelled')::boolean, false) then
      continue;
    end if;
    v_price := public.pelham_pos_tee_price(t.doc, pl);
    v_subtotal := v_subtotal + v_price;
    v_lines := v_lines || jsonb_build_object('name', public.pelham_pos_tee_line_name(t.doc, pl), 'amount', v_price);
  end loop;

  v_reason := case
    when coalesce(t.status, '') <> 'reserved' then
      format('This booking is %s.', replace(coalesce(t.status, ''), '_', ' '))
    when coalesce(t.source, '') = 'voice_hold' then
      'This booking is still being confirmed by the pro shop.'
    when v_minutes is null then
      'This booking has no tee time on the sheet.'
    when public.pelham_local_now() >= t.booking_date + make_interval(mins => v_minutes) then
      'This tee time has already started.'
    when exists (select 1 from jsonb_array_elements(coalesce(t.doc->'players', '[]'::jsonb)) e
                  where coalesce((e->>'paid')::boolean, false)) then
      'This booking has already been paid.'
    when exists (select 1 from public.pelham_bill_lines li
                  where li.booking_id = t.id and li.kind = 'tee_player' and li.active) then
      'The pro shop has already started a bill for this booking. Please pay at the pro shop.'
    when jsonb_array_length(v_lines) = 0 then
      'Nobody is left on this booking.'
    when v_subtotal <= 0 then
      'There is nothing to pay online for this booking.'
  end;

  return jsonb_build_object(
    'payable', v_reason is null,
    'reason', v_reason,
    'lines', v_lines,
    'subtotal', v_subtotal,
    'tax', public.pelham_pos_tax(v_subtotal),
    'total', v_subtotal + public.pelham_pos_tax(v_subtotal)
  );
end;
$$;

create or replace function public.pelham_op_sim_quote(r public.pelham_sim_reservations)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_price integer := round(coalesce(r.total_price, 0) * 100)::integer;
  v_reason text;
begin
  v_reason := case
    when r.status <> 'confirmed' then
      format('This booking is %s.', replace(r.status, '_', ' '))
    when public.pelham_local_now() >= r.booking_date + make_interval(mins => r.start_minutes) then
      'This booking has already started.'
    when exists (select 1 from public.pelham_bill_lines li
                  where li.sim_reservation_id = r.id and li.kind = 'sim_booking' and li.active) then
      'The front desk has already started a bill for this booking. Please pay at the club.'
    when v_price <= 0 then
      'There is nothing to pay online for this booking.'
  end;
  return jsonb_build_object(
    'payable', v_reason is null,
    'reason', v_reason,
    'lines', jsonb_build_array(jsonb_build_object('name', public.pelham_pos_sim_line_name(r), 'amount', v_price)),
    'subtotal', v_price,
    'tax', public.pelham_pos_tax(v_price),
    'total', v_price + public.pelham_pos_tax(v_price)
  );
end;
$$;

-- 이 예약에 붙은 온라인 결제 중 살아 있는 것(승인됨). 없으면 가장 최근 시도.
create or replace function public.pelham_op_latest(p_kind text, p_booking text, p_sim bigint)
returns public.pelham_online_payments
language sql
stable
set search_path = ''
as $$
  select o.*
    from public.pelham_online_payments o
   where o.kind = p_kind
     and ((p_kind = 'tee' and o.booking_id = p_booking) or (p_kind = 'sim' and o.sim_reservation_id = p_sim))
   order by (o.status = 'approved') desc, o.created_at desc
   limit 1
$$;

-- 온라인으로 낸 예약을 손님이 지금 취소(=자동 환불)할 수 있는가. 할 수 있으면 null.
create or replace function public.pelham_op_cancel_block(o public.pelham_online_payments)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  t public.pelham_tee_bookings;
  r public.pelham_sim_reservations;
  v_bill public.pelham_bills;
begin
  if o.id is null or o.status <> 'approved' then
    return 'This booking was not paid online.';
  end if;
  if o.refund_started_at is not null and o.refund_started_at > now() - interval '10 minutes' then
    return 'A refund for this booking is already in progress.';
  end if;
  select * into v_bill from public.pelham_bills where id = o.bill_id;
  if v_bill.status is distinct from 'paid' then
    return 'This payment has already been refunded at the club.';
  end if;
  if o.kind = 'tee' then
    select * into t from public.pelham_tee_bookings where id = o.booking_id;
    if t.id is null or coalesce(t.status, '') <> 'reserved' then
      return format('This booking is %s, so it can no longer be cancelled online.',
                    replace(coalesce(t.status, 'gone'), '_', ' '));
    end if;
    if public.pelham_local_now()
       > public.pelham_guest_deadline(t.booking_date, public.pelham_tee_minutes(t.tee_time)) then
      return 'Online cancellations close 24 hours before your tee time.';
    end if;
    -- 온라인 계산서 밖에서 받은 플레이어(프로 샵에서 카트 등)가 있으면 직원이 정리해야 한다.
    if exists (select 1 from public.pelham_bill_lines li join public.pelham_bills b on b.id = li.bill_id
                where li.booking_id = t.id and li.active and b.id <> o.bill_id and b.status in ('open', 'paid')) then
      return 'The pro shop has added charges to this booking.';
    end if;
  else
    select * into r from public.pelham_sim_reservations where id = o.sim_reservation_id;
    if r.id is null or r.status <> 'paid' then
      return format('This booking is %s, so it can no longer be cancelled online.',
                    replace(coalesce(r.status, 'gone'), '_', ' '));
    end if;
    if public.pelham_local_now() > public.pelham_guest_deadline(r.booking_date, r.start_minutes) then
      return 'Online cancellations close 24 hours before your start time.';
    end if;
  end if;
  return null;
end;
$$;

-- 결제된 온라인 계산서를 환불 상태로. `pelham_staff_bill_refund`(0005)에서 직원 확인을 뺀 것과 같다
-- (온라인 계산서에는 상품 줄이 없다). 실내 골프 예약은 0008 트리거가 checked_in 으로 돌린다.
create or replace function public.pelham_op_refund_bill(p_bill bigint, p_reason text)
returns void
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_bill public.pelham_bills;
  v_booking text;
  v_doc jsonb;
  v_players jsonb;
  v_now text := public.pelham_iso(now());
  v_ids text[];
begin
  select * into v_bill from public.pelham_bills where id = p_bill for update;
  if v_bill.id is null or v_bill.status <> 'paid' then
    return;
  end if;
  select coalesce(array_agg(distinct li.booking_id), '{}') into v_ids
    from public.pelham_bill_lines li where li.bill_id = p_bill and li.kind = 'tee_player' and li.active;
  update public.pelham_bills
     set status = 'refunded', refunded_at = now(), refund_reason = p_reason
   where id = p_bill;

  foreach v_booking in array v_ids loop
    select t.doc into v_doc from public.pelham_tee_bookings t where t.id = v_booking;
    if v_doc is null then
      continue;
    end if;
    perform public.pelham_tee_lock((v_doc->>'date')::date, v_doc->>'time');
    select t.doc into v_doc from public.pelham_tee_bookings t where t.id = v_booking for update;
    select coalesce(jsonb_agg(
             case when exists (select 1 from public.pelham_bill_lines li
                                where li.bill_id = p_bill and li.booking_id = v_booking
                                  and li.player_id = e.value->>'id' and li.kind = 'tee_player' and li.active)
                  then e.value || jsonb_build_object('paid', false, 'paidAt', null)
                  else e.value end
             order by e.ord), '[]'::jsonb)
      into v_players
      from jsonb_array_elements(coalesce(v_doc->'players', '[]'::jsonb)) with ordinality as e(value, ord);
    update public.pelham_bill_lines set active = false
     where bill_id = p_bill and booking_id = v_booking and kind = 'tee_player';
    v_doc := jsonb_set(v_doc, '{players}', v_players);
    v_doc := public.pelham_tee_audit(v_doc, format('Refunded online bill %s: %s.', v_bill.receipt_no, p_reason), v_now);
    perform public.pelham_tee_save(v_doc);
  end loop;

  update public.pelham_bill_lines set active = false where bill_id = p_bill;
end;
$$;

-- 승인된 거래를 계산서로 기록한다. 기록할 수 없으면 PT409 로 멈춘다(부르는 쪽이 orphaned 로 바꾼다).
-- 반환: 새 계산서 id.
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
          format('Paid online · Authorize.net %s · invoice %s', o.trans_id, o.invoice))
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
          p_last4, left('Authorize.net' || coalesce(' · ' || nullif(btrim(p_brand), ''), ''), 60));

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
               format('Paid online (Authorize.net %s) on bill %s: %s.', o.trans_id, v_receipt,
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

-- ===== 서버 함수 (service_role 전용) ====================================

-- 손님 화면이 보여 줄 것: 낼 수 있는지, 얼마인지, 이미 낸 결제, 온라인 취소(=환불) 가능 여부.
-- 코드 + 이메일로 본인 확인(0012 와 같은 함수). 못 찾으면 404.
create or replace function public.pelham_online_pay_quote(p_code text, p_email text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  s public.pelham_sim_reservations := public.pelham_sim_guest_row(p_code, p_email);
  t public.pelham_tee_bookings;
  o public.pelham_online_payments;
  v_quote jsonb;
  v_head jsonb;
  c jsonb;
begin
  if s.id is not null then
    v_quote := public.pelham_op_sim_quote(s);
    o := public.pelham_op_latest('sim', null, s.id);
    v_head := jsonb_build_object(
      'kind', 'sim', 'confirmation_code', s.confirmation_code,
      'date', to_char(s.booking_date, 'YYYY-MM-DD'),
      'time', public.pelham_pos_sim_time(s.start_minutes),
      'description', format('Indoor golf %s, %s, %sh', to_char(s.booking_date, 'Mon DD'),
                            public.pelham_pos_sim_time(s.start_minutes), s.duration_hours),
      'customer_name', s.customer_name, 'email', s.customer_email);
  else
    t := public.pelham_tee_guest_row(p_code, p_email);
    if t.id is null then
      perform public.pelham_fail('404', 'We could not find a booking with that confirmation code and email.');
    end if;
    v_quote := public.pelham_op_tee_quote(t);
    o := public.pelham_op_latest('tee', t.id, null);
    c := t.doc->'players'->public.pelham_tee_contact_index(t.doc);
    v_head := jsonb_build_object(
      'kind', 'tee', 'confirmation_code', t.confirmation_code,
      'date', to_char(t.booking_date, 'YYYY-MM-DD'),
      'time', t.tee_time,
      'description', format('Tee time %s, %s, %s players', to_char(t.booking_date, 'Mon DD'), t.tee_time,
                            jsonb_array_length(v_quote->'lines')),
      'customer_name', btrim(coalesce(c->>'firstName', '') || ' ' || coalesce(c->>'lastName', '')),
      'email', c->>'email');
  end if;

  return v_head || v_quote || jsonb_build_object(
    'payment', case when o.id is null then null else public.pelham_op_json(o) end,
    'cancel_refund', case when o.id is not null and o.status = 'approved'
                          then jsonb_build_object('allowed', public.pelham_op_cancel_block(o) is null,
                                                  'reason', public.pelham_op_cancel_block(o))
                     end);
end;
$$;

-- 결제 시작: 금액을 정하고 pending 한 줄. 반환값으로 FastAPI 가 결제 폼 토큰을 받는다.
create or replace function public.pelham_online_pay_start(p_code text, p_email text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  q jsonb := public.pelham_online_pay_quote(p_code, p_email);
  s public.pelham_sim_reservations;
  t public.pelham_tee_bookings;
  o public.pelham_online_payments;
  v_invoice text;
begin
  if not (q->>'payable')::boolean then
    perform public.pelham_fail('409', q->>'reason');
  end if;
  if q->>'kind' = 'sim' then
    s := public.pelham_sim_guest_row(p_code, p_email);
  else
    t := public.pelham_tee_guest_row(p_code, p_email);
  end if;
  loop
    v_invoice := 'PHW' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12));
    exit when not exists (select 1 from public.pelham_online_payments where invoice = v_invoice);
  end loop;
  insert into public.pelham_online_payments
    (invoice, kind, booking_id, sim_reservation_id, confirmation_code, customer_name, customer_email,
     description, subtotal, tax, amount)
  values
    (v_invoice, q->>'kind', t.id, s.id, q->>'confirmation_code', nullif(btrim(q->>'customer_name'), ''),
     nullif(btrim(q->>'email'), ''), q->>'description', (q->>'subtotal')::integer, (q->>'tax')::integer,
     (q->>'total')::integer)
  returning * into o;
  return public.pelham_op_json(o) || jsonb_build_object(
    'customer_name', o.customer_name, 'email', o.customer_email, 'lines', q->'lines');
end;
$$;

-- Authorize.net 이 돌려준(FastAPI 가 거래 상세로 다시 확인한) 결과를 기록한다. 몇 번 와도 같다.
-- p: {invoice, trans_id, response_code ('1' 승인 / '2' 거절 / '3' 오류 / '4' 보류), auth_code, amount(센트),
--     card_brand, card_last4, response_text}
-- 반환: pelham_op_json + {needs_reversal: 이 거래를 카드에 돌려줘야 하는가, reversal_trans_id}
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
  if v_trans is null or v_trans !~ '^[0-9]{1,20}$' then
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

-- invoice 또는 Authorize.net 거래 ID 로 한 줄. 돌아온 화면의 상태 확인·웹훅이 쓴다. 없으면 null.
create or replace function public.pelham_online_payment(p jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  o public.pelham_online_payments;
begin
  if nullif(p->>'invoice', '') is not null then
    select * into o from public.pelham_online_payments where invoice = upper(btrim(p->>'invoice'));
  elsif nullif(p->>'trans_id', '') is not null then
    select * into o from public.pelham_online_payments
     where trans_id = btrim(p->>'trans_id') or refund_trans_id = btrim(p->>'trans_id')
     limit 1;
  end if;
  if o.id is null then
    return null;
  end if;
  return public.pelham_op_json(o) || jsonb_build_object('amount_cents', o.amount, 'status_since', public.pelham_iso(o.updated_at));
end;
$$;

-- 손님 취소 환불 시작. 본인 확인 → 취소 가능 확인 → "환불 중" 표시. 반환값으로 FastAPI 가 카드사에 환불한다.
-- 온라인 결제가 없는 예약이면 404 — 화면은 원래 취소(0012)를 쓴다.
create or replace function public.pelham_online_refund_begin(p_code text, p_email text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  s public.pelham_sim_reservations := public.pelham_sim_guest_row(p_code, p_email);
  t public.pelham_tee_bookings;
  o public.pelham_online_payments;
  v_block text;
begin
  if s.id is not null then
    o := public.pelham_op_latest('sim', null, s.id);
  else
    t := public.pelham_tee_guest_row(p_code, p_email);
    if t.id is null then
      perform public.pelham_fail('404', 'We could not find a booking with that confirmation code and email.');
    end if;
    o := public.pelham_op_latest('tee', t.id, null);
  end if;
  if o.id is null or o.status <> 'approved' then
    perform public.pelham_fail('404', 'This booking was not paid online.');
  end if;
  select * into o from public.pelham_online_payments where id = o.id for update;
  v_block := public.pelham_op_cancel_block(o);
  if v_block is not null then
    perform public.pelham_fail('409', v_block || ' Please call the pro shop.');
  end if;
  update public.pelham_online_payments set refund_started_at = now(), updated_at = now()
   where id = o.id
  returning * into o;
  return public.pelham_op_json(o) || jsonb_build_object('amount_cents', o.amount);
end;
$$;

-- 카드사에서 void/refund 가 끝났다 → 기록. p: {invoice | trans_id(원거래), refund_kind, refund_trans_id,
-- cancel_booking (true = 손님 취소), reason}. 몇 번 와도 같다.
create or replace function public.pelham_online_refund_finish(p jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  o public.pelham_online_payments;
  v_kind text := coalesce(nullif(p->>'refund_kind', ''), 'refund');
  v_reason text := coalesce(nullif(btrim(p->>'reason'), ''), 'Refunded online');
  v_cancel boolean := coalesce((p->>'cancel_booking')::boolean, false);
  t public.pelham_tee_bookings;
  r public.pelham_sim_reservations;
  v_res jsonb;
  v_doc jsonb;
  v_now text := public.pelham_iso(now());
begin
  if v_kind not in ('void', 'refund') then
    perform public.pelham_fail('422', 'refund_kind must be void or refund.');
  end if;
  if nullif(p->>'invoice', '') is not null then
    select * into o from public.pelham_online_payments where invoice = upper(btrim(p->>'invoice')) for update;
  else
    select * into o from public.pelham_online_payments where trans_id = btrim(coalesce(p->>'trans_id', '')) for update;
  end if;
  if o.id is null then
    perform public.pelham_fail('404', 'No online payment found.');
  end if;
  if o.status not in ('approved', 'orphaned', 'voided', 'refunded') then
    perform public.pelham_fail('409', format('This online payment is %s; there is nothing to refund.', o.status));
  end if;

  if o.status in ('approved', 'orphaned') then
    update public.pelham_online_payments
       set status = case v_kind when 'void' then 'voided' else 'refunded' end,
           refund_kind = v_kind,
           refund_trans_id = nullif(btrim(coalesce(p->>'refund_trans_id', '')), ''),
           refund_reason = v_reason, refunded_at = now(), refund_started_at = null, updated_at = now()
     where id = o.id
    returning * into o;
  end if;

  -- 아래 계산서 환불은 위에서 상태를 바꾼 뒤라 보호 트리거(pelham_op_guard_bill)를 통과한다.
  if o.bill_id is not null then
    perform public.pelham_op_refund_bill(o.bill_id, v_reason);
  end if;

  if v_cancel then
    if o.kind = 'tee' then
      select * into t from public.pelham_tee_bookings where id = o.booking_id;
      if t.id is not null and coalesce(t.status, '') = 'reserved' then
        perform public.pelham_tee_lock(t.booking_date, t.tee_time);
        select * into t from public.pelham_tee_bookings where id = o.booking_id for update;
        v_res := public.pelham_tee_apply_status(t.doc, 'cancelled',
                   'Cancelled online by the guest (card refunded).', v_now);
        v_doc := public.pelham_tee_audit(v_res->'doc', v_res->>'message', v_now);
        perform public.pelham_tee_save(v_doc);
      end if;
    else
      select * into r from public.pelham_sim_reservations where id = o.sim_reservation_id;
      if r.id is not null and r.status <> 'cancelled' then
        perform pg_advisory_xact_lock(hashtext('pelham_sim:' || r.booking_date::text));
        update public.pelham_sim_reservations
           set status = 'cancelled',
               notes = btrim(coalesce(notes, '') || E'\n' || format('[%s] Cancelled online by guest (card refunded).',
                             to_char(public.pelham_local_now(), 'YYYY-MM-DD HH24:MI'))),
               updated_at = now()
         where id = r.id;
      end if;
    end if;
  end if;

  return public.pelham_op_json(o);
end;
$$;

-- 카드사 환불이 실패했다. "환불 중" 표시를 지운다(손님은 전화 안내를 받는다).
create or replace function public.pelham_online_refund_abort(p_invoice text, p_message text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  o public.pelham_online_payments;
begin
  update public.pelham_online_payments
     set refund_started_at = null,
         response_text = left('Refund failed: ' || coalesce(p_message, ''), 300),
         updated_at = now()
   where invoice = upper(btrim(coalesce(p_invoice, ''))) and status = 'approved'
  returning * into o;
  if o.id is null then
    return null;
  end if;
  return public.pelham_op_json(o);
end;
$$;

-- ===== 트리거 ==========================================================

-- 온라인 계산서를 POS 의 Refund 로 닫지 못하게 한다. 장부만 환불되고 카드에는 돈이 안 돌아간다.
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
      'This bill was paid online. Refund or void it in Authorize.net — the bill updates itself.');
  end if;
  return new;
end;
$$;

drop trigger if exists pelham_op_guard_bill on public.pelham_bills;
create trigger pelham_op_guard_bill
  before update of status on public.pelham_bills
  for each row execute function public.pelham_op_guard_bill();

-- ===== 권한 ============================================================

revoke all on function public.pelham_op_json(public.pelham_online_payments) from public, anon, authenticated;
revoke all on function public.pelham_op_tee_quote(public.pelham_tee_bookings) from public, anon, authenticated;
revoke all on function public.pelham_op_sim_quote(public.pelham_sim_reservations) from public, anon, authenticated;
revoke all on function public.pelham_op_latest(text, text, bigint) from public, anon, authenticated;
revoke all on function public.pelham_op_cancel_block(public.pelham_online_payments) from public, anon, authenticated;
revoke all on function public.pelham_op_refund_bill(bigint, text) from public, anon, authenticated;
revoke all on function public.pelham_op_attach(public.pelham_online_payments, text, text, text) from public, anon, authenticated;
revoke all on function public.pelham_op_guard_bill() from public, anon, authenticated;

revoke all on function public.pelham_online_pay_quote(text, text) from public, anon, authenticated;
revoke all on function public.pelham_online_pay_start(text, text) from public, anon, authenticated;
revoke all on function public.pelham_online_pay_complete(jsonb) from public, anon, authenticated;
revoke all on function public.pelham_online_payment(jsonb) from public, anon, authenticated;
revoke all on function public.pelham_online_refund_begin(text, text) from public, anon, authenticated;
revoke all on function public.pelham_online_refund_finish(jsonb) from public, anon, authenticated;
revoke all on function public.pelham_online_refund_abort(text, text) from public, anon, authenticated;

grant execute on function public.pelham_online_pay_quote(text, text) to service_role;
grant execute on function public.pelham_online_pay_start(text, text) to service_role;
grant execute on function public.pelham_online_pay_complete(jsonb) to service_role;
grant execute on function public.pelham_online_payment(jsonb) to service_role;
grant execute on function public.pelham_online_refund_begin(text, text) to service_role;
grant execute on function public.pelham_online_refund_finish(jsonb) to service_role;
grant execute on function public.pelham_online_refund_abort(text, text) to service_role;

notify pgrst, 'reload schema';
