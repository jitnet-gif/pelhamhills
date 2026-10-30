/**
 * 기프트카드(0120) — 매니저가 Gift Cards 화면에서 발행하고, 계산서 결제의 "Gift card" 수단으로 잔액만큼 쓴다.
 * 함수 이름과 인자는 `supabase/migrations/0120_gift_cards.sql` 와 글자 그대로 같다.
 *
 * 결제 때 카드 코드는 결제 줄의 `auth_code` 로 간다. 서버 트리거가 그 코드로 카드를 잠그고 잔액을 판정한다.
 * 화면이 보여 주는 잔액은 안내일 뿐이다.
 */

import { useEffect, useState } from "react";

import { paymentsApiBase } from "@/lib/booking/payments";
import { ApiError } from "@/lib/teeSheet/api";
import { accessToken } from "@/lib/teeSheet/session";
import { staffRpc } from "@/lib/teeSheet/staffRpc";
import { clubDateTime, type ReceiptBlock, type ReceiptHeader } from "@/lib/retail/receipt";
import { formatMoney, type Cents } from "@/lib/retail/types";

export type GiftCardUse = {
  receipt_no: string | null;
  amount: Cents;
  /** refunded 면 그 돈은 카드로 돌아왔다. */
  status: "paid" | "refunded";
  paid_at: string | null;
};

export type GiftCard = {
  id: number;
  /** 바코드 값. `GIFT-` + 16진 10자. */
  code: string;
  /** 발행 금액. */
  amount: Cents;
  used: Cents;
  balance: Cents;
  kind: "sold" | "complimentary";
  status: "active" | "void";
  recipient: string | null;
  phone: string | null;
  email: string | null;
  note: string | null;
  issued_email: string | null;
  issued_on: string;
  issued_at: string;
  /** `YYYY-MM-DD`(0139). 비면 No expiry. */
  expires_on: string | null;
  /** 결제가 막히는가. 판매 카드는 날짜가 지나도 false 다(온타리오법, 0139). */
  expired: boolean;
  void_reason: string | null;
  voided_at: string | null;
  uses: GiftCardUse[];
};

export type GiftCardIssue = {
  amount: Cents;
  kind: GiftCard["kind"];
  recipient?: string;
  phone?: string;
  email?: string;
  note: string;
  expires_on?: string;
};

export const giftCardApi = {
  access: () => staffRpc<boolean>("pelham_gift_card_access"),
  list: () => staffRpc<GiftCard[]>("pelham_staff_gift_cards"),
  byCode: (code: string) => staffRpc<GiftCard>("pelham_staff_gift_card", { p_code: code }),
  issue: (fields: GiftCardIssue) => staffRpc<GiftCard>("pelham_staff_gift_card_issue", { p: fields }),
  void: (code: string, reason: string) =>
    staffRpc<GiftCard>("pelham_staff_gift_card_void", { p_code: code, p_reason: reason }),
  setExpiry: (code: string, expires: string | null) =>
    staffRpc<GiftCard>("pelham_staff_gift_card_set_expiry", { p_code: code, p_expires: expires }),
  text: (code: string, phone: string) => sendGiftCard(code, "text", { phone }),
  email: (code: string, email: string) => sendGiftCard(code, "email", { email }),
};

/**
 * 카드를 손님에게 — `text` 는 바코드 그림을 붙인 문자, `email` 은 종이 상품권(Gift Certificate) 양식의 메일.
 * Twilio·SMTP 키는 FastAPI(Fly) 에만 있어서 그쪽 `/gift-cards/{code}/text|email` 을 직원 토큰으로 부른다
 * (`backend/api/routes/gift_cards.py`).
 */
async function sendGiftCard(
  code: string,
  how: "text" | "email",
  payload: { phone: string } | { email: string },
): Promise<{ to: string }> {
  const token = await accessToken();
  if (!token) throw new ApiError(401, "Sign in with a staff account.");
  let response: Response;
  try {
    response = await fetch(`${paymentsApiBase()}/gift-cards/${encodeURIComponent(code)}/${how}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    throw new ApiError(0, "Could not reach the server.");
  }
  const body = (await response.json().catch(() => null)) as { detail?: unknown; to?: string } | null;
  if (!response.ok) {
    const detail = typeof body?.detail === "string" && body.detail ? body.detail : `${response.status}`;
    throw new ApiError(response.status, detail);
  }
  return { to: body?.to ?? Object.values(payload)[0] };
}

/** 메뉴에 Gift Cards 를 띄울 계정인가(매니저·계정 관리자, proshop@ 제외). 막는 것은 서버다. */
const known = new Map<string, boolean>();

export function useGiftCardAccess(email: string): boolean | null {
  const [allowed, setAllowed] = useState<boolean | null>(() => known.get(email) ?? null);

  useEffect(() => {
    if (known.has(email)) return;
    let cancelled = false;
    giftCardApi
      .access()
      .then((value) => {
        known.set(email, value);
        if (!cancelled) setAllowed(value);
      })
      .catch(() => {
        // 0120 전이거나 서버가 안 받는다 — 메뉴를 숨긴다.
        if (!cancelled) setAllowed(false);
      });
    return () => {
      cancelled = true;
    };
  }, [email]);

  return allowed;
}

/** 카드 코드. 스캐너가 소문자로 보내도 받는다. */
export const GIFT_CARD_CODE = /^GIFT-[0-9A-F]{10}$/i;

export function isGiftCardCode(raw: string): boolean {
  return GIFT_CARD_CODE.test(raw.trim());
}

/** 만료일 글자: `Dec 31, 2027`, 없으면 `No expiry`. */
export function expiryText(card: Pick<GiftCard, "expires_on">): string {
  if (!card.expires_on) return "No expiry";
  return new Date(`${card.expires_on}T12:00:00`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** 영수증·결제 줄에 찍는 카드 번호. 전체 코드는 돈과 같으므로 끝 4자만. */
export function maskGiftCard(code: string): string {
  return `Gift card ****${code.slice(-4)}`;
}

/** 0120 이 아직 이 프로젝트에 없다(PostgREST `PGRST202`). */
export function isGiftCardMissing(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 404 &&
    /could not find the function|PGRST202|schema cache/i.test(error.message)
  );
}

export function describeGiftCardError(error: unknown): string {
  if (isGiftCardMissing(error)) {
    return "기프트카드 기능이 아직 켜지지 않았습니다. Supabase SQL Editor 에서 0120_gift_cards.sql 을 실행해 주세요.";
  }
  if (error instanceof ApiError) {
    if (error.status === 0) return "서버에 연결할 수 없습니다. 인터넷 연결을 확인하고 다시 시도해 주세요.";
    return error.message;
  }
  return "알 수 없는 오류가 났습니다. 다시 시도해 주세요.";
}

// ===== 카드 한 장 ========================================================

/**
 * 감열 프린터로 찍는 카드 한 장. 영수증과 같은 렌더러를 쓰지만 판매 영수증처럼 보이지 않게 한다.
 * 바코드에는 코드가 그대로 들어간다. 계산서 결제 칸에서 이것을 쏘면 그 카드가 잡힌다.
 */
export function giftCardBlocks(card: GiftCard, options: { header: ReceiptHeader; reprint?: boolean }): ReceiptBlock[] {
  const { header } = options;
  const blocks: ReceiptBlock[] = [{ kind: "logo" }];
  blocks.push({ kind: "text", text: header.name, align: "center", bold: true, large: true });
  for (const line of header.addressLines ?? []) blocks.push({ kind: "text", text: line, align: "center" });
  if (header.phone) blocks.push({ kind: "text", text: header.phone, align: "center" });

  blocks.push({ kind: "text", text: "GIFT CARD", align: "center", bold: true, large: true, gap: true });
  blocks.push({ kind: "text", text: `Issued ${clubDateTime(card.issued_on, card.issued_at)}`, align: "center" });
  if (options.reprint) blocks.push({ kind: "text", text: "*** REPRINT ***", align: "center", bold: true });
  if (card.status === "void") blocks.push({ kind: "text", text: "*** VOID ***", align: "center", bold: true });

  blocks.push({ kind: "field", label: "Card", value: card.code, gap: true });
  if (card.recipient) blocks.push({ kind: "field", label: "For", value: card.recipient });
  blocks.push({ kind: "rule" });
  blocks.push({ kind: "total", label: "Value", amount: formatMoney(card.amount) });
  if (card.used > 0) blocks.push({ kind: "total", label: "Balance", amount: formatMoney(card.balance), bold: true });
  blocks.push({
    kind: "text",
    text: `Use it for green fees, the pro shop and the snack bar. Any amount left stays on the card. ${card.expires_on ? `Expires ${expiryText(card)}` : "No expiry"}. Not redeemable for cash. Keep it safe — anyone with this barcode can spend it.`,
    align: "center",
    gap: true,
  });
  blocks.push({ kind: "barcode", value: card.code });
  return blocks;
}

// ===== 스캔 전달 ========================================================

/**
 * 계산대·티 시트의 스캐너가 기프트카드 코드를 받으면 여기로 보내고, 계산서의 결제 칸이 받는다.
 * 레인체크(`rainCheck.ts`)와 같은 작은 우편함이다 — 듣는 칸 전부에 보내고, 없으면 맡겨 둔다.
 */
let pendingCode: string | null = null;
const listeners = new Set<(code: string) => void>();

export function offerGiftCardCode(raw: string): void {
  const code = raw.trim().toUpperCase();
  if (listeners.size === 0) {
    pendingCode = code;
    return;
  }
  pendingCode = null;
  listeners.forEach((listener) => listener(code));
}

/** 맡겨 둔 코드를 꺼낸다(한 번만). */
export function takeGiftCardCode(): string | null {
  const code = pendingCode;
  pendingCode = null;
  return code;
}

export function subscribeGiftCardCode(listener: (code: string) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
