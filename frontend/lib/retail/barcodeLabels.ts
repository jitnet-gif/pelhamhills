/**
 * 바코드 스티커·리스트 인쇄. 클럽이 만든 바코드(`PH000123`, `barcode.ts`)를 상품에 붙이거나
 * 카운터에 붙여 두고 쏘기 위한 종이다.
 *
 * 크기가 스캔을 정한다. `PH` + 6자리는 Code 128 B 로 123 모듈 + 앞뒤 여백 20 모듈 = 143 모듈이다.
 * - Avery 5160(2⅝×1in): 바코드 폭 2.3in → 모듈 약 0.016in(0.41mm).
 * - 라벨 롤(2.25×1.25in): 바코드 폭 2.05in → 모듈 약 0.014in(0.36mm).
 * 둘 다 일반 스캐너(DS2208 등)가 쉽게 읽는 0.25mm 보다 넉넉하다. 막대 높이도 0.4in 이상으로 둔다.
 * **브라우저 인쇄 배율이 100%(실제 크기)여야** 칸이 라벨에 맞는다 — 화면에만 그 안내를 띄운다.
 */

import { code128Svg } from "./barcode";
import { formatMoney, type Product } from "./types";

export type LabelLayout = "avery5160" | "roll" | "list";

export const LABEL_LAYOUTS: { value: LabelLayout; label: string; hint: string }[] = [
  { value: "avery5160", label: "Sticker sheet — Avery 5160 / 8160 (30 per Letter page)", hint: "2⅝ × 1 in labels" },
  { value: "roll", label: "Label printer roll — 2.25 × 1.25 in", hint: "One label per page (Zebra, DYMO, Rollo)" },
  { value: "list", label: "Counter list — name, price, barcode", hint: "Plain Letter paper, two columns" },
];

export type LabelOptions = {
  layout: LabelLayout;
  /** 상품마다 몇 장. */
  copies: number;
  /** 시트에서 이미 쓴 칸 수(앞에서부터 비워 둔다). 반쯤 쓴 시트를 다시 넣을 때. */
  skip: number;
  showPrice: boolean;
};

function escapeHtml(text: string) {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function labelHtml(item: Product, showPrice: boolean) {
  const code = (item.barcode ?? "").trim();
  return (
    `<div class="label"><div class="top"><span class="name">${escapeHtml(item.name)}</span>` +
    (showPrice ? `<span class="price">${escapeHtml(formatMoney(item.price))}</span>` : "") +
    `</div><div class="bars">${code128Svg(code)}</div><p class="code">${escapeHtml(code)}</p></div>`
  );
}

const SCREEN_NOTE =
  `<p class="note">Print at <b>100% / Actual size</b> (not “Fit to page”), margins <b>None</b>, ` +
  `or the barcodes will not line up with the stickers.</p>`;

const LABEL_CSS = `
  .label{box-sizing:border-box;overflow:hidden;display:flex;flex-direction:column;justify-content:center;background:#fff}
  .top{display:flex;align-items:baseline;gap:6px;min-width:0}
  .name{flex:1;min-width:0;font-weight:700;line-height:1.1;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
  .price{font-weight:700;white-space:nowrap}
  .bars svg{display:block;width:100%;height:100%}
  .code{margin:0;text-align:center;font-family:ui-monospace,Menlo,monospace;letter-spacing:1px}
  .note{font:13px system-ui,sans-serif;background:#fff8e1;border:1px solid #f0c36d;padding:8px 10px;margin:12px}
  @media print{.note{display:none}}
`;

function sheetDoc(items: Product[], options: LabelOptions) {
  // Avery 5160: 위 여백 0.5in, 왼쪽 0.1875in, 3열 × 10행, 열 사이 0.125in.
  const cells = [
    ...Array.from({ length: options.skip }, () => `<div class="label"></div>`),
    ...items.flatMap((item) => Array.from({ length: options.copies }, () => labelHtml(item, options.showPrice))),
  ];
  const pages: string[] = [];
  for (let i = 0; i < cells.length; i += 30) pages.push(`<div class="page">${cells.slice(i, i + 30).join("")}</div>`);
  return {
    css: `
      @page{size:letter;margin:0}
      body{margin:0;font-family:system-ui,sans-serif;color:#000}
      .page{width:8.5in;height:11in;box-sizing:border-box;padding:0.5in 0 0 0.1875in;display:grid;
        grid-template-columns:repeat(3,2.625in);grid-auto-rows:1in;column-gap:0.125in;break-after:page;overflow:hidden}
      .page:last-child{break-after:auto}
      .label{padding:0.06in 0.16in}
      .name{font-size:9pt}.price{font-size:9pt}
      .bars{height:0.44in;margin-top:0.03in}
      .code{font-size:7pt}
      @media screen{body{background:#e5e5e5}.page{background:#fff;margin:12px auto;box-shadow:0 0 4px #999}
        .label{outline:1px dashed #ccc}}
    `,
    body: pages.join(""),
  };
}

function rollDoc(items: Product[], options: LabelOptions) {
  const labels = items.flatMap((item) => Array.from({ length: options.copies }, () => labelHtml(item, options.showPrice)));
  return {
    css: `
      @page{size:2.25in 1.25in;margin:0}
      body{margin:0;font-family:system-ui,sans-serif;color:#000}
      .label{width:2.25in;height:1.25in;padding:0.07in 0.1in;break-after:page}
      .label:last-child{break-after:auto}
      .name{font-size:10pt}.price{font-size:10pt}
      .bars{height:0.5in;margin-top:0.04in}
      .code{font-size:8pt}
      @media screen{body{background:#e5e5e5;padding:12px;display:flex;flex-wrap:wrap;gap:8px}
        .label{outline:1px dashed #999}}
    `,
    body: labels.join(""),
  };
}

function listDoc(items: Product[]) {
  const rows = items
    .map((item) => {
      const code = (item.barcode ?? "").trim();
      return (
        `<div class="row"><div class="name">${escapeHtml(item.name)}` +
        `<small>${escapeHtml(item.menu_group || item.category)}</small></div>` +
        `<div class="price">${escapeHtml(formatMoney(item.price))}</div>` +
        `<div class="bars">${code128Svg(code)}</div><p class="code">${escapeHtml(code)}</p></div>`
      );
    })
    .join("");
  return {
    css: `
      @page{size:letter;margin:0.5in}
      body{font-family:system-ui,sans-serif;margin:0;color:#000}
      h1{font-size:16px;margin:0 0 10px}
      .grid{display:grid;grid-template-columns:1fr 1fr;gap:0 0.4in}
      .row{display:grid;grid-template-columns:1fr auto;gap:2px 12px;padding:10px 0;border-bottom:1px solid #ccc;break-inside:avoid}
      .row .name{font-weight:700;font-size:13px;display:block}.row .name small{display:block;font-weight:400;color:#555;font-size:11px}
      .row .price{font-weight:700;font-size:15px;text-align:right}
      .row .bars,.row .code{grid-column:1/-1}.row .bars{height:0.5in}
      .code{font-size:11px}
      @media screen{body{margin:24px}}
    `,
    body: `<h1>Items without a maker barcode — scan here</h1><div class="grid">${rows}</div>`,
  };
}

/** 새 창에 그려 인쇄 창을 연다. 팝업이 막혔으면 false. */
export function printBarcodeLabels(items: Product[], options: LabelOptions): boolean {
  const sorted = [...items].sort(
    (a, b) => (a.menu_group ?? "").localeCompare(b.menu_group ?? "") || a.name.localeCompare(b.name),
  );
  const doc =
    options.layout === "avery5160" ? sheetDoc(sorted, options) : options.layout === "roll" ? rollDoc(sorted, options) : listDoc(sorted);
  const win = window.open("", "_blank", "width=900,height=1000");
  if (!win) return false;
  win.document.write(
    `<!doctype html><html><head><meta charset="utf-8"><title>Barcode labels</title>` +
      `<style>${LABEL_CSS}${doc.css}</style></head><body>` +
      (options.layout === "list" ? "" : SCREEN_NOTE) +
      `${doc.body}<script>window.onload=function(){setTimeout(function(){window.print()},200)}</script></body></html>`,
  );
  win.document.close();
  return true;
}
