const NARR = __NARR__;
const DUR = __DUR__;
const BARCODE = `__BARCODE__`;
let LANG = "ko";
try { const s = localStorage.getItem("pelham-deck-lang"); if (s === "en" || s === "ko") LANG = s; } catch (e) {}
const T = (o) => (typeof o === "string" ? o : o[LANG]);

const UI = {
  eyebrow: { ko: "프로샵 관리자 · 기프트카드", en: "Pro shop admin · Gift cards" },
  title: { ko: "발행할 때 바코드가 안 보인 이유와 수정", en: "Why the barcode was missing, and the fix" },
  sub: { ko: "/admin/gift-cards · 2026-10-26 · 나레이션 Hope (ElevenLabs)", en: "/admin/gift-cards · 2026-10-26 · narrated by Hope (ElevenLabs)" },
  play: { ko: "▶ 재생", en: "▶ Play" }, pause: { ko: "❚❚ 멈춤", en: "❚❚ Pause" },
  speed: { ko: "속도", en: "Speed" }, pitch: { ko: "피치", en: "Pitch" },
  who: { ko: "나레이션 · Hope", en: "Narration · Hope" },
  pic: { ko: "화면", en: "Picture" }, keys: { ko: "핵심", en: "Key points" },
  keyhint: { ko: "한/영 키 또는 L: 언어 · ←/→: 장면 · 스페이스: 재생", en: "Han/Eng key or L: language · ←/→: scene · Space: play" },
  nopitch: { ko: "이 브라우저에서는 피치를 바꿀 수 없습니다", en: "Pitch can't be changed in this browser" },
  foot: { ko: "카드 번호 GIFT-7C2E91A4B0 과 금액은 예시입니다. 바코드는 실제 Code 128 이라 스캐너로 읽힙니다. 수정은 커밋·배포 전입니다.",
          en: "Card GIFT-7C2E91A4B0 and the amounts are examples. The barcode is real Code 128, so a scanner reads it. The fix is not committed or deployed yet." },
};

const bc = (cls = "") => `<div class="gc-bc ${cls}">${BARCODE}</div>`;

// 화면 모형: 넓은 화면(폼 | 목록) 과 좁은 화면(폼 위, 목록 아래 — 화면 밖)
const screen = (narrow, fixed) => `<div class="gc-scr ${narrow ? "narrow" : ""}">
  <div class="gc-cap">${narrow ? T({ ko: "1280px 보다 좁음 (태블릿·노트북)", en: "Narrower than 1280px (tablet, laptop)" }) : T({ ko: "1280px 이상", en: "1280px and wider" })}</div>
  <div class="gc-view">
    <div class="gc-form"><b>New Gift Card</b><span class="gc-in">$50.00</span><span class="gc-go">Issue &amp; print</span>
      ${fixed ? `<div class="gc-just"><small>Just issued · $50.00</small>${bc()}<code>GIFT-7C2E91A4B0</code></div>` : ""}</div>
    <div class="gc-list"><b>${T({ ko: "카드 목록", en: "Card list" })}</b><span class="gc-row">GIFT-7C2E… <i>Barcode &amp; history</i></span>${bc("sm")}</div>
  </div>
  ${narrow ? `<div class="gc-fold">${T({ ko: "↑ 여기까지 화면 · 아래는 스크롤해야 보임", en: "↑ end of screen · below needs scrolling" })}</div>` : ""}
</div>`;

const S = [
  { n: { ko: "질문", en: "Question" },
    h: { ko: "바코드는 만들어지고 있었다", en: "The barcode was being made" },
    pic: () => `<div class="gc-three">
      <div class="gc-tile ok"><span class="tag ok">${T({ ko: "있음", en: "Yes" })}</span><b>${T({ ko: "인쇄된 카드", en: "Printed card" })}</b>${bc("sm")}</div>
      <div class="gc-tile ok"><span class="tag ok">${T({ ko: "있음", en: "Yes" })}</span><b>${T({ ko: "손님 문자 (MMS)", en: "Guest text (MMS)" })}</b>${bc("sm")}</div>
      <div class="gc-tile no"><span class="tag no">${T({ ko: "안 보임", en: "Not seen" })}</span><b>${T({ ko: "발행 직후 화면", en: "Screen after issuing" })}</b><div class="gc-empty">?</div></div>
    </div>`,
    pts: [
      { ko: "인쇄 카드와 문자에는 처음부터 바코드가 들어 있었다", en: "The printed card and the text always had the barcode" },
      { ko: "문제는 관리자 화면에서 바코드가 보이는 자리", en: "The problem was where the admin screen showed it" },
    ] },
  { n: { ko: "원인", en: "Cause" },
    h: { ko: "좁은 화면에서는 목록이 폼 아래로 내려간다", en: "On narrow screens the list drops below the form" },
    pic: () => `<div class="gc-two">${screen(false, false)}${screen(true, false)}</div>`,
    pts: [
      { ko: "바코드는 오른쪽 목록의 <b>Barcode &amp; history</b> 안에만 있었다", en: "The barcode lived only inside <b>Barcode &amp; history</b> in the list" },
      { ko: "폭 1280px 미만이면 목록이 폼 아래 — 발행 후 화면 밖", en: "Under 1280px the list sits below the form, off screen after issuing" },
    ] },
  { n: { ko: "수정 1", en: "Fix 1" },
    h: { ko: "발행 버튼 바로 밑에 Just issued 바코드", en: "Just issued barcode right under the Issue button" },
    pic: () => `<div class="gc-big"><div class="gc-card"><small>Just issued · $50.00</small>${bc("lg")}<code>GIFT-7C2E91A4B0</code><span class="gc-btn">Reprint</span></div></div>`,
    pts: [
      { ko: "카드 번호·금액과 같이 보인다", en: "Shown with the card number and value" },
      { ko: "<b>Reprint</b> 로 바로 다시 인쇄", en: "<b>Reprint</b> prints it again right there" },
      { ko: "화면 폭과 상관없이 같은 자리", en: "Same place at any screen width" },
    ] },
  { n: { ko: "수정 2", en: "Fix 2" },
    h: { ko: "금액 버튼은 이제 더하기", en: "Amount buttons now add" },
    pic: () => `<div class="gc-sum">
      <div class="gc-chips"><span>+$25.00</span><span class="on">+$50.00</span><span>+$100.00</span><span>+$150.00</span><span>+$200.00</span><span class="clr">Clear</span></div>
      <div class="gc-eq"><span class="on">$50</span><i>+</i><span class="on">$50</span><i>+</i><span>$25</span><i>=</i><b>$125.00</b></div>
      <div class="gc-was"><s>${T({ ko: "예전: 누른 금액으로 바뀜 → $25.00", en: "Before: replaced the amount → $25.00" })}</s></div>
    </div>`,
    pts: [
      { ko: "누를 때마다 입력칸 금액에 더한다", en: "Each tap adds to the amount in the box" },
      { ko: "<b>Clear</b> 로 비우기, 직접 입력도 그대로", en: "<b>Clear</b> empties it; typing still works" },
    ] },
  { n: { ko: "상태", en: "Status" },
    h: { ko: "고친 파일 하나 · 배포 전", en: "One file changed · not deployed" },
    pic: () => `<div class="gc-check">
      <div><span class="tag ok">${T({ ko: "완료", en: "Done" })}</span><span><span class="code">app/admin/gift-cards/page.tsx</span></span></div>
      <div><span class="tag ok">${T({ ko: "통과", en: "Pass" })}</span><span>${T({ ko: "이 파일 린트·타입 오류 없음", en: "No lint or type errors in this file" })}</span></div>
      <div><span class="tag">${T({ ko: "남음", en: "To do" })}</span><span>${T({ ko: "브라우저에서 직접 눌러 보기", en: "Click through in a browser" })}</span></div>
      <div><span class="tag">${T({ ko: "남음", en: "To do" })}</span><span>${T({ ko: "커밋·배포 후 카드 한 장으로 확인", en: "Commit, deploy, check with one card" })}</span></div>
    </div>`,
    pts: [
      { ko: "프로샵 화면만 바뀌었다 (GPS 앱 지갑은 그대로)", en: "Only the pro shop page changed (GPS app wallet unchanged)" },
      { ko: "배포 후 테스트 카드 한 장 발행 → 무효 처리", en: "After deploying, issue one test card, then void it" },
    ] },
];
