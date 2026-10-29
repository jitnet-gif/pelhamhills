"use client";

/**
 * 손님이 **말로** 티타임을 예약하거나 취소하는 위젯.
 *
 * 전화선과 같은 에이전트, 같은 도구를 쓴다. 다른 것은 입구뿐이다 — 여기서는
 * 브라우저 마이크로 붙고, 전화에서는 Twilio 로 붙는다. 예약이 실제로 만들어지는
 * 곳은 양쪽 다 `backend/api/routes/voice.py` 이므로 규칙이 갈릴 일이 없다.
 *
 * ## 설계상 지킨 것
 *
 * - **폼을 대체하지 않는다.** 마이크를 못 쓰는 손님, 조용한 곳에 있는 손님,
 *   음성 인식이 이름을 못 알아듣는 경우가 반드시 있다. 이 위젯이 실패해도 아래
 *   폼은 그대로 살아 있어야 하므로, 실패는 조용히 접히고 폼을 가리지 않는다.
 * - **끝나면 목록을 새로 읽는다.** 통화 중에 에이전트가 예약을 만들었다면 화면의
 *   빈 시간 목록은 이미 낡았다. `onFinished` 로 부모가 다시 불러오게 한다.
 * - **SDK 는 눌렀을 때 불러온다.** 정적 export 사이트에서 예약 화면을 여는 것만으로
 *   음성 SDK 와 오디오 워크렛을 내려받게 하면, 말로 할 생각이 없는 대다수 손님이
 *   쓰지도 않을 번들 값을 치른다.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { CLUB } from "@/lib/nav";
import {
  VOICE_UNAVAILABLE_MESSAGE,
  browserTodayIso,
  requestVoiceSession,
} from "@/lib/voice/session";

type Props = {
  /** 통화가 끝났다. 예약이 생겼을 수 있으니 부모는 빈 시간을 다시 읽어야 한다. */
  onFinished?: () => void;
  /** 눌러서 열린 자리(CharlieBot)라 바로 마이크를 연다. */
  autoStart?: boolean;
};

/** 웹에서 Charlie 가 하는 첫마디. 전화 인사는 agent.json 기본값. 짧게 둔다(2026-10-26 요청). */
const GREETING = "Hi, I'm Charlie. Would you like to book a tee time?";

type Phase = "idle" | "connecting" | "live" | "error";

/** 화면에 남기는 마지막 대화 몇 줄. 전체 로그가 아니라 "지금 무슨 말이 오갔나" 다. */
type Line = { id: number; who: "you" | "assistant"; text: string };

const MAX_LINES = 4;

export default function VoiceBooking({ onFinished, autoStart }: Props) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [speaking, setSpeaking] = useState(false);

  // 세션을 끊는 함수. SDK 를 동적으로 불러오므로 훅이 아니라 ref 에 담아 둔다.
  const stopRef = useRef<null | (() => void)>(null);
  const lineId = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // 손님이 화면을 떠나면 마이크를 반드시 놓는다. 안 그러면 탭 표시등이
      // 계속 켜져 있고, 통화 요금도 계속 나간다.
      stopRef.current?.();
    };
  }, []);

  const addLine = useCallback((who: Line["who"], text: string) => {
    if (!mounted.current || !text.trim()) return;
    setLines((current) => [
      ...current.slice(-(MAX_LINES - 1)),
      { id: (lineId.current += 1), who, text },
    ]);
  }, []);

  const start = useCallback(async () => {
    setPhase("connecting");
    setError("");
    setLines([]);

    try {
      // 마이크 권한을 SDK 보다 먼저 묻는다. 여기서 거절당하면 signed URL 을
      // 발급받을 이유가 없고(=크레딧을 태울 이유가 없고), 손님에게 "마이크가
      // 필요하다" 는 정확한 이유를 말해 줄 수 있다.
      await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setPhase("error");
      setError("We need your microphone to talk. Allow it in your browser, or use the form below.");
      return;
    }

    let session;
    try {
      session = await requestVoiceSession();
    } catch {
      setPhase("error");
      setError(VOICE_UNAVAILABLE_MESSAGE);
      return;
    }

    try {
      const { Conversation } = await import("@elevenlabs/client");

      const conversation = await Conversation.startSession({
        signedUrl: session.signedUrl,
        connectionType: "websocket",
        // 에이전트가 오늘 날짜를 지어내지 못하게 브라우저가 아는 날짜를 넘긴다.
        // 서버도 'today'/'tomorrow' 를 해석하지만, 손님이 "이번 주 금요일" 이라고
        // 말하는 경우는 모델이 오늘을 알아야 풀 수 있다.
        dynamicVariables: {
          today_iso: browserTodayIso(),
          club_name: CLUB.shortName,
          channel: "website",
          greeting: GREETING,
        },
        // 에이전트 첫 인사는 전화 인사다(전화는 변수를 못 보낸다). 웹은 Charlie 인사로 덮는다.
        overrides: { agent: { firstMessage: GREETING } },
        onModeChange: ({ mode }) => {
          if (mounted.current) setSpeaking(mode === "speaking");
        },
        onMessage: ({ role, message }) => {
          // `source` 는 deprecated 다 (SDK 타입 주석). `role` 은 "user" | "agent".
          addLine(role === "user" ? "you" : "assistant", message);
        },
        onDisconnect: () => {
          if (!mounted.current) return;
          setPhase("idle");
          setSpeaking(false);
          stopRef.current = null;
          // 통화 중에 예약이 만들어졌을 수 있다. 화면의 빈 시간은 이미 낡았다.
          onFinished?.();
        },
        onError: (reason) => {
          if (!mounted.current) return;
          setPhase("error");
          setError(
            typeof reason === "string" && reason
              ? "The call dropped. Please try again, or use the form below."
              : VOICE_UNAVAILABLE_MESSAGE,
          );
        },
      });

      stopRef.current = () => {
        void conversation.endSession();
      };

      if (mounted.current) {
        setPhase("live");
      } else {
        // 연결이 붙는 사이에 손님이 화면을 떠났다.
        stopRef.current();
      }
    } catch {
      setPhase("error");
      setError(VOICE_UNAVAILABLE_MESSAGE);
    }
  }, [addLine, onFinished]);

  const stop = useCallback(() => {
    stopRef.current?.();
    stopRef.current = null;
    setPhase("idle");
    setSpeaking(false);
    onFinished?.();
  }, [onFinished]);

  const started = useRef(false);
  useEffect(() => {
    if (!autoStart || started.current) return;
    started.current = true;
    void start();
  }, [autoStart, start]);

  if (phase === "error") {
    return (
      <div className="rounded-sm border border-[#d6c28f] bg-[#f3ead2] p-4 text-[#5c4a1c]">
        <p className="text-sm font-semibold">{error}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            className="tap-target rounded-sm border border-[#8a6f30] bg-white px-4 text-sm font-bold text-[#5c4a1c] transition hover:bg-[#f7f4ed]"
            onClick={() => {
              setPhase("idle");
              setError("");
            }}
            type="button"
          >
            Dismiss
          </button>
          <a
            className="tap-target flex items-center rounded-sm border border-[#8a6f30] bg-white px-4 text-sm font-bold text-[#5c4a1c] transition hover:bg-[#f7f4ed]"
            href={CLUB.phoneHref}
          >
            Call {CLUB.phone}
          </a>
        </div>
      </div>
    );
  }

  if (phase === "idle") {
    return (
      <div className="flex flex-col gap-3 rounded-sm border border-[#d8d1c3] bg-white p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="font-semibold">Rather just say it?</p>
          <p className="text-sm text-[#5b6155]">
            Charlie can book or cancel a tee time by voice.
          </p>
        </div>
        <button
          className="tap-target shrink-0 rounded-sm bg-[#214d2f] px-5 text-sm font-bold text-white transition hover:bg-[#163820]"
          onClick={() => void start()}
          type="button"
        >
          Talk to Charlie
        </button>
      </div>
    );
  }

  return (
    <div className="rounded-sm border border-[#214d2f] bg-white p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="flex items-center gap-2 font-semibold">
          <span
            aria-hidden
            className={`inline-block h-2.5 w-2.5 rounded-full ${
              phase === "connecting"
                ? "animate-pulse bg-[#d6c28f]"
                : speaking
                  ? "animate-pulse bg-[#214d2f]"
                  : "bg-[#8fae97]"
            }`}
          />
          {phase === "connecting"
            ? "Connecting…"
            : speaking
              ? "Charlie is speaking"
              : "Listening — go ahead"}
        </p>
        <button
          className="tap-target shrink-0 rounded-sm border border-[#d8d1c3] bg-white px-4 text-sm font-bold text-[#8a2f2f] transition hover:bg-[#fbeeee]"
          onClick={stop}
          type="button"
        >
          End call
        </button>
      </div>

      {/* 대화를 글로도 보여준다. 시끄러운 곳에서, 또는 이름 철자가 잘못 잡혔을 때
          손님이 눈으로 확인할 방법이 있어야 한다. */}
      {lines.length > 0 && (
        <ul aria-live="polite" className="mt-3 space-y-1 border-t border-[#ece7da] pt-3">
          {lines.map((line) => (
            <li className="text-sm" key={line.id}>
              <span className="font-semibold text-[#5b6155]">
                {line.who === "you" ? "You: " : "Charlie: "}
              </span>
              <span>{line.text}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
