/**
 * 손님 온라인 결제(Authorize.net)의 통로. 예약 자체는 `rpc.ts`(Supabase 함수)로 하지만, 결제는 카드사
 * 키가 필요해서 **FastAPI(Fly)** 의 `/payments/online/*` 로 간다(`backend/api/routes/payments.py`).
 *
 * - 금액은 서버(SQL 0020)가 정한다. 화면은 받은 금액을 보여 주기만 한다.
 * - 카드 입력은 Authorize.net 이 호스팅하는 결제 폼에서 한다. 이 사이트는 카드 번호를 보지 않는다.
 *   `checkout()` 이 받은 토큰을 숨은 폼으로 Authorize.net 에 POST 하면 그 페이지로 넘어간다.
 * - 결제 뒤 손님은 `/book/pay?invoice=…` 로 돌아온다. 결과는 그 화면이 서버에 물어서 보여 준다.
 *
 * API 주소: `NEXT_PUBLIC_PAYMENTS_API_URL` 이 있으면 그것. 없으면 로컬에서 연 페이지는 `lib/apiHost.ts`
 * 의 주소(개발 서버), 배포된 페이지는 운영 Fly 앱. `NEXT_PUBLIC_API_URL` 을 그대로 믿지 않는 이유:
 * Vercel 에 남은 값이 꺼진 옛 앱(`pelhamhills-api`)을 가리킬 수 있다(fly.toml, 2026-10-06 이름 변경).
 * 예약 rpc 가 공개 키를 코드에 두는 것과 같은 생각이다 — 환경변수 없이 배포한 날 결제가 조용히 꺼지지 않게.
 */

import { apiBaseUrl } from "@/lib/apiHost";
import { ApiError } from "@/lib/teeSheet/api";

const PRODUCTION_API = "https://pelham-hills-api.fly.dev/api/v1";

function base(): string {
  const explicit = (process.env.NEXT_PUBLIC_PAYMENTS_API_URL ?? "").trim().replace(/\/+$/, "");
  if (explicit) return explicit;
  const local =
    typeof window !== "undefined" && /^(localhost|127\.0\.0\.1)$/i.test(window.location.hostname);
  return (local && apiBaseUrl()) || PRODUCTION_API;
}

/** 센트 → "$108.01" */
export function money(cents: number | null | undefined): string {
  return `$${((cents ?? 0) / 100).toFixed(2)}`;
}

export type OnlinePayment = {
  invoice: string;
  kind: "tee" | "sim";
  confirmation_code: string;
  description: string;
  subtotal: number;
  tax: number;
  amount: number;
  status: "pending" | "approved" | "declined" | "error" | "held" | "orphaned" | "voided" | "refunded";
  card_brand?: string | null;
  card_last4?: string | null;
  receipt_no?: string | null;
  refund_kind?: "void" | "refund" | null;
  refund_pending?: boolean;
  approved_at?: string | null;
  refunded_at?: string | null;
  reversed?: "void" | "refund";
  reversal_failed?: boolean;
};

export type PaymentQuote =
  | { enabled: false }
  | {
      enabled: true;
      kind: "tee" | "sim";
      confirmation_code: string;
      description: string;
      payable: boolean;
      reason: string | null;
      lines: Array<{ name: string; amount: number }>;
      subtotal: number;
      tax: number;
      total: number;
      payment: OnlinePayment | null;
      cancel_refund: { allowed: boolean; reason: string | null } | null;
    };

export type Credentials = { code: string; email: string };

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${base()}/payments/online${path}`, {
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

export function quotePayment(creds: Credentials): Promise<PaymentQuote> {
  return call<PaymentQuote>("/quote", { method: "POST", body: JSON.stringify(creds) });
}

export function paymentStatus(invoice: string): Promise<OnlinePayment> {
  return call<OnlinePayment>(`/status/${encodeURIComponent(invoice)}`);
}

export function cancelAndRefund(
  creds: Credentials,
): Promise<OnlinePayment & { booking_cancelled: boolean }> {
  return call("/cancel", { method: "POST", body: JSON.stringify(creds) });
}

/**
 * 결제 폼을 연다. 서버가 금액을 정하고 Authorize.net 토큰을 받아 오면, 숨은 폼으로 그 결제 페이지에
 * POST 한다(이 탭이 Authorize.net 으로 넘어간다). 토큰은 15분 유효하다.
 */
export async function startCheckout(creds: Credentials): Promise<void> {
  const { form_url, token } = await call<{ form_url: string; token: string; invoice: string }>("/checkout", {
    method: "POST",
    body: JSON.stringify(creds),
  });
  const form = document.createElement("form");
  form.method = "POST";
  form.action = form_url;
  form.style.display = "none";
  const input = document.createElement("input");
  input.type = "hidden";
  input.name = "token";
  input.value = token;
  form.appendChild(input);
  document.body.appendChild(form);
  form.submit();
}
