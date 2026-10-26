/**
 * 음성 예약 위젯이 붙을 티켓(signed URL)을 받아오는 곳.
 *
 * ## 왜 백엔드에서 받아오는가
 * ElevenLabs 에 붙으려면 API 키가 필요하다. 키를 `NEXT_PUBLIC_*` 으로 두면 번들에
 * 박혀 누구나 읽을 수 있고, 그 키로 우리 계정의 음성 크레딧을 태울 수 있다.
 * 그래서 키는 FastAPI 안에만 두고, 브라우저는 한 번 쓰고 버리는 주소만 받는다.
 *
 * ## 왜 Next 의 route handler 를 안 쓰는가
 * 쓸 수가 없다. `next.config.mjs` 가 `output: "export"` 라서 이 앱에는 서버가
 * 없다 — route handler 도, middleware 도, server action 도 빌드에서 사라진다.
 * 이 앱에서 비밀을 다룰 수 있는 유일한 서버는 백엔드다.
 */

import { paymentsApiBase } from "@/lib/booking/payments";

export type VoiceSession = {
  signedUrl: string;
  agentId: string;
};

export class VoiceUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VoiceUnavailableError";
  }
}

/** 손님에게 보여줄 문구. 서버 주소도, 계정 정보도 절대 넣지 않는다. */
export const VOICE_UNAVAILABLE_MESSAGE =
  "The voice assistant is not available right now. You can book with the form below, or call the pro shop.";

export async function requestVoiceSession(): Promise<VoiceSession> {
  // Vercel 에 NEXT_PUBLIC_API_URL 이 없어 apiBaseUrl() 이 비면 요청조차 안 나갔다(2026-10-26).
  // 결제와 같은 운영 Fly 주소를 쓴다.
  const base = paymentsApiBase();

  let response: Response;
  try {
    response = await fetch(`${base}/voice/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
  } catch {
    throw new VoiceUnavailableError(VOICE_UNAVAILABLE_MESSAGE);
  }

  if (!response.ok) {
    throw new VoiceUnavailableError(VOICE_UNAVAILABLE_MESSAGE);
  }

  // 서버(`SessionResponse`)는 snake_case 로 보낸다.
  const body = (await response.json()) as { signed_url?: string; agent_id?: string };
  if (!body.signed_url || !body.agent_id) {
    throw new VoiceUnavailableError(VOICE_UNAVAILABLE_MESSAGE);
  }

  return { signedUrl: body.signed_url, agentId: body.agent_id };
}

/**
 * 브라우저가 아는 오늘 날짜를 **현지 시간 기준** ISO 로.
 *
 * `toISOString().slice(0,10)` 은 UTC 라서 온타리오 저녁 8시부터 하루가 밀린다.
 * 이 값을 에이전트에 dynamic variable 로 넘기므로, 틀리면 손님이 엉뚱한 날을
 * 예약하게 된다. 규칙은 `components/booking/availability.ts` 의 `todayIso` 와 같다.
 */
export function browserTodayIso(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}
