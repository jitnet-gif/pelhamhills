/**
 * 종합 매출 리포트의 다섯 사업부 — 티 시트, 실내 베이, 스낵바, 리테일, 회원권.
 *
 * **팔린 것(줄의 분류)** 으로 나눈다. 계산서를 연 자리(`station`)로 나누지 않는다: 티 시트에서
 * 스캔한 모자도, 프로 샵에서 받은 그린피도 한 계산서에 섞이기 때문이다(0005·c483056).
 * 분류는 서로 겹치지 않는다 — 그린피 줄은 `Green Fees`, 베이 줄은 `Simulator`(0008), 상품은
 * `pelham_retail_products_category_check` 의 여섯 개뿐이다. 회원권 줄은 `Memberships`(0072). 그래서 다섯 칸의 합은 리포트의
 * `gross` 와 같다(둘 다 결제된 계산서의 살아 있는 줄 `line_total` 합).
 *
 * 주문 할인·세금·팁·결제 수단은 계산서 단위라 사업부로 쪼개지 않는다.
 */

import type { Cents, RetailDailyReport } from "./types";

export type DivisionKey = "tee_sheet" | "indoor" | "snack_bar" | "retail" | "memberships";

export const DIVISIONS: ReadonlyArray<{ key: DivisionKey; label: string }> = [
  { key: "tee_sheet", label: "Tee Sheet" },
  { key: "indoor", label: "Indoor Simulator" },
  { key: "snack_bar", label: "Snack Bar" },
  { key: "retail", label: "Pro Shop Retail" },
  { key: "memberships", label: "Memberships" },
];

/** 모르는 상품 분류는 리테일이다 — 상품이면 프로 샵 물건이다. */
export function divisionOf(category: string): DivisionKey {
  if (category === "Green Fees") return "tee_sheet";
  if (category === "Simulator") return "indoor";
  if (category === "Food & Beverage") return "snack_bar";
  if (category === "Memberships") return "memberships";
  return "retail";
}

export type DivisionTotal = {
  key: DivisionKey;
  label: string;
  quantity: number;
  total: Cents;
  categories: RetailDailyReport["by_category"];
};

/** 다섯 칸을 늘 같은 순서로, 판매가 없는 사업부도 0 으로 돌려준다. */
export function divisionTotals(report: RetailDailyReport): DivisionTotal[] {
  return DIVISIONS.map(({ key, label }) => {
    const categories = report.by_category.filter((row) => divisionOf(row.category) === key);
    return {
      key,
      label,
      categories,
      quantity: categories.reduce((sum, row) => sum + row.quantity, 0),
      total: categories.reduce((sum, row) => sum + row.total, 0),
    };
  });
}
