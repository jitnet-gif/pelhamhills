const $ = (id) => document.getElementById(id);
const audio = $("audio");
let cur = 0, playing = false, timer = null;

// 속도·피치는 AI 매니저(StrategyDeck)와 같은 열쇠·모양으로 기억한다: {tone, speed, pitch}.
// 소리는 ElevenLabs Hope 가 natural · 1× 로 미리 만든 것이고, 속도는 <audio> 재생 속도(음높이 유지),
// 피치는 Web Audio 피치 시프터(반음 ±4)가 바꾼다.
const VOICE_KEY = "pelham-narration-voice";
let voice = { tone: "natural", speed: 1, pitch: 0 };
try { const v = JSON.parse(localStorage.getItem(VOICE_KEY) || "null"); if (v) voice = { ...voice, ...v }; } catch (e) {}
$("speed").value = String(voice.speed); if (!$("speed").value) $("speed").value = "1";
$("pitch").value = String(voice.pitch); if (!$("pitch").value) $("pitch").value = "0";
function saveVoice() {
  voice = { ...voice, speed: Number($("speed").value), pitch: Number($("pitch").value) };
  try { localStorage.setItem(VOICE_KEY, JSON.stringify(voice)); } catch (e) {}
}

const PITCH_WORKLET = `
class PelhamPitch extends AudioWorkletProcessor {
  static get parameterDescriptors() { return [{ name: "ratio", defaultValue: 1, minValue: 0.5, maxValue: 2 }]; }
  constructor() { super(); this.win = Math.round(sampleRate * 0.05); this.len = this.win * 2 + 4; this.buf = []; this.w = 0; this.phase = 0; }
  read(b, d) { let pos = this.w - d; while (pos < 0) pos += this.len; const i = Math.floor(pos); const f = pos - i; return b[i] * (1 - f) + b[(i + 1) % this.len] * f; }
  process(inputs, outputs, params) {
    const input = inputs[0] || [], output = outputs[0], ratio = params.ratio[0];
    for (let c = 0; c < output.length; c++) if (!this.buf[c]) this.buf[c] = new Float32Array(this.len);
    for (let i = 0; i < output[0].length; i++) {
      const p1 = this.phase, p2 = (p1 + 0.5) % 1;
      const g1 = Math.sin(Math.PI * p1) ** 2, g2 = Math.sin(Math.PI * p2) ** 2;
      for (let c = 0; c < output.length; c++) {
        const src = input[c] || input[0];
        const x = src ? src[i] : 0;
        const b = this.buf[c];
        b[this.w] = x;
        output[c][i] = ratio === 1 ? x : this.read(b, p1 * this.win + 1) * g1 + this.read(b, p2 * this.win + 1) * g2;
      }
      this.w = (this.w + 1) % this.len;
      this.phase += (1 - ratio) / this.win;
      if (this.phase >= 1) this.phase -= 1;
      if (this.phase < 0) this.phase += 1;
    }
    return true;
  }
}
registerProcessor("pelham-pitch", PelhamPitch);
`;
// 피치를 처음 0 이 아닌 값으로 둘 때만 그래프를 잇는다 — file:// 로 열면 Web Audio 가 소리를 막으므로 그때는 쓰지 않는다.
let graph = null, graphTried = false;
const ratioOf = (semi) => 2 ** (semi / 12);
async function ensureGraph() {
  if (graph || graphTried || location.protocol === "file:") return graph;
  graphTried = true;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const context = new Ctx();
    await context.audioWorklet.addModule(URL.createObjectURL(new Blob([PITCH_WORKLET], { type: "application/javascript" })));
    const node = new AudioWorkletNode(context, "pelham-pitch", { outputChannelCount: [2] });
    context.createMediaElementSource(audio).connect(node).connect(context.destination);
    graph = { context, node };
  } catch (e) { graph = null; }
  return graph;
}
async function applyPitch() {
  const semi = Number($("pitch").value);
  if (semi === 0 && !graph) return;
  const g = await ensureGraph();
  if (!g) { $("pitch").value = "0"; $("pitch").disabled = true; $("pitch").title = T(UI.nopitch); return; }
  g.context.resume();
  g.node.parameters.get("ratio").setValueAtTime(ratioOf(semi), g.context.currentTime);
}
function applySpeed() { audio.preservesPitch = true; audio.playbackRate = Number($("speed").value); }

function renderUI() {
  $("eyebrow").textContent = T(UI.eyebrow); $("title").textContent = T(UI.title); $("sub").textContent = T(UI.sub);
  $("who").textContent = T(UI.who); $("speedL").textContent = T(UI.speed) + " "; $("pitchL").textContent = T(UI.pitch) + " ";
  $("foot").textContent = T(UI.foot); $("keyhint").textContent = T(UI.keyhint);
  $("play").textContent = playing ? T(UI.pause) : T(UI.play);
  $("lang-ko").setAttribute("aria-pressed", LANG === "ko"); $("lang-en").setAttribute("aria-pressed", LANG === "en");
  document.documentElement.lang = LANG;
  $("chips").innerHTML = S.map((s, i) => `<button class="chip" type="button" data-i="${i}" aria-current="${i === cur}"><b>${i + 1}</b>${T(s.n)}</button>`).join("");
}

function show(i) {
  cur = Math.max(0, Math.min(S.length - 1, i));
  const s = S[cur];
  $("stage").innerHTML = `<div class="lane"><div class="lt">${T(UI.pic)}</div><h2>${T(s.h)}</h2>${s.pic()}</div>
    <div class="lane"><div class="lt">${T(UI.keys)}</div><ul class="pts">${s.pts.map((p, k) => `<li><i>${k + 1}</i><span>${T(p)}</span></li>`).join("")}</ul></div>`;
  $("narr").textContent = NARR[LANG][cur];
  $("prog").style.width = "0";
  renderUI();
}

// ElevenLabs 크레딧이 바닥나(2026-10-26) 이 발표는 브라우저 음성으로 읽는다.
let utter = null;
function stopAudio() { clearInterval(timer); utter = null; try { speechSynthesis.cancel(); } catch (e) {} }
function playScene() {
  stopAudio();
  if (!("speechSynthesis" in window)) { playing = false; renderUI(); return; }
  const u = new SpeechSynthesisUtterance(NARR[LANG][cur]);
  u.lang = LANG === "ko" ? "ko-KR" : "en-US";
  u.rate = Number($("speed").value) || 1;
  u.pitch = Math.max(0, Math.min(2, 1 + Number($("pitch").value || 0) / 12));
  const v = speechSynthesis.getVoices().find((x) => x.lang && x.lang.replace("_", "-").startsWith(u.lang));
  if (v) u.voice = v;
  const start = Date.now(), est = (NARR[LANG][cur].length / (LANG === "ko" ? 7 : 15)) / u.rate;
  timer = setInterval(() => { $("prog").style.width = `${Math.min(100, ((Date.now() - start) / 1000 / est) * 100)}%`; }, 200);
  u.onend = () => {
    if (utter !== u) return;
    clearInterval(timer); $("prog").style.width = "100%";
    if (playing && cur < S.length - 1) setTimeout(() => { if (playing) { show(cur + 1); playScene(); } }, 700);
    else { playing = false; renderUI(); }
  };
  utter = u;
  speechSynthesis.speak(u);
}
$("play").onclick = () => { playing = !playing; if (playing) { playScene(); } else stopAudio(); renderUI(); };
$("prev").onclick = () => { show(cur - 1); if (playing) playScene(); };
$("next").onclick = () => { show(cur + 1); if (playing) playScene(); };
$("chips").onclick = (e) => { const b = e.target.closest("button[data-i]"); if (!b) return; show(Number(b.dataset.i)); if (playing) playScene(); };
$("speed").onchange = () => { saveVoice(); if (playing) playScene(); };
$("pitch").onchange = () => { saveVoice(); if (playing) playScene(); };
function setLang(l) { LANG = l; try { localStorage.setItem("pelham-deck-lang", l); } catch (e) {} show(cur); if (playing) playScene(); }
$("lang-ko").onclick = () => setLang("ko");
$("lang-en").onclick = () => setLang("en");

// 한/영 키: Windows 한글 키보드는 HangulMode(Lang1), Mac 은 Caps Lock 으로 입력 소스를 바꾸는 경우가 많다.
// Caps Lock 은 누름·뗌이 둘 다 올 수 있어 0.4초 안의 두 번째는 무시한다. L 키도 같다.
let lastToggle = 0;
function toggleLang() { const now = Date.now(); if (now - lastToggle < 400) return; lastToggle = now; setLang(LANG === "ko" ? "en" : "ko"); }
const isHanEng = (e) => e.key === "HangulMode" || e.code === "Lang1" || e.key === "CapsLock";
document.addEventListener("keydown", (e) => {
  if (e.target.closest && e.target.closest("select")) return;
  if (isHanEng(e) || ((e.key === "l" || e.key === "L" || e.key === "ㅣ") && !e.metaKey && !e.ctrlKey && !e.altKey)) { toggleLang(); return; }
  if (e.key === "ArrowRight") $("next").click();
  if (e.key === "ArrowLeft") $("prev").click();
  if (e.key === " " && !(e.target.closest && e.target.closest("button"))) { e.preventDefault(); $("play").click(); }
});
document.addEventListener("keyup", (e) => { if (e.key === "CapsLock") toggleLang(); });
show(0);
</script>
