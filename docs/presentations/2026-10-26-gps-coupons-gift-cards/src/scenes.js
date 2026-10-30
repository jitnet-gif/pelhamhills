const NARR = __NARR__;
const DUR = __DUR__;
let LANG = "ko";
try { const s = localStorage.getItem("pelham-deck-lang"); if (s === "en" || s === "ko") LANG = s; } catch (e) {}
const T = (o) => (typeof o === "string" ? o : o[LANG]);

const UI = {
  eyebrow: { ko: "GPS 앱 · 운영안", en: "GPS app · operating plan" },
  title: { ko: "GPS 앱에서도 쿠폰·기프트카드 발행", en: "Coupons and gift cards from the GPS app" },
  sub: { ko: "golf-gps-pelhamhills-seven.vercel.app · 2026-10-26 제안 (아직 만들지 않음) · 나레이션 Hope", en: "golf-gps-pelhamhills-seven.vercel.app · proposal 2026-10-26 (not built yet) · narrated by Hope" },
  play: { ko: "▶ 재생", en: "▶ Play" }, pause: { ko: "❚❚ 멈춤", en: "❚❚ Pause" },
  speed: { ko: "속도 ", en: "Speed " }, who: { ko: "나레이션", en: "Narration" },
  pic: { ko: "화면", en: "Picture" }, keys: { ko: "핵심", en: "Key points" },
  foot: { ko: "제안입니다. 기프트카드(0120)·프로모 코드(0078)·도장 쿠폰북(GPS 0023–0028)은 이미 있는 것이고, GPS 발행 탭·손님 지갑·개인 쿠폰·0121은 아직 만들지 않았습니다. 화면 속 이름·금액은 예시입니다.",
          en: "This is a proposal. Gift cards (0120), promo codes (0078) and the stamp book (GPS 0023–0028) exist today; the GPS issue tab, guest wallet, personal coupons and 0121 are not built yet. Names and amounts on screen are examples." },
};

const bc = () => `<div class="gw-bc" aria-hidden="true"></div>`;

const S = [
  { n: { ko: "지금", en: "Today" },
    h: { ko: "발행은 프로샵 관리자 화면에서만", en: "Issuing happens only on the pro shop admin" },
    pic: () => `<div class="gw-two">
      <div class="gw-box"><h3>${T({ ko: "펠햄힐스 관리자", en: "Pelham Hills admin" })}</h3>
        <span><span class="tag ok">${T({ ko: "있음", en: "Have" })}</span> /admin/gift-cards — GIFT-</span>
        <span><span class="tag ok">${T({ ko: "있음", en: "Have" })}</span> /admin/promotions — PROMO-</span>
        <span><span class="tag ok">${T({ ko: "있음", en: "Have" })}</span> ${T({ ko: "계산서에서 바코드 스캔", en: "Scan the barcode on any bill" })}</span></div>
      <div class="gw-box"><h3>${T({ ko: "GPS 앱", en: "GPS app" })}</h3>
        <span><span class="tag ok">${T({ ko: "있음", en: "Have" })}</span> ${T({ ko: "도장 쿠폰북 10 = 무료 1", en: "Stamp book, 10 = 1 free" })}</span>
        <span><span class="tag no">${T({ ko: "없음", en: "Missing" })}</span> ${T({ ko: "기프트카드·쿠폰 발행", en: "Issue gift cards and coupons" })}</span>
        <span><span class="tag no">${T({ ko: "없음", en: "Missing" })}</span> ${T({ ko: "손님 폰에서 받은 카드 보기", en: "Guest sees cards on their phone" })}</span></div></div>`,
    pts: [{ ko: "기프트카드: 0120 (배포됨, SQL 실행 대기)", en: "Gift cards: 0120 (deployed, SQL not run yet)" },
      { ko: "프로모 코드: 0078, 계산서마다 1개", en: "Promo codes: 0078, one per bill" },
      { ko: "도장: 체크인 때 자동, 회원 제외 (GPS 0027·0026)", en: "Stamps: automatic at check-in, members excluded (GPS 0027, 0026)" },
      { ko: "목표: GPS에서 발행 + 손님 앱에서 꺼내 쓰기", en: "Goal: issue from GPS + guests pull them up in the app" }] },
  { n: { ko: "한 장부", en: "One ledger" },
    h: { ko: "GPS는 창구, 장부는 하나", en: "GPS is another window onto one ledger" },
    pic: () => `<div class="gw-flow">
      <div class="gw-node"><b>${T({ ko: "프로샵 관리자", en: "Pro shop admin" })}</b>pelhamhills.vercel.app</div>
      <div class="gw-ar">→</div>
      <div class="gw-node db"><b>Supabase</b>pelham_gift_cards<br>pelham_promotions<br><span class="note">${T({ ko: "같은 발행 함수", en: "same issue functions" })}</span></div>
      <div class="gw-ar">←</div>
      <div class="gw-node"><b>${T({ ko: "GPS 앱", en: "GPS app" })}</b>golf-gps-…-seven</div></div>
      <div class="offer"><b>${T({ ko: "같은 바코드 · 같은 잔액", en: "Same barcode · same balance" })}</b>${T({ ko: "GPS에서 만든 GIFT-7C2A… 카드도 프로샵 계산서에서 그대로 쏩니다.", en: "A GIFT-7C2A… card made in GPS scans on a pro shop bill exactly the same way." })}</div>`,
    pts: [{ ko: "두 앱은 이미 같은 데이터베이스 (GPS 0026이 pelham_ 표를 읽음)", en: "Both apps already share one database (GPS 0026 reads pelham_ tables)" },
      { ko: "GPS 쪽에 새 기프트카드 표를 만들지 않음", en: "No second gift card table on the GPS side" },
      { ko: "잔액은 결제 줄에서 계산 → 환불하면 저절로 복원", en: "Balance comes from payments → a refund puts it back automatically" },
      { ko: "리포트·백업도 한 곳에서", en: "Reports and backups stay in one place" }] },
  { n: { ko: "누가", en: "Who" },
    h: { ko: "GPS 관리 화면 새 탭 — 매니저만", en: "New GPS admin tab — managers only" },
    pic: () => `<div class="mock"><div class="mh">GPS Admin</div><div class="mb">
      <div class="gw-tabs"><span>${T({ ko: "플레이어", en: "Players" })}</span><span>${T({ ko: "통계", en: "Stats" })}</span><span>${T({ ko: "배너", en: "Banners" })}</span><span>${T({ ko: "주문", en: "Orders" })}</span><span class="on">${T({ ko: "쿠폰·기프트카드", en: "Coupons & Gift Cards" })}</span></div>
      <div class="gw-form"><i>${T({ ko: "종류", en: "Type" })}</i><span>${T({ ko: "기프트카드 · 무료", en: "Gift card · Complimentary" })}</span>
        <i>${T({ ko: "금액", en: "Amount" })}</i><span>$25.00</span>
        <i>${T({ ko: "받는 손님", en: "Guest" })}</i><span>${T({ ko: "앱 계정 검색 — 예: J. Smith", en: "Search app accounts — e.g. J. Smith" })}</span>
        <i>${T({ ko: "사유", en: "Reason" })}</i><span>${T({ ko: "10/25 전화 불만 — 카트 고장", en: "10/25 complaint call — cart broke down" })}</span></div>
      <div class="mbtn">${T({ ko: "발행하고 손님 앱으로 보내기", en: "Issue and send to the guest's app" })}</div></div></div>`,
    pts: [{ ko: "권한 = 프로샵 기프트카드 매니저와 같은 판정 (pelham_is_gift_card_manager)", en: "Access = same check as pro shop gift card managers (pelham_is_gift_card_manager)" },
      { ko: "같은 로그인이라 따로 권한 줄 필요 없음", en: "Same sign-in, so no separate grant" },
      { ko: "proshop@ 공용 계정은 제외 (0102와 같음)", en: "Shared proshop@ account excluded (as in 0102)" },
      { ko: "코스 지도만 고치는 GPS 관리자는 탭이 안 보임", en: "GPS admins who only edit the course map don't see the tab" }] },
  { n: { ko: "세 종류", en: "Three kinds" },
    h: { ko: "기프트카드 · 개인 쿠폰 · 캠페인 쿠폰", en: "Gift card · personal coupon · campaign coupon" },
    pic: () => `<div class="gw-tw"><table class="gw-t"><thead><tr><th></th><th>${T({ ko: "기프트카드", en: "Gift card" })}</th><th>${T({ ko: "개인 쿠폰 (새)", en: "Personal coupon (new)" })}</th><th>${T({ ko: "캠페인 쿠폰", en: "Campaign coupon" })}</th></tr></thead><tbody>
      <tr><th>${T({ ko: "바코드", en: "Barcode" })}</th><td>GIFT-…</td><td class="new">CPN-…</td><td>PROMO-…</td></tr>
      <tr><th>${T({ ko: "가치", en: "Value" })}</th><td>${T({ ko: "금액 → 잔액", en: "Amount → balance" })}</td><td class="new">${T({ ko: "$ 또는 % 할인 1회", en: "One $ or % discount" })}</td><td>${T({ ko: "$ 또는 % 할인", en: "$ or % discount" })}</td></tr>
      <tr><th>${T({ ko: "누구", en: "Who" })}</th><td>${T({ ko: "가진 사람 누구나 (회원 포함)", en: "Whoever holds it (members too)" })}</td><td class="new">${T({ ko: "손님 한 명에 묶임", en: "Tied to one guest" })}</td><td>${T({ ko: "코드 아는 누구나", en: "Anyone with the code" })}</td></tr>
      <tr><th>${T({ ko: "만료", en: "Expiry" })}</th><td>${T({ ko: "없음 (온타리오법)", en: "None (Ontario law)" })}</td><td class="new">${T({ ko: "있음 (예: 60일)", en: "Yes (e.g. 60 days)" })}</td><td>${T({ ko: "기간·횟수", en: "Dates · use limit" })}</td></tr>
      <tr><th>${T({ ko: "쓰는 곳", en: "Applies to" })}</th><td>${T({ ko: "모든 계산서 결제", en: "Payment on any bill" })}</td><td class="new">${T({ ko: "그린피 할인", en: "Green fee discount" })}</td><td>${T({ ko: "그린피 할인", en: "Green fee discount" })}</td></tr>
      <tr><th>${T({ ko: "지금", en: "Today" })}</th><td>0120</td><td class="new">${T({ ko: "결정 필요", en: "Needs a decision" })}</td><td>0078</td></tr></tbody></table></div>`,
    pts: [{ ko: "기프트카드 = 돈 (선수금 또는 무료 보상)", en: "Gift card = money (prepaid or complimentary)" },
      { ko: "개인 쿠폰 = 남이 못 쓰는 할인, 보상·재방문용", en: "Personal coupon = a discount nobody else can use, for make-goods and come-backs" },
      { ko: "캠페인 쿠폰 = 문자·배너로 뿌리는 공용 코드", en: "Campaign coupon = shared code sent by text or banner" },
      { ko: "할인 쿠폰은 계산서당 1장 (0078 규칙 유지)", en: "One discount coupon per bill (keeps the 0078 rule)" }] },
  { n: { ko: "손님 지갑", en: "Guest wallet" },
    h: { ko: "앱의 쿠폰 화면이 지갑이 됩니다", en: "The app's coupon screen becomes a wallet" },
    pic: () => `<div class="gw-ph"><div class="top">${T({ ko: "내 지갑", en: "My wallet" })}</div>
      <div class="gw-card"><span>${T({ ko: "기프트카드", en: "Gift card" })}</span><b>$35.00</b><span class="mono">GIFT-7C2A91F0B4 · ${T({ ko: "만료 없음", en: "no expiry" })}</span></div>
      <div class="gw-card cp"><span>${T({ ko: "개인 쿠폰 · 그린피", en: "Personal coupon · green fee" })}</span><b>−20%</b><span class="mono">${T({ ko: "12월 25일까지", en: "until Dec 25" })}</span></div>
      ${bc()}
      <div class="note" style="text-align:center">${T({ ko: "도장 7 / 10", en: "Stamps 7 / 10" })}</div>
      <div class="gw-stamps">${Array.from({ length: 10 }, (_, i) => `<s class="${i < 7 ? "f" : ""}"></s>`).join("")}</div></div>`,
    pts: [{ ko: "순서: 기프트카드 → 쿠폰 → 도장판", en: "Order: gift cards → coupons → stamp book" },
      { ko: "누르면 바코드 전체 화면 (밝기 최대)", en: "Tap for a full-screen barcode (brightness up)" },
      { ko: "다 쓴 카드·지난 쿠폰은 아래 '지난 것'으로", en: "Spent cards and expired coupons move to 'Past'" },
      { ko: "앱 없는 손님: 지금처럼 문자 MMS 바코드", en: "Guests without the app: barcode by MMS, as today" }] },
  { n: { ko: "계산", en: "Checkout" },
    h: { ko: "프로샵 계산은 그대로 — 스캔 한 번", en: "Pro shop checkout unchanged — one scan" },
    pic: () => `<div class="gw-bill">
      <div><span>${T({ ko: "그린피 18홀", en: "Green fee 18 holes" })}</span><span>$54.00</span></div>
      <div class="d"><span>CPN-… ${T({ ko: "개인 쿠폰 −20%", en: "personal coupon −20%" })}</span><span>−$10.80</span></div>
      <div class="g"><span>GIFT-7C2A… ${T({ ko: "기프트카드", en: "gift card" })}</span><span>−$35.00</span></div>
      <div><span>${T({ ko: "카드로 낼 나머지", en: "Rest by card" })}</span><span>$8.20</span></div></div>
      <div class="gw-push"><b>Pelham Hills</b>${T({ ko: "기프트카드를 $35.00 썼습니다. 남은 잔액 $0.00 · 쿠폰 사용 완료", en: "You used $35.00 on your gift card. Balance $0.00 · coupon used" })}<small>${T({ ko: "결제 직후 앱 알림 (예시, 세금 제외)", en: "App notification right after payment (example, before tax)" })}</small></div>`,
    pts: [{ ko: "GIFT- → 결제 수단 Gift card (0120 트리거가 잔액 확인)", en: "GIFT- → Gift card payment (0120 trigger checks the balance)" },
      { ko: "PROMO-·CPN- → 그린피 할인", en: "PROMO- / CPN- → green fee discount" },
      { ko: "모자란 몫은 다른 수단으로", en: "Any shortfall goes on another method" },
      { ko: "환불하면 잔액·쿠폰이 손님 지갑에 돌아옴", en: "A refund puts the balance and coupon back in the wallet" }] },
  { n: { ko: "운영", en: "Running it" },
    h: { ko: "이럴 때 이렇게 씁니다", en: "When to use which" },
    pic: () => `<div class="gw-sc">
      <div><b>${T({ ko: "불만 전화", en: "Complaint call" })}</b><span><em>${T({ ko: "기프트 · 무료", en: "Gift · comp" })}</em>${T({ ko: "문제 기록(0099)을 보고 매니저가 $25 카드를 그 손님 앱으로", en: "Manager reads the problem log (0099) and sends a $25 card to that guest's app" })}</span></div>
      <div><b>${T({ ko: "비로 중단", en: "Rained out" })}</b><span><em class="c">${T({ ko: "개인 쿠폰", en: "Personal" })}</em>${T({ ko: "레인체크 종이 대신 남은 홀만큼 할인 쿠폰", en: "A discount for the unplayed holes instead of a paper rain check" })}</span></div>
      <div><b>${T({ ko: "연말 선물", en: "Holiday gifts" })}</b><span><em>${T({ ko: "기프트 · 판매", en: "Gift · sold" })}</em>${T({ ko: "프로샵에서 돈 받고 발행 → 받는 분 문자", en: "Take payment at the pro shop, issue, text the recipient" })}</span></div>
      <div><b>${T({ ko: "오래 안 온 손님", en: "Lapsed guests" })}</b><span><em class="c">${T({ ko: "개인 쿠폰", en: "Personal" })}</em>${T({ ko: "60일 이상 미방문 명단을 매니저가 보고 골라서", en: "Manager picks from a 60-days-away list" })}</span></div>
      <div><b>${T({ ko: "평일 오후", en: "Weekday PM" })}</b><span><em class="c">${T({ ko: "캠페인", en: "Campaign" })}</em>${T({ ko: "PROMO-WKPM을 문자·앱 배너로 (동의한 사람만)", en: "PROMO-WKPM by text and app banner (consented only)" })}</span></div>
      <div><b>${T({ ko: "10번 라운드", en: "10th round" })}</b><span><em>${T({ ko: "도장", en: "Stamps" })}</em>${T({ ko: "지금 그대로 — 자동, 회원 제외", en: "Unchanged — automatic, members excluded" })}</span></div></div>`,
    pts: [{ ko: "보상은 그 자리에서, 손님 앱으로 바로", en: "Make-goods on the spot, straight to the guest's app" },
      { ko: "회원: 기프트카드는 OK, 할인 쿠폰은 제외 (도장과 같은 규칙)", en: "Members: gift cards yes, discount coupons no (same rule as stamps)" },
      { ko: "자동 발송은 하지 않음 — 매니저가 고름", en: "No automatic sending — a manager chooses" },
      { ko: "판매 카드도 온라인 판매는 하지 않음 (10-26 결정)", en: "Sold cards are not sold online (decided 10-26)" }] },
  { n: { ko: "안전·순서", en: "Safeguards" },
    h: { ko: "안전장치와 진행 순서", en: "Safeguards and next steps" },
    pic: () => `<div class="check">
      <div><span class="tag ok">${T({ ko: "있음", en: "Have" })}</span>${T({ ko: "사유 필수 · 기프트카드 $5,000 한도 · 무효도 사유", en: "Reason required · $5,000 gift card cap · void needs a reason" })}</div>
      <div><span class="tag">${T({ ko: "추가", en: "Add" })}</span>${T({ ko: "발행 내역 매일 메일 (analysis@·jitnet57@)", en: "Daily email of issued cards (analysis@, jitnet57@)" })}</div>
      <div><span class="tag">1</span>${T({ ko: "0120 SQL 실행 — 지금 대기 중", en: "Run the 0120 SQL — waiting now" })}</div>
      <div><span class="tag">2</span>${T({ ko: "결정: 개인 쿠폰(CPN-)을 넣을지, 회원 제외할지", en: "Decide: add personal coupons (CPN-)? exclude members?" })}</div>
      <div><span class="tag">3</span>${T({ ko: "0121: 계정 지정 발행 + 내 지갑 조회 함수", en: "0121: issue-to-account + my-wallet functions" })}</div>
      <div><span class="tag">4</span>${T({ ko: "GPS 관리 탭 + 지갑 화면 → 깨끗한 worktree에서 Vercel 배포", en: "GPS admin tab + wallet → Vercel deploy from a clean worktree" })}</div>
      <div><span class="tag no">${T({ ko: "막힘", en: "Blocked" })}</span>${T({ ko: "GPS 저장소 푸시 403 — jitnet-gif 권한 필요", en: "GPS repo push 403 — needs jitnet-gif access" })}</div></div>`,
    pts: [{ ko: "발행·무효·사용 모두 기록에 남음", en: "Issue, void and every use stay on record" },
      { ko: "손님 지갑은 자기 것만 읽기 (보안 함수)", en: "The wallet reads only the guest's own cards (secured function)" },
      { ko: "번호는 무작위 — 옆 번호로 남의 잔액 못 씀", en: "Codes are random — no guessing a neighbour's card" },
      { ko: "정해 주시면 2번부터 바로 만듭니다", en: "Once decided, I build from step 2" }] },
];
