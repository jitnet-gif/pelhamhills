/**
 * 회계 통합 문서(`accountingWorkbook.ts`)를 .xlsx 로. 화면 표와 같은 모델·같은 서식이다:
 * 제목 두 줄, 4 행 머리글(고정·필터), 돈 칸 `#,##0.00`(음수 빨강), 합계 줄은 수식 + 결과.
 *
 * ExcelJS 는 무겁다(~1MB). 버튼을 누를 때만 불러온다.
 */

import { reportDownload } from "@/lib/activityWatch";

import {
  cellValue,
  FIRST_DATA_ROW,
  HEADER_ROW,
  isFormula,
  MONEY_FORMAT,
  type CellFormat,
  type Row,
  type Workbook,
} from "./accountingWorkbook";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const NUM_FORMATS: Record<CellFormat, string | undefined> = {
  text: undefined,
  date: "yyyy-mm-dd",
  int: "#,##0",
  money: MONEY_FORMAT,
};

// 화면(`AccountingWorkbook.tsx`)과 같은 색.
const HEADER_FILL = "FFF3F4F6";
const SECTION_FILL = "FFEEF2FF";
const TOTAL_FILL = "FFF9FAFB";
const MUTED_FONT = "FF6B7280";
const BORDER = "FFD4D4D8";

export async function workbookToXlsx(model: Workbook): Promise<Blob> {
  const ExcelJS = (await import("exceljs")).default;
  const book = new ExcelJS.Workbook();
  book.creator = "Pelham Hills";
  book.created = new Date();
  // 열 때 엑셀이 수식을 다시 계산한다. 저장된 결과는 미리보기·모바일 뷰어용이다.
  book.calcProperties.fullCalcOnLoad = true;

  for (const sheet of model.sheets) {
    const ws = book.addWorksheet(sheet.name, {
      views: [{ state: "frozen", ySplit: HEADER_ROW, xSplit: 0 }],
      pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
    });
    ws.columns = sheet.columns.map((column) => ({ width: column.width }));

    ws.getCell("A1").value = sheet.title;
    ws.getCell("A1").font = { bold: true, size: 14 };
    ws.getCell("A2").value = sheet.subtitle;
    ws.getCell("A2").font = { size: 9, color: { argb: MUTED_FONT } };

    const header = ws.getRow(HEADER_ROW);
    sheet.columns.forEach((column, index) => {
      const cell = header.getCell(index + 1);
      cell.value = column.header;
      cell.font = { bold: true };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEADER_FILL } };
      cell.border = { bottom: { style: "thin", color: { argb: BORDER } } };
      cell.alignment = { horizontal: column.format === "text" || column.format === "date" ? "left" : "right" };
    });

    sheet.rows.forEach((row, rowIndex) => writeRow(ws.getRow(FIRST_DATA_ROW + rowIndex), row, sheet.columns));

    if (sheet.filter) {
      ws.autoFilter = {
        from: { row: HEADER_ROW, column: 1 },
        to: { row: HEADER_ROW, column: sheet.columns.length },
      };
    }
  }

  const buffer = await book.xlsx.writeBuffer();
  return new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

function writeRow(target: import("exceljs").Row, row: Row, columns: Workbook["sheets"][number]["columns"]) {
  row.cells.forEach((cell, index) => {
    const out = target.getCell(index + 1);
    const format = columns[index]?.format ?? "text";
    const raw = cellValue(cell);

    if (isFormula(cell)) {
      out.value = { formula: cell.formula, result: cell.value };
    } else if (format === "date" && typeof raw === "string" && ISO_DATE.test(raw)) {
      // 자정 UTC 로 만들어야 엑셀에서 하루 밀리지 않는다.
      const [y, m, d] = raw.split("-").map(Number);
      out.value = new Date(Date.UTC(y, m - 1, d));
    } else {
      out.value = raw;
    }

    const numFmt = NUM_FORMATS[format];
    if (numFmt && (typeof raw === "number" || out.value instanceof Date)) out.numFmt = numFmt;

    if (row.style === "section") {
      out.font = { bold: true };
      out.fill = { type: "pattern", pattern: "solid", fgColor: { argb: SECTION_FILL } };
    } else if (row.style === "total") {
      out.font = { bold: true };
      out.fill = { type: "pattern", pattern: "solid", fgColor: { argb: TOTAL_FILL } };
      out.border = {
        top: { style: "thin", color: { argb: "FF111827" } },
        bottom: { style: "double", color: { argb: "FF111827" } },
      };
    } else if (row.style === "muted" || row.style === "indent") {
      out.font = { color: { argb: MUTED_FONT } };
    }
  });
}

export function downloadBlob(blob: Blob, filename: string) {
  reportDownload(filename);
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
