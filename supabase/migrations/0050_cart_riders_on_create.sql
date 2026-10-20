-- 카트 대수만 적힌 새 예약에 선수별 카트 요금을 붙인다 (9홀이면 9홀 카트 요금).
--
-- 왜(2026-10-20): 손님 웹 예약(`pelham_tee_book`)과 직원 시트의 새 예약 창(`pelham_staff_booking_create`)은
-- 카트를 예약 단위 `cartCount`(대수)로만 적고, 선수마다 `cart: false, cartFee: 0` 으로 만든다.
-- 계산서·온라인 결제(`pelham_pos_tee_price`)는 선수의 `cart`·`cartFee` 만 읽으므로 카트 요금이 아예 빠졌다.
-- 9홀 예약에 9홀 카트 요금이 붙지 않는 것도 이 때문이다.
--
-- 규칙:
--   - 새로 만드는 예약(INSERT)만. `cartCount` > 0 인데 카트를 탄다고 적힌 선수가 하나도 없을 때만.
--     전화 비서처럼 선수별로 이미 적어 보낸 예약은 건드리지 않는다.
--   - 카트 한 대에 두 명 — 앞에서부터 min(대수 × 2, 인원) 명이 카트를 탄다.
--   - 요금은 `pelham_tee_cart_fee_on`(0045): 그 날·그 홀 수·요금제. 퍼블릭 18홀 $19.47, 9홀 $11.50,
--     시니어 평일 $17.70 / $9.74, "Cart" 회원 $0 (모두 세전, HST 13% 별도).
--   - 결제된 선수는 건드리지 않는다.
--   - 트리거 이름이 0045 의 `pelham_tee_bookings_time_rate` 보다 앞이라(알파벳순) 먼저 돈다.
--     이후 홀 수·날짜·요금제가 바뀌면 그쪽이 자동값으로 따라가게 한다.
--
-- 같은 규칙이 `backend/api/routes/tee_sheet.py` 의 `create_booking` 에도 있다.
--
-- 전제: 0045. 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다.

do $$
begin
  if to_regprocedure('public.pelham_tee_cart_fee_on(text, integer, date)') is null then
    raise exception '0050 needs 0045 first (pelham_tee_cart_fee_on is missing).';
  end if;
end;
$$;

create or replace function public.pelham_tee_bookings_cart_riders()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_carts integer;
  v_holes integer;
  v_riders integer;
  v_players jsonb := '[]'::jsonb;
  pl jsonb;
  i integer := 0;
begin
  if new.doc is null or coalesce(new.status, '') in ('blocked', 'cancelled')
     or jsonb_typeof(new.doc->'players') <> 'array' then
    return new;
  end if;
  v_carts := coalesce(nullif(new.doc->>'cartCount', '')::integer, 0);
  if v_carts <= 0 or exists (
       select 1 from jsonb_array_elements(new.doc->'players') p
        where coalesce((p.value->>'cart')::boolean, false)) then
    return new;
  end if;

  v_holes := case when coalesce(nullif(new.doc->>'holes', '')::integer, 18) = 9 then 9 else 18 end;
  v_riders := v_carts * 2;

  for pl in select value from jsonb_array_elements(new.doc->'players') loop
    if i < v_riders and not coalesce((pl->>'paid')::boolean, false) then
      pl := pl || jsonb_build_object(
        'cart', true,
        'cartFee', public.pelham_tee_cart_fee_on(pl->>'ratePlan', v_holes, new.booking_date));
      i := i + 1;
    end if;
    v_players := v_players || jsonb_build_array(pl);
  end loop;

  new.doc := jsonb_set(new.doc, '{players}', v_players);
  return new;
end;
$$;

drop trigger if exists pelham_tee_bookings_cart_riders on public.pelham_tee_bookings;
create trigger pelham_tee_bookings_cart_riders
  before insert on public.pelham_tee_bookings
  for each row execute function public.pelham_tee_bookings_cart_riders();

revoke all on function public.pelham_tee_bookings_cart_riders() from public, anon, authenticated;
