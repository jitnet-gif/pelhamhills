/**
 * 통화 기록(Calls & SMS 화면)의 통로. 원본은 ElevenLabs 이고 FastAPI(Fly) 의 `/calls` 가 직원 확인 뒤
 * 대신 읽어 온다(`backend/api/routes/calls.py`). API 키를 브라우저에 둘 수 없어서다.
 */

import { paymentsApiBase } from "@/lib/booking/payments";
import { CLUB_TIME_ZONE } from "@/lib/retail/receipt";
import { ApiError } from "@/lib/teeSheet/api";
import { accessToken } from "@/lib/teeSheet/session";

export type CallOutcome = "booked" | "modified" | "cancelled" | "waitlist" | "lost_item" | "transferred" | "info";

export type CallRow = {
  id: string;
  started_at: number | null;
  duration: number | null;
  status: string | null;
  successful: string | null;
  title: string;
  summary: string;
  tools: string[];
  outcome: CallOutcome;
};

export type CallBooking = {
  kind: "tee" | "sim";
  action: "booked" | "modified" | "cancelled";
  booking_id: string;
  date: string | null;
  time: string | null;
  name: string | null;
  confirmation_code: string | null;
  party_size: number | null;
};

export type CallTurn = {
  role: "agent" | "user" | string;
  message: string;
  at: number | null;
  tool_calls: { name: string; params: string }[];
  tool_results: { name: string; error: boolean; result: string }[];
};

export type CallDetail = {
  id: string;
  status: string | null;
  started_at: number | null;
  duration: number | null;
  termination_reason: string;
  caller: string;
  title: string;
  summary: string;
  successful: string | null;
  has_audio: boolean;
  outcome: CallOutcome;
  bookings: CallBooking[];
  transcript: CallTurn[];
};

async function request(path: string): Promise<Response> {
  const token = await accessToken();
  if (!token) throw new ApiError(401, "Sign in with a pro shop account.");
  let response: Response;
  try {
    response = await fetch(`${paymentsApiBase()}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  } catch {
    throw new ApiError(0, "Could not reach the server.");
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
  return response;
}

export async function fetchCalls(
  cursor?: string | null,
): Promise<{ calls: CallRow[]; next_cursor: string | null; has_more: boolean }> {
  const query = new URLSearchParams({ page_size: "50" });
  if (cursor) query.set("cursor", cursor);
  return (await request(`/calls?${query}`)).json();
}

export async function fetchCall(id: string): Promise<CallDetail> {
  return (await request(`/calls/${encodeURIComponent(id)}`)).json();
}

/** 녹음은 토큰이 있어야 받을 수 있어 `<audio src>` 로 바로 못 건다. blob 주소로 바꿔 준다. */
export async function fetchCallAudioUrl(id: string): Promise<string> {
  const blob = await (await request(`/calls/${encodeURIComponent(id)}/audio`)).blob();
  return URL.createObjectURL(blob);
}

/** 티 시트에서 그 예약을 연 채로 보는 주소. */
export function teeSheetHref(booking: CallBooking): string {
  const query = new URLSearchParams({ booking: booking.booking_id });
  if (booking.date) query.set("date", booking.date);
  return `/teesheet?${query}`;
}

/** 통화가 남긴 예약 중 티 시트로 열 것 — 마지막에 만들거나 바꾼 티타임. 취소만 했으면 그 예약. */
export function teeBookingOf(detail: CallDetail): CallBooking | null {
  const tee = detail.bookings.filter((b) => b.kind === "tee");
  return [...tee].reverse().find((b) => b.action !== "cancelled") ?? tee[tee.length - 1] ?? null;
}

export const OUTCOME_LABEL: Record<CallOutcome, string> = {
  booked: "Booked",
  modified: "Changed",
  cancelled: "Cancelled",
  waitlist: "Waitlist",
  lost_item: "Lost item",
  transferred: "Transferred",
  info: "Inquiry",
};

export function clubDateTime(unix: number | null): string {
  if (!unix) return "";
  return new Date(unix * 1000).toLocaleString("en-CA", {
    timeZone: CLUB_TIME_ZONE,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function clubDay(unix: number | null): string {
  if (!unix) return "";
  return new Date(unix * 1000).toLocaleDateString("en-CA", { timeZone: CLUB_TIME_ZONE });
}

export function duration(seconds: number | null): string {
  if (seconds == null) return "";
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

// ===== 문자 (0058) =====================================================
// `/sms/messages`·`/sms/opt-outs` 도 FastAPI 가 직원 확인 뒤 DB 에서 대신 읽는다(`backend/api/routes/sms.py`).

export type SmsRow = {
  id: string;
  direction: "in" | "out";
  /** 손님 번호(E.164). 보낸 문자는 받는 사람, 받은 문자는 보낸 사람. */
  phone: string;
  body: string;
  template: string | null;
  booking_ref: string | null;
  media_url: string | null;
  status: string | null;
  error: string | null;
  created_at: string;
};

export async function fetchSms(
  options: { phone?: string | null; before?: string | null } = {},
): Promise<{ messages: SmsRow[]; has_more: boolean; source: "db" | "memory" }> {
  const query = new URLSearchParams({ limit: "100" });
  if (options.phone) query.set("phone", options.phone);
  if (options.before) query.set("before", options.before);
  return (await request(`/sms/messages?${query}`)).json();
}

export async function fetchSmsOptOuts(): Promise<{
  opt_outs: { phone: string; created_at: string | null }[];
  source: "db" | "memory";
}> {
  return (await request("/sms/opt-outs")).json();
}

export const SMS_TEMPLATE_LABEL: Record<string, string> = {
  confirm: "Booking confirmed",
  cancel: "Booking cancelled",
  reminder: "Reminder",
  payment_approved: "Payment approved",
  rain_check: "Rain check",
  waitlist_offer: "Waitlist offer",
  lost_item_found: "Lost item found",
  marketing: "Promotion",
  assistant: "Text assistant",
  reply: "Auto reply",
  info_directions: "Info text (directions)",
  info_booking_link: "Info text (booking link)",
};

export function smsTemplateLabel(row: SmsRow): string {
  if (row.direction === "in") return "Guest text";
  if (!row.template) return "Text";
  return SMS_TEMPLATE_LABEL[row.template] ?? (row.template.startsWith("info_") ? "Info text" : row.template);
}

/** +19058921234 → (905) 892-1234 */
export function prettyPhone(e164: string): string {
  const d = e164.replace(/\D/g, "");
  const ten = d.length === 11 && d.startsWith("1") ? d.slice(1) : d;
  return ten.length === 10 ? `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}` : e164;
}

export function isoClubDateTime(iso: string | null): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  return Number.isNaN(t) ? "" : clubDateTime(t / 1000);
}
