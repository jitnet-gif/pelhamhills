/**
 * Hope 목소리 설정 — 프레젠테이션 나레이터(`StrategyDeck`)와 Hope 타일(`HopeAssistant`)이 같이 쓴다.
 *
 * - 톤(calm · natural · lively)과 속도는 **ElevenLabs 가 직접** 바꿔서 만든다(Fly `/ai-marketing/narrate` 의
 *   voice_settings). natural · 1× 는 목소리에 저장된 설정 그대로라 이 기능 전과 같은 소리다.
 * - ElevenLabs 속도는 0.7–1.2 까지다. 1.3× · 1.5× 는 1.2 로 만들고 나머지를 `<audio>` 재생 속도로 더한다.
 * - 피치는 브라우저(Web Audio)가 바꾼다 — 프레젠테이션만.
 * - 이 브라우저(localStorage `pelham-narration-voice`)에 기억하고, 한쪽에서 바꾸면 다른 쪽도 따라 바뀐다.
 */

export type Tone = "calm" | "natural" | "lively";
export type HopeVoice = { tone: Tone; speed: number; pitch: number };

export const TONES: { value: Tone; label: string }[] = [
  { value: "calm", label: "Calm" },
  { value: "natural", label: "Natural" },
  { value: "lively", label: "Lively" },
];
export const SPEEDS = [0.75, 0.85, 1, 1.1, 1.2, 1.3, 1.5];
export const PITCHES = [-4, -3, -2, -1, 0, 1, 2, 3, 4];

const VOICE_KEY = "pelham-narration-voice";
const EVENT = "pelham-narration-voice";

export function storedVoice(): HopeVoice {
  try {
    const raw = JSON.parse(localStorage.getItem(VOICE_KEY) ?? "null") as Partial<HopeVoice> | null;
    const speed = Number(raw?.speed);
    const pitch = Number(raw?.pitch);
    return {
      tone: TONES.some((tone) => tone.value === raw?.tone) ? (raw?.tone as Tone) : "natural",
      speed: SPEEDS.includes(speed) ? speed : 1,
      pitch: PITCHES.includes(pitch) ? pitch : 0,
    };
  } catch {
    return { tone: "natural", speed: 1, pitch: 0 };
  }
}

export function saveVoice(voice: HopeVoice): void {
  try {
    localStorage.setItem(VOICE_KEY, JSON.stringify(voice));
  } catch {
    // 기억 못 해도 이번에는 그대로 쓴다.
  }
  window.dispatchEvent(new CustomEvent<HopeVoice>(EVENT, { detail: voice }));
}

export function onVoiceChange(listener: (voice: HopeVoice) => void): () => void {
  const handle = (event: Event) => listener((event as CustomEvent<HopeVoice>).detail);
  window.addEventListener(EVENT, handle);
  return () => window.removeEventListener(EVENT, handle);
}

/** ElevenLabs 에 보낼 것(톤 · 0.7–1.2 속도)과, 그 위에 `<audio>` 가 더할 재생 속도. */
export function voiceParts(voice: HopeVoice): { tone: Tone; speed: number; playbackRate: number } {
  const speed = Math.min(1.2, Math.max(0.7, voice.speed));
  return { tone: voice.tone, speed, playbackRate: voice.speed / speed };
}
