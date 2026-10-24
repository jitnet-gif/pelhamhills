"use client";

/**
 * 하루 마감 숫자를 눌렀을 때 그 숫자를 이루는 계산서·줄을 펼쳐 보여 준다.
 *
 * 서버 리포트(`pelham_staff_pos_report_daily`)를 다시 부르지 않고, 화면이 이미 읽어 둔 그날
 * 계산서 목록(`pelham_staff_bills`)에서 같은 규칙으로 거른다:
 * - 매출 칸·사업부·계산대·결제 = `status = 'paid'` 계산서만 (환불은 따로).
 * - 사업부·분류·상품 = 그 계산서의 살아 있는 줄 `line_total` (줄의 `category` 로 나눈다).
 * 그래서 펼친 목록의 합은 누른 칸의 숫자와 같아야 한다. 다르면 아래 합계 줄에서 바로 보인다.
 *
 * 어느 칸이든 먼저 요약, 줄 하나를 누르면 그 거래(2026-10-24). 묶는 기준은 `groupingOf`: 매출 칸·결제 수단·상품은
 * 계산대별, 할인·환불·팁·계산대는 담당자별, 사업부는 분류별. Cash 는 담당자별, Card 는 신용·직불별(따로 둔다).
 */

import { useMemo, type ReactNode } from "react";

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
import StaffName from "@/components/reports/StaffName";
import { BackLink, summarize, type DrillGroup } from "@/components/reports/ReportDrill";
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
      /** 요약에서 고른 묶음(`groupingOf` 의 key). 없으면 요약. */
      group?: string;
    }
  | { kind: "division"; division: DivisionKey; category?: string }
  | { kind: "station"; station: string; group?: string }
  | { kind: "payment"; method: PaymentMethod; group?: string }
  // 현금만 담당자(계산서의 Cashier)별로(현금 리포트 계정만, 2026-10-24) — 서랍이 하나라(0062) 계산대별은 뜻이 없다.
  // 먼저 담당자별 요약, 한 사람을 누르면 그 사람의 거래(`cashier` = `cashierKey`).
  | { kind: "cash"; cashier?: string }
  // Card Sales 칸 — 먼저 신용카드·직불(Interac) 요약, 하나를 누르면 그 거래.
  | { kind: "cards"; method?: CardMethod }
  | { kind: "product"; productId: number; name: string; group?: string };

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

const byRegister = (sale: Sale): DrillGroup => ({
  key: sale.station ?? "",
  label: sale.station ? stationLabel(sale.station) : "No register",
});
const byCashier = (sale: Sale): DrillGroup => ({
  key: cashierKey(sale.cashier),
  label: (sale.cashier ?? "").trim() || "No cashier name",
});

/** 요약을 무엇으로 묶나. Cash·Card·사업부는 따로 처리해서 null. */
function groupingOf(drill: Drill): { of: (sale: Sale) => DrillGroup; name: string } | null {
  switch (drill.kind) {
    case "sales":
    case "gross":
    case "net_sales":
    case "tax":
    case "net":
    case "payment":
    case "product":
      return { of: byRegister, name: "registers" };
    case "discount":
    case "refunded":
    case "tips":
    case "station":
      return { of: byCashier, name: "cashiers" };
    default:
      return null;
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
  label: ReactNode;
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

  const grouping = useMemo(() => groupingOf(drill), [drill]);
  const group = "group" in drill ? drill.group : undefined;
  const inGroup = <R extends { sale: Sale }>(rows: R[] | null): R[] | null =>
    rows && grouping && group !== undefined
      ? rows.filter((row) => grouping.of(row.sale).key === group)
      : rows;

  const allBills = useMemo<BillRow[] | null>(() => {
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

  const allLines = useMemo<LineRow[] | null>(() => {
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

  const bills = inGroup(allBills);
  const lines = inGroup(allLines);

  // 요약 먼저(2026-10-24): 현금은 담당자별, 카드는 신용·직불별, 사업부는 분류별, 나머지는 `groupingOf`.
  const summary = useMemo<SummaryRow[] | null>(() => {
    if (drill.kind === "cash" && drill.cashier === undefined) {
      return groupCashByCashier(allBills ?? []).map((group) => ({
        key: group.key || "(none)",
        label: <StaffName date={group.rows[0].sale.business_date} empty="No cashier name" name={group.name} />,
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
    if (drill.kind === "division" && !drill.category) {
      return summarize(divisionLines, (row) => ({ key: row.category, label: row.category }), (row) => row.line.line_total).map(
        (item) => ({
          key: item.key,
          label: item.label,
          detail: `×${item.rows.reduce((sum, row) => sum + row.line.quantity, 0)}`,
          // 사업부 칸처럼 HST 포함.
          total: item.total + computeTax(item.total),
          next: { kind: "division", division: drill.division, category: item.key },
        }),
      );
    }
    if (grouping && !("group" in drill && drill.group !== undefined)) {
      const next = (key: string) => ({ ...drill, group: key }) as Drill;
      // 담당자별이면 다른 칸처럼 ID 확인 표시(`StaffName`)를 붙인다.
      const staffLabel = (label: string, sale: Sale) =>
        grouping.name === "cashiers" ? (
          <StaffName date={sale.business_date} empty="No cashier name" name={sale.cashier} />
        ) : (
          label
        );
      if (allBills) {
        return summarize(allBills, (row) => grouping.of(row.sale), (row) => row.amount, "").map((item) => ({
          key: item.key || "(none)",
          label: staffLabel(item.label, item.rows[0].sale),
          detail: `${item.rows.length} bill(s)`,
          total: item.total,
          next: next(item.key),
        }));
      }
      return summarize(allLines ?? [], (row) => grouping.of(row.sale), (row) => row.line.line_total, "").map((item) => ({
        key: item.key || "(none)",
        label: staffLabel(item.label, item.rows[0].sale),
        detail: `×${item.rows.reduce((sum, row) => sum + row.line.quantity, 0)}`,
        total: item.total,
        next: next(item.key),
      }));
    }
    return null;
  }, [drill, grouping, allBills, allLines, divisionLines, paid]);

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

  const first = (bills ?? lines ?? [])[0];
  const groupLabel =
    grouping && group !== undefined && first ? grouping.of(first.sale).label : "";
  const back =
    drill.kind === "cash" && drill.cashier !== undefined
      ? { label: "All cashiers", to: { kind: "cash" } as Drill }
      : drill.kind === "cards" && drill.method
        ? { label: "Credit & debit summary", to: { kind: "cards" } as Drill }
        : drill.kind === "division" && drill.category
          ? { label: "All categories", to: { kind: "division", division: drill.division } as Drill }
          : grouping && group !== undefined
            ? { label: `All ${grouping.name}`, to: { ...drill, group: undefined } as Drill }
            : null;

  return (
    <Modal onClose={onClose} title={groupLabel ? `${title(drill)} — ${groupLabel}` : title(drill)}>
      <div className="grid gap-3">
        {back ? <BackLink label={back.label} onClick={() => onChange(back.to)} /> : null}

        {drill.kind === "division" && drill.category && categories.length > 1 ? (
          <div className="flex flex-wrap gap-1.5">
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

        {summary && summary.length > 0 ? (
          <ul className="grid gap-1.5">
            {summary.map((row) => (
              <li key={row.key}>
                <RowButton
                  amount={row.total}
                  onClick={() => onChange(row.next)}
                  primary={<>{row.label} ›</>}
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
                      staff={<StaffName date={sale.business_date} name={sale.cashier} />}
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
                      staff={<StaffName date={sale.business_date} name={sale.cashier} />}
                      secondary={[
                        sale.receipt_no,
                        timeOf(sale),
                        drill.kind === "division" && !drill.category
                          ? category
                          : "",
                        line.discount > 0
                          ? `−${formatMoney(line.discount)}`
                          : "",
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
              : drill.kind === "cards"
                ? "Credit and debit, tips excluded (same as the Card Sales figure). Tap a line to see the transactions."
                : "Tap a line to see the transactions."
            : "Tap a row to open the receipt."}
        </p>
      </div>
    </Modal>
  );
}

function RowButton({
  primary,
  secondary,
  staff,
  amount,
  onClick,
}: {
  primary: ReactNode;
  secondary: string;
  /** 누가 처리했나(`StaffName`). 잘려도 보이게 둘째 줄 맨 앞에. */
  staff?: ReactNode;
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
          {staff ? (
            <>
              <span className="font-semibold text-[#3f434a]">{staff}</span>
              {secondary ? " · " : ""}
            </>
          ) : null}
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
