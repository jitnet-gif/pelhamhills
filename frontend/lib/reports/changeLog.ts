/**
 * Change log — 모든 변경의 전·후 장부(0057 `pelham_staff_change_log`). 지운 줄도 "지우기 전" 이 남는다.
 *
 * 비밀번호는 매번 같이 보낸다(서버가 확인한다). 화면은 메모리(state)에만 들고 저장소에는 넣지 않는다 —
 * 탭을 닫거나 새로 열면 다시 묻는다. 틀린 비밀번호는 오류가 아니라 `{ok:false}` 로 온다.
 */

import { staffRpc } from "@/lib/teeSheet/staffRpc";

export type ChangeOp = "insert" | "update" | "delete";

export type ChangeRow = {
  id: number;
  at: string;
  table: string;
  rowKey: string | null;
  op: ChangeOp;
  label: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  changed: string[] | null;
  actor: string;
};

export type ChangeLogResult =
  | { ok: true; rows: ChangeRow[]; more: boolean }
  | { ok: false; message: string; locked?: boolean; triesLeft?: number };

export function fetchChangeLog(input: {
  password: string;
  from: string;
  to: string;
  table?: string;
  search?: string;
  beforeId?: number;
}): Promise<ChangeLogResult> {
  return staffRpc<ChangeLogResult>("pelham_staff_change_log", {
    p_password: input.password,
    p_from: input.from,
    p_to: input.to,
    p_table: input.table || null,
    p_search: input.search || null,
    p_before_id: input.beforeId ?? null,
  });
}

/** 테이블 이름 → 화면 이름. 목록에 없는 테이블은 `pelham_` 을 떼고 보여 준다. */
export const TABLE_LABEL: Record<string, string> = {
  pelham_tee_bookings: "Tee booking",
  pelham_tee_extras: "Tee extra",
  pelham_tee_waitlist: "Waitlist",
  pelham_tee_holidays: "Holiday",
  pelham_tee_rate_bands: "Rate band",
  pelham_tee_rate_cards: "Rate card",
  pelham_tee_price_overrides: "Player price",
  pelham_bills: "Bill",
  pelham_bill_lines: "Bill line",
  pelham_bill_payments: "Payment",
  pelham_rain_checks: "Rain check",
  pelham_register_closes: "Register close",
  pelham_staff_closeouts: "Staff closeout",
  pelham_online_payments: "Online payment",
  pelham_terminal_transactions: "Card terminal",
  pelham_retail_products: "Product",
  pelham_retail_sales: "Retail sale",
  pelham_retail_stock_moves: "Stock move",
  pelham_customers: "Customer",
  pelham_memberships: "Membership",
  pelham_membership_payments: "Membership payment",
  pelham_sim_bays: "Simulator bay",
  pelham_sim_reservations: "Simulator booking",
  pelham_lost_items: "Lost item",
  pelham_marketing_campaigns: "Campaign",
  pelham_marketing_optouts: "Marketing opt-out",
  pelham_managers: "Manager",
  pelham_cash_viewers: "Cash report list",
  pelham_marketing_viewers: "Marketing list",
};

export const tableLabel = (table: string) => TABLE_LABEL[table] ?? table.replace(/^pelham_/, "").replace(/_/g, " ");

// ===== 전·후 비교 ==========================================================

export type FieldChange = { path: string; before: string | null; after: string | null };

/** 예약 doc 의 History(`audit`)는 따로 보여 준다 — 40줄에서 잘리며 매번 "지워진 줄" 이 생겨 비교를 어지럽힌다. */
const SKIP = new Set(["updated_at", "doc.audit"]);

function show(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value === "" ? '""' : value;
  return JSON.stringify(value);
}

/** 배열 안의 객체는 id(없으면 name)로 짝을 짓는다 — 선수 한 명을 지우면 뒤 선수들이 모두 "바뀜" 으로 보이지 않게. */
function itemKey(item: unknown, index: number): string {
  if (item && typeof item === "object" && !Array.isArray(item)) {
    const record = item as Record<string, unknown>;
    const name = typeof record.name === "string" && record.name ? record.name : null;
    if (record.id !== undefined && record.id !== null) return name ? `${name}#${String(record.id)}` : `#${String(record.id)}`;
    if (name) return name;
  }
  return String(index);
}

function flatten(value: unknown, path: string, out: Map<string, string>) {
  if (SKIP.has(path)) return;
  if (Array.isArray(value)) {
    if (value.length === 0) out.set(path, "[]");
    value.forEach((item, index) => flatten(item, `${path}[${itemKey(item, index)}]`, out));
    return;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0 && path) out.set(path, "{}");
    for (const [key, child] of entries) flatten(child, path ? `${path}.${key}` : key, out);
    return;
  }
  if (path) out.set(path, show(value));
}

/** 바뀐 칸만. 생성이면 after 의 모든 칸, 삭제면 before 의 모든 칸. */
export function diffRows(before: unknown, after: unknown): FieldChange[] {
  const a = new Map<string, string>();
  const b = new Map<string, string>();
  if (before) flatten(before, "", a);
  if (after) flatten(after, "", b);
  const paths = [...new Set([...a.keys(), ...b.keys()])].sort();
  const changes: FieldChange[] = [];
  for (const path of paths) {
    const was = a.get(path) ?? null;
    const now = b.get(path) ?? null;
    if (was !== now) changes.push({ path, before: was, after: now });
  }
  return changes;
}

/** 이 변경으로 예약 History 에 새로 붙은 줄(있으면). "무엇을 했나" 를 사람 말로 보여 준다. */
export function newHistoryLines(before: unknown, after: unknown): string[] {
  const list = (row: unknown) => {
    const doc = row && typeof row === "object" ? (row as { doc?: { audit?: unknown } }).doc : undefined;
    return Array.isArray(doc?.audit) ? (doc.audit as { id?: string; message?: string }[]) : [];
  };
  const seen = new Set(list(before).map((entry) => entry.id));
  return list(after)
    .filter((entry) => !seen.has(entry.id) && typeof entry.message === "string")
    .map((entry) => entry.message as string);
}
