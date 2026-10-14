/**
 * 프로 샵 티 시트가 서버와 말하는 **유일한** 통로.
 *
 * ## 왜 FastAPI 가 아니라 Supabase 함수인가
 * 티 시트 API(`pelhamhills-api.fly.dev`)는 2026-09-16 Fly.io 체험 종료로 꺼졌다. 손님
 * 예약은 이미 `supabase/migrations/0003_public_booking.sql` 의 함수로 옮겼고
 * (`lib/booking/rpc.ts`), 프로 샵 화면도 같은 방식으로 옮긴다. 이 사이트는 정적
 * export 라 비밀 키를 들 곳이 없으므로, 브라우저가 공개(publishable) 키 **+ 로그인한
 * 직원의 토큰**으로 `0004_staff_tee_sheet.sql` 의 `pelham_staff_*` 함수를 직접 부른다.
 *
 * 손님용 함수(`pelham_tee_*`)와 다른 점은 딱 하나다: 이쪽은 `authenticated` 에게만
 * 실행 권한이 있고, 함수마다 직원인지 확인한 뒤 아니면 SQLSTATE `PT401` 로 거절한다.
 * 그래서 요청에는 `Authorization: Bearer <액세스 토큰>` 이 반드시 붙는다.
 *
 * ## 오류
 * PostgREST 는 `PTxxx` SQLSTATE 를 같은 숫자의 HTTP 상태로 내보낸다. 그래서 `PT404` 는
 * 404, `PT409` 는 409 로 도착하고, 화면은 기존 `ApiError.status` 분기를 그대로 쓴다.
 * **status 0 은 진짜 네트워크 실패에만 쓴다** — `useTeeSheet` 가 0 을 "오프라인"으로
 * 읽고 샘플 예약(손님 이름이 들어 있는 시드)을 화면에 깔기 때문이다. 로그인이
 * 없는 상태는 0 이 아니라 401 이다.
 */

import { ApiError } from "./api";
import { withManagerApproval } from "./managerApproval";
import { PUBLISHABLE_KEY, SUPABASE_URL, accessToken, clearSession } from "./session";
import type {
  AddPlayerInput,
  CreateBookingInput,
  DailyReport,
  PatchBookingInput,
  PatchPlayerInput,
  RateDay,
  SlotsResponse,
  TeeBooking,
  WeekReport,
} from "./types";

/** 로그인하지 않은 채 직원 함수를 부를 때. 요청은 보내지 않는다. */
const NEEDS_SIGN_IN = "로그인이 필요합니다. 프로 샵 계정으로 다시 로그인해 주세요.";

/** 토큰이 만료·거부됐을 때. 세션을 버리고 로그인 화면으로 돌려보낸다. */
const SESSION_EXPIRED = "로그인이 만료되었습니다. 다시 로그인해 주세요.";

type PostgrestError = { code?: unknown; message?: unknown; hint?: unknown; details?: unknown };

/**
 * PostgREST 자신이 낸 인증 오류인가(`PGRST301` 만료된 JWT, `PGRST302` 익명 거부 등).
 *
 * 함수 안의 직원 확인이 올린 `PT401` 과 구분해야 한다. 앞쪽은 "다시 로그인",
 * 뒤쪽은 "이 계정은 직원이 아니다" 로 화면이 완전히 달라진다.
 */
function isJwtProblem(code: unknown): boolean {
  return typeof code === "string" && code.startsWith("PGRST3");
}

/** 직원 함수 호출. 매니저 승인(0024)으로 막히면 PIN 창을 띄우고 한 번 더 부른다(`managerApproval`). */
export function staffRpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  return withManagerApproval(() => rawStaffRpc<T>(fn, args));
}

/** 매니저 PIN 확인(0024). 틀려도 오류가 아니라 `approved: false` 로 온다 — 틀린 기록이 남아야 해서. */
export function approveAsManager(pin: string, action: string, ref: string) {
  return rawStaffRpc<{ approved: boolean; manager?: string; message?: string }>("pelham_staff_manager_approve", {
    p_pin: pin,
    p_action: action,
    p_ref: ref,
  });
}

async function rawStaffRpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const token = await accessToken();
  if (!token) throw new ApiError(401, NEEDS_SIGN_IN);

  let response: Response;
  try {
    response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: {
        apikey: PUBLISHABLE_KEY,
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(args),
    });
  } catch {
    // fetch 의 원문 메시지에는 요청 주소가 섞일 수 있다. 화면에 내보내지 않는다.
    throw new ApiError(0, "Network error");
  }

  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`.trim();
    let code: unknown = null;
    try {
      const body = (await response.json()) as PostgrestError;
      code = body?.code;
      if (typeof body?.message === "string" && body.message) message = body.message;
    } catch {
      // JSON 이 아닌 오류 본문(게이트웨이 HTML 등). 상태 줄을 그대로 쓴다.
    }

    if (response.status === 401 && isJwtProblem(code)) {
      clearSession();
      throw new ApiError(401, SESSION_EXPIRED);
    }
    throw new ApiError(response.status, message);
  }

  // `returns void` 함수는 204(본문 없음)로 돌아온다. 그대로 json() 을 부르면 터진다.
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

/**
 * 직원이 아니라서 거절당했는가. 로그인 게이트가 "직원 계정이 아닙니다" 화면을
 * 띄울지 판단하는 데 쓴다.
 *
 * 401/403 **만** 본다. `0004` 마이그레이션이 아직 적용되지 않은 프로젝트에서는
 * PostgREST 가 404(`PGRST202`, 함수를 찾을 수 없음)를 돌려주는데, 그것을 "직원 아님"
 * 으로 읽으면 진짜 직원 전원이 잠긴다. 404·5xx·네트워크 오류는 통과시키고 티 시트
 * 자신의 오류 표시에 맡긴다.
 */
export function isStaffDenied(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 401 || error.status === 403);
}

// ===== 계약서의 열한 개 함수 ==============================================
// 이름과 인자는 `supabase/migrations/0004_staff_tee_sheet.sql` 가 정의한 그대로다.
// 여기서 이름을 바꾸면 SQL 쪽과 조용히 어긋난다.

export const staffSlots = (date: string) =>
  staffRpc<SlotsResponse>("pelham_staff_slots", { p_date: date });

export const staffBookings = (from: string, to: string) =>
  staffRpc<TeeBooking[]>("pelham_staff_bookings", { p_from: from, p_to: to });

export const staffBooking = (id: string) =>
  staffRpc<TeeBooking>("pelham_staff_booking", { p_id: id });

export const staffBookingCreate = (input: CreateBookingInput) =>
  staffRpc<TeeBooking>("pelham_staff_booking_create", { p: input });

export const staffBookingPatch = (id: string, patch: PatchBookingInput) =>
  staffRpc<TeeBooking>("pelham_staff_booking_patch", { p_id: id, p: patch });

export const staffBookingDelete = (id: string) =>
  staffRpc<void>("pelham_staff_booking_delete", { p_id: id });

export const staffPlayerAdd = (bookingId: string, input: AddPlayerInput) =>
  staffRpc<TeeBooking>("pelham_staff_player_add", { p_id: bookingId, p: input });

export const staffPlayerPatch = (bookingId: string, playerId: string, patch: PatchPlayerInput) =>
  staffRpc<TeeBooking>("pelham_staff_player_patch", {
    p_id: bookingId,
    p_player: playerId,
    p: patch,
  });

export const staffPlayerRemove = (bookingId: string, playerId: string) =>
  staffRpc<TeeBooking>("pelham_staff_player_remove", { p_id: bookingId, p_player: playerId });

export const staffReportDaily = (date: string) =>
  staffRpc<DailyReport>("pelham_staff_report_daily", { p_date: date });

export const staffReportWeek = (from: string, to: string) =>
  staffRpc<WeekReport>("pelham_staff_report_week", { p_from: from, p_to: to });

// 0025: 날짜별 요금(주중·주말·공휴일). 요일 탭과 주간 격자 머리에 쓴다.
export const staffRateDays = (from: string, to: string) =>
  staffRpc<RateDay[]>("pelham_staff_rate_days", { p_from: from, p_to: to });
