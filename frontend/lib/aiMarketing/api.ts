/**
 * AI Manager Marketing Strategies(`/admin/ai-marketing`) — 기간 집계는 Supabase 함수 하나(0094)가 낸다.
 * 매니저(Reports 명단)와 0094 명단(admin@ · proshop@ · analysis@) 밖 계정은 SQL 이 403 으로 거절한다.
 *
 * 금액은 모두 센트, 세전. 고객층·시간대 나누는 규칙은 0094 머리 주석에 있다.
 */

import { paymentsApiBase } from "@/lib/booking/payments";
import { bookingRpc } from "@/lib/booking/rpc";
import { ApiError } from "@/lib/teeSheet/api";
import { accessToken } from "@/lib/teeSheet/session";
import { staffRpc } from "@/lib/teeSheet/staffRpc";

import type { Tone } from "./voice";

export type Segment = "member" | "public" | "golfnow" | "junior_senior" | "league" | "tour" | "staff";
export type DayType = "weekday" | "weekend";
export type DayPart = "am" | "pm" | "twilight" | "unknown";

export type GridCell = { seg: Segment; daytype: DayType; daypart: DayPart; rounds: number };

export type SalesParts = { green: number; cart: number; extras: number; shop: number; snack: number };

export type SegSales = SalesParts & { seg: Segment | "no_golfer"; players: number };

export type MarketingSummary = {
  from: string;
  to: string;
  days: Record<DayType, number>;
  rounds: number;
  no_shows: number;
  bookings: number;
  linked_rounds: number;
  linked_golfers: number;
  repeat_golfers: number;
  grid: GridCell[];
  by_date: { date: string; rounds: number; no_shows: number }[];
  sales_by_seg: SegSales[];
  sales_by_daytype: (SalesParts & { daytype: DayType })[];
  paid_bills: number;
  net_sales: number;
  bill_discount: number;
  promo: { code: string; name: string; uses: number; amount: number }[];
  web_sources: { label: string; bookings: number }[];
  members: { type: string; count: number }[];
  reach: {
    customers: number;
    with_email: number;
    with_phone: number;
    sms_ok: number;
    call_ok: number;
    opted_out: number;
  };
};

/** 회원별 라운드 수(0097). */
export type MemberRounds = {
  season: number;
  members: {
    name: string;
    type: string;
    plan: "single" | "spousal";
    member_number: string | null;
    linked: boolean;
    rounds: number;
    season_rounds: number;
    no_shows: number;
    last_played: string | null;
  }[];
  unlinked_rounds: number;
};

export const aiMarketingApi = {
  reports: () => staffRpc<ReportRow[]>("pelham_staff_ai_marketing_reports"),
  report: (id: string) => staffRpc<Strategy>("pelham_staff_ai_marketing_report", { p_id: id }),
  saveReport: (from: string, to: string, lang: "en" | "ko", focus: string, doc: Strategy, source: "claude" | "browser") =>
    staffRpc<{ id: string; saved: boolean }>("pelham_staff_ai_marketing_report_save", {
      p_from: from,
      p_to: to,
      p_lang: lang,
      p_focus: focus,
      p_doc: doc,
      p_source: source,
    }),
  share: (id: string, on: boolean) =>
    staffRpc<{ id: string; share_token: string | null }>("pelham_staff_ai_marketing_report_share", { p_id: id, p_on: on }),
  facts: () => staffRpc<Fact[]>("pelham_staff_ai_marketing_facts"),
  saveFact: (fact: Partial<Fact>) => staffRpc<Fact>("pelham_staff_ai_marketing_fact_save", { p: fact }),
  launches: (reportId: string) => staffRpc<LaunchRow[]>("pelham_staff_ai_marketing_launches", { p_report: reportId }),
  recordLaunch: (reportId: string, strategy: number, channel: LaunchRow["channel"], ref: string) =>
    staffRpc<{ ok: boolean }>("pelham_staff_ai_marketing_launch_record", {
      p_report: reportId,
      p_strategy: strategy,
      p_channel: channel,
      p_ref: ref,
    }),
  shared: (token: string) => bookingRpc<SharedReport>("pelham_ai_marketing_shared_report", { p_token: token }),
  access: () => staffRpc<boolean>("pelham_staff_ai_marketing_access"),
  summary: (from: string, to: string) =>
    staffRpc<MarketingSummary>("pelham_staff_ai_marketing_summary", { p_from: from, p_to: to }),
  memberRounds: (from: string, to: string) =>
    staffRpc<MemberRounds>("pelham_staff_ai_marketing_member_rounds", { p_from: from, p_to: to }),
};

/** Claude 의 마케팅 전략(Fly `POST /ai-marketing/strategy`). 서버가 위 요약 + 주변 상권으로 쓴다. */
export type Strategy = {
  headline: string;
  facts: { fact: string; evidence: string }[];
  strategies: {
    title: string;
    target_group: string;
    time_slot: string;
    area: string;
    why: string;
    offer: string;
    channels: string[];
    steps: string[];
    kpi: string;
    budget: "low" | "medium" | "high";
    /** 프레젠테이션에서 이 전략 장면의 나레이션. 이 기능 전에 받은 결과에는 없다. */
    narration?: string;
    /** 실행 타일에 미리 채울 손님용 문구(영어). 이 기능 전에 받은 결과에는 없다. */
    launch?: StrategyLaunchCopy;
  }[];
  niche_markets: { area: string; population: string; drive: string; why: string; hook: string }[];
  plan: { window: "30" | "60" | "90"; actions: string[] }[];
  cautions: string[];
  /** 손익분기점(인건비 pelham-shift + 매니저 팩트의 비용). 이 기능 전에 받은 결과에는 없다. */
  break_even?: {
    summary: string;
    figures: { label: string; value: string }[];
    improvements: { title: string; impact: string; how: string }[];
  };
  narration?: { intro: string; niches: string; break_even?: string; plan: string; close: string };
  model: string;
  period: { from: string; to: string };
  /** 보관함(0113)에 저장된 번호. 0113 을 안 돌렸으면 없다. */
  report_id?: string | null;
};

export type StrategyLaunchCopy = {
  sms: string;
  call: string;
  segment: "all" | "members" | "non_members" | "regulars" | "new";
  popup_title: string;
  popup_body: string;
  popup_link_label: string;
  popup_link: "/book/tee-time" | "/book/indoor" | "/book/login" | "/";
  days: number;
};

/** 전략에서 만든 캠페인·팝업과 지금 상태(0115). */
export type LaunchRow = {
  strategy: number;
  channel: "sms" | "call" | "popup";
  ref: string;
  created_at: string;
  created_by: string;
  campaign: { status: "ready" | "sending" | "sent" | "cancelled"; name: string; recipients: number; sent: number; failed: number } | null;
  popup: { title: string; active: boolean; starts_at: string | null; ends_at: string | null; live: boolean } | null;
};

/** 매니저가 적는 팩트(0117). amount_cents 는 per(월·시즌·연·한 번) 기준 금액. */
export type Fact = {
  id: string;
  kind: "cost" | "revenue" | "goal" | "event" | "note";
  label: string;
  detail: string;
  amount_cents: number | null;
  per: "month" | "season" | "year" | "once" | null;
  active: boolean;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
};

/** Claude 가 받을 것 그대로(Fly `/ai-marketing/inputs`). data 는 0094 요약 + channels · calls · labor · manager_facts. */
export type StrategyInputs = {
  period: { from: string; to: string };
  found: Record<"sales_and_tee_sheet" | "texts_and_phone" | "phone_assistant_calls" | "labor" | "manager_facts", boolean>;
  data: MarketingSummary & {
    channels?: Record<string, unknown>;
    calls?: Record<string, unknown>;
    labor?: {
      period: { from: string; to: string; days: number };
      currency: string;
      hourly: { staff: number; hours: number; regular_hours: number; ot_hours: number; holiday_hours: number; pay: number };
      management: { people: number; biweekly_total: number; pay: number };
      total_labor: number;
      by_daytype: Record<"weekday" | "weekend", { days: number; hours: number; pay: number }>;
      by_area: { area: string; hours: number; pay: number }[];
      by_day: { date: string; hours: number; pay: number; staff: number }[];
    };
    manager_facts?: Partial<Fact>[];
  };
  region: string;
};

/** 보관함 목록 한 줄(0113). */
export type ReportRow = {
  id: string;
  created_at: string;
  created_by: string;
  from: string;
  to: string;
  lang: "en" | "ko";
  focus: string;
  model: string;
  source: "claude" | "browser" | "example";
  headline: string;
  strategies: number;
  share_token: string | null;
};

/** 공유 링크로 읽은 보고서(0113, 로그인 없이). */
export type SharedReport = { doc: Strategy; lang: "en" | "ko"; from: string; to: string; created_at: string; source: string };

/** 응답 본문의 `detail` 을 오류 글로. */
async function failure(response: Response, missing: string): Promise<ApiError> {
  let message = `${response.status} ${response.statusText}`.trim();
  try {
    const body = (await response.json()) as { detail?: unknown };
    if (typeof body?.detail === "string" && body.detail) message = body.detail;
  } catch {
    // JSON 이 아닌 오류 본문.
  }
  if (response.status === 404) message = missing;
  return new ApiError(response.status, message);
}

export async function askStrategy(from: string, to: string, lang: "en" | "ko", focus: string): Promise<Strategy> {
  const token = await accessToken();
  if (!token) throw new ApiError(401, "Sign in again to ask Claude.");
  let response: Response;
  try {
    response = await fetch(`${paymentsApiBase()}/ai-marketing/strategy`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ from, to, lang, focus }),
    });
  } catch {
    throw new ApiError(0, "Can't reach the server. Check the connection and try again.");
  }
  if (!response.ok) throw await failure(response, "Claude's strategy is not on the server yet. Deploy the API (Fly) first.");
  return (await response.json()) as Strategy;
}

/** 나레이션 한 장면 → mp3 blob 주소. 같은 글·같은 목소리 설정은 이 탭에서 한 번만 받는다.
 * `share` 가 있으면 공유 링크 모드 — 로그인 없이 그 보고서의 대본만 읽힌다(서버가 확인한다).
 * `voice` 는 ElevenLabs 톤·속도(`lib/aiMarketing/voice.ts` 의 voiceParts). 없으면 목소리 그대로. */
const narrationUrls = new Map<string, Promise<string>>();

export function narrationUrl(text: string, share = "", voice?: { tone: Tone; speed: number }): Promise<string> {
  const tone = voice?.tone ?? "natural";
  const speed = voice?.speed ?? 1;
  const cacheKey = `${tone}|${speed}|${text}`;
  const known = narrationUrls.get(cacheKey);
  if (known) return known;
  const pending = (async () => {
    const token = share ? "" : await accessToken();
    if (!share && !token) throw new ApiError(401, "Sign in again to hear the narrator.");
    let response: Response;
    try {
      response = await fetch(`${paymentsApiBase()}/ai-marketing/narrate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ text, share, tone, speed }),
      });
    } catch {
      throw new ApiError(0, "Can't reach the server. Check the connection and try again.");
    }
    if (!response.ok) throw await failure(response, "The narrator is not on the server yet. Deploy the API (Fly) first.");
    return URL.createObjectURL(await response.blob());
  })();
  narrationUrls.set(cacheKey, pending);
  // 실패한 것은 기억하지 않는다 — 다시 누르면 다시 받는다.
  pending.catch(() => narrationUrls.delete(cacheKey));
  return pending;
}

/** Hope 가 화면에 넘기는 동작. 서버는 아무것도 보내지 않는다 — 문자·팝업은 화면이 확인을 받고 실행한다. */
export type HopeAction =
  | { type: "strategy"; from: string; to: string; focus: string }
  | { type: "present" }
  | ({
      type: "launch";
      report_id: string;
      strategy: number;
      title: string;
      sms: string;
      /** AI 전화(ElevenLabs)가 할 말. 비어 있을 수 있다. */
      call: string;
      popup: boolean;
    } & Pick<StrategyLaunchCopy, "segment" | "popup_title" | "popup_body" | "popup_link_label" | "popup_link" | "days">);

/** Hope 가 이번 답에서 찾아본 기간 숫자(0094 요약 그대로). 금액은 센트. */
export type HopeLookup = {
  from: string;
  to: string;
  rounds: number;
  bookings: number;
  no_shows: number;
  paid_bills: number;
  net_sales: number;
  bill_discount: number;
};

export type HopeReply = { reply: string; actions: HopeAction[]; lookups: HopeLookup[]; log_id: string | null };

/** Hope 기록 한 줄(0119). */
export type HopeLogRow = {
  id: string;
  created_at: string;
  created_by: string;
  lang: "en" | "ko";
  kind: "chat" | "launch" | "strategy" | "present";
  question: string;
  answer: string;
  detail: Record<string, unknown>;
};

export const hopeApi = {
  log: (limit = 50) => staffRpc<HopeLogRow[]>("pelham_staff_ai_manager_log", { p_limit: limit }),
  save: (kind: HopeLogRow["kind"], lang: "en" | "ko", question: string, answer: string, detail: Record<string, unknown>) =>
    staffRpc<{ id: string }>("pelham_staff_ai_manager_log_save", {
      p_kind: kind,
      p_lang: lang,
      p_question: question,
      p_answer: answer,
      p_detail: detail,
    }),
};

/** 질문 유형 = AI 매니저 화면의 네 탭. 서버가 마지막 질문 앞에 붙여 Hope 가 그 쪽으로 답한다. */
export type HopeTopic = "analysis" | "reports" | "launch" | "facts";

/** Hope 와 대화 한 번(Fly `POST /ai-marketing/chat`). 지난 대화를 같이 보내 이어서 말한다. */
export async function askHope(
  messages: { role: "user" | "assistant"; text: string }[],
  lang: "en" | "ko",
  topic?: HopeTopic,
): Promise<HopeReply> {
  const token = await accessToken();
  if (!token) throw new ApiError(401, "Sign in again to talk to Hope.");
  let response: Response;
  try {
    response = await fetch(`${paymentsApiBase()}/ai-marketing/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ messages: messages.slice(-20), lang, topic }),
    });
  } catch {
    throw new ApiError(0, "Can't reach the server. Check the connection and try again.");
  }
  if (!response.ok) throw await failure(response, "Hope is not on the server yet. Deploy the API (Fly) first.");
  return (await response.json()) as HopeReply;
}

/** Claude 가 받을 것을 그대로 받아 본다(전략은 쓰지 않는다 — Claude 요금 없음). */
export async function strategyInputs(from: string, to: string): Promise<StrategyInputs> {
  const token = await accessToken();
  if (!token) throw new ApiError(401, "Sign in again.");
  let response: Response;
  try {
    response = await fetch(`${paymentsApiBase()}/ai-marketing/inputs`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ from, to }),
    });
  } catch {
    throw new ApiError(0, "Can't reach the server. Check the connection and try again.");
  }
  if (!response.ok) throw await failure(response, "This view is not on the server yet. Deploy the API (Fly) first.");
  return (await response.json()) as StrategyInputs;
}
