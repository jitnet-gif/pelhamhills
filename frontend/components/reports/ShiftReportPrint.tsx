"use client";

/**
 * Daily close 의 Print 창 — 담당자 이름·시작·끝 시각을 적고, 그 사이 합계만 영수증 프린터로 찍는다.
 * 계산서 목록은 찍지 않는다. 무엇을 어떻게 세는지는 `lib/reports/shiftReport.ts`.
 * 미리보기와 종이가 같은 HTML 이다(`printReceipt.ts` 의 다른 전표와 같은 규칙).
 */

import { useMemo, useState } from "react";

import { localBusinessDate } from "@/lib/retail/api";
import { printShiftReport, shiftReportSheetHtml } from "@/lib/retail/printReceipt";
import { recentCashiers, rememberedCashier } from "@/lib/pos/currentBill";
import { shiftSummary, shiftWindow, type ShiftInput } from "@/lib/reports/shiftReport";
import type { Sale } from "@/lib/retail/types";

import { Button, ErrorNote, Field, Modal, TextInput } from "@/components/retail/ui";

function nowClock(): string {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
}

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
  const [start, setStart] = useState("06:00");
  // 오늘이면 지금까지, 지난 날이면 하루 끝까지.
  const [end, setEnd] = useState(() => (date === localBusinessDate() ? nowClock() : "23:59"));
  const [error, setError] = useState("");
  const suggestions = useMemo(() => recentCashiers(), []);

  const input: ShiftInput = { staff: staff.trim().replace(/\s+/g, " "), date, start, end };
  const range = shiftWindow(input);
  const summary = range ? shiftSummary(sales, range) : null;

  function print() {
    setError("");
    if (!input.staff) {
      setError("Enter the staff name.");
      return;
    }
    if (!summary) {
      setError("Enter a start and end time.");
      return;
    }
    printShiftReport(input, summary, cash);
  }

  return (
    <Modal onClose={onClose} title={`Print shift report — ${date}`}>
      <div className="grid gap-3">
        <Field label="Staff name">
          <TextInput
            autoComplete="off"
            list="shift-report-staff"
            onChange={(event) => setStaff(event.target.value)}
            placeholder="Who is closing"
            value={staff}
          />
        </Field>
        <datalist id="shift-report-staff">
          {suggestions.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Start time">
            <TextInput onChange={(event) => setStart(event.target.value)} type="time" value={start} />
          </Field>
          <Field hint={range && end < start ? "next day" : undefined} label="End time">
            <TextInput onChange={(event) => setEnd(event.target.value)} type="time" value={end} />
          </Field>
        </div>

        {summary ? (
          <div className="overflow-x-auto bg-[#f2f2f4] p-3">
            <div
              className="rc-sheet mx-auto bg-white p-3 shadow"
              // 우리 포맷터가 만든 HTML 이다 — 사람이 입력한 글자는 전부 이스케이프돼 있다.
              dangerouslySetInnerHTML={{ __html: shiftReportSheetHtml({ ...input, staff: input.staff || "—" }, summary, cash) }}
              style={{ width: "72mm" }}
            />
          </div>
        ) : null}

        {error ? <ErrorNote>{error}</ErrorNote> : null}
        <div className="flex gap-2">
          <Button className="flex-1" onClick={print} tone="primary">
            <span className="size-5">
              <PrinterIcon />
            </span>
            Print
          </Button>
          <Button onClick={onClose}>Cancel</Button>
        </div>
      </div>
    </Modal>
  );
}

export function PrinterIcon() {
  return (
    <svg aria-hidden className="h-full w-full" fill="currentColor" fillRule="evenodd" viewBox="0 0 24 24">
      <path d="M6 2h12v5H6V2zM4 8h16a2 2 0 012 2v7h-4v5H6v-5H2v-7a2 2 0 012-2zm4 7v5h8v-5H8zm10-4.5a1 1 0 100 2 1 1 0 000-2z" />
    </svg>
  );
}
