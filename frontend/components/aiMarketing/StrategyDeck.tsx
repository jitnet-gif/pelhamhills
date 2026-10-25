"use client";

/**
 * Claude 전략 보고서를 보여 주는 두 가지 — **프레젠테이션**(`StrategyDeck`)과 **전체 글**(`StrategyBody`).
 * AI 마케팅 화면의 전략 패널, "Strategy reports" 탭, 공유·보고용 페이지(/strategy)가 같이 쓴다.
 *
 * 프레젠테이션: 장면 칩, 무대, 어두운 나레이션 띠, 재생 막대. 나레이션 소리는 장면을 틀 때 Fly
 * (`/ai-marketing/narrate`, ElevenLabs Hope)가 만든다. 다음 장면은 미리 받아 둔다.
 *
 * ## 속도 · 피치
 * - 속도는 `<audio>` 의 playbackRate(음높이는 그대로 — 브라우저의 preservesPitch).
 * - 피치는 Web Audio 로 바꾼다: 오디오를 AudioWorklet(지연선 두 개를 엇갈려 읽는 피치 시프터)에 통과시킨다.
 *   0 이면 손대지 않고 그대로 내보낸다. 속도와 따로 움직인다(반음 단위, ±4).
 * - 둘 다 이 브라우저(localStorage `pelham-narration-voice`)에 기억한다 — 다음에 열어도 그대로.
 */

import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";

import { Button, ErrorNote } from "@/components/retail/ui";
import { narrationUrl, type Strategy } from "@/lib/aiMarketing/api";
import type { Lang } from "@/lib/i18n/engine";
import { ApiError } from "@/lib/teeSheet/api";

function describe(cause: unknown): string {
  if (cause instanceof ApiError) return cause.message;
  return cause instanceof Error ? cause.message : "Something went wrong.";
}

const BUDGET_LABEL: Record<Strategy["strategies"][number]["budget"], string> = { low: "Low budget", medium: "Medium budget", high: "High budget" };


type Scene = { label: string; title: string; say: string; body: ReactNode };

/** 결과 → 장면들. 나레이션이 없는 옛 결과는 글에서 대본을 만든다. */
function strategyScenes(strategy: Strategy): Scene[] {
  const plan = [...strategy.plan].sort((a, b) => Number(a.window) - Number(b.window));
  const facts = strategy.facts.map((fact) => fact.fact);
  const scenes: Scene[] = [
    {
      label: "Summary",
      title: strategy.headline,
      say: strategy.narration?.intro || [strategy.headline, ...facts.slice(0, 3)].join(" "),
      body: (
        <ul className="grid gap-2 text-sm">
          {strategy.facts.map((fact, index) => (
            <li className="grid grid-cols-[22px_minmax(0,1fr)] gap-2" key={index}>
              <span className="font-mono text-xs text-[#1a7f4b]">{index + 1}</span>
              <span>
                {fact.fact} <span className="text-xs text-[#6b7280]">— {fact.evidence}</span>
              </span>
            </li>
          ))}
        </ul>
      ),
    },
  ];
  strategy.strategies.forEach((item, index) => {
    scenes.push({
      label: `Strategy ${index + 1}`,
      title: item.title,
      say: item.narration || [item.title, item.why, item.offer].join(" "),
      body: (
        <div className="grid gap-3 text-sm md:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
          <div className="grid content-start gap-2">
            <p className="flex flex-wrap gap-1 text-xs">
              {[item.target_group, item.time_slot, item.area, BUDGET_LABEL[item.budget] ?? item.budget].map((tag, tagIndex) => (
                <span className="bg-[#eef0f2] px-1.5 py-0.5" key={tagIndex}>
                  {tag}
                </span>
              ))}
            </p>
            <p>{item.why}</p>
            <div className="border border-[#1a7f4b] bg-[#e8f4ec] p-2">
              <b>Offer:</b> {item.offer}
            </div>
            <p>
              <b>Channels:</b> {item.channels.join(" · ")}
            </p>
            <p className="text-[#1a7f4b]">
              <b>Measure:</b> {item.kpi}
            </p>
          </div>
          <ol className="grid list-decimal content-start gap-1 pl-5">
            {item.steps.map((step, stepIndex) => (
              <li key={stepIndex}>{step}</li>
            ))}
          </ol>
        </div>
      ),
    });
  });
  scenes.push({
    label: "Local niches",
    title: "Local niches — Niagara to the Hamilton boundary",
    say: strategy.narration?.niches || strategy.niche_markets.map((row) => `${row.area}: ${row.hook}`).join(" "),
    body: (
      <div className="overflow-x-auto">
        <table className="w-full min-w-[600px] text-sm">
          <thead>
            <tr className="text-left text-xs text-[#6b7280]">
              <th className="font-bold">Area</th>
              <th className="font-bold">People</th>
              <th className="font-bold">Drive</th>
              <th className="font-bold">Hook</th>
            </tr>
          </thead>
          <tbody>
            {strategy.niche_markets.map((row, index) => (
              <tr className="border-t border-[#eef0f2] align-top" key={index}>
                <td className="py-1 pr-2 font-semibold">{row.area}</td>
                <td className="py-1 pr-2 whitespace-nowrap">{row.population}</td>
                <td className="py-1 pr-2 whitespace-nowrap">{row.drive}</td>
                <td className="py-1">{row.hook}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    ),
  });
  scenes.push({
    label: "Rollout",
    title: "Rollout — next 30, 60 and 90 days",
    say: strategy.narration?.plan || plan.map((step) => step.actions[0] ?? "").join(" "),
    body: (
      <div className="grid gap-2 md:grid-cols-3">
        {plan.map((step) => (
          <div className="border border-[#d4d4d8] p-3 text-sm" key={step.window}>
            <h4 className="mb-1 font-bold">{`Next ${step.window} days`}</h4>
            <ul className="grid list-disc gap-1 pl-5">
              {step.actions.map((action, index) => (
                <li key={index}>{action}</li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    ),
  });
  if (strategy.cautions.length > 0 || strategy.narration?.close) {
    scenes.push({
      label: "Watch out",
      title: "Watch out",
      say: strategy.narration?.close || strategy.cautions.join(" "),
      body: (
        <ul className="grid list-disc gap-1 pl-5 text-sm text-[#7a6320]">
          {strategy.cautions.map((caution, index) => (
            <li key={index}>{caution}</li>
          ))}
        </ul>
      ),
    });
  }
  return scenes;
}

const SPEEDS = [0.75, 0.85, 1, 1.1, 1.2, 1.3, 1.5];
const PITCHES = [-4, -3, -2, -1, 0, 1, 2, 3, 4];
const VOICE_KEY = "pelham-narration-voice";

type Voice = { speed: number; pitch: number };

function storedVoice(): Voice {
  try {
    const raw = JSON.parse(localStorage.getItem(VOICE_KEY) ?? "null") as Partial<Voice> | null;
    const speed = Number(raw?.speed);
    const pitch = Number(raw?.pitch);
    return {
      speed: SPEEDS.includes(speed) ? speed : 1,
      pitch: PITCHES.includes(pitch) ? pitch : 0,
    };
  } catch {
    return { speed: 1, pitch: 0 };
  }
}

/**
 * 피치 시프터(AudioWorklet). 지연선을 두 탭이 톱니 모양으로 엇갈려 읽는다 — 읽는 속도가 ratio 배라서
 * 음높이가 ratio 배가 되고, 길이는 그대로다. 두 탭은 반 주기 어긋나 sin² · cos² 로 섞여 이음매가 들리지 않는다.
 */
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

type Graph = { context: AudioContext; node: AudioWorkletNode };

/** `<audio>` 하나에 한 번만 잇는다(createMediaElementSource 는 두 번 부르면 오류). */
const graphs = new WeakMap<HTMLAudioElement, Promise<Graph | null>>();

function audioGraph(player: HTMLAudioElement): Promise<Graph | null> {
  const known = graphs.get(player);
  if (known) return known;
  const made = (async () => {
    const Context = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Context) return null;
    try {
      const context = new Context();
      const url = URL.createObjectURL(new Blob([PITCH_WORKLET], { type: "application/javascript" }));
      await context.audioWorklet.addModule(url);
      const node = new AudioWorkletNode(context, "pelham-pitch", { outputChannelCount: [2] });
      context.createMediaElementSource(player).connect(node).connect(context.destination);
      return { context, node };
    } catch {
      // Web Audio 가 안 되는 브라우저 — 피치 없이 그냥 소리만 낸다.
      return null;
    }
  })();
  graphs.set(player, made);
  return made;
}

const ratioOf = (semitones: number) => 2 ** (semitones / 12);

/**
 * 가 / Aa 는 `onLang` 을 부른다 — 어드민에서는 화면 언어(EN/한), 보관함에서는 같은 기간의 다른 언어 보고서.
 * `share` 는 공유 링크 토큰(로그인 없이 그 보고서 대본만 읽힌다).
 */
export function StrategyDeck({
  strategy,
  lang,
  onLang,
  share = "",
}: {
  strategy: Strategy;
  lang: Lang;
  onLang: (lang: Lang) => void;
  share?: string;
}) {
  const scenes = useMemo(() => strategyScenes(strategy), [strategy]);
  const audio = useRef<HTMLAudioElement | null>(null);
  const graph = useRef<Graph | null>(null);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  // 소리가 실제로 나기 시작한 장면. playing 인데 index 와 다르면 아직 준비 중이다.
  const [sounding, setSounding] = useState(-1);
  const [progress, setProgress] = useState(0);
  const [voice, setVoice] = useState<Voice>(() => storedVoice());
  const [error, setError] = useState("");
  const scene = scenes[Math.min(index, scenes.length - 1)];
  const preparing = playing && sounding !== index;

  useEffect(() => {
    const player = audio.current;
    if (!player) return;
    if (!playing) {
      player.pause();
      return;
    }
    let cancelled = false;
    narrationUrl(scene.say, share).then(
      (url) => {
        if (cancelled) return;
        player.src = url;
        player.preservesPitch = true;
        player.playbackRate = voice.speed;
        player.play().then(
          () => {
            if (!cancelled) setSounding(index);
          },
          () => {
            if (!cancelled) setPlaying(false);
          },
        );
      },
      (cause) => {
        if (cancelled) return;
        setError(describe(cause));
        setPlaying(false);
      },
    );
    const next = scenes[index + 1];
    if (next) narrationUrl(next.say, share).catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // 속도·피치는 아래 effect 가 바꾼다 — 바꿨다고 장면을 처음부터 다시 틀지 않게.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, index, scene.say, scenes, share]);

  useEffect(() => {
    if (audio.current) audio.current.playbackRate = voice.speed;
    graph.current?.node.parameters.get("ratio")?.setValueAtTime(ratioOf(voice.pitch), graph.current.context.currentTime);
    try {
      localStorage.setItem(VOICE_KEY, JSON.stringify(voice));
    } catch {
      // 기억 못 해도 이번에는 그대로 쓴다.
    }
  }, [voice]);

  const togglePlay = () => {
    setError("");
    const player = audio.current;
    if (!playing && player) {
      // 첫 재생 때(사용자가 누른 순간) 오디오 그래프를 만든다 — 브라우저가 소리를 허락하는 때.
      void audioGraph(player).then((made) => {
        graph.current = made;
        if (!made) return;
        void made.context.resume();
        made.node.parameters.get("ratio")?.setValueAtTime(ratioOf(voice.pitch), made.context.currentTime);
      });
    }
    setPlaying(!playing);
  };
  const go = (next: number) => {
    setIndex(Math.max(0, Math.min(scenes.length - 1, next)));
    setProgress(0);
  };
  const onEnded = () => {
    setProgress(1);
    if (index < scenes.length - 1) go(index + 1);
    else setPlaying(false);
  };

  return (
    <div className="grid min-w-0 gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1">
          {scenes.map((item, sceneIndex) => (
            <button
              aria-current={sceneIndex === index}
              className={`border px-2 py-1 text-xs font-semibold ${
                sceneIndex === index ? "border-[#1a7f4b] bg-[#e8f4ec]" : "border-[#d4d4d8] bg-white"
              }`}
              key={sceneIndex}
              onClick={() => go(sceneIndex)}
              type="button"
            >
              <span className="mr-1 font-mono text-[#6b7280]">{sceneIndex + 1}</span>
              {item.label}
            </button>
          ))}
        </div>
        <div aria-label="Language" className="inline-flex border border-[#d4d4d8]" role="group" translate="no">
          {(["ko", "en"] as const).map((code) => (
            <button
              aria-pressed={lang === code}
              className={`inline-flex min-h-9 items-center gap-1 px-2.5 text-xs font-bold ${
                lang === code ? "bg-[#1f2328] text-white" : "bg-white text-[#1f2328]"
              }`}
              key={code}
              onClick={() => onLang(code)}
              type="button"
            >
              <svg aria-hidden="true" className="size-5" viewBox="0 0 24 24">
                <path d="M3 4h18v12H9l-5 4v-4H3z" fill="none" stroke="currentColor" strokeWidth="1.6" />
                <text fill="currentColor" fontFamily="sans-serif" fontSize="8" fontWeight="700" textAnchor="middle" x="12" y="13.5">
                  {code === "ko" ? "가" : "Aa"}
                </text>
              </svg>
              {code === "ko" ? "한국어" : "English"}
            </button>
          ))}
        </div>
      </div>

      <section className="grid min-h-[260px] content-start gap-3 border border-[#d4d4d8] bg-white p-4">
        <p className="text-xs font-bold tracking-wide text-[#6b7280] uppercase">{`${index + 1} / ${scenes.length} · ${scene.label}`}</p>
        <h3 className="text-lg leading-snug font-bold [text-wrap:balance]">{scene.title}</h3>
        {scene.body}
      </section>

      <section aria-live="polite" className="grid gap-1 bg-[#14201a] px-4 py-3 text-[#e9f2ec]">
        <span className="text-[11px] tracking-wide text-[#9fb5a8] uppercase">Narration · Hope</span>
        <p className="text-[15px] leading-relaxed">{scene.say}</p>
      </section>

      <div className="flex flex-wrap items-center gap-2">
        <Button aria-label="Previous scene" disabled={index === 0} onClick={() => go(index - 1)}>
          ◀
        </Button>
        <Button className="min-w-[120px]" onClick={togglePlay} tone="primary">
          {preparing ? "Preparing voice…" : playing ? "❚❚ Pause" : "▶ Play"}
        </Button>
        <Button aria-label="Next scene" disabled={index === scenes.length - 1} onClick={() => go(index + 1)}>
          ▶
        </Button>
        <div aria-hidden="true" className="relative h-1.5 min-w-[120px] flex-1 bg-[#e5e7eb]">
          <span className="absolute inset-y-0 left-0 bg-[#1a7f4b]" style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
        <label className="flex items-center gap-1 text-xs text-[#6b7280]">
          Speed
          <select
            className="border border-[#d4d4d8] bg-white px-1 py-1 text-xs"
            onChange={(event) => setVoice({ ...voice, speed: Number(event.target.value) })}
            value={voice.speed}
          >
            {SPEEDS.map((value) => (
              <option key={value} value={value}>{`${value}×`}</option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1 text-xs text-[#6b7280]">
          Pitch
          <select
            className="border border-[#d4d4d8] bg-white px-1 py-1 text-xs"
            onChange={(event) => setVoice({ ...voice, pitch: Number(event.target.value) })}
            value={voice.pitch}
          >
            {PITCHES.map((value) => (
              <option key={value} value={value}>
                {value === 0 ? "0" : value > 0 ? `+${value}` : `${value}`}
              </option>
            ))}
          </select>
        </label>
      </div>
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      <audio
        onEnded={onEnded}
        onTimeUpdate={(event) => {
          const player = event.currentTarget;
          if (player.duration > 0) setProgress(player.currentTime / player.duration);
        }}
        preload="auto"
        ref={audio}
      />
      <p className="text-xs text-[#6b7280]">
        {strategy.period.from} → {strategy.period.to} · {strategy.model} · Narration by ElevenLabs (Hope). Population and drive
        times are approximate (2021 Census).
      </p>
    </div>
  );
}

export function StrategyBody({ strategy }: { strategy: Strategy }) {
  const plan = [...strategy.plan].sort((a, b) => Number(a.window) - Number(b.window));
  return (
    <div className="grid min-w-0 gap-3">
      <p className="border-l-4 border-[#6d28d9] bg-[#f5f3ff] px-3 py-2 text-sm font-semibold">{strategy.headline}</p>

      <section className="grid gap-1">
        <h3 className="text-xs font-bold tracking-wide text-[#6b7280] uppercase">What the numbers say</h3>
        <ul className="grid gap-1 text-sm">
          {strategy.facts.map((fact, index) => (
            <li key={index}>
              {fact.fact} <span className="text-xs text-[#6b7280]">— {fact.evidence}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="grid gap-2">
        <h3 className="text-xs font-bold tracking-wide text-[#6b7280] uppercase">Strategies</h3>
        <div className="grid gap-2 lg:grid-cols-2">
          {strategy.strategies.map((item, index) => (
            <article className="grid content-start gap-1.5 border border-[#d4d4d8] p-3 text-sm" key={index}>
              <h4 className="font-bold">
                {index + 1}. {item.title}
              </h4>
              <p className="flex flex-wrap gap-1 text-xs">
                {[item.target_group, item.time_slot, item.area, BUDGET_LABEL[item.budget] ?? item.budget].map((tag, tagIndex) => (
                  <span className="bg-[#eef0f2] px-1.5 py-0.5" key={tagIndex}>
                    {tag}
                  </span>
                ))}
              </p>
              <p>{item.why}</p>
              <p>
                <b>Offer:</b> {item.offer}
              </p>
              <p>
                <b>Channels:</b> {item.channels.join(" · ")}
              </p>
              <ol className="list-decimal pl-5">
                {item.steps.map((step, stepIndex) => (
                  <li key={stepIndex}>{step}</li>
                ))}
              </ol>
              <p className="text-xs text-[#1a7f4b]">
                <b>Measure:</b> {item.kpi}
              </p>
            </article>
          ))}
        </div>
      </section>

      <section className="grid gap-1">
        <h3 className="text-xs font-bold tracking-wide text-[#6b7280] uppercase">Local niches — Niagara to the Hamilton boundary</h3>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="text-left text-xs text-[#6b7280]">
                <th className="font-bold">Area</th>
                <th className="font-bold">People</th>
                <th className="font-bold">Drive</th>
                <th className="font-bold">Why they&apos;d come</th>
                <th className="font-bold">Hook</th>
              </tr>
            </thead>
            <tbody>
              {strategy.niche_markets.map((row, index) => (
                <tr className="border-t border-[#eef0f2] align-top" key={index}>
                  <td className="py-1 pr-2 font-semibold">{row.area}</td>
                  <td className="py-1 pr-2 whitespace-nowrap">{row.population}</td>
                  <td className="py-1 pr-2 whitespace-nowrap">{row.drive}</td>
                  <td className="py-1 pr-2">{row.why}</td>
                  <td className="py-1">{row.hook}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="grid gap-1">
        <h3 className="text-xs font-bold tracking-wide text-[#6b7280] uppercase">Rollout</h3>
        <div className="grid gap-2 md:grid-cols-3">
          {plan.map((step) => (
            <div className="border border-[#d4d4d8] p-3 text-sm" key={step.window}>
              <h4 className="mb-1 font-bold">{`Next ${step.window} days`}</h4>
              <ul className="grid list-disc gap-1 pl-5">
                {step.actions.map((action, index) => (
                  <li key={index}>{action}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>

      {strategy.cautions.length > 0 ? (
        <section className="grid gap-1">
          <h3 className="text-xs font-bold tracking-wide text-[#6b7280] uppercase">Watch out</h3>
          <ul className="grid list-disc gap-1 pl-5 text-sm text-[#7a6320]">
            {strategy.cautions.map((caution, index) => (
              <li key={index}>{caution}</li>
            ))}
          </ul>
        </section>
      ) : null}
      <p className="text-xs text-[#6b7280]">
        {strategy.period.from} → {strategy.period.to} · {strategy.model} · Population and drive times are approximate (2021
        Census).
      </p>
    </div>
  );
}
