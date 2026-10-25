-- 스낵바(Food & Beverage) 상품 바코드를 2026-10-24 22:36 백업 값으로 되돌린다.
--
-- 왜: 2026-10-25 스낵바 상품 바코드가 바뀌거나 지워졌다. 그날 밤 자동 백업 ZIP
-- (pelhamhills-backup-2026-10-24_2236)의 pelham_retail_products.csv 에 바코드가 있던 57개를 되돌린다.
--
-- 규칙
-- - 상품은 id 로 찾는다. 지금 바코드가 백업과 같으면 건드리지 않는다.
-- - 그 바코드를 지금 다른 상품이 쓰고 있으면(유일 인덱스) 건너뛰고, 아래 결과에 'skipped' 로 보인다.
-- - 백업에 바코드가 없던 상품은 건드리지 않는다.
--
-- 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다.

drop table if exists pg_temp.restore_barcodes;
create temp table restore_barcodes (id integer primary key, barcode text, name text);

insert into restore_barcodes (id, barcode, name) values
    (34, '062067335358', 'Budweiser'),
    (37, '056327073937', 'Molson Canadian'),
    (50, '056327014336', 'Coors Original'),
    (51, '062067424991', 'Corona Zero'),
    (68, '776029701548', 'Moosehead'),
    (77, '628634637029', 'Pelham Hills Lager'),
    (85, '687181947692', 'Pure Drive Lemon Lime'),
    (90, '842092000120', 'Silver Smith Motueka Pils'),
    (91, '679546002054', 'Silver Smith Nut Brown Ale'),
    (92, '842092000014', 'Silver Smith The Black Lager'),
    (93, '031146021857', 'Sin Noodle'),
    (97, '5000104123280', 'Strongbow'),
    (100, '627843351009', 'Triple Bogey Lager'),
    (101, '627843494430', 'Triple Bogey Transfusion Classic'),
    (102, '627843494409', 'Triple Bogey Ultra'),
    (106, '848819000985', 'White Claw Black Berry'),
    (107, '848819000008', 'White Claw Black Cherry'),
    (251, '062067567346', 'bud light small'),
    (252, '687181947746', 'Pure Drive Cherry Lime'),
    (253, '627843494461', 'Triple Bogey Azalea'),
    (254, '628233970046', 'Triple Bogey Transfusion Orange'),
    (255, '627843494447', 'Triple Bogey Transfusion Cranberry'),
    (256, '628233970145', 'Triple Bogey Water Hazard'),
    (257, '627843494454', 'Triple Bogey Half & Half'),
    (258, '062067382338', 'Corona Extra'),
    (259, '627843580232', 'Henderson''s Best Amber Ale'),
    (260, '842092000007', 'Silversmith Altar Ego Ipa'),
    (261, '627843546962', 'Divercity'),
    (262, '065912002795', 'Clamato Spicy Caeser'),
    (263, '05490733', 'Dr. Pepper'),
    (264, '069000013748', 'Pepsi Zero'),
    (265, '069000009918', 'Pepsi'),
    (266, '069000019832', 'Pepsi Diet'),
    (267, '4809010272010', '7D Dried Mangoes'),
    (268, '059966105809', 'Trophy Cranberry Trail Mix'),
    (269, '060410074848', 'Munchies'),
    (270, '687456283340', 'Made Good Soft Baked Cookie Bites'),
    (271, '059800000116', 'Aero'),
    (272, '058496812324', 'M&M'),
    (273, '073390000110', 'Mentos Mint'),
    (274, '05986034', 'Smarties'),
    (275, '065633505896', 'Fibre 1 Oats & Chocolate'),
    (276, '056600793217', 'Reese''s Peanut Butter Cups'),
    (277, '4039311', 'M&M Milk Chocolate'),
    (278, '8801073210776', 'Buldak'),
    (279, '031146020393', 'Udon'),
    (280, '060410071953-', 'Doritos Nacho Cheese'),
    (281, '060410001578', 'Lay''s Bar-B-Q'),
    (282, '060410001660', 'Ruffles All Dressed'),
    (283, '196633912398', 'Sea Salt Popcorn Kirkland'),
    (284, '057271162562', 'Gatorade Orange Zero'),
    (285, '055577420263', 'Gatorade Fruit Punch'),
    (286, '057271162609', 'Gatorade Zero Berry'),
    (287, '057271162586', 'Gatorade Zero Lemon Lime'),
    (288, '889392607277', 'Celsius Peach Vibe'),
    (289, '889392607239', 'Celsius Tropical Vibe'),
    (290, 'LS-458', 'Beer & Cooler');

with todo as (
  select r.id, r.barcode, r.name, p.barcode as current_barcode,
         exists (select 1 from public.pelham_retail_products o
                 where o.id <> r.id and lower(o.barcode) = lower(r.barcode)) as taken
  from restore_barcodes r
  join public.pelham_retail_products p on p.id = r.id
  where p.barcode is distinct from r.barcode
),
done as (
  update public.pelham_retail_products p
     set barcode = t.barcode, updated_at = now()
    from todo t
   where p.id = t.id and not t.taken
  returning p.id
)
select t.name, t.current_barcode as was, t.barcode as restored,
       case when t.taken then 'skipped (barcode used by another product)' else 'restored' end as result
  from todo t
 order by result, t.name;
