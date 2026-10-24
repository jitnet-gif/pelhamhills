/**
 * Stripe 대사(Reports → Stripe check) — Stripe 가 실제로 받은·돌려준 카드 돈과 우리 기록을 맞춘 결과.
 *
 * 대조는 서버(FastAPI `GET /payments/reconcile`, `backend/services/stripe_reconcile.py`)가 한다. Stripe
 * 비밀 키가 그 서버에만 있기 때문이다. 여기는 결과를 받아 화면과 .xlsx 파일 모델로 바꾼다.
 * 한 줄 = PaymentIntent(`pi_…`) 하나. 금액은 센트.
 */

import { paymentsApiBase } from "@/lib/booking/payments";
import { isMissingMigration } from "@/lib/pos/api";
import { CLUB_TIME_ZONE } from "@/lib/retail/receipt";
import type { Sale } from "@/lib/retail/types";
import { ApiError } from "@/lib/teeSheet/api";
import { accessToken } from "@/lib/teeSheet/session";
import { staffRpc } from "@/lib/teeSheet/staffRpc";

import type { Row, Workbook } from "./accountingWorkbook";

export type Level = "ok" | "warn" | "error";

export type ReconcileIssue = { level: "warn" | "error"; code: string; message: string };

export type StripeSide = {
  payment_intent: string;
  charge: string;
  status: string;
  created: number;
  amount: number;
  refunded: number;
  disputed: boolean;
  method: string;
  card_brand: string;
  card_last4: string;
  description: string;
};

export type OurSide = {
  source: "terminal" | "online";
  id: number;
  status: string;
  amount: number;
  refunded: number;
  refund_ids: string[];
  created_at: string | null;
  bill_id: number | null;
  bill_status: "open" | "paid" | "refunded" | "void" | null;
  receipt_no: string | null;
  business_date: string | null;
  card_brand: string | null;
  card_last4: string | null;
  label: string;
  customer_name?: string | null;
  /** 단말기 승인을 계산서에 쓰기 전에 VOID 했다(0019). */
  voided?: boolean;
  /** 단말기만. amount 안의 팁(계산서 합계 밖). */
  tip?: number;
  /** 단말기만. 계산서 결제 줄에 붙었나. */
  on_bill?: boolean;
  /** 단말기만. credit · debit(Interac 환불은 리더에 카드를 다시 댄다). */
  card_type?: "credit" | "debit" | "gift" | "ebt" | null;
  pending_refunds?: number;
};

/** 상세 창에서 정한 것(0089). sale = 매출로 반영, refund = 카드 환불, note = 그대로 둠(이유). */
export type ReconcileDecision = {
  id: number;
  payment_intent: string;
  terminal_txn_id: number | null;
  decision: "sale" | "refund" | "note";
  note: string | null;
  staff_name: string | null;
  bill_id: number | null;
  amount: number;
  created_at: string;
};

/** 카드에서 돈이 빠지지 않은 시도 — Stripe 대시보드의 Canceled·Incomplete. 대사(rows)에는 들어가지 않는다. */
export type StripeAttempt = {
  payment_intent: string;
  at: string;
  status: string;
  status_label: string;
  amount: number;
  reason: string;
  message: string;
  source: "terminal" | "online" | "unknown";
  card_brand: string;
  card_last4: string;
  label: string;
};

export type ReconcileRow = {
  key: string;
  source: "terminal" | "online" | "unknown";
  at: string | null;
  level: Level;
  issues: ReconcileIssue[];
  stripe: StripeSide | null;
  ours: OurSide | null;
  /** 이 PaymentIntent 의 마지막 결정(0089). Fly 서버가 2026-10-23 판 이후일 때만 온다. */
  decision?: ReconcileDecision | null;
  /** 그대로 두기로 정해서 문제로 세지 않는 줄. */
  reviewed?: boolean;
};

export type ReconcileReport = {
  environment: "test" | "live";
  from: string;
  to: string;
  generated_at: string;
  summary: {
    stripe_charged: number;
    stripe_refunded: number;
    stripe_net: number;
    ours_charged: number;
    ours_refunded: number;
    ours_net: number;
    difference: number;
    errors: number;
    warnings: number;
    matched: number;
    rows: number;
    outside_window: number;
    /** 아래 넷은 Fly 서버가 2026-10-23 판 이후일 때만 온다. */
    attempts?: number;
    attempts_amount?: number;
    voided?: number;
    voided_amount?: number;
    reviewed?: number;
  };
  rows: ReconcileRow[];
  attempts?: StripeAttempt[];
  keyed: { count: number; amount: number };
  truncated: boolean;
  unchecked: number;
};

export const MAX_DAYS = 31;

export async function fetchReconcile(from: string, to: string): Promise<ReconcileReport> {
  const token = await accessToken();
  if (!token) throw new ApiError(401, "Sign in with a pro shop account.");
  const query = new URLSearchParams({ from, to });
  let response: Response;
  try {
    response = await fetch(`${paymentsApiBase()}/payments/reconcile?${query}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    throw new ApiError(0, "Could not reach the payments server.");
  }
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`.trim();
    try {
      const body = (await response.json()) as { detail?: unknown };
      if (typeof body?.detail === "string" && body.detail) message = body.detail;
    } catch {
      // JSON 이 아닌 오류 본문. 상태 줄을 그대로 쓴다.
    }
    throw new ApiError(response.status, message);
  }
  return (await response.json()) as ReconcileReport;
}

// ===== 정하기 (0089) ===================================================

export const DECISIONS_MISSING_MESSAGE =
  "Deciding from the Stripe check is not switched on yet. Run 0089_reconcile_decisions.sql in the Supabase SQL Editor.";

async function decisionCall<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  try {
    return await staffRpc<T>(fn, args);
  } catch (cause) {
    if (isMissingMigration(cause)) throw new ApiError(404, DECISIONS_MISSING_MESSAGE);
    throw cause;
  }
}

/** 매출로 반영: 단말기 승인을 계산서의 카드 결제로 붙이고 계산서를 끝낸다(void 계산서는 되살린다). */
export function keepAsSale(terminalTxn: number, note: string) {
  return decisionCall<{ bill: Sale; decision: ReconcileDecision }>("pelham_staff_reconcile_keep", {
    p_txn: terminalTxn,
    p_note: note.trim() || null,
  });
}

/** 카드 환불을 마친 뒤(refund), 또는 그대로 둘 때(note — 이유 필수) 결정을 남긴다. */
export function recordDecision(input: {
  payment_intent: string;
  decision: "refund" | "note";
  note?: string;
  terminal_txn?: number | null;
}) {
  return decisionCall<ReconcileDecision>("pelham_staff_reconcile_decide", {
    p: { ...input, note: input.note?.trim() || null },
  });
}

// ===== 보이기 ==========================================================

export const LEVEL_LABEL: Record<Level, string> = { error: "Problem", warn: "Check", ok: "Matched" };

export const DECISION_LABEL: Record<ReconcileDecision["decision"], string> = {
  sale: "Counted as sale",
  refund: "Refunded to card",
  note: "Left as is",
};

export const SOURCE_LABEL: Record<ReconcileRow["source"], string> = {
  terminal: "Register (S700)",
  online: "Online",
  unknown: "Unknown",
};

export function stripeUrl(environment: "test" | "live", paymentIntent: string): string {
  return `https://dashboard.stripe.com/${environment === "test" ? "test/" : ""}payments/${paymentIntent}`;
}

export function clubTime(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("en-CA", {
    timeZone: CLUB_TIME_ZONE,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function cardText(row: ReconcileRow): string {
  const brand = row.stripe?.card_brand || row.ours?.card_brand || "";
  const last4 = row.stripe?.card_last4 || row.ours?.card_last4 || "";
  return [brand && brand[0].toUpperCase() + brand.slice(1), last4 && `•${last4}`].filter(Boolean).join(" ");
}

/** 두 쪽의 순액 차이(Stripe − 우리). */
export function rowDifference(row: ReconcileRow): number {
  const stripe = row.stripe ? row.stripe.amount - row.stripe.refunded : 0;
  const ours = row.ours ? row.ours.amount - row.ours.refunded : 0;
  return stripe - ours;
}

// ===== 엑셀 ============================================================

const cents = (value: number) => Math.round(value) / 100;

export function buildReconcileWorkbook(report: ReconcileReport): Workbook {
  const s = report.summary;
  const rows: Row[] = report.rows.map((row) => ({
    cells: [
      row.reviewed ? "Reviewed" : LEVEL_LABEL[row.level],
      clubTime(row.at),
      SOURCE_LABEL[row.source],
      cardText(row),
      row.stripe?.payment_intent ?? "",
      row.stripe ? cents(row.stripe.amount) : null,
      row.stripe ? cents(row.stripe.refunded) : null,
      row.ours?.label ?? "",
      row.ours?.receipt_no ?? "",
      row.ours?.bill_status ?? "",
      row.ours ? cents(row.ours.amount) : null,
      row.ours ? cents(row.ours.refunded) : null,
      cents(rowDifference(row)),
      [
        row.issues.map((issue) => issue.message).join(" "),
        row.decision
          ? `${DECISION_LABEL[row.decision.decision]}${row.decision.staff_name ? ` by ${row.decision.staff_name}` : ""}` +
            (row.decision.note ? `: ${row.decision.note}` : "")
          : "",
      ]
        .filter(Boolean)
        .join(" — "),
    ],
  }));
  rows.push({
    style: "total",
    cells: [
      "Total", "", "", "", "",
      cents(s.stripe_charged), cents(s.stripe_refunded), "", "", "",
      cents(s.ours_charged), cents(s.ours_refunded), cents(s.difference),
      `${s.errors} problem(s), ${s.warnings} to check, ${s.matched} matched`,
    ],
  });
  const range = report.from === report.to ? report.from : `${report.from} to ${report.to}`;
  return {
    from: report.from,
    to: report.to,
    sheets: [
      {
        name: "Stripe check",
        title: `Stripe reconciliation — ${range}`,
        subtitle:
          `Stripe ${report.environment} mode · Stripe net ${cents(s.stripe_net).toFixed(2)} · ` +
          `our records net ${cents(s.ours_net).toFixed(2)} · difference ${cents(s.difference).toFixed(2)} · ` +
          `generated ${new Date(report.generated_at).toLocaleString("en-CA", { timeZone: CLUB_TIME_ZONE })}`,
        filter: true,
        columns: [
          { header: "Status", width: 10, format: "text" },
          { header: "Time", width: 16, format: "text" },
          { header: "Source", width: 15, format: "text" },
          { header: "Card", width: 13, format: "text" },
          { header: "Stripe payment", width: 30, format: "text" },
          { header: "Stripe charged", width: 13, format: "money" },
          { header: "Stripe refunded", width: 13, format: "money" },
          { header: "Our record", width: 24, format: "text" },
          { header: "Receipt", width: 18, format: "text" },
          { header: "Bill", width: 10, format: "text" },
          { header: "Our charged", width: 13, format: "money" },
          { header: "Our refunded", width: 13, format: "money" },
          { header: "Difference", width: 12, format: "money" },
          { header: "What to check", width: 70, format: "text" },
        ],
        rows,
      },
    ],
  };
}
