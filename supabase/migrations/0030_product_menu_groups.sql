-- 상품 메뉴 그룹(menu group) — 계산대 상품 격자를 Lightspeed 처럼 그룹 폴더로 나눈다.
--
-- 왜(2026-10-17): 진짜 상품 목록(매장 POS 에서 내보낸 것)은 수백 개다. 분류 여섯 개(Apparel, Balls …)만으로는
-- 스낵바가 한 칸에 전부 쏟아진다. Lightspeed 계산대는 "Hot Food", "Beer", "Men's Shirts" 같은 그룹 버튼을
-- 먼저 보이고, 누르면 그 안의 상품이 나온다. 그 그룹을 상품의 `menu_group` 으로 둔다.
--
-- 규칙:
--   - 자유 글자(1–40자). 비우면 null — 계산대에서 그룹 폴더 밖에 바로 보인다.
--   - 분류(`category`)와 따로다. 분류는 매출 리포트·사업부(0005) 용이라 그대로 여섯 개다.
--   - 같은 그룹 이름은 대소문자·앞뒤 공백을 무시하고 하나로 본다(화면이 묶는다). 저장은 직원이 친 그대로.
--
-- 전제: 0006. 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다.

do $$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'pelham_retail_products' and column_name = 'barcode') then
    raise exception '0030 needs 0006 first (pelham_retail_products.barcode is missing).';
  end if;
end;
$$;

alter table public.pelham_retail_products add column if not exists menu_group text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'pelham_retail_products_menu_group_check') then
    alter table public.pelham_retail_products add constraint pelham_retail_products_menu_group_check
      check (menu_group is null or length(btrim(menu_group)) between 1 and 40);
  end if;
end;
$$;

-- 아래 네 함수는 0006 과 같고, 메뉴 그룹을 읽고 쓰는 줄만 더했다.

create or replace function public.pelham_pos_product_json(p public.pelham_retail_products)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', p.id,
    'sku', p.sku,
    'barcode', p.barcode,
    'name', p.name,
    'category', p.category,
    'menu_group', p.menu_group,
    'price', p.price,
    'cost', p.cost,
    'stock', p.stock,
    'reorder_point', p.reorder_point,
    'is_active', p.is_active,
    'created_at', public.pelham_iso(p.created_at),
    'updated_at', public.pelham_iso(p.updated_at)
  )
$$;

create or replace function public.pelham_pos_check_product(p jsonb)
returns void
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p ? 'category' and (p->>'category') not in
     ('Apparel', 'Equipment', 'Balls', 'Accessories', 'Food & Beverage', 'Rentals') then
    perform public.pelham_fail('422', format('''%s'' is not a product category', p->>'category'));
  end if;
  if p ? 'price' and coalesce((p->>'price')::integer, -1) < 0 then
    perform public.pelham_fail('422', 'Price must be zero or more (cents).');
  end if;
  if p ? 'cost' and coalesce((p->>'cost')::integer, 0) < 0 then
    perform public.pelham_fail('422', 'Cost cannot be negative.');
  end if;
  if p ? 'stock' and jsonb_typeof(p->'stock') <> 'null' and (p->>'stock')::integer < 0 then
    perform public.pelham_fail('422', 'Stock cannot be negative. Leave it empty for rentals.');
  end if;
  if p ? 'sku' and length(btrim(coalesce(p->>'sku', ''))) not between 1 and 64 then
    perform public.pelham_fail('422', 'SKU must be 1–64 characters.');
  end if;
  -- 바코드: 비우면 null(바코드 없는 상품). 스캐너가 읽는 글자만(영숫자·하이픈·점·슬래시).
  if p ? 'barcode' and jsonb_typeof(p->'barcode') = 'string' and btrim(p->>'barcode') <> ''
     and btrim(p->>'barcode') !~ '^[A-Za-z0-9./-]{1,64}$' then
    perform public.pelham_fail('422', 'Barcode must be 1–64 letters, digits, "-", "." or "/".');
  end if;
  if p ? 'name' and length(btrim(coalesce(p->>'name', ''))) not between 1 and 120 then
    perform public.pelham_fail('422', 'Name must be 1–120 characters.');
  end if;
  -- 메뉴 그룹: 비우면 null(그룹 없음).
  if p ? 'menu_group' and jsonb_typeof(p->'menu_group') = 'string' and length(btrim(p->>'menu_group')) > 40 then
    perform public.pelham_fail('422', 'Menu group must be 40 characters or fewer.');
  end if;
end;
$$;

create or replace function public.pelham_staff_pos_product_create(p jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v public.pelham_retail_products;
  v_stock integer;
  v_barcode text;
begin
  perform public.pelham_require_staff();
  p := coalesce(p, '{}'::jsonb);
  if not (p ? 'sku' and p ? 'name' and p ? 'category' and p ? 'price') then
    perform public.pelham_fail('422', 'sku, name, category and price are required.');
  end if;
  perform public.pelham_pos_check_product(p);
  if exists (select 1 from public.pelham_retail_products
              where lower(btrim(sku)) = lower(btrim(p->>'sku'))) then
    perform public.pelham_fail('409', format('SKU %s already exists.', btrim(p->>'sku')));
  end if;

  v_barcode := nullif(btrim(coalesce(p->>'barcode', '')), '');
  if v_barcode is not null and exists (select 1 from public.pelham_retail_products
                                        where lower(barcode) = lower(v_barcode)) then
    perform public.pelham_fail('409', format('Barcode %s is already on another product.', v_barcode));
  end if;

  v_stock := case when jsonb_typeof(p->'stock') in ('number', 'string') then (p->>'stock')::integer end;
  insert into public.pelham_retail_products
    (sku, barcode, name, category, menu_group, price, cost, stock, reorder_point, is_active)
  values (btrim(p->>'sku'), v_barcode, btrim(p->>'name'), p->>'category',
          nullif(btrim(coalesce(p->>'menu_group', '')), ''),
          (p->>'price')::integer,
          coalesce((p->>'cost')::integer, 0),
          -- 원장의 출발점은 아래 'initial' 이동이다. 여기서는 0(또는 null)으로 넣는다.
          case when v_stock is null then null else 0 end,
          coalesce((p->>'reorder_point')::integer, 0),
          coalesce((p->>'is_active')::boolean, true))
  returning * into v;

  if v_stock is not null and v_stock <> 0 then
    perform public.pelham_pos_move(v.id, v_stock, 'initial', null, 'Stock when the product was added');
  end if;
  select * into v from public.pelham_retail_products where id = v.id;
  return public.pelham_pos_product_json(v);
end;
$$;

create or replace function public.pelham_staff_pos_product_update(p_id integer, p jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v public.pelham_retail_products;
  v_new_stock integer;
begin
  perform public.pelham_require_staff();
  p := coalesce(p, '{}'::jsonb);
  perform public.pelham_pos_check_product(p);

  select * into v from public.pelham_retail_products where id = p_id for update;
  if v.id is null then
    perform public.pelham_fail('404', 'Product not found');
  end if;
  if p ? 'sku' and exists (select 1 from public.pelham_retail_products
                            where lower(btrim(sku)) = lower(btrim(p->>'sku')) and id <> p_id) then
    perform public.pelham_fail('409', format('SKU %s already exists.', btrim(p->>'sku')));
  end if;

  if p ? 'barcode' and nullif(btrim(coalesce(p->>'barcode', '')), '') is not null
     and exists (select 1 from public.pelham_retail_products
                  where lower(barcode) = lower(btrim(p->>'barcode')) and id <> p_id) then
    perform public.pelham_fail('409', format('Barcode %s is already on another product.', btrim(p->>'barcode')));
  end if;

  update public.pelham_retail_products
     set sku = case when p ? 'sku' then btrim(p->>'sku') else sku end,
         barcode = case when p ? 'barcode' then nullif(btrim(coalesce(p->>'barcode', '')), '') else barcode end,
         name = case when p ? 'name' then btrim(p->>'name') else name end,
         category = coalesce(p->>'category', category),
         menu_group = case when p ? 'menu_group' then nullif(btrim(coalesce(p->>'menu_group', '')), '')
                           else menu_group end,
         price = coalesce((p->>'price')::integer, price),
         cost = coalesce((p->>'cost')::integer, cost),
         reorder_point = coalesce((p->>'reorder_point')::integer, reorder_point),
         is_active = coalesce((p->>'is_active')::boolean, is_active),
         updated_at = now()
   where id = p_id;

  if p ? 'stock' then
    if jsonb_typeof(p->'stock') = 'null' then
      -- 재고 추적을 끈다(렌탈로 바꿈). 원장은 남는다.
      update public.pelham_retail_products set stock = null, updated_at = now() where id = p_id;
    else
      v_new_stock := (p->>'stock')::integer;
      if v.stock is null then
        -- 추적을 새로 켠다. 0 에서 출발해 'initial' 로 채운다.
        update public.pelham_retail_products set stock = 0 where id = p_id;
        perform public.pelham_pos_move(p_id, v_new_stock, 'initial', null, 'Stock tracking turned on');
      else
        perform public.pelham_pos_move(p_id, v_new_stock - v.stock, 'adjust', null, 'Edited on the Products tab');
      end if;
    end if;
  end if;

  select * into v from public.pelham_retail_products where id = p_id;
  return public.pelham_pos_product_json(v);
end;
$$;

-- 권한은 0005 에서 준 그대로다(`create or replace` 는 권한을 바꾸지 않는다).
