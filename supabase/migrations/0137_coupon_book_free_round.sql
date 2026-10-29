-- 쿠폰북(GPS 앱, 라운드 10번 = 1번 무료)의 무료 라운드를 티 시트 계산서에서 쓴다(2026-10-29 클럽 요청).
--
-- 왜: "쿠폰북에 10개되면 무료쿠폰을 티시트 결제 카테고리에서 반영이 되도록". 무료 라운드는 GPS 앱 /fnb 의
--   "무료 라운드 사용" 버튼으로만 쓸 수 있었다. 그 버튼은 장부에 한 줄을 남길 뿐 계산서는 그대로라,
--   직원이 그린피를 손으로 깎아야 했고 둘이 맞는지 아무도 몰랐다.
--
-- 흐름:
--   1. 티 시트에서 그린피를 계산서에 담으면, 계산서가 그 선수의 쿠폰북을 찾아 보인다
--      (선수 → GPS 계정은 0027 의 coupon_owner_for_player: 프로샵 QR 연결, 손님 기록 이메일, 예약 이메일).
--   2. 무료 라운드가 있으면 "Use free round" 를 누른다. 그 선수 줄의 그린피만 0 이 된다(줄 할인).
--      카트·추가 항목(extras)은 그대로 받는다 — 무료는 라운드(그린피)다.
--   3. 장부(coupon_entries)에 'redeem' 한 줄이 그 계산서 줄과 묶여 남는다. GPS 앱 지갑의 남은 무료가 바로 준다.
--
-- 되돌림:
--   - "Undo" 또는 그 선수를 계산서에서 빼면 redeem 줄이 지워져 무료가 돌아온다.
--   - 결제된 계산서를 환불하거나 열린 계산서를 취소하면(줄이 꺼짐) 무료가 돌아온다.
--
-- 도장(0027)과의 관계: 무료로 친 라운드에는 도장이 없다.
--   - 결제를 먼저 하면 0027 체크인 트리거가 "오늘 무료를 썼다" 를 보고 도장을 건너뛴다.
--   - 체크인을 먼저 해서 오늘 도장이 이미 찍혔으면, 무료를 쓸 때 그 자리의 오늘 도장을 먼저 뺀다.
--     그래서 10번째 도장을 받은 그 라운드 자체는 무료가 안 된다(그 라운드가 10번째 유료 라운드다).
--   - Undo 하면 체크인된 오늘 선수에게 도장을 다시 찍는다.
--
-- 바꾸는 것:
--   - coupon_entries.bill_line_id (GPS 0023 의 장부 표에 칸 하나. 줄이 지워지면 redeem 도 같이 지워진다)
--   - pelham_staff_bill_coupons(p_bill)                  계산서 그린피 줄마다 쿠폰북 요약
--   - pelham_staff_bill_use_free_round(p_bill, p_line)   무료 라운드 쓰기
--   - pelham_staff_bill_undo_free_round(p_bill, p_line)  되돌리기
--   - pelham_bill_lines 트리거 둘: 다시 계산해도 무료 줄의 그린피가 0 으로 남게, 줄이 꺼지면 무료를 돌려주게.
--
-- 전제: pelhamhills 0005, 0080, 0093 / GPS 0023, 0026, 0027.
-- 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다.

do $$
begin
  if to_regclass('public.coupon_entries') is null then
    raise exception '0137 needs the GPS coupon book first (golf-gps 0023_coupon_book.sql).';
  end if;
  if to_regprocedure('public.coupon_owner_for_player(jsonb)') is null then
    raise exception '0137 needs golf-gps 0027_coupon_auto_stamp.sql first (coupon_owner_for_player is missing).';
  end if;
  if to_regprocedure('public.pelham_pos_recalc(bigint)') is null then
    raise exception '0137 needs 0005 first (pelham_pos_recalc is missing).';
  end if;
end;
$$;

-- ===== 장부 칸 ==========================================================

alter table public.coupon_entries
  add column if not exists bill_line_id bigint references public.pelham_bill_lines (id) on delete cascade;
create unique index if not exists coupon_entries_bill_line
  on public.coupon_entries (bill_line_id) where bill_line_id is not null;

-- ===== 도우미 ==========================================================

-- 그 선수의 그린피(센트) — 카트·extras 를 뺀 몫. 0093 의 pelham_pos_tee_price 첫 항과 같다.
create or replace function public.pelham_coupon_green_fee(p_doc jsonb, p_player jsonb)
returns integer
language sql
immutable
set search_path = ''
as $$
  select greatest(round(coalesce(case when jsonb_typeof(p_player->'greenFee') = 'number'
                                      then (p_player->>'greenFee')::numeric end,
                                 (p_doc->>'rate')::numeric, 0) * 100)::integer, 0)
$$;

-- 그린피 줄 하나 → 예약 doc 의 선수. 없으면 null.
create or replace function public.pelham_coupon_line_player(p_line public.pelham_bill_lines)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select public.pelham_pos_find_player(t.doc, p_line.player_id)
    from public.pelham_tee_bookings t
   where t.id = p_line.booking_id
$$;

-- 무료 줄이 깎는 금액: 그린피 × 수량, 줄 금액을 넘지 않게.
create or replace function public.pelham_coupon_line_discount(p_line public.pelham_bill_lines)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select least(coalesce(public.pelham_coupon_green_fee(t.doc, public.pelham_pos_find_player(t.doc, p_line.player_id)), 0)
                 * p_line.quantity,
               p_line.unit_price * p_line.quantity)
    from public.pelham_tee_bookings t
   where t.id = p_line.booking_id
$$;

-- ===== 계산서의 쿠폰북 ====================================================

-- 살아 있는 그린피 줄마다(쿠폰북을 찾은 선수만):
--   {line_id, name, free_left, on_card, is_member, applied, amount}
-- applied 면 amount 가 그 줄에서 깎은 센트.
create or replace function public.pelham_staff_bill_coupons(p_bill bigint)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  l public.pelham_bill_lines;
  v_player jsonb;
  v_owner uuid;
  v_sum jsonb;
  v_out jsonb := '[]'::jsonb;
begin
  perform public.pelham_require_staff();
  for l in
    select * from public.pelham_bill_lines
     where bill_id = p_bill and kind = 'tee_player' and active
     order by id
  loop
    v_player := public.pelham_coupon_line_player(l);
    if v_player is null then
      continue;
    end if;
    v_owner := public.coupon_owner_for_player(v_player);
    if v_owner is null then
      continue;
    end if;
    v_sum := public.coupon_summary(v_owner);
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'line_id', l.id,
      'name', coalesce(nullif(btrim(v_player->>'name'), ''), 'Guest'),
      'free_left', (v_sum->>'free_left')::integer,
      'on_card', (v_sum->>'on_card')::integer,
      'is_member', coalesce((v_sum->>'is_member')::boolean, false),
      'applied', exists (select 1 from public.coupon_entries e where e.bill_line_id = l.id),
      'amount', l.discount
    ));
  end loop;
  return v_out;
end;
$$;

create or replace function public.pelham_staff_bill_use_free_round(p_bill bigint, p_line bigint)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  l public.pelham_bill_lines;
  v_player jsonb;
  v_owner uuid;
  v_amount integer;
  v_sum jsonb;
  e record;
begin
  perform public.pelham_require_staff();
  perform public.pelham_pos_lock_open(p_bill);
  select * into l from public.pelham_bill_lines
   where id = p_line and bill_id = p_bill and kind = 'tee_player' and active
   for update;
  if l.id is null then
    perform public.pelham_fail('404', 'That green fee is not on this bill.');
  end if;
  if exists (select 1 from public.coupon_entries x where x.bill_line_id = l.id) then
    return public.pelham_pos_bill_json(p_bill);
  end if;

  v_player := public.pelham_coupon_line_player(l);
  v_owner := public.coupon_owner_for_player(coalesce(v_player, '{}'::jsonb));
  if v_owner is null then
    perform public.pelham_fail('404', 'No coupon book for this player. Link their GPS app (scan their QR) or use the email they signed up with.');
  end if;
  v_amount := coalesce(public.pelham_coupon_line_discount(l), 0);
  if v_amount <= 0 then
    perform public.pelham_fail('422', 'This player has no green fee to cover.');
  end if;

  -- 두 계산대가 같은 손님의 마지막 무료를 같이 쓰지 않게(0023 과 같은 잠금).
  perform pg_advisory_xact_lock(hashtext('coupon:' || v_owner::text));

  -- 이 라운드로 오늘 찍힌 도장은 뺀다 — 무료 라운드에는 도장이 없다(0027).
  for e in
    select ce.id from public.coupon_entries ce
     where ce.booking_id = l.booking_id and ce.player_id = l.player_id and ce.kind = 'stamp'
  loop
    perform public.coupon_drop_stamp(e.id);
  end loop;

  v_sum := public.coupon_summary(v_owner);
  if (v_sum->>'free_left')::integer < 1 then
    perform public.pelham_fail('409', format('No free round yet — %s of 10 stamps on the card.', v_sum->>'on_card'));
  end if;

  insert into public.coupon_entries (owner_id, kind, staff_id, booking_id, player_id, bill_line_id)
  values (v_owner, 'redeem', auth.uid(), l.booking_id, l.player_id, l.id);
  -- 줄 할인은 아래 트리거가 매긴다(다시 계산할 때도 같은 길).
  update public.pelham_bill_lines set discount = v_amount where id = l.id;
  perform public.pelham_pos_recalc(p_bill);
  return public.pelham_pos_bill_json(p_bill);
end;
$$;

create or replace function public.pelham_staff_bill_undo_free_round(p_bill bigint, p_line bigint)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  l public.pelham_bill_lines;
  v_owner uuid;
  v_player jsonb;
  v_date date;
begin
  perform public.pelham_require_staff();
  perform public.pelham_pos_lock_open(p_bill);
  select * into l from public.pelham_bill_lines
   where id = p_line and bill_id = p_bill and kind = 'tee_player'
   for update;
  if l.id is null then
    perform public.pelham_fail('404', 'That green fee is not on this bill.');
  end if;

  delete from public.coupon_entries x where x.bill_line_id = l.id returning x.owner_id into v_owner;
  update public.pelham_bill_lines set discount = 0 where id = l.id;
  perform public.pelham_pos_recalc(p_bill);

  -- 이제 유료 라운드다. 이미 체크인한 오늘 선수면 그 도장을 다시 찍는다(체크인 트리거가 건너뛴 것).
  if v_owner is not null and l.active then
    begin
      v_player := public.pelham_coupon_line_player(l);
      select t.booking_date into v_date from public.pelham_tee_bookings t where t.id = l.booking_id;
      if coalesce((v_player->>'arrived')::boolean, false)
         and v_date = (now() at time zone 'America/Toronto')::date
         and coalesce(v_player->>'ratePlan', '') not ilike '%member%' then
        perform public.coupon_give_stamp(v_owner, l.booking_id, l.player_id);
      end if;
    exception when others then
      raise warning 'coupon stamp not restored for bill line %: %', l.id, sqlerrm;
    end;
  end if;
  return public.pelham_pos_bill_json(p_bill);
end;
$$;

-- ===== 줄 트리거 ==========================================================

-- 다시 계산(pelham_pos_recalc)은 단가를 새로 매기고 line_total 을 discount 로 계산한다. 무료 줄이면
-- discount 를 지금의 그린피로 다시 맞춘다 — 요금제를 바꾸거나 카트를 더해도 그린피만 0 으로 남는다.
create or replace function public.pelham_coupon_line_keep_free()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.kind = 'tee_player' and new.active
     and exists (select 1 from public.coupon_entries x where x.bill_line_id = new.id) then
    new.discount := coalesce(public.pelham_coupon_line_discount(new), new.discount);
    new.line_total := new.unit_price * new.quantity - least(new.discount, new.unit_price * new.quantity);
  end if;
  return new;
end;
$$;

drop trigger if exists pelham_coupon_line_keep_free on public.pelham_bill_lines;
create trigger pelham_coupon_line_keep_free
  before update on public.pelham_bill_lines
  for each row execute function public.pelham_coupon_line_keep_free();

-- 줄이 꺼지면(환불·취소) 무료를 돌려준다. 줄을 지우면 외래키(on delete cascade)가 같은 일을 한다.
create or replace function public.pelham_coupon_line_released()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.active and not new.active then
    delete from public.coupon_entries x where x.bill_line_id = new.id;
  end if;
  return null;
end;
$$;

drop trigger if exists pelham_coupon_line_released on public.pelham_bill_lines;
create trigger pelham_coupon_line_released
  after update of active on public.pelham_bill_lines
  for each row execute function public.pelham_coupon_line_released();

revoke all on function public.pelham_coupon_green_fee(jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.pelham_coupon_line_player(public.pelham_bill_lines) from public, anon, authenticated;
revoke all on function public.pelham_coupon_line_discount(public.pelham_bill_lines) from public, anon, authenticated;
revoke all on function public.pelham_coupon_line_keep_free() from public, anon, authenticated;
revoke all on function public.pelham_coupon_line_released() from public, anon, authenticated;
revoke all on function public.pelham_staff_bill_coupons(bigint) from public, anon, authenticated;
revoke all on function public.pelham_staff_bill_use_free_round(bigint, bigint) from public, anon, authenticated;
revoke all on function public.pelham_staff_bill_undo_free_round(bigint, bigint) from public, anon, authenticated;
grant execute on function public.pelham_staff_bill_coupons(bigint) to authenticated;
grant execute on function public.pelham_staff_bill_use_free_round(bigint, bigint) to authenticated;
grant execute on function public.pelham_staff_bill_undo_free_round(bigint, bigint) to authenticated;

notify pgrst, 'reload schema';

-- ===== 확인 ============================================================
-- 세 함수가 나와야 한다.
select proname from pg_proc
 where proname in ('pelham_staff_bill_coupons', 'pelham_staff_bill_use_free_round', 'pelham_staff_bill_undo_free_round')
 order by proname;
