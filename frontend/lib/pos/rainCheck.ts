/**
 * 레인체크(0011) — 비로 라운드를 다 못 친 손님에게 **사람마다** 한 장씩 주는 크레딧 전표.
 * 함수 이름과 인자는 `supabase/migrations/0011_rain_checks.sql` 와 글자 그대로 같다.
 *
 * 발행은 티 시트의 플레이어 카드에서, 사용은 계산서 결제의 "Rain check" 수단에서 한다.
 * 금액·만료일·사용 여부는 전부 서버가 판정한다. 화면이 보여 주는 "만료됨"은 안내일 뿐이다.
 */

import { paymentsApiBase } from "@/lib/booking/payments";
import { ApiError } from "@/lib/teeSheet/api";
import { addDays } from "@/lib/teeSheet/dates";
import { accessToken } from "@/lib/teeSheet/session";
import { staffRpc } from "@/lib/teeSheet/staffRpc";
import { clubDateTime, usDate, type ReceiptBlock, type ReceiptHeader } from "@/lib/retail/receipt";
import { formatMoney, type Cents } from "@/lib/retail/types";

export type RainCheck = {
  id: number;
  /** 전표 바코드 값. `RC-` + 16진 10자. */
  code: string;
  status: "issued" | "redeemed" | "void";
  /** 발행됨인데 만료일이 지났다(매장 현지 날짜 기준). */
  expired: boolean;
  booking_id: string;
  player_id: string;
  player_name: string;
  tee_date: string | null;
  tee_time: string | null;
  holes: number | null;
  holes_played: number | null;
  /** 크레딧(센트, 세금 포함). */
  amount: Cents;
  /** 그 사람이 낸 돈(발행 당시). 크레딧의 상한. */
  paid_value: Cents;
  source_receipt: string | null;
  issued_on: string;
  expires_on: string;
  cashier: string | null;
  note: string | null;
  issued_at: string;
  redeemed_receipt: string | null;
  redeemed_at: string | null;
  void_reason: string | null;
  voided_at: string | null;
};

export type RainCheckQuote = {
  player_name: string;
  paid: boolean;
  paid_value: Cents;
  source_receipt: string | null;
  issued_on: string;
  default_expires_on: string;
  existing: RainCheck | null;
};

export type RainCheckIssue = {
  booking_id: string;
  player_id: string;
  amount?: Cents;
  expires_on?: string;
  holes_played?: number | null;
  cashier?: string;
  note?: string;
};

export const rainCheckApi = {
  quote: (booking: string, player: string) =>
    staffRpc<RainCheckQuote>("pelham_staff_rain_check_quote", { p_booking: booking, p_player: player }),
  issue: (fields: RainCheckIssue) => staffRpc<RainCheck>("pelham_staff_rain_check_issue", { p: fields }),
  forBooking: (booking: string) => staffRpc<RainCheck[]>("pelham_staff_rain_checks", { p_booking: booking }),
  /** 티 시트 격자의 ☂(0064). 티타임 날짜 기준, 무효 제외. */
  between: (from: string, to: string) =>
    staffRpc<RainCheck[]>("pelham_staff_rain_checks_between", { p_from: from, p_to: to }),
  byCode: (code: string) => staffRpc<RainCheck>("pelham_staff_rain_check", { p_code: code }),
  void: (code: string, reason: string) =>
    staffRpc<RainCheck>("pelham_staff_rain_check_void", { p_code: code, p_reason: reason }),
  text: textRainCheck,
  /** Reports 의 Rain checks 탭(0062). 발행일 기준. */
  report: (from: string, to: string) =>
    staffRpc<RainCheckReport>("pelham_staff_rain_check_report", { p_from: from, p_to: to }),
};

/** 리포트 한 줄 — 전표 + 마지막으로 보낸 문자(0058 기록). */
export type RainCheckReportRow = RainCheck & {
  texted_to: string | null;
  texted_at: string | null;
  text_status: string | null;
  text_count: number;
};

export type RainCheckReport = {
  from: string;
  to: string;
  today: string;
  rows: RainCheckReportRow[];
  /** 기간과 상관없이 지금 쓸 수 있는 크레딧 전체. */
  outstanding: { count: number; amount: Cents };
};

/**
 * 전표를 손님 휴대폰으로 — 바코드 그림을 붙인 문자. Twilio 키는 FastAPI(Fly) 에만 있어서
 * 그쪽 `/rain-checks/{code}/text` 를 직원 토큰으로 부른다(`backend/api/routes/rain_checks.py`).
 */
async function textRainCheck(code: string, phone: string): Promise<{ to: string }> {
  const token = await accessToken();
  if (!token) throw new ApiError(401, "Sign in with a pro shop account.");
  let response: Response;
  try {
    response = await fetch(`${paymentsApiBase()}/rain-checks/${encodeURIComponent(code)}/text`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ phone }),
    });
  } catch {
    throw new ApiError(0, "Could not reach the server.");
  }
  const body = (await response.json().catch(() => null)) as { detail?: unknown; to?: string } | null;
  if (!response.ok) {
    const detail = typeof body?.detail === "string" && body.detail ? body.detail : `${response.status}`;
    throw new ApiError(response.status, detail);
  }
  return { to: body?.to ?? phone };
}

// ===== 바뀌었다는 신호 ==================================================
// 발행·무효 뒤 같은 탭(격자)과 같은 브라우저의 다른 탭(Reports → Rain checks)이 다시 읽게 한다.
// BroadcastChannel 은 보낸 탭 자신에게는 오지 않으므로 같은 탭은 window 이벤트로 따로 알린다.
// 다른 컴퓨터에서 낸 것은 신호가 오지 않으니 탭으로 돌아올 때(visibilitychange) 다시 읽는다.

const CHANGED_CHANNEL = "pelham-rain-checks";
const CHANGED_EVENT = "pelham:rain-checks-changed";

export function announceRainChecksChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(CHANGED_EVENT));
  try {
    const channel = new BroadcastChannel(CHANGED_CHANNEL);
    channel.postMessage("changed");
    channel.close();
  } catch {
    // BroadcastChannel 이 없는 브라우저 — 다른 탭은 돌아올 때 다시 읽는다.
  }
}

/** 레인체크가 바뀌었을 수 있을 때마다 `listener`. 돌려준 함수로 끊는다. */
export function onRainChecksChanged(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const onVisible = () => {
    if (document.visibilityState === "visible") listener();
  };
  window.addEventListener(CHANGED_EVENT, listener);
  document.addEventListener("visibilitychange", onVisible);
  let channel: BroadcastChannel | null = null;
  try {
    channel = new BroadcastChannel(CHANGED_CHANNEL);
    channel.onmessage = listener;
  } catch {
    channel = null;
  }
  return () => {
    window.removeEventListener(CHANGED_EVENT, listener);
    document.removeEventListener("visibilitychange", onVisible);
    channel?.close();
  };
}

/** 전표 코드. 스캐너가 소문자로 보내도 받는다. 티 시트 영수증 번호(`XXXX-XXXX`)와 겹치지 않는다. */
export const RAIN_CHECK_CODE = /^RC-[0-9A-F]{10}$/i;

export function isRainCheckCode(raw: string): boolean {
  return RAIN_CHECK_CODE.test(raw.trim());
}

/** 0011 이 아직 이 프로젝트에 없다(PostgREST `PGRST202`). */
export function isRainCheckMissing(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 404 &&
    /could not find the function|PGRST202|schema cache/i.test(error.message)
  );
}

export const RAIN_CHECK_MISSING_MESSAGE =
  "레인체크 기능이 아직 켜지지 않았습니다. Supabase SQL Editor 에서 0011_rain_checks.sql 을 실행해 주세요.";

export function describeRainCheckError(error: unknown): string {
  if (isRainCheckMissing(error)) return RAIN_CHECK_MISSING_MESSAGE;
  if (error instanceof ApiError) {
    if (error.status === 0) return "서버에 연결할 수 없습니다. 인터넷 연결을 확인하고 다시 시도해 주세요.";
    return error.message;
  }
  return "알 수 없는 오류가 났습니다. 다시 시도해 주세요.";
}

// ===== 전표 ============================================================

/**
 * 전표 한 장의 블록. 영수증과 같은 블록·같은 렌더러(`receiptHtml`)를 쓰지만 **판매 영수증처럼
 * 보이지 않게** 한다 — "Sales Receipt"·HST·PAYMENTS 가 찍힌 종이는 환불 청구서로 읽힌다.
 * 바코드에는 코드가 그대로 들어간다. 계산서 결제 칸에서 이것을 쏘면 그 크레딧이 잡힌다.
 */
export function rainCheckBlocks(
  check: RainCheck,
  options: { header: ReceiptHeader; reprint?: boolean; sample?: boolean },
): ReceiptBlock[] {
  const { header } = options;
  const blocks: ReceiptBlock[] = [{ kind: "logo" }];
  blocks.push({ kind: "text", text: header.name, align: "center", bold: true, large: true });
  for (const line of header.addressLines ?? []) blocks.push({ kind: "text", text: line, align: "center" });
  if (header.phone) blocks.push({ kind: "text", text: header.phone, align: "center" });

  blocks.push({ kind: "text", text: "RAIN CHECK", align: "center", bold: true, large: true, gap: true });
  blocks.push({ kind: "text", text: `Issued ${clubDateTime(check.issued_on, check.issued_at)}`, align: "center" });
  if (options.sample) blocks.push({ kind: "text", text: SAMPLE_MARK, align: "center", bold: true });
  if (options.reprint) blocks.push({ kind: "text", text: "*** REPRINT ***", align: "center", bold: true });
  if (check.status === "void") blocks.push({ kind: "text", text: "*** VOID ***", align: "center", bold: true });
  if (check.status === "redeemed") blocks.push({ kind: "text", text: "*** USED ***", align: "center", bold: true });

  blocks.push({ kind: "field", label: "Rain check", value: check.code, gap: true });
  blocks.push({ kind: "field", label: "Name", value: check.player_name });
  if (check.tee_date) {
    const round = `${usDate(check.tee_date)} ${(check.tee_time ?? "").toLowerCase()}`.trim();
    blocks.push({ kind: "field", label: "Round", value: check.holes ? `${round} (${check.holes} holes)` : round });
  }
  if (check.holes_played !== null) {
    blocks.push({ kind: "field", label: "Holes played", value: String(check.holes_played) });
  }
  if (check.source_receipt) blocks.push({ kind: "field", label: "Paid on", value: check.source_receipt });
  if (check.cashier) blocks.push({ kind: "field", label: "Employee", value: check.cashier });

  blocks.push({ kind: "rule" });
  blocks.push({ kind: "total", label: "Credit (HST incl.)", amount: formatMoney(check.amount), bold: true });
  blocks.push({
    kind: "text",
    text: `Valid through ${usDate(check.expires_on)}`,
    align: "center",
    bold: true,
    large: true,
    gap: true,
  });
  blocks.push({
    kind: "text",
    text: "One use. Bring this slip to the pro shop. Not redeemable for cash. Any credit left over is not refunded.",
    align: "center",
  });
  if (check.note) blocks.push({ kind: "text", text: `Note: ${check.note}`, align: "left" });

  if (options.sample) blocks.push({ kind: "text", text: SAMPLE_MARK, align: "center", bold: true, gap: true });
  blocks.push({ kind: "barcode", value: check.code });
  return blocks;
}

const SAMPLE_MARK = "*** SAMPLE - NOT VALID ***";

/**
 * 전표 견본(Reports → Rain checks 의 Sample). 서버에 없는 가짜 전표다 — 코드의 S·M·P·L 은 16진수가
 * 아니라 `RAIN_CHECK_CODE` 에 맞지 않으므로 바코드를 쏴도 크레딧으로 잡히지 않는다.
 * 만료일은 기본값(발행일 + 180일, 0044)과 같게 둔다.
 */
export function sampleRainCheck(today: string): RainCheck {
  return {
    id: 0,
    code: "RC-SAMPLE0001",
    status: "issued",
    expired: false,
    booking_id: "sample",
    player_id: "sample",
    player_name: "Sample Guest",
    tee_date: today,
    tee_time: "9:00 AM",
    holes: 18,
    holes_played: 7,
    amount: 6500,
    paid_value: 6500,
    source_receipt: "SAMPLE",
    issued_on: today,
    expires_on: addDays(today, 180),
    cashier: "Pro Shop",
    note: "Rain, stopped at hole 7",
    issued_at: new Date().toISOString(),
    redeemed_receipt: null,
    redeemed_at: null,
    void_reason: null,
    voided_at: null,
  };
}

// ===== 스캔 전달 ========================================================

/**
 * 계산대·티 시트의 스캐너가 레인체크 코드를 받으면 여기로 보내고, 계산서의 결제 칸이 받는다.
 * 두 컴포넌트가 서로를 모르게 하는 작은 우편함이다.
 *
 * 듣는 결제 칸 **전부**에 보낸다. 계산대는 계산서를 데스크톱 옆칸과 휴대폰 시트에 두 번 그리므로,
 * 한 곳에만 주면 숨은 쪽이 받아 가고 보이는 쪽은 가만히 있을 수 있다. 각자 찾아도 해가 없다.
 * 듣는 칸이 하나도 없으면(티 시트 서랍이 아직 안 열렸다) 맡겨 두었다가 처음 열리는 칸이 가져간다.
 */
let pendingCode: string | null = null;
const listeners = new Set<(code: string) => void>();

export function offerRainCheckCode(raw: string): void {
  const code = raw.trim().toUpperCase();
  if (listeners.size === 0) {
    pendingCode = code;
    return;
  }
  pendingCode = null;
  listeners.forEach((listener) => listener(code));
}

/** 맡겨 둔 코드를 꺼낸다(한 번만). */
export function takeRainCheckCode(): string | null {
  const code = pendingCode;
  pendingCode = null;
  return code;
}

export function subscribeRainCheckCode(listener: (code: string) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
