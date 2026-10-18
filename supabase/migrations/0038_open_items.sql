-- 오픈 아이템 — 상품 목록에 없는 것을 이름·가격을 직접 쳐서 계산서에 담는다.
--
-- 왜(2026-10-18): 판매 화면(New Sale)에서 등록 안 된 물건(레슨비, 수선비, 행사 참가비 등)을
-- 받으려면 상품부터 만들어야 했다. Lightspeed 의 "Open Item" 처럼 이름·가격만 쳐서 바로 받는다.
--
-- 바뀌는 것
-- 1. 계산서 줄 종류 `open_item`. product_id·예약 칸이 모두 비어 있다. SKU 는 'OPEN'.
-- 2. `pelham_staff_bill_add_open_item(bill, p)` — p: {name, price(센트), quantity, category}.
--    같은 이름을 두 번 담아도 줄이 둘이다(합치지 않는다 — 가격이 다를 수 있다).
--
-- 규칙
--   - 재고는 건드리지 않는다. 결제·환불의 재고 처리는 `kind = 'product'` 만 보므로 고칠 것이 없다.
--   - 세금은 계산서 전체에 같은 HST(`pelham_pos_recalc`)라 따로 할 것이 없다.
--   - 수량·줄 할인·지우기는 상품 줄과 같다(`pelham_staff_bill_line_update` 그대로).
--   - 매출 보고서에는 고른 분류로 잡힌다. Top products 에는 나오지 않는다(상품이 아니다).
--
-- 같은 한도(이름 80자, 가격 $0.01–$10,000.00)가 `frontend/components/retail/OpenItemDialog.tsx` 에 있다.
-- 바꾸면 둘을 같이 고쳐라.
--
-- 전제: 0005, 0008. 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다.

do $$
begin
  if to_regprocedure('public.pelham_pos_recalc(bigint)') is null then
    raise exception '0038 needs 0005 first (pelham_pos_recalc is missing).';
  end if;
  if not exists (select 1 from pg_constraint where conname = 'pelham_bill_lines_sim_check') then
    raise exception '0038 needs 0008 first (pelham_bill_lines_sim_check is missing).';
  end if;
end;
$$;

-- ===== 테이블 ==========================================================

-- 0008 과 같은 방법으로 줄 종류 check 를 찾아 바꾼다.
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
    check (kind in ('product', 'tee_player', 'sim_booking', 'open_item'));
end;
$$;

-- ===== 직원 함수 =======================================================

create or replace function public.pelham_staff_bill_add_open_item(p_bill bigint, p jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_name text;
  v_category text;
  v_price integer;
  v_qty integer;
begin
  perform public.pelham_require_staff();
  perform public.pelham_pos_lock_open(p_bill);
  p := coalesce(p, '{}'::jsonb);

  v_name := btrim(coalesce(p->>'name', ''));
  if v_name = '' then
    perform public.pelham_fail('422', 'Enter a name for the open item.');
  end if;
  if char_length(v_name) > 80 then
    perform public.pelham_fail('422', 'Open item name must be 80 characters or fewer.');
  end if;

  v_category := coalesce(nullif(btrim(coalesce(p->>'category', '')), ''), 'Other');
  if char_length(v_category) > 40 then
    perform public.pelham_fail('422', 'Category must be 40 characters or fewer.');
  end if;

  begin
    v_price := (p->>'price')::integer;
    v_qty := coalesce((p->>'quantity')::integer, 1);
  exception when others then
    perform public.pelham_fail('422', 'Price and quantity must be whole numbers (price in cents).');
  end;
  if v_price is null or v_price < 1 or v_price > 1000000 then
    perform public.pelham_fail('422', 'Price must be between $0.01 and $10,000.00.');
  end if;
  if v_qty < 1 or v_qty > 9999 then
    perform public.pelham_fail('422', 'Quantity must be between 1 and 9999.');
  end if;

  insert into public.pelham_bill_lines (bill_id, kind, sku, name, category, quantity, unit_price, line_total)
  values (p_bill, 'open_item', 'OPEN', v_name, v_category, v_qty, v_price, v_qty * v_price);

  perform public.pelham_pos_recalc(p_bill);
  return public.pelham_pos_bill_json(p_bill);
end;
$$;

-- ===== 권한 ============================================================

revoke all on function public.pelham_staff_bill_add_open_item(bigint, jsonb) from public, anon, authenticated;
grant execute on function public.pelham_staff_bill_add_open_item(bigint, jsonb) to authenticated;
