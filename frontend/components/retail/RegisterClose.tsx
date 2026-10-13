"use client";

/**
 * 계산대 마감(Close Register). Lightspeed R-Series 의 "Register - … Closing Totals" 화면을 옮겼다 —
 * 직원들이 그 표에 손이 익어 있다(2026-10-12).
 *
 * 줄 = 결제수단, 칸 = Start+Adds · Payments · Withdraws · Total Remaining · Closing Count.
 * 숫자(Total Remaining 까지)는 **서버가** 계산서에서 센다(0023). 화면은 센 돈만 더한다 —
 * 현금은 권종 × 개수 + Extra, 카드·체크카드는 단말기 마감 전표 금액.
 * 회원 계정·기프트카드·레인체크는 셀 실물이 없어 Lightspeed 의 Credit Account / Gift Card 줄처럼 숫자만.
 *
 * Lightspeed 의 Open Drawer 버튼은 없다 — 이 계산대는 아직 서랍을 열 수 없다(눌러도 안 되는 버튼은
 * 그리지 않는다, `RegisterHome` 과 같은 규칙).
 */

import { useEffect, useMemo, useState, type ReactNode } from "react";

import retailApi, { toRetailError } from "@/lib/retail/api";
import { PAYMENT_LABELS } from "@/lib/retail/receipt";
import {
  CASH_DENOMINATIONS,
  formatMoney,
  parseMoney,
  type CashCounts,
  type Cents,
  type RegisterCloseReport,
  type RegisterCloseRow,
} from "@/lib/retail/types";

import { Button, ErrorNote, SkeletonRows, TextInput } from "./ui";

/** Lightspeed 표와 같은 이름. */
const ROW_LABELS: Partial<Record<string, string>> = {
  card: "Credit Card",
  debit: "Debit Card",
  member_account: "Credit Account",
};

function rowLabel(method: string): string {
  return ROW_LABELS[method] ?? PAYMENT_LABELS[method as keyof typeof PAYMENT_LABELS] ?? method;
}

function denominationLabel(cents: number): string {
  return cents >= 100 ? `$${cents / 100}` : `${cents}¢`;
}

/** 돈 입력칸 초깃값. 0 은 "0.00" 으로(Lightspeed 처럼). */
function moneyText(cents: Cents | null | undefined): string {
  return ((cents ?? 0) / 100).toFixed(2);
}

function countOf(text: string): number {
  const value = Number.parseInt(text.replace(/[^0-9]/g, ""), 10);
  return Number.isFinite(value) ? value : 0;
}

export default function RegisterClose({
  date,
  station,
  registerName,
  onCancel,
  onStaffCloseout,
}: {
  date: string;
  station: string;
  registerName: string;
  onCancel: () => void;
  /** 담당자별 마감(근무시간·팁)으로. */
  onStaffCloseout: () => void;
}) {
  const [report, setReport] = useState<RegisterCloseReport | null>(null);
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    let cancelled = false;
    retailApi
      .getRegisterClose(date, station)
      .then((value) => {
        if (!cancelled) setReport(value);
      })
      .catch((cause) => {
        if (!cancelled) setLoadError(toRetailError(cause).message);
      });
    return () => {
      cancelled = true;
    };
  }, [date, station]);

  if (loadError) return <ErrorNote>{loadError}</ErrorNote>;
  if (!report) return <SkeletonRows count={6} />;
  return (
    <CloseForm
      onCancel={onCancel}
      onSaved={setReport}
      onStaffCloseout={onStaffCloseout}
      registerName={registerName}
      report={report}
    />
  );
}

function CloseForm({
  report,
  registerName,
  onSaved,
  onCancel,
  onStaffCloseout,
}: {
  report: RegisterCloseReport;
  registerName: string;
  onSaved: (report: RegisterCloseReport) => void;
  onCancel: () => void;
  onStaffCloseout: () => void;
}) {
  const saved = report.close;
  // 이미 셌으면 그 숫자로 연다(다시 세기).
  const [counts, setCounts] = useState<Record<string, string>>(() =>
    Object.fromEntries(CASH_DENOMINATIONS.map((cents) => [String(cents), String(saved?.cash_counts[String(cents)] ?? 0)])),
  );
  const [extra, setExtra] = useState(moneyText(saved?.cash_counts.extra));
  const [card, setCard] = useState(moneyText(saved?.counted.card));
  const [debit, setDebit] = useState(moneyText(saved?.counted.debit));
  const [note, setNote] = useState(saved?.note ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [justSaved, setJustSaved] = useState(false);

  const cashTotal = useMemo(
    () =>
      CASH_DENOMINATIONS.reduce((sum, cents) => sum + cents * countOf(counts[String(cents)] ?? ""), 0) +
      parseMoney(extra),
    [counts, extra],
  );
  const counted: Record<string, Cents> = { cash: cashTotal, card: parseMoney(card), debit: parseMoney(debit) };

  const totals = report.rows.reduce(
    (sum, row) => ({
      start: sum.start + row.start,
      payments: sum.payments + row.payments,
      withdraws: sum.withdraws + row.withdraws,
      remaining: sum.remaining + row.remaining,
    }),
    { start: 0, payments: 0, withdraws: 0, remaining: 0 },
  );

  async function submit() {
    setBusy(true);
    setError("");
    setJustSaved(false);
    const cashCounts: CashCounts = Object.fromEntries(
      CASH_DENOMINATIONS.map((cents) => [String(cents), countOf(counts[String(cents)] ?? "")]),
    );
    cashCounts.extra = parseMoney(extra);
    try {
      onSaved(
        await retailApi.saveRegisterClose(report.business_date, report.station, {
          counted: { cash: counted.cash, card: counted.card, debit: counted.debit },
          cash_counts: cashCounts,
          note: note.trim() || null,
        }),
      );
      setJustSaved(true);
    } catch (cause) {
      setError(toRetailError(cause).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid min-w-0 gap-4">
      <h3 className="text-lg font-bold text-[#2b2f36]">
        Register - &quot;{registerName}&quot; Closing Totals
      </h3>

      {report.open_bills > 0 ? (
        <p className="bg-[#fff8e1] px-3 py-2 text-sm text-[#5b4708]">
          {report.open_bills} sale(s) on this register are still open. Charge or void them before closing.
        </p>
      ) : null}

      {saved ? (
        <SavedSummary close={saved} justSaved={justSaved} rows={report.rows} />
      ) : null}

      {/* 표는 넓다. 좁은 화면에서는 표 안에서만 옆으로 민다. */}
      <div className="-mx-3 overflow-x-auto px-3">
        <table className="w-full min-w-[640px] border-collapse border border-[#d4d4d8] text-sm">
          <thead>
            <tr className="bg-[#f2f2f4] text-[#1f2328]">
              <Th className="text-left">Type</Th>
              <Th>Start+Adds</Th>
              <Th>Payments</Th>
              <Th>Withdraws</Th>
              <Th>Total Remaining</Th>
              <Th className="w-[13rem] text-center">Closing Count</Th>
            </tr>
          </thead>
          <tbody>
            {report.rows.map((row) => (
              <tr className="border-t border-[#d4d4d8] align-top" key={row.method}>
                <td className="px-2 py-2 font-bold">{rowLabel(row.method)}</td>
                <Money value={row.start} />
                <Money value={row.payments} />
                <Money value={row.withdraws} />
                <Money value={row.remaining} />
                <td className="border-l border-[#d4d4d8] px-2 py-2">
                  {row.method === "cash" ? (
                    <CashCount
                      counts={counts}
                      extra={extra}
                      onCount={(key, value) => setCounts((prev) => ({ ...prev, [key]: value }))}
                      onExtra={setExtra}
                      total={cashTotal}
                    />
                  ) : row.countable ? (
                    <MoneyInput
                      label={`${rowLabel(row.method)} closing count`}
                      onChange={row.method === "card" ? setCard : setDebit}
                      value={row.method === "card" ? card : debit}
                    />
                  ) : (
                    <p className="py-0.5 text-right tabular-nums">{formatMoney(row.remaining)}</p>
                  )}
                  {row.countable ? <Diff counted={counted[row.method]} expected={row.remaining} /> : null}
                </td>
              </tr>
            ))}
            <tr className="border-t border-[#d4d4d8] bg-[#f2f2f4] font-bold">
              <td className="px-2 py-2">Totals</td>
              <Money value={totals.start} />
              <Money value={totals.payments} />
              <Money value={totals.withdraws} />
              <Money value={totals.remaining} />
              <td className="border-l border-[#d4d4d8]" />
            </tr>
          </tbody>
        </table>
      </div>

      <label className="grid gap-1 border-t border-[#d4d4d8] pt-3 sm:grid-cols-[5rem_1fr] sm:items-center">
        <span className="text-sm font-bold text-[#3f434a] sm:text-right sm:pr-3">Note</span>
        <TextInput onChange={(event) => setNote(event.target.value)} placeholder="Why it's over/short…" value={note} />
      </label>

      {error ? <ErrorNote>{error}</ErrorNote> : null}

      <div className="flex flex-wrap gap-2 border-t border-[#d4d4d8] pt-3">
        <Button disabled={busy} onClick={() => void submit()} tone="primary">
          {busy ? "Submitting…" : saved ? "Submit Counts Again" : "Submit Counts"}
        </Button>
        <Button disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
        <Button className="sm:ml-auto" disabled={busy} onClick={onStaffCloseout}>
          Staff hours &amp; tip split →
        </Button>
      </div>
    </div>
  );
}

// ===== 조각 ============================================================

function Th({ children, className = "text-right" }: { children: ReactNode; className?: string }) {
  return <th className={`border-l border-[#d4d4d8] px-2 py-2 font-bold first:border-l-0 ${className}`}>{children}</th>;
}

function Money({ value }: { value: Cents }) {
  return <td className="border-l border-[#d4d4d8] px-2 py-2 text-right tabular-nums">{formatMoney(value)}</td>;
}

function CashCount({
  counts,
  extra,
  total,
  onCount,
  onExtra,
}: {
  counts: Record<string, string>;
  extra: string;
  total: Cents;
  onCount: (key: string, value: string) => void;
  onExtra: (value: string) => void;
}) {
  return (
    <div className="grid gap-1.5">
      {CASH_DENOMINATIONS.map((cents) => (
        <label className="grid grid-cols-[1fr_5rem] items-center gap-2" key={cents}>
          <span className="text-right tabular-nums">{denominationLabel(cents)} ×</span>
          <input
            className="min-h-9 w-full border border-[#a1a1aa] px-2 text-right tabular-nums focus:border-[#4533ff] focus:outline-none"
            inputMode="numeric"
            onChange={(event) => onCount(String(cents), event.target.value.replace(/[^0-9]/g, ""))}
            onFocus={(event) => event.currentTarget.select()}
            value={counts[String(cents)] ?? ""}
          />
        </label>
      ))}
      <label className="grid grid-cols-[3.5rem_1fr] items-center gap-2">
        <span className="text-right">Extra</span>
        <MoneyInput label="Extra cash" onChange={onExtra} value={extra} />
      </label>
      <div className="grid grid-cols-[3.5rem_1fr] items-center gap-2">
        <span className="text-right">Total</span>
        <p className="flex min-h-9 items-center justify-between border border-[#d4d4d8] bg-[#f7f7f8] px-2 tabular-nums">
          <span className="text-[#6b7280]">$</span>
          {(total / 100).toFixed(2)}
        </p>
      </div>
    </div>
  );
}

function MoneyInput({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <span className="flex min-h-9 items-center border border-[#a1a1aa] px-2 focus-within:border-[#4533ff]">
      <span className="text-[#6b7280]">$</span>
      <input
        aria-label={label}
        className="min-w-0 flex-1 bg-transparent text-right tabular-nums focus:outline-none"
        inputMode="decimal"
        onBlur={() => onChange((parseMoney(value) / 100).toFixed(2))}
        onChange={(event) => onChange(event.target.value)}
        onFocus={(event) => event.currentTarget.select()}
        value={value}
      />
    </span>
  );
}

/** 센 돈 − Total Remaining. 0 이면 맞음. */
function Diff({ counted, expected }: { counted: Cents; expected: Cents }) {
  const diff = counted - expected;
  return (
    <p className={`mt-1 text-right text-xs font-bold ${diff === 0 ? "text-[#1f6b3a]" : "text-[#8a1f1f]"}`}>
      {diff === 0 ? "Balances" : `${diff > 0 ? "Over" : "Short"} ${formatMoney(Math.abs(diff))}`}
    </p>
  );
}

/** 마지막으로 센 결과(서버에 적힌 값). */
function SavedSummary({
  close,
  rows,
  justSaved,
}: {
  close: NonNullable<RegisterCloseReport["close"]>;
  rows: RegisterCloseRow[];
  justSaved: boolean;
}) {
  const off = rows
    .filter((row) => row.countable)
    .map((row) => ({
      label: rowLabel(row.method),
      diff: (close.counted[row.method] ?? 0) - (close.expected[row.method] ?? 0),
    }))
    .filter((item) => item.diff !== 0);
  const tone = close.stale
    ? "bg-[#fdf0f0] text-[#8a1f1f]"
    : off.length === 0
      ? "bg-[#e8f5ec] text-[#1f6b3a]"
      : "bg-[#fff8e1] text-[#5b4708]";
  return (
    <div className={`grid gap-0.5 px-3 py-2 text-sm ${tone}`}>
      <p className="font-bold">
        {justSaved ? "Counts submitted" : "Counted"} {new Date(close.closed_at).toLocaleString("en-CA")}
        {off.length === 0 ? " — register balances." : ""}
      </p>
      {off.map((item) => (
        <p key={item.label}>
          {item.label}: {item.diff > 0 ? "over" : "short"} {formatMoney(Math.abs(item.diff))}
        </p>
      ))}
      {close.stale ? <p>Sales on this register changed after the count. Count again.</p> : null}
    </div>
  );
}
