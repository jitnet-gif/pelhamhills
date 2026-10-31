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
  /** 0133 — 받은 뒤 14일 안에 이 번호로 온 연락(웹 예약·신청 / 전화 / 문자 답장). */
  replied?: ReplyChannel[];
  /** 0133 — 받은 사람이 어떤 사람인지(지금 고객 명부 기준). 명부에 없는 번호면 null. new = 최근 12개월 계정. */
  customer?: { is_member: boolean; rounds: number; city: string | null; new: boolean } | null;
};

export type ReplyChannel = "web" | "call" | "text";

/** 0133 — 받은 번호(reached) 중 시작 후 `days` 일 안에 연락해 온 사람 수. 상세에만 있다. */
export type CampaignReplies = {
  days: number;
  until: string | null;
  reached: number;
  responded: number;
  web: number;
  call: number;
  text: number;
};

/** 0145 — 연락 온 숫자 뒤의 한 건. what·detail 은 서버가 만든 글. status 는 지금 상태, 문자는 null. */
export type CampaignContact = {
  kind: ReplyChannel;
  at: string;
  phone: string;
  name: string | null;
  what: string;
  detail: string | null;
  status: string | null;
  ref: string | null;
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
    /** 0132 — 손으로 친 번호 수 · 그 번호에만 보냈는지. */
    typed?: number;
    phones_only?: boolean;
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
  replies?: CampaignReplies;
};

/** 보낸 캠페인 비용. 문자 = Twilio 요금(unit = USD 등), 전화 = ElevenLabs 크레딧. pending = 요금이 아직 안 붙은 통 수. */
export type CampaignCost = {
  channel: Channel;
  unit: string;
  total: number;
  priced: number;
  pending: number;
  /** 문자 조각 수(긴 문자는 여러 조각으로 요금이 붙는다). 전화는 null. */
  segments: number | null;
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

async function backend<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const token = await accessToken();
  if (!token) throw new ApiError(401, "Sign in again.");
  let response: Response;
  try {
    response = await fetch(`${paymentsApiBase()}${path}`, {
      method,
      headers:
        body === undefined
          ? { Authorization: `Bearer ${token}` }
          : { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "Could not reach the server.");
  }
  const payload = (await response.json().catch(() => null)) as { detail?: unknown } | null;
  if (!response.ok) {
    const detail = typeof payload?.detail === "string" && payload.detail ? payload.detail : `${response.status}`;
    throw new ApiError(response.status, detail);
  }
  return payload as T;
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
    /** 0132 — 손으로 친 번호(문자만). phones_only 면 그룹·필터 없이 이 번호에만. */
    phones?: string[];
    phones_only?: boolean;
  }) => staffRpc<Campaign>("pelham_marketing_campaign_create", { p: fields }),
  campaigns: () => staffRpc<Campaign[]>("pelham_marketing_campaigns"),
  campaign: (id: number) => staffRpc<Campaign>("pelham_marketing_campaign", { p_id: id }),
  contacts: (id: number) => staffRpc<CampaignContact[]>("pelham_marketing_campaign_contacts", { p_id: id }),
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
  cost: (id: number) => backend<CampaignCost>("GET", `/marketing/campaigns/${id}/cost`),
  send: (id: number) => backend<{ ok: boolean; already_running: boolean }>("POST", `/marketing/campaigns/${id}/send`),
  /** 0136 — 실패한 사람만 다시 보낸다. sendIds 를 주면 그 줄만. */
  retry: (id: number, sendIds?: number[]) =>
    backend<{ ok: boolean; already_running: boolean; retried: number }>(
      "POST",
      `/marketing/campaigns/${id}/retry`,
      sendIds?.length ? { send_ids: sendIds } : {},
    ),
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

export const REPLY_LABEL: Record<ReplyChannel, string> = {
  web: "Website",
  call: "Phone call",
  text: "Text reply",
};

/** 그룹이 어떤 사람들인지(0047 pelham_marketing_candidates 의 segment 조건 그대로). */
export const SEGMENT_HINT: Record<Segment, string> = {
  all: "Everyone in the customer list",
  members: "Club members (member flag in the customer list)",
  non_members: "Public golfers who are not members",
  regulars: "Customers with 5 or more rounds booked or played",
  new: "Customer accounts created in the last 12 months",
};

/** 받은 사람들 구성 — 회원·일반·단골(5+)·신규·명부 밖 번호, 많은 도시 순. */
export function summarizeRecipients(sends: CampaignSend[]) {
  const known = sends.filter((s) => s.customer);
  const cities = new Map<string, number>();
  for (const s of known) {
    if (s.customer?.city) cities.set(s.customer.city, (cities.get(s.customer.city) ?? 0) + 1);
  }
  return {
    known: known.length,
    members: known.filter((s) => s.customer?.is_member).length,
    publicGolfers: known.filter((s) => !s.customer?.is_member).length,
    regulars: known.filter((s) => (s.customer?.rounds ?? 0) >= 5).length,
    newCustomers: known.filter((s) => s.customer?.new).length,
    notInList: sends.length - known.length,
    cities: [...cities.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])),
  };
}

/** 캠페인 상세 받은 사람 표의 보기 필터. */
export type SendView =
  | "all"
  | "reached"
  | "not_reached"
  | "waiting"
  | "contacted"
  | "no_contact"
  | "opted_out"
  | "member"
  | "public"
  | "not_in_list";

const REACHED = new Set<SendStatus>(["sent", "delivered"]);
const NOT_REACHED = new Set<SendStatus>(["failed", "skipped", "cancelled"]);

export function sendInView(send: CampaignSend, view: SendView): boolean {
  switch (view) {
    case "all":
      return true;
    case "reached":
      return REACHED.has(send.status);
    case "not_reached":
      return NOT_REACHED.has(send.status);
    case "waiting":
      return send.status === "queued" || send.status === "sending";
    case "contacted":
      return (send.replied ?? []).length > 0;
    case "no_contact":
      return REACHED.has(send.status) && !(send.replied ?? []).length;
    case "opted_out":
      return Boolean(send.optout);
    case "member":
      return Boolean(send.customer?.is_member);
    case "public":
      return Boolean(send.customer && !send.customer.is_member);
    case "not_in_list":
      return !send.customer;
  }
}

/**
 * 번호 찾기 — 숫자가 있으면 전화번호 숫자에서(앞의 1 은 없어도 찾는다), 아니면 이름에서 찾는다.
 * "905 555" 처럼 띄어 써도 숫자만 이어 본다.
 */
export function sendMatches(send: CampaignSend, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const digits = q.replace(/\D/g, "");
  if (digits && send.phone.replace(/\D/g, "").includes(digits)) return true;
  return (send.name ?? "").toLowerCase().includes(q);
}

export type AudienceFact = { label: string; value: string; hint?: string };

/** 캠페인을 누구에게 보냈는지 — 칸 이름과 값. 예: Group: Members · Rounds: 5+ · City: Fonthill. */
export function campaignAudienceFacts(audience: Campaign["audience"] | null | undefined): AudienceFact[] {
  if (!audience) return [];
  if (audience.kind === "weather") {
    return [{ label: "Group", value: `Tee sheet guests on ${audience.date ?? ""}`, hint: "Everyone booked that day" }];
  }
  const facts: AudienceFact[] = [];
  if (!audience.phones_only) {
    const segment = SEGMENT_LABEL[audience.segment] ? audience.segment : "all";
    facts.push({ label: "Group", value: SEGMENT_LABEL[segment], hint: SEGMENT_HINT[segment] });
    const min = Number(audience.min_rounds) || 0;
    const max = Number(audience.max_rounds) || 0;
    if (min > 0 || max > 0) {
      facts.push({
        label: "Rounds",
        value: min > 0 && max > 0 ? `${min}–${max}` : min > 0 ? `${min} or more` : `${max} or fewer`,
      });
    }
    const list = (v: string[] | string | undefined) => (Array.isArray(v) ? v : v ? [v] : []).filter(Boolean);
    const cities = list(audience.city);
    if (cities.length) facts.push({ label: "City", value: cities.join(", ") });
    const codes = list(audience.area_code);
    if (codes.length) facts.push({ label: "Area code", value: codes.join(", ") });
    if (audience.search) facts.push({ label: "Search", value: `"${audience.search}"` });
    if (audience.picked) facts.push({ label: "Picked by hand", value: `${audience.picked} people` });
  }
  if (audience.typed) {
    facts.push({ label: audience.phones_only ? "Typed numbers only" : "Typed numbers", value: String(audience.typed) });
  }
  return facts;
}

/** 목록용 한 줄 — "Members · Rounds 5 or more · Fonthill". */
export function describeCampaignAudience(audience: Campaign["audience"] | null | undefined): string {
  return campaignAudienceFacts(audience)
    .map((f) => (f.label === "Group" || f.label === "City" ? f.value : `${f.label} ${f.value}`))
    .join(" · ");
}

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
