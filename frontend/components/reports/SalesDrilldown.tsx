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
import { DIVISIONS, divisionOf, type DivisionKey } from "@/lib/retail/divisions";
import { formatMoney, type Cents, type PaymentMethod, type Sale, type SaleLine } from "@/lib/retail/types";

import { EmptyNote, Modal } from "@/components/retail/ui";

export type Drill =
  | { kind: "sales" | "gross" | "discount" | "tax" | "net" | "refunded" }
  | { kind: "division"; division: DivisionKey; category?: string }
  | { kind: "station"; station: string }
  | { kind: "payment"; method: PaymentMethod }
  | { kind: "product"; productId: number; name: string };

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
      return "Gross — before order discounts & tax";
    case "discount":
      return "Order discounts";
    case "tax":
      return "Tax (HST)";
    case "net":
      return "Net";
    case "refunded":
      return "Refunded";
    case "division": {
      const label = DIVISIONS.find((d) => d.key === drill.division)?.label ?? drill.division;
      return drill.category ? `${label} — ${drill.category}` : label;
    }
    case "station":
      return `Register — ${stationLabel(drill.station)}`;
    case "payment":
      return `Payment — ${PAYMENT_LABELS[drill.method]}`;
    case "product":
      return drill.name;
  }
}

type BillRow = { sale: Sale; amount: Cents };
type LineRow = { sale: Sale; line: SaleLine; category: string };

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
      case "discount":
        return paid.filter((sale) => sale.discount > 0).map((sale) => ({ sale, amount: sale.discount }));
      case "tax":
        return paid.map((sale) => ({ sale, amount: sale.tax }));
      case "refunded":
        return sales
          .filter((sale) => sale.status === "refunded" || (!sale.status && sale.refunded_at))
          .map((sale) => ({ sale, amount: sale.total }));
      case "station":
        return paid
          .filter((sale) => (sale.station ?? "") === drill.station)
          .map((sale) => ({ sale, amount: sale.total }));
      case "payment":
        return paid
          .map((sale) => ({
            sale,
            amount: (sale.payments ?? [])
              .filter((payment) => payment.method === drill.method)
              .reduce((sum, payment) => sum + payment.amount, 0),
            has: (sale.payments ?? []).some((payment) => payment.method === drill.method),
          }))
          .filter((row) => row.has)
          .map(({ sale, amount }) => ({ sale, amount }));
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
      return drill.category ? divisionLines.filter((row) => row.category === drill.category) : divisionLines;
    }
    if (drill.kind === "product") {
      return paid.flatMap((sale) =>
        sale.lines
          .filter((line) => (line.kind ?? "product") === "product" && line.product_id === drill.productId)
          .map((line) => ({ sale, line, category: lineCategory(line) })),
      );
    }
    return null;
  }, [drill, divisionLines, paid]);

  const categories = useMemo(() => {
    const seen = new Map<string, Cents>();
    for (const row of divisionLines) seen.set(row.category, (seen.get(row.category) ?? 0) + row.line.line_total);
    return [...seen.entries()];
  }, [divisionLines]);

  const total = bills
    ? bills.reduce((sum, row) => sum + row.amount, 0)
    : (lines ?? []).reduce((sum, row) => sum + row.line.line_total, 0);
  const count = bills ? bills.length : (lines ?? []).reduce((sum, row) => sum + row.line.quantity, 0);

  return (
    <Modal onClose={onClose} title={title(drill)}>
      <div className="grid gap-3">
        {drill.kind === "division" && categories.length > 1 ? (
          <div className="flex flex-wrap gap-1.5">
            <Chip active={!drill.category} onClick={() => onChange({ kind: "division", division: drill.division })}>
              All
            </Chip>
            {categories.map(([category, amount]) => (
              <Chip
                active={drill.category === category}
                key={category}
                onClick={() => onChange({ kind: "division", division: drill.division, category })}
              >
                {category} · {formatMoney(amount)}
              </Chip>
            ))}
          </div>
        ) : null}

        {count === 0 ? (
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
                          ? sale.payments.map((payment) => PAYMENT_LABELS[payment.method]).join(" + ")
                          : sale.payment_method
                            ? PAYMENT_LABELS[sale.payment_method]
                            : "No charge",
                        sale.cashier ?? "",
                        drill.kind === "refunded" && sale.refund_reason ? sale.refund_reason : "",
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    />
                  </li>
                ))
              : (lines ?? []).map(({ sale, line, category }, index) => (
                  <li key={`${sale.id}-${line.id ?? index}`}>
                    <RowButton
                      amount={line.line_total}
                      onClick={() => onOpenSale(sale)}
                      primary={`${line.quantity}× ${line.name}`}
                      secondary={[
                        sale.receipt_no,
                        timeOf(sale),
                        drill.kind === "division" && !drill.category ? category : "",
                        line.discount > 0 ? `−${formatMoney(line.discount)}` : "",
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
            Total <span className="text-xs font-normal text-[#6b7280]">{bills ? `${count} bill(s)` : `×${count}`}</span>
          </span>
          <span className="text-lg font-bold tabular-nums">{formatMoney(total)}</span>
        </div>
        <p className="text-[11px] text-[#6b7280]">Tap a row to open the receipt.</p>
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
        <span className="block truncate text-xs text-[#6b7280]">{secondary}</span>
      </span>
      <span className="shrink-0 text-sm font-bold tabular-nums">{formatMoney(amount)}</span>
    </button>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      className={`border px-2 py-1 text-xs ${
        active ? "border-[#18181b] bg-[#18181b] text-white" : "border-[#d4d4d8] bg-white hover:border-[#4533ff]"
      }`}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
}
