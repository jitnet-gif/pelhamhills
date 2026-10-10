/**
 * 영수증 포맷터(`lib/retail/receipt.ts`)와 바코드(`lib/retail/barcode.ts`) 검사.
 *
 * 실행: `node frontend/scripts/verify-receipt.mjs` (Node 23.6+ — .ts 를 그대로 읽는다)
 *
 * 기대값은 **손으로 쓴 값**이다. 포맷터 출력을 복사해 붙이면 아무것도 검사하지 않는다.
 * 금액 옆 주석이 그 계산이고, 바코드 체크섬도 손으로 더한 값이다.
 */

import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

// `receipt.ts` 는 Next 규칙대로 `./types` 를 확장자 없이 부른다. Node ESM 은 그걸
// 못 찾으므로 여기서만 `.ts` 를 붙여 준다. 정적 import 는 이 등록보다 먼저 풀리니
// 포맷터는 아래에서 동적으로 읽는다.
// frontend/package.json 에 "type" 이 없어서, 형식을 알려 주지 않으면 Node 가 .ts 를
// CommonJS 로 읽어 보다가 실패한 뒤 ESM 으로 다시 읽으며 경고를 찍는다.
const asTypeScript = (result) =>
  result.url.endsWith(".ts") ? { ...result, format: "module-typescript" } : result;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier)) {
      try {
        return asTypeScript(nextResolve(`${specifier}.ts`, context));
      } catch {
        // 확장자를 붙여도 없으면 원래 이름으로 한 번 더 — 그 오류를 그대로 보여 준다.
      }
    }
    return asTypeScript(nextResolve(specifier, context));
  },
});

const { receiptBlocks, receiptDocBlocks, receiptHtml } = await import("../lib/retail/receipt.ts");
const { CODE128_PATTERNS, code128Svg, code128Values } = await import("../lib/retail/barcode.ts");
const { paidBillFor, teeReceipt, teeReceiptFor } = await import("../lib/teeSheet/receipt.ts");

const HEADER = {
  name: "Pelham Hills Golf Club",
  addressLines: ["196 Webber Road", "Welland, Ontario, L3B 5N9", "Canada"],
  phone: "+1 (905) 735-6768",
};

/**
 * 클럽의 실물 Lightspeed 영수증(2026-09-15)과 같은 금액.
 * 카트 $17.70 은 **그 영수증에 찍혀 있던 값**이다 — 지금 요금표(세전 $19.00, `cart_fee_for`)가
 * 아니다. 이 시험은 금액 규칙이 아니라 종이 모양을 검사한다.
 */
function greenFeeSale(overrides = {}) {
  return {
    id: 7,
    receipt_no: "PH-20260915-0007",
    business_date: "2026-09-15",
    lines: [
      {
        product_id: 201,
        sku: "GF18-PS",
        name: "18 Hole Green Fee - Public Senior",
        quantity: 1,
        unit_price: 4071,
        discount: 0,
        line_total: 4071,
      },
      {
        product_id: 202,
        sku: "HC18-PS",
        name: "Half Cart (18 Holes) - Public Senior",
        quantity: 1,
        unit_price: 1770,
        discount: 0,
        line_total: 1770,
      },
    ],
    // 4071 + 1770 = 5841, round(5841 × 0.13 = 759.33) = 759, 5841 + 759 = 6600
    subtotal: 5841,
    discount: 0,
    tax: 759,
    total: 6600,
    payment_method: "card",
    cashier: "John",
    note: null,
    refunded_at: null,
    refund_reason: null,
    // 9월은 EDT(UTC−4) → 현지 오후 2:07
    created_at: "2026-09-15T18:07:00+00:00",
    ...overrides,
  };
}

const find = (blocks, predicate) => blocks.filter(predicate);
const totals = (blocks) =>
  Object.fromEntries(find(blocks, (b) => b.kind === "total").map((b) => [b.label, b.amount]));

test("the green-fee receipt follows the Lightspeed layout block by block", () => {
  assert.deepEqual(
    receiptBlocks(greenFeeSale(), { header: HEADER, register: "Pro Shop Counter" }),
    [
      { kind: "logo" },
      { kind: "text", text: "Pelham Hills Golf Club", align: "center", bold: true, large: true },
      { kind: "text", text: "196 Webber Road", align: "center" },
      { kind: "text", text: "Welland, Ontario, L3B 5N9", align: "center" },
      { kind: "text", text: "Canada", align: "center" },
      { kind: "text", text: "+1 (905) 735-6768", align: "center" },
      { kind: "text", text: "Sales Receipt", align: "center", bold: true, large: true, gap: true },
      { kind: "text", text: "09/15/2026 2:07 pm", align: "center" },
      { kind: "field", label: "Ticket", value: "PH-20260915-0007", gap: true },
      { kind: "field", label: "Register", value: "Pro Shop Counter" },
      { kind: "field", label: "Employee", value: "John" },
      { kind: "itemsHead" },
      { kind: "item", name: "18 Hole Green Fee - Public Senior", detail: "GF18-PS", qty: 1, amount: "$40.71" },
      { kind: "item", name: "Half Cart (18 Holes) - Public Senior", detail: "HC18-PS", qty: 1, amount: "$17.70" },
      { kind: "rule" },
      { kind: "total", label: "Subtotal", amount: "$58.41" },
      { kind: "total", label: "HST ($58.41 @ 13%)", amount: "$7.59" },
      { kind: "total", label: "Total Tax", amount: "$7.59" },
      { kind: "total", label: "Total", amount: "$66.00", bold: true },
      { kind: "section", title: "PAYMENTS" },
      { kind: "total", label: "Card", amount: "$66.00" },
      { kind: "text", text: "Thank You!", align: "center", gap: true },
      { kind: "barcode", value: "PH-20260915-0007" },
    ],
  );
});

test("tax and total are copied from the sale, never recomputed", () => {
  // 일부러 맞지 않는 숫자다. 5841 × 13% 는 759 지만 서버가 999 라고 했으면 999 가 찍혀야 한다.
  const t = totals(receiptBlocks(greenFeeSale({ tax: 999, total: 12345 }), { header: HEADER }));
  assert.equal(t["HST ($58.41 @ 13%)"], "$9.99");
  assert.equal(t["Total Tax"], "$9.99");
  assert.equal(t.Total, "$123.45");
  assert.equal(t.Card, "$123.45");
});

test("quantities and discounts go in the detail line; Price stays the line total", () => {
  const sale = greenFeeSale({
    lines: [
      {
        product_id: 1,
        sku: "PV1-DZ",
        name: "Titleist Pro V1 (Dozen)",
        quantity: 2,
        unit_price: 8499,
        discount: 1000,
        line_total: 15998, // 2 × 8499 − 1000
      },
    ],
    // 주문 할인 500 → 과세 기준 15498, round(15498 × 0.13 = 2014.74) = 2015, 15498 + 2015 = 17513
    subtotal: 15998,
    discount: 500,
    tax: 2015,
    total: 17513,
  });
  const blocks = receiptBlocks(sale, { header: HEADER });
  assert.deepEqual(find(blocks, (b) => b.kind === "item"), [
    { kind: "item", name: "Titleist Pro V1 (Dozen)", detail: "PV1-DZ - 2 @ $84.99 - Discount $10.00", qty: 2, amount: "$159.98" },
  ]);
  assert.deepEqual(totals(blocks), {
    Subtotal: "$159.98",
    Discount: "-$5.00",
    "HST ($154.98 @ 13%)": "$20.15",
    "Total Tax": "$20.15",
    Total: "$175.13",
    Card: "$175.13",
  });
});

test("reprints, refunds, notes and member-account payments are marked", () => {
  const sale = greenFeeSale({
    payment_method: "member_account",
    cashier: null,
    note: "Member #4471",
    refunded_at: "2026-01-16T15:00:00+00:00",
    refund_reason: "Rained out",
    business_date: "2026-01-15",
    // 1월은 EST(UTC−5) → 현지 오후 12:30
    created_at: "2026-01-15T17:30:00+00:00",
  });
  const blocks = receiptBlocks(sale, { header: HEADER, reprint: true });
  const texts = find(blocks, (b) => b.kind === "text").map((b) => b.text);

  assert.equal(texts[texts.indexOf("Sales Receipt") + 1], "01/15/2026 12:30 pm");
  assert.equal(texts[texts.indexOf("Sales Receipt") + 2], "*** REPRINT ***");
  assert.ok(texts.includes("Note: Member #4471"));
  assert.ok(texts.includes("*** REFUNDED ***"));
  assert.ok(texts.includes("Rained out"));
  assert.equal(totals(blocks)["Member account"], "$66.00");
  // 계산대 이름을 안 주고 직원도 없으면 두 줄 다 빠진다.
  assert.deepEqual(
    find(blocks, (b) => b.kind === "field").map((b) => b.label),
    ["Ticket"],
  );
});

test("the date is the business date; the time is club-local, or dropped if unreadable", () => {
  const backdated = receiptBlocks(greenFeeSale({ business_date: "2026-09-14" }), { header: HEADER });
  assert.ok(backdated.some((b) => b.kind === "text" && b.text === "09/14/2026 2:07 pm"));

  const noTime = receiptBlocks(greenFeeSale({ created_at: "not a date" }), { header: HEADER });
  assert.ok(noTime.some((b) => b.kind === "text" && b.text === "09/15/2026"));
});

test("HTML escapes everything a person typed", () => {
  const sale = greenFeeSale({
    cashier: `Jo "<i>"`,
    lines: [{ ...greenFeeSale().lines[0], name: `Tee <script>alert(1)</script> & 'Co'` }],
  });
  const html = receiptHtml(receiptBlocks(sale, { header: HEADER }));
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("Tee &lt;script&gt;alert(1)&lt;/script&gt; &amp; &#39;Co&#39;"));
  assert.ok(html.includes("Employee:Jo &quot;&lt;i&gt;&quot;"));
});

test("HTML keeps the three-column item table and bold total", () => {
  const html = receiptHtml(receiptBlocks(greenFeeSale(), { header: HEADER }));
  assert.ok(html.includes(`<div class="rc-row rc-head"><span>Items</span><span>#</span><span>Price</span></div>`));
  assert.ok(
    html.includes(
      `<div class="rc-row"><span class="rc-detail">GF18-PS</span><span>1</span><span>$40.71</span></div>`,
    ),
  );
  assert.ok(html.includes(`<div class="rc-total rc-bold"><span>Total</span><span>$66.00</span></div>`));
  assert.ok(html.includes(`<p class="rc-text rc-gap">Ticket:PH-20260915-0007</p>`));
});

test("each printed copy is marked as the customer's or the shop's", () => {
  const customer = receiptBlocks(greenFeeSale(), { header: HEADER, copyLabel: "CUSTOMER COPY" });
  assert.deepEqual(customer.at(-1), {
    kind: "text",
    text: "CUSTOMER COPY",
    align: "center",
    bold: true,
    gap: true,
  });
  // 표시는 바코드 뒤에 온다 — 바코드 자리는 그대로다.
  assert.equal(customer.at(-2).kind, "barcode");
  // 표시를 주지 않으면 예전처럼 바코드로 끝난다.
  assert.equal(receiptBlocks(greenFeeSale(), { header: HEADER }).at(-1).kind, "barcode");
});

test("the club logo is embedded in the receipt, not fetched while printing", () => {
  const html = receiptHtml(receiptBlocks(greenFeeSale(), { header: HEADER }));
  // 주소로 걸려 있으면 인쇄가 이미지보다 빨라서 로고 없이 종이가 나갈 수 있다.
  assert.ok(html.includes(`<img alt="" class="rc-logo-img" src="data:image/png;base64,`));
  assert.ok(!/<img[^>]+src="\//.test(html));
  // 로고는 클럽 이름 바로 앞에 온다.
  const logoAt = html.indexOf("rc-logo-img");
  const nameAt = html.indexOf("Pelham Hills Golf Club");
  assert.ok(logoAt > 0 && logoAt < nameAt);
});

// ===== 티 시트 카드의 Payment =====

function teeBooking(overrides = {}) {
  return {
    id: "b-xeric",
    date: "2026-09-15",
    time: "1:30 PM",
    holes: 18,
    rate: 40.71,
    players: [],
    ...overrides,
  };
}

function teePlayer(overrides = {}) {
  return {
    id: "a1b2c3-8665",
    name: "Reg Jodoin",
    ratePlan: "Public Senior",
    paid: true,
    cancelled: false,
    cart: true,
    cartFee: 17.7,
    // 9월 EDT → 현지 오후 2:07
    paidAt: "2026-09-15T18:07:00+00:00",
    ...overrides,
  };
}

test("a tee-sheet payment prints green fee and cart like the Lightspeed receipt", () => {
  const blocks = receiptDocBlocks(teeReceipt(teeBooking(), teePlayer()), {
    header: HEADER,
    register: "Pro Shop Counter",
  });
  assert.deepEqual(blocks.slice(0, 1), [{ kind: "logo" }]);
  assert.ok(blocks.some((b) => b.kind === "text" && b.text === "09/15/2026 2:07 pm"));
  // 확인 코드 BPRE-DOTE + 플레이어 id 뒤 4자 8665
  assert.deepEqual(find(blocks, (b) => b.kind === "field"), [
    { kind: "field", label: "Ticket", value: "BPRE-DOTE-8665", gap: true },
    { kind: "field", label: "Register", value: "Pro Shop Counter" },
  ]);
  const detail = "Reg Jodoin - Tee Time: 09/15/2026 1:30 pm";
  assert.deepEqual(find(blocks, (b) => b.kind === "item"), [
    { kind: "item", name: "18 Hole Green Fee - Public Senior", detail, qty: 1, amount: "$40.71" },
    { kind: "item", name: "Half Cart (18 Holes) - Public Senior", detail, qty: 1, amount: "$17.70" },
  ]);
  // 실물 영수증과 같은 합: 4071 + 1770 = 5841, round(759.33) = 759, 6600
  assert.deepEqual(totals(blocks), {
    Subtotal: "$58.41",
    "HST ($58.41 @ 13%)": "$7.59",
    "Total Tax": "$7.59",
    Total: "$66.00",
    Payment: "$66.00",
  });
  assert.deepEqual(blocks.at(-1), { kind: "barcode", value: "BPRE-DOTE-8665" });
});

test("imported Chronogolf reservations get distinct tickets, not one shared code", () => {
  // id 앞부분은 전부 "chronogolf-csv-" 라 앞에서 자르면 모두 CHRO-NOGO-CHRO 가 된다(실제 사고).
  const first = teeReceipt(
    teeBooking({ id: "chronogolf-csv-19671-156843283" }),
    teePlayer({ id: "chronogolf-csv-19671-156843283-r442828665" }),
  );
  const second = teeReceipt(
    teeBooking({ id: "chronogolf-csv-19671-156843284" }),
    teePlayer({ id: "chronogolf-csv-19671-156843284-r442828777" }),
  );
  // 뒤 8자 = Chronogolf 예약 번호의 끝자리, 뒤 4자 = 라운드 id 의 끝자리.
  assert.equal(first.ticket, "5684-3283-8665");
  assert.equal(second.ticket, "5684-3284-8777");
});

test("an unpaid player's preview is stamped with the time it was opened, not a made-up payment", () => {
  const unpaid = teePlayer({ paid: false, paidAt: null });
  const preview = teeReceipt(teeBooking(), unpaid, { at: "2026-09-15T18:07:00+00:00" });
  assert.equal(preview.date, "2026-09-15");
  assert.equal(preview.time, "2026-09-15T18:07:00+00:00");
  // `at` 은 결제 시각이 없을 때만 쓴다 — 결제한 사람은 서버가 찍은 값 그대로다.
  const paid = teeReceipt(teeBooking(), teePlayer(), { at: "2030-01-01T00:00:00Z" });
  assert.equal(paid.time, "2026-09-15T18:07:00+00:00");
});

test("paying for the group puts everyone on one receipt with one total", () => {
  const players = [
    teePlayer({ id: "p-0001", name: "Doug Campbell", ratePlan: "Public", cart: true, cartFee: 19.0 }),
    teePlayer({ id: "p-0002", name: "Guest", ratePlan: "Public", cart: false, cartFee: 0 }),
    teePlayer({ id: "p-0003", name: "Guest", ratePlan: "Public", cart: false, cartFee: 0 }),
  ];
  const doc = teeReceiptFor(teeBooking({ rate: 34.52 }), players);
  // 3452 × 3 + 1900 = 12256, round(12256 × 0.13 = 1593.28) = 1593, 합계 13849
  assert.deepEqual(
    doc.lines.map((line) => [line.name, line.amount]),
    [
      ["18 Hole Green Fee - Public", 3452],
      ["Half Cart (18 Holes) - Public", 1900],
      ["18 Hole Green Fee - Public", 3452],
      ["18 Hole Green Fee - Public", 3452],
    ],
  );
  assert.deepEqual([doc.subtotal, doc.tax, doc.total], [12256, 1593, 13849]);
  // 한 번의 결제 = 한 장 = 한 번호.
  assert.equal(doc.ticket, "BPRE-DOTE-ALL");

  // 사람마다 따로 찍으면 세금이 사람 수만큼 반올림돼 합계가 달라진다 — 그래서 한 번에 계산한다.
  const apart = players.reduce((sum, player) => sum + teeReceiptFor(teeBooking({ rate: 34.52 }), [player]).total, 0);
  assert.notEqual(apart, doc.total);
});

test("no cart means one line; dollars become cents without float drift", () => {
  const doc = teeReceipt(teeBooking({ rate: 47.79 }), teePlayer({ cart: false, cartFee: 0, ratePlan: "Public" }));
  // 47.79 × 100 = 4778.999…, 반올림해서 4779. round(4779 × 0.13 = 621.27) = 621, 4779 + 621 = 5400
  assert.deepEqual(doc.lines.map((l) => [l.name, l.amount]), [["18 Hole Green Fee - Public", 4779]]);
  assert.deepEqual([doc.subtotal, doc.tax, doc.total], [4779, 621, 5400]);
});

test("the receipt date is the club-local payment date, or the tee date for old payments", () => {
  // 토론토 9월 15일 밤 9:30 = UTC 16일 01:30. 티 타임은 20일.
  const late = teeReceipt(teeBooking({ date: "2026-09-20" }), teePlayer({ paidAt: "2026-09-16T01:30:00Z" }));
  assert.equal(late.date, "2026-09-15");
  const lateBlocks = receiptDocBlocks(late, { header: HEADER });
  assert.ok(lateBlocks.some((b) => b.kind === "text" && b.text === "09/15/2026 9:30 pm"));

  const legacy = receiptDocBlocks(teeReceipt(teeBooking({ date: "2026-09-20" }), teePlayer({ paidAt: null })), {
    header: HEADER,
  });
  assert.ok(legacy.some((b) => b.kind === "text" && b.text === "09/20/2026"));
});

test("Code 128 B encodes a receipt number with a hand-computed checksum", () => {
  // P=48 H=40 -=13 2=18 0=16 6=22 9=25 1=17 5=21 (ASCII − 32)
  // 104 + 1·48 + 2·40 + 3·13 + 4·18 + 5·16 + 6·18 + 7·22 + 8·16 + 9·25 + 10·17
  //     + 11·21 + 12·13 + 13·16 + 14·16 + 15·16 + 16·17 = 2539, 2539 mod 103 = 67
  assert.deepEqual(code128Values("PH-20260915-0001"), [
    104, 48, 40, 13, 18, 16, 18, 22, 16, 25, 17, 21, 13, 16, 16, 16, 17, 67, 106,
  ]);

  const svg = code128Svg("PH-20260915-0001");
  // 모듈 수: 시작 11 + 데이터 16×11 + 체크섬 11 + 정지 13 = 211, 앞뒤 여백 10씩 → 231
  assert.ok(svg.includes(`viewBox="0 0 231 1"`));
  // 막대 수: 기호마다 3개 × 18(시작+데이터 16+체크섬) + 정지 4 = 58
  assert.equal(svg.match(/<rect /g).length, 58);
});

test("the Code 128 table has 107 distinct, well-formed patterns", () => {
  assert.equal(CODE128_PATTERNS.length, 107);
  assert.equal(new Set(CODE128_PATTERNS).size, 107);
  CODE128_PATTERNS.forEach((pattern, value) => {
    const widths = [...pattern].map(Number);
    const modules = widths.reduce((a, b) => a + b, 0);
    if (value === 106) {
      assert.equal(pattern, "2331112");
      return;
    }
    assert.equal(widths.length, 6, `value ${value}`);
    assert.equal(modules, 11, `value ${value}`);
    // 규격상 막대 모듈 합은 짝수(공백 합은 홀수)다. 옮겨 적다 틀린 칸은 대개 이걸 깬다.
    assert.equal((widths[0] + widths[2] + widths[4]) % 2, 0, `value ${value}`);
  });
});

test("Code 128 B refuses characters it cannot carry", () => {
  assert.throws(() => code128Values("Café"), /cannot encode/);
});

test("a card paid on the reader shows its approval, last four and where it was taken", () => {
  const sale = greenFeeSale({
    payments: [
      { method: "card", amount: 6600, tip: 0, entry: "integrated", auth_code: "A1B2C3", card_last4: "4242", terminal: "Stripe Terminal" },
    ],
    total: 6600,
  });
  const blocks = receiptBlocks(sale, { header: HEADER });
  assert.ok(blocks.some((b) => b.kind === "text" && b.text === "Approval A1B2C3 · ****4242 · Stripe Terminal"));
});

test("a tee reprint finds the bill that took the green fee, and only one bill", () => {
  const line = (bill, player) => ({ kind: "tee_player", booking_id: "b-1", player_id: player });
  const bills = [
    { id: 1, status: "void", lines: [line(1, "p1")] },
    { id: 2, status: "paid", lines: [line(2, "p1"), line(2, "p2")] },
    { id: 3, status: "paid", lines: [line(3, "p3")] },
  ];
  const p = (id) => teePlayer({ id });
  assert.equal(paidBillFor(bills, "b-1", [p("p1")])?.id, 2);
  assert.equal(paidBillFor(bills, "b-1", [p("p1"), p("p2")])?.id, 2);
  // 따로 낸 두 사람은 한 장으로 섞지 않는다. 계산서 없이 결제로 표시한 사람은 null.
  assert.equal(paidBillFor(bills, "b-1", [p("p1"), p("p3")]), null);
  assert.equal(paidBillFor(bills, "b-1", [p("p9")]), null);
  assert.equal(paidBillFor(bills, "b-2", [p("p1")]), null);
});
