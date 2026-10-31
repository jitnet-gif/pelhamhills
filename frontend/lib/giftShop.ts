/**
 * 기프트카드 온라인 판매(0144, `backend/api/routes/gift_orders.py`). 손님 쪽 호출만 있다.
 * 금액 검사는 서버가 한다. 여기 있는 숫자는 화면 안내용이다.
 */

import { paymentsApiBase } from "@/lib/booking/payments";
import { ApiError } from "@/lib/teeSheet/api";

export const GIFT_MIN_DOLLARS = 10;
export const GIFT_MAX_DOLLARS = 1000;
export const GIFT_PRESETS = [25, 50, 100, 200];

export type GiftOrder = {
  /** 센트. */
  amount: number;
  buyer_name: string;
  buyer_email: string;
  buyer_phone: string;
  recipient: string;
  recipient_email: string;
  recipient_phone: string;
};

export type GiftOrderResult = {
  invoice: string;
  amount: number;
  status: "pending" | "approved" | "declined" | "error" | "orphaned" | "refunded";
  card_brand?: string | null;
  card_last4?: string | null;
  recipient?: string | null;
  /** 승인된 주문에만 있다. */
  code?: string | null;
  reversed?: "void" | "refund";
  reversal_failed?: boolean;
};

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${paymentsApiBase()}/payments/gift-card${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
  } catch {
    throw new ApiError(0, "Network error");
  }
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`.trim();
    try {
      const body = (await response.json()) as { detail?: unknown };
      if (typeof body?.detail === "string" && body.detail) message = body.detail;
    } catch {
      // JSON 이 아닌 오류 본문. 상태 줄을 그대로 쓴다.
    }
    throw new ApiError(response.status, message);
  }
  return (await response.json()) as T;
}

/** 주문을 만들고 Stripe 결제 페이지로 넘어간다. */
export async function startGiftCheckout(order: GiftOrder): Promise<void> {
  const { url } = await call<{ url: string }>("/checkout", { method: "POST", body: JSON.stringify(order) });
  if (!/^https:\/\/checkout\.stripe\.com\//.test(url)) throw new ApiError(502, "Online payment is not available right now.");
  window.location.assign(url);
}

export function giftOrderStatus(invoice: string): Promise<GiftOrderResult> {
  return call<GiftOrderResult>(`/status/${encodeURIComponent(invoice)}`);
}
