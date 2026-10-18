/**
 * 리테일 서버가 없을 때 보여 주는 **읽기 전용 예시 데이터**(상품·저재고).
 * 매출 예시는 없다 — 매출은 Reports 한 곳에서만 보고, 거기는 가짜 숫자를 띄우지 않는다.
 *
 * 왜 필요한가: 백엔드가 아직 없거나 꺼져 있을 때 화면이 텅 비면 직원은
 * "앱이 고장났다" 고 판단하고 닫는다. 무엇을 보게 될 화면인지는 보여 주되,
 * 배너로 "예시" 라고 못박고 Charge·저장 버튼을 전부 비활성화한다 —
 * 저장된 줄 알았는데 아무 데도 안 남는 것이 빈 화면보다 훨씬 나쁘다.
 *
 * 계약 타입(`Product`/`LowStockItem`)을 그대로 붙여 둔다.
 * 그래야 계약이 바뀌었을 때 tsc 가 여기서 먼저 걸어 준다.
 */

import type { LowStockItem, Product } from "@/lib/retail/types";

const NOW = "2026-09-08T14:20:00Z";

function product(
  id: number,
  sku: string,
  name: string,
  category: Product["category"],
  price: number,
  cost: number,
  stock: number | null,
  reorder_point = 4,
  is_active = true,
): Product {
  return {
    id,
    sku,
    name,
    category,
    price,
    cost,
    stock,
    reorder_point,
    is_active,
    created_at: NOW,
    updated_at: NOW,
  };
}

/** 계산대 폴더(0030)를 예시 화면에서도 보이게. 없는 id 는 그룹 없음. */
const DEMO_GROUPS: Record<number, string> = {
  1: "Golf Balls",
  2: "Golf Balls",
  4: "Shirts",
  5: "Hats",
  6: "Outerwear",
  7: "Gloves",
  12: "Beer",
  13: "Hot Food",
  14: "Drinks",
};

export const demoProducts: Product[] = [
  product(1, "PH-BALL-PV1", "Titleist Pro V1 (dozen)", "Balls", 8499, 5400, 18),
  product(2, "PH-BALL-CHR", "Callaway Chrome Soft (dozen)", "Balls", 7499, 4800, 3),
  product(3, "PH-BALL-RNG", "Range balls (bucket of 60)", "Balls", 1200, 300, 120, 30),
  product(4, "PH-POLO-M", "Pelham Hills crest polo", "Apparel", 6900, 3100, 11),
  product(5, "PH-CAP-NAV", "Club cap — navy", "Apparel", 3200, 1150, 26, 10),
  product(6, "PH-VEST-W", "Ladies' quarter-zip vest", "Apparel", 8900, 4200, 2),
  product(7, "PH-GLV-L", "Cabretta glove — left", "Accessories", 2799, 1250, 34, 12),
  product(8, "PH-TEE-BMB", "Bamboo tees (100 ct)", "Accessories", 999, 320, 61, 20),
  product(9, "PH-MARK-BR", "Brass ball marker", "Accessories", 1499, 500, 7),
  product(10, "PH-WEDG-56", "Vokey SM10 wedge 56°", "Equipment", 22900, 15600, 4, 2),
  product(11, "PH-PUTT-B2", "Blade putter — 34\"", "Equipment", 19900, 12800, 1, 2),
  product(12, "PH-BEER-DFT", "Draught pint", "Food & Beverage", 800, 240, 200, 48),
  product(13, "PH-HOTDOG", "Turn dog", "Food & Beverage", 650, 190, 40, 24),
  product(14, "PH-WATER", "Bottled water", "Food & Beverage", 300, 60, 180, 60),
  // 렌탈은 재고 개념이 없어서 `stock: null` 이다. 이 한 줄이 화면 곳곳의
  // null 처리를 실제로 밟게 해 준다 — 없으면 배포하고 나서야 터진다.
  product(15, "PH-RENT-CART", "Power cart — 18 holes", "Rentals", 3800, 0, null, 0),
  product(16, "PH-RENT-CLUB", "Rental clubs — full set", "Rentals", 4500, 0, null, 0),
  product(17, "PH-BALL-OLD", "Discontinued 2024 logo balls", "Balls", 4900, 3900, 0, 0, false),
].map((item) => ({ ...item, menu_group: DEMO_GROUPS[item.id] ?? null }));

export const demoLowStock: LowStockItem[] = [
  {
    product_id: 11,
    sku: "PH-PUTT-B2",
    name: 'Blade putter — 34"',
    category: "Equipment",
    stock: 1,
    reorder_point: 2,
  },
  {
    product_id: 6,
    sku: "PH-VEST-W",
    name: "Ladies' quarter-zip vest",
    category: "Apparel",
    stock: 2,
    reorder_point: 4,
  },
  {
    product_id: 2,
    sku: "PH-BALL-CHR",
    name: "Callaway Chrome Soft (dozen)",
    category: "Balls",
    stock: 3,
    reorder_point: 4,
  },
];
