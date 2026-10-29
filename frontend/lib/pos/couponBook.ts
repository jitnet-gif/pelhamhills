/**
 * 쿠폰북 무료 라운드(0137) — GPS 앱 쿠폰북(라운드 10번 = 1번 무료)을 티 시트 계산서에서 쓴다.
 * 함수 이름과 인자는 `supabase/migrations/0137_coupon_book_free_round.sql` 와 글자 그대로 같다.
 *
 * 선수 → GPS 계정 찾기, 남은 무료 판정, 도장 정리는 전부 서버가 한다. 무료는 그 선수 줄의 그린피만 0 으로 만든다.
 * 라운드 100번마다 기념품(0138, GPS 0029)은 계산서 금액과 상관없이 장부에만 "줬다" 를 남긴다.
 */

import { staffRpc } from "@/lib/teeSheet/staffRpc";
import type { Cents } from "@/lib/retail/types";

import type { Bill } from "./api";

/** 계산서 그린피 줄 하나의 쿠폰북. 쿠폰북을 찾은 선수만 온다. */
export type BillCoupon = {
  line_id: number;
  name: string;
  free_left: number;
  /** 판 위의 도장(0–9). */
  on_card: number;
  is_member: boolean;
  /** 이 줄에 무료 라운드를 썼다. */
  applied: boolean;
  /** applied 면 그 줄에서 깎은 센트. */
  amount: Cents;
  /** 누적 라운드(도장 + 쓴 무료). 0138 전 서버는 주지 않는다. */
  rounds?: number;
  /** 받을 기념품 수(라운드 100번마다 하나). */
  gift_due?: number;
  rounds_to_gift?: number;
  /** 이 예약 자리로 기념품을 이미 줬다. */
  gift_given?: boolean;
};

/** 기념품 하나에 라운드 몇 번. 서버(GPS 0029)의 100 과 같아야 한다. */
export const ROUNDS_PER_GIFT = 100;

export const couponBookApi = {
  forBill: (bill: number) => staffRpc<BillCoupon[]>("pelham_staff_bill_coupons", { p_bill: bill }),
  use: (bill: number, line: number) =>
    staffRpc<Bill>("pelham_staff_bill_use_free_round", { p_bill: bill, p_line: line }),
  undo: (bill: number, line: number) =>
    staffRpc<Bill>("pelham_staff_bill_undo_free_round", { p_bill: bill, p_line: line }),
  giveGift: (bill: number, line: number) =>
    staffRpc<BillCoupon[]>("pelham_staff_bill_give_gift", { p_bill: bill, p_line: line }),
  undoGift: (bill: number, line: number) =>
    staffRpc<BillCoupon[]>("pelham_staff_bill_undo_gift", { p_bill: bill, p_line: line }),
};
