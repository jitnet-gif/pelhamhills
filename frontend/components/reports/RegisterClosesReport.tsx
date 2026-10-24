"use client";

/**
 * 계산대 마감 기록 — Reports(`?view=closes`)의 한 탭. 기간 안의 (영업일, 서랍)마다 한 줄.
 *
 * 각 줄: 언제 누가 닫았는지, 수단별로 마감 순간의 기대 금액(Total Remaining) · 센 돈 · 과부족, 마감 뒤에 결제·환불이
 * 더 들어와 다시 세야 하는지(Recount), 매출이 있는데 아무도 닫지 않았는지(Not closed). 마감 자체는 계산대 홈의
 * Close Register 에서 한다 — 여기는 읽기만. 2026-10-21 부터는 서랍이 하나라 하루 한 줄이다(0062).
 *
 * 2026-10-24 부터 하루 두 번(Morning · Dinner, 0092) — 근무마다 한 줄, 담당자(캐셔)와 근무 시각이 같이 보인다.
 * 모닝 마감이 없으면 디너 한 줄이 하루 전체다. 현금 칸을 누르면 그 근무의 현금 거래를 담당자별로 본다(`CashTransactions`).
 *
 * 현금은 `/cash` 에서만 보인다. 서버(0065)도 현금 리포트 계정이 아니면 현금 줄을 보내지 않는다 —
 * `cash` 로 한 번 더 거르는 것은 다른 탭과 같은 두 번째 울타리다.
 */

import { useEffect, useMemo, useState } from "react";

import retailApi, { localBusinessDate, toRetailError } from "@/lib/retail/api";
import { CLUB_TIME_ZONE, PAYMENT_LABELS, stationLabel, usDate } from "@/lib/retail/receipt";
import {
  formatMoney,
  type Cents,
  type RegisterCloseHistory,
  type RegisterCloseHistoryLine,
  type RegisterCloseHistoryRow,
} from "@/lib/retail/types";
import { addDays } from "@/lib/teeSheet/dates";

import { CashShiftModal, SHIFT_LABELS } from "@/components/reports/CashTransactions";
import { EmptyNote, ErrorNote, Field, SkeletonRows, StatCard, TextInput } from "@/components/retail/ui";

/** 근무마다 남기는 시작 잔돈(`pelham_register_float`). 현금 줄의 expected·now 에 들어 있다. */
const CASH_FLOAT = 20000;

/** Close Register 표와 같은 이름. */
const METHOD_LABELS: Record<string, string> = { cash: "Cash", card: "Credit Card", debit: "Debit Card" };

type Status = "closed" | "stale" | "open";

const BADGE: Record<Status, { label: string; className: string }> = {
  closed: { label: "Closed", className: "bg-[#dcfce7] text-[#166534]" },
  stale: { label: "Recount", className: "bg-[#fff1cc] text-[#8a5a00]" },
  open: { label: "Not closed", className: "bg-[#fee2e2] text-[#991b1b]" },
};

function statusOf(row: RegisterCloseHistoryRow): Status {
  if (!row.closed) return "open";
  return row.stale ? "stale" : "closed";
}

function closedAt(iso: string | null): string {
  if (!iso) return "";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  return at.toLocaleString("en-CA", { timeZone: CLUB_TIME_ZONE, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function signed(cents: Cents): string {
  return cents > 0 ? `+${formatMoney(cents)}` : formatMoney(cents);
}

function DiffText({ diff }: { diff: Cents | null }) {
  if (diff === null) return null;
  if (diff === 0) return <span className="text-[#166534]">even</span>;
  return <span className={diff > 0 ? "text-[#1d4ed8]" : "text-[#b91c1c]"}>{diff > 0 ? "over " : "short "}{signed(diff)}</span>;
}

export default function RegisterClosesReport({ cash }: { cash: boolean }) {
  const today = localBusinessDate();
  const [from, setFrom] = useState(() => addDays(today, -13));
  const [to, setTo] = useState(today);
  const [loaded, setLoaded] = useState<{ range: string; report: RegisterCloseHistory | null; error: string } | null>(null);
  // 현금 칸을 눌러 연 근무.
  const [cashOf, setCashOf] = useState<RegisterCloseHistoryRow | null>(null);

  const range = `${from}..${to}`;
  const rangeError = from && to && from > to ? "From must be on or before To." : "";
  const loading = loaded?.range !== range;

  useEffect(() => {
    if (rangeError || !from || !to) return;
    let cancelled = false;
    retailApi
      .getRegisterCloseHistory(from, to)
      .then((report) => {
        if (!cancelled) setLoaded({ range, report, error: "" });
      })
      .catch((cause) => {
        if (!cancelled) setLoaded({ range, report: null, error: toRetailError(cause).message });
      });
    return () => {
      cancelled = true;
    };
  }, [from, to, range, rangeError]);

  const report = loaded && !loading ? loaded.report : null;
  const showCash = cash && Boolean(report?.cash);
  const counted = useMemo(() => (showCash ? ["cash", "card", "debit"] : ["card", "debit"]), [showCash]);
  const rows = useMemo(() => report?.rows ?? [], [report]);

  const closedRows = rows.filter((row) => row.closed);
  const openRows = rows.filter((row) => !row.closed);
  const staleRows = rows.filter((row) => row.closed && row.stale);
  const overShort = counted.map((method) => ({
    method,
    diff: closedRows.reduce((total, row) => total + (lineOf(row, method)?.diff ?? 0), 0),
  }));

  return (
    <div className="grid min-w-0 gap-3">
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Business date from">
          <TextInput max={to} onChange={(event) => setFrom(event.target.value)} type="date" value={from} />
        </Field>
        <Field label="To">
          <TextInput max={today} min={from} onChange={(event) => setTo(event.target.value)} type="date" value={to} />
        </Field>
      </div>

      {rangeError ? <ErrorNote>{rangeError}</ErrorNote> : null}
      {loaded && !loading && loaded.error ? <ErrorNote>{loaded.error}</ErrorNote> : null}

      {loading && !rangeError ? (
        <SkeletonRows count={6} />
      ) : !report ? null : (
        <>
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-5">
            <StatCard hint={`${rows.length} shift close(s) with sales or a count`} label="Closed" strong value={String(closedRows.length)} />
            <StatCard hint="sales but nobody closed" label="Not closed" value={String(openRows.length)} />
            <StatCard hint="payments or refunds after the count" label="Recount" value={String(staleRows.length)} />
            {overShort.map((item) => (
              <StatCard
                hint="counted − expected, closed days"
                key={item.method}
                label={`${METHOD_LABELS[item.method]} over/short`}
                value={signed(item.diff)}
              />
            ))}
          </div>

          {rows.length === 0 ? (
            <EmptyNote>No register closes or sales for these dates.</EmptyNote>
          ) : (
            <div className="min-w-0 overflow-x-auto border border-[#d4d4d8] bg-white">
              <table className="w-full min-w-[980px] text-left text-sm">
                <thead className="bg-[#f3f4f6] text-xs text-[#3f434a] uppercase">
                  <tr>
                    <th className="px-3 py-2">Business date</th>
                    <th className="px-3 py-2">Drawer · shift</th>
                    <th className="px-3 py-2">Close</th>
                    {counted.map((method) => (
                      <th className="px-3 py-2 text-right" key={method}>
                        {METHOD_LABELS[method]}
                      </th>
                    ))}
                    <th className="px-3 py-2 text-right">Other</th>
                    <th className="px-3 py-2">Note</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const status = statusOf(row);
                    const others = row.lines.filter((line) => !line.countable && line.expected !== 0);
                    return (
                      <tr className="border-t border-[#ececf0] align-top" key={`${row.business_date}-${row.drawer}-${row.shift ?? "day"}`}>
                        <td className="px-3 py-2 whitespace-nowrap tabular-nums">{usDate(row.business_date)}</td>
                        <td className="px-3 py-2">
                          <span className="block font-bold">
                            {stationLabel(row.drawer)}
                            {row.shift ? ` · ${SHIFT_LABELS[row.shift]}` : ""}
                          </span>
                          {row.stations.length > 1 ? (
                            <span className="block text-xs text-[#6b7280]">{row.stations.map(stationLabel).join(" · ")}</span>
                          ) : null}
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap">
                          <span className={`inline-block px-1.5 py-0.5 text-xs font-bold ${BADGE[status].className}`}>
                            {BADGE[status].label}
                          </span>
                          {row.closed ? (
                            <span className="block text-xs text-[#6b7280]">
                              {[closedAt(row.closed_at), row.closed_by].filter(Boolean).join(" · ")}
                            </span>
                          ) : null}
                          {/* 담당자·근무 시각(0081). 그 전 마감에는 없다. */}
                          {row.cashier ? (
                            <span className="block text-xs font-bold text-[#1f2328]">
                              {row.cashier}
                              {row.shift_start && row.shift_end ? ` · ${row.shift_start}–${row.shift_end}` : ""}
                            </span>
                          ) : null}
                        </td>
                        {counted.map((method) => (
                          <MethodCell
                            key={method}
                            line={lineOf(row, method)}
                            onOpen={method === "cash" ? () => setCashOf(row) : undefined}
                            row={row}
                          />
                        ))}
                        <td className="px-3 py-2 text-right text-xs whitespace-nowrap tabular-nums">
                          {others.length === 0
                            ? null
                            : others.map((line) => (
                                <span className="block" key={line.method}>
                                  {PAYMENT_LABELS[line.method] ?? line.method} {formatMoney(line.expected)}
                                </span>
                              ))}
                        </td>
                        <td className="px-3 py-2 text-xs">{row.note}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="text-xs text-[#6b7280]">
            Expected is the Total Remaining when the drawer was counted (cash includes the $200 float); for a day
            nobody closed it is what the drawer should hold now. Recount means payments or refunds came in after the
            count — open Close Register for that day and count again. From Oct 21, 2026 one drawer takes every
            screen&apos;s payments. From Oct 24, 2026 the drawer is closed twice a day — Morning · Shift 1 (up to the
            morning shift end time) and Evening · Shift 2 (everything after); a day with no Shift 1 close has one Shift 2 row for the
            whole day. Tap a cash amount to see that shift&apos;s cash transactions by cashier. Online payments are
            never in a drawer.
          </p>
          {cashOf ? (
            <CashShiftModal
              date={cashOf.business_date}
              onClose={() => setCashOf(null)}
              title={`Cash transactions — ${cashOf.shift ? SHIFT_LABELS[cashOf.shift] : "Day"} · ${usDate(cashOf.business_date)}`}
              window={cashOf.window}
            />
          ) : null}
        </>
      )}
    </div>
  );
}

function lineOf(row: RegisterCloseHistoryRow, method: string): RegisterCloseHistoryLine | undefined {
  return row.lines.find((line) => line.method === method);
}

function MethodCell({
  line,
  row,
  onOpen,
}: {
  line: RegisterCloseHistoryLine | undefined;
  row: RegisterCloseHistoryRow;
  /** 현금 칸 — 눌러서 그 근무의 현금 거래를 본다. */
  onOpen?: () => void;
}) {
  if (!line) return <td className="px-3 py-2" />;
  return (
    <td className="px-3 py-2 text-right whitespace-nowrap tabular-nums">
      {onOpen ? (
        <button className="block w-full text-right text-xs font-bold text-[#4533ff] underline" onClick={onOpen} type="button">
          cash sales {formatMoney(line.now - CASH_FLOAT)} →
        </button>
      ) : null}
      {row.closed && line.counted === null && line.method !== "cash" ? (
        <>
          {/* 캐셔는 현금만 센다(0090) — 카드 전표는 매니저가 세기 전까지 비어 있다. */}
          <span className="block text-[#6b7280]">not counted</span>
          <span className="block text-xs text-[#6b7280]">expected {formatMoney(line.expected)}</span>
        </>
      ) : row.closed ? (
        <>
          <span className="block font-bold">{formatMoney(line.counted ?? 0)}</span>
          <span className="block text-xs text-[#6b7280]">expected {formatMoney(line.expected)}</span>
          <span className="block text-xs font-bold">
            <DiffText diff={line.diff} />
          </span>
          {row.stale && line.now !== line.expected ? (
            <span className="block text-xs text-[#8a5a00]">now {formatMoney(line.now)}</span>
          ) : null}
        </>
      ) : (
        <>
          <span className="block text-[#6b7280]">not counted</span>
          <span className="block text-xs text-[#6b7280]">expected {formatMoney(line.expected)}</span>
        </>
      )}
    </td>
  );
}
