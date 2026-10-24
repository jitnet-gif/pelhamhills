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
 * 캐셔의 마감은 **현금만**이다(2026-10-23, 0090): 카드·체크카드·회원 계정 같은 다른 줄은 그리지 않고, 카드 단말기
 * 전표도 세지 않는다 — 카드 매출을 캐셔에게 보이지 않는다. 카드는 현금 리포트 계정이 같은 화면(전부 보임)이나
 * Stripe 대사에서 맞춘다. 출력하는 근무 마감표도 센 현금·남길 잔돈·넘길 현금만 찍는다.
 * 2026-10-24 부터는 현금 리포트 계정(매니저)도 이 화면에서 **현금 줄만** 본다 — 카드·체크카드는 Daily close 의
 * Card & debit vs. Stripe 에서 맞춘다. 매니저는 현금 줄의 기대 금액·과부족을 그대로 본다.
 *
 * 하루 두 번 마감한다 — **Morning · Dinner**(2026-10-24, 0092). 모닝 캐셔가 자기 시간의 현금을 세어 잔돈 $200 만 남기고
 * 넘기고, 디너 캐셔가 그 뒤를 센다. 경계는 모닝 마감의 끝 시각이다(그 분까지 모닝). 모닝을 건너뛰면 디너가 하루 전체를 센다.
 * 현금 리포트 계정은 Cash 줄의 Payments 를 눌러 그 근무의 현금 거래를 담당자별로 본다(`CashTransactions`).
 *
 * Lightspeed 의 Open Drawer 버튼은 없다 — 이 계산대는 아직 서랍을 열 수 없다(눌러도 안 되는 버튼은
 * 그리지 않는다, `RegisterHome` 과 같은 규칙).
 */

import { useEffect, useMemo, useState, type ReactNode } from "react";

import { REGISTER_CLOSE_GUIDE } from "@/lib/nav";
import { cashierName } from "@/lib/pos/cashierCode";
import { rememberCashier, rememberedCashier } from "@/lib/pos/currentBill";
import { defaultShiftEnd, defaultShiftStart, shiftSummary, shiftWindow } from "@/lib/reports/shiftReport";
import retailApi, { toRetailError } from "@/lib/retail/api";
import { printShiftReport } from "@/lib/retail/printReceipt";
import { PAYMENT_LABELS, stationLabel } from "@/lib/retail/receipt";
import {
  CASH_DENOMINATIONS,
  formatMoney,
  parseMoney,
  type CashCounts,
  type Cents,
  type RegisterCloseReport,
  type RegisterCloseRow,
  type RegisterShift,
  type Sale,
} from "@/lib/retail/types";

import CashierField from "@/components/reports/CashierField";
import { CashShiftModal, SHIFT_LABELS } from "@/components/reports/CashTransactions";
import { PrinterIcon, ShiftPreview, ShiftTimes } from "@/components/reports/ShiftReportPrint";

import { Button, Chip, ErrorNote, SkeletonRows, TextInput } from "./ui";

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

/** 처음 열 때의 근무. 오후 3시 전이면 모닝 — 직원이 칩으로 바꾼다. */
function guessShift(): RegisterShift {
  return new Date().getHours() < 15 ? "morning" : "dinner";
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
  blindCash,
}: {
  date: string;
  station: string;
  registerName: string;
  onCancel: () => void;
  /** 현금 기대 금액·과부족을 가린다(현금 리포트 계정이 아닐 때). */
  blindCash: boolean;
}) {
  const [shift, setShift] = useState<RegisterShift>(guessShift);
  // 근무를 바꾸면 그 근무의 표를 다시 읽는다. 다른 근무의 표는 그리지 않는다.
  const [loaded, setLoaded] = useState<{ shift: RegisterShift; report: RegisterCloseReport | null; error: string } | null>(
    null,
  );
  // 그날 계산서 — 근무 마감표(시작~끝 시각 합계)를 찍을 때 센다. 서랍이 하나라(0062) 화면을 가리지 않는다.
  const [sales, setSales] = useState<Sale[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    retailApi
      .getRegisterClose(date, station, shift)
      .then((value) => {
        if (!cancelled) setLoaded({ shift, report: value, error: "" });
      })
      .catch((cause) => {
        if (!cancelled) setLoaded({ shift, report: null, error: toRetailError(cause).message });
      });
    return () => {
      cancelled = true;
    };
  }, [date, station, shift]);

  useEffect(() => {
    let cancelled = false;
    retailApi
      .listSales(date)
      .then((value) => {
        if (!cancelled) setSales(value);
      })
      .catch(() => {
        // 마감은 계산서 목록 없이도 된다. 출력만 막힌다.
        if (!cancelled) setSales([]);
      });
    return () => {
      cancelled = true;
    };
  }, [date]);

  const report = loaded?.shift === shift ? loaded.report : null;
  return (
    <div className="grid min-w-0 gap-3">
      {/* 0092 전 서버(근무 없음)면 칩을 그리지 않는다 — 하루 한 마감 그대로. */}
      {loaded?.report && !loaded.report.shift ? null : (
        <ShiftPicker onPick={setShift} shift={shift} shifts={loaded?.report?.shifts} />
      )}
      {loaded?.shift === shift && loaded.error ? (
        <ErrorNote>{loaded.error}</ErrorNote>
      ) : !report || !sales ? (
        <SkeletonRows count={6} />
      ) : (
        <CloseForm
          blind={blindCash || report.cash_blind === true}
          key={shift}
          sales={sales}
          shift={shift}
          onCancel={onCancel}
          onSaved={(next) => setLoaded({ shift, report: next, error: "" })}
          registerName={registerName}
          report={report}
        />
      )}
    </div>
  );
}

/** Shift 1 | Shift 2. 이미 닫은 근무는 ✓ (이름은 넣지 않는다). */
function ShiftPicker({
  shift,
  shifts,
  onPick,
}: {
  shift: RegisterShift;
  shifts: RegisterCloseReport["shifts"];
  onPick: (shift: RegisterShift) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {(["morning", "dinner"] as const).map((key, index) => {
        const info = shifts?.find((item) => item.shift === key);
        return (
          <Chip active={shift === key} key={key} onClick={() => onPick(key)}>
            Shift {index + 1}
            {info?.closed ? " ✓" : ""}
          </Chip>
        );
      })}
    </div>
  );
}

function CloseForm({
  report,
  registerName,
  onSaved,
  onCancel,
  blind,
  sales,
  shift: shiftKey,
}: {
  blind: boolean;
  sales: Sale[];
  shift: RegisterShift;
  report: RegisterCloseReport;
  registerName: string;
  onSaved: (report: RegisterCloseReport) => void;
  onCancel: () => void;
}) {
  const saved = report.close;
  // 이미 셌으면 그 숫자로 연다(다시 세기).
  const [counts, setCounts] = useState<Record<string, string>>(() =>
    Object.fromEntries(CASH_DENOMINATIONS.map((cents) => [String(cents), String(saved?.cash_counts[String(cents)] ?? 0)])),
  );
  const [extra, setExtra] = useState(moneyText(saved?.cash_counts.extra));
  const [note, setNote] = useState(saved?.note ?? "");
  // 담당자와 근무 시각(0081). 다시 세면 저장된 값으로 연다.
  const [cashier, setCashier] = useState(() => saved?.cashier ?? rememberedCashier());
  // 디너는 모닝이 끝난 시각부터 시작한다(모닝을 닫았으면).
  const morningEnd = report.shifts?.find((item) => item.shift === "morning" && item.closed)?.shift_end ?? null;
  const [shiftStart, setShiftStart] = useState(
    () => saved?.shift_start ?? (shiftKey === "dinner" && morningEnd ? morningEnd : defaultShiftStart(sales)),
  );
  const [shiftEnd, setShiftEnd] = useState(() => saved?.shift_end ?? defaultShiftEnd(report.business_date));
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [justSaved, setJustSaved] = useState(false);
  // 현금 리포트 계정이 Cash 줄 Payments 를 눌러 여는 그 근무의 현금 거래.
  const [showCash, setShowCash] = useState(false);

  const cashTotal = useMemo(
    () =>
      CASH_DENOMINATIONS.reduce((sum, cents) => sum + cents * countOf(counts[String(cents)] ?? ""), 0) +
      parseMoney(extra),
    [counts, extra],
  );

  // 마감은 현금 줄 하나만(누구든, 2026-10-24). 블라인드면 기대 금액도 없이(0046·0090).
  const cashRows = report.rows.filter((row) => row.method === "cash");
  const rows = blind
    ? cashRows.map((row) => ({ ...row, payments: null, payment_count: null, remaining: null }))
    : cashRows;
  const float = report.rows.find((row) => row.method === "cash")?.start ?? 0;

  /** 담당자·시각을 확인해 돌려준다. 안 되면 오류를 띄우고 null. */
  async function shift(): Promise<{ name: string; start: string; end: string } | null> {
    let name: string;
    try {
      name = await cashierName(cashier);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That staff ID didn't work.");
      return null;
    }
    setCashier(name);
    if (!shiftWindow({ staff: name, date: report.business_date, start: shiftStart, end: shiftEnd })) {
      setError("Enter the shift start and end time.");
      return null;
    }
    return { name, start: shiftStart, end: shiftEnd };
  }

  async function print() {
    setError("");
    setBusy(true);
    try {
      const who = await shift();
      if (!who) return;
      const input = { staff: who.name, date: report.business_date, start: who.start, end: who.end };
      const range = shiftWindow(input);
      if (range) {
        printShiftReport(input, shiftSummary(sales, range), !blind, undefined, { counted: cashTotal, float });
      }
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    setBusy(true);
    setError("");
    setNotice("");
    setJustSaved(false);
    const who = await shift();
    if (!who) {
      setBusy(false);
      return;
    }
    rememberCashier(who.name);
    const cashCounts: CashCounts = Object.fromEntries(
      CASH_DENOMINATIONS.map((cents) => [String(cents), countOf(counts[String(cents)] ?? "")]),
    );
    cashCounts.extra = parseMoney(extra);
    try {
      const next = await retailApi.saveRegisterClose(report.business_date, report.station, {
        shift: shiftKey,
        // 현금만 센다 — 카드 칸을 보내지 않는다(캐셔는 서버(0090)가 옛 카드 값을 지킨다).
        counted: { cash: cashTotal },
        cash_counts: cashCounts,
        note: note.trim() || null,
        cashier: who.name,
        shift_start: who.start,
        shift_end: who.end,
      });
      onSaved(next);
      setJustSaved(true);
      // 0081 전 서버는 담당자·시각을 모르고 지나간다. 센 돈은 저장됐으니 그것만 알린다.
      if (next.close && next.close.cashier === undefined) {
        setNotice(
          "Counts saved, but the cashier and shift times were not — run 0081_register_close_shift.sql in the Supabase SQL Editor.",
        );
      }
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
        Closing Totals{report.shift ? ` — ${SHIFT_LABELS[shiftKey]}` : ""}
      </h3>

      {/* 0092: 경계는 모닝의 끝 시각. 모닝을 안 닫았으면 디너가 하루 전체다. 0092 전 서버면 안내하지 않는다. */}
      {!report.shift ? (
        blind ? null : (
          <p className="bg-[#fff8e1] px-3 py-2 text-sm text-[#5b4708]">
            Shift 1 / Shift 2 closes switch on once 0092_register_close_morning_dinner.sql is run in the Supabase SQL
            Editor. Until then this is the one close for the day.
          </p>
        )
      ) : (
        <p className="bg-[#eef6f0] px-3 py-2 text-sm text-[#1f4d2e]">
          {shiftKey === "morning"
            ? "Shift 1 covers sales up to the shift end time below. Count the drawer, keep the float, hand in the rest — Shift 2 counts everything after."
            : morningEnd
              ? `Shift 2 covers sales from ${morningEnd}, when Shift 1 ended. Count the drawer, keep the float, hand in the rest.`
              : "Shift 1 (Morning) has not been closed today, so this count covers the whole day."}
        </p>
      )}

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
                <Money
                  onClick={row.method === "cash" && row.payments !== null ? () => setShowCash(true) : undefined}
                  value={row.payments}
                />
                <Money value={row.withdraws} />
                <Money value={row.remaining} />
                <td className="border-l border-[#d4d4d8] px-2 py-2">
                  <CashCount
                    counts={counts}
                    extra={extra}
                    onCount={(key, value) => setCounts((prev) => ({ ...prev, [key]: value }))}
                    onExtra={setExtra}
                    total={cashTotal}
                  />
                  {/* 매니저는 과부족, 캐셔(블라인드)는 남길 잔돈·넘길 현금만. */}
                  {row.remaining !== null ? <Diff counted={cashTotal} expected={row.remaining} /> : null}
                  <CashDrop counted={cashTotal} float={row.start} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 누가 몇 시부터 몇 시까지 맡은 서랍인가(0081). 출력은 이 시간대의 합계만 — 계산서 목록은 찍지 않는다. */}
      <div className="grid gap-3 border-t border-[#d4d4d8] pt-3 sm:grid-cols-[1fr_1fr]">
        <CashierField onChange={setCashier} value={cashier} />
        <ShiftTimes end={shiftEnd} onEnd={setShiftEnd} onStart={setShiftStart} start={shiftStart} />
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
      {notice ? <p className="bg-[#fff8e1] px-3 py-2 text-sm text-[#5b4708]">{notice}</p> : null}

      <details className="border border-[#d4d4d8]">
        <summary className="cursor-pointer px-3 py-2 text-sm font-bold">Preview shift report</summary>
        <ShiftPreview
          cash={!blind}
          date={report.business_date}
          drop={{ counted: cashTotal, float }}
          end={shiftEnd}
          sales={sales}
          staff={cashier}
          start={shiftStart}
        />
      </details>

      <div className="flex flex-wrap gap-2 border-t border-[#d4d4d8] pt-3">
        <Button disabled={busy} onClick={() => void submit()} tone="primary">
          {busy ? "Submitting…" : saved ? "Submit Counts Again" : "Submit Counts"}
        </Button>
        <Button disabled={busy} onClick={() => void print()} title="Print the shift totals on the receipt printer">
          <span className="size-5">
            <PrinterIcon />
          </span>
          Print
        </Button>
        <Button disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>

      {showCash ? (
        <CashShiftModal
          date={report.business_date}
          onClose={() => setShowCash(false)}
          sales={sales}
          title={`Cash transactions — ${SHIFT_LABELS[shiftKey]} · ${report.business_date}`}
          window={report.window}
        />
      ) : null}

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

/** null = 이 계정에는 가린 칸(블라인드 카운트). `onClick` 이 있으면 눌러서 거래를 본다. */
function Money({ value, onClick }: { value: Cents | null; onClick?: () => void }) {
  return (
    <td className="border-l border-[#d4d4d8] px-2 py-2 text-right tabular-nums">
      {value === null ? (
        <span className="text-[#6b7280]">—</span>
      ) : onClick ? (
        <button
          className="font-bold text-[#4533ff] underline"
          onClick={onClick}
          title="See the cash transactions in this shift"
          type="button"
        >
          {formatMoney(value)}
        </button>
      ) : (
        formatMoney(value)
      )}
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
  const countedRows = rows.filter((row) => row.countable && !(blind && row.method === "cash"));
  const off = countedRows
    .filter((row) => close.counted[row.method] !== undefined)
    .map((row) => ({
      label: rowLabel(row.method),
      diff: (close.counted[row.method] ?? 0) - (close.expected[row.method] ?? 0),
    }))
    .filter((item) => item.diff !== 0);
  // 캐셔는 현금만 센다(0090) — 카드 전표를 아직 아무도 안 셌으면 매니저에게 그렇게 적는다.
  const notCounted = countedRows
    .filter((row) => row.method !== "cash" && close.counted[row.method] === undefined)
    .map((row) => rowLabel(row.method));
  const tone = close.stale
    ? "bg-[#fdf0f0] text-[#8a1f1f]"
    : off.length === 0 && notCounted.length === 0
      ? "bg-[#e8f5ec] text-[#1f6b3a]"
      : "bg-[#fff8e1] text-[#5b4708]";
  return (
    <div className={`grid gap-0.5 px-3 py-2 text-sm ${tone}`}>
      <p className="font-bold">
        {justSaved ? "Counts submitted" : "Counted"} {new Date(close.closed_at).toLocaleString("en-CA")}
        {off.length === 0 && notCounted.length === 0 && !blind ? " — register balances." : ""}
      </p>
      {close.cashier ? (
        <p>
          {close.cashier}
          {close.shift_start && close.shift_end ? ` · ${close.shift_start}–${close.shift_end}` : ""}
        </p>
      ) : null}
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
      {notCounted.length > 0 ? <p>{notCounted.join(" and ")}: not counted yet.</p> : null}
      {close.stale ? <p>Sales on this register changed after the count. Count again.</p> : null}
    </div>
  );
}
