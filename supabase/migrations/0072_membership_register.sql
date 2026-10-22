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
--
-- 세금: 요금표(`pelham_membership_price`, 0042)는 HST 포함 금액이다. 계산서는 줄 합계에 13% 를 얹으므로
-- 줄 가격은 남은 금액 ÷ 1.13 (Weekday Single $2,316.50 → $2,050.00 + HST $266.50, Lightspeed 와 같다).
-- 레지스터 판매에는 신용카드 3% 를 붙이지 않는다(결제 수단은 줄을 담은 뒤에 정해진다).
--
-- 전제: 0038, 0070. 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다.

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
  v_c public.pelham_customers;
  v_row public.pelham_memberships;
  v_name text;
  v_balance numeric;
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

  v_name := coalesce(nullif(btrim(v_c.display_name), ''), btrim(concat_ws(' ', v_c.first_name, v_c.last_name)));

  select * into v_row from public.pelham_memberships m
   where m.customer_ref = v_ref and m.season = v_season
   for update;

  if v_row.id is null then
    insert into public.pelham_memberships (
      season, customer_ref, member_name, phone, email, member_number, address, postal_code,
      membership_type, plan, cart_package, amount_due, status, expires_on, source)
    values (
      v_season, v_ref, v_name, v_c.phone, v_c.email, v_c.member_number,
      nullif(concat_ws(', ', v_c.address_line1, v_c.city), ''), v_c.postal_code,
      v_type, v_plan, v_cart,
      coalesce(public.pelham_membership_price(v_type, v_plan, v_cart, false, false), 0),
      'pending', v_expires, 'staff')
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
                          else m.amount_due
                        end,
           amount_paid = case when m.status = 'cancelled' then 0 else m.amount_paid end,
           status = case when m.status = 'cancelled' then 'pending' else m.status end,
           expires_on = coalesce(v_expires, m.expires_on),
           updated_at = now()
     where m.id = v_row.id
    returning * into v_row;
  end if;

  v_balance := v_row.amount_due - v_row.amount_paid;
  if v_balance <= 0 then
    perform public.pelham_fail('409', format('%s''s %s membership is already paid in full.', v_name, v_season));
  end if;
  -- HST 포함 잔액 → 세전 줄 가격(센트).
  v_price := round(v_balance * 100 / 1.13)::integer;

  v_label := format('%s %s %s Membership%s',
    v_season,
    case v_type when 'full' then 'Full' when 'weekday' then 'Weekday' when 'intermediate' then 'Intermediate'
                when 'nine_hole' then '9 Hole' when 'twilight' then 'Twilight' else 'Junior' end,
    case v_plan when 'spousal' then 'Spousal' else 'Single' end,
    case v_cart when 'unlimited_7day' then ' with 7 Day Cart' when 'unlimited_weekday' then ' with Weekday Cart' else '' end);

  -- 같은 회원권을 다시 담으면 줄을 새로 쓴다(종류를 바꿨을 수 있다).
  delete from public.pelham_bill_lines where bill_id = p_bill and kind = 'membership' and membership_id = v_row.id;
  insert into public.pelham_bill_lines (bill_id, kind, sku, name, category, quantity, unit_price, line_total, membership_id)
  values (p_bill, 'membership', 'MEMBERSHIP', left(format('%s · %s', v_label, v_name), 120), 'Memberships',
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
    select li.membership_id as id, li.name, li.line_total
      from public.pelham_bill_lines li
     where li.bill_id = new.id and li.kind = 'membership' and li.active
     order by li.membership_id
  loop
    select * into m from public.pelham_memberships where id = l.id for update;
    v_amount := (l.line_total + public.pelham_pos_tax(l.line_total)) / 100.0;

    if new.status = 'paid' then
      if m.status = 'cancelled' then
        perform public.pelham_fail('409', format('%s was cancelled. Remove the line.', l.name));
      end if;
      if m.amount_paid >= m.amount_due then
        perform public.pelham_fail('409', format('%s is already paid in full. Remove the line.', l.name));
      end if;
      v_paid := m.amount_paid + v_amount;
      -- ÷1.13 반올림으로 생기는 몇 센트는 잔액에 맞춘다.
      if abs(m.amount_due - v_paid) <= 0.05 then
        v_paid := m.amount_due;
      end if;
      update public.pelham_memberships
         set amount_paid = v_paid,
             paid_on = public.pelham_local_now()::date,
             payment_method = coalesce(v_method, payment_method),
             status = case when v_paid >= amount_due then 'active' else status end,
             notes = concat_ws(E'\n', notes, format('Paid %s at the register · %s · %s',
                       to_char(v_amount, 'FM$999,990.00'), new.receipt_no,
                       coalesce(array_to_string(v_methods, ' + '), 'no charge'))),
             updated_at = now()
       where id = m.id;
    else
      v_paid := greatest(m.amount_paid - v_amount, 0);
      if v_paid <= 0.05 then
        v_paid := 0;
      end if;
      update public.pelham_memberships
         set amount_paid = v_paid,
             status = case when status = 'active' and v_paid < amount_due then 'pending' else status end,
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

-- ===== 권한 ============================================================

revoke all on function public.pelham_staff_bill_add_membership(bigint, jsonb) from public, anon, authenticated;
grant execute on function public.pelham_staff_bill_add_membership(bigint, jsonb) to authenticated;
revoke all on function public.pelham_pos_membership_on_bill() from public, anon, authenticated;

notify pgrst, 'reload schema';
