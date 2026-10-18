/**
 * 백엔드 주소를 결정하는 단 하나의 자리. 새 fetch 래퍼에서 직접
 * `process.env.NEXT_PUBLIC_API_URL` 을 읽지 말고 여기를 거친다.
 *
 * `NEXT_PUBLIC_*` 값은 빌드 시점에 번들 안으로 박힌다. 그래서 개발 기본값인
 * `http://localhost:8000` 이 그대로 굳은 채 배포되면, 방문자의 브라우저는
 * **자기 컴퓨터의** 8000 포트를 두드리다 실패한다. 실제로 그렇게 나갔고
 * 예약 화면에 "Could not reach the booking server at http://localhost:8000"
 * 이 찍혔다 — 모르는 사람 화면에 우리 개발 머신 주소를 보여준 셈이다.
 *
 * 그래서 규칙을 하나 둔다: **loopback 주소는 loopback 페이지에서만 유효하다.**
 * pelhamhills.vercel.app 에서 열린 페이지에 localhost API 는 정의상 틀린 값이므로
 * 요청을 시도조차 하지 않고 "설정 안 됨"(빈 문자열) 으로 취급한다. 로컬 개발과
 * `next build` 뒤의 로컬 확인은 그대로 동작한다 — 페이지도 localhost 니까.
 */

const LOOPBACK = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|::1)$/i;

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/** 페이지 자체가 로컬에서 열려 있는가. 서버 렌더/정적 export 시점엔 알 수 없다. */
function servedLocally(): boolean {
  if (typeof window === "undefined") return false;
  return LOOPBACK.test(window.location.hostname);
}

function usableFromHere(url: string): boolean {
  return !(LOOPBACK.test(hostnameOf(url)) && !servedLocally());
}

/**
 * 이 브라우저에서 실제로 쓸 수 있는 API 호스트 (버전 접두사 없음).
 * 쓸 수 없으면 빈 문자열.
 *
 * 브라우저마다 답이 다르므로 모듈 상수로 굳히지 말고 **호출 시점**에 구한다.
 * 정적 export 는 서버에서 한 번, 브라우저에서 다시 평가되기 때문이다.
 */
export function apiHost(): string {
  const configured = (process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/+$/, "");
  const host = configured || "http://localhost:8000";
  return usableFromHere(host) ? host : "";
}

/** `/api/v1` 까지 붙은 베이스. 쓸 수 없으면 빈 문자열. */
export function apiBaseUrl(): string {
  const explicit = (process.env.NEXT_PUBLIC_API_BASE_URL ?? "").replace(/\/+$/, "");
  if (explicit) return usableFromHere(explicit) ? explicit : "";
  const host = apiHost();
  return host ? `${host}/api/v1` : "";
}

/**
 * 사용자에게 보여줄 "예약 서버가 없다" 문구. 주소는 절대 넣지 않는다 —
 * 방문자에게 localhost 든 내부 호스트든 알려 줄 이유가 없다.
 */
export const NO_API_MESSAGE =
  "Online booking is not available on this site yet. Please call the pro shop at 249-805-0556 or email info@pelhamhills.com.";
