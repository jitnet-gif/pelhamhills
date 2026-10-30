const NARR = __NARR__;
const DUR = __DUR__;
let LANG = "ko";
try { const s = localStorage.getItem("pelham-deck-lang"); if (s === "en" || s === "ko") LANG = s; } catch (e) {}
const T = (o) => (typeof o === "string" ? o : o[LANG]);

const UI = {
  eyebrow: { ko: "GPS 쿠폰북 · 티 시트", en: "GPS coupon book · Tee sheet" },
  title: { ko: "라운드 100번마다 기념품", en: "A souvenir every 100 rounds" },
  sub: { ko: "2026-10-29 클럽 요청 · 그림 속 이름과 숫자는 예시입니다", en: "Club request, 2026-10-29 · names and numbers shown are examples" },
  play: { ko: "▶ 재생", en: "▶ Play" }, pause: { ko: "❚❚ 멈춤", en: "❚❚ Pause" },
  speed: { ko: "속도", en: "Speed" },
  who: { ko: "나레이션 · Hope (ElevenLabs)", en: "Narration · Hope (ElevenLabs)" },
  pic: { ko: "화면", en: "Picture" }, keys: { ko: "핵심", en: "Key points" },
  foot: { ko: "'100번마다'로 만들었습니다. 100번째 1회만 드리려면 알려 주세요.",
          en: "Built as every 100 rounds. Tell us if it should be once only, at 100." },
};

const track = () => {
  const dots = [];
  for (let i = 10; i <= 300; i += 10) {
    const x = (i / 300) * 100;
    if (i % 100 === 0) dots.push(`<span class="sv-gift" style="left:${x}%">★</span><span class="sv-lab big" style="left:${x}%">${i}</span>`);
    else dots.push(`<span class="sv-tick" style="left:${x}%"></span>`);
  }
  return `<div class="sv-track"><span class="sv-line"></span>${dots.join("")}<span class="sv-lab" style="left:0">0</span></div>
    <div class="sv-legend"><span><i style="background:var(--muted)"></i>${T({ ko: "10번마다 무료 라운드", en: "Free round every 10" })}</span><span><i style="background:var(--pink)"></i>${T({ ko: "100번마다 기념품", en: "Souvenir every 100" })}</span></div>`;
};
const billHead = (name) => `<div class="r"><span>${name} · ${T({ ko: "그린피", en: "Green fee" })}</span><span>$47.79</span></div>`;
const billTot = `<div class="r tot"><span>Total</span><span>$47.79</span></div>`;

const S = [
  { n: { ko: "규칙", en: "The rule" },
    h: { ko: "도장 10개 무료는 그대로, 100라운드 기념품이 추가", en: "Ten-stamp free round stays. A 100-round souvenir is added" },
    pic: () => track(),
    pts: [
      { ko: "100·200·300… <b>100라운드마다 기념품 1개</b>", en: "100, 200, 300… <b>one souvenir every 100 rounds</b>" },
      { ko: "무료 라운드 규칙은 바뀌지 않음", en: "The free-round rule does not change" },
      { ko: "기념품은 프로샵에서 직접 건넴", en: "Staff hand it over at the pro shop" },
    ] },
  { n: { ko: "세는 법", en: "Counting" },
    h: { ko: "라운드 = 도장 + 쓴 무료 라운드", en: "Rounds = stamps + free rounds used" },
    pic: () => `<div class="sv-sum">
        <div><b>91</b><small>${T({ ko: "도장(유료)", en: "Stamps (paid)" })}</small></div><span>+</span>
        <div><b>9</b><small>${T({ ko: "쓴 무료", en: "Free used" })}</small></div><span>=</span>
        <div class="t"><b>100</b><small>${T({ ko: "라운드", en: "Rounds" })}</small></div>
      </div>`,
    pts: [
      { ko: "무료 라운드에는 도장이 없지만 <b>라운드로는 셈</b>", en: "Free rounds have no stamp but <b>still count as rounds</b>" },
      { ko: "이미 쌓인 장부도 그대로 셈 — 처음부터 다시 시작 안 함", en: "The existing ledger counts — nobody starts from zero" },
    ] },
  { n: { ko: "티 시트", en: "Tee sheet" },
    h: { ko: "그린피를 담으면 계산서에 뜬다", en: "It appears when the green fee is on the bill" },
    pic: () => `<div class="sv-bill">${billHead("Alex Kim")}
        <div class="sv-row due"><span><b>🎁 Souvenir due</b> · Alex Kim<small>100 rounds — hand over a 100-round souvenir</small></span><span class="sv-btn">Gave souvenir</span></div>
        <div class="sv-row quiet"><span>Sam Lee · coupon book 7/10 · 37/100 to souvenir</span></div>
        ${billTot}</div>`,
    pts: [
      { ko: "받을 사람: <b>분홍 Souvenir due 줄</b>", en: "Due: a <b>pink Souvenir due row</b>" },
      { ko: "아직이면 회색 글씨로 진행만 표시", en: "Not yet: a small grey progress line" },
    ] },
  { n: { ko: "증정", en: "Giving it" },
    h: { ko: "건네고 누르면 끝. 금액은 그대로", en: "Hand it over, press once. The total stays the same" },
    pic: () => `<div class="sv-bill">${billHead("Alex Kim")}
        <div class="sv-row done"><span><b>Souvenir given</b> · Alex Kim<small>100 rounds · coupon book</small></span><span class="sv-btn alt">Undo</span></div>
        ${billTot}</div>`,
    pts: [
      { ko: "<b>계산서 금액 변화 없음</b>", en: "<b>The bill total does not change</b>" },
      { ko: "장부에 기념품 한 줄 — 이중 지급 막음", en: "One ledger line — prevents giving it twice" },
      { ko: "잘못 눌렀으면 Undo", en: "Pressed by mistake? Undo" },
    ] },
  { n: { ko: "손님 앱", en: "Customer app" },
    h: { ko: "손님은 앱에서 남은 라운드를 본다", en: "Customers see how many rounds are left" },
    pic: () => `<div class="sv-ph">
        <div class="sv-ban"><b>100 rounds - a souvenir is waiting for you!</b><small>Pick it up at the pro shop - show your code.</small></div>
        <div class="sv-stamps">${[1,2,3,4,5,6,7,8,9,10].map((i) => `<i class="${i <= 1 ? "on" : ""}">${i}</i>`).join("")}</div>
        <div class="sv-pro"><div><span>100-round souvenir</span><span>37/100</span></div><div class="m"><i style="width:37%"></i></div><small>63 more rounds to your next souvenir</small></div>
      </div>`,
    pts: [
      { ko: "진행 막대: <b>몇 라운드 남았는지</b>", en: "Progress bar: <b>rounds to go</b>" },
      { ko: "채워지면 수령 안내 표시", en: "A pickup banner when it fills" },
      { ko: "받은 뒤 기록에 남음", en: "Pickup shows in their history" },
    ] },
  { n: { ko: "예외", en: "Exceptions" },
    h: { ko: "이럴 때는 이렇게 됩니다", en: "What happens in these cases" },
    pic: () => `<div class="sv-ex">
        <div><b>${T({ ko: "회원", en: "Members" })}</b><small>${T({ ko: "도장이 없어 라운드가 안 쌓임. 회원이 되기 전에 채운 기념품은 받음", en: "No stamps, so rounds do not add up. A souvenir earned before joining is kept" })}</small></div>
        <div><b>${T({ ko: "앱 계정이 안 이어진 손님", en: "Guests not linked to the app" })}</b><small>${T({ ko: "계산서에 안 보임 (QR 연결 또는 가입 이메일로 예약해야 함)", en: "Not shown on the bill (needs a QR link or their sign-up email)" })}</small></div>
        <div><b>${T({ ko: "환불", en: "Refunds" })}</b><small>${T({ ko: "도장이 빠지면 라운드 수도 줄어듦. 이미 준 기념품은 그대로", en: "A removed stamp lowers the count. A souvenir already given stays given" })}</small></div>
      </div>`,
    pts: [
      { ko: "무료 라운드 규칙과 같은 기준", en: "Same rules as the free round" },
      { ko: "그린피가 계산서에 있어야 줄이 보임", en: "The row needs the green fee on the bill" },
    ] },
  { n: { ko: "지금 상태", en: "Status" },
    h: { ko: "배포와 SQL 실행 완료", en: "Deployed, and both SQL files have run" },
    pic: () => `<div class="sv-st">
        <div><span class="p">${T({ ko: "완료", en: "Done" })}</span><span>${T({ ko: "티 시트 계산서 · 손님 앱 배포", en: "Tee sheet bill · customer app deployed" })}</span></div>
        <div><span class="p">${T({ ko: "완료", en: "Done" })}</span><code>GPS 0029_coupon_hundred_gift.sql</code></div>
        <div><span class="p">${T({ ko: "완료", en: "Done" })}</span><code>0138_coupon_book_hundred_gift.sql</code></div>
        <div><span class="p n">${T({ ko: "미배포", en: "Not live" })}</span><span>${T({ ko: "직원 /fnb 화면의 '기념품 줬음' 버튼", en: "'Gave souvenir' button on the staff /fnb screen" })}</span></div>
      </div>`,
    pts: [
      { ko: "받을 손님의 그린피를 담으면 <b>기념품 줄 표시</b>", en: "Put an eligible green fee on the bill and <b>the row appears</b>" },
      { ko: "지금은 티 시트 계산서에서만 기록", en: "For now, record it on the tee sheet bill only" },
    ] },
];
