const NARR = __NARR__;
const DUR = __DUR__;
let LANG = "ko";
try { const s = localStorage.getItem("pelham-deck-lang"); if (s === "en" || s === "ko") LANG = s; } catch (e) {}
const T = (o) => (typeof o === "string" ? o : o[LANG]);

const UI = {
  eyebrow: { ko: "메시지 발송 · 결제 영수증", en: "Messages · Payment receipts" },
  title: { ko: "이메일·문자·영수증은 어디로 나가나", en: "How email, texts and receipts go out" },
  sub: { ko: "2026-10-30 코드 기준 · 그림 속 이름과 금액은 예시입니다", en: "Based on the code, 2026-10-30 · names and amounts shown are examples" },
  play: { ko: "▶ 재생", en: "▶ Play" }, pause: { ko: "❚❚ 멈춤", en: "❚❚ Pause" },
  speed: { ko: "속도", en: "Speed" },
  who: { ko: "나레이션 · Hope (ElevenLabs)", en: "Narration · Hope (ElevenLabs)" },
  pic: { ko: "그림", en: "Picture" }, keys: { ko: "핵심", en: "Key points" },
  foot: { ko: "Stripe 대시보드의 자동 이메일 영수증이 켜져 있으면 온라인 손님은 메일을 두 통 받습니다. 코드로는 확인할 수 없어 대시보드에서 봐야 합니다. 발신 번호는 저장소 문서 기준이며 운영 서버 값과 직접 대조하지는 않았습니다.",
          en: "If Stripe's automatic email receipts are on, online customers get two emails. The code can't show this, so check the dashboard. The sending number comes from the repo docs and was not compared with the live server value." },
};

const svc = (k) => ({
  g: `<span class="er-svc g">Gmail</span>`,
  t: `<span class="er-svc t">Twilio</span>`,
  s: `<span class="er-svc s">Stripe</span>`,
})[k];
const none = () => `<span class="er-svc n">${T({ ko: "없음", en: "None" })}</span>`;
const item = (ko, en, sko, sen, right, off) => `<div class="er-it${off ? " off" : ""}"><span>${T({ ko, en })}<small>${T({ ko: sko, en: sen })}</small></span>${right}</div>`;

const S = [
  { n: { ko: "한눈에", en: "At a glance" },
    h: { ko: "이메일은 Gmail, 문자는 Twilio, 결제는 Stripe", en: "Email is Gmail, texts are Twilio, payments are Stripe" },
    pic: () => `<div class="er-flow">
      <div class="er-fr"><div>${T({ ko: "이메일", en: "Email" })}</div><span>→</span><div class="g">Gmail<small>smtp.gmail.com</small></div><span>→</span><div>${T({ ko: "받은편지함", en: "Inbox" })}</div></div>
      <div class="er-fr"><div>${T({ ko: "문자", en: "Text" })}</div><span>→</span><div class="t">Twilio<small>SMS</small></div><span>→</span><div>${T({ ko: "휴대폰", en: "Phone" })}</div></div>
      <div class="er-fr"><div>${T({ ko: "카드 결제", en: "Card payment" })}</div><span>→</span><div class="s">Stripe<small>${T({ ko: "승인 처리", en: "Approval" })}</small></div><span>→</span><div>${T({ ko: "우리 서버", en: "Our server" })}<small>${T({ ko: "그다음 문자·이메일", en: "Then text or email" })}</small></div></div>
    </div>`,
    pts: [
      { ko: "이메일은 <b>전부 Gmail</b>로 나감", en: "All email goes through <b>Gmail</b>" },
      { ko: "Twilio는 <b>문자 전용</b>", en: "Twilio is for <b>texts only</b>" },
      { ko: "Stripe는 결제만 처리, 영수증 발송 요청은 안 함", en: "Stripe only handles the payment. We don't ask it to send receipts" },
    ] },
  { n: { ko: "Gmail 이메일", en: "Gmail email" },
    h: { ko: "Gmail로 나가는 이메일 여섯 가지", en: "Six kinds of email go through Gmail" },
    pic: () => `<div class="er-list">
      ${item("결제 영수증", "Payment receipt", "손님 · 직원이 보낼 때", "Customer · when staff send it", svc("g"))}
      ${item("기프트카드", "Gift card", "손님 · 직원이 보낼 때", "Customer · when staff send it", svc("g"))}
      ${item("proshop@ 활동 알림", "proshop@ activity alert", "관리자", "Managers", svc("g"))}
      ${item("서버 멈춤 알림", "Server down alert", "관리자", "Managers", svc("g"))}
      ${item("온라인 결제 영수증", "Online payment receipt", "손님 · 승인 후 1분 안에 자동 (0141 적용 후)", "Customer · automatic within a minute (after 0141)", svc("g"))}
      ${item("실내 시뮬레이터 확정 메일", "Indoor simulator confirmation", "손님 · 웹 예약 시 자동 (0140 적용 후)", "Customer · automatic on web booking (after 0140)", svc("g"))}
    </div>`,
    pts: [
      { ko: "Gmail <b>앱 비밀번호</b>로 접속 (Fly secrets에 보관)", en: "Signs in with a Gmail <b>app password</b>, kept in Fly secrets" },
      { ko: "손님 답장은 info@pelhamhills.ca로 감", en: "Customer replies go to info@pelhamhills.ca" },
      { ko: "하루 약 2,000통 한도. 대량 마케팅 메일에는 별도 서비스 필요", en: "About 2,000 a day. Bulk marketing email needs a separate service" },
    ] },
  { n: { ko: "Twilio 문자", en: "Twilio texts" },
    h: { ko: "Twilio로 나가는 문자", en: "Texts that go through Twilio" },
    pic: () => `<div class="er-list">
      ${item("카드 승인 문자", "Card approval text", "금액·카드 끝 4자리 · 자동", "Amount and last 4 digits · automatic", svc("t"))}
      ${item("결제 영수증 문자", "Receipt text", "직원이 보낼 때", "When staff send it", svc("t"))}
      ${item("기프트카드 문자", "Gift card text", "바코드 · 직원이 보낼 때", "Barcode · when staff send it", svc("t"))}
      ${item("마케팅 캠페인", "Marketing campaigns", "/marketing에서 발송", "Sent from /marketing", svc("t"))}
    </div>`,
    pts: [
      { ko: "<b>STOP</b>으로 답한 번호에는 어떤 문자도 안 감", en: "Numbers that replied <b>STOP</b> get no texts at all" },
      { ko: "승인 문자는 결제 한 건에 <b>한 번만</b>", en: "An approval text goes out <b>once</b> per payment" },
      { ko: "번호가 없으면 승인 문자도 없음", en: "No phone number means no approval text" },
    ] },
  { n: { ko: "전화번호", en: "Phone numbers" },
    h: { ko: "문자는 한 번호에서 나가고, 손님 번호는 순서대로 찾는다", en: "Texts come from one number, and the customer's number is found in order" },
    pic: () => `<div class="er-list">
      ${item("보내는 번호", "Sending number", "모든 문자 · 사이트에 표시된 클럽 번호와 같음", "All texts · same as the club number on the website", `<span class="er-svc t">+1 249-805-0556</span>`)}
      ${item("손님 답장", "Customer replies", "같은 번호로 받음 · STOP, C 취소", "Arrive at the same number · STOP, C to cancel", `<span class="er-svc t">+1 249-805-0556</span>`)}
      ${item("프로샵 안내 번호", "Pro shop number", "문자로 해결 안 되는 일을 안내", "For anything a text can't solve", `<span class="er-svc n">+1 416-822-7609</span>`)}
    </div>
    <div class="er-gap"><div><b>${T({ ko: "손님 번호를 찾는 순서", en: "Order for finding the customer's number" })}</b><small>${T({ ko: "① 직원이 계산대에서 적은 번호 → ② 계산서의 티타임 플레이어 → ③ 그 예약의 첫 번호 → ④ 시뮬레이터 예약. 온라인 결제는 예약 번호", en: "1. Number staff typed at the register → 2. Tee time player on the bill → 3. First number on that booking → 4. Simulator booking. Online payments use the booking number" })}</small></div></div>`,
    pts: [
      { ko: "손님 화면에는 <b>249-805-0556</b>에서 온 문자로 보임", en: "Customers see texts from <b>249-805-0556</b>" },
      { ko: "번호는 +1로 시작하는 국제 형식으로 맞춰서 보냄", en: "Numbers are normalized to the +1 format before sending" },
      { ko: "네 곳 모두 번호가 없으면 승인 문자는 나가지 않음", en: "If all four are empty, no approval text goes out" },
    ] },
  { n: { ko: "결제별 영수증", en: "By payment" },
    h: { ko: "결제 방식마다 손님이 받는 것", en: "What the customer gets for each payment" },
    pic: () => `<div class="tw"><table class="er-tb">
      <thead><tr><th>${T({ ko: "결제 방식", en: "Payment" })}</th><th>${T({ ko: "자동으로", en: "Automatic" })}</th><th>${T({ ko: "직원이 보내면", en: "If staff send it" })}</th></tr></thead>
      <tbody>
        <tr><td><b>${T({ ko: "단말기 카드", en: "Card on the reader" })}</b></td><td>${T({ ko: "승인 문자", en: "Approval text" })} ${svc("t")}</td><td>${svc("t")} ${svc("g")}</td></tr>
        <tr><td><b>${T({ ko: "손으로 입력한 카드", en: "Keyed card" })}</b></td><td>${none()}</td><td>${svc("t")} ${svc("g")}</td></tr>
        <tr><td><b>${T({ ko: "현금·수표·기프트카드 등", en: "Cash, cheque, gift card, others" })}</b></td><td>${none()}</td><td>${svc("t")} ${svc("g")}</td></tr>
        <tr><td><b>${T({ ko: "온라인 티타임·시뮬레이터", en: "Online tee time, simulator" })}</b></td><td>${T({ ko: "승인 문자", en: "Approval text" })} ${svc("t")}<br>${T({ ko: "이메일 영수증", en: "Email receipt" })} ${svc("g")}</td><td>${T({ ko: "해당 없음", en: "Not applicable" })}</td></tr>
        <tr><td><b>${T({ ko: "온라인 회원권", en: "Online membership" })}</b></td><td>${T({ ko: "이메일 영수증", en: "Email receipt" })} ${svc("g")}</td><td>${T({ ko: "해당 없음", en: "Not applicable" })}</td></tr>
      </tbody></table></div>`,
    pts: [
      { ko: "온라인 결제는 <b>이메일 영수증이 자동</b> (0141 적용 후)", en: "Online payments get an <b>automatic email receipt</b> (after 0141)" },
      { ko: "프로샵 결제의 영수증 전체는 직원이 결제 끝 화면에서 보냄", en: "For pro shop payments, staff send the full receipt from the Payment complete screen" },
      { ko: "종이 영수증은 프린터로 따로 출력", en: "Paper receipts print separately" },
    ] },
  { n: { ko: "결제 끝 화면", en: "Payment complete" },
    h: { ko: "번호와 이메일이 미리 채워진다", en: "The phone and email are filled in for you" },
    pic: () => `<div class="er-pay">
      <div class="ok">✓ Payment complete · $47.79</div>
      <label>Text receipt to<span>(905) 555-0101</span></label>
      <label>Email receipt to<span>guest@example.com</span></label>
      <small style="color:var(--muted)">Leave a box blank to skip it.</small>
      <div class="bt"><span class="m">Send</span><span>Print &amp; send</span></div>
    </div>`,
    pts: [
      { ko: "예약에 적힌 번호·이메일을 <b>자동으로 채움</b>", en: "Fills in the phone and email <b>from the booking</b>" },
      { ko: "단말기 카드만 낸 계산서는 승인 문자가 이미 갔으니 번호 칸을 비움", en: "If the bill was paid only by reader card, the phone box stays empty because the approval text already went" },
      { ko: "잘못 보냈거나 다시 달라고 하면 또 보낼 수 있음", en: "It can be sent again after a wrong number or a repeat request" },
    ] },
  { n: { ko: "바뀐 점", en: "What changed" },
    h: { ko: "온라인 영수증과 시뮬레이터 확정 메일이 자동으로", en: "Online receipts and simulator confirmations become automatic" },
    pic: () => `<div class="er-gap">
      <div><b>${T({ ko: "온라인 결제 영수증", en: "Online payment receipts" })} ${svc("g")}</b><small>${T({ ko: "티타임·시뮬레이터·회원권. 승인 후 1분 안에 한 통. STOP 번호여도 이메일로 받음", en: "Tee times, simulator, memberships. One email within a minute. It reaches customers with a STOP number too" })}</small></div>
      <div><b>${T({ ko: "실내 시뮬레이터 확정 메일", en: "Indoor simulator confirmations" })} ${svc("g")}</b><small>${T({ ko: "웹 예약만 해당. 전화·문자·직원 예약은 대상이 아님", en: "Web bookings only. Phone, text and staff bookings are not included" })}</small></div>
      <div><b>${T({ ko: "아직 남은 빈틈", en: "Still open" })}</b><small>${T({ ko: "손으로 입력한 카드는 직원이 보내야 함. 실패한 메일은 다시 보내지 않음", en: "Keyed cards still need staff to send a receipt. A failed email is not retried" })}</small></div>
      <div><b><span class="tag">${T({ ko: "남은 일", en: "One step left" })}</span></b><small>${T({ ko: "코드는 Vercel·Fly에 배포 완료. 운영 DB에서 0140·0141 SQL을 실행해야 메일이 나감", en: "The code is live on Vercel and Fly. Emails start once SQL 0140 and 0141 run on the production database" })}</small></div>
    </div>`,
    pts: [
      { ko: "온라인 손님도 이제 <b>영수증을 받을 길</b>이 생김", en: "Online customers now have <b>a way to get a receipt</b>" },
      { ko: "메일은 번호와 상관없이 감", en: "Email goes out with or without a phone number" },
      { ko: "한 건에 한 통만 가도록 SQL이 막음", en: "SQL keeps it to one email per payment or booking" },
    ] },
];
