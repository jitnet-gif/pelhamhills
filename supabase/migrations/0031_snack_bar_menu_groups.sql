-- 스낵바 메뉴 그룹 채우기 — 매장 POS 에서 옮긴 스낵바 상품(Food & Beverage)을 계산대 폴더(0030)로 나눈다.
--
-- 왜(2026-10-18): 0030 으로 폴더는 생겼지만 상품의 `menu_group` 이 모두 비어 있어 스낵바 계산대에
-- 90여 개가 한 칸에 쏟아진다. Lightspeed 처럼 Beer, Grab & Go … 폴더를 먼저 보이게 한다.
--
-- 규칙:
--   - SKU 로 집는다(id 아님 — 다른 DB 에서는 id 가 다르다).
--   - 그룹이 비어 있는 상품만 채운다. 직원이 Products 탭에서 이미 고친 그룹은 건드리지 않는다.
--   - 폴더 순서는 화면(`frontend/lib/retail/menuGroups.ts` 의 SNACK_BAR_GROUPS)이 정한다. 이름을 바꾸면 거기도.
--
-- 전제: 0030. 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다.

update public.pelham_retail_products p
   set menu_group = g.menu_group,
       updated_at = now()
  from (values
    -- 맥주+음식 묶음
    ('LS-455', 'Specials'), ('LS-457', 'Specials'), ('LS-456', 'Specials'),
    -- 맥주(무알코올 Corona Zero 포함)
    ('LS-427', 'Beer'), ('LS-400', 'Beer'), ('LS-352', 'Beer'), ('LS-403', 'Beer'), ('LS-404', 'Beer'),
    ('LS-142', 'Beer'), ('LS-144', 'Beer'), ('LS-134', 'Beer'), ('LS-135', 'Beer'), ('LS-402', 'Beer'),
    ('LS-443', 'Beer'), ('LS-420', 'Beer'), ('LS-389', 'Beer'), ('LS-138', 'Beer'), ('LS-445', 'Beer'),
    ('LS-419', 'Beer'), ('LS-388', 'Beer'), ('LS-318', 'Beer'), ('LS-317', 'Beer'), ('LS-319', 'Beer'),
    ('LS-454', 'Beer'), ('LS-253', 'Beer'), ('LS-254', 'Beer'), ('LS-442', 'Beer'),
    -- 사이다·셀처·칵테일
    ('LS-150', 'Coolers & Cocktails'), ('LS-151', 'Coolers & Cocktails'), ('LS-321', 'Coolers & Cocktails'),
    ('LS-320', 'Coolers & Cocktails'), ('LS-421', 'Coolers & Cocktails'), ('LS-387', 'Coolers & Cocktails'),
    ('LS-153', 'Coolers & Cocktails'), ('LS-431', 'Coolers & Cocktails'), ('LS-430', 'Coolers & Cocktails'),
    -- 탄산음료
    ('LS-383', 'Pop'), ('LS-291', 'Pop'), ('LS-304', 'Pop'), ('LS-384', 'Pop'), ('LS-385', 'Pop'),
    ('LS-381', 'Pop'), ('LS-292', 'Pop'), ('LS-293', 'Pop'), ('LS-382', 'Pop'), ('016600010240', 'Pop'),
    -- 스포츠·에너지(Gatorade 맛 이름 포함)
    ('GTR-591', 'Sports & Energy'), ('055577420249', 'Sports & Energy'), ('057271163095', 'Sports & Energy'),
    ('LS-397', 'Sports & Energy'), ('LS-299', 'Sports & Energy'), ('LS-399', 'Sports & Energy'),
    ('LS-301', 'Sports & Energy'), ('LS-300', 'Sports & Energy'), ('LS-302', 'Sports & Energy'),
    ('LS-394', 'Sports & Energy'), ('LS-395', 'Sports & Energy'), ('LS-359', 'Sports & Energy'),
    -- 주스·물
    ('LS-428', 'Juice & Water'), ('LS-296', 'Juice & Water'), ('LS-297', 'Juice & Water'),
    ('LS-303', 'Juice & Water'), ('LS-298', 'Juice & Water'), ('LS-358', 'Juice & Water'),
    -- 따뜻한 음료
    ('LS-356', 'Coffee & Tea'), ('LS-357', 'Coffee & Tea'),
    -- 그릴·샌드위치
    ('LS-362', 'Grill'), ('LS-363', 'Grill'), ('LS-361', 'Grill'), ('LS-429', 'Grill'), ('LS-366', 'Grill'),
    ('LS-365', 'Grill'), ('LS-364', 'Grill'), ('LS-367', 'Grill'), ('LS-448', 'Grill'),
    -- 라면·만두
    ('LS-451', 'Noodles & Dumplings'), ('LS-450', 'Noodles & Dumplings'), ('LS-453', 'Noodles & Dumplings'),
    ('LS-452', 'Noodles & Dumplings'), ('LS-449', 'Noodles & Dumplings'),
    -- 곁들이·추가
    ('LS-368', 'Sides & Extras'), ('LS-369', 'Sides & Extras'), ('LS-370', 'Sides & Extras'),
    ('LS-372', 'Sides & Extras'), ('LS-371', 'Sides & Extras'),
    -- 바로 집어 가는 과자·빵
    ('LS-379', 'Grab & Go'), ('LS-377', 'Grab & Go'), ('CLIF-BAR', 'Grab & Go'), ('LS-376', 'Grab & Go'),
    ('LS-375', 'Grab & Go'), ('LS-374', 'Grab & Go'), ('LS-446', 'Grab & Go'), ('LS-380', 'Grab & Go'),
    ('LS-447', 'Grab & Go')
  ) as g(sku, menu_group)
 where lower(p.sku) = lower(g.sku)
   and p.menu_group is null;

-- 확인: 스낵바 상품과 그룹. 그룹이 빈 줄은 위 목록에 없는 상품이다.
select menu_group, count(*) as products, string_agg(name, ', ' order by name) as names
  from public.pelham_retail_products
 where category = 'Food & Beverage'
 group by menu_group
 order by menu_group nulls first;
