/**
 * AI Manager Marketing Strategies(`/admin/ai-marketing`) — 기간 집계는 Supabase 함수 하나(0094)가 낸다.
 * 매니저(Reports 명단)와 0094 명단(admin@ · proshop@ · analysis@) 밖 계정은 SQL 이 403 으로 거절한다.
 *
 * 금액은 모두 센트, 세전. 고객층·시간대 나누는 규칙은 0094 머리 주석에 있다.
 */

import { paymentsApiBase } from "@/lib/booking/payments";
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
  }[];
  niche_markets: { area: string; population: string; drive: string; why: string; hook: string }[];
  plan: { window: "30" | "60" | "90"; actions: string[] }[];
  cautions: string[];
  model: string;
  period: { from: string; to: string };
};

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
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`.trim();
    try {
      const body = (await response.json()) as { detail?: unknown };
      if (typeof body?.detail === "string" && body.detail) message = body.detail;
    } catch {
      // JSON 이 아닌 오류 본문.
    }
    if (response.status === 404) message = "Claude's strategy is not on the server yet. Deploy the API (Fly) first.";
    throw new ApiError(response.status, message);
  }
  return (await response.json()) as Strategy;
}
