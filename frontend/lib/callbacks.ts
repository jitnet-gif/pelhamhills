/**
 * 전화 상담 콜백 명단(0059) — Reports 의 Phone callbacks 탭이 부르는 직원 함수.
 * 함수 이름과 인자는 `supabase/migrations/0059_callback_requests.sql` 와 글자 그대로 같다.
 *
 * 접수는 전화 비서가 한다(`request_callback`, 업무시간 밖에 손님이 사람과 얘기해야 할 때).
 * 직원은 업무시간에 전화하고 "Called" 로 바꾼다.
 */

import { CLUB_TIME_ZONE } from "@/lib/retail/receipt";
import { staffRpc } from "@/lib/teeSheet/staffRpc";

export type CallbackStatus = "open" | "called" | "closed";

export type CallbackRequest = {
  id: string;
  /** `CB-0101` 꼴. */
  ticket: string;
  first_name: string;
  last_name: string;
  /** 전화할 번호. 손님이 다른 번호를 말했으면 그 번호. */
  phone: string;
  /** 전화선이 준 발신번호. */
  caller_number: string | null;
  reason: string;
  preferred_time: string | null;
  conversation_id: string | null;
  status: CallbackStatus;
  notes: string | null;
  handled_at: string | null;
  handled_by: string | null;
  created_at: string;
  updated_at: string;
};

export type CallbackPatch = {
  status?: CallbackStatus;
  notes?: string;
};

export const callbacksApi = {
  list: (status?: CallbackStatus) =>
    staffRpc<CallbackRequest[]>("pelham_staff_callbacks", { p_status: status ?? null }),
  update: (id: string, patch: CallbackPatch) =>
    staffRpc<CallbackRequest>("pelham_staff_callback_update", { p_id: id, p: patch }),
};

export const CALLBACK_STATUS_LABEL: Record<CallbackStatus, string> = {
  open: "To call",
  called: "Called",
  closed: "Closed",
};

export function callbackTime(iso: string | null): string {
  if (!iso) return "—";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "—";
  return at.toLocaleString("en-CA", {
    timeZone: CLUB_TIME_ZONE,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
