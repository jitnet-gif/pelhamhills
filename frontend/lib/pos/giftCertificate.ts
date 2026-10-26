/**
 * 종이 상품권(Gift Certificate) — 클럽이 쓰던 인쇄 양식을 그대로 옮겨, 기프트카드 한 장을 일반 프린터(Letter 가로)로 찍는다.
 * 원본 스캔은 세로로 누워 있어 돌려 세웠고, 왼쪽 로고(공·월계수)만 잘라 `public/pelham-hills/gift-certificate-logo.png` 에 두었다.
 *
 * 빈 줄에 들어가는 것: 금액(entitles), 받는 사람(To — 없으면 손으로 쓰게 비운다), 만료(No expiry — 온타리오법),
 * 오른쪽 위 번호 자리에는 카드 코드. Authorized by 는 서명 자리라 비워 둔다.
 * 바코드는 감열 카드와 같은 값이라 계산서 결제 칸에서 그대로 쏘면 된다.
 */

import { code128Svg } from "@/lib/retail/barcode";
import { formatMoney } from "@/lib/retail/types";

import type { GiftCard } from "./giftCard";

function escapeHtml(text: string) {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

const CSS = `
  @page{size:letter landscape;margin:0.5in}
  *{box-sizing:border-box}
  body{margin:0;color:#111;font-family:"Times New Roman",Times,Georgia,serif}
  .cert{position:relative;width:9.5in;height:3.95in;margin:0 auto;padding:0.12in 0.25in 0.18in;border:1px dashed #9a9a9a;
    display:grid;grid-template-columns:2.35in 1fr;grid-template-rows:auto 1fr;column-gap:0.15in}
  .no{position:absolute;top:0.14in;right:0.22in;font:700 11pt "Times New Roman",serif;letter-spacing:0.5px}
  .mark{position:absolute;top:0.38in;right:0.22in;font:700 10pt system-ui,sans-serif;color:#b00020}
  h1{grid-column:1/-1;margin:0;text-align:center;font-weight:700;font-size:60pt;line-height:1.05;letter-spacing:2px;color:#7c9a6b}
  .club{align-self:end;text-align:center;font-size:12.5pt;line-height:1.15}
  .club img{display:block;width:2.2in;margin:0 auto 0.04in}
  .club b{display:block;font-size:14pt;margin-top:0.02in}
  .lines{display:flex;flex-direction:column;gap:0.2in;padding-top:0.05in;font-size:15pt}
  .row{display:flex;align-items:flex-end;gap:0.08in}
  .row.in{padding-left:0.4in}
  .fill{flex:1;min-width:0;border-bottom:1px solid #111;padding:0 0.08in 1px;font-size:17pt;font-weight:700;
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-height:1.35em}
  .fill.short{flex:0 0 1.9in}
  .fill.exp{flex:0 0 1.5in;font-size:14pt}
  .fill small{font-size:11pt;font-weight:400}
  .cash{margin:-0.18in 0 0;text-align:right;font-size:7.5pt}
  .foot{margin-top:auto;display:flex;align-items:flex-end;justify-content:space-between;gap:0.2in}
  .bars{width:2.6in}
  .bars span{display:block;height:0.45in}
  .bars svg{display:block;width:100%;height:100%}
  .bars p{margin:1px 0 0;text-align:center;font:9pt ui-monospace,Menlo,monospace;letter-spacing:1px}
  .web{font-size:17pt;letter-spacing:0.5px}
  .note{font:13px system-ui,sans-serif;background:#fff8e1;border:1px solid #f0c36d;padding:8px 10px;margin:12px auto;width:9.5in}
  @media screen{body{background:#e5e5e5;padding:12px}.cert{background:#fff;border-style:solid;box-shadow:0 0 4px #999}}
  @media print{.note{display:none}}
`;

export function giftCertificateHtml(
  card: GiftCard,
  options: { origin: string; reprint?: boolean },
): string {
  const value =
    card.used > 0 && card.status === "active" ? card.balance : card.amount;
  const mark =
    card.status === "void" ? "VOID" : options.reprint ? "REPRINT" : "";
  return (
    `<div class="cert">` +
    `<span class="no">${escapeHtml(card.code)}</span>` +
    (mark ? `<span class="mark">*** ${mark} ***</span>` : "") +
    `<h1>Gift Certificate</h1>` +
    `<div class="club"><img alt="Pelham Hills Golf Club" src="${options.origin}/pelham-hills/gift-certificate-logo.png">` +
    `196 Webber Road,<br>Pelham, ON L3B 5N8<b>905-735-6768</b></div>` +
    `<div class="lines">` +
    `<div class="row">This certificate entitles <span class="fill">${escapeHtml(formatMoney(value))} ` +
    `<small>— green fees, pro shop &amp; snack bar</small></span></div>` +
    `<div class="row in">To <span class="fill">${escapeHtml(card.recipient ?? "")}</span></div>` +
    `<p class="cash">*not redeemable for cash</p>` +
    `<div class="row in">Authorized by <span class="fill short"></span>` +
    ` Expires on <span class="fill exp">No expiry</span></div>` +
    `<div class="foot"><div class="bars"><span>${code128Svg(card.code)}</span><p>${escapeHtml(card.code)}</p></div>` +
    `<span class="web">www.pelhamhills.ca</span></div>` +
    `</div></div>`
  );
}

/** 새 창에 상품권을 그려 인쇄 창을 연다. 팝업이 막혔으면 false. */
export function printGiftCertificate(
  card: GiftCard,
  options: { reprint?: boolean } = {},
): boolean {
  const win = window.open("", "_blank", "width=1100,height=600");
  if (!win) return false;
  win.document.write(
    `<!doctype html><html><head><meta charset="utf-8"><title>Gift Certificate ${escapeHtml(card.code)}</title>` +
      `<style>${CSS}</style></head><body>` +
      `<p class="note">Print on <b>Letter, Landscape</b> at <b>100% / Actual size</b>. Cut along the dashed line.</p>` +
      giftCertificateHtml(card, {
        origin: window.location.origin,
        reprint: options.reprint,
      }) +
      // onload 는 로고 그림까지 받은 뒤에 온다.
      `<script>window.onload=function(){setTimeout(function(){window.print()},200)}</script></body></html>`,
  );
  win.document.close();
  return true;
}
