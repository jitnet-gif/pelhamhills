/**
 * Stripe 대사(Reports → Stripe check) — Stripe 가 실제로 받은·돌려준 카드 돈과 우리 기록을 맞춘 결과.
 *
 * 대조는 서버(FastAPI `GET /payments/reconcile`, `backend/services/stripe_reconcile.py`)가 한다. Stripe
 * 비밀 키가 그 서버에만 있기 때문이다. 여기는 결과를 받아 화면과 .xlsx 파일 모델로 바꾼다.
 * 한 줄 = PaymentIntent(`pi_…`) 하나. 금액은 센트.
 */

import { paymentsApiBase } from "@/lib/booking/payments";
import { CLUB_TIME_ZONE } from "@/lib/retail/receipt";
import { ApiError } from "@/lib/teeSheet/api";
import { accessToken } from "@/lib/teeSheet/session";

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
};

export type ReconcileRow = {
  key: string;
  source: "terminal" | "online" | "unknown";
  at: string | null;
  level: Level;
  issues: ReconcileIssue[];
  stripe: StripeSide | null;
  ours: OurSide | null;
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
  };
  rows: ReconcileRow[];
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

// ===== 보이기 ==========================================================

export const LEVEL_LABEL: Record<Level, string> = { error: "Problem", warn: "Check", ok: "Matched" };

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
      LEVEL_LABEL[row.level],
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
      row.issues.map((issue) => issue.message).join(" "),
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
