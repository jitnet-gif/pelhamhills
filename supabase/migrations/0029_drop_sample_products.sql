-- 견본 상품 지우기(drop sample products) — 개발용으로 넣어 둔 16개 품목을 상품 테이블에서 뺀다.
--
-- 왜(2026-10-17): 0003·0005 가 `backend/data/retail.json` 의 견본 16개(Pro V1, Qi10 드라이버, Gatorade …)를
-- 넣어 두었다. 우리 프로샵·스낵바의 진짜 목록이 아니다. 진짜 상품은 매장 POS 에서 내보낸 목록으로 따로 넣는다.
-- 0003·0005 의 시드도 같이 뺐다 — 다시 돌려도 견본이 되살아나지 않는다.
--
-- 규칙:
--   - SKU 로 집는다(id 아님). 직원이 Products 탭에서 새로 넣은 상품은 건드리지 않는다.
--   - 계산서 줄(`pelham_bill_lines`)이 가리키는 견본은 지울 수 없다 — 지난 영수증이 깨진다.
--     그런 것은 숨기기만 한다(is_active = false). 계산대·검색에 안 나온다. 마지막 표에 남는다.
--   - 견본의 재고 원장(`pelham_retail_stock_moves`) 줄도 같이 지운다. 원장이 가리키는 상품이 없어지기 때문.
--
-- 전제: 0005. 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다.

-- 견본 SKU 목록은 문장마다 그대로 적는다. 임시 테이블·임시 함수는 SQL editor 에서 문장 사이에
-- 사라질 수 있다(2026-10-17, "_pelham_sample_skus does not exist").

-- 계산서에 한 번도 안 담긴 견본: 원장 → 상품 순으로 지운다.
delete from public.pelham_retail_stock_moves m
 using public.pelham_retail_products p
 where m.product_id = p.id
   and lower(p.sku) = any (array['pv1-dz', 'chrm-dz', 'tm-qi10-d', 'vky-sm10-56', 'sc-np2-34', 'fj-polo-m',
                             'ph-cap-adj', 'sm-rain-l', 'fj-glv-ml', 'tee-bmb-50', 'ph-twl-tri', 'dvt-mrk-set',
                             'gtr-591', 'clif-bar', 'cart-18', 'clubs-18'])
   and not exists (select 1 from public.pelham_bill_lines l where l.product_id = p.id);

delete from public.pelham_retail_products p
 where lower(p.sku) = any (array['pv1-dz', 'chrm-dz', 'tm-qi10-d', 'vky-sm10-56', 'sc-np2-34', 'fj-polo-m',
                             'ph-cap-adj', 'sm-rain-l', 'fj-glv-ml', 'tee-bmb-50', 'ph-twl-tri', 'dvt-mrk-set',
                             'gtr-591', 'clif-bar', 'cart-18', 'clubs-18'])
   and not exists (select 1 from public.pelham_bill_lines l where l.product_id = p.id);

-- 계산서에 담긴 적 있는 견본: 숨긴다.
update public.pelham_retail_products p
   set is_active = false, updated_at = now()
 where lower(p.sku) = any (array['pv1-dz', 'chrm-dz', 'tm-qi10-d', 'vky-sm10-56', 'sc-np2-34', 'fj-polo-m',
                             'ph-cap-adj', 'sm-rain-l', 'fj-glv-ml', 'tee-bmb-50', 'ph-twl-tri', 'dvt-mrk-set',
                             'gtr-591', 'clif-bar', 'cart-18', 'clubs-18'])
   and p.is_active;

-- 결과: 남은 견본(계산서에 담겨 숨기기만 한 것)과 남은 상품 수.
select 'sample kept hidden (on a bill)' as what, p.sku, p.name,
       (select count(*) from public.pelham_bill_lines l where l.product_id = p.id) as bill_lines
  from public.pelham_retail_products p
 where lower(p.sku) = any (array['pv1-dz', 'chrm-dz', 'tm-qi10-d', 'vky-sm10-56', 'sc-np2-34', 'fj-polo-m',
                             'ph-cap-adj', 'sm-rain-l', 'fj-glv-ml', 'tee-bmb-50', 'ph-twl-tri', 'dvt-mrk-set',
                             'gtr-591', 'clif-bar', 'cart-18', 'clubs-18'])
union all
select 'products left (active)', null, null, count(*)
  from public.pelham_retail_products where is_active;
