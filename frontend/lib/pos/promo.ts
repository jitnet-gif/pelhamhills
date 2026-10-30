/**
 * 프로모션 코드(0078) — Promotions 화면에서 만들고, 바코드(`PROMO-` + 코드)를 찍으면 계산서 할인이 된다.
 * 함수 이름과 인자는 `supabase/migrations/0078_promo_codes.sql` 와 글자 그대로 같다.
 *
 * 할인 금액·만료·사용 한도는 전부 서버가 판정한다. 할인은 계산서의 그린피 줄에만 붙는다.
 */

import { staffRpc } from "@/lib/teeSheet/staffRpc";
import type { Cents } from "@/lib/retail/types";

import type { Bill } from "./api";

export type PromoState = "active" | "scheduled" | "expired" | "used_up" | "paused";

export type Promotion = {
  id: number;
  code: string;
  /** 바코드 값. `PROMO-` + code. */
  barcode: string;
  name: string;
  /** amount = value 가 센트, percent = value 가 % */
  kind: "amount" | "percent";
  value: number;
  /** amount 일 때 그린피 인원마다(true) 또는 계산서당 한 번(false). */
  per_player: boolean;
  conditions: string | null;
  starts_on: string | null;
  expires_on: string | null;
  usage_limit: number | null;
  active: boolean;
  /** 결제된 계산서 수. */
  used: number;
  /** 아직 결제 안 된 열린 계산서에 걸린 수. */
  held: number;
  state: PromoState;
  created_at: string;
};

export type PromotionInput = {
  id?: number;
  code?: string;
  name: string;
  kind: Promotion["kind"];
  value: number;
  per_player?: boolean;
  conditions?: string;
  starts_on?: string | null;
  expires_on?: string | null;
  usage_limit?: number | null;
  active?: boolean;
};

/** 계산서에 걸린 코드. amount 는 그 계산서에서 뺀 센트. */
export type BillPromo = Pick<Promotion, "code" | "name" | "kind" | "value" | "per_player" | "conditions"> & {
  amount: Cents;
};

export const promoApi = {
  list: () => staffRpc<Promotion[]>("pelham_staff_promotions"),
  save: (promotion: PromotionInput) => staffRpc<Promotion>("pelham_staff_promotion_save", { p: promotion }),
  byCode: (code: string) => staffRpc<Promotion>("pelham_staff_promotion", { p_code: code }),
  apply: (bill: number, code: string) =>
    staffRpc<Bill>("pelham_staff_bill_apply_promo", { p_bill: bill, p_code: code }),
  remove: (bill: number) => staffRpc<Bill>("pelham_staff_bill_remove_promo", { p_bill: bill }),
  forBill: (bill: number) => staffRpc<BillPromo | null>("pelham_staff_bill_promo", { p_bill: bill }),
};

/** 스캐너가 읽은 값이 프로모션 바코드인가. 손으로 친 코드(FALL18)는 계산서의 Promo code 칸으로 받는다.
 *  `CPN-` + 16진 10자는 GPS 앱 지갑의 개인 쿠폰(0121) — 서버에서는 같은 프로모션 줄이라 같은 길로 간다. */
export const PROMO_BARCODE = /^(PROMO-[A-Z0-9]{3,16}|CPN-[0-9A-F]{10})$/i;

export function isPromoBarcode(raw: string): boolean {
  return PROMO_BARCODE.test(raw.trim());
}

export function promoDiscountLabel(promo: Pick<Promotion, "kind" | "value" | "per_player">): string {
  if (promo.kind === "percent") return `${promo.value}% off green fees`;
  const dollars = promo.value % 100 === 0 ? `$${promo.value / 100}` : `$${(promo.value / 100).toFixed(2)}`;
  return promo.per_player ? `${dollars} off per player` : `${dollars} off the bill`;
}

export const PROMO_STATE_LABEL: Record<PromoState, string> = {
  active: "Active",
  scheduled: "Scheduled",
  expired: "Expired",
  used_up: "Used up",
  paused: "Paused",
};
