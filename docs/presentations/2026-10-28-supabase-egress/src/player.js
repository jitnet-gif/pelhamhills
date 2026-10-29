const $ = (id) => document.getElementById(id);
const audio = $("audio");
let cur = 0, playing = false, timer = null, startAt = 0;

function renderUI() {
  $("eyebrow").textContent = T(UI.eyebrow); $("title").textContent = T(UI.title); $("sub").textContent = T(UI.sub);
  $("who").textContent = T(UI.who); $("speedL").textContent = T(UI.speed); $("foot").textContent = T(UI.foot);
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

function stopAudio() { audio.pause(); clearInterval(timer); }
function playScene() {
  stopAudio();
  audio.src = `audio/${LANG}/s${cur + 1}.mp3`;
  audio.playbackRate = Number($("speed").value);
  const p = audio.play();
  if (p && p.catch) p.catch(() => { playing = false; renderUI(); });
  timer = setInterval(() => {
    const d = audio.duration || DUR[LANG][cur] || 1;
    $("prog").style.width = `${Math.min(100, (audio.currentTime / d) * 100)}%`;
  }, 200);
}
audio.addEventListener("ended", () => {
  clearInterval(timer); $("prog").style.width = "100%";
  if (playing && cur < S.length - 1) setTimeout(() => { if (playing) { show(cur + 1); playScene(); } }, 700);
  else { playing = false; renderUI(); }
});
$("play").onclick = () => { playing = !playing; if (playing) playScene(); else stopAudio(); renderUI(); };
$("prev").onclick = () => { show(cur - 1); if (playing) playScene(); };
$("next").onclick = () => { show(cur + 1); if (playing) playScene(); };
$("chips").onclick = (e) => { const b = e.target.closest("button[data-i]"); if (!b) return; show(Number(b.dataset.i)); if (playing) playScene(); };
$("speed").onchange = () => { audio.playbackRate = Number($("speed").value); };
function setLang(l) { LANG = l; try { localStorage.setItem("pelham-deck-lang", l); } catch (e) {} show(cur); if (playing) playScene(); }
$("lang-ko").onclick = () => setLang("ko");
$("lang-en").onclick = () => setLang("en");
document.addEventListener("keydown", (e) => { if (e.key === "ArrowRight") $("next").click(); if (e.key === "ArrowLeft") $("prev").click(); });
show(0);
</script>
