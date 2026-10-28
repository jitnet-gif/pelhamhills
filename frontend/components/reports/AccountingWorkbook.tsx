"use client";

/**
 * 회계 보고서 — 엑셀처럼 생긴 화면(열 문자·행 번호·눈금선·수식 입력줄·아래쪽 시트 탭)과,
 * 같은 모양의 .xlsx 내려받기. 화면과 파일은 같은 모델(`lib/reports/accountingWorkbook.ts`)을
 * 그리므로 칸 위치·서식·합계 수식이 같다. 화면에서 칸을 누르면 파일에 들어갈 수식이 보인다.
 *
 * 기간은 최대 `MAX_RANGE_DAYS` 일. 하루마다 마감 리포트와 계산서 목록을 따로 읽는다(서버에
 * 기간 리포트가 없다). 한꺼번에 수백 개를 쏘지 않게 동시 요청 수를 묶어 둔다.
 */

import { useEffect, useMemo, useState } from "react";

import retailApi, { localBusinessDate, toRetailError } from "@/lib/retail/api";
import {
  BOOKKEEPER_GROSS_COL,
  BOOKKEEPER_SHEET,
  buildAccountingWorkbook,
  cellValue,
  columnLetter,
  datesBetween,
  FIRST_DATA_ROW,
  HEADER_ROW,
  isFormula,
  MAX_RANGE_DAYS,
  monthStart,
  type Cell,
  type CellFormat,
  type DayData,
  type RowStyle,
  type Sheet,
} from "@/lib/reports/accountingWorkbook";
import { downloadBlob, workbookToXlsx } from "@/lib/reports/exportXlsx";
import { fetchStripeFees } from "@/lib/reports/stripeReconcile";

import { Button, ErrorNote, Field, SkeletonRows, TextInput } from "@/components/retail/ui";

const CONCURRENCY = 6;
const SKIPPED_KEY = "pelham.accounting.skippedSheets";

async function loadDays(dates: string[]): Promise<{ days: DayData[]; failed: number }> {
  const days: DayData[] = new Array(dates.length);
  let failed = 0;
  let next = 0;
  async function worker() {
    while (next < dates.length) {
      const index = next++;
      const date = dates[index];
      const [report, sales] = await Promise.allSettled([
        retailApi.getDailyReport(date),
        retailApi.listSales(date),
      ]);
      // 둘 중 하나만 읽힌 날은 통째로 뺀다. 리포트만 있으면 Daily Net 에는 들어가고 Receipts 에는
      // 빠져서, 시트끼리 맞아야 할 합계가 이유 없이 어긋난다.
      if (report.status === "fulfilled" && sales.status === "fulfilled") {
        days[index] = { date, report: report.value, sales: sales.value };
      } else {
        failed += 1;
        days[index] = { date, report: null, sales: [] };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, dates.length) }, worker));
  return { days, failed };
}

/** `cash` 는 현금 리포트(`/cash`)에서만 참이다 — `buildAccountingWorkbook` 참고. */
export default function AccountingWorkbook({ cash = false }: { cash?: boolean }) {
  const today = localBusinessDate();
  const [from, setFrom] = useState(() => monthStart(today));
  const [to, setTo] = useState(today);
  const [days, setDays] = useState<DayData[] | null>(null);
  // For Bookkeeper 의 Gross Sales 칸을 누를 때만 보이는 Stripe 수수료. 시트·파일에는 넣지 않는다. null = 못 읽음.
  const [fees, setFees] = useState<Record<string, number> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [active, setActive] = useState(0);
  const [selected, setSelected] = useState<{ row: number; col: number } | null>(null);
  const [exporting, setExporting] = useState(false);
  // 내려받을 시트(이름). 체크를 푼 시트는 파일에서 빠진다 — 화면 탭은 그대로. 이 기기에만 기억한다.
  // 체크박스는 시트를 다 읽은 뒤에만 그려지므로(서버 렌더에는 없다) 처음 값에서 바로 읽어도 된다.
  const [skipped, setSkipped] = useState<string[]>(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem(SKIPPED_KEY) ?? "[]");
      return Array.isArray(saved) ? saved.filter((name): name is string => typeof name === "string") : [];
    } catch {
      return []; // 못 읽으면(서버 렌더 포함) 전부 내려받는다.
    }
  });

  function toggleSheet(name: string) {
    setSkipped((current) => {
      const next = current.includes(name) ? current.filter((n) => n !== name) : [...current, name];
      try {
        window.localStorage.setItem(SKIPPED_KEY, JSON.stringify(next));
      } catch {
        // 저장 못 해도 이번 화면에서는 그대로 쓴다.
      }
      return next;
    });
  }

  const dates = useMemo(() => datesBetween(from, to), [from, to]);
  const rangeError =
    dates.length === 0
      ? "From must be on or before To."
      : dates.length > MAX_RANGE_DAYS
        ? `Pick ${MAX_RANGE_DAYS} days or fewer.`
        : "";

  useEffect(() => {
    if (rangeError) return;
    let cancelled = false;
    setLoading(true);
    setError("");
    // 수수료는 Stripe(Fly 서버)에서 따로. 실패해도 나머지 시트는 그대로 만든다.
    const feesRequest = fetchStripeFees(dates[0], dates[dates.length - 1]).then(
      (result) => ({ fees: result.fees, error: result.truncated ? "Stripe fees: too many transactions, fees may be short — pick fewer days." : "" }),
      (cause) => ({ fees: null, error: `Stripe fees could not be read (${cause instanceof Error ? cause.message : "error"}).` }),
    );
    Promise.all([loadDays(dates), feesRequest])
      .then(([{ days: loaded, failed }, feeResult]) => {
        if (cancelled) return;
        setDays(loaded);
        setFees(feeResult.fees);
        const notes = [
          failed > 0 ? `${failed} day(s) could not be loaded — they are marked “Not loaded”.` : "",
          feeResult.error,
        ].filter(Boolean);
        if (notes.length) setError(notes.join(" "));
      })
      .catch((cause) => {
        if (!cancelled) setError(toRetailError(cause).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [dates, rangeError]);

  const workbook = useMemo(
    () => (days && !rangeError ? buildAccountingWorkbook(from, to, days, { cash }) : null),
    [days, from, to, rangeError, cash],
  );
  const sheet = workbook?.sheets[active] ?? null;
  // 시트끼리 서로 참조하는 수식이 없으니 골라 빼도 남은 시트의 수식은 그대로 맞다.
  const exportSheets = workbook?.sheets.filter((s) => !skipped.includes(s.name)) ?? [];

  async function exportXlsx() {
    if (!workbook || exportSheets.length === 0) return;
    setExporting(true);
    try {
      const blob = await workbookToXlsx({ ...workbook, sheets: exportSheets });
      downloadBlob(blob, `PelhamHills_Accounting_${workbook.from}_to_${workbook.to}.xlsx`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not build the Excel file.");
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="grid min-w-0 gap-3">
      <div className="flex flex-wrap items-end gap-2">
        <Field label="From">
          <TextInput max={to} onChange={(event) => setFrom(event.target.value)} type="date" value={from} />
        </Field>
        <Field label="To">
          <TextInput min={from} onChange={(event) => setTo(event.target.value)} type="date" value={to} />
        </Field>
        <Button
          disabled={!workbook || loading || exporting || exportSheets.length === 0}
          onClick={exportXlsx}
          tone="primary"
        >
          {exporting ? "Building…" : "Download Excel (.xlsx)"}
        </Button>
      </div>

      {workbook ? (
        <fieldset className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
          <legend className="sr-only">Sheets in the Excel file</legend>
          <span className="font-semibold text-[#444]">Sheets in the file:</span>
          {workbook.sheets.map((s) => (
            <label className="inline-flex cursor-pointer items-center gap-1.5" key={s.name}>
              <input
                checked={!skipped.includes(s.name)}
                className="h-4 w-4 accent-[#107c41]"
                onChange={() => toggleSheet(s.name)}
                type="checkbox"
              />
              {s.name}
            </label>
          ))}
          {exportSheets.length === 0 ? <span className="text-[#c00000]">Pick at least one sheet.</span> : null}
        </fieldset>
      ) : null}

      {rangeError ? <ErrorNote>{rangeError}</ErrorNote> : null}
      {error ? <ErrorNote>{error}</ErrorNote> : null}

      {loading && !rangeError ? (
        <SkeletonRows count={8} />
      ) : sheet ? (
        <SheetView
          fees={fees}
          onSelect={setSelected}
          selected={selected}
          sheet={sheet}
          tabs={workbook!.sheets.map((s) => s.name)}
          active={active}
          onTab={(index) => {
            setActive(index);
            setSelected(null);
          }}
        />
      ) : null}
    </div>
  );
}

// ===== 엑셀 모양 표 ======================================================

/** 엑셀 열 너비(문자 수) → 화면 px. 엑셀 기본 글꼴 기준 대략 7px/문자 + 여백. */
const px = (width: number) => Math.round(width * 7 + 5);

const ROW_HEAD = 40;

function formatCell(value: string | number | null, format: CellFormat): string {
  if (value === null || value === "") return "";
  if (typeof value === "string") return value;
  if (format === "money") {
    return value.toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  return value.toLocaleString("en-CA");
}

function cellClass(style: RowStyle | undefined): string {
  switch (style) {
    case "section":
      return "bg-[#eef2ff] font-bold";
    case "total":
      return "bg-[#f9fafb] font-bold border-t border-t-[#111827] border-b-[3px] border-b-[#111827] border-double";
    case "muted":
    case "indent":
      return "text-[#6b7280]";
    default:
      return "";
  }
}

function SheetView({
  sheet,
  tabs,
  active,
  onTab,
  selected,
  onSelect,
  fees,
}: {
  fees: Record<string, number> | null;
  sheet: Sheet;
  tabs: string[];
  active: number;
  onTab: (index: number) => void;
  selected: { row: number; col: number } | null;
  onSelect: (cell: { row: number; col: number }) => void;
}) {
  const cols = sheet.columns;
  const width = ROW_HEAD + cols.reduce((sum, column) => sum + px(column.width), 0);

  // 선택된 칸 → 이름 상자(C12)와 수식 입력줄.
  const address = selected ? `${columnLetter(selected.col)}${selected.row}` : "";
  const selectedCell: Cell | undefined = selected ? cellAt(sheet, selected.row, selected.col) : undefined;
  const bar =
    selectedCell === undefined || selectedCell === null
      ? ""
      : isFormula(selectedCell)
        ? `=${selectedCell.formula}`
        : String(selectedCell);

  const isSel = (row: number, col: number) => selected?.row === row && selected?.col === col;
  const tdBase = "h-[21px] overflow-hidden whitespace-nowrap border-r border-b border-[#e5e7eb] px-1 text-[12px]";
  const align = (format: CellFormat, value: unknown) =>
    typeof value === "number" && (format === "money" || format === "int") ? "text-right tabular-nums" : "text-left";
  const sel = "outline outline-2 -outline-offset-2 outline-[#107c41]";

  return (
    <div className="min-w-0 border border-[#c8c8c8] bg-white font-[Calibri,Carlito,'Segoe_UI',sans-serif]">
      {/* 이름 상자 + 수식 입력줄 */}
      <div className="flex items-stretch border-b border-[#c8c8c8] text-[12px]">
        <div className="w-20 shrink-0 border-r border-[#c8c8c8] px-2 py-1 tabular-nums">{address}</div>
        <div className="shrink-0 border-r border-[#c8c8c8] px-2 py-1 italic text-[#6b7280]">fx</div>
        <div className="min-w-0 flex-1 truncate px-2 py-1 font-mono">{bar}</div>
      </div>

      <div className="max-h-[70vh] overflow-auto">
        <table className="border-separate border-spacing-0" style={{ width, tableLayout: "fixed" }}>
          <colgroup>
            <col style={{ width: ROW_HEAD }} />
            {cols.map((column, index) => (
              <col key={index} style={{ width: px(column.width) }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              <th className="sticky top-0 left-0 z-30 h-[20px] border-r border-b border-[#c8c8c8] bg-[#f3f3f3]" />
              {cols.map((_, index) => (
                <th
                  className={`sticky top-0 z-20 h-[20px] border-r border-b border-[#c8c8c8] text-[11px] font-normal text-[#444] ${
                    selected?.col === index ? "bg-[#d3f0e0]" : "bg-[#f3f3f3]"
                  }`}
                  key={index}
                >
                  {columnLetter(index)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {/* 1 제목, 2 기간, 3 빈 줄 — 엑셀처럼 옆 빈 칸으로 넘쳐 보이게 한 칸에 걸친다. */}
            {[sheet.title, sheet.subtitle, ""].map((text, index) => (
              <tr key={`top-${index}`}>
                <RowHead n={index + 1} active={selected?.row === index + 1} />
                <td
                  className={`${tdBase} ${index === 0 ? "h-[26px] text-[16px] font-bold" : "text-[11px] text-[#6b7280]"} ${
                    isSel(index + 1, 0) ? sel : ""
                  }`}
                  colSpan={cols.length}
                  onClick={() => onSelect({ row: index + 1, col: 0 })}
                >
                  {text}
                </td>
              </tr>
            ))}

            {/* 4 머리글 — 틀 고정(파일도 4 행까지 고정). */}
            <tr>
              <RowHead n={HEADER_ROW} active={selected?.row === HEADER_ROW} sticky />
              {cols.map((column, index) => (
                <td
                  className={`${tdBase} sticky top-[20px] z-10 border-b-[#9ca3af] bg-[#f3f4f6] font-bold ${
                    column.format === "money" || column.format === "int" ? "text-right" : "text-left"
                  } ${isSel(HEADER_ROW, index) ? sel : ""}`}
                  key={index}
                  onClick={() => onSelect({ row: HEADER_ROW, col: index })}
                  title={column.header}
                >
                  {column.header}
                </td>
              ))}
            </tr>

            {sheet.rows.map((row, rowIndex) => {
              const n = FIRST_DATA_ROW + rowIndex;
              return (
                <tr key={n}>
                  <RowHead n={n} active={selected?.row === n} />
                  {cols.map((column, col) => {
                    const cell = row.cells[col] ?? null;
                    // For Bookkeeper 의 Gross Sales 는 화면에서 수수료를 뺀 값(After fees)으로 보인다. 파일은 그대로 총매출.
                    const breakdown = bankBreakdown(sheet, rowIndex, col, fees);
                    const value = breakdown && breakdown.fee !== null ? afterFees(breakdown) : cellValue(cell);
                    const negative = typeof value === "number" && value < 0 && column.format === "money";
                    const bank = isSel(n, col) ? breakdown : null;
                    return (
                      <td
                        className={`${tdBase} ${align(column.format, value)} ${cellClass(row.style)} ${
                          negative ? "text-[#c00000]" : ""
                        } ${row.style === "section" && col === 0 ? "overflow-visible" : ""} ${
                          isSel(n, col) ? sel : ""
                        } ${bank ? "relative overflow-visible" : ""}`}
                        key={col}
                        onClick={() => onSelect({ row: n, col })}
                      >
                        {formatCell(value, column.format)}
                        {bank ? <BankPopover bank={bank} above={rowIndex === sheet.rows.length - 1} /> : null}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* 시트 탭 */}
      <div className="flex overflow-x-auto border-t border-[#c8c8c8] bg-[#f3f3f3] text-[12px]">
        {tabs.map((name, index) => (
          <button
            className={`shrink-0 border-r border-[#c8c8c8] px-4 py-1.5 ${
              index === active
                ? "-mt-px border-t-2 border-t-[#107c41] bg-white font-bold text-[#107c41]"
                : "text-[#444] hover:bg-[#e8e8e8]"
            }`}
            key={name}
            onClick={() => onTab(index)}
            type="button"
          >
            {name}
          </button>
        ))}
      </div>
    </div>
  );
}

function RowHead({ n, active, sticky = false }: { n: number; active: boolean; sticky?: boolean }) {
  return (
    <th
      className={`sticky left-0 border-r border-b border-[#c8c8c8] text-center text-[11px] font-normal text-[#444] ${
        sticky ? "top-[20px] z-20" : "z-10"
      } ${active ? "bg-[#d3f0e0]" : "bg-[#f3f3f3]"}`}
    >
      {n}
    </th>
  );
}

function cellAt(sheet: Sheet, row: number, col: number): Cell | undefined {
  if (row === 1) return col === 0 ? sheet.title : null;
  if (row === 2) return col === 0 ? sheet.subtitle : null;
  if (row === 3) return null;
  if (row === HEADER_ROW) return sheet.columns[col]?.header ?? null;
  return sheet.rows[row - FIRST_DATA_ROW]?.cells[col] ?? null;
}

/**
 * For Bookkeeper 의 Gross Sales 칸을 누르면 그 칸 바로 옆에: 총매출 − Stripe 수수료 = 은행에 남는 돈.
 * 화면에만 — 시트 모델에 없으니 .xlsx 로 나가지 않는다(2026-10-28 클럽 요청). Grand Total 줄은 기간 전체.
 */
type Bank = { label: string; gross: number; fee: number | null };

function bankBreakdown(sheet: Sheet, rowIndex: number, col: number, fees: Record<string, number> | null): Bank | null {
  if (sheet.name !== BOOKKEEPER_SHEET || col !== BOOKKEEPER_GROSS_COL) return null;
  const cells = sheet.rows[rowIndex]?.cells;
  const gross = cells ? cellValue(cells[BOOKKEEPER_GROSS_COL]) : null;
  const date = cells?.[0];
  if (typeof gross !== "number" || typeof date !== "string") return null;
  const total = date === "Grand Total";
  const dates = total
    ? sheet.rows.map((r) => r.cells[0]).filter((d): d is string => typeof d === "string" && d !== "Grand Total")
    : [date];
  return {
    label: total ? "Whole period" : date,
    gross,
    fee: fees ? dates.reduce((sum, d) => sum + (fees[d] ?? 0), 0) / 100 : null,
  };
}

function afterFees(bank: Bank): number {
  return Math.round((bank.gross - (bank.fee ?? 0)) * 100) / 100;
}

function BankPopover({ bank, above }: { bank: Bank; above: boolean }) {
  const money = (value: number) =>
    value.toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (
    <div
      className={`absolute right-0 z-40 grid min-w-[230px] gap-0.5 border border-[#107c41] bg-white px-3 py-2 text-left text-[12px] font-normal text-[#111827] shadow-lg ${
        above ? "bottom-full mb-1" : "top-full mt-1"
      }`}
    >
      <p className="font-bold text-[#107c41]">{bank.label}</p>
      {bank.fee === null ? (
        <p className="text-[#c00000]">Stripe fees could not be read.</p>
      ) : (
        <>
          <p className="flex justify-between gap-4 tabular-nums">
            <span>Total sales</span>
            <span>{money(bank.gross)}</span>
          </p>
          <p className="flex justify-between gap-4 tabular-nums text-[#c00000]">
            <span>− Stripe fees</span>
            <span>{money(bank.fee)}</span>
          </p>
          <p className="flex justify-between gap-4 border-t border-[#111827] pt-0.5 font-bold tabular-nums">
            <span>= After fees</span>
            <span>{money(afterFees(bank))}</span>
          </p>
        </>
      )}
    </div>
  );
}
