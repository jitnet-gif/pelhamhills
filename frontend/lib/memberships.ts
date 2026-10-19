/**
 * 시즌별 회원권 명부(0040) — `/admin/memberships` 가 부르는 직원 함수.
 * 함수 이름과 인자는 `supabase/migrations/0040_memberships.sql` 와 글자 그대로 같다.
 *
 * 요금은 클럽의 2027 Early Bird 요금표 PDF(v3, 2026-09-14)와 공개 요금표(`app/memberships/page.tsx`)의
 * HST 포함 금액과 같은 숫자다. 결제 수단·3% 카드 수수료는 같은 PDF 2쪽 신청서를 따른다.
 * 그쪽은 원문 표기 문자열이라 여기서 다시 숫자로 적는다 — 클럽이 요금을 바꾸면 두 곳을 같이 고친다.
 */

import { paymentsApiBase } from "@/lib/booking/payments";
import { bookingRpc } from "@/lib/booking/rpc";
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
  address: string | null;
  postal_code: string | null;
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
  /** staff: 프로 샵이 넣음 · online: 손님이 `/memberships/application` 에서 신청(0041). */
  source: "staff" | "online";
  created_at: string;
  updated_at: string;
};

/** 저장할 때 보내는 꼴. 고칠 때는 바꾼 키만 보낸다. */
export type MembershipInput = Partial<Omit<Membership, "id" | "created_at" | "updated_at" | "source">>;

/** 손님 신청서가 보내는 꼴(0041 `pelham_membership_apply`). */
export type MembershipApplication = Pick<
  MembershipInput,
  | "season"
  | "member_name"
  | "phone"
  | "email"
  | "address"
  | "postal_code"
  | "membership_type"
  | "plan"
  | "spouse_name"
  | "cart_package"
  | "range_pass"
  | "amount_due"
  | "payment_method"
  | "notes"
> & { agreed: boolean };

export type ApplicationReceipt = {
  reference: string;
  /** 카드 결제를 여는 열쇠(0042). 신청 이메일과 함께 낸다. */
  pay_key: string;
  member_name: string;
  season: number;
  /** SQL 요금표 금액(0042). 신용카드면 3% 포함. */
  amount_due: number;
  payment_method: string | null;
};

/** 손님용. 공개 키로 부르는 함수는 이것 하나다. 금액은 SQL 이 요금표로 정한다(0042). */
export function applyForMembership(input: MembershipApplication): Promise<ApplicationReceipt> {
  return bookingRpc<ApplicationReceipt>("pelham_membership_apply", { p: input });
}

// ===== 카드 결제(Stripe Checkout, `backend/api/routes/membership_payments.py`) =====

export type MembershipPayCredentials = { key: string; email: string };

export type MembershipPayment = {
  invoice: string;
  /** 센트. */
  amount: number;
  status: "pending" | "approved" | "declined" | "error" | "orphaned" | "refunded";
  card_brand?: string | null;
  card_last4?: string | null;
  reference?: string;
  member_name?: string;
  season?: number;
  membership_type?: MembershipType;
  plan?: MembershipPlan;
  membership_status?: MembershipStatus;
  /** 남은 금액(달러). */
  balance?: number;
  reversed?: "void" | "refund";
  reversal_failed?: boolean;
};

async function payCall<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${paymentsApiBase()}/payments/membership${path}`, {
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

/** 결과 화면이 "다시 결제" 를 열 수 있게 이 탭에만 열쇠를 남긴다. 저장소가 막혀 있어도 결제는 된다. */
const PAY_CREDS_KEY = "pelham.membership.pay";

export function rememberPayCredentials(creds: MembershipPayCredentials): void {
  try {
    sessionStorage.setItem(PAY_CREDS_KEY, JSON.stringify(creds));
  } catch {
    // 사생활 보호 모드 등. 결과 화면이 다시 결제 버튼을 못 그릴 뿐이다.
  }
}

export function recallPayCredentials(): MembershipPayCredentials | null {
  try {
    const raw = sessionStorage.getItem(PAY_CREDS_KEY);
    const value = raw ? (JSON.parse(raw) as MembershipPayCredentials) : null;
    return value?.key && value?.email ? value : null;
  } catch {
    return null;
  }
}

/** 결제 페이지를 연다: 서버가 남은 금액으로 Stripe Checkout 세션을 만들고, 이 탭이 그리로 넘어간다. */
export async function startMembershipCheckout(creds: MembershipPayCredentials): Promise<void> {
  rememberPayCredentials(creds);
  const { url } = await payCall<{ url: string }>("/checkout", { method: "POST", body: JSON.stringify(creds) });
  if (!/^https:\/\/checkout\.stripe\.com\//.test(url)) throw new ApiError(502, "Online payment is not available right now.");
  window.location.assign(url);
}

export function membershipPaymentStatus(invoice: string): Promise<MembershipPayment> {
  return payCall<MembershipPayment>(`/status/${encodeURIComponent(invoice)}`);
}

/** 고객 명부에서 회원으로 표시됐지만 이 시즌 회원권이 아직 없는 사람. */
export type RenewalCandidate = {
  customer_ref: string;
  name: string;
  phone: string | null;
  email: string | null;
  member_number: string | null;
  address: string | null;
  postal_code: string | null;
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
  /** Early Bird 실내 골프 쿠폰 시간. 완납해야 지급된다. */
  simHours: number;
  /** 연습장 이용이 회원권에 들어 있다(Full). 연습장 이용권을 따로 팔지 않는다. */
  rangeIncluded?: boolean;
}[] = [
  { key: "full", label: "Full", access: "Anytime · driving range included", single: 3051, spousal: 5152.8, simHours: 10, rangeIncluded: true },
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

/** 신청서 2쪽: "Additional 3% charge for Credit Card Payment". */
export const CREDIT_CARD_SURCHARGE = 0.03;

/** 신청서의 결제 수단 네 가지. 신용카드만 3% 가 붙는다. */
export const PAYMENT_METHODS = ["Cheque", "Credit card", "E-transfer", "Cash"] as const;

/** 지금 파는 회원권 시즌. 온라인 신청서가 이 시즌으로 낸다. */
export const MEMBERSHIP_SEASON = 2027;

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
 * 요금표대로의 금액(HST 포함). 카트 패키지는 한 사람 몫(1/2 카트) 하나로 센다 — 부부가 둘 다
 * 사면 직원이 금액을 고친다. Full 은 연습장이 포함이라 이용권 값을 더하지 않는다.
 * 신용카드로 내면 합계에 3% 를 얹는다.
 */
export function listPrice(m: {
  membership_type: MembershipType;
  plan: MembershipPlan;
  cart_package: CartPackage | null;
  range_pass: boolean;
  payment_method?: string | null;
}): number {
  const type = typeInfo(m.membership_type);
  const base = m.plan === "spousal" && type.spousal ? type.spousal : type.single;
  const cart = CART_PACKAGES.find((c) => c.key === m.cart_package)?.price ?? 0;
  const range = m.range_pass && !type.rangeIncluded ? RANGE_PASS_PRICE : 0;
  const subtotal = base + cart + range;
  return round2(m.payment_method === "Credit card" ? subtotal * (1 + CREDIT_CARD_SURCHARGE) : subtotal);
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
