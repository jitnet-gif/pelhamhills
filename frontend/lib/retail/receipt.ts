/**
 * 영수증 한 장을 **블록 목록**으로 만든다. 순수 함수다 — DOM 도 프레임워크도 쓰지 않는다.
 *
 * 모양은 클럽이 쓰던 Lightspeed 영수증(2026-09-15 실물)을 따른다: 클럽 머리글 →
 * "Sales Receipt" 와 날짜 → Ticket / Register / Employee → Items·#·Price 표 →
 * 오른쪽 정렬 합계 → PAYMENTS → Thank You → 바코드.
 *
 * 왜 블록인가: 굵게·가운데 정렬·표·바코드는 고정폭 텍스트로 표현할 수 없다. 블록 하나가
 * ESC/POS 명령과 그대로 맞는다 — 굵게 `ESC E`, 정렬 `ESC a`, 바코드 `GS k`. 지금은
 * `receiptHtml()` 이 브라우저 인쇄용 HTML 로 그리고(`printReceipt.ts`), 다음 단계의 로컬
 * 브리지는 같은 블록을 명령으로 옮긴다. 두 경로가 같은 블록을 쓰므로 종이 내용이 어긋나지 않는다.
 *
 * 입력은 `ReceiptDoc` 한 모양이다. 리테일 판매는 `saleReceipt()` 가, 티 시트 결제는
 * `lib/teeSheet/receipt.ts` 가 이 모양으로 옮긴다 — 그래서 두 영수증의 머리글·로고·표·바코드가 같다.
 *
 * 금액은 **넘겨받은 값만** 찍는다. 세금이나 합계를 다시 계산하지 않는다 — 서버(파이썬
 * 은행가 반올림)와 1센트 어긋난 숫자가 종이에 찍히는 것이 `types.ts` 의 `computeTax` 주석이
 * 막으려는 사고다. 뺄셈은 HST 줄에 적는 과세 기준액(`subtotal − discount`, 정수) 하나뿐이다.
 *
 * 실물 영수증에 있지만 **일부러 넣지 않은 것**:
 * - `Fee total` — Lightspeed 의 예약 수수료다. 우리에게는 그런 요금이 없어 늘 $0.00 이 된다.
 * - `TRANSACTION DETAILS`(AID·암호문 등) — Chase 단말이 앱과 연동되기 전에는 채울 값이 없다.
 *   지어낸 승인 정보가 찍힌 영수증은 거짓 금융 기록이다. 지금 찍는 것은 직원이 단말기 전표에서
 *   옮겨 적은 승인번호·끝 4자리뿐이고, "keyed" 로 표시한다.
 */

import { code128Svg } from "./barcode";
import { RECEIPT_LOGO } from "./logo";
import { TAX_RATE, formatMoney, type Cents, type PaymentMethod, type Sale } from "./types";

/** 결제 수단 표시 이름. 계산대·매출 화면·영수증이 이 한 벌을 같이 쓴다. */
export const PAYMENT_LABELS: Record<PaymentMethod, string> = {
  cash: "Cash",
  card: "Card",
  debit: "Debit (Interac)",
  member_account: "Member account",
  gift_card: "Gift card",
  rain_check: "Rain check",
};

/** 계산서를 연 계산대(`pelham_bills.station`) 표시 이름. 사업부가 아니다 — 사업부는 `divisions.ts`. */
export const STATION_LABELS: Record<string, string> = {
  pro_shop: "Pro Shop",
  snack_bar: "Snack Bar",
  tee_sheet: "Tee Sheet",
  simulator: "Bay Sheet",
};

export function stationLabel(station: string | null | undefined): string {
  return station ? (STATION_LABELS[station] ?? station) : "";
}

/**
 * 영수증 시각은 클럽 현지 시각이다. 서버 `created_at` 은 UTC 라서, 브라우저 시간대에
 * 맡기면 시간대가 다른 PC 에서 다시 찍은 영수증의 시각이 달라진다.
 */
export const CLUB_TIME_ZONE = "America/Toronto";

const TAX_PERCENT = Math.round(TAX_RATE * 100);

/**
 * 영수증 맨 위 로고는 클럽 로고 이미지다(`logo.ts` 에 내용째 박혀 있다). 바로 아래 줄이
 * 클럽 이름이다. 예전에는 어드민 사이드바의 워드마크(◆ pelhamhills)를 글자로 찍었는데,
 * 그것은 POS 화면의 워드마크이지 골프장 로고가 아니었다.
 */

export type ReceiptHeader = {
  name: string;
  /** 주소 줄. 실물 영수증처럼 도로 / 도시·주·우편번호 / 나라 순으로 한 줄씩. */
  addressLines?: readonly string[];
  phone?: string;
  /** GST/HST 등록번호. 있을 때만 찍는다 — 없는 번호를 지어내지 않는다. */
  hstNumber?: string;
};

export type ReceiptOptions = {
  header: ReceiptHeader;
  /** 계산대 이름. 실물 영수증의 `Register:Pro Shop Counter`. */
  register?: string;
  /** 매출 화면에서 다시 찍은 영수증. 손님이 두 장을 들고 두 번 환불받지 못하게 표시한다. */
  reprint?: boolean;
  /**
   * 한 번 인쇄에 두 장이 나갈 때 각 장 맨 아래에 붙는 표시("CUSTOMER COPY" / "MERCHANT COPY").
   * 어느 장이 손님 것이고 어느 장이 보관용인지 종이만 보고 알 수 있어야 한다.
   */
  copyLabel?: string;
};

/** 품목 한 줄. `amount` 는 그 줄의 합계(센트) — Price 칸에 그대로 찍힌다. */
export type ReceiptLine = { name: string; detail: string; quantity: number; amount: Cents };

/** 영수증 한 장의 내용. 금액은 전부 센트 정수이고 이미 확정된 값이다. */
export type ReceiptDoc = {
  ticket: string;
  /** 영수증 날짜 `YYYY-MM-DD` (클럽 현지). */
  date: string;
  /** 시각(ISO). 없거나 읽을 수 없으면 날짜만 찍는다. */
  time: string | null;
  employee: string | null;
  lines: ReceiptLine[];
  subtotal: Cents;
  discount: Cents;
  tax: Cents;
  total: Cents;
  /** PAYMENTS 아래 줄의 이름(결제 수단). `payments` 가 있으면 그쪽을 찍는다. */
  paymentLabel: string;
  /**
   * 결제 한 줄씩(분할 결제). 카드·체크카드는 Chase 단말기가 준 승인번호가 붙는다 — 단말기가
   * 실제로 찍어 준 값이라 영수증에 옮겨도 된다. 지어낸 승인 정보는 절대 넣지 않는다.
   */
  payments?: ReceiptPayment[];
  /** 팁 합계. Total 밖이다. */
  tip?: Cents;
  note: string | null;
  refundedAt: string | null;
  refundReason: string | null;
};

export type ReceiptPayment = {
  label: string;
  amount: Cents;
  /** "Approval 083412 · ****4242 · keyed on Card terminal" 같은 한 줄. 없으면 null. */
  detail: string | null;
};

function paymentDetail(payment: NonNullable<Sale["payments"]>[number]): string | null {
  if (payment.rain_check_code) return payment.rain_check_code;
  if (!payment.auth_code) return null;
  const parts = [`Approval ${payment.auth_code}`];
  if (payment.card_last4) parts.push(`****${payment.card_last4}`);
  if (payment.entry === "keyed") parts.push(`keyed on ${payment.terminal ?? "card terminal"}`);
  return parts.join(" · ");
}

/**
 * 리테일 판매 → 영수증 내용. 날짜는 `business_date` 다 — 마감 리포트가 묶는 날짜와 영수증
 * 날짜가 같아야 소급 입력한 매출도 그 날 장부에서 찾을 수 있다.
 */
export function saleReceipt(sale: Sale): ReceiptDoc {
  return {
    ticket: sale.receipt_no,
    date: sale.business_date,
    time: sale.created_at,
    employee: sale.cashier,
    lines: sale.lines.map((line) => {
      // 실물 영수증의 품목 아래 줄("Guest ... - Tee Time: ...")처럼 " - " 로 잇는다.
      // Price 칸은 줄 합계(line_total) 그대로다 — 할인은 설명으로만 적어서 칸의 합이 Subtotal 과 맞는다.
      // 그린피 줄은 SKU 가 없다(`TEE`). 이름에 이미 시각과 사람이 들어 있다.
      const detail =
        line.kind === "tee_player"
          ? [`Tee time ${line.tee_date ?? ""}`.trim()]
          : line.kind === "sim_booking"
            ? [`Simulator ${line.tee_date ?? ""}`.trim()]
            : [line.sku];
      if (line.quantity > 1) detail.push(`${line.quantity} @ ${formatMoney(line.unit_price)}`);
      if (line.discount > 0) detail.push(`Discount ${formatMoney(line.discount)}`);
      return { name: line.name, detail: detail.join(" - "), quantity: line.quantity, amount: line.line_total };
    }),
    subtotal: sale.subtotal,
    discount: sale.discount,
    tax: sale.tax,
    total: sale.total,
    // 결제 줄이 없는 계산서(전액 할인)는 payment_method 가 null 이다.
    paymentLabel: sale.payment_method ? (PAYMENT_LABELS[sale.payment_method] ?? sale.payment_method) : "No charge",
    payments: sale.payments?.map((payment) => ({
      label: PAYMENT_LABELS[payment.method] ?? payment.method,
      amount: payment.amount,
      detail: paymentDetail(payment),
    })),
    tip: sale.tip,
    note: sale.note,
    refundedAt: sale.refunded_at,
    refundReason: sale.refund_reason,
  };
}

/**
 * 영수증의 한 덩어리. `gap` 은 앞에 한 줄만큼 띄우라는 뜻이다(ESC/POS 에서는 줄바꿈 하나).
 * 금액(`amount`)은 이미 사람이 읽는 문자열이다 — 렌더러는 계산하지 않고 옮기기만 한다.
 */
export type ReceiptBlock =
  | { kind: "logo" }
  | {
      kind: "text";
      text: string;
      align: "left" | "center";
      bold?: true;
      large?: true;
      gap?: true;
    }
  | { kind: "field"; label: string; value: string; gap?: true }
  | { kind: "itemsHead" }
  | { kind: "item"; name: string; detail: string; qty: number; amount: string }
  | { kind: "rule" }
  | { kind: "total"; label: string; amount: string; bold?: true }
  | { kind: "section"; title: string }
  | { kind: "barcode"; value: string };

const TIME_FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: CLUB_TIME_ZONE,
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

export function receiptBlocks(sale: Sale, options: ReceiptOptions): ReceiptBlock[] {
  return receiptDocBlocks(saleReceipt(sale), options);
}

export function receiptDocBlocks(doc: ReceiptDoc, options: ReceiptOptions): ReceiptBlock[] {
  const { header } = options;
  const blocks: ReceiptBlock[] = [{ kind: "logo" }];

  blocks.push({ kind: "text", text: header.name, align: "center", bold: true, large: true });
  for (const line of header.addressLines ?? []) {
    blocks.push({ kind: "text", text: line, align: "center" });
  }
  if (header.phone) blocks.push({ kind: "text", text: header.phone, align: "center" });
  if (header.hstNumber) {
    blocks.push({ kind: "text", text: `HST # ${header.hstNumber}`, align: "center" });
  }

  blocks.push({ kind: "text", text: "Sales Receipt", align: "center", bold: true, large: true, gap: true });
  blocks.push({ kind: "text", text: receiptDateTime(doc), align: "center" });
  if (options.reprint) {
    blocks.push({ kind: "text", text: "*** REPRINT ***", align: "center", bold: true });
  }

  blocks.push({ kind: "field", label: "Ticket", value: doc.ticket, gap: true });
  if (options.register) blocks.push({ kind: "field", label: "Register", value: options.register });
  if (doc.employee) blocks.push({ kind: "field", label: "Employee", value: doc.employee });

  blocks.push({ kind: "itemsHead" });
  for (const line of doc.lines) {
    blocks.push({
      kind: "item",
      name: line.name,
      detail: line.detail,
      qty: line.quantity,
      amount: formatMoney(line.amount),
    });
  }
  blocks.push({ kind: "rule" });

  blocks.push({ kind: "total", label: "Subtotal", amount: formatMoney(doc.subtotal) });
  if (doc.discount > 0) {
    blocks.push({ kind: "total", label: "Discount", amount: `-${formatMoney(doc.discount)}` });
  }
  const taxable = doc.subtotal - doc.discount;
  blocks.push({
    kind: "total",
    label: `HST (${formatMoney(taxable)} @ ${TAX_PERCENT}%)`,
    amount: formatMoney(doc.tax),
  });
  blocks.push({ kind: "total", label: "Total Tax", amount: formatMoney(doc.tax) });
  blocks.push({ kind: "total", label: "Total", amount: formatMoney(doc.total), bold: true });

  blocks.push({ kind: "section", title: "PAYMENTS" });
  if (doc.payments && doc.payments.length > 0) {
    for (const payment of doc.payments) {
      blocks.push({ kind: "total", label: payment.label, amount: formatMoney(payment.amount) });
      if (payment.detail) blocks.push({ kind: "text", text: payment.detail, align: "left" });
    }
  } else {
    blocks.push({ kind: "total", label: doc.paymentLabel, amount: formatMoney(doc.total) });
  }
  if (doc.tip && doc.tip > 0) blocks.push({ kind: "total", label: "Tip", amount: formatMoney(doc.tip) });
  if (doc.note) blocks.push({ kind: "text", text: `Note: ${doc.note}`, align: "left" });

  if (doc.refundedAt) {
    blocks.push({ kind: "text", text: "*** REFUNDED ***", align: "center", bold: true, gap: true });
    if (doc.refundReason) blocks.push({ kind: "text", text: doc.refundReason, align: "center" });
  }

  blocks.push({ kind: "text", text: "Thank You!", align: "center", gap: true });
  blocks.push({ kind: "barcode", value: doc.ticket });
  if (options.copyLabel) {
    blocks.push({ kind: "text", text: options.copyLabel, align: "center", bold: true, gap: true });
  }
  return blocks;
}

/**
 * 블록 → 브라우저 인쇄용 HTML. 스타일은 `globals.css` 의 `#receipt-print-root .rc-*`.
 * 상품명·메모·직원 이름은 사람이 입력한 값이라 **전부 이스케이프**한다.
 */
export function receiptHtml(blocks: readonly ReceiptBlock[]): string {
  return `<div class="rc">${blocks.map(blockHtml).join("")}</div>`;
}

function blockHtml(block: ReceiptBlock): string {
  switch (block.kind) {
    case "logo":
      return `<div class="rc-logo"><img alt="" class="rc-logo-img" src="${RECEIPT_LOGO}"></div>`;
    case "text":
      return `<p class="${classes(
        "rc-text",
        block.align === "center" && "rc-center",
        block.bold && "rc-bold",
        block.large && "rc-large",
        block.gap && "rc-gap",
      )}">${escapeHtml(block.text)}</p>`;
    case "field":
      // 실물 영수증 표기 그대로 `Ticket:220000013873` — 콜론 뒤에 공백이 없다.
      return `<p class="${classes("rc-text", block.gap && "rc-gap")}">${escapeHtml(block.label)}:${escapeHtml(block.value)}</p>`;
    case "itemsHead":
      return `<div class="rc-row rc-head"><span>Items</span><span>#</span><span>Price</span></div>`;
    case "item":
      return (
        `<div class="rc-item"><p class="rc-bold">${escapeHtml(block.name)}</p>` +
        `<div class="rc-row"><span class="rc-detail">${escapeHtml(block.detail)}</span>` +
        `<span>${block.qty}</span><span>${escapeHtml(block.amount)}</span></div></div>`
      );
    case "rule":
      return `<hr class="rc-rule">`;
    case "total":
      return `<div class="${classes("rc-total", block.bold && "rc-bold")}"><span>${escapeHtml(block.label)}</span><span>${escapeHtml(block.amount)}</span></div>`;
    case "section":
      return `<p class="rc-section">${escapeHtml(block.title)}</p>`;
    case "barcode":
      return `<div class="rc-barcode">${code128Svg(block.value)}<p>${escapeHtml(block.value)}</p></div>`;
  }
}

function classes(...names: Array<string | false | undefined>): string {
  return names.filter(Boolean).join(" ");
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * 실물 영수증 표기 `09/15/2026 2:07 pm`. 날짜는 `doc.date` 그대로, 시각은 `doc.time` 을
 * 클럽 현지 시각으로. 시각이 없거나 읽을 수 없으면 날짜만 찍는다.
 */
function receiptDateTime(doc: ReceiptDoc): string {
  return clubDateTime(doc.date, doc.time);
}

/** `YYYY-MM-DD` + ISO 시각 → `09/15/2026 2:07 pm`. 영수증과 레인체크 전표가 같은 표기를 쓴다. */
export function clubDateTime(date: string, time: string | null): string {
  const time12 = time ? localTime(time) : "";
  return time12 ? `${usDate(date)} ${time12}` : usDate(date);
}

/** `YYYY-MM-DD` → `MM/DD/YYYY`. 읽을 수 없으면 그대로. */
export function usDate(iso: string): string {
  const [year, month, day] = iso.split("-");
  return year && month && day ? `${month}/${day}/${year}` : iso;
}

function localTime(iso: string): string {
  const value = new Date(iso);
  if (Number.isNaN(value.getTime())) return "";
  // formatToParts 로 조립한다. format() 은 ICU 버전에 따라 "PM" 앞에 좁은 공백(U+202F)을
  // 넣어서, 같은 영수증이 PC 마다 다른 글자로 찍힌다.
  const parts = TIME_FORMAT.formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? "";
  return `${part("hour")}:${part("minute")} ${part("dayPeriod").toLowerCase()}`;
}
