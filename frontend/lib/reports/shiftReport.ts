/**
 * 근무 마감표(Shift report) — Daily close 의 **Print** 가 영수증 프린터로 찍는 한 장(2026-10-22).
 *
 * 담당자 이름과 시작·끝 시각을 적으면, 그날 계산서 중 **그 사이에 결제된 것만** 모아 합계만 찍는다.
 * 계산서 목록(트랜잭션)은 찍지 않는다 — 클럽이 원한 것은 숫자 열한 줄이다.
 *
 * 숫자는 서버 리포트가 아니라 화면이 이미 받은 계산서(`listSales`)에서 센다. 서버 리포트는 하루
 * 단위라 시각으로 자를 수 없어서다. 규칙은 리포트와 같게 맞춘다:
 * - 환불된 계산서는 매출·결제에서 빼고 Refund 에만 센다(서버 `gross`/`net` 과 같다).
 * - 매출은 세금 포함(손님에게 받은 돈, Total Collected 와 같은 뜻). 팁은 매출이 아니라 뺀다.
 * - 사업부는 팔린 것(분류)으로 나눈다(`divisions.ts`). 계산서 합계를 줄 금액 비율로 사업부에 나눠
 *   주문 할인·세금까지 들어가게 한다 — 그래서 사업부 다섯 줄의 합이 Total Sales 와 센트까지 같다.
 *   실내 베이(Indoor Simulator)는 "Other" 로 간다.
 */

import { CLUB_TIME_ZONE, PAYMENT_LABELS, type ReceiptBlock, type ReceiptHeader } from "@/lib/retail/receipt";
import { divisionOf, type DivisionKey } from "@/lib/retail/divisions";
import { formatMoney, type Cents, type PaymentMethod, type Sale } from "@/lib/retail/types";

export type ShiftInput = {
  staff: string;
  /** 영업일 `YYYY-MM-DD`. */
  date: string;
  /** `HH:MM`(24시간). 이 PC 의 현지 시각 — `localBusinessDate` 와 같은 가정이다. */
  start: string;
  end: string;
};

export type ShiftSummary = {
  saleCount: number;
  totalSales: Cents;
  divisions: Record<"tee_sheet" | "pro_shop" | "snack_bar" | "membership" | "other", Cents>;
  payments: Record<"cash" | "card" | "debit" | "rain_check" | "other", Cents>;
  refundCount: number;
  refundTotal: Cents;
};

const DIVISION_SLOT: Record<DivisionKey, keyof ShiftSummary["divisions"]> = {
  tee_sheet: "tee_sheet",
  retail: "pro_shop",
  snack_bar: "snack_bar",
  memberships: "membership",
  indoor: "other",
};

const PAYMENT_SLOT: Partial<Record<PaymentMethod, keyof ShiftSummary["payments"]>> = {
  cash: "cash",
  card: "card",
  debit: "debit",
  rain_check: "rain_check",
};

/** 시작·끝을 이 PC 시각의 순간으로. 끝이 시작보다 이르면 자정을 넘긴 근무로 본다. */
export function shiftWindow(input: ShiftInput): { from: number; to: number } | null {
  if (!/^\d{2}:\d{2}$/.test(input.start) || !/^\d{2}:\d{2}$/.test(input.end)) return null;
  const from = new Date(`${input.date}T${input.start}:00`).getTime();
  let to = new Date(`${input.date}T${input.end}:59.999`).getTime();
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  if (to < from) to += 24 * 60 * 60 * 1000;
  return { from, to };
}

export function shiftSummary(sales: readonly Sale[], window: { from: number; to: number }): ShiftSummary {
  const summary: ShiftSummary = {
    saleCount: 0,
    totalSales: 0,
    divisions: { tee_sheet: 0, pro_shop: 0, snack_bar: 0, membership: 0, other: 0 },
    payments: { cash: 0, card: 0, debit: 0, rain_check: 0, other: 0 },
    refundCount: 0,
    refundTotal: 0,
  };

  for (const sale of sales) {
    const at = new Date(sale.created_at).getTime();
    if (!(at >= window.from && at <= window.to)) continue;
    if (sale.refunded_at || sale.status === "refunded") {
      summary.refundCount += 1;
      summary.refundTotal += sale.total;
      continue;
    }
    if (sale.status && sale.status !== "paid") continue;

    summary.saleCount += 1;
    summary.totalSales += sale.total;
    for (const [slot, amount] of allocate(sale)) summary.divisions[slot] += amount;

    const payments = sale.payments?.length
      ? sale.payments
      : sale.payment_method
        ? [{ method: sale.payment_method, amount: sale.total }]
        : [];
    for (const payment of payments) {
      summary.payments[PAYMENT_SLOT[payment.method] ?? "other"] += payment.amount;
    }
  }
  return summary;
}

/** 계산서 합계(세금·주문 할인 포함)를 줄 금액 비율로 사업부에 나눈다. 반올림 나머지는 가장 큰 칸이 받는다. */
function allocate(sale: Sale): Map<keyof ShiftSummary["divisions"], Cents> {
  const bySlot = new Map<keyof ShiftSummary["divisions"], Cents>();
  for (const line of sale.lines) {
    const slot = DIVISION_SLOT[divisionOf(line.category ?? "")];
    bySlot.set(slot, (bySlot.get(slot) ?? 0) + line.line_total);
  }
  const base = [...bySlot.values()].reduce((sum, value) => sum + value, 0);
  const shares = new Map<keyof ShiftSummary["divisions"], Cents>();
  if (base <= 0) {
    if (sale.total > 0) shares.set("other", sale.total);
    return shares;
  }
  let given = 0;
  let largest: keyof ShiftSummary["divisions"] | null = null;
  for (const [slot, value] of bySlot) {
    const share = Math.floor((sale.total * value) / base);
    shares.set(slot, share);
    given += share;
    if (largest === null || value > (bySlot.get(largest) ?? 0)) largest = slot;
  }
  if (largest !== null) shares.set(largest, (shares.get(largest) ?? 0) + sale.total - given);
  return shares;
}

const PRINTED_AT = new Intl.DateTimeFormat("en-US", {
  timeZone: CLUB_TIME_ZONE,
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/** `14:30` → `2:30 PM`. */
function clock(value: string): string {
  const [h, m] = value.split(":").map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

/**
 * 영수증 한 장의 블록. `cash` 가 거짓이면(일반 Reports) Cash 줄을 찍지 않는다 — 블라인드 카운트(0046).
 */
export function shiftReportBlocks(
  input: ShiftInput,
  summary: ShiftSummary,
  options: { header: ReceiptHeader; cash: boolean },
): ReceiptBlock[] {
  const money = formatMoney;
  const blocks: ReceiptBlock[] = [
    { kind: "logo" },
    { kind: "text", text: options.header.name, align: "center", bold: true, large: true },
    { kind: "text", text: "Shift Report", align: "center", bold: true, large: true, gap: true },
    { kind: "text", text: `Printed ${PRINTED_AT.format(new Date())}`, align: "center" },
    { kind: "field", label: "Staff", value: input.staff, gap: true },
    { kind: "field", label: "Date", value: input.date },
    { kind: "field", label: "Start", value: clock(input.start) },
    { kind: "field", label: "End", value: clock(input.end) },

    { kind: "section", title: "SALES (TAX INCL.)" },
    { kind: "total", label: `Total Sales ×${summary.saleCount}`, amount: money(summary.totalSales), bold: true },
    { kind: "total", label: "Tee Sheet", amount: money(summary.divisions.tee_sheet) },
    { kind: "total", label: "Pro Shop", amount: money(summary.divisions.pro_shop) },
    { kind: "total", label: "Snack Bar", amount: money(summary.divisions.snack_bar) },
    { kind: "total", label: "Membership", amount: money(summary.divisions.membership) },
    { kind: "total", label: "Other", amount: money(summary.divisions.other) },

    { kind: "section", title: "PAYMENTS" },
  ];
  if (options.cash) blocks.push({ kind: "total", label: PAYMENT_LABELS.cash, amount: money(summary.payments.cash) });
  blocks.push(
    { kind: "total", label: PAYMENT_LABELS.card, amount: money(summary.payments.card) },
    { kind: "total", label: "Debit", amount: money(summary.payments.debit) },
    { kind: "total", label: PAYMENT_LABELS.rain_check, amount: money(summary.payments.rain_check) },
  );
  // 회원 계정·기프트카드. 없으면 줄을 찍지 않는다 — 있으면 빠뜨려서 결제 합이 매출과 어긋나 보이지 않게.
  if (summary.payments.other > 0) {
    blocks.push({ kind: "total", label: "Other (account / gift)", amount: money(summary.payments.other) });
  }

  blocks.push(
    { kind: "rule" },
    { kind: "total", label: `Refund ×${summary.refundCount}`, amount: money(summary.refundTotal), bold: true },
    { kind: "text", text: "Signature: ____________________", align: "left", gap: true },
  );
  return blocks;
}
