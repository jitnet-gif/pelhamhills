"use client";

/**
 * 현금 거래 — 담당자(계산서의 Cashier 칸)별로 묶어 시각 순으로(2026-10-24). 세 곳이 같이 쓴다:
 * - Close Register 의 Cash 줄 Payments(현금 리포트 계정만) — 그 근무(모닝·디너, 0092)의 현금 거래.
 * - Daily close 의 Cash Sales 칸 — 그날 현금을 담당자별로.
 * - Register closes 탭의 Cash 칸 — 그 근무의 현금 거래(화면이 그날 계산서를 읽어 근무 범위로 거른다).
 *
 * 근무 범위(`ShiftWindow`)는 서버가 정한다(모닝 마감의 끝 시각). 화면은 결제 시각(`created_at`)으로 같은 범위를 고른다.
 * 금액: 마감 표와 맞출 때는 팁까지(서랍에 들어간 돈, `withTips`), Daily close 의 Cash Sales 와 맞출 때는 팁 빼고.
 *
 * 카드·체크카드도 같은 창으로 연다(2026-10-24, `paymentRows`·`method`) — Register closes 의 Card·Debit 칸,
 * 대사표의 Sales report 줄. 서랍 마감과 맞출 때는 온라인 결제를 뺀다(`drawerOnly` — 서랍에 들어오지 않는다).
 */

import { useEffect, useMemo, useState } from "react";

import retailApi, { toRetailError } from "@/lib/retail/api";
import { cashierKey, saleTime } from "@/lib/reports/shiftReport";
import { PAYMENT_LABELS, stationLabel } from "@/lib/retail/receipt";
import { formatMoney, type Cents, type PaymentMethod, type RegisterShift, type Sale, type ShiftWindow } from "@/lib/retail/types";

import StaffName from "@/components/reports/StaffName";
import { EmptyNote, ErrorNote, Modal, SkeletonRows } from "@/components/retail/ui";

export const SHIFT_LABELS: Record<RegisterShift, string> = {
  morning: "Morning · Shift 1",
  dinner: "Evening · Shift 2",
};

export type CashRow = { sale: Sale; amount: Cents };

function isPaid(sale: Sale) {
  return sale.status ? sale.status === "paid" : !sale.refunded_at;
}

/** 결제 시각이 근무 범위 안인가. 범위가 없으면 하루 전체. */
export function inShift(sale: Sale, window: ShiftWindow | null | undefined): boolean {
  if (!window) return true;
  const at = new Date(sale.created_at).getTime();
  if (window.from && at < new Date(window.from).getTime()) return false;
  if (window.to && at >= new Date(window.to).getTime()) return false;
  return true;
}

/** 결제된 계산서의 현금 몫(분할 결제면 현금 줄만). 마감 표의 Payments 와 같은 범위 — `status = 'paid'`. */
export function cashRows(sales: readonly Sale[], window?: ShiftWindow | null, withTips = false): CashRow[] {
  return paymentRows(sales, "cash", window, withTips);
}

/** `cashRows` 를 결제 수단 하나로. `drawerOnly` 면 온라인 계산서(서랍 밖)를 뺀다. */
export function paymentRows(
  sales: readonly Sale[],
  method: PaymentMethod,
  window?: ShiftWindow | null,
  withTips = false,
  drawerOnly = false,
): CashRow[] {
  return sales
    .filter((sale) => isPaid(sale) && inShift(sale, window) && !(drawerOnly && sale.station === "online"))
    .map((sale) => {
      const paid = (sale.payments ?? []).filter((payment) => payment.method === method);
      return {
        sale,
        amount: paid.length
          ? paid.reduce((sum, payment) => sum + payment.amount + (withTips ? (payment.tip ?? 0) : 0), 0)
          : null,
      };
    })
    .filter((row): row is CashRow => row.amount !== null)
    .sort((a, b) => new Date(a.sale.created_at).getTime() - new Date(b.sale.created_at).getTime());
}

type Group = { key: string; name: string; rows: CashRow[]; total: Cents };

export function groupCashByCashier(rows: readonly CashRow[]): Group[] {
  const groups = new Map<string, Group>();
  for (const row of rows) {
    const key = cashierKey(row.sale.cashier);
    const group = groups.get(key) ?? {
      key,
      name: (row.sale.cashier ?? "").trim(),
      rows: [],
      total: 0,
    };
    group.rows.push(row);
    group.total += row.amount;
    groups.set(key, group);
  }
  // 이름 있는 사람을 첫 거래 순으로(rows 가 이미 시각 순), 이름 없는 계산서는 맨 뒤.
  return [...groups.values()].sort((a, b) => Number(a.key === "") - Number(b.key === ""));
}

/** 담당자 칸 목록. 담당자가 셋 이하면 펼쳐서 연다. */
export function CashByCashier({
  rows,
  onOpenSale,
  method = "cash",
}: {
  rows: readonly CashRow[];
  onOpenSale?: (sale: Sale) => void;
  method?: PaymentMethod;
}) {
  const groups = useMemo(() => groupCashByCashier(rows), [rows]);
  const total = rows.reduce((sum, row) => sum + row.amount, 0);
  const noun = `${PAYMENT_LABELS[method].toLowerCase()} transaction(s)`;
  if (rows.length === 0) return <EmptyNote>No {noun.replace("(s)", "s")} in this period.</EmptyNote>;
  return (
    <div className="grid gap-2">
      {groups.map((group) => (
        <details className="border border-[#d4d4d8]" key={group.key || "(none)"} open={groups.length <= 3}>
          <summary className="flex cursor-pointer items-baseline justify-between gap-2 px-3 py-2">
            <span className="min-w-0">
              <span className="block truncate text-sm font-bold">
                <StaffName date={group.rows[0].sale.business_date} empty="No cashier name" name={group.name} />
              </span>
              <span className="block text-xs text-[#6b7280]">
                {saleTime(group.rows[0].sale)} – {saleTime(group.rows[group.rows.length - 1].sale)} ·{" "}
                {group.rows.length} {noun}
              </span>
            </span>
            <span className="shrink-0 text-base font-bold tabular-nums">{formatMoney(group.total)}</span>
          </summary>
          <ul className="grid gap-0.5 border-t border-[#ececf0] px-3 py-1.5 text-xs">
            {group.rows.map(({ sale, amount }) => {
              const label = (
                <>
                  <span className="min-w-0 truncate">
                    <span className="tabular-nums">{saleTime(sale)}</span> · {sale.receipt_no}
                    <span className="text-[#6b7280]">
                      {sale.station ? ` · ${stationLabel(sale.station)}` : ""}
                      {(sale.payments ?? []).some((payment) => payment.method !== method) ? " · split" : ""}
                    </span>
                  </span>
                  <span className="shrink-0 tabular-nums">{formatMoney(amount)}</span>
                </>
              );
              return (
                <li key={sale.id}>
                  {onOpenSale ? (
                    <button
                      className="flex w-full items-baseline justify-between gap-2 py-0.5 text-left hover:text-[#4533ff] hover:underline"
                      onClick={() => onOpenSale(sale)}
                      type="button"
                    >
                      {label}
                    </button>
                  ) : (
                    <p className="flex items-baseline justify-between gap-2 py-0.5">{label}</p>
                  )}
                </li>
              );
            })}
          </ul>
        </details>
      ))}
      <div className="flex items-baseline justify-between gap-2 border-t border-[#d4d4d8] pt-2">
        <span className="text-sm font-bold">
          Total <span className="text-xs font-normal text-[#6b7280]">{rows.length} transaction(s)</span>
        </span>
        <span className="text-lg font-bold tabular-nums">{formatMoney(total)}</span>
      </div>
    </div>
  );
}

/**
 * 한 근무의 현금 거래 창. `sales` 를 주면 그것으로(마감 화면은 이미 읽었다), 없으면 그날 계산서를 읽는다.
 * 금액은 팁 포함 — 마감 표의 Cash Payments 와 같은 값이다. `method` 로 카드·체크카드도 연다.
 */
export function CashShiftModal({
  title,
  date,
  window,
  sales: given,
  method = "cash",
  drawerOnly = false,
  note,
  onClose,
}: {
  title: string;
  date: string;
  window: ShiftWindow | null | undefined;
  sales?: readonly Sale[];
  method?: PaymentMethod;
  /** 서랍 마감과 맞출 때 — 온라인 결제를 뺀다. */
  drawerOnly?: boolean;
  /** 아래 설명을 바꿀 때. */
  note?: string;
  onClose: () => void;
}) {
  const [loaded, setLoaded] = useState<{
    sales: Sale[] | null;
    error: string;
  } | null>(null);

  useEffect(() => {
    if (given) return;
    let cancelled = false;
    retailApi
      .listSales(date)
      .then((value) => {
        if (!cancelled) setLoaded({ sales: value, error: "" });
      })
      .catch((cause) => {
        if (!cancelled) setLoaded({ sales: null, error: toRetailError(cause).message });
      });
    return () => {
      cancelled = true;
    };
  }, [date, given]);

  const sales = given ?? loaded?.sales ?? null;
  const rows = useMemo(
    () => (sales ? paymentRows(sales, method, window, true, drawerOnly) : []),
    [sales, window, method, drawerOnly],
  );

  return (
    <Modal onClose={onClose} title={title}>
      {loaded?.error ? (
        <ErrorNote>{loaded.error}</ErrorNote>
      ) : !sales ? (
        <SkeletonRows count={4} />
      ) : (
        <div className="grid gap-2">
          <CashByCashier method={method} rows={rows} />
          <p className="text-[11px] text-[#6b7280]">
            {note ??
              `${PAYMENT_LABELS[method]} taken in this shift, tips included — the same total as the ${PAYMENT_LABELS[method]} Payments on Close Register.`}
          </p>
        </div>
      )}
    </Modal>
  );
}
