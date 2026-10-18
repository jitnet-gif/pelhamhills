/**
 * 영수증 블록(`receipt.ts`) → **ESC/POS 바이트**. 순수 함수다 — DOM 도 연결도 모른다.
 *
 * 블루투스로 붙은 Epson TM-m30 계열은 드라이버 없이 이 바이트를 그대로 받는다
 * (`receiptPrinter.ts` 가 운반한다). 브라우저 인쇄와 **같은 블록**을 옮기므로 종이에 찍히는
 * 내용은 같다. 모양만 프린터 글꼴로 바뀐다 — 80mm 롤, Font A 한 줄 48자.
 *
 * 블록 → 명령: 굵게 `ESC E`, 정렬 `ESC a`, 큰 글자 `GS !`, 바코드 `GS k`(Code 128),
 * 로고 `GS v 0`(래스터), 자르기 `GS V`. 장(sheet)마다 종이를 자른다 — 드라이버의
 * "페이지마다 자르기" 설정이 필요 없다.
 */

import type { ReceiptBlock } from "./receipt";

/** 80mm 롤, Font A(12×24) 한 줄 글자 수. */
export const RECEIPT_COLUMNS = 48;

/** 1비트 그림. `data` 는 한 줄에 `width / 8` 바이트, 1 = 검정. `width` 는 8 의 배수. */
export type Raster = { width: number; height: number; data: Uint8Array };

export type EscposOptions = {
  /** 맨 위 로고. 없으면 로고 블록을 건너뛴다(글자 영수증은 그대로 나간다). */
  logo?: Raster | null;
  /** 첫 장을 찍기 전에 현금함을 연다(프린터 DK 포트). 현금 결제에만. */
  openDrawer?: boolean;
};

const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;

/** 장 여러 개 → 한 번에 보낼 바이트. 장마다 끝에서 종이를 자른다. */
export function escposReceipt(sheets: readonly (readonly ReceiptBlock[])[], options: EscposOptions = {}): Uint8Array {
  const out = new ByteWriter();
  // 초기화, 코드 페이지 WPC1252(16) — `encodeText` 가 이 표에 맞춰 바꾼다.
  out.push(ESC, 0x40, ESC, 0x74, 16);
  if (options.openDrawer) out.push(ESC, 0x70, 0, 25, 250);
  for (const sheet of sheets) {
    for (const block of sheet) writeBlock(out, block, options.logo ?? null);
    // 자르는 날 아래까지 종이를 밀고 부분 절단(`GS V 66 n`: n 줄 밀고 자른다).
    out.push(GS, 0x56, 66, 4);
  }
  return out.bytes();
}

function writeBlock(out: ByteWriter, block: ReceiptBlock, logo: Raster | null): void {
  switch (block.kind) {
    case "logo":
      if (!logo) return;
      align(out, "center");
      out.push(GS, 0x76, 0x30, 0, ...le16(logo.width / 8), ...le16(logo.height));
      out.append(logo.data);
      out.push(LF);
      return;
    case "text": {
      if (block.gap) out.push(LF);
      align(out, block.align);
      // 큰 글자: 24자 안이면 가로세로 두 배, 길면 세로만 두 배(한 줄 48자 유지).
      const wide = block.large && block.text.length <= RECEIPT_COLUMNS / 2;
      const size = block.large ? (wide ? 0x11 : 0x01) : 0x00;
      out.push(GS, 0x21, size);
      if (block.bold) out.push(ESC, 0x45, 1);
      for (const line of wrap(block.text, wide ? RECEIPT_COLUMNS / 2 : RECEIPT_COLUMNS)) textLine(out, line);
      if (block.bold) out.push(ESC, 0x45, 0);
      if (size) out.push(GS, 0x21, 0);
      return;
    }
    case "field":
      if (block.gap) out.push(LF);
      align(out, "left");
      for (const line of wrap(`${block.label}:${block.value}`, RECEIPT_COLUMNS)) textLine(out, line);
      return;
    case "itemsHead":
      out.push(LF);
      align(out, "left");
      out.push(ESC, 0x45, 1);
      textLine(out, itemRow("Items", "#", "Price"));
      out.push(ESC, 0x45, 0);
      textLine(out, "-".repeat(RECEIPT_COLUMNS));
      return;
    case "item": {
      align(out, "left");
      out.push(ESC, 0x45, 1);
      for (const line of wrap(block.name, RECEIPT_COLUMNS)) textLine(out, line);
      out.push(ESC, 0x45, 0);
      // 설명이 길면 위 줄들에 먼저 쓰고, 마지막 줄 오른쪽에 수량·금액을 붙인다.
      const detailLines = wrap(block.detail, ITEM_DETAIL_WIDTH);
      const last = detailLines.pop() ?? "";
      for (const line of detailLines) textLine(out, line);
      textLine(out, itemRow(last, String(block.qty), block.amount));
      return;
    }
    case "rule":
      align(out, "left");
      textLine(out, "-".repeat(RECEIPT_COLUMNS));
      return;
    case "total":
      align(out, "left");
      if (block.bold) out.push(ESC, 0x45, 1);
      textLine(out, spread(block.label, block.amount));
      if (block.bold) out.push(ESC, 0x45, 0);
      return;
    case "section":
      out.push(LF);
      align(out, "left");
      out.push(ESC, 0x45, 1);
      textLine(out, block.title);
      out.push(ESC, 0x45, 0);
      return;
    case "barcode": {
      // Code 128 은 ASCII 만 담는다. 영수증 번호(`PH-20260915-0001`)는 늘 ASCII 다.
      const data = encodeText(`{B${block.value}`);
      align(out, "center");
      out.push(GS, 0x68, 80); // 높이 80점(10mm)
      out.push(GS, 0x77, 2); // 막대 폭
      out.push(GS, 0x48, 0); // 사람이 읽는 글자는 아래에 따로 찍는다
      out.push(GS, 0x6b, 73, data.length);
      out.append(data);
      out.push(LF);
      textLine(out, block.value);
      return;
    }
  }
}

/** 품목 줄 칸: 설명 | 수량(4) | 금액(11). 합이 48. */
const ITEM_QTY_WIDTH = 4;
const ITEM_PRICE_WIDTH = 11;
const ITEM_DETAIL_WIDTH = RECEIPT_COLUMNS - ITEM_QTY_WIDTH - ITEM_PRICE_WIDTH;

function itemRow(detail: string, qty: string, price: string): string {
  return (
    clip(detail, ITEM_DETAIL_WIDTH).padEnd(ITEM_DETAIL_WIDTH) +
    qty.padStart(ITEM_QTY_WIDTH) +
    price.padStart(ITEM_PRICE_WIDTH)
  );
}

/** 왼쪽 글자, 오른쪽 금액. 금액은 절대 자르지 않는다 — 넘치면 글자를 줄인다. */
export function spread(label: string, amount: string, width = RECEIPT_COLUMNS): string {
  const room = Math.max(0, width - amount.length - 1);
  const left = clip(label, room);
  return left + " ".repeat(width - left.length - amount.length) + amount;
}

function clip(text: string, width: number): string {
  return text.length <= width ? text : text.slice(0, width);
}

/** 단어 단위 줄바꿈. 한 단어가 한 줄보다 길면 그 단어를 끊는다. 빈 글은 빈 줄 하나. */
export function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let current = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    let rest = word;
    while (rest.length > width) {
      if (current) {
        lines.push(current);
        current = "";
      }
      lines.push(rest.slice(0, width));
      rest = rest.slice(width);
    }
    if (!current) current = rest;
    else if (current.length + 1 + rest.length <= width) current += ` ${rest}`;
    else {
      lines.push(current);
      current = rest;
    }
  }
  lines.push(current);
  return lines;
}

function align(out: ByteWriter, where: "left" | "center"): void {
  out.push(ESC, 0x61, where === "center" ? 1 : 0);
}

function textLine(out: ByteWriter, text: string): void {
  out.append(encodeText(text));
  out.push(LF);
}

/** WPC1252 에서 0x80–0x9F 자리에 있는 글자. 나머지 0xA0–0xFF 는 Latin-1 과 같다. */
const CP1252_EXTRA: Record<string, number> = {
  "€": 0x80, "‚": 0x82, "„": 0x84, "…": 0x85, "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94,
  "•": 0x95, "–": 0x96, "—": 0x97, "™": 0x99,
};

/**
 * 글자 → 프린터 코드 페이지(WPC1252). 표에 없는 글자는 악센트를 떼어 보고(`é` 는 표에 있다),
 * 그래도 없으면 `?`. 사람이 입력한 상품명·메모에 이모지가 섞여도 명령 바이트가 깨지지 않는다.
 */
export function encodeText(text: string): Uint8Array {
  const bytes: number[] = [];
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0x3f;
    if (code === 0x09) bytes.push(0x20);
    else if (code < 0x20 || code === 0x7f) continue; // 제어 문자는 명령으로 읽힌다
    else if (code < 0x80 || (code >= 0xa0 && code <= 0xff)) bytes.push(code);
    else if (char in CP1252_EXTRA) bytes.push(CP1252_EXTRA[char]);
    else {
      const bare = char.normalize("NFD").replace(/\p{M}/gu, "");
      const bareCode = bare.length === 1 ? bare.charCodeAt(0) : 0;
      bytes.push(bareCode >= 0x20 && bareCode < 0x7f ? bareCode : 0x3f);
    }
  }
  return Uint8Array.from(bytes);
}

function le16(value: number): [number, number] {
  return [value & 0xff, (value >> 8) & 0xff];
}

/**
 * RGBA 픽셀 → 1비트 래스터. 투명한 곳은 흰색(종이)이다. 감열 헤드는 회색을 못 찍으므로
 * 밝기 문턱값 하나로 나눈다.
 */
export function rasterFromRgba(rgba: Uint8ClampedArray, width: number, height: number, threshold = 160): Raster {
  const rowBytes = Math.ceil(width / 8);
  const data = new Uint8Array(rowBytes * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const alpha = rgba[i + 3] / 255;
      const luma = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
      const onPaper = luma * alpha + 255 * (1 - alpha);
      if (onPaper < threshold) data[y * rowBytes + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return { width: rowBytes * 8, height, data };
}

class ByteWriter {
  private chunks: Uint8Array[] = [];
  private pending: number[] = [];

  push(...values: number[]): void {
    this.pending.push(...values);
  }

  append(bytes: Uint8Array): void {
    this.flush();
    this.chunks.push(bytes);
  }

  bytes(): Uint8Array {
    this.flush();
    const total = this.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }

  private flush(): void {
    if (this.pending.length === 0) return;
    this.chunks.push(Uint8Array.from(this.pending));
    this.pending = [];
  }
}
