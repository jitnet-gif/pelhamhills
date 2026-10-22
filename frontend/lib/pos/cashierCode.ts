/**
 * 계산대 담당자 코드 — Cashier 칸에 pelham-shift 직원 ID(숫자 4~8자리)를 치면 그 직원 이름으로 바꾼다.
 * FastAPI(`backend/api/routes/cashier_code.py`)가 직원 확인 뒤 pelham-shift 에 묻는다.
 * 번호는 pelham-shift 의 로그인 비밀번호이기도 하므로 계산서·이 기기 어디에도 적지 않는다 — 이름만 남는다.
 *
 * 승인(0077)도 같은 번호로 한다 — `approveByShiftId`. 환불·가격 변경 같은 막힌 일을 그 직원 이름으로 승인한다.
 */

import { paymentsApiBase } from "@/lib/booking/payments";
import { ApiError } from "@/lib/teeSheet/api";
import { accessToken } from "@/lib/teeSheet/session";

/** 직원 ID 모양인가(pelham-shift 와 같은 규칙). */
export function isShiftCode(value: string): boolean {
  return /^\d{4,8}$/.test(value.trim());
}

async function postShift(path: string, body: Record<string, string>): Promise<unknown> {
  const token = await accessToken();
  if (!token) throw new ApiError(401, "Sign in again to use a staff ID.");
  let response: Response;
  try {
    response = await fetch(`${paymentsApiBase()}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "Can't reach the server. Type your name instead.");
  }
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`.trim();
    try {
      const detail = ((await response.json()) as { detail?: unknown })?.detail;
      if (typeof detail === "string" && detail) message = detail;
    } catch {
      // JSON 이 아닌 오류 본문.
    }
    // 경로 자체가 없으면 FastAPI 기본 "Not Found" — 서버가 아직 옛 배포다.
    if (response.status === 404 && message === "Not Found") {
      message = "Staff IDs are not on the server yet. Deploy the API (Fly) first, or type your name.";
    }
    throw new ApiError(response.status, message);
  }
  return response.json();
}

export async function cashierForCode(code: string): Promise<string> {
  const body = (await postShift("/pos/cashier-code", { code: code.trim() })) as { name?: unknown };
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!name) throw new ApiError(404, "No staff member has that Pelham Shift ID.");
  return name;
}

/** 칸에 친 값 → 담당자 이름. 번호면 pelham-shift 에 묻고, 이름이면 그대로(공백 정리). 못 쓰면 문장을 던진다. */
export async function cashierName(entry: string): Promise<string> {
  const text = entry.trim().replace(/\s+/g, " ");
  if (!text) throw new ApiError(422, "Enter your Pelham Shift ID or name.");
  return isShiftCode(text) ? cashierForCode(text) : text;
}

/** 막힌 일(0024)을 이 직원 ID 로 승인한다. 틀린 번호면 `approved: false` 와 문장. */
export async function approveByShiftId(
  code: string,
  action: string,
  ref: string,
): Promise<{ approved: boolean; name?: string; message?: string }> {
  const body = (await postShift("/pos/approve", { code: code.trim(), action, ref })) as {
    approved?: unknown;
    name?: unknown;
    message?: unknown;
  };
  return {
    approved: body?.approved === true,
    name: typeof body?.name === "string" ? body.name : undefined,
    message: typeof body?.message === "string" ? body.message : undefined,
  };
}
