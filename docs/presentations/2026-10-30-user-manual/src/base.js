let LANG = "ko";
try { const s = localStorage.getItem("pelham-deck-lang"); if (s === "en" || s === "ko") LANG = s; } catch (e) {}
const T = (o) => (typeof o === "string" ? o : Array.isArray(o) ? o[LANG === "ko" ? 0 : 1] : o[LANG]);
const L = (ko, en) => T([ko, en]);

const UI = {
  eyebrow: { ko: "Pelham Hills Golf Club · 전체 사용설명서", en: "Pelham Hills Golf Club · Full user manual" },
  title: { ko: "사용설명서", en: "User Manual" },
  sub: { ko: "2026-10-30 코드 기준 · 화면의 이름·금액·코드는 샘플입니다", en: "Based on the code, 2026-10-30 · names, amounts and codes shown are samples" },
  play: { ko: "▶ 재생", en: "▶ Play" }, pause: { ko: "❚❚ 멈춤", en: "❚❚ Pause" },
  speed: { ko: "속도", en: "Speed" },
  who: { ko: "나레이션 · Hope (Natural)", en: "Narration · Hope (Natural)" },
  keys: { ko: "핵심", en: "Key points" },
  foot: { ko: "재생하면 다음 장면으로 끝까지 이어집니다. 위쪽 단추로 장을 고르고, ← → 키로도 넘깁니다. 코드 내용을 정리한 것이라 운영 DB에 SQL이 적용되지 않은 기능은 화면이 다를 수 있습니다.",
          en: "Play runs on to the end. Pick a section above, or use the ← → keys. This manual is written from the code, so a feature whose SQL has not been applied to the live database may look different." },
};

const CH = [
  { n: ["시작하기", "Getting started"] },
  { n: ["티시트", "Tee sheet"] },
  { n: ["결제", "Payment"] },
  { n: ["계산대·마감", "Registers & closing"] },
  { n: ["기프트카드", "Gift cards"] },
  { n: ["쿠폰·프로모션", "Coupons & promos"] },
  { n: ["회원권·시뮬레이터", "Memberships & simulator"] },
  { n: ["손님 화면", "Guest side"] },
  { n: ["마케팅·AI", "Marketing & AI"] },
  { n: ["관리자", "Admin"] },
];
const S = [];
let CURCH = 0;
const add = (id, n, h, pic, pts, ko, en) => S.push({ id, ch: CURCH, n: { ko: n[0], en: n[1] }, h: { ko: h[0], en: h[1] }, pic, pts, say: { ko, en } });

const win = (title, path, inner) => `<div class="um"><div class="um-h"><span>${title}</span><span>${path || ""}</span></div><div class="um-b">${inner}</div></div>`;
const tabs = (list, on) => `<div class="um-tabs">${list.map((t) => `<span class="${t === on ? "on" : ""}">${t}</span>`).join("")}</div>`;
const btn = (t, k) => `<span class="um-btn ${k || ""}">${t}</span>`;
const btns = (...a) => `<div class="um-btns">${a.join("")}</div>`;
const fld = (l, v) => `<div class="um-f">${l}<span>${v || "&nbsp;"}</span></div>`;
const g2 = (...a) => `<div class="um-g2">${a.join("")}</div>`;
const g3 = (...a) => `<div class="um-g3">${a.join("")}</div>`;
const rw = (l, r, sm) => `<div class="um-r"><span>${l}${sm ? `<small>${sm}</small>` : ""}</span>${r}</div>`;
const pill = (t, k) => `<span class="um-pill ${k || ""}">${t}</span>`;
const num = (t) => `<b>${t}</b>`;
const steps = (...a) => `<div class="um-steps">${a.map((x) => `<div>${T(x)}</div>`).join("")}</div>`;
const cols = (...a) => `<div class="um-cols">${a.map((x) => `<div class="${x[2] || ""}"><b>${T(x[0])}</b><small>${T(x[1])}</small></div>`).join("")}</div>`;
const warn = (ko, en) => `<div class="um-warn">${L(ko, en)}</div>`;
const table = (head, rows) => `<div class="um-tw"><table class="um-tb"><thead><tr>${head.map((h) => `<th>${T(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${T(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
const phone = (inner) => `<div class="um-phone">${inner}</div>`;
const bub = (inner) => `<div class="um-bub">${inner}</div>`;
const SAMP = () => `<span class="samp">SAMPLE · ${L("샘플", "NOT VALID")}</span>`;
const bar = (code) => `<span class="bc">${BARS[code]}</span>`;
const GIFT = "GIFT-1A2B3C4D5E", PROMO = "PROMO-FALL18", CPN = "CPN-7F3A91C04B";
const NUM = () => L("[클럽 번호]", "[club number]");

const giftIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 9h18v4H3zM5 13v8h14v-8M12 9v12M12 9c-3 0-5-1.5-5-3.3C7 4 9.5 3.5 12 9zM12 9c3 0 5-1.5 5-3.3C17 4 14.500 3.500 12 9z"/></svg>`;
const stamps = (n) => `<ol class="cp-grid" style="list-style:none;margin:0;padding:0" aria-label="${n} of 10 stamps">${Array.from({ length: 10 }, (_, i) => i < n ? `<li class="cp-c on"><img alt="" src="club-logo.png" style="transform:rotate(${[-8, 6, -4, 9, -6, 5, -9, 7, -3][i]}deg)"></li>` : i === 9 ? `<li class="cp-c gift">${giftIcon}</li>` : `<li class="cp-c">${i + 1}</li>`).join("")}</ol>`;
const ban = (k, a, b) => `<div class="cp-ban ${k}"><b>${a}</b><small>${b}</small></div>`;
const codeBox = () => `<div class="cp-code"><span><small>Your code</small><b>K7M2QX</b></span><small>Show this at<br>the pro shop</small></div>`;
const wallet = (k, type, a, s, c) => `<div class="gc-wal ${k}"><span class="t">${type}</span><span class="a">${a}</span><span class="s">${s}</span><span class="c">${c} · Tap to show barcode</span></div>`;
const thermal = (o = {}) => `<div class="gc-th"><img alt="" src="club-logo-print.png"><b>Pelham Hills Golf Club</b><div class="big">GIFT CARD</div><div>Issued Oct 30, 2026 2:15 PM</div>${o.reprint ? "<b>*** REPRINT ***</b>" : ""}<hr>
  <div class="rw"><span>Card</span><span>${GIFT}</span></div><div class="rw"><span>For</span><span>Jordan Lee</span></div><div class="rw"><span>Value</span><b>$100.00</b></div><hr>
  <p>Use it for green fees, the pro shop and the snack bar. Any amount left stays on the card. Expires Dec 31, 2027. Not redeemable for cash. Keep it safe — anyone with this barcode can spend it.</p>${bar(GIFT)}</div>`;
const cert = () => `<div class="gc-wrap"><div class="gc-cert"><span class="no">${GIFT}</span><h3>Gift Certificate</h3>
  <div class="cl"><img alt="Pelham Hills Golf Club" src="gift-certificate-logo.png">196 Webber Road,<br>Pelham, ON L3B 5N8<b>905-735-6768</b></div>
  <div class="ln"><div class="rw">This certificate entitles <span class="fl">$100.00 <small>— green fees, pro shop &amp; snack bar</small></span></div>
  <div class="rw in">To <span class="fl">Jordan Lee</span></div><p class="cash">*not redeemable for cash</p>
  <div class="rw in">Authorized by <span class="fl s"></span> Expires on <span class="fl e">Dec 31, 2027</span></div>
  <div class="ft"><div class="bars">${bar(GIFT)}<p>${GIFT}</p></div><span class="web">www.pelhamhills.ca</span></div></div></div></div>`;
