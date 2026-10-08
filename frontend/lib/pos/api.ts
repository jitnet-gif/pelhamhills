/**
 * 합산 계산서(그린피 + 프로 샵 + 스낵바)의 **유일한** 통로.
 * 함수 이름과 인자는 `supabase/migrations/0005_pos_bills.sql` 와 글자 그대로 같다.
 *
 * 전송은 티 시트와 같은 `staffRpc`(직원 로그인 토큰 + 공개 키)다. 오류는 `ApiError` 로 온다:
 * status 0 = 연결 실패, 401 = 로그인, 404 = 없음(또는 0005 가 아직 안 돌았다), 409 = 상태 충돌,
 * 422 = 입력 오류. `describePosError` 가 사람이 읽을 문장으로 바꾼다.
 */

import { ApiError } from "@/lib/teeSheet/api";
import { staffRpc } from "@/lib/teeSheet/staffRpc";
import type { Cents, PaymentMethod, Sale } from "@/lib/retail/types";

export type BillStation = "pro_shop" | "snack_bar" | "tee_sheet" | "simulator";

/** 계산서 한 장. 결제된 계산서는 기존 `Sale` 과 같은 필드를 갖는다. */
export type Bill = Omit<Sale, "lines" | "status" | "receipt_no"> & {
  status: "open" | "paid" | "refunded" | "void";
  station: BillStation;
  label: string | null;
  checkout_id: string | null;
  opened_at: string;
  paid_at: string | null;
  /** 열린 계산서에는 아직 없다. */
  receipt_no: string;
  lines: BillLine[];
};

export type BillLine = Sale["lines"][number] & {
  id: number;
  /** sim_booking = 실내 골프 베이 예약(0008). 날짜·시각은 tee_date·tee_time 칸을 같이 쓴다. */
  kind: "product" | "tee_player" | "sim_booking";
  category: string;
  booking_id: string | null;
  player_id: string | null;
  tee_date: string | null;
  tee_time: string | null;
};

export type PaymentInput = {
  method: PaymentMethod;
  amount: Cents;
  tip?: Cents;
  /** 카드·체크카드: Chase 단말기가 찍어 준 승인번호. 없으면 서버가 거절한다. */
  auth_code?: string;
  card_last4?: string;
  /** 레인체크: 전표 코드(`RC-…`). 서버가 잠그고 상태·만료일·금액을 확인한다(0011). */
  rain_check_code?: string;
  /**
   * 단말기 연동(0019): `pelham_terminal_transactions.id`. 있으면 서버가 승인번호·끝 4자리를 단말기
   * 기록에서 읽고, 금액·팁이 단말기 결과와 같은지 본다(`entry = 'integrated'`).
   */
  terminal_txn?: number;
};

/** 단말기 승인번호가 필요한 결제 수단. */
export const TERMINAL_METHODS: readonly PaymentMethod[] = ["card", "debit"];

export const posApi = {
  open: (fields: { station: BillStation; label?: string; cashier?: string; note?: string }) =>
    staffRpc<Bill>("pelham_staff_bill_open", { p: fields }),
  listOpen: () => staffRpc<Bill[]>("pelham_staff_bills_open"),
  get: (id: number) => staffRpc<Bill>("pelham_staff_bill", { p_id: id }),
  addProduct: (bill: number, product: number, quantity = 1) =>
    staffRpc<Bill>("pelham_staff_bill_add_product", { p_bill: bill, p_product: product, p_quantity: quantity }),
  updateLine: (bill: number, line: number, fields: { quantity?: number; discount?: Cents }) =>
    staffRpc<Bill>("pelham_staff_bill_line_update", { p_bill: bill, p_line: line, p: fields }),
  update: (bill: number, fields: { discount?: Cents; cashier?: string; note?: string; label?: string }) =>
    staffRpc<Bill>("pelham_staff_bill_update", { p_bill: bill, p: fields }),
  /** players 를 비우면 그 예약에서 아직 안 낸 사람 전부. */
  addTee: (bill: number, booking: string, players?: string[]) =>
    staffRpc<Bill>("pelham_staff_bill_add_tee", {
      p_bill: bill,
      p_booking: booking,
      p_players: players && players.length > 0 ? players : null,
    }),
  /** 실내 골프 베이 예약 하나(0008). 계산서가 결제되면 예약이 paid 가 된다. */
  addSim: (bill: number, reservation: number) =>
    staffRpc<Bill>("pelham_staff_bill_add_sim", { p_bill: bill, p_reservation: reservation }),
  void: (bill: number) => staffRpc<Bill>("pelham_staff_bill_void", { p_bill: bill }),
  pay: (bill: number, checkoutId: string, payments: PaymentInput[]) =>
    staffRpc<Bill>("pelham_staff_bill_pay", { p_bill: bill, p: { checkout_id: checkoutId, payments } }),
  refund: (bill: number, reason: string) =>
    staffRpc<Bill>("pelham_staff_bill_refund", { p_bill: bill, p_reason: reason }),
  listPaid: (businessDate: string) => staffRpc<Bill[]>("pelham_staff_bills", { p_date: businessDate }),
  byReceipt: (receipt: string) => staffRpc<Bill>("pelham_staff_bill_by_receipt", { p_receipt: receipt }),
};

/**
 * 0005 마이그레이션이 아직 이 프로젝트에 없다. PostgREST 는 없는 함수를 404(`PGRST202`)로 준다.
 * "계산서를 찾을 수 없음"(PT404)도 404 라서 문장으로 가른다.
 */
export function isMissingMigration(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 404 &&
    /could not find the function|PGRST202|schema cache/i.test(error.message)
  );
}

export const MISSING_MIGRATION_MESSAGE =
  "계산서 기능이 아직 켜지지 않았습니다. Supabase SQL Editor 에서 0005_pos_bills.sql 을 실행해 주세요.";

export function describePosError(error: unknown): string {
  if (isMissingMigration(error)) return MISSING_MIGRATION_MESSAGE;
  if (error instanceof ApiError) {
    if (error.status === 0) return "서버에 연결할 수 없습니다. 인터넷 연결을 확인하고 다시 시도해 주세요.";
    return error.message;
  }
  return "알 수 없는 오류가 났습니다. 다시 시도해 주세요.";
}

/** 결제 버튼을 누를 때마다 하나. 재시도는 같은 값을 다시 쓴다(서버가 두 번 받지 않는다). */
export function newCheckoutId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  // 오래된 브라우저. 형식만 UUID v4 면 된다.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}
