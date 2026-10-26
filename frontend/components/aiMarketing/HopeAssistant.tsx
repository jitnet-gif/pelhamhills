"use client";

/**
 * **Hope** — AI 매니저 화면 맨 위 타일. 목소리로 부르고, 대화로 묻고, 말로 듣는다.
 *
 *   1. "Hope 부르기" 를 켜면 마이크가 "Hope"(호프) 를 기다린다(브라우저 음성 인식, 이 기기 안에서).
 *      부르면 "네, 부르셨어요?" 하고 질문을 듣는다. "호프야 오늘 매출 얼마야" 처럼 한 번에 말해도 된다.
 *   2. 질문은 Fly `/ai-marketing/chat` 로 간다 — Claude 가 오늘·어제·이번 주·내일 예약과 매출, 문자·전화, 최근 전략을
 *      직접 찾아 짧게 답한다. 답은 ElevenLabs Hope 목소리(톤·속도는 `lib/aiMarketing/voice.ts`)로 읽고, 화면에도 쓴다.
 *      다 읽으면 바로 다음 말을 듣는다 — 대화식. 조용하면 다시 "Hope" 를 기다린다.
 *   3. "전략 만들어 줘" → 고객 분석 탭에서 Claude 전략을 만든다(1–2분). "프레젠테이션 틀어 줘" 나 나레이터 아이콘 →
 *      그 결과를 Hope 나레이션 프레젠테이션으로 튼다.
 *   4. "문자로 보내 줘" → 손님 문자(Twilio)와 웹사이트 팝업 확인 카드를 띄우고 Hope 가 읽어 준다. **"네" 를 듣거나
 *      "Yes, send" 를 눌러야** 캠페인을 만들어 보내고 팝업을 켠다. 받을 사람·동의·수신거부·발송 시간 규칙은
 *      Marketing 과 같다(`/marketing/campaigns/{id}/send`).
 *   5. 주고받은 것과 실행 결과는 모두 0119(Hope reports)에 남는다 — 지우지 않는다.
 *
 * 음성 인식이 없는 브라우저(Firefox 등)에서는 글로 묻고, 답은 그대로 소리로 듣는다.
 * 언어는 화면의 EN / 한 을 따른다 — 듣는 말, Hope 의 답, 전략 보고서 모두.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { Button, ErrorNote, TextInput } from "@/components/retail/ui";
import {
  aiMarketingApi,
  askHope,
  hopeApi,
  type HopeAction,
  type HopeLogRow,
  type HopeLookup,
  narrationUrl,
} from "@/lib/aiMarketing/api";
import { type HopeVoice, onVoiceChange, saveVoice, SPEEDS, storedVoice, TONES, type Tone, voiceParts } from "@/lib/aiMarketing/voice";
import { getLang, type Lang, onLangChange, setLang } from "@/lib/i18n/engine";
import { marketingApi, SEGMENT_LABEL } from "@/lib/marketing/api";
import { siteNoticesApi } from "@/lib/siteNotices";
import { ApiError } from "@/lib/teeSheet/api";

type LaunchAction = Extract<HopeAction, { type: "launch" }>;
type Phase = "idle" | "wake" | "listening" | "thinking" | "speaking";
type Turn = { role: "user" | "assistant"; text: string; lookups?: HopeLookup[] };
type Proposal = { action: LaunchAction; reach: number | null; status: "asking" | "running" | "done" | "cancelled"; result?: string };

// ----- 브라우저 음성 인식(Chrome · Edge · Safari). 표준 타입이 없어 쓰는 만큼만 적는다. -----
type RecResult = { isFinal: boolean; 0: { transcript: string } };
type RecEvent = { resultIndex: number; results: ArrayLike<RecResult> };
type Rec = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: RecEvent) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  start: () => void;
  abort: () => void;
};

function recognizerClass(): (new () => Rec) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: new () => Rec; webkitSpeechRecognition?: new () => Rec };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

const WAKE = /(hey\s+)?\bhope\b|호프|홉|헤이\s*호프/i;
const NO = /(아니|취소|하지\s*마|보내지\s*마|안\s*보내|그만|안\s*돼|\bno\b|\bnope\b|cancel|don'?t|not now|stop)/i;
const YES = /(^|\s)(네|예|응|그래|좋아|보내|실행|진행|올려|yes|yeah|yep|sure|go ahead|send it|do it|confirm)/i;

const GREETING: Record<Lang, string> = { ko: "네, 부르셨어요?", en: "Yes, you called?" };

const money = (cents: number) => `$${(cents / 100).toLocaleString("en-CA", { maximumFractionDigits: 0 })}`;

function describe(cause: unknown): string {
  if (cause instanceof ApiError) return cause.message;
  return cause instanceof Error ? cause.message : "Something went wrong.";
}

export function HopeAssistant({
  onStrategy,
  onPresent,
  notice,
}: {
  onStrategy: (action: Extract<HopeAction, { type: "strategy" }>) => void;
  onPresent: () => void;
  /** 화면이 Hope 에게 말하게 할 것(전략이 다 됐다 등). id 가 바뀔 때 한 번 읽는다. */
  notice: { id: number; text: string } | null;
}) {
  const [lang, setLangState] = useState<Lang>(() => getLang());
  useEffect(() => onLangChange(setLangState), []);
  const [voice, setVoiceState] = useState<HopeVoice>(() => storedVoice());
  useEffect(() => onVoiceChange(setVoiceState), []);
  const setVoice = (next: HopeVoice) => {
    setVoiceState(next);
    saveVoice(next);
  };

  const [awake, setAwake] = useState(false);
  const [phase, setPhaseState] = useState<Phase>("idle");
  const [heard, setHeard] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [typed, setTyped] = useState("");
  const [proposal, setProposalState] = useState<Proposal | null>(null);
  const [error, setError] = useState("");
  const [log, setLog] = useState<HopeLogRow[] | null>(null);
  const [logError, setLogError] = useState("");

  // 콜백 안에서 최신 값을 읽는다(인식기 이벤트는 처음 만든 함수를 붙든다).
  const phaseRef = useRef<Phase>("idle");
  const awakeRef = useRef(false);
  const langRef = useRef(lang);
  const voiceRef = useRef(voice);
  const turnsRef = useRef<Turn[]>([]);
  const proposalRef = useRef<Proposal | null>(null);
  const recRef = useRef<Rec | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  useEffect(() => {
    langRef.current = lang;
    voiceRef.current = voice;
    proposalRef.current = proposal;
  });

  const Recognizer = recognizerClass();
  /** 확인 카드 — ref 도 바로 바꾼다("네" 가 다음 렌더 전에 들려도 카드를 본다). */
  const setProposal = (next: Proposal | null | ((now: Proposal | null) => Proposal | null)) => {
    const value = typeof next === "function" ? next(proposalRef.current) : next;
    proposalRef.current = value;
    setProposalState(value);
  };
  const setPhase = (next: Phase) => {
    phaseRef.current = next;
    setPhaseState(next);
  };

  const loadLog = useCallback(() => {
    hopeApi.log(30).then(
      (rows) => {
        setLog(rows);
        setLogError("");
      },
      (cause) => {
        const message = describe(cause);
        setLogError(/function|schema cache|does not exist/i.test(message)
          ? "Hope reports switch on once 0119_ai_manager_hope_log.sql is run in the Supabase SQL Editor."
          : message);
      },
    );
  }, []);
  useEffect(loadLog, [loadLog]);

  const stopRec = () => {
    const rec = recRef.current;
    recRef.current = null;
    if (rec) {
      rec.onend = null;
      rec.onresult = null;
      rec.onerror = null;
      try {
        rec.abort();
      } catch {
        // 이미 멈췄다.
      }
    }
  };

  /** Hope 목소리로 읽는다. ElevenLabs 가 안 되면 브라우저 목소리로. 다 읽으면 끝난다. */
  const speak = (text: string): Promise<void> =>
    new Promise((resolve) => {
      stopRec();
      setPhase("speaking");
      const parts = voiceParts(voiceRef.current);
      const player = audioRef.current;
      const fallback = () => {
        if (typeof window === "undefined" || !window.speechSynthesis) return resolve();
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.lang = langRef.current === "ko" ? "ko-KR" : "en-US";
        utterance.rate = voiceRef.current.speed;
        utterance.onend = () => resolve();
        utterance.onerror = () => resolve();
        window.speechSynthesis.speak(utterance);
      };
      narrationUrl(text, "", parts).then(
        (url) => {
          if (!player) return resolve();
          player.onended = () => resolve();
          player.onerror = () => resolve();
          player.src = url;
          player.preservesPitch = true;
          player.playbackRate = parts.playbackRate;
          player.play().catch(fallback);
        },
        fallback,
      );
    });

  /** 말이 끝나면: 대화 중이면 바로 다음 말을 듣고, 아니면 다시 "Hope" 를 기다린다. */
  const afterSpeaking = (keepListening: boolean) => {
    if (keepListening && Recognizer) listenOnce();
    else if (awakeRef.current) startWake();
    else setPhase("idle");
  };

  const say = async (text: string, keepListening: boolean) => {
    await speak(text);
    afterSpeaking(keepListening);
  };

  const record = (turn: Turn) => {
    turnsRef.current = [...turnsRef.current, turn];
    setTurns(turnsRef.current);
  };

  // ----- 확인 카드: 문자 + 팝업 -----

  const runLaunch = async () => {
    const current = proposalRef.current;
    if (!current || current.status !== "asking") return;
    const { action } = current;
    setProposal({ ...current, status: "running" });
    const done: string[] = [];
    const failed: string[] = [];
    const detail: Record<string, unknown> = { action, reach: current.reach };
    if (action.sms) {
      try {
        const campaign = await marketingApi.createCampaign({
          channel: "sms",
          name: `Hope · ${action.title}`.slice(0, 80),
          message: action.sms,
          audience: { segment: action.segment },
        });
        detail.campaign_id = campaign.id;
        if (action.report_id && action.strategy > 0) {
          await aiMarketingApi.recordLaunch(action.report_id, action.strategy - 1, "sms", String(campaign.id)).catch(() => undefined);
        }
        await marketingApi.send(Number(campaign.id));
        detail.sms = "sending";
        done.push(langRef.current === "ko" ? "문자 발송을 시작했어요" : "the texts are going out now");
      } catch (cause) {
        detail.sms = describe(cause);
        failed.push(`${langRef.current === "ko" ? "문자" : "Text"}: ${describe(cause)}`);
      }
    }
    if (action.popup) {
      try {
        const start = new Date();
        const notice = await siteNoticesApi.save({
          kind: "promotion",
          title: action.popup_title,
          body: action.popup_body,
          link_url: action.popup_link,
          link_label: action.popup_link_label || null,
          surfaces: "all",
          repeat: "daily",
          starts_at: start.toISOString(),
          ends_at: new Date(start.getTime() + action.days * 86_400_000).toISOString(),
          active: true,
        });
        detail.popup_id = notice.id;
        if (action.report_id && action.strategy > 0) {
          await aiMarketingApi.recordLaunch(action.report_id, action.strategy - 1, "popup", notice.id).catch(() => undefined);
        }
        done.push(langRef.current === "ko" ? "홈페이지 팝업을 올렸어요" : "the pop-up is live on the website");
      } catch (cause) {
        detail.popup = describe(cause);
        failed.push(`${langRef.current === "ko" ? "팝업" : "Pop-up"}: ${describe(cause)}`);
      }
    }
    const ko = langRef.current === "ko";
    const summary = [
      done.length ? (ko ? `${done.join(", ")}.` : `Done — ${done.join(" and ")}.`) : "",
      failed.length ? (ko ? `안 된 것이 있어요. ${failed.join(" ")}` : `Something did not go through. ${failed.join(" ")}`) : "",
    ].filter(Boolean).join(" ");
    setProposal({ ...current, status: "done", result: summary });
    record({ role: "assistant", text: summary });
    hopeApi.save("launch", langRef.current, ko ? "네, 보내 주세요" : "Yes, send it", summary, detail).then(loadLog, () => undefined);
    await say(summary, false);
  };

  const cancelLaunch = async () => {
    const current = proposalRef.current;
    if (!current || current.status !== "asking") return;
    setProposal({ ...current, status: "cancelled" });
    const text = langRef.current === "ko" ? "알겠어요, 보내지 않을게요." : "Okay, I won't send it.";
    record({ role: "assistant", text });
    hopeApi.save("launch", langRef.current, "cancelled", text, { action: current.action }).then(loadLog, () => undefined);
    await say(text, false);
  };

  // ----- 대화 -----

  const ask = async (text: string, byVoice: boolean) => {
    const question = text.trim();
    if (!question) return;
    // 확인 카드가 떠 있으면 "네 / 아니요" 가 먼저다.
    if (proposalRef.current?.status === "asking") {
      if (NO.test(question)) {
        record({ role: "user", text: question });
        return cancelLaunch();
      }
      if (YES.test(question)) {
        record({ role: "user", text: question });
        return runLaunch();
      }
    }
    setError("");
    stopRec();
    record({ role: "user", text: question });
    setPhase("thinking");
    try {
      const answer = await askHope(turnsRef.current.map(({ role, text: said }) => ({ role, text: said })), langRef.current);
      record({ role: "assistant", text: answer.reply, lookups: answer.lookups });
      let launch: LaunchAction | null = null;
      for (const action of answer.actions) {
        if (action.type === "strategy") onStrategy(action);
        else if (action.type === "present") onPresent();
        else launch = action;
      }
      if (answer.log_id) loadLog();
      if (launch) {
        const proposed = launch;
        setProposal({ action: proposed, reach: null, status: "asking" });
        marketingApi.audience("sms", { segment: proposed.segment }).then(
          (audience) => setProposal((now) => (now && now.action === proposed ? { ...now, reach: audience.phones } : now)),
          () => undefined,
        );
      }
      // 프레젠테이션을 트는 중이면 Hope 는 듣지 않는다(나레이션과 겹치지 않게).
      const presenting = answer.actions.some((action) => action.type === "present");
      await speak(answer.reply);
      if (presenting) {
        if (awakeRef.current) startWake();
        else setPhase("idle");
        return;
      }
      afterSpeaking(byVoice || Boolean(launch));
    } catch (cause) {
      const message = describe(cause);
      setError(message);
      afterSpeaking(false);
    }
  };

  /** 한 마디 듣기(질문, 이어지는 대화, "네/아니요"). 아무 말이 없으면 다시 "Hope" 를 기다린다. */
  const listenOnce = () => {
    if (!Recognizer) return;
    stopRec();
    const rec = new Recognizer();
    rec.lang = langRef.current === "ko" ? "ko-KR" : "en-US";
    rec.continuous = false;
    rec.interimResults = true;
    let finalText = "";
    rec.onresult = (event) => {
      let text = "";
      for (let i = 0; i < event.results.length; i++) text += event.results[i][0].transcript;
      setHeard(text);
      if (event.results[event.results.length - 1]?.isFinal) finalText = text;
    };
    rec.onerror = (event) => {
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        setError("The microphone is blocked. Allow it for this site in the browser, then call Hope again.");
        setAwake(false);
        awakeRef.current = false;
      }
    };
    rec.onend = () => {
      recRef.current = null;
      setHeard("");
      if (finalText.trim()) void ask(finalText, true);
      else if (awakeRef.current) startWake();
      else setPhase("idle");
    };
    recRef.current = rec;
    setPhase("listening");
    try {
      rec.start();
    } catch {
      setPhase("idle");
    }
  };

  /** "Hope" 를 기다린다. 브라우저가 몇십 초마다 듣기를 끊으면 다시 켠다. */
  const startWake = () => {
    if (!Recognizer || !awakeRef.current) return;
    stopRec();
    const rec = new Recognizer();
    rec.lang = langRef.current === "ko" ? "ko-KR" : "en-US";
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const text = result[0].transcript;
        const match = WAKE.exec(text);
        if (!match) continue;
        const rest = text.slice(match.index + match[0].length).replace(/^[\s,.!?야아]+/, "").trim();
        // "호프야 오늘 매출 얼마야" — 한 번에 말했으면 바로 묻는다. 아직 말하는 중이면 끝날 때까지 기다린다.
        if (rest.length >= 4 && !result.isFinal) return;
        stopRec();
        if (rest.length >= 4) void ask(rest, true);
        else void say(GREETING[langRef.current], true);
        return;
      }
    };
    rec.onerror = (event) => {
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        setError("The microphone is blocked. Allow it for this site in the browser, then call Hope again.");
        setAwake(false);
        awakeRef.current = false;
        setPhase("idle");
      }
    };
    rec.onend = () => {
      recRef.current = null;
      if (awakeRef.current && phaseRef.current === "wake") window.setTimeout(startWake, 250);
    };
    recRef.current = rec;
    setPhase("wake");
    try {
      rec.start();
    } catch {
      // 이미 듣는 중 — onend 가 다시 켠다.
    }
  };

  const toggleAwake = () => {
    setError("");
    if (awake) {
      setAwake(false);
      awakeRef.current = false;
      stopRec();
      audioRef.current?.pause();
      setPhase("idle");
      return;
    }
    setAwake(true);
    awakeRef.current = true;
    // 인사말을 미리 만들어 둔다 — 불렀을 때 바로 대답하게.
    narrationUrl(GREETING[lang], "", voiceParts(voice)).catch(() => undefined);
    startWake();
  };

  const talkNow = () => {
    setError("");
    audioRef.current?.pause();
    listenOnce();
  };

  // 언어를 바꾸면 그 언어로 다시 듣는다.
  useEffect(() => {
    if (awakeRef.current && phaseRef.current === "wake") startWake();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lang]);

  // 화면이 알려 주는 것(전략 완성 등)을 읽는다.
  const lastNotice = useRef(0);
  useEffect(() => {
    if (!notice || notice.id === lastNotice.current) return;
    lastNotice.current = notice.id;
    record({ role: "assistant", text: notice.text });
    void say(notice.text, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notice]);

  useEffect(
    () => () => {
      awakeRef.current = false;
      stopRec();
    },
    [],
  );

  const status: Record<Phase, string> = {
    idle: awake ? "Ready" : "Off",
    wake: 'Listening for "Hope"',
    listening: "Listening…",
    thinking: "Hope is thinking…",
    speaking: "Hope is speaking",
  };
  const live = phase === "listening" || phase === "speaking" || phase === "thinking";

  return (
    <section className="grid min-w-0 gap-3 bg-[#14201a] p-4 text-[#e9f2ec]">
      <div className="flex flex-wrap items-center gap-3">
        <span
          aria-hidden="true"
          className={`grid size-12 place-items-center rounded-full text-lg font-bold ${
            live ? "animate-pulse bg-[#1a7f4b]" : phase === "wake" ? "bg-[#2f5d46]" : "bg-[#24342b]"
          }`}
        >
          H
        </span>
        <div className="grid min-w-0 flex-1 gap-0.5">
          <h2 className="text-base font-bold">Hope · AI Manager</h2>
          <p aria-live="polite" className="text-xs text-[#9fb5a8]">
            {status[phase]}
            {heard ? (
              <span className="ml-2 text-[#e9f2ec]" translate="no">
                “{heard}”
              </span>
            ) : null}
          </p>
        </div>
        <div aria-label="Language" className="inline-flex border border-[#3c5a49]" role="group" translate="no">
          {(["ko", "en"] as const).map((code) => (
            <button
              aria-pressed={lang === code}
              className={`min-h-9 px-2.5 text-xs font-bold ${lang === code ? "bg-[#e9f2ec] text-[#14201a]" : "text-[#e9f2ec]"}`}
              key={code}
              onClick={() => setLang(code)}
              type="button"
            >
              {code === "ko" ? "한" : "EN"}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {Recognizer ? (
          <>
            <Button onClick={toggleAwake} tone={awake ? "plain" : "primary"}>
              {awake ? "■ Stop listening" : "🎙 Call Hope"}
            </Button>
            <Button disabled={phase === "thinking"} onClick={talkNow}>
              Talk now
            </Button>
          </>
        ) : (
          <span className="text-xs text-[#9fb5a8]">This browser cannot listen. Type to Hope — answers are still spoken.</span>
        )}
        <button
          className="inline-flex min-h-11 items-center gap-2 border border-[#3c5a49] px-3 text-sm font-bold hover:bg-[#24342b]"
          onClick={onPresent}
          title="AI presentation narrator"
          type="button"
        >
          <svg aria-hidden="true" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.6" viewBox="0 0 24 24">
            <rect height="11" rx="1" width="16" x="2" y="3" />
            <path d="M10 14v4M6 20h8M8 7l4 2.5L8 12z" />
            <path d="M20 8c1 1 1 4 0 5M22 6c2 2.5 2 6.5 0 9" />
          </svg>
          Presentation narrator
        </button>
        <label className="flex items-center gap-1 text-xs text-[#9fb5a8]">
          Tone
          <select
            className="border border-[#3c5a49] bg-[#14201a] px-1 py-1 text-xs text-[#e9f2ec]"
            onChange={(event) => setVoice({ ...voice, tone: event.target.value as Tone })}
            value={voice.tone}
          >
            {TONES.map((tone) => (
              <option key={tone.value} value={tone.value}>
                {tone.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1 text-xs text-[#9fb5a8]">
          Speed
          <select
            className="border border-[#3c5a49] bg-[#14201a] px-1 py-1 text-xs text-[#e9f2ec]"
            onChange={(event) => setVoice({ ...voice, speed: Number(event.target.value) })}
            value={voice.speed}
          >
            {SPEEDS.map((value) => (
              <option key={value} value={value}>{`${value}×`}</option>
            ))}
          </select>
        </label>
      </div>

      {turns.length > 0 ? (
        <ol className="grid max-h-80 gap-2 overflow-y-auto text-sm">
          {turns.slice(-12).map((turn, index) => (
            <li
              className={`grid gap-1 px-3 py-2 ${turn.role === "user" ? "justify-self-end bg-[#24342b]" : "bg-[#1d2d24]"}`}
              key={index}
            >
              <span className="text-[11px] tracking-wide text-[#9fb5a8] uppercase">{turn.role === "user" ? "You" : "Hope"}</span>
              <span translate="no">{turn.text}</span>
              {turn.lookups?.length ? (
                <span className="flex flex-wrap gap-1">
                  {turn.lookups.map((row, rowIndex) => (
                    <span className="bg-[#14201a] px-1.5 py-0.5 font-mono text-[11px] text-[#cfe3d6]" key={rowIndex} translate="no">
                      {`${row.from === row.to ? row.from : `${row.from}→${row.to}`} · ${row.rounds} rounds · ${row.bookings} tee times · ${money(row.net_sales)} sales`}
                    </span>
                  ))}
                </span>
              ) : null}
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-sm text-[#9fb5a8]">
          Say “Hope”, then ask — for example “How many bookings today?”, “What were sales yesterday compared with last
          week?”, “Make a strategy for weekday afternoons”, or “Send a text for strategy one”.
        </p>
      )}

      {proposal ? <ProposalCard onCancel={cancelLaunch} onConfirm={runLaunch} proposal={proposal} /> : null}

      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const text = typed;
          setTyped("");
          void ask(text, false);
        }}
      >
        <TextInput
          aria-label="Ask Hope"
          className="min-w-0 flex-1"
          maxLength={500}
          onChange={(event) => setTyped(event.target.value)}
          placeholder="Or type a question for Hope"
          value={typed}
        />
        <Button disabled={!typed.trim() || phase === "thinking"} tone="primary" type="submit">
          Ask
        </Button>
      </form>
      {error ? <ErrorNote>{error}</ErrorNote> : null}

      <details className="text-sm" onToggle={(event) => (event.currentTarget.open ? loadLog() : undefined)}>
        <summary className="cursor-pointer text-xs font-bold tracking-wide text-[#9fb5a8] uppercase">Hope reports</summary>
        <div className="mt-2 grid gap-2">
          {logError ? <p className="text-xs text-[#f0c36b]">{logError}</p> : null}
          {log && log.length === 0 ? <p className="text-xs text-[#9fb5a8]">Nothing yet — every question and launch is kept here.</p> : null}
          {(log ?? []).map((row) => (
            <article className="grid gap-0.5 border-t border-[#24342b] pt-2" key={row.id}>
              <span className="text-[11px] text-[#9fb5a8]">
                {`${row.created_at.slice(0, 16).replace("T", " ")} · ${row.kind} · ${row.created_by}`}
              </span>
              <span className="font-semibold" translate="no">
                {row.question}
              </span>
              <span className="text-[#cfe3d6]" translate="no">
                {row.answer}
              </span>
            </article>
          ))}
        </div>
      </details>

      <audio preload="auto" ref={audioRef} />
    </section>
  );
}

function ProposalCard({ proposal, onConfirm, onCancel }: { proposal: Proposal; onConfirm: () => void; onCancel: () => void }) {
  const { action } = proposal;
  return (
    <div className="grid gap-2 border-2 border-[#f0c36b] bg-[#fffaf0] p-3 text-sm text-[#1f2328]">
      <p className="font-bold">
        {proposal.status === "asking"
          ? "Send this? Say “yes” or press the button — nothing goes out before that."
          : proposal.status === "running"
            ? "Sending…"
            : proposal.status === "cancelled"
              ? "Not sent."
              : "Done."}
      </p>
      {action.sms ? (
        <div className="grid gap-1">
          <span className="text-xs font-bold text-[#6b7280]">
            {`Text message · ${SEGMENT_LABEL[action.segment]}${proposal.reach === null ? "" : ` · ${proposal.reach} people can receive it`}`}
          </span>
          <p className="border border-[#d4d4d8] bg-white p-2" translate="no">
            {action.sms}
          </p>
          <span className="text-[11px] text-[#6b7280]">The sender name and the opt-out line are added automatically.</span>
        </div>
      ) : null}
      {action.popup ? (
        <div className="grid gap-1">
          <span className="text-xs font-bold text-[#6b7280]">{`Website pop-up · ${action.days} days`}</span>
          <div className="border border-[#d4d4d8] bg-white p-2" translate="no">
            <p className="font-bold">{action.popup_title}</p>
            <p>{action.popup_body}</p>
            <p className="mt-1 inline-block bg-[#1a7f4b] px-2 py-0.5 text-xs font-bold text-white">{action.popup_link_label}</p>
          </div>
        </div>
      ) : null}
      {proposal.result ? <p className="text-[#1a7f4b]">{proposal.result}</p> : null}
      {proposal.status === "asking" ? (
        <div className="flex flex-wrap gap-2">
          <Button onClick={onConfirm} tone="primary">
            {action.sms && action.popup ? "Yes, send & publish" : action.sms ? "Yes, send" : "Yes, publish"}
          </Button>
          <Button onClick={onCancel}>Not now</Button>
        </div>
      ) : null}
    </div>
  );
}
