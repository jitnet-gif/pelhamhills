"use client";

/**
 * 하루 마감 숫자를 눌렀을 때 그 숫자를 이루는 계산서·줄을 펼쳐 보여 준다.
 *
 * 서버 리포트(`pelham_staff_pos_report_daily`)를 다시 부르지 않고, 화면이 이미 읽어 둔 그날
 * 계산서 목록(`pelham_staff_bills`)에서 같은 규칙으로 거른다:
 * - 매출 칸·사업부·계산대·결제 = `status = 'paid'` 계산서만 (환불은 따로).
 * - 사업부·분류·상품 = 그 계산서의 살아 있는 줄 `line_total` (줄의 `category` 로 나눈다).
 * 그래서 펼친 목록의 합은 누른 칸의 숫자와 같아야 한다. 다르면 아래 합계 줄에서 바로 보인다.
 */

import { useMemo } from "react";

import { PAYMENT_LABELS, stationLabel } from "@/lib/retail/receipt";
import {
  DIVISIONS,
  divisionOf,
  type DivisionKey,
} from "@/lib/retail/divisions";
import {
  computeTax,
  formatMoney,
  type Cents,
  type PaymentMethod,
  type Sale,
  type SaleLine,
} from "@/lib/retail/types";

import {
  cashRows,
  groupCashByCashier,
} from "@/components/reports/CashTransactions";
import { cashierKey, saleTime } from "@/lib/reports/shiftReport";
import { EmptyNote, Modal } from "@/components/retail/ui";

export type Drill =
  | {
      kind:
        | "sales"
        | "gross"
        | "discount"
        | "net_sales"
        | "tax"
        | "net"
        | "refunded"
        | "tips";
    }
  | { kind: "division"; division: DivisionKey; category?: string }
  | { kind: "station"; station: string }
  | { kind: "payment"; method: PaymentMethod }
  // 현금만 담당자(계산서의 Cashier)별로(현금 리포트 계정만, 2026-10-24) — 서랍이 하나라(0062) 계산대별은 뜻이 없다.
  // 먼저 담당자별 요약, 한 사람을 누르면 그 사람의 거래(`cashier` = `cashierKey`).
  | { kind: "cash"; cashier?: string }
  // Card Sales 칸 — 먼저 신용카드·직불(Interac) 요약, 하나를 누르면 그 거래.
  | { kind: "cards"; method?: CardMethod }
  | { kind: "product"; productId: number; name: string };

type CardMethod = "card" | "debit";
const CARD_LABELS: Record<CardMethod, string> = {
  card: "Credit card",
  debit: "Debit (Interac)",
};

/** 리포트의 `live` 와 같다. 예전 응답에 status 가 없으면 환불 표시로 가른다. */
function isPaid(sale: Sale) {
  return sale.status ? sale.status === "paid" : !sale.refunded_at;
}

/** 줄의 분류. 0005 이후 계산서는 서버가 채워 준다 — 없을 때만 줄 종류로 짐작한다. */
function lineCategory(line: SaleLine): string {
  if (line.category) return line.category;
  if (line.kind === "tee_player") return "Green Fees";
  if (line.kind === "sim_booking") return "Simulator";
  return "Other";
}

function timeOf(sale: Sale) {
  const value = new Date(sale.created_at);
  return Number.isNaN(value.getTime())
    ? ""
    : value.toLocaleTimeString("en-CA", { hour: "2-digit", minute: "2-digit" });
}

function title(drill: Drill) {
  switch (drill.kind) {
    case "sales":
      return "Sales";
    case "gross":
      return "Gross Sales — before discounts, tax excl.";
    case "discount":
      return "Order discounts";
    case "net_sales":
      return "Net Sales — after discounts, tax excl.";
    case "tax":
      return "Tax · HST";
    case "net":
      return "Total Collected — tax incl., tips excl.";
    case "refunded":
      return "Refunds";
    case "tips":
      return "Tips";
    case "division": {
      const label =
        DIVISIONS.find((d) => d.key === drill.division)?.label ??
        drill.division;
      return drill.category ? `${label} — ${drill.category}` : label;
    }
    case "station":
      return `Register — ${stationLabel(drill.station)}`;
    case "payment":
      return `Payment — ${PAYMENT_LABELS[drill.method]}`;
    case "cash":
      return drill.cashier === undefined
        ? "Cash Sales — by cashier"
        : "Cash Sales — transactions";
    case "cards":
      return drill.method
        ? `Card Sales — ${CARD_LABELS[drill.method]}`
        : "Card Sales — credit & debit";
    case "product":
      return drill.name;
  }
}

type BillRow = { sale: Sale; amount: Cents };

/** 계산서 안의 그 결제 수단 금액 합(분할 결제면 그 몫만). 없으면 null. 팁은 `tip` 에 따로 있어 빠진다. */
function paidWith(sale: Sale, method: PaymentMethod): Cents | null {
  const rows = (sale.payments ?? []).filter(
    (payment) => payment.method === method,
  );
  return rows.length
    ? rows.reduce((sum, payment) => sum + payment.amount, 0)
    : null;
}

function cardRows(sales: readonly Sale[], method: CardMethod): BillRow[] {
  return sales
    .map((sale) => ({ sale, amount: paidWith(sale, method) }))
    .filter((row): row is BillRow => row.amount !== null);
}

type LineRow = { sale: Sale; line: SaleLine; category: string };

/** 요약 한 줄 — 누르면 `next` 로 들어간다. */
type SummaryRow = {
  key: string;
  label: string;
  detail: string;
  total: Cents;
  next: Drill;
};

export default function SalesDrilldown({
  drill,
  sales,
  onChange,
  onOpenSale,
  onClose,
}: {
  drill: Drill;
  sales: Sale[];
  /** 사업부 안의 분류 칩을 누르면 같은 창에서 범위를 바꾼다. */
  onChange: (drill: Drill) => void;
  onOpenSale: (sale: Sale) => void;
  onClose: () => void;
}) {
  const paid = useMemo(() => sales.filter(isPaid), [sales]);

  const bills = useMemo<BillRow[] | null>(() => {
    switch (drill.kind) {
      case "sales":
      case "net":
        return paid.map((sale) => ({ sale, amount: sale.total }));
      case "gross":
        return paid.map((sale) => ({ sale, amount: sale.subtotal }));
      case "net_sales":
        return paid.map((sale) => ({
          sale,
          amount: sale.subtotal - sale.discount,
        }));
      case "tips":
        return paid
          .filter((sale) => (sale.tip ?? 0) > 0)
          .map((sale) => ({ sale, amount: sale.tip ?? 0 }));
      case "discount":
        return paid
          .filter((sale) => sale.discount > 0)
          .map((sale) => ({ sale, amount: sale.discount }));
      case "tax":
        return paid.map((sale) => ({ sale, amount: sale.tax }));
      case "refunded":
        return sales
          .filter(
            (sale) =>
              sale.status === "refunded" || (!sale.status && sale.refunded_at),
          )
          .map((sale) => ({ sale, amount: sale.total }));
      case "station":
        return paid
          .filter((sale) => (sale.station ?? "") === drill.station)
          .map((sale) => ({ sale, amount: sale.total }));
      case "payment":
        return paid
          .map((sale) => ({ sale, amount: paidWith(sale, drill.method) }))
          .filter((row): row is BillRow => row.amount !== null);
      case "cash": {
        // Cash Sales 칸과 같게 팁은 뺀다.
        const rows = cashRows(paid);
        return drill.cashier === undefined
          ? rows
          : rows.filter(
              (row) => cashierKey(row.sale.cashier) === drill.cashier,
            );
      }
      case "cards":
        return drill.method
          ? cardRows(paid, drill.method)
          : [...cardRows(paid, "card"), ...cardRows(paid, "debit")];
      default:
        return null;
    }
  }, [drill, paid, sales]);

  const divisionLines = useMemo<LineRow[]>(() => {
    if (drill.kind !== "division") return [];
    return paid.flatMap((sale) =>
      sale.lines
        .map((line) => ({ sale, line, category: lineCategory(line) }))
        .filter((row) => divisionOf(row.category) === drill.division),
    );
  }, [drill, paid]);

  const lines = useMemo<LineRow[] | null>(() => {
    if (drill.kind === "division") {
      return drill.category
        ? divisionLines.filter((row) => row.category === drill.category)
        : divisionLines;
    }
    if (drill.kind === "product") {
      return paid.flatMap((sale) =>
        sale.lines
          .filter(
            (line) =>
              (line.kind ?? "product") === "product" &&
              line.product_id === drill.productId,
          )
          .map((line) => ({ sale, line, category: lineCategory(line) })),
      );
    }
    return null;
  }, [drill, divisionLines, paid]);

  // Cash·Card 칸은 요약 먼저(2026-10-24): 현금은 담당자별, 카드는 신용·직불별.
  const summary = useMemo<SummaryRow[] | null>(() => {
    if (drill.kind === "cash" && drill.cashier === undefined) {
      return groupCashByCashier(bills ?? []).map((group) => ({
        key: group.key || "(none)",
        label: group.name || "No cashier name",
        detail: `${saleTime(group.rows[0].sale)} – ${saleTime(group.rows[group.rows.length - 1].sale)} · ${group.rows.length} cash transaction(s)`,
        total: group.total,
        next: { kind: "cash", cashier: group.key },
      }));
    }
    if (drill.kind === "cards" && !drill.method) {
      return (["card", "debit"] as const).map((method) => {
        const rows = cardRows(paid, method);
        return {
          key: method,
          label: CARD_LABELS[method],
          detail: `${rows.length} transaction(s)`,
          total: rows.reduce((sum, row) => sum + row.amount, 0),
          next: { kind: "cards", method },
        };
      });
    }
    return null;
  }, [drill, bills, paid]);

  const categories = useMemo(() => {
    const seen = new Map<string, Cents>();
    for (const row of divisionLines)
      seen.set(
        row.category,
        (seen.get(row.category) ?? 0) + row.line.line_total,
      );
    return [...seen.entries()];
  }, [divisionLines]);

  // 사업부는 Reports 칸과 같게 HST 를 더해 보인다(2026-10-22). 합계는 줄마다 반올림하지 않고 합에 한 번 얹는다.
  const shown = (amount: Cents) =>
    drill.kind === "division" ? amount + computeTax(amount) : amount;
  const total = bills
    ? bills.reduce((sum, row) => sum + row.amount, 0)
    : shown((lines ?? []).reduce((sum, row) => sum + row.line.line_total, 0));
  const count = bills
    ? bills.length
    : (lines ?? []).reduce((sum, row) => sum + row.line.quantity, 0);

  return (
    <Modal onClose={onClose} title={title(drill)}>
      <div className="grid gap-3">
        {drill.kind === "division" && categories.length > 1 ? (
          <div className="flex flex-wrap gap-1.5">
            <Chip
              active={!drill.category}
              onClick={() =>
                onChange({ kind: "division", division: drill.division })
              }
            >
              All
            </Chip>
            {categories.map(([category, amount]) => (
              <Chip
                active={drill.category === category}
                key={category}
                onClick={() =>
                  onChange({
                    kind: "division",
                    division: drill.division,
                    category,
                  })
                }
              >
                {category} · {formatMoney(shown(amount))}
              </Chip>
            ))}
          </div>
        ) : null}

        {(drill.kind === "cash" && drill.cashier !== undefined) ||
        (drill.kind === "cards" && drill.method) ? (
          <button
            className="justify-self-start text-xs font-bold text-[#4533ff] hover:underline"
            onClick={() => onChange({ kind: drill.kind })}
            type="button"
          >
            ←{" "}
            {drill.kind === "cash" ? "All cashiers" : "Credit & debit summary"}
          </button>
        ) : null}

        {summary ? (
          <ul className="grid gap-1.5">
            {summary.map((row) => (
              <li key={row.key}>
                <RowButton
                  amount={row.total}
                  onClick={() => onChange(row.next)}
                  primary={`${row.label} ›`}
                  secondary={row.detail}
                />
              </li>
            ))}
          </ul>
        ) : count === 0 ? (
          <EmptyNote>Nothing here for this date.</EmptyNote>
        ) : (
          <ul className="grid gap-1.5">
            {bills
              ? bills.map(({ sale, amount }) => (
                  <li key={sale.id}>
                    <RowButton
                      amount={amount}
                      onClick={() => onOpenSale(sale)}
                      primary={sale.receipt_no}
                      secondary={[
                        timeOf(sale),
                        sale.station ? stationLabel(sale.station) : "",
                        sale.payments && sale.payments.length > 1
                          ? sale.payments
                              .map((payment) => PAYMENT_LABELS[payment.method])
                              .join(" + ")
                          : sale.payment_method
                            ? PAYMENT_LABELS[sale.payment_method]
                            : "No charge",
                        drill.kind === "cash" ? "" : (sale.cashier ?? ""),
                        drill.kind === "refunded" && sale.refund_reason
                          ? sale.refund_reason
                          : "",
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    />
                  </li>
                ))
              : (lines ?? []).map(({ sale, line, category }, index) => (
                  <li key={`${sale.id}-${line.id ?? index}`}>
                    <RowButton
                      amount={shown(line.line_total)}
                      onClick={() => onOpenSale(sale)}
                      primary={`${line.quantity}× ${line.name}`}
                      secondary={[
                        sale.receipt_no,
                        timeOf(sale),
                        drill.kind === "division" && !drill.category
                          ? category
                          : "",
                        line.discount > 0
                          ? `−${formatMoney(line.discount)}`
                          : "",
                        sale.cashier ?? "",
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    />
                  </li>
                ))}
          </ul>
        )}

        <div className="flex items-baseline justify-between gap-2 border-t border-[#d4d4d8] pt-2">
          <span className="text-sm font-bold">
            Total{" "}
            <span className="text-xs font-normal text-[#6b7280]">
              {bills ? `${count} bill(s)` : `×${count}`}
            </span>
          </span>
          <span className="text-lg font-bold tabular-nums">
            {formatMoney(total)}
          </span>
        </div>
        <p className="text-[11px] text-[#6b7280]">
          {summary
            ? drill.kind === "cash"
              ? "Cash per cashier, tips excluded (same as the Cash Sales figure). Tap a cashier to see the transactions."
              : "Credit and debit, tips excluded (same as the Card Sales figure). Tap a line to see the transactions."
            : "Tap a row to open the receipt."}
        </p>
      </div>
    </Modal>
  );
}

function RowButton({
  primary,
  secondary,
  amount,
  onClick,
}: {
  primary: string;
  secondary: string;
  amount: Cents;
  onClick: () => void;
}) {
  return (
    <button
      className="flex w-full items-center justify-between gap-3 border border-[#e4e4e8] px-3 py-2 text-left hover:border-[#4533ff]"
      onClick={onClick}
      type="button"
    >
      <span className="min-w-0">
        <span className="block truncate text-sm font-bold">{primary}</span>
        <span className="block truncate text-xs text-[#6b7280]">
          {secondary}
        </span>
      </span>
      <span className="shrink-0 text-sm font-bold tabular-nums">
        {formatMoney(amount)}
      </span>
    </button>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      className={`border px-2 py-1 text-xs ${
        active
          ? "border-[#18181b] bg-[#18181b] text-white"
          : "border-[#d4d4d8] bg-white hover:border-[#4533ff]"
      }`}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
}
