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

import {
  describeTerminalResult,
  terminal,
  terminalEnabled,
  TerminalError,
  useTerminalSettings,
  type TerminalRecord,
} from "@/lib/pos/terminal";
import retailApi, { localBusinessDate, toRetailError } from "@/lib/retail/api";
import { printReceipt } from "@/lib/retail/printReceipt";
import { PAYMENT_LABELS, stationLabel } from "@/lib/retail/receipt";
import { divisionTotals } from "@/lib/retail/divisions";
import { formatMoney, type RetailDailyReport, type Sale, type SalePayment } from "@/lib/retail/types";

import StaffCloseout from "@/components/reports/StaffCloseout";

import {
  Button,
  EmptyNote,
  ErrorNote,
  Field,
  Modal,
  Panel,
  SkeletonBar,
  SkeletonRows,
  StatCard,
  TextArea,
  TextInput,
} from "@/components/retail/ui";

export default function SalesReport() {
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
  // 환불하면 담당자별 마감 숫자도 바뀐다. 마감 패널에 다시 읽으라고 알린다.
  const [closeoutKey, setCloseoutKey] = useState(0);

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

  function applyRefund(updated: Sale) {
    setSales((current) => current.map((sale) => (sale.id === updated.id ? updated : sale)));
    setSelected(updated);
    // 리포트의 환불 건수·금액이 바뀌므로 다시 읽는다. 화면에서 손으로 더하면
    // 서버의 마감 숫자와 어긋난 값을 직원이 믿게 된다.
    retailApi
      .getDailyReport(date)
      .then(setReport)
      .catch(() => setReport(null));
    setCloseoutKey((key) => key + 1);
  }

  return (
    <div className="grid min-w-0 gap-3">
      <div className="grid gap-2 sm:max-w-xs">
        <Field label="Business date">
          <TextInput
            onChange={(event) => setDate(event.target.value)}
            type="date"
            value={date}
          />
        </Field>
      </div>

      {error ? <ErrorNote>{error}</ErrorNote> : null}

      {loading ? (
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-3 xl:grid-cols-6">
          {Array.from({ length: 6 }, (_, index) => (
            <SkeletonBar className="h-16 min-w-0" key={index} />
          ))}
        </div>
      ) : report ? (
        <>
          {/* 각 칸의 의미는 계약(`types.ts` 의 리포트 주석)이 정해 둔 그대로 쓴다.
              여기서 다시 더하거나 빼지 않는다 — 특히 환불 건은 `gross`/`net` 에서
              서버가 **이미 빼 두었다.** 화면에서 또 빼면 이중 차감이 되고,
              그러면 마감 숫자가 서랍 속 현금과 영영 맞지 않는다. */}
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-3 xl:grid-cols-6">
            <StatCard
              hint="refunds excluded"
              label="Sales"
              value={String(report.sale_count)}
            />
            <StatCard
              hint="before order discounts & tax"
              label="Gross"
              value={formatMoney(report.gross)}
            />
            <StatCard
              hint="order-level only"
              label="Discounts"
              value={formatMoney(report.discount)}
            />
            <StatCard label="Tax (HST)" value={formatMoney(report.tax)} />
            <StatCard
              hint="gross − discounts + tax"
              label="Net"
              value={formatMoney(report.net)}
            />
            <StatCard
              hint={`${report.refunded_count} sale(s) · tax incl.`}
              label="Refunded"
              value={formatMoney(report.refunded_total)}
            />
          </div>

          {/* 사업부 네 칸. 팔린 것(분류)으로 나눈다 — 나누는 규칙과 이유는 `lib/retail/divisions.ts`.
              합이 위 Gross 와 같다. 할인·세금은 계산서 단위라 여기 들어가지 않는다. */}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
            {divisions.map((division) => (
              <section className="min-w-0 border border-[#d4d4d8] bg-white p-3" key={division.key}>
                <div className="flex items-baseline justify-between gap-2">
                  <h2 className="text-sm font-bold">{division.label}</h2>
                  <span className="text-xs text-[#6b7280]">
                    {report.gross > 0 ? `${Math.round((division.total / report.gross) * 100)}%` : "—"}
                  </span>
                </div>
                <p className="mt-1 text-2xl font-semibold tabular-nums">{formatMoney(division.total)}</p>
                <p className="text-[11px] text-[#6b7280]">before order discounts &amp; tax</p>
                {division.categories.length === 0 ? (
                  <p className="mt-2 text-xs text-[#6b7280]">No sales.</p>
                ) : (
                  <ul className="mt-2 grid gap-0.5 border-t border-[#ececf0] pt-2 text-xs">
                    {division.categories.map((row) => (
                      <li className="flex items-baseline justify-between gap-2" key={row.category}>
                        <span className="min-w-0 truncate">
                          {row.category} <span className="text-[#6b7280]">×{row.quantity}</span>
                        </span>
                        <span className="shrink-0 tabular-nums">{formatMoney(row.total)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            ))}
          </div>

          <div className="grid min-w-0 gap-3 lg:grid-cols-3">
            {/* 계산서를 연 계산대별. 서랍·단말기 대사용이지 사업부 매출이 아니다 —
                티 시트 계산대에서 모자를 팔 수 있다. 합이 위 Net 과 같다. */}
            <Panel title="By register (tax incl.)">
              {!report.by_station || report.by_station.length === 0 ? (
                <EmptyNote>Nothing rung in yet.</EmptyNote>
              ) : (
                <ul className="grid gap-1 text-sm">
                  {report.by_station.map((row) => (
                    <li className="flex items-baseline justify-between gap-2" key={row.station}>
                      <span className="min-w-0 truncate">
                        {stationLabel(row.station)}{" "}
                        <span className="text-xs text-[#6b7280]">×{row.count}</span>
                      </span>
                      <span className="shrink-0 tabular-nums">{formatMoney(row.total)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>

            <Panel title="By payment">
              {report.by_payment.length === 0 ? (
                <EmptyNote>Nothing rung in yet.</EmptyNote>
              ) : (
                <ul className="grid gap-1 text-sm">
                  {report.by_payment.map((row) => (
                    <li className="flex items-baseline justify-between gap-2" key={row.method}>
                      <span className="min-w-0 truncate">
                        {PAYMENT_LABELS[row.method]}{" "}
                        <span className="text-xs text-[#6b7280]">×{row.count}</span>
                      </span>
                      <span className="shrink-0 tabular-nums">{formatMoney(row.total)}</span>
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
                    <li className="flex items-baseline justify-between gap-2" key={row.product_id}>
                      <span className="min-w-0 truncate">
                        {row.name} <span className="text-xs text-[#6b7280]">×{row.quantity}</span>
                      </span>
                      <span className="shrink-0 tabular-nums">{formatMoney(row.total)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>
        </>
      ) : null}

      <StaffCloseout date={date} refreshKey={closeoutKey} />

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
                      {sale.cashier ? ` · ${sale.cashier}` : ""}
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

// ===== 영수증 상세 + 환불 ===============================================

function SaleDetail({
  sale,
  onClose,
  onRefunded,
}: {
  sale: Sale;
  onClose: () => void;
  onRefunded: (updated: Sale) => void;
}) {
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const created = useMemo(() => {
    // 서버 시각은 ISO-8601 UTC 다. 매장 사람이 읽는 것은 현지 시각이므로 변환한다.
    const value = new Date(sale.created_at);
    return Number.isNaN(value.getTime()) ? sale.created_at : value.toLocaleString("en-CA");
  }, [sale.created_at]);

  async function refund() {
    if (!reason.trim()) return;
    setBusy(true);
    setError("");
    try {
      const updated = await retailApi.refundSale(sale.id, { reason: reason.trim() });
      // 서버가 갱신된 Sale 을 준다는 것은 계약에 명시돼 있지 않다. 형태가
      // 아니면 화면에서 만들어 내지 말고 원본을 그대로 두고 목록을 다시 읽게 한다.
      onRefunded(updated && typeof updated === "object" && "id" in updated ? updated : sale);
      setConfirming(false);
    } catch (cause) {
      setError(toRetailError(cause).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal onClose={onClose} title={sale.receipt_no}>
      <div className="grid gap-3">
        <div>
          <p className="text-xs text-[#6b7280]">
            {sale.business_date} · {created}
          </p>
          <p className="text-xs text-[#6b7280]">
            {sale.payments && sale.payments.length > 1
              ? sale.payments.map((payment) => PAYMENT_LABELS[payment.method]).join(" + ")
              : (sale.payment_method ? PAYMENT_LABELS[sale.payment_method] : "No charge")}
            {sale.cashier ? ` · ${sale.cashier}` : ""}
          </p>
        </div>

        {sale.refunded_at ? (
          <div className="border border-[#e2a5a5] bg-[#fdf0f0] px-3 py-2 text-sm text-[#8a1f1f]">
            <p className="font-bold">Refunded</p>
            {sale.refund_reason ? <p>{sale.refund_reason}</p> : null}
          </div>
        ) : null}

        <ul className="grid gap-1 border-y border-[#d4d4d8] py-2 text-sm">
          {sale.lines.map((line, index) => (
            <li key={line.id ?? `${line.product_id}-${line.sku}-${index}`}>
              <div className="flex items-baseline justify-between gap-2">
                <span className="min-w-0 truncate">
                  {line.quantity}× {line.name}
                </span>
                <span className="shrink-0 tabular-nums">{formatMoney(line.line_total)}</span>
              </div>
              <p className="text-[11px] text-[#6b7280]">
                {line.kind === "tee_player"
                  ? `Green fee · tee time ${line.tee_date ?? ""}`
                  : line.kind === "sim_booking"
                    ? `Simulator · ${line.tee_date ?? ""} ${line.tee_time ?? ""}`
                    : line.sku} ·{" "}
                {formatMoney(line.unit_price)} each
                {line.discount > 0 ? ` · −${formatMoney(line.discount)}` : ""}
              </p>
            </li>
          ))}
        </ul>

        <dl className="grid gap-1 text-sm">
          <SummaryRow label="Subtotal" value={formatMoney(sale.subtotal)} />
          {sale.discount > 0 ? (
            <SummaryRow label="Order discount" value={`−${formatMoney(sale.discount)}`} />
          ) : null}
          <SummaryRow label="HST" value={formatMoney(sale.tax)} />
          <div className="flex items-baseline justify-between gap-2 border-t border-[#d4d4d8] pt-1.5">
            <dt className="font-bold">Total</dt>
            <dd className="text-lg font-bold tabular-nums">{formatMoney(sale.total)}</dd>
          </div>
        </dl>

        {sale.payments && sale.payments.length > 0 ? (
          <ul className="grid gap-1 text-sm">
            {sale.payments.map((payment, index) => (
              <li className="flex items-baseline justify-between gap-2" key={index}>
                <span className="min-w-0">
                  {PAYMENT_LABELS[payment.method]}
                  {payment.auth_code ? (
                    <span className="text-[11px] text-[#6b7280]">
                      {" "}
                      · Approval {payment.auth_code}
                      {payment.card_last4 ? ` · ****${payment.card_last4}` : ""}
                    </span>
                  ) : null}
                </span>
                <span className="shrink-0 tabular-nums">{formatMoney(payment.amount)}</span>
              </li>
            ))}
          </ul>
        ) : null}

        {sale.note ? <p className="text-xs text-[#6b7280]">{sale.note}</p> : null}

        {/* 다시 찍은 종이에는 REPRINT 가 찍힌다. 원본과 사본을 들고 두 번 환불받으러
            오는 것을 창구에서 가려낼 수 있어야 한다. */}
        <Button full onClick={() => printReceipt(sale, { reprint: true })}>
          Reprint receipt
        </Button>

        {error ? <ErrorNote>{error}</ErrorNote> : null}

        {sale.refunded_at ? null : confirming ? (
          <div className="grid gap-2 border border-[#e2a5a5] p-2">
            {sale.payments?.some((payment) => payment.method === "card" || payment.method === "debit") ? (
              <p className="bg-[#fff8e1] px-2 py-2 text-xs text-[#5b4708]">
                Refund the card or debit part on the Chase DX8000 first. This button only fixes the books: it puts
                stock back and marks any green fees on this bill unpaid again.
              </p>
            ) : null}
            <TerminalRefunds sale={sale} />
            <Field hint="Required — it goes on the day's reconciliation" label="Refund reason">
              <TextArea
                onChange={(event) => setReason(event.target.value)}
                placeholder="Wrong size, customer cancelled…"
                value={reason}
              />
            </Field>
            <div className="flex gap-2">
              <Button
                className="flex-1"
                disabled={busy || !reason.trim()}
                onClick={refund}
                tone="danger"
              >
                {busy ? "Refunding…" : "Confirm refund"}
              </Button>
              <Button className="flex-1" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <Button full onClick={() => setConfirming(true)} tone="danger">
            Refund this sale
          </Button>
        )}

      </div>
    </Modal>
  );
}

/**
 * 단말기 연동으로 받은 카드 결제(`entry = "integrated"`, Stripe Terminal)를 돌려준다. 신용카드는 Stripe
 * 환불(카드 필요 없음), Interac 은 리더에서 손님이 카드를 다시 댄다. 돌려준 뒤 아래 *Confirm refund* 로
 * 장부를 맞춘다. 손으로 친("keyed") 결제는 예전처럼 단말기에서 직접 한다.
 */
function TerminalRefunds({ sale }: { sale: Sale }) {
  const settings = useTerminalSettings();
  const linked = (sale.payments ?? []).filter(
    (payment) => payment.entry === "integrated" && (payment.method === "card" || payment.method === "debit"),
  );
  const [records, setRecords] = useState<TerminalRecord[]>([]);
  const [working, setWorking] = useState<number | null>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");

  const hasLinked = linked.length > 0;
  useEffect(() => {
    if (!hasLinked) return;
    let cancelled = false;
    terminal
      .forBill(sale.id)
      .then((list) => {
        if (!cancelled) setRecords(list);
      })
      .catch(() => {
        // 기록을 못 읽었다. 버튼은 그대로 쓸 수 있다.
      });
    return () => {
      cancelled = true;
    };
  }, [hasLinked, sale.id]);

  if (!hasLinked) return null;

  /** 이 결제 줄의 판매 기록(Charge 때 묶인 것). */
  const saleFor = (payment: SalePayment) =>
    records.find(
      (record) => record.kind === "sale" && record.approved && record.used && record.auth_code === payment.auth_code,
    );
  const done = (payment: SalePayment) => {
    const original = saleFor(payment);
    return records.some(
      (record) =>
        record.kind === "refund" &&
        record.approved &&
        (original ? record.refund_of === original.id : record.original_auth_code === payment.auth_code),
    );
  };

  async function reverse(index: number, payment: SalePayment) {
    const original = saleFor(payment);
    if (!original) {
      setError("Could not find the reader approval for this payment. Refund it in the Stripe Dashboard.");
      return;
    }
    setWorking(index);
    setError("");
    try {
      const record = await terminal.refund(settings, sale.id, original, { onStatus: setStatus });
      setRecords((current) => [...current, record]);
      if (!record.approved) setError(`Refund did not go through: ${describeTerminalResult(record)}`);
    } catch (cause) {
      setError(cause instanceof TerminalError || cause instanceof Error ? cause.message : "The reader did not answer.");
    } finally {
      setWorking(null);
      setStatus("");
    }
  }

  return (
    <div className="grid gap-2 border border-[#d4d4d8] p-2 text-sm">
      <p className="text-xs font-bold tracking-wide text-[#6b7280] uppercase">Paid through the card reader</p>
      {linked.some((payment) => payment.method === "debit") && !terminalEnabled(settings) ? (
        <p className="text-xs text-[#5b4708]">
          Interac refunds need the card reader. Do it on a register that is linked to the reader.
        </p>
      ) : null}
      {linked.map((payment, index) => (
        <div className="grid gap-1" key={index}>
          <p>
            {PAYMENT_LABELS[payment.method]} {formatMoney(payment.amount + (payment.tip ?? 0))}
            <span className="text-[11px] text-[#6b7280]">
              {" "}
              · Approval {payment.auth_code}
              {payment.card_last4 ? ` · ****${payment.card_last4}` : ""}
            </span>
          </p>
          {done(payment) ? (
            <p className="text-xs font-bold text-[#1f6b3a]">Refunded to the card.</p>
          ) : (
            <Button
              className="min-h-9 justify-self-start px-2 text-xs"
              disabled={working !== null || (payment.method === "debit" && !terminalEnabled(settings))}
              onClick={() => void reverse(index, payment)}
            >
              {payment.method === "debit" ? "Refund on reader (customer taps card)" : "Refund to card"}
            </Button>
          )}
        </div>
      ))}
      {status ? <p className="text-xs font-bold">{status}</p> : null}
      {error ? <ErrorNote>{error}</ErrorNote> : null}
    </div>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-[#6b7280]">{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}
