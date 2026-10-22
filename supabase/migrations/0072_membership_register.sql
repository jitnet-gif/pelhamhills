-- 회원권을 레지스터에서 판다 — Lightspeed 의 Customer → Subscriptions → Sell → Register 와 같은 흐름.
--
-- 왜(2026-10-22): 고객 파일에서 회원권을 넣어도 돈은 따로 받아 Memberships 화면에 손으로 적어야 했다.
-- Lightspeed 처럼 고객 파일에서 회원권을 고르면 레지스터 계산서에 한 줄로 올라가고, 결제하면
-- 회원권이 납부(active)로 바뀐다.
--
-- 바뀌는 것
-- 1. 계산서 줄 종류 `membership`, 줄에 `membership_id`. SKU 'MEMBERSHIP', 분류 'Memberships'.
-- 2. `pelham_staff_bill_add_membership(bill, p)` — p: {customer_ref, season, membership_type, plan,
--    cart_package, expires_on}. 그 시즌 회원권을 만들거나(pending) 고치고, 남은 금액을 줄로 담는다.
-- 3. 트리거 `pelham_pos_membership_on_bill` — 결제되면 amount_paid 에 더하고 다 냈으면 active,
--    환불되면 뺀다(0008 의 베이 예약 트리거와 같은 모양).
-- 4. `pelham_staff_bill_line_update` 를 다시 정의한다: 회원권 줄도 수량 0/1 만.
-- 5. 신용카드 3%(신청서 규칙, 0042). 단말기는 서버 결제보다 **먼저** 카드를 긁으므로 수수료는 결제 전에
--    줄 가격에 들어 있어야 한다. 그래서 줄을 담을 때(또는 레지스터 줄의 버튼으로) 정한다:
--    SKU 'MEMBERSHIP' = 수수료 없음, 'MEMBERSHIP-CC' = 남은 금액 × 1.03. 결제 수단이 맞지 않으면
--    레지스터 화면이 단말기로 보내기 전에 막고, 트리거가 한 번 더 막는다. 수수료는 결제될 때
--    amount_due 에 더한다(환불하면 뺀다) — 담기만 하고 안 낸 회원권의 금액은 그대로다.
--    `pelham_staff_bill_membership_card_fee(bill, line, on)` 이 줄의 수수료를 켜고 끈다.
-- 6. 회원권 시작일 `pelham_memberships.starts_on`(비우면 없음). 판매 창과 고객 편집 폼에서 넣는다.
--    `pelham_staff_customers` · `pelham_staff_customer_save`(0070)를 시작일만 더해 다시 정의한다.
--
-- 세금: 요금표(`pelham_membership_price`, 0042)는 HST 포함 금액이다. 계산서는 줄 합계에 13% 를 얹으므로
-- 줄 가격은 남은 금액 ÷ 1.13 (Weekday Single $2,316.50 → $2,050.00 + HST $266.50, Lightspeed 와 같다).
-- 카드 수수료 줄은 남은 금액 × 1.03 ÷ 1.13.
--
-- 전제: 0038, 0070 (0071 과는 상관없다). 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다.

do $$
begin
  if to_regprocedure('public.pelham_staff_bill_add_open_item(bigint, jsonb)') is null then
    raise exception '0072 needs 0038 first (pelham_staff_bill_add_open_item is missing).';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'pelham_memberships' and column_name = 'expires_on') then
    raise exception '0072 needs 0069 first (pelham_memberships.expires_on is missing).';
  end if;
end;
$$;

-- ===== 테이블 ==========================================================

alter table public.pelham_memberships add column if not exists starts_on date;

alter table public.pelham_bill_lines
  add column if not exists membership_id uuid references public.pelham_memberships (id);

-- 0038 과 같은 방법으로 줄 종류 check 를 찾아 바꾼다.
do $$
declare
  c record;
begin
  for c in
    select conname from pg_constraint
     where conrelid = 'public.pelham_bill_lines'::regclass and contype = 'c'
       and pg_get_constraintdef(oid) like '%kind = ANY%'
  loop
    execute format('alter table public.pelham_bill_lines drop constraint %I', c.conname);
  end loop;
  alter table public.pelham_bill_lines add constraint pelham_bill_lines_kind_check
    check (kind in ('product', 'tee_player', 'sim_booking', 'open_item', 'membership'));

  if not exists (select 1 from pg_constraint where conname = 'pelham_bill_lines_membership_check') then
    alter table public.pelham_bill_lines add constraint pelham_bill_lines_membership_check
      check ((kind = 'membership') = (membership_id is not null));
  end if;
end;
$$;

-- 한 계산서에 같은 회원권은 한 줄.
create unique index if not exists pelham_bill_lines_membership_once
  on public.pelham_bill_lines (bill_id, membership_id) where kind = 'membership';

-- ===== 직원 함수 =======================================================

-- 회원권 줄의 세전 가격(센트): 남은 금액(HST 포함) ÷ 1.13, 카드면 × 1.03 먼저. 0 이하면 null.
create or replace function public.pelham_pos_membership_line_price(p_membership uuid, p_card boolean)
returns integer
language sql
stable
set search_path = ''
as $$
  select case when m.amount_due - m.amount_paid > 0
              then round((m.amount_due - m.amount_paid) * (case when p_card then 1.03 else 1 end) * 100 / 1.13)::integer
         end
    from public.pelham_memberships m
   where m.id = p_membership
$$;

create or replace function public.pelham_staff_bill_add_membership(p_bill bigint, p jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_ref text := nullif(btrim(coalesce(p->>'customer_ref', '')), '');
  v_type text := nullif(btrim(coalesce(p->>'membership_type', '')), '');
  v_plan text := coalesce(nullif(btrim(coalesce(p->>'plan', '')), ''), 'single');
  v_cart text := nullif(btrim(coalesce(p->>'cart_package', '')), '');
  v_season integer;
  v_expires date;
  v_starts date;
  v_card boolean := coalesce(p->>'card_fee', '') = 'true';
  v_c public.pelham_customers;
  v_row public.pelham_memberships;
  v_name text;
  v_price integer;
  v_label text;
begin
  perform public.pelham_require_staff();
  perform public.pelham_pos_lock_open(p_bill);
  p := coalesce(p, '{}'::jsonb);

  select * into v_c from public.pelham_customers c where c.customer_ref = v_ref;
  if v_c.customer_ref is null then
    perform public.pelham_fail('404', format('Customer %s was not found.', coalesce(v_ref, '')));
  end if;
  if coalesce(p->>'season', '') !~ '^\d{4}$' then
    perform public.pelham_fail('422', 'Pick a membership season.');
  end if;
  v_season := (p->>'season')::integer;
  if v_type is null or v_type not in ('full', 'weekday', 'intermediate', 'nine_hole', 'twilight', 'junior') then
    perform public.pelham_fail('422', 'Pick a membership.');
  end if;
  if v_plan not in ('single', 'spousal') then
    perform public.pelham_fail('422', format('''%s'' is not a plan.', v_plan));
  end if;
  if v_type in ('intermediate', 'junior') then
    v_plan := 'single';
  end if;
  if v_cart is not null and v_cart not in ('unlimited_7day', 'unlimited_weekday') then
    perform public.pelham_fail('422', format('''%s'' is not a cart package.', v_cart));
  end if;
  if coalesce(p->>'expires_on', '') <> '' then
    if p->>'expires_on' !~ '^\d{4}-\d{2}-\d{2}$' then
      perform public.pelham_fail('422', format('''%s'' is not a date.', p->>'expires_on'));
    end if;
    v_expires := (p->>'expires_on')::date;
    if v_expires < public.pelham_local_now()::date then
      perform public.pelham_fail('422', 'The end date is already past.');
    end if;
  end if;
  -- 시작일. 비우면 오늘(클럽 날짜).
  if coalesce(p->>'starts_on', '') <> '' then
    if p->>'starts_on' !~ '^\d{4}-\d{2}-\d{2}$' then
      perform public.pelham_fail('422', format('''%s'' is not a date.', p->>'starts_on'));
    end if;
    v_starts := (p->>'starts_on')::date;
  else
    v_starts := public.pelham_local_now()::date;
  end if;
  if v_expires is not null and v_starts > v_expires then
    perform public.pelham_fail('422', 'The start date is after the end date.');
  end if;

  v_name := coalesce(nullif(btrim(v_c.display_name), ''), btrim(concat_ws(' ', v_c.first_name, v_c.last_name)));

  select * into v_row from public.pelham_memberships m
   where m.customer_ref = v_ref and m.season = v_season
   for update;

  if v_row.id is null then
    insert into public.pelham_memberships (
      season, customer_ref, member_name, phone, email, member_number, address, postal_code,
      membership_type, plan, cart_package, amount_due, status, starts_on, expires_on, source)
    values (
      v_season, v_ref, v_name, v_c.phone, v_c.email, v_c.member_number,
      nullif(concat_ws(', ', v_c.address_line1, v_c.city), ''), v_c.postal_code,
      v_type, v_plan, v_cart,
      coalesce(public.pelham_membership_price(v_type, v_plan, v_cart, false, false), 0),
      'pending', v_starts, v_expires, 'staff')
    returning * into v_row;
  else
    -- 이미 돈을 받은 회원권의 종류를 레지스터에서 바꾸지 않는다(차액 계산은 Memberships 화면에서).
    if v_row.status <> 'cancelled' and v_row.amount_paid > 0
       and (v_row.membership_type is distinct from v_type or v_row.plan is distinct from v_plan
            or v_row.cart_package is distinct from v_cart) then
      perform public.pelham_fail('409', format(
        '%s already paid %s toward a different %s membership. Change it on Memberships.',
        v_name, to_char(v_row.amount_paid, 'FM$999,990.00'), v_season));
    end if;
    update public.pelham_memberships m
       set membership_type = v_type,
           plan = v_plan,
           cart_package = v_cart,
           amount_due = case
                          when m.membership_type is distinct from v_type or m.plan is distinct from v_plan
                            or m.cart_package is distinct from v_cart or m.status = 'cancelled'
                          then coalesce(public.pelham_membership_price(v_type, v_plan, v_cart, m.range_pass, false),
                                        m.amount_due)
                          -- 고객 폼에서 'Credit card' 로 넣어 3% 가 이미 붙은 채 안 낸 회원권: 수수료는 줄이 정한다.
                          when m.amount_paid = 0 and m.payment_method = 'Credit card'
                            and m.amount_due = public.pelham_membership_price(v_type, v_plan, v_cart, m.range_pass, true)
                          then coalesce(public.pelham_membership_price(v_type, v_plan, v_cart, m.range_pass, false),
                                        m.amount_due)
                          else m.amount_due
                        end,
           amount_paid = case when m.status = 'cancelled' then 0 else m.amount_paid end,
           status = case when m.status = 'cancelled' then 'pending' else m.status end,
           starts_on = v_starts,
           expires_on = coalesce(v_expires, m.expires_on),
           updated_at = now()
     where m.id = v_row.id
    returning * into v_row;
  end if;

  v_price := public.pelham_pos_membership_line_price(v_row.id, v_card);
  if v_price is null then
    perform public.pelham_fail('409', format('%s''s %s membership is already paid in full.', v_name, v_season));
  end if;

  v_label := format('%s %s %s Membership%s',
    v_season,
    case v_type when 'full' then 'Full' when 'weekday' then 'Weekday' when 'intermediate' then 'Intermediate'
                when 'nine_hole' then '9 Hole' when 'twilight' then 'Twilight' else 'Junior' end,
    case v_plan when 'spousal' then 'Spousal' else 'Single' end,
    case v_cart when 'unlimited_7day' then ' with 7 Day Cart' when 'unlimited_weekday' then ' with Weekday Cart' else '' end);

  -- 같은 회원권을 다시 담으면 줄을 새로 쓴다(종류를 바꿨을 수 있다).
  delete from public.pelham_bill_lines where bill_id = p_bill and kind = 'membership' and membership_id = v_row.id;
  insert into public.pelham_bill_lines (bill_id, kind, sku, name, category, quantity, unit_price, line_total, membership_id)
  values (p_bill, 'membership', case when v_card then 'MEMBERSHIP-CC' else 'MEMBERSHIP' end, left(format('%s · %s', v_label, v_name), 120), 'Memberships',
          1, v_price, v_price, v_row.id);

  -- 명부의 회원 표시를 맞춘다(0070 customer_save 와 같다). 티시트 검색(0053)이 읽는다.
  update public.pelham_customers c
     set is_member = true,
         player_type = coalesce(public.pelham_membership_rate_plan(v_type, v_cart), c.player_type)
   where c.customer_ref = v_ref
     and v_season >= coalesce((select max(m.season) from public.pelham_memberships m
                                where m.customer_ref = v_ref and m.status <> 'cancelled'), v_season);

  perform public.pelham_pos_recalc(p_bill);
  return public.pelham_pos_bill_json(p_bill);
end;
$$;

-- 레지스터의 회원권 줄에서 신용카드 3% 를 켜고 끈다. 줄 할인은 지운다(가격이 새로 정해진다).
create or replace function public.pelham_staff_bill_membership_card_fee(p_bill bigint, p_line bigint, p_on boolean)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  l public.pelham_bill_lines;
  v_price integer;
begin
  perform public.pelham_require_staff();
  perform public.pelham_pos_lock_open(p_bill);
  select * into l from public.pelham_bill_lines where id = p_line and bill_id = p_bill and kind = 'membership';
  if l.id is null then
    perform public.pelham_fail('404', 'Membership line not found on this bill');
  end if;
  perform 1 from public.pelham_memberships where id = l.membership_id for update;
  v_price := public.pelham_pos_membership_line_price(l.membership_id, coalesce(p_on, false));
  if v_price is null then
    perform public.pelham_fail('409', format('%s is already paid in full. Remove the line.', l.name));
  end if;
  update public.pelham_bill_lines
     set sku = case when p_on then 'MEMBERSHIP-CC' else 'MEMBERSHIP' end,
         unit_price = v_price, discount = 0, line_total = v_price
   where id = l.id;
  perform public.pelham_pos_recalc(p_bill);
  return public.pelham_pos_bill_json(p_bill);
end;
$$;

-- 0008 과 같다 + 회원권 줄도 수량 0/1.
create or replace function public.pelham_staff_bill_line_update(p_bill bigint, p_line bigint, p jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  l public.pelham_bill_lines;
  v_qty integer;
  v_discount integer;
begin
  perform public.pelham_require_staff();
  perform public.pelham_pos_lock_open(p_bill);
  select * into l from public.pelham_bill_lines where id = p_line and bill_id = p_bill;
  if l.id is null then
    perform public.pelham_fail('404', 'Line not found on this bill');
  end if;
  p := coalesce(p, '{}'::jsonb);

  v_qty := coalesce((p->>'quantity')::integer, l.quantity);
  if l.kind = 'tee_player' and v_qty not in (0, 1) then
    perform public.pelham_fail('422', 'A green fee line is one player. Remove it or keep it.');
  end if;
  if l.kind = 'sim_booking' and v_qty not in (0, 1) then
    perform public.pelham_fail('422', 'A simulator line is one reservation. Remove it or keep it.');
  end if;
  if l.kind = 'membership' and v_qty not in (0, 1) then
    perform public.pelham_fail('422', 'A membership line is one membership. Remove it or keep it.');
  end if;
  if v_qty = 0 then
    delete from public.pelham_bill_lines where id = p_line;
  else
    if v_qty < 0 or v_qty > 9999 then
      perform public.pelham_fail('422', 'Quantity must be between 0 and 9999.');
    end if;
    v_discount := coalesce((p->>'discount')::integer, l.discount);
    if v_discount < 0 then
      perform public.pelham_fail('422', 'Discount cannot be negative.');
    end if;
    v_discount := least(v_discount, v_qty * l.unit_price);
    update public.pelham_bill_lines
       set quantity = v_qty, discount = v_discount, line_total = v_qty * unit_price - v_discount
     where id = p_line;
  end if;

  perform public.pelham_pos_recalc(p_bill);
  return public.pelham_pos_bill_json(p_bill);
end;
$$;

-- ===== 트리거 ==========================================================

-- 계산서가 결제되면 회원권에 낸 돈(줄 합계 + 그 줄의 HST)을 더하고, 환불되면 뺀다.
-- 결제 함수의 한 트랜잭션 안에서 돈다 — 여기서 거절하면 결제 전체가 없던 일이 된다.
-- 환불 함수는 줄을 무효로 하기 **전에** 계산서 상태를 바꾸므로(0008 주석) 환불 때도 줄은 active 다.
create or replace function public.pelham_pos_membership_on_bill()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  l record;
  m public.pelham_memberships;
  v_amount numeric;
  v_paid numeric;
  v_due numeric;
  v_fee numeric;
  v_methods text[];
  v_method text;
begin
  if not (old.status = 'open' and new.status = 'paid') and not (old.status = 'paid' and new.status = 'refunded') then
    return null;
  end if;

  select array_agg(distinct pm.method) into v_methods
    from public.pelham_bill_payments pm where pm.bill_id = new.id;
  -- 회원권 화면의 결제 수단 네 가지(0070)에 맞는 것만 적는다. 나머지는 메모에만 남긴다.
  v_method := case when cardinality(v_methods) = 1 then
                case v_methods[1] when 'cash' then 'Cash' when 'card' then 'Credit card' end
              end;

  for l in
    select li.membership_id as id, li.name, li.line_total, li.sku = 'MEMBERSHIP-CC' as card_fee
      from public.pelham_bill_lines li
     where li.bill_id = new.id and li.kind = 'membership' and li.active
     order by li.membership_id
  loop
    select * into m from public.pelham_memberships where id = l.id for update;
    v_amount := (l.line_total + public.pelham_pos_tax(l.line_total)) / 100.0;
    -- 카드 줄의 3%: 낸 돈 중 수수료 몫. 회원권 금액(amount_due)에 그만큼 더한다.
    v_fee := case when l.card_fee then v_amount - round(v_amount / 1.03, 2) else 0 end;

    if new.status = 'paid' then
      if m.status = 'cancelled' then
        perform public.pelham_fail('409', format('%s was cancelled. Remove the line.', l.name));
      end if;
      if m.amount_paid >= m.amount_due then
        perform public.pelham_fail('409', format('%s is already paid in full. Remove the line.', l.name));
      end if;
      -- 결제 수단과 수수료가 맞아야 한다. 레지스터 화면이 먼저 막는다 — 여기는 마지막 확인이다.
      if l.card_fee and (v_methods is null or v_methods <> array['card']) then
        perform public.pelham_fail('422', format(
          '%s includes the 3%% credit card fee. Take it all by credit card, or remove the card fee on the line.', l.name));
      end if;
      if not l.card_fee and 'card' = any(coalesce(v_methods, '{}')) then
        perform public.pelham_fail('422', format(
          'A membership paid by credit card adds 3%%. Add the card fee on %s first.', l.name));
      end if;
      v_due := m.amount_due + v_fee;
      v_paid := m.amount_paid + v_amount;
      -- ÷1.13 반올림으로 생기는 몇 센트는 잔액에 맞춘다.
      if abs(v_due - v_paid) <= 0.05 then
        v_paid := v_due;
      end if;
      update public.pelham_memberships
         set amount_due = v_due,
             amount_paid = v_paid,
             paid_on = public.pelham_local_now()::date,
             payment_method = coalesce(v_method, payment_method),
             status = case when v_paid >= v_due then 'active' else status end,
             notes = concat_ws(E'\n', notes, format('Paid %s at the register%s · %s · %s',
                       to_char(v_amount, 'FM$999,990.00'),
                       case when v_fee > 0 then format(' (incl. %s card fee)', to_char(v_fee, 'FM$999,990.00')) else '' end,
                       new.receipt_no, coalesce(array_to_string(v_methods, ' + '), 'no charge'))),
             updated_at = now()
       where id = m.id;
    else
      v_due := greatest(m.amount_due - v_fee, 0);
      v_paid := greatest(m.amount_paid - v_amount, 0);
      if v_paid <= 0.05 then
        v_paid := 0;
      end if;
      update public.pelham_memberships
         set amount_due = v_due,
             amount_paid = v_paid,
             status = case when status = 'active' and v_paid < v_due then 'pending' else status end,
             notes = concat_ws(E'\n', notes, format('Refunded %s · %s', to_char(v_amount, 'FM$999,990.00'), new.receipt_no)),
             updated_at = now()
       where id = m.id;
    end if;
  end loop;
  return null;
end;
$$;

drop trigger if exists pelham_pos_membership_on_bill on public.pelham_bills;
create trigger pelham_pos_membership_on_bill
  after update of status on public.pelham_bills
  for each row execute function public.pelham_pos_membership_on_bill();

-- ===== 명부 읽기 (0070 + 시작일) ============================================

create or replace function public.pelham_staff_customers()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.pelham_require_staff();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'customer_ref', c.customer_ref,
             'name', coalesce(nullif(btrim(c.display_name), ''), btrim(concat_ws(' ', c.first_name, c.last_name))),
             'first_name', c.first_name,
             'last_name', c.last_name,
             'phone', c.phone,
             'email', c.email,
             'address', concat_ws(', ', nullif(c.address_line1, ''), nullif(c.city, '')),
             'address_line1', c.address_line1,
             'city', c.city,
             'postal_code', c.postal_code,
             'is_member', c.is_member,
             'player_type', c.player_type,
             'member_number', c.member_number,
             'scoring_factor', c.scoring_factor,
             'activation_state', c.activation_state,
             'has_credit_card', c.has_credit_card,
             'rounds', c.rounds_booked_played,
             'user_created_on', c.user_created_on,
             'needs_review', c.needs_review,
             'review_reasons', c.review_reasons,
             'possible_duplicate_of', c.possible_duplicate_of,
             'membership', (
               select jsonb_build_object('id', m.id, 'season', m.season, 'membership_type', m.membership_type,
                                         'plan', m.plan, 'status', m.status, 'cart_package', m.cart_package,
                                         'member_name', m.member_name, 'member_number', m.member_number,
                                         'phone', m.phone, 'email', m.email,
                                         'address', m.address, 'postal_code', m.postal_code,
                                         'amount_due', m.amount_due, 'amount_paid', m.amount_paid,
                                         'starts_on', m.starts_on, 'expires_on', m.expires_on, 'payment_method', m.payment_method,
                                         'expired', coalesce(m.expires_on < public.pelham_local_now()::date, false),
                                         'rate_plan', public.pelham_membership_rate_plan(m.membership_type, m.cart_package))
                 from public.pelham_memberships m
                where m.customer_ref = c.customer_ref and m.status <> 'cancelled'
                order by m.season desc
                limit 1
             )
           ) order by c.rounds_booked_played desc, lower(c.last_name), lower(c.first_name))
      from public.pelham_customers c
  ), '[]'::jsonb);
end;
$$;

-- ===== 추가·수정 (0070 + 시작일) ============================================

create or replace function public.pelham_staff_customer_save(p_ref text, p jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_ref text := nullif(btrim(coalesce(p_ref, '')), '');
  v_first text := nullif(btrim(coalesce(p->>'first_name', '')), '');
  v_last text := nullif(btrim(coalesce(p->>'last_name', '')), '');
  v_phone text := regexp_replace(coalesce(p->>'phone', ''), '\D', '', 'g');
  v_email text := nullif(lower(btrim(coalesce(p->>'email', ''))), '');
  v_address text := nullif(btrim(coalesce(p->>'address_line1', '')), '');
  v_city text := nullif(btrim(coalesce(p->>'city', '')), '');
  v_postal text := nullif(upper(regexp_replace(coalesce(p->>'postal_code', ''), '\s', '', 'g')), '');
  v_number text := nullif(btrim(coalesce(p->>'member_number', '')), '');
  v_reasons text[];
  -- 회원권
  v_has_m boolean := jsonb_typeof(p->'membership') = 'object';
  v_m jsonb := case when jsonb_typeof(p->'membership') = 'object' then p->'membership' else '{}'::jsonb end;
  v_season integer;
  v_type text := nullif(btrim(coalesce(v_m->>'membership_type', '')), '');
  v_plan text := coalesce(nullif(btrim(coalesce(v_m->>'plan', '')), ''), 'single');
  v_cart text := nullif(btrim(coalesce(v_m->>'cart_package', '')), '');
  v_status text := coalesce(nullif(btrim(coalesce(v_m->>'status', '')), ''), 'pending');
  v_expires date;
  v_has_starts boolean := v_m ? 'starts_on';
  v_starts date;
  v_has_method boolean := v_m ? 'payment_method';
  v_method text := nullif(btrim(coalesce(v_m->>'payment_method', '')), '');
  v_name text;
  v_row public.pelham_memberships;
begin
  perform public.pelham_require_staff();
  if p is null or jsonb_typeof(p) <> 'object' then
    perform public.pelham_fail('422', 'Nothing to save.');
  end if;
  if v_ref is not null and not exists (select 1 from public.pelham_customers c where c.customer_ref = v_ref) then
    perform public.pelham_fail('404', format('Customer %s was not found.', v_ref));
  end if;

  if v_first is null and v_last is null then
    perform public.pelham_fail('422', 'Give the customer a first or last name.');
  end if;
  if length(v_phone) = 11 and left(v_phone, 1) = '1' then
    v_phone := substr(v_phone, 2);
  end if;
  if v_phone = '' then
    v_phone := null;
  elsif length(v_phone) <> 10 then
    perform public.pelham_fail('422', 'A phone number has 10 digits.');
  end if;
  if v_email is not null and v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    perform public.pelham_fail('422', format('''%s'' is not an email address.', v_email));
  end if;
  if v_postal is not null then
    if v_postal ~ '^[A-Z]\d[A-Z]\d[A-Z]\d$' then
      v_postal := left(v_postal, 3) || ' ' || right(v_postal, 3);
    elsif v_postal !~ '^\d{5}(-?\d{4})?$' then
      perform public.pelham_fail('422', format('''%s'' is not a postal code.', p->>'postal_code'));
    end if;
  end if;

  if v_has_m then
    if coalesce(v_m->>'season', '') !~ '^\d{4}$' then
      perform public.pelham_fail('422', 'Pick a membership season.');
    end if;
    v_season := (v_m->>'season')::integer;
    if v_type is not null and v_type not in ('full', 'weekday', 'intermediate', 'nine_hole', 'twilight', 'junior') then
      perform public.pelham_fail('422', format('''%s'' is not a membership type.', v_type));
    end if;
    if v_plan not in ('single', 'spousal') then
      perform public.pelham_fail('422', format('''%s'' is not a plan.', v_plan));
    end if;
    if v_cart is not null and v_cart not in ('unlimited_7day', 'unlimited_weekday') then
      perform public.pelham_fail('422', format('''%s'' is not a cart package.', v_cart));
    end if;
    if v_status not in ('pending', 'active') then
      perform public.pelham_fail('422', format('''%s'' is not a membership status.', v_status));
    end if;
    -- 만료일. 빈칸이면 만료일 없음(null).
    if coalesce(v_m->>'expires_on', '') <> '' then
      if v_m->>'expires_on' !~ '^\d{4}-\d{2}-\d{2}$' then
        perform public.pelham_fail('422', format('''%s'' is not a date.', v_m->>'expires_on'));
      end if;
      v_expires := (v_m->>'expires_on')::date;
    end if;
    -- 시작일(0072). 빈칸이면 없음(null). 키가 없으면 그대로 둔다.
    if coalesce(v_m->>'starts_on', '') <> '' then
      if v_m->>'starts_on' !~ '^\d{4}-\d{2}-\d{2}$' then
        perform public.pelham_fail('422', format('''%s'' is not a date.', v_m->>'starts_on'));
      end if;
      v_starts := (v_m->>'starts_on')::date;
    end if;
    if v_starts is not null and v_expires is not null and v_starts > v_expires then
      perform public.pelham_fail('422', 'The start date is after the end date.');
    end if;
    if v_method is not null and v_method not in ('Cheque', 'Credit card', 'E-transfer', 'Cash') then
      perform public.pelham_fail('422', format('''%s'' is not a payment method.', v_method));
    end if;
    -- 개인 전용 회원권(Intermediate·Junior)은 spousal 이 없다.
    if v_type in ('intermediate', 'junior') then
      v_plan := 'single';
    end if;
  end if;

  perform public.pelham_require_manager('customer', coalesce(v_ref, 'new'),
                                        case when v_ref is null then 'adding a customer' else 'editing this customer' end);

  if v_ref is null then
    loop
      v_ref := 'PH' || lpad(nextval('public.pelham_customer_ref_seq')::text, 5, '0');
      exit when not exists (select 1 from public.pelham_customers c where c.customer_ref = v_ref);
    end loop;
    insert into public.pelham_customers (
      customer_ref, first_name, last_name, display_name, email, phone, address_line1, city,
      postal_code, member_number, user_created_on, source, provenance)
    values (
      v_ref, v_first, v_last, btrim(concat_ws(' ', v_first, v_last)), v_email, v_phone, v_address, v_city,
      v_postal, v_number, public.pelham_local_now()::date, 'staff',
      jsonb_build_object('created_by', (select lower(u.email) from auth.users u where u.id = auth.uid())));
  else
    -- 고친 칸의 검토 사유만 지운다. 중복 의심·중복 계정은 남긴다.
    select array(
             select r from unnest(c.review_reasons) r
              where not (r = 'first_name_missing' and v_first is not null)
                and not (r = 'last_name_missing' and v_last is not null)
                and not (r = 'email_unparsed' and v_email is distinct from c.email)
                and not (r = 'phone_unparsed' and v_phone is distinct from c.phone)
                and not (r = 'postal_unparsed' and v_postal is distinct from c.postal_code))
      into v_reasons
      from public.pelham_customers c where c.customer_ref = v_ref;

    update public.pelham_customers c
       set first_name = v_first,
           last_name = v_last,
           display_name = btrim(concat_ws(' ', v_first, v_last)),
           email = v_email,
           phone = v_phone,
           address_line1 = v_address,
           city = v_city,
           postal_code = v_postal,
           member_number = v_number,
           review_reasons = v_reasons,
           needs_review = cardinality(v_reasons) > 0 or cardinality(c.possible_duplicate_of) > 0
     where c.customer_ref = v_ref;
  end if;

  -- ===== 회원권 =====
  if v_has_m then
    v_name := btrim(concat_ws(' ', v_first, v_last));
    select * into v_row from public.pelham_memberships m
     where m.customer_ref = v_ref and m.season = v_season
     for update;

    if v_type is null then
      if v_row.id is not null and v_row.status <> 'cancelled' then
        update public.pelham_memberships set status = 'cancelled', updated_at = now() where id = v_row.id;
      end if;
    elsif v_row.id is null then
      insert into public.pelham_memberships (
        season, customer_ref, member_name, phone, email, member_number, address, postal_code,
        membership_type, plan, cart_package, amount_due, status, starts_on, expires_on, payment_method)
      values (
        v_season, v_ref, v_name, v_phone, v_email, v_number,
        nullif(concat_ws(', ', v_address, v_city), ''), v_postal,
        v_type, v_plan, v_cart,
        coalesce(public.pelham_membership_price(v_type, v_plan, v_cart, false, coalesce(v_method = 'Credit card', false)), 0),
        v_status, v_starts, v_expires, v_method);
    else
      if not v_has_method then
        v_method := v_row.payment_method;
      end if;
      if not v_has_starts then
        v_starts := v_row.starts_on;
      end if;
      update public.pelham_memberships m
         set member_name = v_name,
             phone = v_phone,
             email = v_email,
             member_number = v_number,
             address = coalesce(nullif(concat_ws(', ', v_address, v_city), ''), m.address),
             postal_code = coalesce(v_postal, m.postal_code),
             membership_type = v_type,
             plan = v_plan,
             cart_package = v_cart,
             payment_method = v_method,
             -- 종류·플랜·카트·결제 수단이 바뀌었을 때만 요금표로 다시 센다(직원이 고친 금액을 지키려고).
             amount_due = case
                            when m.membership_type is distinct from v_type or m.plan is distinct from v_plan
                              or m.cart_package is distinct from v_cart or m.status = 'cancelled'
                              or m.payment_method is distinct from v_method
                            then coalesce(public.pelham_membership_price(v_type, v_plan, v_cart, m.range_pass,
                                                                         coalesce(v_method = 'Credit card', false)), m.amount_due)
                            else m.amount_due
                          end,
             status = v_status,
             starts_on = v_starts,
             expires_on = v_expires,
             updated_at = now()
       where m.id = v_row.id;
    end if;

    -- 명부의 회원 표시를 맞춘다. 티시트 검색(0053)은 player_type 을 요금제 이름으로도 읽는다.
    update public.pelham_customers c
       set is_member = exists (select 1 from public.pelham_memberships m
                                where m.customer_ref = c.customer_ref and m.status <> 'cancelled'),
           player_type = coalesce(
             (select public.pelham_membership_rate_plan(m.membership_type, m.cart_package)
                from public.pelham_memberships m
               where m.customer_ref = c.customer_ref and m.status <> 'cancelled'
               order by m.season desc limit 1),
             c.player_type)
     where c.customer_ref = v_ref;
  end if;

  return jsonb_build_object('customer_ref', v_ref);
end;
$$;

-- ===== 권한 ============================================================

revoke all on function public.pelham_staff_bill_add_membership(bigint, jsonb) from public, anon, authenticated;
grant execute on function public.pelham_staff_bill_add_membership(bigint, jsonb) to authenticated;
revoke all on function public.pelham_staff_bill_membership_card_fee(bigint, bigint, boolean) from public, anon, authenticated;
grant execute on function public.pelham_staff_bill_membership_card_fee(bigint, bigint, boolean) to authenticated;
revoke all on function public.pelham_pos_membership_line_price(uuid, boolean) from public, anon, authenticated;
revoke all on function public.pelham_pos_membership_on_bill() from public, anon, authenticated;
revoke all on function public.pelham_staff_customers() from public, anon, authenticated;
revoke all on function public.pelham_staff_customer_save(text, jsonb) from public, anon, authenticated;
grant execute on function public.pelham_staff_customers() to authenticated;
grant execute on function public.pelham_staff_customer_save(text, jsonb) to authenticated;

notify pgrst, 'reload schema';
