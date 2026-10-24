"use client";

/**
 * 클럽 종합 매출 — 티 시트·실내 베이·스낵바·프로 샵 리테일을 한 장부에서 하루 단위로.
 * Reports(`/admin/reports`) 한 곳에서만 띄운다. 예전에는 리테일 작업 화면에 Sales 탭이 따로
 * 있었지만 같은 장부를 두 곳에서 보여 줄 이유가 없어 여기로 모았다(2026-09-30).
 *
 * 하루가 끝나면 여기 숫자와 서랍 안의 현금이 맞아야 한다.
 *
 * 환불된 매출을 **목록에서 지우지 않는** 것이 이 화면의 핵심이다. 지우면 그 날
 * 합계가 갑자기 줄어들어서 대사(reconciliation)가 맞지 않고, 무엇이 사라졌는지
 * 아무도 모른다. 그래서 취소선 + 배지로 남기고 사유를 같이 보여 준다.
 */

import { useEffect, useMemo, useState } from "react";

import retailApi, { localBusinessDate, toRetailError } from "@/lib/retail/api";
import { PAYMENT_LABELS, stationLabel } from "@/lib/retail/receipt";
import { divisionTotals } from "@/lib/retail/divisions";
import { computeTax, formatMoney, type Cents, type RetailDailyReport, type Sale } from "@/lib/retail/types";

import Cancellations from "@/components/reports/Cancellations";
import CardSales from "@/components/reports/CardSales";
import CashierShifts from "@/components/reports/CashierShifts";
import CashReconcile from "@/components/reports/CashReconcile";
import PriceReview from "@/components/reports/PriceReview";
import SaleDetail from "@/components/reports/SaleDetail";
import SalesDrilldown, { type Drill } from "@/components/reports/SalesDrilldown";
import ShiftReportPrint, { PrinterIcon } from "@/components/reports/ShiftReportPrint";
import StaffCloseout from "@/components/reports/StaffCloseout";

import {
  Button,
  EmptyNote,
  ErrorNote,
  Field,
  Panel,
  SkeletonBar,
  SkeletonRows,
  StatCard,
  TextInput,
} from "@/components/retail/ui";
import StaffName from "@/components/reports/StaffName";

/**
 * `cash` 가 거짓이면(일반 Reports) 현금 숫자를 그리지 않는다 — By payment 의 Cash 줄과 담당자별 마감
 * (서랍 현금·팁 나누기). 서버도 현금 리포트 계정이 아니면 같은 것을 주지 않는다(0046). 여기서 한 번 더
 * 거르는 것은 0046 이 아직 안 돈 프로젝트에서도 일반 화면에 현금이 새지 않게 하려는 것이다.
 */
export default function SalesReport({ cash = false }: { cash?: boolean }) {
  // 티 시트의 "Refund" 바로가기는 `?date=YYYY-MM-DD`(결제한 날)로 온다. 그 날 목록을 연다.
  const [date, setDate] = useState(() => {
    const wanted = typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("date");
    return wanted && /^\d{4}-\d{2}-\d{2}$/.test(wanted) ? wanted : localBusinessDate();
  });
  const [sales, setSales] = useState<Sale[]>([]);
  const [report, setReport] = useState<RetailDailyReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<Sale | null>(null);
  // 숫자를 눌러 연 상세. 영수증을 열면 잠시 가렸다가, 영수증을 닫으면 그 목록으로 돌아온다.
  const [drill, setDrill] = useState<Drill | null>(null);
  // 환불하면 담당자별 마감 숫자도 바뀐다. 마감 패널에 다시 읽으라고 알린다.
  const [closeoutKey, setCloseoutKey] = useState(0);
  // 담당자 마감을 저장하면 대사표만 다시 읽는다(마감 패널은 저장 결과를 이미 받았다).
  const [savedKey, setSavedKey] = useState(0);
  const [printing, setPrinting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");

    // 두 요청 중 하나만 실패해도 나머지는 보여 준다. 리포트가 없다고 매출
    // 목록까지 감추면, 정작 대사에 필요한 원자료를 못 보게 된다.
    Promise.allSettled([retailApi.listSales(date), retailApi.getDailyReport(date)]).then(
      (results) => {
        if (cancelled) return;
        const [salesResult, reportResult] = results;
        if (salesResult.status === "fulfilled") setSales(salesResult.value);
        else setError(toRetailError(salesResult.reason).message);
        setReport(reportResult.status === "fulfilled" ? reportResult.value : null);
        setLoading(false);
      },
    );

    return () => {
      cancelled = true;
    };
  }, [date]);

  const divisions = useMemo(() => (report ? divisionTotals(report) : []), [report]);
  const payments = useMemo(
    () => (report ? report.by_payment.filter((row) => cash || row.method !== "cash") : []),
    [report, cash],
  );

  function applyRefund(updated: Sale) {
    setSales((current) => current.map((sale) => (sale.id === updated.id ? updated : sale)));
    setSelected(updated);
    // 리포트의 환불 건수·금액이 바뀌므로 다시 읽는다. 화면에서 손으로 더하면
    // 서버의 마감 숫자와 어긋난 값을 직원이 믿게 된다.
    retailApi
      .getDailyReport(date)
      .then(setReport)
      .catch(() => setReport(null));
    if (cash) setCloseoutKey((key) => key + 1);
  }

  return (
    <div className="grid min-w-0 gap-3">
      <div className="flex items-end gap-2">
        <div className="grid min-w-0 flex-1 gap-2 sm:max-w-xs">
          <Field label="Business date">
            <TextInput
              onChange={(event) => {
                setDate(event.target.value);
                setDrill(null);
              }}
              type="date"
              value={date}
            />
          </Field>
        </div>
        {/* 담당자·시작·끝 시각을 적고 합계만 영수증 프린터로(`ShiftReportPrint`). 계산서 목록은 찍지 않는다. */}
        <Button className="shrink-0" disabled={loading} onClick={() => setPrinting(true)} title="Print shift report on the receipt printer">
          <span className="size-5">
            <PrinterIcon />
          </span>
          Print
        </Button>
      </div>

      {error ? <ErrorNote>{error}</ErrorNote> : null}

      {loading ? (
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-5">
          {Array.from({ length: 5 }, (_, index) => (
            <SkeletonBar className="h-16 min-w-0" key={index} />
          ))}
        </div>
      ) : report ? (
        <>
          {/* 각 칸의 의미는 계약(`types.ts` 의 리포트 주석)이 정해 둔 그대로 쓴다.
              여기서 다시 더하거나 빼지 않는다 — 특히 환불 건은 `gross`/`net` 에서
              서버가 **이미 빼 두었다.** 화면에서 또 빼면 이중 차감이 되고,
              그러면 마감 숫자가 서랍 속 현금과 영영 맞지 않는다. */}
          {/* 위에서 아래로 읽히게: 세전 매출 → 할인 → 세전 순매출 → 세금 → 받은 돈.
              굵은 두 칸이 "얼마 팔았나"(Net Sales)와 "손님에게 얼마 받았나"(Total Collected).
              서버의 `net` 은 세금 포함이라 화면에서는 Total Collected 로 부르고,
              Net Sales 는 `gross − discount` 로 여기서 만든다. */}
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-5">
            <StatCard
              hint="before discounts · tax excl."
              label="Gross Sales"
              onClick={() => setDrill({ kind: "gross" })}
              value={formatMoney(report.gross)}
            />
            <StatCard
              hint="order discounts applied"
              label="Discounts"
              onClick={() => setDrill({ kind: "discount" })}
              value={`−${formatMoney(report.discount)}`}
            />
            <StatCard
              hint="after discounts · tax excl."
              label="Net Sales"
              onClick={() => setDrill({ kind: "net_sales" })}
              strong
              value={formatMoney(report.gross - report.discount)}
            />
            <StatCard
              hint="collected from customers"
              label="Tax · HST"
              onClick={() => setDrill({ kind: "tax" })}
              value={`+${formatMoney(report.tax)}`}
            />
            <StatCard
              hint="tax incl. · tips excl."
              className="col-span-2 lg:col-span-1"
              label="Total Collected"
              onClick={() => setDrill({ kind: "net" })}
              strong
              value={formatMoney(report.net)}
            />
          </div>

          {/* 위 흐름 밖의 숫자. 환불은 위에서 이미 빠졌고, 팁은 매출이 아니다.
              Cash Sales 는 현금 리포트 계정만(0046) — By payment 의 Cash 줄과 같은 값이다. 누르면 담당자별 → 거래.
              Card Sales 는 By payment 의 Card + Debit 줄 — 누구에게나 보인다. */}
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-5">
            <StatCard
              hint="refunds excluded"
              label="Sales"
              onClick={() => setDrill({ kind: "sales" })}
              value={String(report.sale_count)}
            />
            <StatCard
              hint={`${report.refunded_count} sale(s) · already excluded above`}
              label="Refunds"
              onClick={() => setDrill({ kind: "refunded" })}
              value={formatMoney(report.refunded_total)}
            />
            <StatCard
              hint="counted apart from sales"
              label="Tips"
              onClick={() => setDrill({ kind: "tips" })}
              value={formatMoney(report.tips ?? 0)}
            />
            {cash ? (
              <StatCard
                hint="tax incl. · tips excl. · by cashier"
                label="Cash Sales"
                onClick={() => setDrill({ kind: "cash" })}
                value={formatMoney(report.by_payment.find((row) => row.method === "cash")?.total ?? 0)}
              />
            ) : null}
            <StatCard
              className={cash ? "col-span-2 lg:col-span-1" : ""}
              hint="credit & debit · tax incl. · tips excl."
              label="Card Sales"
              onClick={() => setDrill({ kind: "cards" })}
              value={formatMoney(
                report.by_payment
                  .filter((row) => row.method === "card" || row.method === "debit")
                  .reduce((sum, row) => sum + row.total, 0),
              )}
            />
          </div>

          {/* 사업부 다섯 칸(회원권 포함, 0072). 팔린 것(분류)으로 나눈다 — 나누는 규칙과 이유는 `lib/retail/divisions.ts`.
              금액은 HST 를 더해 보인다(2026-10-22) — 카운터에서 손님에게 부르는 값이 세금 포함이라서다.
              모든 계산서가 13% 하나라 줄 합계에 세금을 얹으면 되지만, 주문 할인은 계산서 단위라
              여기 들어가지 않고 세금도 계산서마다 반올림하므로, 다섯 칸의 합은 Total Collected 와
              몇 센트 다를 수 있다. 비율(%)은 세전 Gross Sales 기준 그대로다. */}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
            {divisions.map((division) => (
              <section className="min-w-0 border border-[#d4d4d8] bg-white p-3" key={division.key}>
                <button
                  className="block w-full text-left hover:text-[#4533ff]"
                  onClick={() => setDrill({ kind: "division", division: division.key })}
                  type="button"
                >
                  <span className="flex items-baseline justify-between gap-2">
                    <h2 className="text-sm font-bold">{division.label}</h2>
                    <span className="text-xs text-[#6b7280]">
                      {report.gross > 0 ? `${Math.round((division.total / report.gross) * 100)}%` : "—"}
                    </span>
                  </span>
                  <span className="mt-1 block text-2xl font-semibold tabular-nums">{formatMoney(withTax(division.total))}</span>
                  <span className="block text-[11px] text-[#6b7280]">before order discounts · tax incl.</span>
                </button>
                {division.categories.length === 0 ? (
                  <p className="mt-2 text-xs text-[#6b7280]">No sales.</p>
                ) : (
                  <ul className="mt-2 grid gap-0.5 border-t border-[#ececf0] pt-2 text-xs">
                    {division.categories.map((row) => (
                      <li key={row.category}>
                        <button
                          className={DRILL_ROW}
                          onClick={() => setDrill({ kind: "division", division: division.key, category: row.category })}
                          type="button"
                        >
                          <span className="min-w-0 truncate">
                            {row.category} <span className="text-[#6b7280]">×{row.quantity}</span>
                          </span>
                          <span className="shrink-0 tabular-nums">{formatMoney(withTax(row.total))}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            ))}
          </div>

          {/* 요금표와 다른 그린피·카트 요금(0055). 매니저가 승인한 정정도 여기서 다시 본다. */}
          <PriceReview date={date} />

          <div className="grid min-w-0 gap-3 lg:grid-cols-3">
            {/* 계산서를 연 계산대별. 서랍·단말기 대사용이지 사업부 매출이 아니다 —
                티 시트 계산대에서 모자를 팔 수 있다. 합이 위 Total Collected 와 같다. */}
            <Panel title="By register (tax incl.)">
              {!report.by_station || report.by_station.length === 0 ? (
                <EmptyNote>Nothing rung in yet.</EmptyNote>
              ) : (
                <ul className="grid gap-1 text-sm">
                  {report.by_station.map((row) => (
                    <li key={row.station}>
                      <button
                        className={DRILL_ROW}
                        onClick={() => setDrill({ kind: "station", station: row.station ?? "" })}
                        type="button"
                      >
                      <span className="min-w-0 truncate">
                        {stationLabel(row.station)}{" "}
                        <span className="text-xs text-[#6b7280]">×{row.count}</span>
                      </span>
                      <span className="shrink-0 tabular-nums">{formatMoney(row.total)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>

            <Panel title={cash ? "By payment" : "By payment (cash not shown)"}>
              {payments.length === 0 ? (
                <EmptyNote>Nothing rung in yet.</EmptyNote>
              ) : (
                <ul className="grid gap-1 text-sm">
                  {payments.map((row) => (
                    <li key={row.method}>
                      <button
                        className={DRILL_ROW}
                        onClick={() => setDrill({ kind: "payment", method: row.method })}
                        type="button"
                      >
                      <span className="min-w-0 truncate">
                        {PAYMENT_LABELS[row.method]}{" "}
                        <span className="text-xs text-[#6b7280]">×{row.count}</span>
                      </span>
                      <span className="shrink-0 tabular-nums">{formatMoney(row.total)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>

            <Panel title="Top products">
              {report.top_products.length === 0 ? (
                <EmptyNote>Nothing rung in yet.</EmptyNote>
              ) : (
                <ul className="grid gap-1 text-sm">
                  {report.top_products.map((row) => (
                    <li key={row.product_id}>
                      <button
                        className={DRILL_ROW}
                        onClick={() => setDrill({ kind: "product", productId: row.product_id, name: row.name })}
                        type="button"
                      >
                      <span className="min-w-0 truncate">
                        {row.name} <span className="text-xs text-[#6b7280]">×{row.quantity}</span>
                      </span>
                      <span className="shrink-0 tabular-nums">{formatMoney(row.total)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>
        </>
      ) : null}

      {/* By payment 의 Card·Debit 을 Stripe 숫자로 이어 준다(팁·환불·손으로 친 전표·온라인). */}
      {!loading ? <CardSales date={date} onOpenSale={setSelected} sales={sales} /> : null}

      {/* 환불·void 계산서·예약 취소(0088). 카드 쪽 취소는 바로 위 칸. */}
      {!loading ? <Cancellations date={date} onOpenSale={setSelected} sales={sales} /> : null}

      {cash ? <CashReconcile date={date} refreshKey={closeoutKey + savedKey} /> : null}

      {cash ? (
        <StaffCloseout date={date} onSaved={() => setSavedKey((key) => key + 1)} refreshKey={closeoutKey} />
      ) : null}

      {/* 담당자별·시각순 거래와 담당자별 출력(`CashierShifts`). */}
      {!loading && sales.length > 0 ? (
        <CashierShifts cash={cash} date={date} onOpenSale={setSelected} sales={sales} />
      ) : null}

      <Panel title={`Receipts — ${date}`}>
        {loading ? (
          <SkeletonRows count={5} />
        ) : sales.length === 0 ? (
          <EmptyNote>No sales recorded for this date.</EmptyNote>
        ) : (
          <ul className="grid gap-2">
            {sales.map((sale) => (
              <li key={sale.id}>
                <button
                  className="flex min-h-14 w-full items-center justify-between gap-3 border border-[#e4e4e8] px-3 py-2 text-left hover:border-[#4533ff]"
                  onClick={() => setSelected(sale)}
                  type="button"
                >
                  <span className="min-w-0">
                    <span className="flex flex-wrap items-center gap-1.5">
                      <span
                        className={`text-sm font-bold ${
                          sale.refunded_at ? "text-[#6b7280] line-through" : ""
                        }`}
                      >
                        {sale.receipt_no}
                      </span>
                      {sale.refunded_at ? (
                        <span className="bg-[#fdf0f0] px-1.5 py-0.5 text-[10px] font-bold text-[#8a1f1f]">
                          REFUNDED
                        </span>
                      ) : null}
                    </span>
                    <span className="block truncate text-xs text-[#6b7280]">
                      {sale.station ? `${stationLabel(sale.station)} · ` : ""}
                      {(sale.payment_method ? PAYMENT_LABELS[sale.payment_method] : "No charge")} · {sale.lines.length} line(s)
                      {" · "}
                      <StaffName date={sale.business_date} name={sale.cashier} />
                    </span>
                  </span>
                  <span
                    className={`shrink-0 text-base font-bold tabular-nums ${
                      sale.refunded_at ? "text-[#6b7280] line-through" : ""
                    }`}
                  >
                    {formatMoney(sale.total)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {drill && !selected ? (
        <SalesDrilldown
          drill={drill}
          onChange={setDrill}
          onClose={() => setDrill(null)}
          onOpenSale={setSelected}
          sales={sales}
        />
      ) : null}

      {printing ? (
        <ShiftReportPrint cash={cash} date={date} onClose={() => setPrinting(false)} sales={sales} />
      ) : null}

      {selected ? (
        <SaleDetail
          onClose={() => setSelected(null)}
          onRefunded={applyRefund}
          sale={selected}
        />
      ) : null}
    </div>
  );
}

/** 리포트 칸 안의 한 줄 — 누르면 그 줄을 이루는 계산서가 열린다. */
const DRILL_ROW =
  "flex w-full items-baseline justify-between gap-2 py-0.5 text-left hover:text-[#4533ff] hover:underline";

/** 사업부 칸의 세금 포함 금액. 계산서와 같은 반올림(`computeTax`)을 쓴다. */
function withTax(amount: Cents): Cents {
  return amount + computeTax(amount);
}
