const NARR = __NARR__;
const DUR = __DUR__;
let LANG = "ko";
try { const s = localStorage.getItem("pelham-deck-lang"); if (s === "en" || s === "ko") LANG = s; } catch (e) {}
const T = (o) => (typeof o === "string" ? o : o[LANG]);

const UI = {
  eyebrow: { ko: "Supabase · 전송량(Egress)", en: "Supabase · Egress" },
  title: { ko: "Supabase 전송량 폭증, 줄이는 전략", en: "Supabase egress spike: how to cut it" },
  sub: { ko: "2026-10-28 · 사용량 화면 + API 로그 + 티 시트 코드로 확인 · 아직 코드는 안 바꿈", en: "2026-10-28 · from the Usage page, API logs and tee sheet code · no code changed yet" },
  play: { ko: "▶ 재생", en: "▶ Play" }, pause: { ko: "❚❚ 멈춤", en: "❚❚ Pause" },
  speed: { ko: "속도", en: "Speed" }, pitch: { ko: "피치", en: "Pitch" },
  who: { ko: "나레이션 · Hope (ElevenLabs)", en: "Narration · Hope (ElevenLabs)" },
  pic: { ko: "화면", en: "Picture" }, keys: { ko: "핵심", en: "Key points" },
  keyhint: { ko: "한/영 키 또는 L: 언어 · ←/→: 장면 · 스페이스: 재생", en: "Han/Eng key or L: language · ←/→: scene · Space: play" },
  nopitch: { ko: "이 브라우저에서는 피치를 바꿀 수 없습니다", en: "Pitch can't be changed in this browser" },
  foot: { ko: "호출 수는 Supabase API 로그(최근 7일)에서, 1회당 약 100 KB 는 호출 수와 Egress 를 맞대어 낸 추정입니다. 효과 수치도 추정입니다.",
          en: "Call counts come from Supabase API logs (last 7 days); ~100 KB per call is estimated by matching calls to egress. Savings are estimates too." },
};

const row = (label, val, max, txt, cls) =>
  `<div class="eg-row ${cls || ""}"><code>${label}</code><div class="eg-track"><i style="width:${Math.max(1, Math.round((val / max) * 100))}%"></i></div><b>${txt}</b></div>`;
const ticks = (n, on, ok) => `<div class="eg-tick ${ok ? "ok" : ""}">${Array.from({ length: n }, (_, k) => `<i class="${k < on ? "" : "off"}"></i>`).join("")}</div>`;

const S = [
  { n: { ko: "현황", en: "Now" },
    h: { ko: "한도의 2.3배 — 저장량이 아니라 전송량", en: "2.3× the limit — transfer, not storage" },
    pic: () => `<div class="eg-big"><b>11.45 GB</b><span>${T({ ko: "Egress · 10/7–11/7 · Free 한도 5 GB", en: "Egress · Oct 7–Nov 7 · Free limit 5 GB" })}</span></div>
      <div class="eg-meter"><i style="width:100%"></i><em style="left:43.7%"></em><small style="left:43.7%">5 GB</small></div>
      <div class="eg-bars">
        <div class="eg-cap">${T({ ko: "하루 Egress (사용량 그래프에서 읽은 날)", en: "Daily egress (days read off the usage graph)" })}</div>
        ${row("10/17", 0.01, 2.27, "≈0")}
        ${row("10/20", 0.72, 2.27, "0.72 GB")}
        ${row("10/23", 2.27, 2.27, "2.27 GB", "hot")}
        ${row("10/27", 0.48, 2.27, "0.48 GB")}
      </div>`,
    pts: [
      { ko: "DB 크기 112 MB(22%) · 저장소 0 — <b>저장은 문제 아님</b>", en: "DB 112 MB (22%) · storage 0 — <b>storage is fine</b>" },
      { ko: "10/18부터 급증, 최고 10/23 하루 2.27 GB", en: "Jumped from Oct 18, peak 2.27 GB on Oct 23" },
      { ko: "10/28 Pro 결제($28.25) → 차단 풀림, 월 250 GB", en: "Paid Pro on Oct 28 ($28.25) → unblocked, 250 GB/month" },
    ] },
  { n: { ko: "범인", en: "Culprit" },
    h: { ko: "직원 티 시트가 예약을 하루 19,186번 읽었다", en: "The staff tee sheet read bookings 19,186 times a day" },
    pic: () => `<div class="eg-bars" style="margin-top:0">
        <div class="eg-cap">${T({ ko: "10/23 API 호출 수 (최고일)", en: "API calls on Oct 23 (peak day)" })}</div>
        ${row("staff_bookings", 19186, 19186, "19,186", "hot")}
        ${row("tee_bookings", 2854, 19186, "2,854")}
        ${row("payment_texts", 1451, 19186, "1,451")}
        ${row("tee_waitlist", 1427, 19186, "1,427")}
        ${row("booking_texts", 1416, 19186, "1,416")}
        ${row("staff_slots", 805, 19186, "805")}
        ${row("lost_items", 770, 19186, "770")}
      </div>`,
    pts: [
      { ko: "<span class=\"code\">pelham_staff_bookings</span> · Chrome(직원 화면)", en: "<span class=\"code\">pelham_staff_bookings</span> · Chrome (staff screen)" },
      { ko: "호출 수와 Egress 가 같이 오르내림 → 1회 약 100 KB", en: "Calls and egress move together → ~100 KB per call" },
      { ko: "나머지(Fly 서버 1분 폴링)는 응답이 거의 비어 작음", en: "The rest (Fly server, 1-min polls) return almost nothing" },
    ] },
  { n: { ko: "이유", en: "Why" },
    h: { ko: "5초마다 일주일치 예약을 통째로", en: "A whole week of bookings, every 5 seconds" },
    pic: () => `<div class="eg-two">
      <div class="eg-card no"><h4>/teesheet · useTeeSheet({ live: true })</h4><pre>POLL_INTERVAL_MS = 5000
listBookings({ from: anchor,
  to: addDays(anchor, 6) })   // 7${T({ ko: "일", en: " days" })}</pre>
        <span>${T({ ko: "1분에 12번 — 바뀐 게 없어도", en: "12 times a minute — even with no change" })}</span>${ticks(12, 12)}</div>
      <div class="eg-card"><h4>${T({ ko: "곱해지는 것", en: "What multiplies it" })}</h4>
        <span>➕ ${T({ ko: "비교 시트(10/21 추가)를 열면 폴링 <b>2배</b>", en: "Second sheet (added Oct 21) <b>doubles</b> the polling" })}</span>
        <span>➕ ${T({ ko: "PC·탭마다 따로", en: "Each PC and tab polls on its own" })}</span>
        <span>➕ ${T({ ko: "예약이 쌓일수록 한 번 크기↑", en: "More bookings → bigger each time" })}</span>
        <span>✓ ${T({ ko: "탭을 숨기면 멈춤 — 하지만 프런트 PC는 늘 켜져 있음", en: "Pauses when the tab is hidden — but the front PC is always on it" })}</span></div>
    </div>
    <div class="eg-math">${T({ ko: "화면 1개 × 12시간 = 8,640회 × 100 KB ≈ 0.86 GB/일", en: "1 screen × 12 h = 8,640 calls × 100 KB ≈ 0.86 GB/day" })}</div>`,
    pts: [
      { ko: "<span class=\"code\">frontend/hooks/useTeeSheet.ts</span> · 9/30부터 5초", en: "<span class=\"code\">frontend/hooks/useTeeSheet.ts</span> · 5 s since Sep 30" },
      { ko: "19,186회 ≈ 화면 2개가 하루 종일 열린 셈", en: "19,186 calls ≈ two screens open all day" },
    ] },
  { n: { ko: "전략", en: "Levers" },
    h: { ko: "줄이는 손잡이 넷", en: "Four levers" },
    pic: () => `<div class="eg-levers">
      <div class="eg-lv pick"><span class="tag ok">${T({ ko: "1단계", en: "Step 1" })}</span><b>${T({ ko: "① 덜 자주", en: "① Less often" })}</b><small>${T({ ko: "5초 → 30초, 손 안 대면 60초", en: "5 s → 30 s, 60 s when idle" })}</small><span>${T({ ko: "효과 큼 · 작업 아주 작음", en: "Big effect · tiny change" })}</span></div>
      <div class="eg-lv pick"><span class="tag ok">${T({ ko: "2단계", en: "Step 2" })}</span><b>${T({ ko: "② 바뀐 것만", en: "② Only on change" })}</b><small>${T({ ko: "작은 \"변경 도장\"을 먼저 묻기", en: "Ask for a tiny \"change stamp\" first" })}</small><span>${T({ ko: "효과 가장 큼 · SQL 1개 + 화면", en: "Biggest effect · 1 SQL + screen" })}</span></div>
      <div class="eg-lv"><span class="tag">${T({ ko: "선택", en: "Optional" })}</span><b>${T({ ko: "③ 덜 많이", en: "③ Less data" })}</b><small>${T({ ko: "보이는 날만 · 격자에 쓰는 칸만", en: "Visible day only · only grid fields" })}</small><span>${T({ ko: "효과 중간 · 화면 여러 곳 손봄", en: "Medium effect · touches several screens" })}</span></div>
      <div class="eg-lv"><span class="tag">${T({ ko: "나중", en: "Later" })}</span><b>${T({ ko: "④ 밀어주기", en: "④ Push" })}</b><small>${T({ ko: "Supabase Realtime 으로 바뀔 때만 알림", en: "Supabase Realtime notifies only on change" })}</small><span>${T({ ko: "폴링 0 · 연결·인증 작업 큼", en: "Zero polling · big connection/auth work" })}</span></div>
    </div>`,
    pts: [
      { ko: "추천: <b>①+②를 함께</b> — 하루 안에 끝나는 크기", en: "Recommended: <b>① + ② together</b> — a one-day job" },
      { ko: "③④는 ①②로 부족할 때만", en: "③ ④ only if ① ② aren't enough" },
    ] },
  { n: { ko: "1단계", en: "Step 1" },
    h: { ko: "덜 자주 읽기", en: "Read less often" },
    pic: () => `<div class="eg-two">
      <div class="eg-card no"><h4>${T({ ko: "지금 · 1분", en: "Now · 1 minute" })}</h4>${ticks(12, 12)}<span>${T({ ko: "12번", en: "12 calls" })}</span></div>
      <div class="eg-card ok"><h4>${T({ ko: "바꾼 뒤 · 1분", en: "After · 1 minute" })}</h4>${ticks(12, 2, true)}<span>${T({ ko: "2번 (손 안 대면 1번)", en: "2 calls (1 when idle)" })}</span></div>
    </div>
    <div class="eg-card"><h4>${T({ ko: "그대로 빠른 것", en: "Still instant" })}</h4>
      <span>✓ ${T({ ko: "내가 저장·결제하면 내 화면은 바로 다시 읽음(이미 있는 pollNow)", en: "My own save or payment refreshes my screen right away (existing pollNow)" })}</span>
      <span>✓ ${T({ ko: "탭으로 돌아오면 바로 읽음", en: "Coming back to the tab reads immediately" })}</span>
      <span>△ ${T({ ko: "다른 PC·전화·웹 예약은 최대 30초 늦게 보임", en: "Other PCs, phone and web bookings show up to 30 s later" })}</span></div>`,
    pts: [
      { ko: "숫자 하나 + 손 안 댐 감지 — 화면 1곳", en: "One number + idle detection — one file" },
      { ko: "예상 <b>약 −83%</b> (2.27 → 0.38 GB/일)", en: "Expected <b>about −83%</b> (2.27 → 0.38 GB/day)" },
    ] },
  { n: { ko: "2단계", en: "Step 2" },
    h: { ko: "바뀌었을 때만 통째로", en: "Full reload only when something changed" },
    pic: () => `<div class="eg-two">
      <div class="eg-card"><h4>${T({ ko: "5초마다 — 작은 질문", en: "Every 5 s — a tiny question" })}</h4><pre>pelham_staff_bookings_stamp(from, to)
→ { "n": 214,
    "at": "2026-10-28T14:02:11Z" }
≈ 0.1 KB</pre></div>
      <div class="eg-card ok"><h4>${T({ ko: "도장이 바뀐 때만", en: "Only when the stamp changes" })}</h4><pre>pelham_staff_bookings(from, to)
→ [ …${T({ ko: "일주일치", en: "a week" })}… ]
≈ 100 KB</pre></div>
    </div>
    <div class="eg-card"><h4>${T({ ko: "도장에 넣을 것", en: "What goes in the stamp" })}</h4>
      <span>${T({ ko: "예약 수 · 가장 늦은 updated_at · 가장 이른 홀드 만료 시각", en: "Booking count · latest updated_at · earliest hold expiry" })}</span>
      <span class="eg-cap">${T({ ko: "홀드는 시간이 지나면 저절로 사라지므로 만료 시각도 넣어야 놓치지 않음", en: "Holds vanish on their own as time passes, so the expiry time must be in it too" })}</span></div>`,
    pts: [
      { ko: "5초 반응은 그대로, 내려받는 양만 줄어듦", en: "Keeps the 5-second feel, only the download shrinks" },
      { ko: "새 SQL 1개(읽기 전용 함수) + useTeeSheet 수정", en: "One new SQL (read-only function) + useTeeSheet change" },
      { ko: "①과 함께면 예상 <b>−98% 이상</b>", en: "With ①, expected <b>−98% or more</b>" },
    ] },
  { n: { ko: "그 밖", en: "Others" },
    h: { ko: "같이 보면 좋은 곳, 손대지 않을 곳", en: "Worth a look, and what to leave alone" },
    pic: () => `<div class="eg-check">
      <div><span class="tag ok">${T({ ko: "같이", en: "With it" })}</span><span>${T({ ko: "비교 시트: 왼쪽과 같은 주면 왼쪽 결과를 나눠 쓰기(두 번 안 읽기)", en: "Second sheet: if it shows the same week as the left, share the left's result (no double read)" })}</span></div>
      <div><span class="tag ok">${T({ ko: "같이", en: "With it" })}</span><span>${T({ ko: "스타터 화면(15초 폴링)·시작 시 60일치 읽기도 같은 도장 적용", en: "Starter screen (15 s poll) and its 60-day read get the same stamp" })}</span></div>
      <div><span class="tag">${T({ ko: "그대로", en: "Leave" })}</span><span>${T({ ko: "Fly 서버 워커(문자·대기자·분실물) 1분 폴링 — 응답이 거의 비어 작음", en: "Fly workers (texts, waitlist, lost items) 1-min polls — near-empty responses" })}</span></div>
      <div><span class="tag">${T({ ko: "감시", en: "Watch" })}</span><span>${T({ ko: "Spend cap 켜 둠 · 주 1회 Usage 의 Egress 확인", en: "Keep spend cap on · check Usage → Egress weekly" })}</span></div>
    </div>`,
    pts: [
      { ko: "가장 큰 한 곳(티 시트)만 고쳐도 대부분 해결", en: "Fixing the one big spot (tee sheet) solves most of it" },
      { ko: "Pro 250 GB 로도 지금 여유는 있음 — 서두를 일은 아님", en: "Pro's 250 GB already leaves room — not an emergency" },
    ] },
  { n: { ko: "효과", en: "Result" },
    h: { ko: "하루 2.27 GB → 약 0.04 GB (추정)", en: "2.27 GB/day → about 0.04 GB (estimate)" },
    pic: () => `<div class="eg-bars" style="margin-top:0">
        <div class="eg-cap">${T({ ko: "최고일(10/23) 기준 하루 Egress", en: "Daily egress based on the peak day (Oct 23)" })}</div>
        ${row(T({ ko: "지금", en: "Now" }), 2.27, 2.27, "2.27 GB", "hot")}
        ${row(T({ ko: "①만", en: "① only" }), 0.38, 2.27, "0.38 GB")}
        ${row("① + ②", 0.04, 2.27, "≈0.04 GB", "good")}
      </div>
      <div class="eg-check" style="margin-top:12px">
        <div><span class="tag ok">${T({ ko: "완료", en: "Done" })}</span><span>${T({ ko: "Pro 결제 · 차단 해제 · 원인 찾기", en: "Pro paid · unblocked · cause found" })}</span></div>
        <div><span class="tag">${T({ ko: "결정", en: "Decide" })}</span><span>${T({ ko: "①+② 진행할지 — 승인하시면 코드 + SQL 1개 준비", en: "Go ahead with ① + ②? On your OK: code + one SQL" })}</span></div>
      </div>`,
    pts: [
      { ko: "한 달 약 70 GB(최악) → 약 1–2 GB", en: "About 70 GB/month (worst case) → about 1–2 GB" },
      { ko: "Free 5 GB 안으로도 돌아올 수 있는 수준", en: "Low enough to fit even the Free 5 GB again" },
    ] },
];
