const NARR = __NARR__;
const DUR = __DUR__;
let LANG = "ko";
try { const s = localStorage.getItem("pelham-deck-lang"); if (s === "en" || s === "ko") LANG = s; } catch (e) {}
const T = (o) => (typeof o === "string" ? o : o[LANG]);

const UI = {
  eyebrow: { ko: "웹사이트 · Book with Charlie", en: "Website · Book with Charlie" },
  title: { ko: "웹 음성 예약이 확정되지 않던 이유와 수정", en: "Why web voice bookings never confirmed, and the fix" },
  sub: { ko: "pelhamhills.com · 2026-10-26 · 브라우저 음성(ElevenLabs 크레딧 소진)", en: "pelhamhills.com · 2026-10-26 · browser voice (ElevenLabs credits used up)" },
  play: { ko: "▶ 재생", en: "▶ Play" }, pause: { ko: "❚❚ 멈춤", en: "❚❚ Pause" },
  speed: { ko: "속도", en: "Speed" }, pitch: { ko: "피치", en: "Pitch" },
  who: { ko: "나레이션 · 브라우저 음성", en: "Narration · browser voice" },
  pic: { ko: "화면", en: "Picture" }, keys: { ko: "핵심", en: "Key points" },
  keyhint: { ko: "한/영 키 또는 L: 언어 · ←/→: 장면 · 스페이스: 재생", en: "Han/Eng key or L: language · ←/→: scene · Space: play" },
  nopitch: { ko: "이 브라우저에서는 피치를 바꿀 수 없습니다", en: "Pitch can't be changed in this browser" },
  foot: { ko: "대화 내용은 2026-10-26 실제 웹 세션 시험 기록입니다. 시험 예약(Test Claudetest, 확인번호 310564)은 바로 취소했습니다.",
          en: "The dialogue is from real web-session tests on 2026-10-26. The test booking (Test Claudetest, code 310564) was cancelled right away." },
};

const step = (tool, what, ok) => `<div class="wc-step ${ok ? "" : "no"}"><code>${tool}</code><span>${T(what)}</span><span class="tag ${ok ? "ok" : "no"}">${ok ? T({ ko: "성공", en: "OK" }) : T({ ko: "거절", en: "Refused" })}</span></div>`;

const S = [
  { n: { ko: "증상", en: "Symptom" },
    h: { ko: "시간은 잡히는데 예약이 안 끝난다", en: "The time gets held, but the booking never finishes" },
    pic: () => `<div class="wc-chat">
      <div class="wc-b"><small>Charlie</small>I've held 8:10 AM on Tuesday, October 27th for you. May I have your first and last name?</div>
      <div class="wc-b me"><small>${T({ ko: "손님", en: "Guest" })}</small>Test Claudetest · 249-805-0556</div>
      <div class="wc-b bad"><small>Charlie</small>I'm very sorry, but the system keeps having trouble processing your booking… I'll connect you to the pro shop now.</div>
      <div class="wc-b bad"><small>Charlie</small>I'm very sorry, but the system is still having trouble…</div>
    </div>`,
    pts: [
      { ko: "이름·전화번호까지 받은 뒤 \"시스템 문제\"를 반복", en: "After name and phone it keeps saying \"system trouble\"" },
      { ko: "그리고 웹에서 할 수 없는 <b>프로샵 연결</b>을 시도", en: "Then it tries a <b>pro shop transfer</b> the website can't do" },
    ] },
  { n: { ko: "시험", en: "Test" },
    h: { ko: "실제 웹 세션을 글자로 끝까지 돌려 봄", en: "Ran a real web session end to end in text" },
    pic: () => `<div class="wc-tl">
      ${step("find_tee_times", { ko: "빈 시간 찾기", en: "Find open times" }, true)}
      ${step("hold_tee_time", { ko: "8:10 AM 자리 잡기(홀드)", en: "Hold 8:10 AM" }, true)}
      ${step("confirm_booking", { ko: "예약 확정 — 1번째", en: "Confirm — try 1" }, false)}
      ${step("confirm_booking", { ko: "예약 확정 — 2·3·4번째", en: "Confirm — tries 2, 3, 4" }, false)}
      ${step("release_hold", { ko: "결국 홀드 풀림", en: "Hold released in the end" }, true)}
    </div>`,
    pts: [
      { ko: "찾기·홀드는 정상, <b>확정만</b> 매번 거절", en: "Find and hold work — <b>only confirm</b> is refused, every time" },
      { ko: "서버 로그: 확정 요청이 DB에 닿기 전에 끝남", en: "Server log: confirm ends before it ever reaches the database" },
    ] },
  { n: { ko: "원인", en: "Cause" },
    h: { ko: "웹에는 발신번호가 없다", en: "The website has no calling number" },
    pic: () => `<div class="wc-two">
      <div class="wc-card ok"><h4>📞 ${T({ ko: "전화", en: "Phone" })}</h4><pre>caller_number: "+19058921234"</pre><span>${T({ ko: "전화선이 번호를 채워 줌", en: "The phone line fills the number" })}</span></div>
      <div class="wc-card no"><h4>🌐 ${T({ ko: "웹사이트", en: "Website" })}</h4><pre>caller_number: null</pre><div class="wc-err">422 · Some details were missing or not understood (caller_number). Ask the caller for them again…</div></div>
    </div>`,
    pts: [
      { ko: "웹에선 <span class=\"code\">system__caller_id</span> 가 비어 null 로 옴", en: "On the web <span class=\"code\">system__caller_id</span> is empty, so it arrives as null" },
      { ko: "서버가 \"글자여야 한다\"며 거절 → 손님이 고칠 수 없는 칸", en: "Server refuses it as \"not text\" — a field the guest can't fix" },
      { ko: "확정·콜백·음식 주문 등 이 칸이 있는 도구만 실패", en: "Only tools with this field failed: confirm, callback, food order…" },
    ] },
  { n: { ko: "수정 1", en: "Fix 1" },
    h: { ko: "빈 발신번호는 빈 값으로 받는다", en: "A missing caller ID is taken as blank" },
    pic: () => `<div class="wc-two">
      <div class="wc-card"><h4>${T({ ko: "모든 음성 도구 공통 입구", en: "Shared entry for every voice tool" })}</h4><pre>null                  → ""
"{{system__caller_id}}" → ""
"+19058921234"          → ${T({ ko: "그대로", en: "unchanged" })}</pre><span>${T({ ko: "번호는 손님이 말한 전화번호를 씀", en: "Booking uses the number the guest says" })}</span></div>
      <div class="wc-card ok"><h4>${T({ ko: "테스트", en: "Tests" })}</h4><span><span class="tag no">${T({ ko: "수정 전", en: "Before" })}</span> ${T({ ko: "새 테스트 실패(같은 422)", en: "New test fails (same 422)" })}</span><span><span class="tag ok">${T({ ko: "수정 후", en: "After" })}</span> 134 passed</span><span class="code">f4f5a9a</span></div>
    </div>`,
    pts: [
      { ko: "<span class=\"code\">backend/api/routes/voice.py</span> 한 곳", en: "One place: <span class=\"code\">backend/api/routes/voice.py</span>" },
      { ko: "전화 예약은 영향 없음(번호가 있으면 그대로)", en: "Phone bookings unaffected (a real number passes through)" },
    ] },
  { n: { ko: "수정 2", en: "Fix 2" },
    h: { ko: "웹 Charlie 는 프로샵 연결 안 함", en: "Web Charlie never transfers to the pro shop" },
    pic: () => `<div class="wc-two">
      <div class="wc-card no"><h4>${T({ ko: "예전", en: "Before" })}</h4><s>I'll connect you to the pro shop now, please stay on the line.</s><s>${T({ ko: "프로샵 번호 안내", en: "Reads out the pro shop number" })}</s></div>
      <div class="wc-card ok"><h4>${T({ ko: "이제", en: "Now" })}</h4><span>${T({ ko: "연결·번호 안내 금지", en: "No transfer, no pro shop number" })}</span><span>${T({ ko: "직접 못 하는 일 → 콜백 요청(request_callback)", en: "Anything it can't do → callback request (request_callback)" })}</span><span class="code">b98955b</span></div>
    </div>`,
    pts: [
      { ko: "기본 안내문 + 대시보드 워크플로 두 단계에 같은 규칙", en: "Same rule in the main prompt and two dashboard workflow steps" },
      { ko: "전화(📞) 손님은 지금처럼 연결 가능", en: "Phone callers can still be transferred as before" },
    ] },
  { n: { ko: "확인", en: "Verified" },
    h: { ko: "배포 후 웹 예약 확정 성공", en: "After deploy, a web booking confirms" },
    pic: () => `<div class="wc-tl">
      ${step("hold_tee_time", { ko: "8:10 AM · 2명 · 카트", en: "8:10 AM · 2 players · cart" }, true)}
      ${step("confirm_booking", { ko: "확인번호 3-1-0-5-6-4 · 확인 문자 발송", en: "Code 3-1-0-5-6-4 · confirmation text sent" }, true)}
      ${step("cancel_booking", { ko: "시험 예약 바로 취소(미리보기 → 취소)", en: "Test booking cancelled (preview → cancel)" }, true)}
    </div>`,
    pts: [
      { ko: "push·Fly 배포 완료 → 실제 웹 세션으로 확인", en: "Pushed and deployed to Fly → checked with a real web session" },
      { ko: "시험 예약은 남아 있지 않음", en: "No test booking left on the sheet" },
    ] },
  { n: { ko: "상태", en: "Status" },
    h: { ko: "남은 일 하나 · 다음 개선", en: "One step left · next improvement" },
    pic: () => `<div class="gc-check">
      <div><span class="tag ok">${T({ ko: "완료", en: "Done" })}</span><span>${T({ ko: "확정 오류 수정 · push · Fly 배포 · 실제 확인", en: "Confirm fix · push · Fly deploy · live check" })}</span></div>
      <div><span class="tag">${T({ ko: "남음", en: "To do" })}</span><span>${T({ ko: "프로샵 연결 금지 규칙을 Charlie 에 적용(attach --apply) — 자동 모드가 막음, 승인 필요", en: "Apply the no-transfer rule to Charlie (attach --apply) — blocked by auto mode, needs approval" })}</span></div>
      <div><span class="tag">${T({ ko: "다음", en: "Next" })}</span><span>${T({ ko: "대시보드 워크플로가 회원 질문을 건너뛰고 질문 순서가 매번 다름", en: "Dashboard workflow skips the member question; order changes each time" })}</span></div>
    </div>`,
    pts: [
      { ko: "적용 전까지 웹 Charlie 가 아직 프로샵 연결을 말할 수 있음", en: "Until applied, web Charlie may still offer a pro shop transfer" },
      { ko: "예약 확정 자체는 지금 정상", en: "Booking confirmation itself works now" },
    ] },
];
