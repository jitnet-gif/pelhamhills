// The one tee sheet API client. Do not add a second fetch wrapper elsewhere.
//
// 2026-09-19: 주소는 더 이상 없다. 이 래퍼는 Fly.io 의 FastAPI(`/api/v1/tee-sheet/...`)
// 를 부르던 자리였지만, 그 서버는 2026-09-16 체험 종료로 꺼졌다. 메서드 이름·인자·
// 반환 타입은 **그대로 두고** 전송만 `lib/teeSheet/staffRpc.ts` 의 Supabase 함수 호출로
// 바꾼다. `hooks/useTeeSheet.ts` 와 패널들은 한 줄도 바뀌지 않는다 — 티 시트 화면의
// 동작을 건드리지 않고 백엔드만 갈아 끼우는 것이 이번 작업의 전부다.
//
// `ApiError` 는 여기 남는다. 예약 화면(`app/book/*`, `components/booking/availability.ts`)
// 과 `lib/booking/rpc.ts` 가 이 타입을 import 하고, `status === 0` 을 "연결 실패" 로 읽는다.

import type {
  AddPlayerInput,
  CreateBookingInput,
  DailyReport,
  OrchestrationStatus,
  PatchBookingInput,
  PatchPlayerInput,
  SlotsResponse,
  TaskAck,
  TeeBooking,
  TeeExtraItem,
  WeekReport,
} from "./types";

// 예전 호출부(`lib/retail/api.ts` 등)가 이 모듈을 통해 주소 헬퍼를 가져다 쓸 수 있도록
// 재수출만 유지한다. 티 시트 자신은 더 이상 쓰지 않는다.
import { apiBaseUrl } from "../apiHost";
import { todayIso } from "./dates";
import {
  staffBooking,
  staffBookingCreate,
  staffBookingDelete,
  staffBookingPatch,
  staffBookings,
  staffPlayerAdd,
  staffPlayerExtras,
  staffPlayerGreenFee,
  staffPlayerPatch,
  staffPlayerRemove,
  staffReportDaily,
  staffReportWeek,
  staffSlots,
  staffTeeExtras,
} from "./staffRpc";

export { apiBaseUrl };

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/**
 * 자동 작업(일일 배치·리마인더·정리·워커)은 Fly 의 잡 러너였다. 서버가 꺼지면서
 * 같이 멈췄고, 리마인더는 이메일 발송이 필요해 클럽이 보류했다.
 *
 * 메서드를 지우지 않고 **즉시 실패**시키는 이유: `OrchestrationPanel` 은 작업을 보낸 뒤
 * 상태를 폴링한다. 없는 주소로 보내면 패널이 2분(MAX_POLL_WINDOW_MS) 동안 도는 것처럼
 * 보인다. 바로 거절하면 패널의 `describeError` 가 "503 · 자동 작업은 …" 한 줄을 띄운다.
 * status 0 을 쓰지 않는 것도 같은 이유다 — 0 은 "서버에 닿지 못함" 으로 읽힌다.
 */
const ORCHESTRATION_STOPPED =
  "자동 작업은 Fly 서버와 함께 멈췄습니다. 티 시트와 리포트는 그대로 쓸 수 있습니다.";

function orchestrationStopped<T>(): Promise<T> {
  return Promise.reject(new ApiError(503, ORCHESTRATION_STOPPED));
}

// 반환 타입을 일부러 명시한다. 이 객체가 화면과의 계약이라, 전송을 갈아 끼우다
// 타입이 슬쩍 달라지면 바로 여기서 걸리게 하기 위해서다.
export const teeSheetApi = {
  // ===== Slots =====
  getSlots: (date: string): Promise<SlotsResponse> => staffSlots(date),

  // ===== Bookings =====
  // 예전 REST 는 from/to/date 를 모두 선택 인자로 받았다. RPC 는 언제나 구간이므로
  // 여기서 좁힌다: date 가 오면 그 하루, 한쪽만 오면 그 날 하루, 아무것도 없으면 오늘.
  // (지금 호출부는 늘 from/to 한 주를 넘긴다 — 나머지는 안전망이다.)
  listBookings: (range?: { from?: string; to?: string; date?: string }): Promise<TeeBooking[]> => {
    const from = range?.date || range?.from || range?.to || todayIso();
    const to = range?.date || range?.to || range?.from || from;
    return staffBookings(from, to);
  },

  getBooking: (id: string): Promise<TeeBooking> => staffBooking(id),

  // 생성 함수는 저장 전 doc 을 돌려준다. 카트 요금(0050)·시각별 요금(0045)은 BEFORE 트리거가
  // 저장 직전에 붙이므로 한 번 다시 읽는다. 다시 읽기가 실패해도 예약은 들어갔다.
  createBooking: async (input: CreateBookingInput): Promise<TeeBooking> => {
    const created = await staffBookingCreate(input);
    return staffBooking(created.id).catch(() => created);
  },

  patchBooking: (id: string, patch: PatchBookingInput): Promise<TeeBooking> =>
    staffBookingPatch(id, patch),

  deleteBooking: (id: string): Promise<void> => staffBookingDelete(id),

  // ===== Players =====
  addPlayer: (bookingId: string, input: AddPlayerInput): Promise<TeeBooking> =>
    staffPlayerAdd(bookingId, input),

  patchPlayer: (
    bookingId: string,
    playerId: string,
    patch: PatchPlayerInput,
  ): Promise<TeeBooking> => staffPlayerPatch(bookingId, playerId, patch),

  removePlayer: (bookingId: string, playerId: string): Promise<TeeBooking> =>
    staffPlayerRemove(bookingId, playerId),

  // ===== Extras (0026) =====
  listExtras: (): Promise<TeeExtraItem[]> => staffTeeExtras(),

  setPlayerExtras: (bookingId: string, playerId: string, codes: string[]): Promise<TeeBooking> =>
    staffPlayerExtras(bookingId, playerId, codes),

  setPlayerGreenFee: (bookingId: string, playerId: string, fee: number | null, reason: string): Promise<TeeBooking> =>
    staffPlayerGreenFee(bookingId, playerId, fee, reason),

  // ===== Reports =====
  getDailyReport: (date: string): Promise<DailyReport> => staffReportDaily(date),

  getWeekReport: (from: string, to: string): Promise<WeekReport> => staffReportWeek(from, to),

  // ===== Orchestration (중단됨) =====
  getOrchestrationStatus: (): Promise<OrchestrationStatus> =>
    orchestrationStopped<OrchestrationStatus>(),

  runDailyBatch: (_date: string): Promise<TaskAck> => orchestrationStopped<TaskAck>(),

  sendReminders: (_date: string): Promise<TaskAck> => orchestrationStopped<TaskAck>(),

  runCleanup: (_before?: string): Promise<TaskAck> => orchestrationStopped<TaskAck>(),

  runWorker: (_date?: string): Promise<TaskAck> => orchestrationStopped<TaskAck>(),
};

export default teeSheetApi;
