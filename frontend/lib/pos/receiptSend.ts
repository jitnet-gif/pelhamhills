/**
 * 결제한 계산서의 영수증을 손님 휴대폰(문자)과 이메일로 — 현금·카드 모두(2026-10-26).
 *
 * Twilio 키와 메일 계정은 FastAPI(Fly) 에만 있어서 그쪽 `/pos/receipts/{bill}/…` 를 직원 토큰으로 부른다
 * (`backend/api/routes/receipts.py`). 영수증 내용은 서버가 계산서에서 다시 읽는다 — 화면이 보낸 글을 쓰지 않는다.
 */

import { paymentsApiBase } from "@/lib/booking/payments";
import { ApiError } from "@/lib/teeSheet/api";
import { accessToken } from "@/lib/teeSheet/session";

export type ReceiptContact = {
  /** 계산서에 담긴 예약의 번호·이메일. 없으면 빈 문자열. */
  phone: string;
  email: string;
  /** 서버에 Twilio·메일 계정이 있는가. */
  can_text: boolean;
  can_email: boolean;
};

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await accessToken();
  if (!token) throw new ApiError(401, "Sign in again to send the receipt.");
  let response: Response;
  try {
    response = await fetch(`${paymentsApiBase()}/pos/receipts/${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    });
  } catch {
    throw new ApiError(0, "Can't reach the server. Try again in a moment.");
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
      message = "Sending receipts is not on the server yet. Deploy the API (Fly) first.";
    }
    throw new ApiError(response.status, message);
  }
  return (await response.json()) as T;
}

export function receiptContact(billId: number): Promise<ReceiptContact> {
  return call<ReceiptContact>(`${billId}/contact`);
}

export function sendReceipt(billId: number, to: { phone?: string; email?: string }): Promise<unknown> {
  return call(`${billId}/send`, {
    method: "POST",
    body: JSON.stringify({ phone: to.phone?.trim() ?? "", email: to.email?.trim() ?? "" }),
  });
}
