/**
 * 계산대 담당자 코드 — Cashier 칸에 pelham-shift 직원 ID(숫자 4~8자리)를 치면 그 직원 이름으로 바꾼다.
 * FastAPI(`backend/api/routes/cashier_code.py`)가 직원 확인 뒤 pelham-shift 에 묻는다.
 * 번호는 pelham-shift 의 로그인 비밀번호이기도 하므로 계산서·이 기기 어디에도 적지 않는다 — 이름만 남는다.
 */

import { paymentsApiBase } from "@/lib/booking/payments";
import { ApiError } from "@/lib/teeSheet/api";
import { accessToken } from "@/lib/teeSheet/session";

/** 직원 ID 모양인가(pelham-shift 와 같은 규칙). */
export function isShiftCode(value: string): boolean {
  return /^\d{4,8}$/.test(value.trim());
}

export async function cashierForCode(code: string): Promise<string> {
  const token = await accessToken();
  if (!token) throw new ApiError(401, "Sign in again to use a staff ID.");
  let response: Response;
  try {
    response = await fetch(`${paymentsApiBase()}/pos/cashier-code`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ code: code.trim() }),
    });
  } catch {
    throw new ApiError(0, "Can't reach the server. Type your name instead.");
  }
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`.trim();
    try {
      const body = (await response.json()) as { detail?: unknown };
      if (typeof body?.detail === "string" && body.detail) message = body.detail;
    } catch {
      // JSON 이 아닌 오류 본문.
    }
    // 경로 자체가 없으면 FastAPI 기본 "Not Found" — 서버가 아직 옛 배포다.
    if (response.status === 404 && message === "Not Found") {
      message = "Staff IDs are not on the server yet. Deploy the API (Fly) first, or type your name.";
    }
    throw new ApiError(response.status, message);
  }
  const body = (await response.json()) as { name?: unknown };
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!name) throw new ApiError(404, "No staff member has that Pelham Shift ID.");
  return name;
}
