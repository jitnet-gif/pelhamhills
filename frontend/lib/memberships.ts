/**
 * 시즌별 회원권 명부(0040) — `/admin/memberships` 가 부르는 직원 함수.
 * 함수 이름과 인자는 `supabase/migrations/0040_memberships.sql` 와 글자 그대로 같다.
 *
 * 요금은 공개 요금표(`app/memberships/page.tsx`, 2027 Early Bird, HST 포함)와 같은 숫자다.
 * 그쪽은 원문 표기 문자열이라 여기서 다시 숫자로 적는다 — 클럽이 요금을 바꾸면 두 곳을 같이 고친다.
 */

import { ApiError } from "@/lib/teeSheet/api";
import { staffRpc } from "@/lib/teeSheet/staffRpc";

export type MembershipType = "full" | "weekday" | "intermediate" | "nine_hole" | "twilight" | "junior";
export type MembershipPlan = "single" | "spousal";
export type CartPackage = "unlimited_7day" | "unlimited_weekday";
export type MembershipStatus = "pending" | "active" | "cancelled";

export type Membership = {
  id: string;
  season: number;
  customer_ref: string | null;
  member_name: string;
  phone: string | null;
  email: string | null;
  member_number: string | null;
  membership_type: MembershipType;
  plan: MembershipPlan;
  spouse_name: string | null;
  cart_package: CartPackage | null;
  range_pass: boolean;
  amount_due: number;
  amount_paid: number;
  paid_on: string | null;
  payment_method: string | null;
  status: MembershipStatus;
  sim_hours_used: number;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

/** 저장할 때 보내는 꼴. 고칠 때는 바꾼 키만 보낸다. */
export type MembershipInput = Partial<Omit<Membership, "id" | "created_at" | "updated_at">>;

/** 고객 명부에서 회원으로 표시됐지만 이 시즌 회원권이 아직 없는 사람. */
export type RenewalCandidate = {
  customer_ref: string;
  name: string;
  phone: string | null;
  email: string | null;
  member_number: string | null;
  /** 지난 요금제 이름. "Weekday Member - Single with Weekday Cart" 꼴. */
  player_type: string | null;
  rounds: number;
};

export const membershipsApi = {
  list: (season: number) => staffRpc<Membership[]>("pelham_staff_memberships", { p_season: season }),
  save: (id: string | null, input: MembershipInput) =>
    staffRpc<Membership>("pelham_staff_membership_save", { p_id: id, p: input }),
  renewals: (season: number) =>
    staffRpc<RenewalCandidate[]>("pelham_staff_membership_renewals", { p_season: season }),
};

// ===== 요금표 (2027 Early Bird) =========================================

export const MEMBERSHIP_TYPES: {
  key: MembershipType;
  label: string;
  access: string;
  single: number;
  /** 없으면 개인 전용. */
  spousal?: number;
  /** Early Bird 실내 골프 쿠폰 시간. */
  simHours: number;
}[] = [
  { key: "full", label: "Full", access: "Play anytime", single: 3051, spousal: 5152.8, simHours: 10 },
  { key: "weekday", label: "Weekday", access: "Weekdays, excl. holidays", single: 2316.5, spousal: 3955, simHours: 8 },
  { key: "intermediate", label: "Intermediate", access: "Ages 18–35, anytime", single: 2316.5, simHours: 8 },
  { key: "nine_hole", label: "9-Hole", access: "Weekdays after 10 AM", single: 1638.5, spousal: 2881.5, simHours: 6 },
  { key: "twilight", label: "Twilight", access: "After 3 PM incl. weekends", single: 1638.5, spousal: 2881.5, simHours: 6 },
  { key: "junior", label: "Junior", access: "17 & under", single: 565, simHours: 0 },
];

export const CART_PACKAGES: { key: CartPackage; label: string; price: number }[] = [
  { key: "unlimited_7day", label: "Unlimited 7-Day cart", price: 1850 },
  { key: "unlimited_weekday", label: "Unlimited Weekday cart", price: 1350 },
];

export const RANGE_PASS_PRICE = 395.5;

/** Early Bird 요금이 끝나는 날(이날까지 완납). */
export const EARLY_BIRD_DEADLINE = "2026-11-15";

export const STATUS_LABEL: Record<MembershipStatus, string> = {
  pending: "Pending",
  active: "Active",
  cancelled: "Cancelled",
};

export function typeInfo(key: MembershipType) {
  return MEMBERSHIP_TYPES.find((t) => t.key === key) ?? MEMBERSHIP_TYPES[0];
}

export function cartLabel(key: CartPackage | null): string | null {
  return CART_PACKAGES.find((c) => c.key === key)?.label ?? null;
}

/**
 * 요금표대로의 금액. 카트 패키지는 한 사람 몫(1/2 카트) 하나로 센다 — 부부가 둘 다 사면
 * 직원이 금액을 고친다.
 */
export function listPrice(m: {
  membership_type: MembershipType;
  plan: MembershipPlan;
  cart_package: CartPackage | null;
  range_pass: boolean;
}): number {
  const type = typeInfo(m.membership_type);
  const base = m.plan === "spousal" && type.spousal ? type.spousal : type.single;
  const cart = CART_PACKAGES.find((c) => c.key === m.cart_package)?.price ?? 0;
  return round2(base + cart + (m.range_pass ? RANGE_PASS_PRICE : 0));
}

export function balance(m: Pick<Membership, "amount_due" | "amount_paid">): number {
  return round2(Number(m.amount_due) - Number(m.amount_paid));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function money(n: number): string {
  return Number(n).toLocaleString("en-CA", { style: "currency", currency: "CAD" });
}

/**
 * 지난 요금제 이름 → 새 회원권 초안. 규칙은 `backend/services/customer_store.py` 의
 * `classify_rate_plan` 과 같다(앞머리로 등급, "spousal"/"single", "7 day cart"/"weekday cart").
 * 모르는 등급("Corporate Member …")은 null — 직원이 고른다.
 */
export function draftFromRatePlan(plan: string | null): {
  membership_type: MembershipType | null;
  plan: MembershipPlan;
  cart_package: CartPackage | null;
} {
  const low = (plan ?? "").trim().toLowerCase();
  const prefixes: [string, MembershipType][] = [
    ["full", "full"],
    ["weekday", "weekday"],
    ["intermediate", "intermediate"],
    ["9 hole", "nine_hole"],
    ["twilight", "twilight"],
    ["junior", "junior"],
  ];
  const type = prefixes.find(([prefix]) => low.startsWith(prefix))?.[1] ?? null;
  return {
    membership_type: type,
    plan: low.includes("spousal") ? "spousal" : "single",
    cart_package: low.includes("7 day cart")
      ? "unlimited_7day"
      : low.includes("weekday cart")
        ? "unlimited_weekday"
        : null,
  };
}

/** 화면에 띄울 한 줄. 404 는 대개 0040 을 아직 SQL Editor 에서 돌리지 않았다는 뜻이다. */
export function describeMembershipError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 0) return "Can't reach the server. Check the connection and try again.";
    if (error.status === 404 && /function|PGRST202|schema cache/i.test(error.message)) {
      return "Membership database functions are missing — run migration 0040 in the Supabase SQL Editor.";
    }
    if (/duplicate key|memberships_customer_season/i.test(error.message)) {
      return "This customer already has a membership for that season.";
    }
    return error.message;
  }
  return (error as Error)?.message ?? "Something went wrong.";
}
