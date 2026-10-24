"use client";

/**
 * 담당자별 거래 — Daily close 에서 그날 계산서를 Cashier 칸(계산서에 적힌 이름)으로 나눠, 각자 몇 시부터 몇 시까지
 * 무엇을 받았는지 시각 순으로 보여 준다(2026-10-22). 담당자마다 Print 가 그 사람의 근무 마감표를 찍는다 —
 * 합계 + 계산서 한 줄씩(`ShiftReportPrint` 에 cashier 를 넘긴다).
 *
 * 숫자는 화면이 받은 계산서에서 센다(`shiftReport.ts` 와 같은 규칙: 환불은 합계에서 빼고 따로 센다).
 * 서버의 담당자별 마감(0010, `StaffCloseout`)은 현금 계정 화면에만 있고 근무시간·팁용이다 — 이 패널은 거래 목록용이다.
 */

import { useMemo, useState } from "react";

import { stationLabel } from "@/lib/retail/receipt";
import { cashierKey, saleClock, salePaymentLabel, saleTime } from "@/lib/reports/shiftReport";
import { formatMoney, type Cents, type Sale } from "@/lib/retail/types";

import ShiftReportPrint, { PrinterIcon } from "@/components/reports/ShiftReportPrint";
import StaffName from "@/components/reports/StaffName";
import { Button, EmptyNote, Panel } from "@/components/retail/ui";

type Group = {
  key: string;
  /** 계산서에 적힌 이름(처음 본 철자). 이름 없는 계산서는 빈 문자열. */
  name: string;
  sales: Sale[];
  first: string;
  last: string;
  count: number;
  total: Cents;
  refunds: number;
};

function isRefunded(sale: Sale): boolean {
  return Boolean(sale.refunded_at) || sale.status === "refunded";
}

function groupByCashier(sales: readonly Sale[]): Group[] {
  const groups = new Map<string, Group>();
  const sorted = [...sales].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  for (const sale of sorted) {
    const key = cashierKey(sale.cashier);
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        name: (sale.cashier ?? "").trim(),
        sales: [],
        first: saleClock(sale),
        last: "",
        count: 0,
        total: 0,
        refunds: 0,
      };
      groups.set(key, group);
    }
    group.sales.push(sale);
    group.last = saleClock(sale);
    if (isRefunded(sale)) group.refunds += 1;
    else {
      group.count += 1;
      group.total += sale.total;
    }
  }
  // 이름 있는 사람을 첫 거래 순으로, 이름 없는 계산서는 맨 뒤.
  return [...groups.values()].sort(
    (a, b) => Number(a.key === "") - Number(b.key === "") || a.first.localeCompare(b.first),
  );
}

/** `14:30` → `2:30 PM` */
function clock(value: string): string {
  const [h, m] = value.split(":").map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

export default function CashierShifts({
  date,
  sales,
  cash,
  onOpenSale,
}: {
  date: string;
  sales: readonly Sale[];
  cash: boolean;
  onOpenSale: (sale: Sale) => void;
}) {
  const groups = useMemo(() => groupByCashier(sales), [sales]);
  const [printing, setPrinting] = useState<Group | null>(null);

  return (
    <Panel title={`By cashier — ${date}`}>
      {groups.length === 0 ? (
        <EmptyNote>No sales recorded for this date.</EmptyNote>
      ) : (
        <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
          {groups.map((group) => (
            <section className="grid min-w-0 gap-2 border border-[#d4d4d8] p-3" key={group.key || "(none)"}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="truncate text-sm font-bold">
                    <StaffName date={date} empty="No cashier name" name={group.name} />
                  </h3>
                  <p className="text-xs text-[#6b7280]">
                    {clock(group.first)} – {clock(group.last)} · {group.count} sale(s)
                    {group.refunds ? ` · ${group.refunds} refunded` : ""}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span className="text-base font-bold tabular-nums">{formatMoney(group.total)}</span>
                  <Button
                    aria-label={`Print ${group.name || "no cashier"} shift`}
                    onClick={() => setPrinting(group)}
                    title="Print this cashier's shift on the receipt printer"
                  >
                    <span className="size-5">
                      <PrinterIcon />
                    </span>
                  </Button>
                </div>
              </div>

              <details open={group.sales.length <= 8}>
                <summary className="cursor-pointer text-xs font-bold text-[#4533ff]">
                  Transactions ({group.sales.length})
                </summary>
                <ul className="mt-1 grid gap-0.5 text-xs">
                  {group.sales.map((sale) => {
                    const refunded = isRefunded(sale);
                    return (
                      <li key={sale.id}>
                        <button
                          className="flex w-full items-baseline justify-between gap-2 py-0.5 text-left hover:text-[#4533ff] hover:underline"
                          onClick={() => onOpenSale(sale)}
                          type="button"
                        >
                          <span className={`min-w-0 truncate ${refunded ? "text-[#6b7280] line-through" : ""}`}>
                            <span className="tabular-nums">{saleTime(sale)}</span> · {sale.receipt_no}
                            <span className="text-[#6b7280]">
                              {" "}
                              · {sale.station ? `${stationLabel(sale.station)} · ` : ""}
                              {salePaymentLabel(sale)}
                            </span>
                          </span>
                          <span className={`shrink-0 tabular-nums ${refunded ? "text-[#8a1f1f]" : ""}`}>
                            {refunded ? `(${formatMoney(sale.total)})` : formatMoney(sale.total)}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </details>
            </section>
          ))}
        </div>
      )}

      {printing ? (
        <ShiftReportPrint
          cash={cash}
          cashier={printing.name}
          date={date}
          initialEnd={printing.last}
          initialStart={printing.first}
          onClose={() => setPrinting(null)}
          sales={sales}
        />
      ) : null}
    </Panel>
  );
}
