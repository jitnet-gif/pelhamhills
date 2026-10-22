-- 계산서 금액이 "어떤 때는 많고 어떤 때는 적게" 나오던 것을 바로잡는다.
--
-- 왜(2026-10-22): 클럽이 "Payment amounts never correct. Sometimes more, sometimes less." 라고 했다.
-- 세금·센트 계산은 맞았다. 틀린 곳은 할인을 담아 두는 방식과 단말기 승인 한도였다.
--
--   1. 다시 계산(pelham_pos_recalc)이 할인을 깎은 값으로 **덮어썼다**. 한 사람을 잠깐 빼서 소계가 할인보다
--      작아지면 할인이 그만큼 영영 줄었다 → 다시 넣어도 할인이 안 돌아와 더 받았다.
--   2. 프로모션 금액이 찍는 순간 굳었다(0078). 찍은 뒤 사람을 빼면 할인이 그대로 남아 덜 받고(상품까지 깎였다),
--      더하면 그 사람은 할인이 없어 더 받았다.
--   3. 직원이 "Bill discount" 칸을 고치면 프로모션 몫까지 덮어썼다(칸에 합친 값이 보였다). 그 뒤 코드를 지우면
--      남은 직원 할인에서 프로모션 금액을 또 뺐다.
--   4. 단말기 판매 시작이 계산서 합계만 봤다. 이미 승인되고 아직 결제에 안 쓴 카드 승인을 빼지 않아,
--      다시 누르면 합계보다 더 긁을 수 있었다.
--
-- 바뀌는 것:
--   - pelham_bills.manual_discount: 직원이 친 할인(센트). 이 값은 다시 계산이 건드리지 않는다.
--   - 다시 계산할 때마다 프로모션 금액을 지금의 그린피 줄로 새로 매긴다(pelham_promo_uses.amount 도 따라간다).
--   - pelham_bills.discount = least(manual_discount + 프로모션, 소계). 화면·영수증·마감이 읽는 값은 그대로 이것이다.
--   - pelham_staff_bill_update 의 discount 는 이제 manual_discount 를 정한다.
--   - 계산서 JSON 에 manual_discount 를 더한다(화면의 "Bill discount" 칸이 이 값을 보인다).
--   - 단말기 판매: 요청 금액 + 이 계산서의 쓰지 않은 승인 합계가 계산서 합계를 넘으면 거절.
--
-- 전제: 0005, 0008, 0011, 0021, 0024, 0078. 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다.

do $$
begin
  if to_regprocedure('public.pelham_staff_bill_apply_promo(bigint,text)') is null then
    raise exception '0080 needs 0078 first (pelham_staff_bill_apply_promo is missing).';
  end if;
  if to_regprocedure('public.pelham_staff_terminal_begin_ungated(jsonb)') is null then
    raise exception '0080 needs 0024 first (pelham_staff_terminal_begin_ungated is missing).';
  end if;
end;
$$;

-- ===== 표 ==============================================================

-- 처음 한 번만: 열린·지난 계산서의 직원 할인 = 지금 할인 − 프로모션 몫.
do $$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'pelham_bills' and column_name = 'manual_discount') then
    alter table public.pelham_bills
      add column manual_discount integer not null default 0 check (manual_discount >= 0);
    update public.pelham_bills b
       set manual_discount = greatest(b.discount - coalesce((select x.amount from public.pelham_promo_uses x
                                                              where x.bill_id = b.id), 0), 0);
  end if;
end;
$$;

-- ===== 프로모션 금액 ======================================================

-- 이 계산서의 지금 그린피 줄로 매긴 프로모션 금액(센트). 코드가 없으면 0. 0078 의 식과 같다.
create or replace function public.pelham_promo_amount_for(p_bill bigint)
returns integer
language sql
stable
set search_path = ''
as $$
  select coalesce((
    select least(
             case
               when p.kind = 'percent' then round(f.fees * p.value / 100.0)::integer
               when p.per_player then p.value * f.players
               else case when f.players > 0 then p.value else 0 end
             end,
             f.fees)
      from public.pelham_promo_uses x
      join public.pelham_promotions p on p.id = x.promo_id
      cross join lateral (
        select coalesce(sum(l.quantity), 0)::integer as players,
               greatest(coalesce(sum(l.line_total), 0), 0)::integer as fees
          from public.pelham_bill_lines l
         where l.bill_id = p_bill and l.active and l.kind = 'tee_player'
      ) f
     where x.bill_id = p_bill
  ), 0)
$$;

-- ===== 다시 계산 ==========================================================

-- 0008 과 같고, 끝의 할인 부분만 바뀌었다(파일 머리 1·2).
create or replace function public.pelham_pos_recalc(p_bill bigint)
returns void
language plpgsql
volatile
set search_path = ''
as $$
declare
  l record;
  v_doc jsonb;
  v_player jsonb;
  v_price integer;
  v_subtotal integer;
  v_manual integer;
  v_promo integer;
  v_discount integer;
  v_taxable integer;
  v_status text;
  v_sim public.pelham_sim_reservations;
begin
  select b.status into v_status from public.pelham_bills b where b.id = p_bill for update;
  if v_status is distinct from 'open' then
    return;
  end if;
  for l in
    select * from public.pelham_bill_lines where bill_id = p_bill and kind = 'tee_player' and active
  loop
    select t.doc into v_doc from public.pelham_tee_bookings t where t.id = l.booking_id;
    v_player := public.pelham_pos_find_player(v_doc, l.player_id);
    if v_player is null or coalesce((v_player->>'cancelled')::boolean, false)
       or coalesce((v_player->>'paid')::boolean, false) then
      continue;
    end if;
    v_price := public.pelham_pos_tee_price(v_doc, v_player);
    update public.pelham_bill_lines
       set unit_price = v_price,
           line_total = v_price * quantity - least(discount, v_price * quantity),
           name = public.pelham_pos_tee_line_name(v_doc, v_player),
           tee_date = (v_doc->>'date')::date,
           tee_time = v_doc->>'time'
     where id = l.id;
  end loop;

  for l in
    select * from public.pelham_bill_lines where bill_id = p_bill and kind = 'sim_booking' and active
  loop
    select * into v_sim from public.pelham_sim_reservations r where r.id = l.sim_reservation_id;
    if v_sim.id is null or v_sim.status in ('paid', 'cancelled') then
      continue;
    end if;
    v_price := round(coalesce(v_sim.total_price, 0) * 100)::integer;
    update public.pelham_bill_lines
       set unit_price = v_price,
           line_total = v_price * quantity - least(discount, v_price * quantity),
           name = public.pelham_pos_sim_line_name(v_sim),
           tee_date = v_sim.booking_date,
           tee_time = public.pelham_pos_sim_time(v_sim.start_minutes)
     where id = l.id;
  end loop;

  select coalesce(sum(line_total), 0) into v_subtotal
    from public.pelham_bill_lines where bill_id = p_bill and active;

  -- 프로모션은 지금 그린피 줄로 다시 매긴다. 직원 할인은 친 값 그대로 두고, 합친 할인만 소계에서 멈춘다.
  v_promo := public.pelham_promo_amount_for(p_bill);
  update public.pelham_promo_uses x set amount = v_promo where x.bill_id = p_bill and x.amount <> v_promo;
  select coalesce(b.manual_discount, 0) into v_manual from public.pelham_bills b where b.id = p_bill;
  v_discount := least(v_manual + v_promo, v_subtotal);
  v_taxable := v_subtotal - v_discount;

  update public.pelham_bills
     set subtotal = v_subtotal,
         discount = v_discount,
         tax = public.pelham_pos_tax(v_taxable),
         total = v_taxable + public.pelham_pos_tax(v_taxable)
   where id = p_bill;
end;
$$;

-- ===== 직원 할인 ==========================================================

-- 0005 와 같고, discount 가 manual_discount 를 정한다(프로모션 몫은 따로 더해진다).
create or replace function public.pelham_staff_bill_update(p_bill bigint, p jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform public.pelham_require_staff();
  perform public.pelham_pos_lock_open(p_bill);
  p := coalesce(p, '{}'::jsonb);
  if p ? 'discount' and coalesce((p->>'discount')::integer, -1) < 0 then
    perform public.pelham_fail('422', 'Discount must be zero or more (cents).');
  end if;
  update public.pelham_bills
     set manual_discount = coalesce((p->>'discount')::integer, manual_discount),
         cashier = case when p ? 'cashier' then nullif(btrim(coalesce(p->>'cashier', '')), '') else cashier end,
         note = case when p ? 'note' then nullif(btrim(coalesce(p->>'note', '')), '') else note end,
         label = case when p ? 'label' then nullif(btrim(coalesce(p->>'label', '')), '') else label end
   where id = p_bill;
  perform public.pelham_pos_recalc(p_bill);
  return public.pelham_pos_bill_json(p_bill);
end;
$$;

-- ===== 프로모션 적용·제거 =================================================

-- 0078 과 같은 검사. 금액은 다시 계산이 매기므로 discount 를 직접 더하지 않는다.
create or replace function public.pelham_staff_bill_apply_promo(p_bill bigint, p_code text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_code text := public.pelham_promo_code(p_code);
  v_promo public.pelham_promotions;
  v_today date := public.pelham_pos_today();
  v_players integer;
  v_fees integer;
  v_taken integer;
  v_by text;
begin
  perform public.pelham_require_staff();
  perform public.pelham_pos_lock_open(p_bill);

  select * into v_promo from public.pelham_promotions p where p.code = v_code for update;
  if v_promo.id is null then
    perform public.pelham_fail('404', format('No promotion %s.', v_code));
  end if;
  if not v_promo.active then
    perform public.pelham_fail('409', format('%s is paused.', v_code));
  end if;
  if v_promo.starts_on is not null and v_promo.starts_on > v_today then
    perform public.pelham_fail('409', format('%s starts %s.', v_code, v_promo.starts_on));
  end if;
  if v_promo.expires_on is not null and v_promo.expires_on < v_today then
    perform public.pelham_fail('409', format('%s expired %s.', v_code, v_promo.expires_on));
  end if;
  if exists (select 1 from public.pelham_promo_uses x where x.bill_id = p_bill) then
    perform public.pelham_fail('409', 'This bill already has a promo code. Remove it first.');
  end if;
  if v_promo.usage_limit is not null then
    select count(*) into v_taken
      from public.pelham_promo_uses x
      join public.pelham_bills b on b.id = x.bill_id
     where x.promo_id = v_promo.id and b.status in ('paid', 'open');
    if v_taken >= v_promo.usage_limit then
      perform public.pelham_fail('409', format('%s has been used %s of %s times.', v_code, v_taken, v_promo.usage_limit));
    end if;
  end if;

  select coalesce(sum(l.quantity), 0), coalesce(sum(l.line_total), 0) into v_players, v_fees
    from public.pelham_bill_lines l
   where l.bill_id = p_bill and l.active and l.kind = 'tee_player';
  if v_players = 0 or v_fees <= 0 then
    perform public.pelham_fail('422', 'Add the green fee to the bill first, then scan the promo code.');
  end if;

  select lower(u.email) into v_by from auth.users u where u.id = auth.uid();
  insert into public.pelham_promo_uses (bill_id, promo_id, amount, applied_by)
  values (p_bill, v_promo.id, 0, v_by);
  perform public.pelham_pos_recalc(p_bill);
  return public.pelham_pos_bill_json(p_bill);
end;
$$;

create or replace function public.pelham_staff_bill_remove_promo(p_bill bigint)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform public.pelham_require_staff();
  perform public.pelham_pos_lock_open(p_bill);
  delete from public.pelham_promo_uses x where x.bill_id = p_bill;
  perform public.pelham_pos_recalc(p_bill);
  return public.pelham_pos_bill_json(p_bill);
end;
$$;

-- ===== 계산서 JSON ========================================================
-- 0011 의 본문을 _base 로 옮기고 manual_discount 만 더한다. 0011 을 다시 돌렸으면 새 본문을 다시 옮긴다.

do $$
declare
  v_src text;
begin
  select p.prosrc into v_src from pg_proc p where p.oid = to_regprocedure('public.pelham_pos_bill_json(bigint)');
  if v_src like '%pelham_pos_bill_json_base%' then
    return;
  end if;
  if to_regprocedure('public.pelham_pos_bill_json_base(bigint)') is not null then
    drop function public.pelham_pos_bill_json_base(bigint);
  end if;
  alter function public.pelham_pos_bill_json(bigint) rename to pelham_pos_bill_json_base;
end;
$$;

create or replace function public.pelham_pos_bill_json(p_bill bigint)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select public.pelham_pos_bill_json_base(p_bill)
         || jsonb_build_object('manual_discount',
              (select b.manual_discount from public.pelham_bills b where b.id = p_bill))
$$;

revoke all on function public.pelham_pos_bill_json_base(bigint) from public, anon, authenticated;
revoke all on function public.pelham_pos_bill_json(bigint) from public, anon, authenticated;
revoke all on function public.pelham_promo_amount_for(bigint) from public, anon, authenticated;

-- ===== 단말기 판매 한도 ===================================================

-- 0024 의 게이트와 같고, 판매에 "쓰지 않은 승인" 검사를 더했다(파일 머리 4).
create or replace function public.pelham_staff_terminal_begin(p jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_bill bigint;
  v_amount integer;
  v_total integer;
  v_held integer;
begin
  perform public.pelham_require_staff();
  -- 결제가 끝난 계산서의 카드 환불만. 계산 중(open) 결제 줄 지우기는 그대로 둔다.
  if p->>'kind' = 'refund' and exists (
       select 1 from public.pelham_bills b
        where b.id = nullif(p->>'bill_id', '')::bigint and b.status <> 'open') then
    perform public.pelham_require_manager('refund', p->>'bill_id', 'this card refund');
  end if;

  if p->>'kind' = 'sale' then
    begin
      v_bill := nullif(p->>'bill_id', '')::bigint;
      v_amount := nullif(p->>'amount', '')::integer;
    exception when others then
      perform public.pelham_fail('422', 'bill_id and amount must be numbers.');
    end;
    -- 합계는 지금 값으로(직원이 사람을 빼거나 더한 뒤일 수 있다).
    perform public.pelham_pos_recalc(v_bill);
    select b.total into v_total from public.pelham_bills b where b.id = v_bill;
    select coalesce(sum(t.requested_amount), 0) into v_held
      from public.pelham_terminal_transactions t
     where t.bill_id = v_bill and t.kind = 'sale' and t.approved
       and t.bill_payment_id is null and t.voided_at is null;
    if v_total is not null and coalesce(v_amount, 0) + v_held > v_total then
      perform public.pelham_fail('409', format(
        'The card reader already approved %s on this bill. Only %s is left — check the payments list before charging again.',
        to_char(v_held / 100.0, 'FM$999,990.00'), to_char(greatest(v_total - v_held, 0) / 100.0, 'FM$999,990.00')));
    end if;
  end if;
  return public.pelham_staff_terminal_begin_ungated(p);
end;
$$;

revoke all on function public.pelham_staff_terminal_begin(jsonb) from public, anon, authenticated;
grant execute on function public.pelham_staff_terminal_begin(jsonb) to authenticated;

notify pgrst, 'reload schema';
