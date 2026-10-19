/**
 * 프로 샵 직원 로그인 세션 — 브라우저에만 사는 작은 저장소.
 *
 * ## 왜 supabase-js 를 쓰지 않나
 * 이 사이트에는 Supabase SDK 가 **설치되어 있지 않다**. `frontend/package.json` 에
 * `@supabase/*` 가 한 줄도 없고, `lib/supabase.ts` 가 부르는 `@supabase/ssr` 는
 * `npx tsc --noEmit` 에서 "Cannot find module" 로 이미 떨어진다(그래서 next.config 의
 * `ignoreBuildErrors` 주석이 그 파일을 "미설치 의존성"이라 부른다). 저장소 루트
 * `node_modules` 에 `@supabase/supabase-js` 가 굴러다니긴 하지만 어느 package.json 에도
 * 선언되어 있지 않다 — 워크스페이스 호이스팅 덕에 타입 검사는 통과해도, frontend 만
 * 설치하는 빌드에서는 사라지는 유령이다. 의존성을 새로 넣는 것은 이번 작업 범위
 * 밖이므로, GoTrue 의 REST 엔드포인트를 `fetch` 로 직접 부른다. 필요한 것은
 * 로그인·갱신·로그아웃 세 개뿐이라 SDK 없이도 충분하다.
 *
 * 그리고 `lib/supabase.ts` 는 `next/headers` 를 부른다 — 정적 export(`output: "export"`)
 * 에는 서버가 없으므로 **브라우저 코드에서 절대 import 하지 않는다.** 이 파일이 그
 * 자리를 대신한다.
 *
 * ## 세션이 사는 곳
 * `localStorage` 한 칸. 정적 export 라 세션을 심어 줄 서버도, 읽어 줄 미들웨어도 없다.
 * 토큰은 프로 샵 태블릿·직원 휴대폰의 브라우저 안에서만 살고, 탭을 옮기면
 * `storage` 이벤트로 같이 움직인다.
 *
 * 주소와 공개 키는 `lib/booking/rpc.ts` 와 같은 값이다. 그쪽이 내보내지 않는
 * 모듈 상수라서 이번에는 복사해 둔다(그 파일은 이번 작업의 담당 밖이다).
 * publishable 키는 브라우저에 실리라고 만든 값이고, 환경변수가 없는 빌드에서
 * 로그인이 조용히 꺼지는 사고를 막으려고 기본값을 코드에 둔다.
 */

import { ApiError } from "./api";

export const SUPABASE_URL = (
  process.env.NEXT_PUBLIC_SUPABASE_URL || "https://yxpiwwgquyaxjubovzmi.supabase.co"
).replace(/\/+$/, "");

export const PUBLISHABLE_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || "sb_publishable_oMJG_-xpWr6AI5o3KnrU_A_kJENaKSY";

const STORAGE_KEY = "pelham.staff.session";

/** 만료 이 시간 전부터는 미리 갱신한다. 요청 도중 토큰이 죽는 것을 막는 여유분. */
const REFRESH_MARGIN_MS = 60_000;

export type StaffSession = {
  accessToken: string;
  refreshToken: string;
  /** 액세스 토큰 만료 시각(epoch ms). */
  expiresAt: number;
  email: string;
  userId: string;
};

// ===== 메모리 캐시 + 구독 =================================================
// 렌더 중에 localStorage 를 읽으면 정적 export 의 프리렌더 HTML 과 브라우저의 첫
// 렌더가 어긋난다(hydration mismatch). 그래서 모듈 캐시를 두고, 화면은 effect 에서만
// 읽는다.

let cached: StaffSession | null = null;
let loaded = false;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function readStored(): StaffSession | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StaffSession>;
    if (typeof parsed?.accessToken !== "string" || typeof parsed?.refreshToken !== "string") {
      return null;
    }
    return {
      accessToken: parsed.accessToken,
      refreshToken: parsed.refreshToken,
      expiresAt: typeof parsed.expiresAt === "number" ? parsed.expiresAt : 0,
      email: typeof parsed.email === "string" ? parsed.email : "",
      userId: typeof parsed.userId === "string" ? parsed.userId : "",
    };
  } catch {
    // 프라이빗 모드/차단된 스토리지/깨진 JSON — 로그인 화면부터 시작한다.
    return null;
  }
}

function writeStored(session: StaffSession | null): void {
  if (typeof window === "undefined") return;
  try {
    if (session) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // 저장이 막혀도 이번 탭에서는 메모리 캐시로 계속 쓸 수 있다.
  }
}

/** 지금 들고 있는 세션(만료됐을 수도 있다). 화면에서는 effect 안에서만 부른다. */
export function getSession(): StaffSession | null {
  if (!loaded) {
    cached = readStored();
    loaded = true;
  }
  return cached;
}

function setSession(session: StaffSession | null): void {
  cached = session;
  loaded = true;
  writeStored(session);
  notify();
}

/** 세션이 바뀔 때(로그인·로그아웃·만료) 알림을 받는다. 해제 함수를 돌려준다. */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// 다른 탭에서 로그아웃하면 이 탭도 따라 나간다. 프로 샵 태블릿에 티 시트를 두 탭
// 띄워 두는 일이 흔한데, 한쪽만 로그인 상태로 남으면 어느 쪽이 진짜인지 알 수 없다.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== null && event.key !== STORAGE_KEY) return;
    cached = readStored();
    loaded = true;
    notify();
  });
}

// ===== GoTrue 호출 ========================================================

/**
 * GoTrue 의 오류 본문은 PostgREST 와 모양이 다르고 버전마다 또 다르다
 * (`msg` / `error_description` / `message` / `error`). 넷 다 훑는다.
 */
function authErrorMessage(body: unknown, fallback: string): string {
  if (!body || typeof body !== "object") return fallback;
  const record = body as Record<string, unknown>;
  for (const key of ["msg", "error_description", "message", "error"]) {
    const value = record[key];
    if (typeof value === "string" && value) return value;
  }
  return fallback;
}

type TokenResponse = {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  user?: { id?: unknown; email?: unknown } | null;
};

function toSession(payload: TokenResponse, fallbackEmail: string): StaffSession | null {
  if (typeof payload?.access_token !== "string" || typeof payload?.refresh_token !== "string") {
    return null;
  }
  const seconds = typeof payload.expires_in === "number" ? payload.expires_in : 3600;
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    expiresAt: Date.now() + seconds * 1000,
    email: typeof payload.user?.email === "string" ? payload.user.email : fallbackEmail,
    userId: typeof payload.user?.id === "string" ? payload.user.id : "",
  };
}

async function tokenRequest(
  grant: "password" | "refresh_token",
  body: Record<string, string>,
): Promise<Response> {
  return fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=${grant}`, {
    method: "POST",
    headers: { apikey: PUBLISHABLE_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * 아이디(또는 이메일)·비밀번호 로그인. 실패는 `ApiError` 로 올린다 — 예약 화면과 같은 오류 타입이다.
 *
 * 401/400 에는 GoTrue 의 영어 원문("Invalid login credentials") 대신 우리 문구를 쓴다.
 * 한국어 화면에 영어 한 줄이 튀어나오면 직원은 무엇이 잘못됐는지 알기 어렵다.
 */
/**
 * 직원은 이메일 대신 짧은 아이디(예: `hwang`)로도 들어온다. GoTrue 는 이메일만 받으므로
 * `@` 가 없는 입력은 클럽 도메인 계정(`hwang@pelhamhills.com`)으로 바꿔 보낸다.
 */
const STAFF_ID_DOMAIN = "pelhamhills.com";

function loginEmail(login: string): string {
  const value = login.trim();
  return value.includes("@") ? value : `${value.toLowerCase()}@${STAFF_ID_DOMAIN}`;
}

export async function signIn(login: string, password: string): Promise<StaffSession> {
  const email = loginEmail(login);
  let response: Response;
  try {
    response = await tokenRequest("password", { email, password });
  } catch {
    throw new ApiError(0, "로그인 서버에 연결할 수 없습니다. 인터넷 연결을 확인해 주세요.");
  }

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    // JSON 이 아닌 응답(게이트웨이 HTML 등). 아래에서 상태 코드로 판단한다.
  }

  if (!response.ok) {
    const message =
      response.status === 400 || response.status === 401
        ? "아이디 또는 비밀번호가 올바르지 않습니다."
        : authErrorMessage(payload, `로그인에 실패했습니다 (${response.status}).`);
    throw new ApiError(response.status, message);
  }

  const session = toSession((payload ?? {}) as TokenResponse, email);
  if (!session) throw new ApiError(500, "로그인 응답을 이해할 수 없습니다. 잠시 후 다시 시도해 주세요.");
  setSession(session);
  return session;
}

/** 저장된 세션을 버린다. GoTrue 쪽 무효화는 실패해도 로그아웃은 성립시킨다. */
export async function signOut(): Promise<void> {
  const current = getSession();
  setSession(null);
  if (!current) return;
  try {
    await fetch(`${SUPABASE_URL}/auth/v1/logout`, {
      method: "POST",
      headers: { apikey: PUBLISHABLE_KEY, Authorization: `Bearer ${current.accessToken}` },
    });
  } catch {
    // 네트워크가 끊겨 있어도 이 브라우저에서는 이미 나간 상태다.
  }
}

/** 세션을 즉시 버린다(만료·거부 감지 시). 네트워크를 타지 않는다. */
export function clearSession(): void {
  if (getSession()) setSession(null);
}

// 갱신은 **한 번에 하나만** 돈다. `useTeeSheet` 는 마운트 때 예약과 슬롯을 각각의
// effect 에서 동시에 부르는데, 저장된 토큰이 만료돼 있으면 두 요청이 같이 갱신을
// 때린다. GoTrue 는 리프레시 토큰을 회전시키므로 늦게 도착한 쪽이 invalid_grant 를
// 받고, 그 실패로 세션을 지우면 직원은 새로고침할 때마다 로그인 화면으로 튕긴다.
let refreshing: Promise<StaffSession | null> | null = null;

async function performRefresh(current: StaffSession): Promise<StaffSession | null> {
  // 갱신이 **일시적으로** 실패한 경우에는 낡은 토큰을 그대로 돌려준다. 그래야 요청이
  // 실제로 나가고, 끊긴 네트워크는 네트워크 오류(status 0 → 오프라인 모드)로,
  // 정말 죽은 토큰은 PostgREST 의 401 로 각각 제 이름표를 달고 돌아온다.
  // 여기서 null 을 돌려주면 둘 다 "로그인 안 됨"으로 뭉개진다.
  let response: Response;
  try {
    response = await tokenRequest("refresh_token", { refresh_token: current.refreshToken });
  } catch {
    return current;
  }

  if (!response.ok) {
    // 400/401/403 은 리프레시 토큰이 죽었다는 뜻 — 다시 로그인해야 한다.
    if (response.status === 400 || response.status === 401 || response.status === 403) {
      setSession(null);
      return null;
    }
    return current; // 5xx 등 서버 쪽 일시 장애.
  }

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    return current;
  }

  const next = toSession((payload ?? {}) as TokenResponse, current.email);
  if (!next) return current;
  setSession(next);
  return next;
}

/**
 * 지금 요청에 붙일 액세스 토큰. 없거나 갱신에 실패하면 `null`.
 * 만료가 가까우면 먼저 갱신한다.
 */
export async function accessToken(): Promise<string | null> {
  const current = getSession();
  if (!current) return null;
  if (current.expiresAt - REFRESH_MARGIN_MS > Date.now()) return current.accessToken;

  if (!refreshing) {
    refreshing = performRefresh(current).finally(() => {
      refreshing = null;
    });
  }
  const refreshed = await refreshing;
  return refreshed?.accessToken ?? null;
}

/** 지금 로그인한 계정의 이메일(로그인되어 있지 않으면 빈 문자열). */
export function sessionEmail(): string {
  return getSession()?.email ?? "";
}
