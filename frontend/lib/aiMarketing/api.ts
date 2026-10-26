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
  narration?: { intro: string; niches: string; plan: string; close: string };
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

/** 나레이션 한 장면 → mp3 blob 주소. 같은 글은 이 탭에서 한 번만 받는다.
 * `share` 가 있으면 공유 링크 모드 — 로그인 없이 그 보고서의 대본만 읽힌다(서버가 확인한다). */
const narrationUrls = new Map<string, Promise<string>>();

export function narrationUrl(text: string, share = ""): Promise<string> {
  const known = narrationUrls.get(text);
  if (known) return known;
  const pending = (async () => {
    const token = share ? "" : await accessToken();
    if (!share && !token) throw new ApiError(401, "Sign in again to hear the narrator.");
    let response: Response;
    try {
      response = await fetch(`${paymentsApiBase()}/ai-marketing/narrate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ text, share }),
      });
    } catch {
      throw new ApiError(0, "Can't reach the server. Check the connection and try again.");
    }
    if (!response.ok) throw await failure(response, "The narrator is not on the server yet. Deploy the API (Fly) first.");
    return URL.createObjectURL(await response.blob());
  })();
  narrationUrls.set(text, pending);
  // 실패한 것은 기억하지 않는다 — 다시 누르면 다시 받는다.
  pending.catch(() => narrationUrls.delete(text));
  return pending;
}
