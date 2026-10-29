const NARR = __NARR__;
const DUR = __DUR__;
let LANG = "ko";
try { const s = localStorage.getItem("pelham-deck-lang"); if (s === "en" || s === "ko") LANG = s; } catch (e) {}
const T = (o) => (typeof o === "string" ? o : o[LANG]);

const UI = {
  eyebrow: { ko: "전화 비서 · ElevenLabs", en: "Phone assistant · ElevenLabs" },
  title: { ko: "전화가 걸자마자 끊긴 이유", en: "Why calls hung up the moment they connected" },
  sub: { ko: "2026-10-29 · Twilio 기록 + ElevenLabs 통화 기록 + 직접 재현으로 확인", en: "2026-10-29 · confirmed from Twilio logs, ElevenLabs call history and a live repro" },
  play: { ko: "▶ 재생", en: "▶ Play" }, pause: { ko: "❚❚ 멈춤", en: "❚❚ Pause" },
  speed: { ko: "속도", en: "Speed" },
  who: { ko: "나레이션 · Hope (ElevenLabs)", en: "Narration · Hope (ElevenLabs)" },
  pic: { ko: "화면", en: "Picture" }, keys: { ko: "핵심", en: "Key points" },
  foot: { ko: "언제부터 끊겼는지는 ElevenLabs 통화 기록의 첫 Error 날짜로 확인해야 합니다(10-26 웹 Charlie 작업 이후로 추정). 코드 수정은 아직 커밋 전입니다.",
          en: "When it started needs the first Error in ElevenLabs call history (likely after the Oct 26 web Charlie work). The code fix is not committed yet." },
};

const node = (cls, title, sub) => `<div class="ph-node ${cls}"><b>${title}</b><small>${sub}</small></div>`;

const S = [
  { n: { ko: "증상", en: "Symptom" },
    h: { ko: "전화를 걸면 0초 만에 끊긴다", en: "Calls end after 0 seconds" },
    pic: () => `<div class="ph-log">
        <div>Call SID CA6ff8269a…22c6</div>
        <div>From +1 416 822 7609 → To +1 249 805 0556</div>
        <div>Start 06:54:46 PDT · End 06:54:46 PDT</div>
        <div class="bad">Duration 0 sec · Cost $0.00</div>
        <div class="bad">Error 31921 Stream – WebSocket – Close Error</div>
      </div>`,
    pts: [
      { ko: "손님 귀에 아무 소리도 나기 전에 끊김", en: "Hung up before the caller heard anything" },
      { ko: "31921 = 소리를 넘기던 연결을 <b>상대(ElevenLabs)가 닫음</b>", en: "31921 = the audio link was <b>closed by the other side (ElevenLabs)</b>" },
    ] },
  { n: { ko: "길", en: "Path" },
    h: { ko: "전화는 Twilio → ElevenLabs 로 간다", en: "A call goes Twilio → ElevenLabs" },
    pic: () => `<div class="ph-path">
        ${node("ok", T({ ko: "손님 전화", en: "Caller" }), "+1 416 822 7609")}
        ${node("ok", "Twilio", T({ ko: "Active · 잔액 $13.33 · inbound_call 200", en: "Active · $13.33 · inbound_call 200" }))}
        ${node("no", "ElevenLabs", T({ ko: "에이전트가 1초 안에 연결을 닫음", en: "Agent closed the link within 1 s" }))}
        ${node("off", "Fly", T({ ko: "예약 도구 — 여기까지 오지도 못함", en: "Booking tools — never reached" }))}
      </div>`,
    pts: [
      { ko: "Twilio: 돈·번호·연결 모두 정상", en: "Twilio: balance, number and hand-off all fine" },
      { ko: "Fly 서버도 정상 — 문제는 <b>ElevenLabs 에이전트 설정</b>", en: "Fly is fine too — the problem is <b>the ElevenLabs agent setting</b>" },
    ] },
  { n: { ko: "원인", en: "Cause" },
    h: { ko: "첫 인사말이 빈칸 {{greeting}} 이었다", en: "The first message was a blank: {{greeting}}" },
    pic: () => `<div class="ph-box">First message = {{greeting}}</div>
      <div class="eg-two" style="margin-top:12px">
        <div class="eg-card ok"><h4>${T({ ko: "웹 Charlie 버튼", en: "Web Charlie button" })}</h4><pre>greeting = "Hi, I'm Charlie…"</pre>${T({ ko: "값을 보냄 → 인사 → 대화", en: "Sends a value → greets → talks" })}</div>
        <div class="eg-card no"><h4>${T({ ko: "전화 (Twilio)", en: "Phone (Twilio)" })}</h4><pre>greeting = ${T({ ko: "(없음)", en: "(nothing)" })}</pre>${T({ ko: "값 없음 → 바로 끊김", en: "No value → hangs up" })}</div>
      </div>`,
    pts: [
      { ko: "ElevenLabs 기록: <b>Missing required dynamic variables in first message: {'greeting'}</b>", en: "ElevenLabs log: <b>Missing required dynamic variables in first message: {'greeting'}</b>" },
      { ko: "빈칸을 못 채우면 인사를 못 해서 통화를 닫는다", en: "It can't fill the blank, can't greet, so it closes the call" },
    ] },
  { n: { ko: "왜", en: "Why" },
    h: { ko: "웹·전화 인사를 다르게 하려다 생긴 구멍", en: "A gap from giving web and phone different greetings" },
    pic: () => `<div class="ph-steps">
        <div>${T({ ko: "10-26: 웹 Charlie 와 전화가 <b>같은 에이전트</b>를 쓰게 함", en: "Oct 26: web Charlie and the phone share <b>one agent</b>" })}</div>
        <div>${T({ ko: "인사를 다르게 하려고 첫 인사를 <b>{{greeting}} 빈칸</b>으로 바꿈", en: "To greet differently, the first message became <b>the {{greeting}} blank</b>" })}</div>
        <div>${T({ ko: "전화용 문장은 '기본값(placeholder)' 칸에 넣어 둠", en: "The phone sentence went into the 'placeholder' default" })}</div>
        <div class="bad">${T({ ko: "그런데 기본값은 <b>대시보드 시험용</b> — 실제 전화에는 안 채워짐", en: "But placeholders are <b>for dashboard testing only</b> — real calls don't get them" })}</div>
        <div>${T({ ko: "웹으로만 시험해서(값을 보내니 정상) 전화 쪽을 놓침", en: "Only the web was tested (it sends the value), so the phone gap was missed" })}</div>
      </div>`,
    pts: [
      { ko: "제(Claude)가 만든 설정의 실수입니다", en: "This was a mistake in the setup I (Claude) made" },
      { ko: "전화로 다시 걸어 보는 시험을 빠뜨림", en: "I skipped a real phone call test" },
    ] },
  { n: { ko: "재현", en: "Repro" },
    h: { ko: "직접 접속해서 똑같이 끊기는 걸 확인", en: "Reproduced the same hang-up directly" },
    pic: () => `<div class="eg-two">
        <div class="ph-log"><div>${T({ ko: "greeting 보냄", en: "with greeting" })}</div><div class="good">agent_response "Hi" + ${T({ ko: "음성", en: "audio" })}</div></div>
        <div class="ph-log"><div>${T({ ko: "greeting 안 보냄 (= 전화)", en: "without greeting (= phone)" })}</div><div class="bad">1008 policy violation</div><div class="bad">Missing … {'greeting'}</div></div>
      </div>`,
    pts: [
      { ko: "같은 에이전트(agent_6601m3…)에 두 번 접속", en: "Connected twice to the same agent (agent_6601m3…)" },
      { ko: "값만 빠지면 끊긴다 → 원인 확정", en: "Only the missing value makes it drop → cause confirmed" },
      { ko: "ElevenLabs 크레딧·Fly·Twilio 는 원인이 아님", en: "ElevenLabs credits, Fly and Twilio are not the cause" },
    ] },
  { n: { ko: "고치기", en: "Fix" },
    h: { ko: "첫 인사는 전화 문장, 웹은 덮어쓰기", en: "First message = phone sentence; the web overrides it" },
    pic: () => `<div class="ph-box ok">First message = "Thanks for calling Pelham Hills Golf Club. I can book a tee time or a simulator bay, take a food order, or help with a cart or course problem. What can I do for you?"</div>
      <div class="eg-check" style="margin-top:12px">
        <div><span class="tag">${T({ ko: "지금", en: "Now" })}</span><span>${T({ ko: "대시보드 First message 칸 교체 → Publish", en: "Replace the dashboard First message → Publish" })}</span></div>
        <div><span class="tag">${T({ ko: "코드", en: "Code" })}</span><span>${T({ ko: "agent.json · attach 스크립트 · 웹 override (커밋 전)", en: "agent.json · attach script · web override (not committed)" })}</span></div>
      </div>`,
    pts: [
      { ko: "스크립트를 다시 돌려도 {{greeting}} 으로 안 돌아가게 함", en: "Re-running the script no longer brings {{greeting}} back" },
      { ko: "순서: ① 에이전트에 덮어쓰기 허용 → ② 그다음 웹 배포", en: "Order: ① allow the override on the agent → ② then deploy the web" },
      { ko: "순서가 바뀌면 이번엔 웹 Charlie 가 끊김", en: "Reverse the order and web Charlie drops instead" },
    ] },
  { n: { ko: "남은 일", en: "Left" },
    h: { ko: "예약 문자 안 온 것 — 예약이 안 만들어졌을 가능성", en: "No booking text — the booking probably never existed" },
    pic: () => `<div class="ph-path" style="grid-template-columns:repeat(3,minmax(0,1fr))">
        ${node("no", T({ ko: "통화 끊김", en: "Call dropped" }), "0 sec")}
        ${node("off", T({ ko: "예약 확정", en: "Booking confirmed" }), T({ ko: "못 함", en: "never ran" }))}
        ${node("off", T({ ko: "확정 문자", en: "Confirmation text" }), T({ ko: "보낼 게 없음", en: "nothing to send" }))}
      </div>
      <div class="eg-check" style="margin-top:12px">
        <div><span class="tag">${T({ ko: "확인", en: "Check" })}</span><span>${T({ ko: "SQL: pelham_sms_messages 에서 +14168227609", en: "SQL: +14168227609 in pelham_sms_messages" })}</span></div>
        <div><span class="tag">${T({ ko: "시험", en: "Test" })}</span><span>${T({ ko: "고친 뒤 다시 걸어 예약까지 → 문자 오는지", en: "After the fix, call and book → does the text arrive?" })}</span></div>
      </div>`,
    pts: [
      { ko: "확정 문자는 '예약 확정' 뒤에만 나간다", en: "The text goes out only after a booking is confirmed" },
      { ko: "고친 뒤에도 안 오면 SQL 결과의 error 를 봄", en: "If it still doesn't come, read the error in the SQL result" },
    ] },
];
