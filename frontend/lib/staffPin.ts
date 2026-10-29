/**
 * 어드민 숫자판 — Pelham Shift 직원 ID(4~8자리)로 들어오고, 1분 동안 손대지 않으면 잠긴 화면을 연다(2026-10-28 클럽 요청).
 *
 * - 들어오기: FastAPI `POST /pos/pin-login` 이 번호를 pelham-shift 에 확인하고 공용 직원 계정(staff@pelhamhills.ca)으로
 *   로그인해 세션을 돌려준다. 그 계정의 비밀번호는 Fly secret 에만 있다 — 저장소가 공개라서.
 * - 잠금 풀기: 이미 로그인한 상태라 계산대 담당자 코드와 같은 `cashierForCode` 로 번호만 확인한다.
 *   매니저 계정 화면도 같은 번호판으로 연다.
 *
 * 번호는 pelham-shift 의 로그인 비밀번호이기도 하므로 이 기기에 적지 않는다.
 */

import { paymentsApiBase } from "@/lib/booking/payments";
import { cashierForCode } from "@/lib/pos/cashierCode";
import { ApiError } from "@/lib/teeSheet/api";
import { adoptSession } from "@/lib/teeSheet/session";

export const PIN_STAFF_EMAIL = "staff@pelhamhills.ca";

/** 손대지 않고 이만큼 지나면 잠근다. */
export const IDLE_LOCK_MS = 60_000;

/** 직원 ID 로 들어온다. 성공하면 세션이 저장되고 그 직원 이름을 돌려준다. */
export async function pinSignIn(code: string): Promise<string> {
  let response: Response;
  try {
    response = await fetch(`${paymentsApiBase()}/pos/pin-login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: code.trim() }),
    });
  } catch {
    throw new ApiError(0, "Can't reach the server. Check the internet connection.");
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // JSON 이 아닌 오류 본문.
  }
  if (!response.ok) {
    const detail = (body as { detail?: unknown } | null)?.detail;
    let message = typeof detail === "string" && detail ? detail : `Sign-in failed (${response.status}).`;
    if (response.status === 404 && detail === "Not Found") {
      message = "Staff ID sign-in is not on the server yet. Use Manager sign in.";
    }
    throw new ApiError(response.status, message);
  }
  if (!adoptSession(body, PIN_STAFF_EMAIL)) throw new ApiError(500, "Sign-in answer was not understood. Try again.");
  const name = (body as { name?: unknown }).name;
  return typeof name === "string" ? name : "";
}

/** 잠긴 화면을 여는 번호인가. 맞으면 이름, 아니면 ApiError. */
export async function pinUnlock(code: string): Promise<string> {
  return cashierForCode(code);
}

// ===== 마지막 손댄 시각 ======================================================
// 탭끼리 나누고 새로고침해도 남도록 localStorage 에 둔다 — 잠긴 화면을 새로고침으로 빠져나가지 못하게.

const LAST_ACTIVE_KEY = "pelham.staff.lastActive";
const LOCKED_KEY = "pelham.staff.locked";

export function markActive(now = Date.now()): void {
  try {
    window.localStorage.setItem(LAST_ACTIVE_KEY, String(now));
  } catch {
    // 저장이 막혀도 이 탭의 타이머로 잠근다.
  }
}

export function lastActive(): number {
  try {
    const value = Number(window.localStorage.getItem(LAST_ACTIVE_KEY));
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

export function setLocked(locked: boolean): void {
  try {
    if (locked) window.localStorage.setItem(LOCKED_KEY, "1");
    else window.localStorage.removeItem(LOCKED_KEY);
  } catch {
    // 위와 같다.
  }
}

export function isLockedStored(): boolean {
  try {
    return window.localStorage.getItem(LOCKED_KEY) === "1";
  } catch {
    return false;
  }
}
