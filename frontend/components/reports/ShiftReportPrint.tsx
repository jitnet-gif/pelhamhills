"use client";

/**
 * Daily close 의 Print 창 — 담당자(Pelham Shift ID 또는 이름)·시작·끝 시각을 적고, 그 사이 합계만 영수증 프린터로 찍는다.
 * 계산서 목록은 찍지 않는다. 무엇을 어떻게 세는지는 `lib/reports/shiftReport.ts`.
 * 미리보기와 종이가 같은 HTML 이다(`printReceipt.ts` 의 다른 전표와 같은 규칙).
 * 계산대 마감(`RegisterClose`)도 같은 칸·같은 출력을 쓴다.
 * 현금 리포트 계정이면 그날 팁 나누기(0010)도 아래에 붙는다(`useTipSplit`).
 */

import { useEffect, useState } from "react";

import { cashierName, isShiftCode } from "@/lib/pos/cashierCode";
import { rememberedCashier } from "@/lib/pos/currentBill";
import retailApi from "@/lib/retail/api";
import { printShiftReport, shiftReportSheetHtml } from "@/lib/retail/printReceipt";
import {
  cashierKey,
  defaultShiftEnd,
  defaultShiftStart,
  salesInWindow,
  shiftSummary,
  shiftWindow,
  type ShiftInput,
} from "@/lib/reports/shiftReport";
import type { CloseoutReport, Sale } from "@/lib/retail/types";

import CashierField from "@/components/reports/CashierField";
import { Button, ErrorNote, Field, Modal, TextInput } from "@/components/retail/ui";

export default function ShiftReportPrint({
  date,
  sales: allSales,
  cash,
  cashier,
  initialStart,
  initialEnd,
  onClose,
}: {
  date: string;
  sales: readonly Sale[];
  cash: boolean;
  /** 담당자별 출력(`CashierShifts`): 계산서 Cashier 칸이 이 이름인 것만 센다. 빈 문자열 = 이름 없는 계산서. */
  cashier?: string;
  initialStart?: string;
  initialEnd?: string;
  onClose: () => void;
}) {
  const sales =
    cashier === undefined ? allSales : allSales.filter((sale) => cashierKey(sale.cashier) === cashierKey(cashier));
  const [staff, setStaff] = useState(() => (cashier ? cashier : rememberedCashier()));
  const [start, setStart] = useState(() => initialStart ?? defaultShiftStart(sales));
  const [end, setEnd] = useState(() => initialEnd ?? defaultShiftEnd(date));
  // 담당자별로 열면 그 사람의 계산서를 한 줄씩 같이 찍는다. 하루 전체 출력은 합계만.
  const [withLines, setWithLines] = useState(cashier !== undefined);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const tipSplit = useTipSplit(date, cash);

  async function print() {
    setError("");
    setBusy(true);
    try {
      const name = await cashierName(staff);
      setStaff(name);
      const input: ShiftInput = { staff: name, date, start, end };
      const range = shiftWindow(input);
      if (!range) {
        setError("Enter a start and end time.");
        return;
      }
      printShiftReport(
        input,
        shiftSummary(sales, range),
        cash,
        withLines ? salesInWindow(sales, range) : undefined,
        tipSplit,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That staff ID didn't work.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      onClose={onClose}
      title={cashier === undefined ? `Print shift report — ${date}` : `Print ${cashier || "No cashier"} — ${date}`}
    >
      <div className="grid gap-3">
        {cashier !== undefined ? (
          <p className="bg-[#f2f2f4] px-3 py-2 text-sm text-[#3f434a]">
            Only bills rung in by <b>{cashier || "no cashier name"}</b> between the times below.
          </p>
        ) : null}
        <CashierField onChange={setStaff} value={staff} />
        <ShiftTimes end={end} onEnd={setEnd} onStart={setStart} start={start} />
        <label className="flex items-center gap-2 text-sm font-bold text-[#3f434a]">
          <input checked={withLines} onChange={(event) => setWithLines(event.target.checked)} type="checkbox" />
          Print each transaction
        </label>
        <ShiftPreview
          cash={cash}
          date={date}
          end={end}
          sales={sales}
          staff={staff}
          start={start}
          tipSplit={tipSplit}
          withLines={withLines}
        />
        {error ? <ErrorNote>{error}</ErrorNote> : null}
        <div className="flex gap-2">
          <Button className="flex-1" disabled={busy} onClick={() => void print()} tone="primary">
            <span className="size-5">
              <PrinterIcon />
            </span>
            {busy ? "Checking…" : "Print"}
          </Button>
          <Button onClick={onClose}>Cancel</Button>
        </div>
      </div>
    </Modal>
  );
}

export function ShiftTimes({
  start,
  end,
  onStart,
  onEnd,
}: {
  start: string;
  end: string;
  onStart: (value: string) => void;
  onEnd: (value: string) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-2">
      <Field label="Start time">
        <TextInput onChange={(event) => onStart(event.target.value)} type="time" value={start} />
      </Field>
      <Field hint={start && end && end < start ? "next day" : undefined} label="End time">
        <TextInput onChange={(event) => onEnd(event.target.value)} type="time" value={end} />
      </Field>
    </div>
  );
}

/** 찍힐 종이 그대로. 담당자 칸이 아직 번호면 이름 대신 줄표로 보인다(번호를 화면에 펼치지 않는다). */
export function ShiftPreview({
  date,
  staff,
  start,
  end,
  sales,
  cash,
  withLines = false,
  tipSplit,
}: {
  date: string;
  staff: string;
  start: string;
  end: string;
  sales: readonly Sale[];
  cash: boolean;
  withLines?: boolean;
  tipSplit?: CloseoutReport | null;
}) {
  const shown = isShiftCode(staff) ? "—" : staff.trim().replace(/\s+/g, " ") || "—";
  const input: ShiftInput = { staff: shown, date, start, end };
  const range = shiftWindow(input);
  if (!range) return null;
  return (
    <div className="overflow-x-auto bg-[#f2f2f4] p-3">
      <div
        className="rc-sheet mx-auto bg-white p-3 shadow"
        // 우리 포맷터가 만든 HTML 이다 — 사람이 입력한 글자는 전부 이스케이프돼 있다.
        dangerouslySetInnerHTML={{
          __html: shiftReportSheetHtml(
            input,
            shiftSummary(sales, range),
            cash,
            withLines ? salesInWindow(sales, range) : undefined,
            tipSplit,
          ),
        }}
        style={{ width: "72mm" }}
      />
    </div>
  );
}

/**
 * 그날 팁 나누기(0010) — 근무 마감표 아래에 붙인다. 서버가 현금 리포트 계정에게만 주므로(0046) `cash` 일 때만 읽는다.
 * 못 읽으면(0010 전, 권한 없음) null — 마감표는 팁 없이 그대로 찍힌다.
 */
export function useTipSplit(date: string, cash: boolean): CloseoutReport | null {
  const [loaded, setLoaded] = useState<{ date: string; report: CloseoutReport | null } | null>(null);
  useEffect(() => {
    if (!cash) return;
    let cancelled = false;
    retailApi
      .getCloseouts(date)
      .then((report) => {
        if (!cancelled) setLoaded({ date, report });
      })
      .catch(() => {
        if (!cancelled) setLoaded({ date, report: null });
      });
    return () => {
      cancelled = true;
    };
  }, [date, cash]);
  return cash && loaded?.date === date ? loaded.report : null;
}

export function PrinterIcon() {
  return (
    <svg aria-hidden className="h-full w-full" fill="currentColor" fillRule="evenodd" viewBox="0 0 24 24">
      <path d="M6 2h12v5H6V2zM4 8h16a2 2 0 012 2v7h-4v5H6v-5H2v-7a2 2 0 012-2zm4 7v5h8v-5H8zm10-4.5a1 1 0 100 2 1 1 0 000-2z" />
    </svg>
  );
}
