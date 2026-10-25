/**
 * 전화 비서가 받은 음식 주문·현장 문제·컴플레인(0099) — 직원 함수.
 * 함수 이름과 인자는 `supabase/migrations/0099_phone_orders_reports.sql` 와 글자 그대로 같다.
 *
 * 음식 주문은 스낵바 계산대 위(`PhoneFoodOrders` compact)와 Calls & SMS 의 Food orders 탭에,
 * 문제·컴플레인은 Calls & SMS 의 Problems · Complaints 탭에 뜬다.
 */

import type { Cents } from "@/lib/retail/types";
import { staffRpc } from "@/lib/teeSheet/staffRpc";

export type FoodOrderStatus = "new" | "ready" | "picked_up" | "cancelled";

export type FoodOrderLine = {
  product_id: number;
  sku: string | null;
  name: string;
  quantity: number;
  unit_price: Cents;
  note?: string;
};

export type FoodOrder = {
  id: string;
  /** `FO-0101` 꼴. */
  ticket: string;
  first_name: string;
  last_name: string;
  phone: string;
  caller_number: string | null;
  items: FoodOrderLine[];
  subtotal: Cents;
  tax: Cents;
  total: Cents;
  pickup_time: string | null;
  notes: string | null;
  conversation_id: string | null;
  status: FoodOrderStatus;
  staff_notes: string | null;
  handled_at: string | null;
  handled_by: string | null;
  created_at: string;
  updated_at: string;
};

export type ReportKind = "problem" | "complaint";
export type ReportStatus = "open" | "in_progress" | "resolved" | "closed";

export type PhoneReport = {
  id: string;
  /** `PB-0101`(문제) · `CP-0101`(컴플레인). */
  ticket: string;
  kind: ReportKind;
  /** 문제: cart_battery · cart_broken · course · injury · other. 컴플레인: 손님이 말한 주제. */
  category: string;
  location: string | null;
  cart_number: string | null;
  details: string;
  first_name: string;
  last_name: string;
  phone: string;
  caller_number: string | null;
  wants_callback: boolean;
  staff_alerted_at: string | null;
  conversation_id: string | null;
  status: ReportStatus;
  staff_notes: string | null;
  handled_at: string | null;
  handled_by: string | null;
  created_at: string;
  updated_at: string;
};

export const phoneRequestsApi = {
  /** `active` = new·ready 만(스낵바 화면). 비우면 전부(최근 300건). */
  foodOrders: (status?: FoodOrderStatus | "active") =>
    staffRpc<FoodOrder[]>("pelham_staff_food_orders", { p_status: status ?? null }),
  updateFoodOrder: (id: string, patch: { status?: FoodOrderStatus; staff_notes?: string }) =>
    staffRpc<FoodOrder>("pelham_staff_food_order_update", { p_id: id, p: patch }),
  reports: (kind: ReportKind, status?: ReportStatus) =>
    staffRpc<PhoneReport[]>("pelham_staff_phone_reports", { p_kind: kind, p_status: status ?? null }),
  updateReport: (id: string, patch: { status?: ReportStatus; staff_notes?: string }) =>
    staffRpc<PhoneReport>("pelham_staff_phone_report_update", { p_id: id, p: patch }),
};

export const FOOD_STATUS_LABEL: Record<FoodOrderStatus, string> = {
  new: "New",
  ready: "Ready",
  picked_up: "Picked up",
  cancelled: "Cancelled",
};

export const REPORT_STATUS_LABEL: Record<ReportStatus, string> = {
  open: "Open",
  in_progress: "In progress",
  resolved: "Resolved",
  closed: "Closed",
};

export const PROBLEM_LABEL: Record<string, string> = {
  cart_battery: "Cart battery dead",
  cart_broken: "Cart problem",
  course: "Course problem",
  injury: "Someone hurt",
  other: "Other",
};
