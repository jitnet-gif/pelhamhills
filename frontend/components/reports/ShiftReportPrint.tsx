"use client";

/**
 * Daily close 의 Print 창 — 담당자(Pelham Shift ID 또는 이름)·시작·끝 시각을 적고, 그 사이 합계만 영수증 프린터로 찍는다.
 * 계산서 목록은 찍지 않는다. 무엇을 어떻게 세는지는 `lib/reports/shiftReport.ts`.
 * 미리보기와 종이가 같은 HTML 이다(`printReceipt.ts` 의 다른 전표와 같은 규칙).
 * 계산대 마감(`RegisterClose`)도 같은 칸·같은 출력을 쓴다.
 */

import { useState } from "react";

import { cashierName, isShiftCode } from "@/lib/pos/cashierCode";
import { rememberedCashier } from "@/lib/pos/currentBill";
import { printShiftReport, shiftReportSheetHtml } from "@/lib/retail/printReceipt";
import { defaultShiftEnd, defaultShiftStart, shiftSummary, shiftWindow, type ShiftInput } from "@/lib/reports/shiftReport";
import type { Sale } from "@/lib/retail/types";

import CashierField from "@/components/reports/CashierField";
import { Button, ErrorNote, Field, Modal, TextInput } from "@/components/retail/ui";

export default function ShiftReportPrint({
  date,
  sales,
  cash,
  onClose,
}: {
  date: string;
  sales: readonly Sale[];
  cash: boolean;
  onClose: () => void;
}) {
  const [staff, setStaff] = useState(() => rememberedCashier());
  const [start, setStart] = useState(() => defaultShiftStart(sales));
  const [end, setEnd] = useState(() => defaultShiftEnd(date));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

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
      printShiftReport(input, shiftSummary(sales, range), cash);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That staff ID didn't work.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal onClose={onClose} title={`Print shift report — ${date}`}>
      <div className="grid gap-3">
        <CashierField onChange={setStaff} value={staff} />
        <ShiftTimes end={end} onEnd={setEnd} onStart={setStart} start={start} />
        <ShiftPreview cash={cash} date={date} end={end} sales={sales} staff={staff} start={start} />
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
}: {
  date: string;
  staff: string;
  start: string;
  end: string;
  sales: readonly Sale[];
  cash: boolean;
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
        dangerouslySetInnerHTML={{ __html: shiftReportSheetHtml(input, shiftSummary(sales, range), cash) }}
        style={{ width: "72mm" }}
      />
    </div>
  );
}

export function PrinterIcon() {
  return (
    <svg aria-hidden className="h-full w-full" fill="currentColor" fillRule="evenodd" viewBox="0 0 24 24">
      <path d="M6 2h12v5H6V2zM4 8h16a2 2 0 012 2v7h-4v5H6v-5H2v-7a2 2 0 012-2zm4 7v5h8v-5H8zm10-4.5a1 1 0 100 2 1 1 0 000-2z" />
    </svg>
  );
}
