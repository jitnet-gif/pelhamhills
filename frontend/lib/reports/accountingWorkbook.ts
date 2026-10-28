/**
 * 회계 보고서 통합 문서 — 기간(From–To)의 매출을 엑셀 시트 다섯 장으로. 맨 앞 For Bookkeeper 는 회계사에게
 * 넘기는 한 장(날짜·순번·세전 매출·HST·세금 포함 매출, Grand Total — 2026-10-28 클럽 요청).
 *
 * 화면(`components/reports/AccountingWorkbook.tsx`)과 .xlsx 파일(`exportXlsx.ts`)이 **이 모델
 * 하나**를 그린다. 그래서 화면에서 본 칸·서식·합계가 파일에서도 같은 자리에 같은 값으로 나온다.
 * 합계 칸은 엑셀 수식과 그 계산 결과를 함께 갖는다 — 회계 담당이 파일에서 수식을 따라가
 * 숫자가 어디서 왔는지 볼 수 있고, 화면은 같은 결과값을 보여 준다.
 *
 * 숫자의 출처
 * - 일별 매출·할인·세금·Total collected(서버의 `net`, 세금 포함)·결제 수단·사업부: 서버 마감 리포트(`pelham_staff_pos_report_daily`).
 *   여기서 계산서를 다시 더하지 않는다 — 마감 숫자는 서버가 정답이다.
 * - 영수증·품목: 그 날의 계산서 목록(`pelham_staff_bills`, paid + refunded).
 *
 * 맞아야 하는 것(0005 SQL 기준)
 * - Daily 의 Cash+Card+Debit+Member+Gift = Total collected. 결제 금액은 팁을 빼고 계산서 합계와 같아야
 *   결제가 된다(`pelham_staff_bill_pay`). 팁은 따로 한 칸.
 * - Receipts 의 Paid 합계 = Daily Total collected, Lines 의 Paid 합계 = Daily Gross.
 *   환불 계산서는 목록에 남지만 Gross·Net 에서는 서버가 이미 뺐다 → 시트에서도 Status 로 나눠 더한다.
 */

import { divisionOf, DIVISIONS } from "@/lib/retail/divisions";
import { CLUB_TIME_ZONE, PAYMENT_LABELS, stationLabel } from "@/lib/retail/receipt";
import { PAYMENT_METHODS, type Cents, type PaymentMethod, type RetailDailyReport, type Sale } from "@/lib/retail/types";

// ===== 모델 =============================================================

export type CellFormat = "text" | "date" | "int" | "money";

/** 수식 칸은 결과(`value`)를 같이 들고 다닌다. 결과가 없으면 미리보기·모바일 엑셀이 0 을 보인다. */
export type FormulaCell = { formula: string; value: number };
export type Cell = string | number | null | FormulaCell;

/** `noTotal` = 합계 줄에서 더하지 않는다(단가처럼 더하면 뜻이 없는 칸). */
export type Column = { header: string; width: number; format: CellFormat; noTotal?: true };

/** section = 굵은 소제목 줄, total = 합계 줄(윗줄 테두리), muted = 환불 등 회색, indent = 하위 항목. */
export type RowStyle = "normal" | "section" | "total" | "muted" | "indent";
export type Row = { cells: Cell[]; style?: RowStyle };

export type Sheet = {
  name: string;
  title: string;
  subtitle: string;
  columns: Column[];
  rows: Row[];
  /** 머리글 줄에 자동 필터를 건다(목록형 시트). */
  filter?: boolean;
};

export type Workbook = { from: string; to: string; sheets: Sheet[] };

/** 시트 위쪽: 1 제목, 2 기간, 3 빈 줄, 4 머리글. 자료는 5 행부터. 화면과 파일이 같이 쓴다. */
export const HEADER_ROW = 4;
export const FIRST_DATA_ROW = HEADER_ROW + 1;

export const MONEY_FORMAT = "#,##0.00;[Red]-#,##0.00";

export type DayData = { date: string; report: RetailDailyReport | null; sales: Sale[] };

// ===== 헬퍼 =============================================================

export function columnLetter(index: number): string {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

export function isFormula(cell: Cell): cell is FormulaCell {
  return typeof cell === "object" && cell !== null && "formula" in cell;
}

export function cellValue(cell: Cell): string | number | null {
  return isFormula(cell) ? cell.value : cell;
}

/** 센트 → 달러 숫자. 엑셀 칸은 문자열이 아니라 숫자여야 더하고 거를 수 있다. */
const dollars = (cents: Cents | undefined | null) => Math.round(cents ?? 0) / 100;

const round2 = (value: number) => Math.round(value * 100) / 100;

/** 같은 열의 자료 범위 합. */
function sumFormula(col: number, firstRow: number, lastRow: number, value: number): FormulaCell {
  const letter = columnLetter(col);
  return {
    formula: lastRow >= firstRow ? `SUM(${letter}${firstRow}:${letter}${lastRow})` : "0",
    value: round2(value),
  };
}

function sumIfsFormula(
  col: number,
  criteriaCol: number,
  criteria: string,
  firstRow: number,
  lastRow: number,
  value: number,
): FormulaCell {
  const v = columnLetter(col);
  const c = columnLetter(criteriaCol);
  return {
    formula:
      lastRow >= firstRow
        ? `SUMIFS(${v}${firstRow}:${v}${lastRow},${c}${firstRow}:${c}${lastRow},"${criteria}")`
        : "0",
    value: round2(value),
  };
}

const TIME_FORMAT = new Intl.DateTimeFormat("en-CA", {
  timeZone: CLUB_TIME_ZONE,
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function clubTime(iso: string): string {
  const value = new Date(iso);
  return Number.isNaN(value.getTime()) ? "" : TIME_FORMAT.format(value);
}

/** 서버 JSON 의 줄에는 분류가 오지만(`pelham_pos_bill_json`) 타입에는 아직 없다. */
function lineCategory(line: Sale["lines"][number]): string {
  const category = (line as { category?: string | null }).category;
  if (category) return category;
  if (line.kind === "tee_player") return "Green Fees";
  if (line.kind === "sim_booking") return "Simulator";
  return "";
}

const divisionLabel = (category: string) =>
  DIVISIONS.find((division) => division.key === divisionOf(category))?.label ?? "";

function paymentText(sale: Sale): string {
  if (sale.payments && sale.payments.length > 0) {
    return sale.payments.map((payment) => PAYMENT_LABELS[payment.method] ?? payment.method).join(" + ");
  }
  return sale.payment_method ? (PAYMENT_LABELS[sale.payment_method] ?? sale.payment_method) : "No charge";
}

const statusText = (sale: Sale) => (sale.refunded_at || sale.status === "refunded" ? "Refunded" : "Paid");

// ===== 통합 문서 ========================================================

/**
 * `cash` 가 거짓이면(일반 Reports) 결제 수단 칸에서 Cash 를 뺀다. 그때 결제 합은 Total collected 가 아니라
 * "현금 아닌 결제" 다 — 서버도 현금 리포트 계정이 아니면 cash 줄을 주지 않는다(0046).
 */
export function buildAccountingWorkbook(
  from: string,
  to: string,
  days: DayData[],
  { cash = false }: { cash?: boolean } = {},
): Workbook {
  const period = from === to ? from : `${from} to ${to}`;
  const methods = cash ? [...PAYMENT_METHODS] : PAYMENT_METHODS.filter((method) => method !== "cash");
  const sheets = [
    buildBookkeeper(period, days),
    buildSummary(period, days, methods, cash),
    buildDaily(period, days, methods, cash),
    buildReceipts(period, days),
    buildLines(period, days),
  ];
  // 못 읽은 날이 있으면 모든 시트에 적는다 — 파일은 화면의 경고 없이 혼자 돌아다닌다.
  const missing = days.filter((day) => day.report === null).length;
  if (missing > 0) {
    for (const sheet of sheets) sheet.subtitle += ` · WARNING: ${missing} day(s) not loaded, not included`;
  }
  return { from, to, sheets };
}

// ----- For Bookkeeper: 하루 한 줄, 회계사용 ---------------------------------

/**
 * Date / Seq # / Net Sales / HST / Gross Sales, 아래 Grand Total.
 * - Seq # = 기간 안의 순번(1, 2, 3…). 회계 장부의 일련번호 칸.
 * - Net Sales = 할인 뒤 세전(Summary 의 Net sales), Gross Sales = Net + HST(= Daily 의 Total collected).
 * Stripe 수수료는 시트·파일에 넣지 않는다(2026-10-28 클럽 요청) — 화면에서 Gross Sales 칸을 누를 때만
 * `AccountingWorkbook.tsx` 가 "Gross − Stripe fee" 를 보여 준다.
 */
const BOOKKEEPER_COLUMNS: Column[] = [
  { header: "Date", width: 12, format: "date" },
  { header: "Seq #", width: 7, format: "int", noTotal: true },
  { header: "Net Sales", width: 14, format: "money" },
  { header: "HST", width: 12, format: "money" },
  { header: "Gross Sales", width: 14, format: "money" },
];

export const BOOKKEEPER_SHEET = "For Bookkeeper";
export const BOOKKEEPER_GROSS_COL = 4;

function buildBookkeeper(period: string, days: DayData[]): Sheet {
  const rows: Row[] = days.map(({ date, report }, index) => {
    const n = FIRST_DATA_ROW + index;
    if (!report) {
      return { cells: [date, index + 1, "Not loaded", null, null], style: "muted" };
    }
    const net = round2(dollars(report.gross) - dollars(report.discount));
    const tax = dollars(report.tax);
    return {
      cells: [date, index + 1, net, tax, { formula: `C${n}+D${n}`, value: round2(net + tax) }],
    };
  });

  const first = FIRST_DATA_ROW;
  const last = FIRST_DATA_ROW + rows.length - 1;
  const totals: Cell[] = BOOKKEEPER_COLUMNS.map((column, col) => {
    if (col === 0) return "Grand Total";
    if (column.noTotal) return null;
    const sum = rows.reduce((acc, row) => {
      const value = cellValue(row.cells[col]);
      return acc + (typeof value === "number" ? value : 0);
    }, 0);
    return sumFormula(col, first, last, sum);
  });

  return {
    name: BOOKKEEPER_SHEET,
    title: "Sales for the bookkeeper — Pelham Hills",
    subtitle: `${period} · Net Sales after discounts, tax excl. · Gross Sales tax incl.`,
    columns: BOOKKEEPER_COLUMNS,
    rows: [...rows, { cells: totals, style: "total" }],
  };
}

// ----- Daily: 하루 한 줄 ------------------------------------------------

const dailyColumns = (methods: PaymentMethod[]): Column[] => [
  { header: "Date", width: 12, format: "date" },
  { header: "Sales #", width: 8, format: "int" },
  ...DIVISIONS.map((division) => ({ header: division.label, width: 14, format: "money" as const })),
  { header: "Gross", width: 13, format: "money" },
  { header: "Discounts", width: 11, format: "money" },
  { header: "HST", width: 11, format: "money" },
  { header: "Total collected", width: 15, format: "money" },
  ...methods.map((method) => ({ header: PAYMENT_LABELS[method], width: 13, format: "money" as const })),
  { header: "Tips", width: 10, format: "money" },
  { header: "Refunds #", width: 10, format: "int" },
  { header: "Refunded $", width: 12, format: "money" },
];

function buildDaily(period: string, days: DayData[], methods: PaymentMethod[], cash: boolean): Sheet {
  const columns = dailyColumns(methods);
  const rows: Row[] = days.map(({ date, report }) => {
    if (!report) {
      // 리포트를 못 읽은 날은 0 으로 채우지 않는다 — 0 은 "매출 없음"이라는 뜻이 된다.
      return { cells: [date, "Not loaded", ...columns.slice(2).map(() => null)], style: "muted" };
    }
    const byCategory = report.by_category;
    const payment = (method: string) => report.by_payment.find((row) => row.method === method)?.total ?? 0;
    return {
      cells: [
        date,
        report.sale_count,
        ...DIVISIONS.map((division) =>
          dollars(
            byCategory
              .filter((row) => divisionOf(row.category) === division.key)
              .reduce((sum, row) => sum + row.total, 0),
          ),
        ),
        dollars(report.gross),
        dollars(report.discount),
        dollars(report.tax),
        dollars(report.net),
        ...methods.map((method) => dollars(payment(method))),
        dollars(report.tips),
        report.refunded_count,
        dollars(report.refunded_total),
      ],
    };
  });

  const first = FIRST_DATA_ROW;
  const last = FIRST_DATA_ROW + rows.length - 1;
  const totals: Cell[] = columns.map((_, col) => {
    if (col === 0) return "Total";
    const sum = rows.reduce((acc, row) => {
      const value = row.cells[col];
      return acc + (typeof value === "number" ? value : 0);
    }, 0);
    return sumFormula(col, first, last, sum);
  });

  return {
    name: "Daily",
    title: "Daily sales — Pelham Hills",
    subtitle: cash
      ? `${period} · gross before order discounts & tax · payments exclude tips (they add up to Total collected)`
      : `${period} · gross before order discounts & tax · payments exclude tips · cash not shown`,
    columns,
    rows: [...rows, { cells: totals, style: "total" }],
    filter: true,
  };
}

// ----- Summary: 기간 손익 요약 -----------------------------------------

function buildSummary(period: string, days: DayData[], methods: PaymentMethod[], cash: boolean): Sheet {
  const reports = days.map((day) => day.report).filter((report): report is RetailDailyReport => report !== null);
  const missing = days.length - reports.length;

  const add = <K extends string>(map: Map<K, { count: number; total: number }>, key: K, count: number, total: number) => {
    const current = map.get(key) ?? { count: 0, total: 0 };
    map.set(key, { count: current.count + count, total: current.total + total });
  };

  const categories = new Map<string, { count: number; total: number }>();
  const payments = new Map<string, { count: number; total: number }>();
  const stations = new Map<string, { count: number; total: number }>();
  let saleCount = 0;
  let discount = 0;
  let tax = 0;
  let tips = 0;
  let refundedCount = 0;
  let refundedTotal = 0;
  for (const report of reports) {
    report.by_category.forEach((row) => add(categories, row.category, row.quantity, row.total));
    report.by_payment.forEach((row) => add(payments, row.method, row.count, row.total));
    report.by_station?.forEach((row) => add(stations, row.station, row.count, row.total));
    saleCount += report.sale_count;
    discount += report.discount;
    tax += report.tax;
    tips += report.tips ?? 0;
    refundedCount += report.refunded_count;
    refundedTotal += report.refunded_total;
  }

  const rows: Row[] = [];
  const excelRow = () => FIRST_DATA_ROW + rows.length;

  rows.push({ cells: ["SALES BY DIVISION (before order discounts & tax)", null, null], style: "section" });
  const divisionRows: number[] = [];
  let gross = 0;
  for (const division of DIVISIONS) {
    const own = [...categories.entries()].filter(([category]) => divisionOf(category) === division.key);
    const quantity = own.reduce((sum, [, row]) => sum + row.count, 0);
    const total = dollars(own.reduce((sum, [, row]) => sum + row.total, 0));
    gross += total;
    divisionRows.push(excelRow());
    rows.push({ cells: [division.label, quantity, total] });
    for (const [category, row] of own) {
      rows.push({ cells: [`    ${category}`, row.count, dollars(row.total)], style: "indent" });
    }
  }
  gross = round2(gross);
  const grossRow = excelRow();
  rows.push({
    cells: ["Gross sales", saleCount, { formula: divisionRows.map((r) => `C${r}`).join("+"), value: gross }],
    style: "total",
  });
  const discountRow = excelRow();
  rows.push({ cells: ["Less: order discounts", null, discount ? -dollars(discount) : 0] });
  // 화면(SalesReport)과 같은 순서·이름: Net sales 는 세전, 세금을 더한 것은 Total collected.
  const netRow = excelRow();
  const net = round2(gross - dollars(discount));
  rows.push({
    cells: ["Net sales (tax excl.)", saleCount, { formula: `C${grossRow}+C${discountRow}`, value: net }],
    style: "total",
  });
  const taxRow = excelRow();
  rows.push({ cells: ["HST collected", null, dollars(tax)] });
  const collected = round2(net + dollars(tax));
  rows.push({
    cells: ["Total collected (tax incl.)", saleCount, { formula: `C${netRow}+C${taxRow}`, value: collected }],
    style: "total",
  });

  rows.push({ cells: [null, null, null] });
  rows.push({ cells: ["PAYMENTS RECEIVED (tips excluded)", "Count", "Amount"], style: "section" });
  const firstPay = excelRow();
  let paid = 0;
  for (const method of methods) {
    const row = payments.get(method) ?? { count: 0, total: 0 };
    paid += dollars(row.total);
    rows.push({ cells: [PAYMENT_LABELS[method], row.count, dollars(row.total)] });
  }
  rows.push({
    cells: [cash ? "Total payments (= Total collected)" : "Total non-cash payments", null, sumFormula(2, firstPay, excelRow() - 1, paid)],
    style: "total",
  });
  rows.push({ cells: ["Tips (outside Total collected, paid to staff)", null, dollars(tips)] });

  rows.push({ cells: [null, null, null] });
  rows.push({ cells: ["BY REGISTER (tax incl.)", "Bills", "Amount"], style: "section" });
  const firstStation = excelRow();
  let stationSum = 0;
  for (const [station, row] of [...stations.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    stationSum += dollars(row.total);
    rows.push({ cells: [stationLabel(station), row.count, dollars(row.total)] });
  }
  if (stations.size === 0) rows.push({ cells: ["No bills", null, null], style: "muted" });
  rows.push({
    cells: ["Total", null, sumFormula(2, firstStation, excelRow() - 1, stations.size ? stationSum : 0)],
    style: "total",
  });

  rows.push({ cells: [null, null, null] });
  rows.push({ cells: ["REFUNDS (already left out of the figures above)", "Bills", "Amount"], style: "section" });
  rows.push({ cells: ["Refunded bills (tax incl.)", refundedCount, dollars(refundedTotal)] });

  if (missing > 0) {
    rows.push({ cells: [null, null, null] });
    rows.push({
      cells: [`WARNING: ${missing} day(s) could not be loaded and are not included.`, null, null],
      style: "muted",
    });
  }

  return {
    name: "Summary",
    title: "Sales summary — Pelham Hills",
    subtitle: `${period} · ${days.length} day(s) · from the daily close reports`,
    columns: [
      { header: "Account", width: 44, format: "text" },
      { header: "Qty / Count", width: 12, format: "int" },
      { header: "Amount", width: 15, format: "money" },
    ],
    rows,
  };
}

// ----- Receipts: 계산서 한 장 한 줄 ------------------------------------

const RECEIPT_COLUMNS: Column[] = [
  { header: "Date", width: 12, format: "date" },
  { header: "Time", width: 7, format: "text" },
  { header: "Receipt #", width: 18, format: "text" },
  { header: "Register", width: 11, format: "text" },
  { header: "Cashier", width: 14, format: "text" },
  { header: "Payment", width: 18, format: "text" },
  { header: "Subtotal", width: 11, format: "money" },
  { header: "Discount", width: 10, format: "money" },
  { header: "HST", width: 10, format: "money" },
  { header: "Total", width: 11, format: "money" },
  { header: "Tip", width: 9, format: "money" },
  { header: "Status", width: 10, format: "text" },
  { header: "Refund reason", width: 28, format: "text" },
];
const RECEIPT_STATUS_COL = 11;

function buildReceipts(period: string, days: DayData[]): Sheet {
  // 날짜·시각 오름차순 — 장부는 위에서 아래로 시간이 흐른다.
  const sales = days
    .flatMap((day) => day.sales)
    .sort((a, b) => a.business_date.localeCompare(b.business_date) || a.created_at.localeCompare(b.created_at));

  const rows: Row[] = sales.map((sale) => ({
    cells: [
      sale.business_date,
      clubTime(sale.created_at),
      sale.receipt_no,
      stationLabel(sale.station),
      sale.cashier ?? "",
      paymentText(sale),
      dollars(sale.subtotal),
      dollars(sale.discount),
      dollars(sale.tax),
      dollars(sale.total),
      dollars(sale.tip),
      statusText(sale),
      sale.refund_reason ?? "",
    ],
    style: statusText(sale) === "Refunded" ? "muted" : "normal",
  }));

  return {
    name: "Receipts",
    title: "Receipts journal — Pelham Hills",
    subtitle: `${period} · refunded bills stay listed but are left out of the Paid total (= Daily Total collected)`,
    columns: RECEIPT_COLUMNS,
    rows: [...rows, ...statusTotals(rows, RECEIPT_COLUMNS, RECEIPT_STATUS_COL, 0)],
    filter: true,
  };
}

// ----- Lines: 품목 한 줄 한 줄 -----------------------------------------

const LINE_COLUMNS: Column[] = [
  { header: "Date", width: 12, format: "date" },
  { header: "Receipt #", width: 18, format: "text" },
  { header: "Division", width: 16, format: "text" },
  { header: "Category", width: 15, format: "text" },
  { header: "Item", width: 30, format: "text" },
  { header: "SKU", width: 14, format: "text" },
  { header: "Qty", width: 6, format: "int" },
  { header: "Unit price", width: 11, format: "money", noTotal: true },
  { header: "Line discount", width: 12, format: "money" },
  { header: "Line total", width: 12, format: "money" },
  { header: "Status", width: 10, format: "text" },
];
const LINE_STATUS_COL = 10;

function buildLines(period: string, days: DayData[]): Sheet {
  const sales = days
    .flatMap((day) => day.sales)
    .sort((a, b) => a.business_date.localeCompare(b.business_date) || a.created_at.localeCompare(b.created_at));

  const rows: Row[] = sales.flatMap((sale) =>
    sale.lines.map((line) => {
      const category = lineCategory(line);
      return {
        cells: [
          sale.business_date,
          sale.receipt_no,
          divisionLabel(category),
          category,
          line.name,
          line.kind === "product" || !line.kind ? line.sku : "",
          line.quantity,
          dollars(line.unit_price),
          dollars(line.discount),
          dollars(line.line_total),
          statusText(sale),
        ],
        style: statusText(sale) === "Refunded" ? ("muted" as const) : ("normal" as const),
      };
    }),
  );

  return {
    name: "Lines",
    title: "Items sold — Pelham Hills",
    subtitle: `${period} · Paid line total = Daily Gross (before order discounts & tax)`,
    columns: LINE_COLUMNS,
    rows: [...rows, ...statusTotals(rows, LINE_COLUMNS, LINE_STATUS_COL, 0)],
    filter: true,
  };
}

/** 목록 시트 아래 두 줄: Paid 합계(= 리포트 숫자)와 Refunded 합계. 돈·수량 칸만 더한다. */
function statusTotals(rows: Row[], columns: Column[], statusCol: number, labelCol: number): Row[] {
  const first = FIRST_DATA_ROW;
  const last = FIRST_DATA_ROW + rows.length - 1;
  return (["Paid", "Refunded"] as const).map((status) => ({
    style: "total" as const,
    cells: columns.map((column, col): Cell => {
      if (col === labelCol) return status === "Paid" ? "Total — Paid" : "Total — Refunded";
      if ((column.format !== "money" && column.format !== "int") || column.noTotal) return null;
      const sum = rows.reduce((acc, row) => {
        const value = row.cells[col];
        return row.cells[statusCol] === status && typeof value === "number" ? acc + value : acc;
      }, 0);
      return sumIfsFormula(col, statusCol, status, first, last, sum);
    }),
  }));
}

// ===== 기간 ============================================================

export const MAX_RANGE_DAYS = 92;

/** `from`..`to`(포함) 의 YYYY-MM-DD 목록. 시간대에 흔들리지 않게 UTC 로 센다. */
export function datesBetween(from: string, to: string): string[] {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return [];
  const out: string[] = [];
  for (let t = start; t <= end && out.length <= MAX_RANGE_DAYS; t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

export function monthStart(date: string): string {
  return `${date.slice(0, 8)}01`;
}
