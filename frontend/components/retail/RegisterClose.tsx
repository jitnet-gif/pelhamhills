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
 * 현금은 **블라인드 카운트**다(2026-10-20, 0046): 현금 리포트 계정이 아니면 현금 줄의 Payments·Total Remaining·
 * 과부족을 보여 주지 않는다. 직원은 서랍을 세고 시작 잔돈($200)만 남긴 뒤 나머지를 전부 현금 매출로 넘긴다 —
 * 화면은 "남길 잔돈"과 "넘길 현금"(센 돈 − 잔돈)만 알려 준다. 과부족은 현금 리포트 계정이 본다.
 * 서버도 그 계정이 아니면 현금 기대 금액을 보내지 않는다. 화면의 `blindCash` 는 0046 전에도 가리려는 두 번째 울타리다.
 *
 * Lightspeed 의 Open Drawer 버튼은 없다 — 이 계산대는 아직 서랍을 열 수 없다(눌러도 안 되는 버튼은
 * 그리지 않는다, `RegisterHome` 과 같은 규칙).
 */

import { useEffect, useMemo, useState, type ReactNode } from "react";

import { REGISTER_CLOSE_GUIDE } from "@/lib/nav";
import retailApi, { toRetailError } from "@/lib/retail/api";
import { PAYMENT_LABELS, stationLabel } from "@/lib/retail/receipt";
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
  blindCash,
}: {
  date: string;
  station: string;
  registerName: string;
  onCancel: () => void;
  /** 현금 기대 금액·과부족을 가린다(현금 리포트 계정이 아닐 때). */
  blindCash: boolean;
  /** 담당자별 마감(근무시간·팁)으로. 현금 리포트 계정이 아니면 없다(0046) — 버튼을 그리지 않는다. */
  onStaffCloseout?: () => void;
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
      blind={blindCash || report.cash_blind === true}
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
  blind,
}: {
  blind: boolean;
  report: RegisterCloseReport;
  registerName: string;
  onSaved: (report: RegisterCloseReport) => void;
  onCancel: () => void;
  onStaffCloseout?: () => void;
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

  // 블라인드면 현금 줄의 기대 금액을 지운다. 합계도 지운다 — 합계에서 다른 줄을 빼면 현금 매출이 나온다.
  const rows = report.rows.map((row) =>
    blind && row.method === "cash" ? { ...row, payments: null, payment_count: null, remaining: null } : row,
  );
  const totals = rows.reduce(
    (sum, row) => ({
      start: sum.start + row.start,
      payments: sum.payments === null || row.payments === null ? null : sum.payments + row.payments,
      withdraws: sum.withdraws + row.withdraws,
      remaining: sum.remaining === null || row.remaining === null ? null : sum.remaining + row.remaining,
    }),
    { start: 0, payments: 0 as Cents | null, withdraws: 0, remaining: 0 as Cents | null },
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
        Register - &quot;{report.stations && report.stations.length > 1 ? stationLabel(report.station) : registerName}&quot;
        Closing Totals
      </h3>

      {/* 0062: 서랍이 하나라 어느 화면에서 열어도 같은 마감이다. 무엇이 들어 있는지 적어 둔다. */}
      {report.stations && report.stations.length > 1 ? (
        <p className="bg-[#f2f2f4] px-3 py-2 text-sm text-[#3f434a]">
          One drawer for the whole club — includes every sale from {report.stations.map(stationLabel).join(", ")}.
          Online booking payments are not in the drawer or on the terminal slip.
        </p>
      ) : null}

      {report.open_bills > 0 ? (
        <p className="bg-[#fff8e1] px-3 py-2 text-sm text-[#5b4708]">
          {report.open_bills} sale(s) on this register are still open. Charge or void them before closing.
        </p>
      ) : null}

      {saved ? (
        <SavedSummary blind={blind} close={saved} justSaved={justSaved} rows={rows} />
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
            {rows.map((row) => (
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
                    <p className="py-0.5 text-right tabular-nums">{formatMoney(row.remaining ?? 0)}</p>
                  )}
                  {row.countable && row.remaining !== null ? (
                    <Diff counted={counted[row.method]} expected={row.remaining} />
                  ) : row.method === "cash" ? (
                    <CashDrop counted={cashTotal} float={row.start} />
                  ) : null}
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
        <TextInput
          onChange={(event) => setNote(event.target.value)}
          placeholder={blind ? "Anything the manager should know…" : "Why it's over/short…"}
          value={note}
        />
      </label>

      {error ? <ErrorNote>{error}</ErrorNote> : null}

      <div className="flex flex-wrap gap-2 border-t border-[#d4d4d8] pt-3">
        <Button disabled={busy} onClick={() => void submit()} tone="primary">
          {busy ? "Submitting…" : saved ? "Submit Counts Again" : "Submit Counts"}
        </Button>
        <Button disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
        {onStaffCloseout ? (
          <Button className="sm:ml-auto" disabled={busy} onClick={onStaffCloseout}>
            Staff hours &amp; tip split →
          </Button>
        ) : null}
      </div>

      {/* 이 화면 사용법(나레이션 프레젠테이션). 새 탭으로 열어 마감 창은 그대로 둔다. */}
      <a
        className="justify-self-start text-sm font-bold text-[#4533ff] underline"
        href={REGISTER_CLOSE_GUIDE}
        rel="noopener"
        target="_blank"
      >
        ▶ How closing works (Korean / English)
      </a>
    </div>
  );
}

// ===== 조각 ============================================================

function Th({ children, className = "text-right" }: { children: ReactNode; className?: string }) {
  return <th className={`border-l border-[#d4d4d8] px-2 py-2 font-bold first:border-l-0 ${className}`}>{children}</th>;
}

/** null = 이 계정에는 가린 칸(블라인드 카운트). */
function Money({ value }: { value: Cents | null }) {
  return (
    <td className="border-l border-[#d4d4d8] px-2 py-2 text-right tabular-nums">
      {value === null ? <span className="text-[#6b7280]">—</span> : formatMoney(value)}
    </td>
  );
}

/** 블라인드 카운트: 시작 잔돈만 남기고 나머지는 현금 매출로 넘긴다. 맞는지 아닌지는 말하지 않는다. */
function CashDrop({ counted, float }: { counted: Cents; float: Cents }) {
  if (counted < float) {
    return (
      <p className="mt-1 text-right text-xs font-bold text-[#8a1f1f]">
        Less than the {formatMoney(float)} float — count again.
      </p>
    );
  }
  return (
    <div className="mt-1 grid gap-0.5 text-right text-xs">
      <p>
        Keep in drawer <b className="tabular-nums">{formatMoney(float)}</b>
      </p>
      <p className="font-bold text-[#1f2328]">
        Cash sales to hand in <span className="tabular-nums">{formatMoney(counted - float)}</span>
      </p>
    </div>
  );
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
  blind,
}: {
  close: NonNullable<RegisterCloseReport["close"]>;
  rows: RegisterCloseRow[];
  justSaved: boolean;
  blind: boolean;
}) {
  // 블라인드면 현금은 과부족을 말하지 않고, 넘긴 현금(센 돈 − 잔돈)만 적는다.
  const drop = blind ? (close.counted.cash ?? 0) - close.opening_float : null;
  const off = rows
    .filter((row) => row.countable && !(blind && row.method === "cash"))
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
        {off.length === 0 && !blind ? " — register balances." : ""}
      </p>
      {drop !== null ? (
        <p>
          Cash sales handed in: {formatMoney(Math.max(0, drop))} (float {formatMoney(close.opening_float)} kept)
        </p>
      ) : null}
      {off.map((item) => (
        <p key={item.label}>
          {item.label}: {item.diff > 0 ? "over" : "short"} {formatMoney(Math.abs(item.diff))}
        </p>
      ))}
      {close.stale ? <p>Sales on this register changed after the count. Count again.</p> : null}
    </div>
  );
}
