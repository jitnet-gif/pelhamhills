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
  PriceReviewRow,
  TeeExtraItem,
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

/** 직원 함수 호출. 승인(0024·0077)으로 막히면 Shift ID 창을 띄우고 한 번 더 부른다(`managerApproval`). */
export function staffRpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  return withManagerApproval(() => rawStaffRpc<T>(fn, args));
}

/**
 * 이 기기의 계산대 담당자 이름(`lib/pos/currentBill.ts` 의 `pelham.pos.cashier`). Change log(0076)가 이 헤더로
 * "누가 했나" 를 적는다 — 로그인은 공용 계정이라 이메일로는 알 수 없다. currentBill 을 import 하면 순환이라 직접 읽는다.
 */
function cashierHeader(): Record<string, string> {
  try {
    const name = window.localStorage.getItem("pelham.pos.cashier")?.trim();
    return name ? { "x-pelham-cashier": encodeURIComponent(name) } : {};
  } catch {
    return {};
  }
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
        ...cashierHeader(),
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

/** 0134: 같은 구간 `pelham_staff_bookings` 결과의 md5(32자). 다를 때만 목록을 다시 받는다. */
export const staffBookingsStamp = (from: string, to: string) =>
  staffRpc<string>("pelham_staff_bookings_stamp", { p_from: from, p_to: to });

/** 0067: 웹 예약의 유입 경로(Google search·Google Ads·Direct …). 플레이 날짜 기간. */
export type BookingAttribution = {
  kind: "tee" | "bay";
  bookingRef: string;
  label: string;
  referrerHost: string | null;
  landing: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  utmTerm: string | null;
  device: "phone" | "tablet" | "computer" | null;
  firstLabel: string | null;
  firstAt: string | null;
  recordedAt: string | null;
};

export const staffBookingAttribution = (from: string, to: string) =>
  staffRpc<BookingAttribution[]>("pelham_staff_booking_attribution", { p_from: from, p_to: to });

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

/** 사유를 주면 0056 의 3인자 함수 — 사유와 승인 매니저가 예약 기록에 남는다. 0056 이 아직 없으면 예전 함수로. */
export const staffPlayerRemove = async (bookingId: string, playerId: string, reason?: string) => {
  const base = { p_id: bookingId, p_player: playerId };
  if (!reason?.trim()) return staffRpc<TeeBooking>("pelham_staff_player_remove", base);
  try {
    return await staffRpc<TeeBooking>("pelham_staff_player_remove", { ...base, p_reason: reason.trim() });
  } catch (error) {
    if (!(error instanceof ApiError) || !/could not find the function|PGRST202|schema cache/i.test(error.message)) throw error;
    return staffRpc<TeeBooking>("pelham_staff_player_remove", base);
  }
};

// 0026: 추가 품목(풀카트·레인지 바스켓).
export const staffTeeExtras = () => staffRpc<TeeExtraItem[]>("pelham_staff_tee_extras");

export const staffPlayerExtras = (bookingId: string, playerId: string, codes: string[]) =>
  staffRpc<TeeBooking>("pelham_staff_player_extras", { p_id: bookingId, p_player: playerId, p_codes: codes });

export const staffPlayerGreenFee = (bookingId: string, playerId: string, fee: number | null, reason: string) =>
  staffRpc<TeeBooking>("pelham_staff_player_green_fee", {
    p_id: bookingId,
    p_player: playerId,
    p_fee: fee,
    p_reason: reason,
  });

export const staffPriceReview = (from: string, to: string) =>
  staffRpc<PriceReviewRow[]>("pelham_staff_price_review", { p_from: from, p_to: to });

export const staffReportDaily = (date: string) =>
  staffRpc<DailyReport>("pelham_staff_report_daily", { p_date: date });

export const staffReportWeek = (from: string, to: string) =>
  staffRpc<WeekReport>("pelham_staff_report_week", { p_from: from, p_to: to });

// 0025: 날짜별 요금(주중·주말·공휴일). 요일 탭과 주간 격자 머리에 쓴다.
export const staffRateDays = (from: string, to: string) =>
  staffRpc<RateDay[]>("pelham_staff_rate_days", { p_from: from, p_to: to });

/** 칸 하나의 수동 블록·릴리스 (0051). `locked` 는 그 칸이 실제로 잠겼는지(자동 판정 포함). */
export type SlotLockRow = { date: string; time: string; minutes: number; locked: boolean };

export const staffSlotLocks = (from: string, to: string) =>
  staffRpc<SlotLockRow[]>("pelham_staff_slot_locks", { p_from: from, p_to: to });

/** 직원 누구나 — 매니저 PIN 없음. 자동 판정과 같은 값이면 서버가 수동 설정을 지운다. */
export const staffSlotLockSet = (date: string, time: string, locked: boolean) =>
  staffRpc<SlotLockRow>("pelham_staff_slot_lock_set", { p: { date, time, locked } });

/** 날짜마다 직원이 정한 첫 티·마지막 티 (0131). first·last 는 분, null = 자동(일출·일몰 2시간 전). */
export type TeeHoursRow = { date: string; first: number | null; last: number | null };

export const staffTeeHours = (from: string, to: string) =>
  staffRpc<TeeHoursRow[]>("pelham_staff_tee_hours", { p_from: from, p_to: to });

/** 직원 누구나. 라벨("8:00 AM") 또는 null(자동). `outside` = 새 시간 밖에 남은 예약 수(옮기지 않는다). */
export const staffTeeHoursSet = (date: string, first: string | null, last: string | null) =>
  staffRpc<TeeHoursRow & { outside: number }>("pelham_staff_tee_hours_set", { p: { date, first, last } });
