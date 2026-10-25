-- 스낵바(Food & Beverage) 상품 중 바코드 칸이 비어 있는 것에 SKU 값을 바코드로 복사한다.
--
-- 왜: 2026-10-25 아이패드 + 블루투스 스캐너로 스낵바 상품을 쏘았는데 안 잡혔다. 바코드 칸은
-- 비어 있고 제조사 바코드가 SKU 칸에 들어 있는 상품들이었다.
--
-- 규칙
-- - 바코드가 비어 있고(null 또는 공백) SKU 가 있는 Food & Beverage 상품만. 바코드가 있는 상품은 그대로.
-- - SKU 가 바코드 형식(영문·숫자·"-"·"."·"/" 1–64자)이 아니면 건너뛴다.
-- - 그 값을 이미 다른 상품이 바코드로 쓰고 있으면(유일 인덱스) 건너뛴다.
-- - SKU 는 바꾸지 않는다.
-- 결과 표에 상품마다 copied / skipped 가 나온다.
--
-- 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다.

with todo as (
  select p.id, p.name, btrim(p.sku) as code,
         btrim(p.sku) !~ '^[A-Za-z0-9./-]{1,64}$' as bad_format,
         exists (select 1 from public.pelham_retail_products o
                 where o.id <> p.id and lower(o.barcode) = lower(btrim(p.sku))) as taken
  from public.pelham_retail_products p
  where p.category = 'Food & Beverage'
    and nullif(btrim(coalesce(p.barcode, '')), '') is null
    and nullif(btrim(coalesce(p.sku, '')), '') is not null
),
done as (
  update public.pelham_retail_products p
     set barcode = t.code, updated_at = now()
    from todo t
   where p.id = t.id and not t.bad_format and not t.taken
  returning p.id
)
select t.name, t.code as barcode,
       case when t.bad_format then 'skipped (SKU is not a barcode format)'
            when t.taken then 'skipped (barcode used by another product)'
            else 'copied' end as result
  from todo t
 order by result, t.name;
