/**
 * 고객 마케팅(`/marketing`) — 받는 사람·동의·캠페인 기록은 Supabase 함수(0047), 실제 발송은
 * FastAPI(`backend/api/routes/marketing.py`). Twilio·ElevenLabs 키가 그 서버에만 있어서다.
 * 둘 다 로그인한 계정의 토큰으로 부르고, 명단 밖 계정은 SQL 이 403 으로 거절한다.
 */

import { paymentsApiBase } from "@/lib/booking/payments";
import { ApiError } from "@/lib/teeSheet/api";
import { accessToken } from "@/lib/teeSheet/session";
import { staffRpc } from "@/lib/teeSheet/staffRpc";

export type Channel = "sms" | "call";
export type Segment = "all" | "members" | "non_members" | "regulars" | "new";
export type SkipReason = "no_phone" | "opted_out" | "no_consent";

export type AudienceFilter = {
  segment: Segment;
  min_rounds?: number;
  /** 0129 — 0 이나 빈 값이면 제한 없음. */
  max_rounds?: number;
  search?: string;
  /** 0129 — 주소 도시(여러 개면 그중 하나). 비면 거르지 않는다. */
  city?: string[];
  /** 0129 — 전화 지역번호 세 자리(905·289·416 …). */
  area_code?: string[];
};

export type AudienceCustomer = {
  customer_ref: string;
  name: string;
  phone: string | null;
  /** 0129 — 주소 도시. 주소가 없거나 0129 전이면 없다. */
  city?: string | null;
  is_member: boolean;
  rounds: number;
  sms_ok: boolean | null;
  call_ok: boolean | null;
  ok: boolean;
  reason: SkipReason | null;
};

export type Audience = {
  total: number;
  eligible: number;
  /** 보낼 수 있는 사람 중 서로 다른 번호 수 — 실제로 나가는 문자·전화 수. */
  phones: number;
  no_phone: number;
  opted_out: number;
  no_consent: number;
  customers: AudienceCustomer[];
  /** 0129 — 지금 그룹·라운드·검색 안에서 보낼 수 있는 사람 수(도시·지역번호 조건은 빼고 센다). */
  cities?: { name: string; count: number }[];
  area_codes?: { code: string; count: number }[];
};

export type SendStatus = "queued" | "sending" | "sent" | "delivered" | "failed" | "skipped" | "cancelled";

export type CampaignSend = {
  id: number;
  customer_ref: string | null;
  name: string | null;
  phone: string;
  status: SendStatus;
  provider_ref: string | null;
  error: string | null;
  updated_at: string;
  /** 날씨 알림(0118)만 — 이 사람의 티 타임. 문자의 {time} 자리. */
  tee_time?: string | null;
  /** 지금 이 번호가 같은 채널에서 수신거부 상태면(0116). after_send = 캠페인이 시작된 뒤 거부. */
  optout?: { created_at: string; source: string; after_send: boolean } | null;
};

export type Campaign = {
  id: number;
  channel: Channel;
  name: string;
  message: string;
  /** barcode: 프로모션 화면에서 온 캠페인의 PROMO-코드(0078). 문자에 바코드 그림이 MMS 로 붙는다. */
  /** kind = "weather": Weather alert 탭에서 그날 티 시트 손님에게 보낸 알림(0118). date = 그 날. */
  audience: AudienceFilter & {
    channel: Channel;
    picked?: number;
    barcode?: string;
    kind?: "weather";
    date?: string;
    tee_times?: number;
  };
  status: "ready" | "sending" | "sent" | "cancelled";
  created_by: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  counts: Partial<Record<SendStatus, number>>;
  /** 받은 사람 중 캠페인 시작 뒤 수신거부한 번호 수(0116). 0116 전 DB 에는 없다. */
  opted_out_after?: number;
  sends?: CampaignSend[];
};

export type OptOut = { phone: string; channel: Channel; source: string; created_at: string; name: string | null };

export type MarketingStatus = {
  sms: boolean;
  call: boolean;
  window_open: boolean;
  window: string;
  /** 날씨 알림 보내는 시각(매일 6:00–22:00). 이 칸이 생기기 전 서버에는 없다. */
  alert_window_open?: boolean;
  alert_window?: string;
  sms_footer: string;
  sms_sender: string;
  running: number[];
};

export type WeatherPlayer = { name: string; phone: string | null; ok: boolean; reason: "no_phone" | "opted_out" | null };

export type WeatherTeeTime = {
  booking_id: string;
  time: string;
  /** 자정부터 분 — 정렬·"지금부터" 거르기. */
  minutes: number;
  title: string;
  status: string;
  players: WeatherPlayer[];
};

export type WeatherAudience = {
  date: string;
  today: string;
  now_minutes: number;
  players: number;
  phones: number;
  no_phone: number;
  opted_out: number;
  tee_times: WeatherTeeTime[];
};

async function backend<T>(method: "GET" | "POST", path: string): Promise<T> {
  const token = await accessToken();
  if (!token) throw new ApiError(401, "Sign in again.");
  let response: Response;
  try {
    response = await fetch(`${paymentsApiBase()}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    throw new ApiError(0, "Could not reach the server.");
  }
  const body = (await response.json().catch(() => null)) as { detail?: unknown } | null;
  if (!response.ok) {
    const detail = typeof body?.detail === "string" && body.detail ? body.detail : `${response.status}`;
    throw new ApiError(response.status, detail);
  }
  return body as T;
}

export const marketingApi = {
  access: () => staffRpc<boolean>("pelham_staff_marketing_access"),
  audience: (channel: Channel, filter: AudienceFilter) =>
    staffRpc<Audience>("pelham_marketing_audience", { p: { channel, ...filter } }),
  createCampaign: (fields: {
    channel: Channel;
    name: string;
    message: string;
    audience: AudienceFilter & { barcode?: string };
    customer_refs?: string[];
  }) => staffRpc<Campaign>("pelham_marketing_campaign_create", { p: fields }),
  campaigns: () => staffRpc<Campaign[]>("pelham_marketing_campaigns"),
  campaign: (id: number) => staffRpc<Campaign>("pelham_marketing_campaign", { p_id: id }),
  cancel: (id: number) => staffRpc<Campaign>("pelham_marketing_campaign_cancel", { p_id: id }),
  setPrefs: (customer_ref: string, prefs: { sms_ok?: boolean | null; call_ok?: boolean | null }) =>
    staffRpc<unknown>("pelham_marketing_prefs_set", { p: { customer_ref, ...prefs } }),
  optOuts: () => staffRpc<OptOut[]>("pelham_marketing_optouts"),
  setOptOut: (phone: string, channel: Channel, opted_out: boolean) =>
    staffRpc<unknown>("pelham_marketing_optout_set", { p: { phone, channel, opted_out } }),
  weatherAudience: (date: string) =>
    staffRpc<WeatherAudience>("pelham_marketing_weather_audience", { p: { date } }),
  createWeatherAlert: (fields: { date: string; name: string; message: string; booking_ids: string[] }) =>
    staffRpc<Campaign>("pelham_marketing_weather_create", { p: fields }),
  status: () => backend<MarketingStatus>("GET", "/marketing/status"),
  send: (id: number) => backend<{ ok: boolean; already_running: boolean }>("POST", `/marketing/campaigns/${id}/send`),
};

/** 0047 이 아직 이 프로젝트에 없다(PostgREST `PGRST202`). */
export function isMarketingMissing(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 404 &&
    /could not find the function|PGRST202|schema cache/i.test(error.message)
  );
}

export function describeMarketingError(error: unknown): string {
  if (isMarketingMissing(error)) {
    return "Marketing is not switched on yet. Run supabase/migrations/0047_marketing.sql in the Supabase SQL editor.";
  }
  if (error instanceof ApiError) {
    if (error.status === 0) return "Could not reach the server. Check the internet connection and try again.";
    return error.message;
  }
  return "Something went wrong. Try again.";
}

/** 4165550001 → (416) 555-0001 */
export function formatPhone(phone: string | null | undefined): string {
  const digits = (phone ?? "").replace(/\D/g, "");
  if (digits.length !== 10) return phone ?? "";
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

export const SEGMENT_LABEL: Record<Segment, string> = {
  all: "All customers",
  members: "Members",
  non_members: "Non-members (public)",
  regulars: "Regulars (5+ rounds)",
  new: "New this year",
};

export const REASON_LABEL: Record<SkipReason, string> = {
  no_phone: "No phone",
  opted_out: "Opted out",
  no_consent: "No consent",
};

export const OPTOUT_SOURCE_LABEL: Record<string, string> = {
  reply: "Replied STOP",
  call: "On a call",
  staff: "Staff",
};

export const SEND_STATUS_LABEL: Record<SendStatus, string> = {
  queued: "Waiting",
  sending: "Sending",
  sent: "Sent",
  delivered: "Delivered",
  failed: "Failed",
  skipped: "Skipped",
  cancelled: "Cancelled",
};
