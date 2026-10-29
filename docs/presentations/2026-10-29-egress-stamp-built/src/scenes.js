const NARR = __NARR__;
const DUR = __DUR__;
let LANG = "ko";
try { const s = localStorage.getItem("pelham-deck-lang"); if (s === "en" || s === "ko") LANG = s; } catch (e) {}
const T = (o) => (typeof o === "string" ? o : o[LANG]);

const UI = {
  eyebrow: { ko: "Supabase · 전송량 줄이기 · 적용 완료", en: "Supabase · cutting egress · built" },
  title: { ko: "변경 도장 폴링 — 바뀌었을 때만 받는다", en: "Change-stamp polling — fetch only when something changed" },
  sub: { ko: "2026-10-29 · 커밋 2bbf387 · Vercel 배포됨 · SQL 0134 붙여 넣기 남음", en: "2026-10-29 · commit 2bbf387 · deployed on Vercel · SQL 0134 still to paste" },
  play: { ko: "▶ 재생", en: "▶ Play" }, pause: { ko: "❚❚ 멈춤", en: "❚❚ Pause" },
  speed: { ko: "속도", en: "Speed" }, pitch: { ko: "피치", en: "Pitch" },
  who: { ko: "나레이션 · Hope (ElevenLabs)", en: "Narration · Hope (ElevenLabs)" },
  pic: { ko: "화면", en: "Picture" }, keys: { ko: "핵심", en: "Key points" },
  keyhint: { ko: "한/영 키 또는 L: 언어 · ←/→: 장면 · 스페이스: 재생", en: "Han/Eng key or L: language · ←/→: scene · Space: play" },
  nopitch: { ko: "이 브라우저에서는 피치를 바꿀 수 없습니다", en: "Pitch can't be changed in this browser" },
  foot: { ko: "효과 수치는 10/23 API 로그와 Egress 로 낸 추정입니다. 실제 티 시트 화면 시험과 SQL 실행은 아직입니다.",
          en: "Savings are estimates from the Oct 23 API logs and egress. Not yet tested on the live tee sheet; the SQL hasn't been run." },
};

const row = (label, val, max, txt, cls) =>
  `<div class="eg-row ${cls || ""}"><code>${label}</code><div class="eg-track"><i style="width:${Math.max(1, Math.round((val / max) * 100))}%"></i></div><b>${txt}</b></div>`;
const st = (n, body, tail, cls) => `<div class="st-step ${cls || ""}"><i>${n}</i><span>${body}</span><span>${tail || ""}</span></div>`;

const S = [
  { n: { ko: "요약", en: "Summary" },
    h: { ko: "1분 동안 내려받는 양", en: "What one screen downloads per minute" },
    pic: () => `<div class="eg-bars" style="margin-top:0">
        <div class="eg-cap">${T({ ko: "티 시트 화면 1개, 아무것도 안 바뀐 1분", en: "One tee sheet screen, a minute with no changes" })}</div>
        ${row(T({ ko: "예전", en: "Before" }), 1200, 1200, "≈1,200 KB", "hot")}
        ${row(T({ ko: "SQL 전", en: "Before SQL" }), 200, 1200, "≈200 KB")}
        ${row(T({ ko: "SQL 후", en: "After SQL" }), 2, 1200, "≈2 KB", "good")}
      </div>
      <div class="eg-two" style="margin-top:12px">
        <div class="eg-card no"><h4>${T({ ko: "예전", en: "Before" })}</h4><span>${T({ ko: "5초마다 일주일치 100 KB × 12번", en: "A week, 100 KB, every 5 s × 12" })}</span></div>
        <div class="eg-card ok"><h4>${T({ ko: "이제", en: "Now" })}</h4><span>${T({ ko: "5초마다 32자 도장 × 12번, 바뀐 때만 100 KB", en: "A 32-char stamp every 5 s × 12; 100 KB only on change" })}</span></div>
      </div>`,
    pts: [
      { ko: "티 시트·스타터 화면 두 곳을 바꿈", en: "Changed two screens: tee sheet and starter" },
      { ko: "커밋 <span class=\"code\">2bbf387</span> · Vercel 배포 완료", en: "Commit <span class=\"code\">2bbf387</span> · deployed on Vercel" },
      { ko: "SQL 0134 를 붙이면 끝까지 줄어듦", en: "Pasting SQL 0134 gets the full cut" },
    ] },
  { n: { ko: "흐름", en: "Flow" },
    h: { ko: "5초마다 묻는 순서", en: "What happens every 5 seconds" },
    pic: () => `<div class="st-flow">
        ${st("1", T({ ko: "\"이번 주 예약 바뀌었어?\" — 도장 묻기", en: "\"Did this week change?\" — ask for the stamp" }), "<code>bookings_stamp</code>")}
        ${st("2", T({ ko: "Supabase 가 32자 돌려줌", en: "Supabase returns 32 characters" }), "<code>9f3c…a1</code>")}
      </div>
      <div class="st-fork" style="margin-top:8px">
        <div class="eg-card ok"><h4>${T({ ko: "지난번과 같음", en: "Same as last time" })}</h4><span>${T({ ko: "끝. 아무것도 안 받음", en: "Done. Nothing downloaded" })}</span><span class="eg-cap">${T({ ko: "대부분의 5초가 여기", en: "Most 5-second ticks end here" })}</span></div>
        <div class="eg-card no"><h4>${T({ ko: "다름", en: "Different" })}</h4><span>${T({ ko: "일주일치 목록을 받아 화면 갱신, 새 도장 기억", en: "Fetch the week, refresh the screen, remember the new stamp" })}</span></div>
      </div>`,
    pts: [
      { ko: "반응 속도는 그대로 5초", en: "Still reacts within 5 seconds" },
      { ko: "목록 받기는 예약이 실제로 바뀐 때만", en: "The list is fetched only when bookings really changed" },
    ] },
  { n: { ko: "정확성", en: "Accuracy" },
    h: { ko: "왜 하나도 놓치지 않나", en: "Why nothing gets missed" },
    pic: () => `<div class="eg-two">
      <div class="eg-card ok"><h4>${T({ ko: "도장 = 받을 목록 그 자체의 요약", en: "Stamp = a digest of the exact list" })}</h4><pre>md5( pelham_staff_bookings(from, to) )</pre>
        <span>${T({ ko: "예약·선수·결제 무엇이 바뀌어도 도장이 바뀜", en: "Any booking, player or payment change changes it" })}</span>
        <span>${T({ ko: "홀드가 시간이 지나 사라져도 바뀜", en: "Changes when a hold expires on its own, too" })}</span></div>
      <div class="eg-card"><h4>${T({ ko: "순서: 도장 먼저, 목록 나중", en: "Order: stamp first, list second" })}</h4>
        <span>${T({ ko: "기억하는 도장은 늘 목록보다 같거나 오래됨", en: "The saved stamp is never newer than the list" })}</span>
        <span>${T({ ko: "그 사이 바뀐 건 다음 5초에 다시 받음", en: "Anything changed in between is fetched on the next tick" })}</span>
        <span>${T({ ko: "응답 없는 저장 뒤엔 도장 무시하고 바로 받음", en: "After an unconfirmed save it fetches right away, stamp or not" })}</span></div>
    </div>`,
    pts: [
      { ko: "<span class=\"code\">updated_at</span> 같은 칸에 기대지 않음", en: "Doesn't rely on a column like <span class=\"code\">updated_at</span>" },
      { ko: "서버 계산은 예전과 같고, 밖으로 나가는 것만 32자", en: "Server work is the same; only 32 chars go out" },
    ] },
  { n: { ko: "손 안 댐", en: "Idle" },
    h: { ko: "아무도 안 만지면 천천히", en: "Slower when nobody is using it" },
    pic: () => `<div class="st-time">
        <div class="on"><small>${T({ ko: "사용 중", en: "In use" })}</small><b>5${T({ ko: "초", en: " s" })}</b><span>${T({ ko: "도장 묻기", en: "stamp check" })}</span></div>
        <div><small>${T({ ko: "2분 손 안 댐", en: "2 min idle" })}</small><b>30${T({ ko: "초", en: " s" })}</b><span>${T({ ko: "도장 묻기", en: "stamp check" })}</span></div>
        <div class="on"><small>${T({ ko: "다시 터치", en: "Touch again" })}</small><b>${T({ ko: "즉시", en: "now" })}</b><span>${T({ ko: "바로 한 번", en: "one check" })}</span></div>
        <div class="off"><small>${T({ ko: "탭 숨김", en: "Tab hidden" })}</small><b>${T({ ko: "멈춤", en: "paused" })}</b><span>${T({ ko: "예전과 같음", en: "as before" })}</span></div>
      </div>`,
    pts: [
      { ko: "마우스 클릭·키보드·휠·터치를 \"사용\"으로 봄", en: "Clicks, keys, wheel and touch count as use" },
      { ko: "점심·밤 시간에 켜 둔 PC가 덜 묻게 됨", en: "PCs left on over lunch or overnight ask far less" },
    ] },
  { n: { ko: "스타터", en: "Starter" },
    h: { ko: "스타터 화면도 같은 방식", en: "Starter screen works the same way" },
    pic: () => `<div class="st-flow">
        ${st("15s", T({ ko: "그날 예약의 도장 묻기", en: "Ask for that day's stamp" }), "<code>{ date }</code>", "ok")}
        ${st("Δ", T({ ko: "바뀌었을 때만 슬롯 + 예약 다시 읽기", en: "Re-read slots + bookings only on change" }), "")}
        ${st("5m", T({ ko: "5분마다 한 번은 통째로 — 첫 티·잠긴 칸은 도장에 안 들어가서", en: "Full read every 5 min — first tee and locked slots aren't in the stamp" }), "")}
      </div>`,
    pts: [
      { ko: "예전: 15초마다 슬롯 + 하루치 예약 통째로", en: "Before: slots + the whole day every 15 s" },
      { ko: "<span class=\"code\">StarterTeeSheet.tsx</span>", en: "<span class=\"code\">StarterTeeSheet.tsx</span>" },
    ] },
  { n: { ko: "SQL", en: "SQL" },
    h: { ko: "SQL 0134 전과 후", en: "Before and after SQL 0134" },
    pic: () => `<div class="eg-two">
      <div class="eg-card"><h4>${T({ ko: "지금 (SQL 전)", en: "Now (before SQL)" })}</h4><span>${T({ ko: "도장 함수가 없어 404 → 안전하게 물러남", en: "Stamp function missing → 404 → safe fallback" })}</span><span>${T({ ko: "티 시트: 30초마다 통째로 (손 안 대면 60초)", en: "Tee sheet: full read every 30 s (60 s idle)" })}</span><span>${T({ ko: "스타터: 60초마다 통째로", en: "Starter: full read every 60 s" })}</span><b>${T({ ko: "약 −80%", en: "about −80%" })}</b></div>
      <div class="eg-card ok"><h4>${T({ ko: "SQL 붙인 뒤", en: "After pasting SQL" })}</h4><pre>pelham_staff_bookings_stamp(from, to)
→ md5 · 32${T({ ko: "자", en: " chars" })}</pre><span>${T({ ko: "화면 새로고침 필요 없음 — 다음 탭 열기부터 도장 사용", en: "Screens pick it up the next time the page loads" })}</span><b>${T({ ko: "약 −98%", en: "about −98%" })}</b></div>
    </div>`,
    pts: [
      { ko: "SQL editor 에 파일 전체 붙여 한 번 · 다시 실행해도 안전", en: "Paste the whole file once in the SQL editor · safe to re-run" },
      { ko: "확인 줄: <span class=\"code\">staff_can_call = true</span>", en: "Check row: <span class=\"code\">staff_can_call = true</span>" },
    ] },
  { n: { ko: "상태", en: "Status" },
    h: { ko: "남은 일과 확인 방법", en: "What's left and how to check" },
    pic: () => `<div class="eg-check">
      <div><span class="tag ok">${T({ ko: "완료", en: "Done" })}</span><span>${T({ ko: "티 시트·스타터 변경 · 린트 통과 · push · Vercel 배포", en: "Tee sheet + starter change · lint passed · pushed · Vercel deployed" })}</span></div>
      <div><span class="tag">${T({ ko: "할 일", en: "To do" })}</span><span>${T({ ko: "SQL 0134 붙여 넣기 (Supabase SQL editor)", en: "Paste SQL 0134 (Supabase SQL editor)" })}</span></div>
      <div><span class="tag">${T({ ko: "확인", en: "Check" })}</span><span>${T({ ko: "다른 PC에서 예약을 바꾸면 5초 안에 보이는지", en: "A booking changed on another PC shows within 5 s" })}</span></div>
      <div><span class="tag">${T({ ko: "확인", en: "Check" })}</span><span>${T({ ko: "하루 뒤 Usage 의 Egress 가 하루 약 0.05 GB 인지", en: "A day later, Usage → Egress is about 0.05 GB/day" })}</span></div>
    </div>`,
    pts: [
      { ko: "실제 티 시트 화면 시험은 아직 — SQL 뒤에 함께", en: "Not yet tested on the live tee sheet — do it after the SQL" },
      { ko: "이상하면 알려 주세요: 화면이 늦게 바뀌는 등", en: "Tell me if anything's off, like slow updates" },
    ] },
];
