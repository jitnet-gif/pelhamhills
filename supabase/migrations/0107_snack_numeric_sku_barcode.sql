-- 0106 을 되돌리고, 스낵바(Food & Beverage) 상품 중 **숫자로만 된 SKU** 만 바코드로 복사한다.
--
-- 왜: 2026-10-25 0106 은 비어 있는 바코드 칸에 SKU 를 모두 복사했다. `LS-135`, `GTR-591` 같은
-- 클럽 SKU 는 제조사 바코드가 아니라서 바코드 칸에 있으면 안 된다. 제조사 바코드(UPC/EAN)는 숫자뿐이다.
--
-- 1) 되돌리기: 바코드가 SKU 와 같고 숫자뿐이 아닌 Food & Beverage 상품 → 바코드를 비운다.
--    예외: Doritos(280, `060410071953-`), Beer & Cooler(290, `LS-458`) — 2026-10-24 백업에도
--    그 바코드였다(0105 가 되돌린 값).
-- 2) 복사: 바코드가 비어 있고 SKU 가 숫자뿐인 Food & Beverage 상품 → SKU 를 바코드로.
--    그 숫자를 이미 다른 상품이 바코드로 쓰고 있으면 건너뛴다.
-- 결과 표에 상품마다 cleared / copied / skipped 가 나온다. 0106 을 실행하지 않았어도 된다.
--
-- 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다.

with undo as (
  update public.pelham_retail_products p
     set barcode = null, updated_at = now()
   where p.category = 'Food & Beverage'
     and p.barcode is not null
     and p.barcode = btrim(p.sku)
     and p.barcode !~ '^[0-9]+$'
     and p.id not in (280, 290)
  returning p.id, p.name, p.sku
),
todo as (
  select p.id, p.name, btrim(p.sku) as code,
         exists (select 1 from public.pelham_retail_products o
                 where o.id <> p.id and lower(o.barcode) = lower(btrim(p.sku))) as taken
  from public.pelham_retail_products p
  where p.category = 'Food & Beverage'
    and nullif(btrim(coalesce(p.barcode, '')), '') is null
    and btrim(coalesce(p.sku, '')) ~ '^[0-9]+$'
),
copied as (
  update public.pelham_retail_products p
     set barcode = t.code, updated_at = now()
    from todo t
   where p.id = t.id and not t.taken
  returning p.id
)
select name, sku as code, 'cleared (club SKU, not a barcode)' as result from undo
union all
select t.name, t.code,
       case when t.taken then 'skipped (barcode used by another product)' else 'copied' end
  from todo t
 order by result, name;
