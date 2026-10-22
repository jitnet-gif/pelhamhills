/**
 * 영수증을 찍는다. 기기마다 세 경로 중 하나다(`receiptPrinter.ts`, 계산대의 Receipt printer 설정):
 * - **브라우저 인쇄**: PC 에 Epson TM-m30III 드라이버가 깔려 있으면 그대로 감열 프린터로 나간다.
 * - **블루투스**: 페어링된 TM-m30 에 ESC/POS 를 직접 보낸다(Chrome·Edge).
 * - **네트워크**: 매장 네트워크의 TM-m30III 에 같은 ESC/POS 를 ePOS-Print 로 보낸다.
 * 블루투스·네트워크가 실패하면 브라우저 인쇄로 넘어간다.
 * 설치 절차: `docs/pro-shop-receipt-printing-2026-09-12.md`.
 *
 * React 포털이 아니라 `body` 바로 아래의 **컨테이너 하나**를 직접 채운다. 계산대의
 * 장바구니 본문은 데스크톱 사이드바와 모바일 시트에 두 번 그려지고, 매출 탭도 켜진 채로
 * 숨어 있다 — 컴포넌트마다 인쇄 영역을 두면 한 번의 인쇄에 영수증이 두 장 찍힌다.
 * 인쇄할 때만 채우고 끝나면 비운다. 비어 있는 동안에는 인쇄 CSS 가 아무것도 숨기지
 * 않으므로(`globals.css` 의 `:not(:empty)`), 다른 어드민 화면의 Ctrl+P 는 평소대로 찍힌다.
 *
 * 내용과 모양은 `receipt.ts` 가 정한다(블록 → HTML). 여기는 클럽 정보를 채워 운반만 한다.
 */

import { CLUB } from "@/lib/nav";
import { rainCheckBlocks, type RainCheck } from "@/lib/pos/rainCheck";
import { shiftReportBlocks, type ShiftInput, type ShiftSummary } from "@/lib/reports/shiftReport";

import {
  PAYMENT_LABELS,
  receiptDocBlocks,
  receiptHtml,
  saleReceipt,
  type ReceiptBlock,
  type ReceiptDoc,
  type ReceiptHeader,
} from "./receipt";
import { printBluetooth, printNetwork, readReceiptPrinterMode } from "./receiptPrinter";
import type { Sale } from "./types";

const ROOT_ID = "receipt-print-root";

/**
 * 계산대 이름. 클럽이 쓰던 Lightspeed 영수증의 표기(`Register:Pro Shop Counter`) 그대로다.
 * 지금은 계산대가 하나뿐이다. 스낵바 계산대가 생기면 기기별 설정으로 옮긴다.
 */
const REGISTER_NAME = "Pro Shop Counter";

const CLUB_HEADER: ReceiptHeader = { name: CLUB.name, addressLines: CLUB.mailingAddress, phone: CLUB.phone };

export function printReceipt(sale: Sale, options: { reprint?: boolean } = {}): void {
  printReceiptDoc(saleReceipt(sale), options);
}

/**
 * 영수증 한 장의 HTML. **화면 미리보기와 종이가 같은 HTML 이다** — 결제 전에 보여 주는 창이
 * 이것을 그대로 그리므로, 본 대로 찍힌다. 모양은 `globals.css` 의 `.rc-sheet` 규칙.
 * 사람이 입력한 글자(상품명·메모·이름)는 receiptHtml 이 전부 이스케이프한다.
 */
export function receiptSheetHtml(
  doc: ReceiptDoc,
  options: { reprint?: boolean; copyLabel?: string } = {},
): string {
  return receiptHtml(receiptSheetBlocks(doc, options));
}

function receiptSheetBlocks(doc: ReceiptDoc, options: { reprint?: boolean; copyLabel?: string }): ReceiptBlock[] {
  return receiptDocBlocks(doc, {
    header: CLUB_HEADER,
    register: REGISTER_NAME,
    reprint: options.reprint,
    copyLabel: options.copyLabel,
  });
}

/**
 * 한 번 인쇄에 나가는 장수와 각 장의 표시. 손님 것 한 장, 프로 샵 보관용 한 장 —
 * 클럽이 쓰던 Lightspeed 영수증도 두 장이었다. 장 사이에서 페이지가 끊기므로
 * 감열 프린터가 사이를 자른다(`globals.css` 의 `.rc-copy`).
 */
const COPY_LABELS = ["CUSTOMER COPY", "MERCHANT COPY"];

/** 판매가 아닌 결제(티 시트 카드의 Payment)도 같은 모양의 영수증으로 찍는다. */
export function printReceiptDoc(doc: ReceiptDoc, options: { reprint?: boolean } = {}): void {
  printSheets(
    COPY_LABELS.map((copyLabel) => receiptSheetBlocks(doc, { ...options, copyLabel })),
    { openDrawer: !options.reprint && paidInCash(doc) },
  );
}

/**
 * 현금을 받은 영수증인가. 블루투스 경로는 이때만 현금함을 연다 — 드라이버 경로는 모든 인쇄에
 * 열리던 것(문서의 "한계")을 고친 셈이다. 재인쇄에는 열지 않는다.
 */
function paidInCash(doc: ReceiptDoc): boolean {
  const cash = PAYMENT_LABELS.cash;
  return doc.payments?.length ? doc.payments.some((payment) => payment.label === cash) : doc.paymentLabel === cash;
}

/** 레인체크 전표 한 장의 HTML. 화면 미리보기와 종이가 같다. */
export function rainCheckSheetHtml(check: RainCheck, options: { reprint?: boolean } = {}): string {
  return receiptHtml(rainCheckBlocks(check, { header: CLUB_HEADER, reprint: options.reprint }));
}

/**
 * 레인체크 전표를 **사람마다 한 장씩** 찍는다. 장 사이에서 페이지가 끊기므로 감열 프린터가
 * 사람 사이를 자른다. 기록은 서버에 있으므로 보관용 사본은 찍지 않는다.
 */
export function printRainChecks(checks: readonly RainCheck[], options: { reprint?: boolean } = {}): void {
  if (checks.length === 0) return;
  printSheets(checks.map((check) => rainCheckBlocks(check, { header: CLUB_HEADER, reprint: options.reprint })));
}

/**
 * 근무 마감표(Daily close 의 Print) 한 장. 손님 영수증이 아니라 사본 표시 없이 한 장만, 서랍도 열지 않는다.
 * 미리보기와 종이가 같도록 HTML 도 여기서 같은 블록으로 만든다.
 */
export function shiftReportSheetHtml(input: ShiftInput, summary: ShiftSummary, cash: boolean): string {
  return receiptHtml(shiftReportBlocks(input, summary, { header: CLUB_HEADER, cash }));
}

export function printShiftReport(input: ShiftInput, summary: ShiftSummary, cash: boolean): void {
  printSheets([shiftReportBlocks(input, summary, { header: CLUB_HEADER, cash })]);
}

function printSheets(sheets: readonly ReceiptBlock[][], options: { openDrawer?: boolean } = {}): void {
  if (typeof window === "undefined") return;
  const mode = readReceiptPrinterMode();
  if (mode === "browser") return printInBrowser(sheets);
  const send = mode === "network" ? printNetwork : printBluetooth;
  send(sheets, options).catch((error: unknown) => {
    // 종이가 안 나오면 직원이 알아야 한다. 인쇄 창으로 넘겨 다른 프린터라도 고를 수 있게 한다.
    const reason = error instanceof Error ? error.message : String(error);
    const label = mode === "network" ? "Network" : "Bluetooth";
    window.alert(`${label} receipt printer did not print (${reason}) Opening the print dialog instead.`);
    printInBrowser(sheets);
  });
}

function printInBrowser(sheets: readonly ReceiptBlock[][]): void {

  let root = document.getElementById(ROOT_ID);
  if (!root) {
    root = document.createElement("div");
    root.id = ROOT_ID;
    document.body.appendChild(root);
  }
  root.className = "rc-sheet";
  root.innerHTML = sheets.map((sheet) => `<div class="rc-copy">${receiptHtml(sheet)}</div>`).join("");

  const container = root;
  const clear = () => {
    container.replaceChildren();
    window.removeEventListener("afterprint", clear);
  };
  window.addEventListener("afterprint", clear);
  window.print();
}
