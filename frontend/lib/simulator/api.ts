/**
 * 실내 골프 Bay Sheet(`/admin/simulator-sheet`)의 **유일한** 통로.
 * 함수 이름과 인자는 `supabase/migrations/0007_staff_sim.sql` 와 글자 그대로 같다.
 *
 * 전송은 티 시트와 같은 `staffRpc`(직원 로그인 토큰 + 공개 키)다. 오류는 `ApiError` 로 온다:
 * status 0 = 연결 실패, 401 = 로그인·직원 아님, 404 = 없음(또는 0007 이 아직 안 돌았다),
 * 409 = 베이 겹침, 422 = 입력 오류.
 */

import { ApiError } from "@/lib/teeSheet/api";
import { staffRpc } from "@/lib/teeSheet/staffRpc";

export type SimBay = {
  id: number;
  bay_number: number;
  bay_type: string;
  hourly_rate: number;
  is_active: boolean;
  /** 지금 상태. maintenance 는 온라인 예약과 새 배정을 막는다(0007). */
  status: BayStatus;
};

export type BayStatus = "open" | "cleaning" | "maintenance";

export type SimStatus = "confirmed" | "checked_in" | "paid" | "no_show" | "cancelled";
export type SimSource = "online" | "phone" | "walk_in" | "voice_ai";

export type SimReservation = {
  id: number;
  confirmation_code: string;
  bay_id: number;
  date: string; // YYYY-MM-DD
  start_time: string; // HH:MM
  duration_hours: number;
  player_count: number;
  customer_name: string;
  customer_email: string;
  phone: string;
  notes: string;
  status: SimStatus;
  source: SimSource;
  /** 접수 시각(ISO). 서버는 늘 보내지만 예전 화면 코드에는 없던 칸이라 선택으로 둔다. */
  created_at?: string | null;
};

export type SimReservationInput = Omit<SimReservation, "id" | "confirmation_code">;

/** 오른손 전용 베이 번호. 나머지는 오른손·왼손 겸용이다. */
export const RIGHT_HAND_ONLY_BAYS = [1];

export const simApi = {
  bays: () => staffRpc<SimBay[]>("pelham_staff_sim_bays"),
  setBayStatus: (bay: number, status: BayStatus) =>
    staffRpc<SimBay>("pelham_staff_sim_bay_status", { p_bay: bay, p_status: status }),
  reservations: (date: string) =>
    staffRpc<SimReservation[]>("pelham_staff_sim_reservations", { p_date: date }),
  /** 0147: 기간 전체를 한 번에. 함수가 없으면 404 다. */
  reservationsRange: (from: string, to: string) =>
    staffRpc<SimReservation[]>("pelham_staff_sim_reservations_range", { p_from: from, p_to: to }),
  create: (input: SimReservationInput) =>
    staffRpc<SimReservation>("pelham_staff_sim_create", { p: input }),
  update: (id: number, patch: Partial<SimReservationInput>) =>
    staffRpc<SimReservation>("pelham_staff_sim_update", { p_id: id, p: patch }),
};

/** 화면에 띄울 한 줄. 404 는 대개 0007 을 아직 SQL Editor 에서 돌리지 않았다는 뜻이다. */
export function describeSimError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 0) return "Can't reach the server. Check the connection and try again.";
    if (error.status === 404 && /function|PGRST202|schema cache/i.test(error.message)) {
      return "Bay Sheet database functions are missing — run migration 0007 in the Supabase SQL Editor.";
    }
    return error.message;
  }
  return (error as Error)?.message ?? "Something went wrong.";
}
