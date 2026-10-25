-- 스낵바(Food & Beverage) 상품 중 SKU 가 클럽 코드(`LS-135` 같은)이고 바코드 칸에 숫자 바코드가 있는 것은
-- SKU 를 그 바코드 숫자로 바꾼다. 그리고 스낵바 상품 중 바코드가 있는 개수를 센다.
--
-- 왜: 2026-10-25 Budweiser 처럼 SKU `LS-135`, Barcode `062067335358` 로 나뉜 상품을 Pepsi 처럼
-- SKU 와 Barcode 가 같은 숫자가 되게 맞춰 달라는 요청.
--
-- 규칙
-- - 바코드가 숫자뿐이고 SKU 와 다른 Food & Beverage 상품만. 바코드는 그대로 둔다.
-- - 그 숫자를 이미 다른 상품이 SKU 로 쓰고 있으면(SKU 유일) 건너뛴다.
-- - 매출·재고 기록은 상품 id 로 이어져 있어서 SKU 를 바꿔도 끊기지 않는다.
-- 결과 표 맨 위 세 줄이 합계(스낵바 상품 수 · 바코드 있음 · 바코드 없음), 그 아래가 상품별 결과.
--
-- 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다.

with todo as (
  select p.id, p.name, p.sku as old_sku, btrim(p.barcode) as code,
         exists (select 1 from public.pelham_retail_products o
                 where o.id <> p.id and lower(o.sku) = lower(btrim(p.barcode))) as taken
  from public.pelham_retail_products p
  where p.category = 'Food & Beverage'
    and btrim(coalesce(p.barcode, '')) ~ '^[0-9]+$'
    and btrim(p.sku) <> btrim(p.barcode)
),
moved as (
  update public.pelham_retail_products p
     set sku = t.code, updated_at = now()
    from todo t
   where p.id = t.id and not t.taken
  returning p.id
),
fb as (
  select count(*) as total,
         count(*) filter (where nullif(btrim(coalesce(barcode, '')), '') is not null) as with_bc
  from public.pelham_retail_products
  where category = 'Food & Beverage'
)
select 0 as ord, '합계: 스낵바 상품' as name, null as old_sku, total::text as new_sku, '' as result from fb
union all
select 1, '합계: 바코드 있음', null, with_bc::text, '' from fb
union all
select 2, '합계: 바코드 없음', null, (total - with_bc)::text, '' from fb
union all
select 3, t.name, t.old_sku, t.code,
       case when t.taken then 'skipped (another product already has this SKU)' else 'moved' end
  from todo t
 order by ord, name;
