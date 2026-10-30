const $ = (id) => document.getElementById(id);
const audio = $("audio");
let cur = 0, playing = false, timer = null;

function renderUI() {
  const c = S[cur].ch;
  $("eyebrow").textContent = T(UI.eyebrow); $("title").textContent = T(UI.title); $("sub").textContent = T(UI.sub);
  $("who").textContent = T(UI.who); $("speedL").textContent = T(UI.speed); $("foot").textContent = T(UI.foot);
  $("play").textContent = playing ? T(UI.pause) : T(UI.play);
  $("pos").textContent = `${cur + 1} / ${S.length}`;
  $("lang-ko").setAttribute("aria-pressed", LANG === "ko"); $("lang-en").setAttribute("aria-pressed", LANG === "en");
  document.documentElement.lang = LANG;
  $("chs").innerHTML = CH.map((x, i) => `<button class="ch" type="button" data-c="${i}" aria-current="${i === c}">${i + 1}. ${T(x.n)}<small>${S.filter((s) => s.ch === i).length}</small></button>`).join("");
  $("chips").innerHTML = S.map((s, i) => s.ch === c ? `<button class="chip" type="button" data-i="${i}" aria-current="${i === cur}"><b>${i + 1}</b>${T(s.n)}</button>` : "").join("");
  const on = $("chs").querySelector('[aria-current="true"]');
  if (on) $("chs").scrollLeft = on.offsetLeft - $("chs").offsetLeft - 40;
}

function show(i) {
  cur = Math.max(0, Math.min(S.length - 1, i));
  const s = S[cur];
  $("stage").innerHTML = `<div class="lane"><div class="lt">${T(CH[s.ch].n)}</div><h2>${T(s.h)}</h2>${s.pic()}</div>
    <div class="lane"><div class="lt">${T(UI.keys)}</div><ul class="pts">${s.pts.map((p, k) => `<li><i>${k + 1}</i><span>${T(p)}</span></li>`).join("")}</ul></div>`;
  $("narr").textContent = T(s.say);
  $("prog").style.width = "0";
  try { history.replaceState(null, "", `#${s.id}`); } catch (e) {}
  renderUI();
}

function stopAudio() { audio.pause(); clearInterval(timer); }
function playScene() {
  stopAudio();
  audio.src = `audio/${LANG}/${S[cur].id}.mp3`;
  audio.playbackRate = Number($("speed").value);
  const p = audio.play();
  if (p && p.catch) p.catch(() => { playing = false; renderUI(); });
  timer = setInterval(() => {
    const d = audio.duration || 1;
    $("prog").style.width = `${Math.min(100, (audio.currentTime / d) * 100)}%`;
  }, 200);
}
audio.addEventListener("ended", () => {
  clearInterval(timer); $("prog").style.width = "100%";
  if (playing && cur < S.length - 1) setTimeout(() => { if (playing) { show(cur + 1); playScene(); } }, 700);
  else { playing = false; renderUI(); }
});
const go = (i) => { show(i); if (playing) playScene(); };
$("play").onclick = () => { playing = !playing; if (playing) playScene(); else stopAudio(); renderUI(); };
$("prev").onclick = () => go(cur - 1);
$("next").onclick = () => go(cur + 1);
$("chips").onclick = (e) => { const b = e.target.closest("button[data-i]"); if (b) go(Number(b.dataset.i)); };
$("chs").onclick = (e) => { const b = e.target.closest("button[data-c]"); if (b) go(S.findIndex((s) => s.ch === Number(b.dataset.c))); };
$("speed").onchange = () => { audio.playbackRate = Number($("speed").value); };
function setLang(l) { LANG = l; try { localStorage.setItem("pelham-deck-lang", l); } catch (e) {} show(cur); if (playing) playScene(); }
$("lang-ko").onclick = () => setLang("ko");
$("lang-en").onclick = () => setLang("en");
document.addEventListener("keydown", (e) => { if (e.target.tagName === "SELECT") return; if (e.key === "ArrowRight") $("next").click(); if (e.key === "ArrowLeft") $("prev").click(); });
const fromHash = S.findIndex((s) => `#${s.id}` === location.hash);
show(fromHash < 0 ? 0 : fromHash);
