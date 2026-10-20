/**
 * 고객용 티타임 가용성 어댑터.
 *
 * 백엔드에는 **"손님이 살 수 있는 티타임" 엔드포인트가 없다.** 있는 것은
 * `/tee-sheet/slots` (그날의 9분 격자 전체)와 `/tee-sheet/bookings?date=` (그날의
 * 예약 전부)뿐이고, 어드민은 그 둘을 격자에 겹쳐 그리는 것으로 충분했다.
 * 손님 화면은 "몇 자리 남았나" 하나만 필요하므로 그 계산을 여기서 한다.
 *
 * 어드민 훅(`hooks/useTeeSheet.ts`)이 쓰는 `lib/teeSheet/*` 는 손대지 않는다.
 * 저 파일들은 어드민의 계약이고, 손님 화면의 사정으로 바꾸면 격자가 따라 깨진다.
 */

import { ApiError } from "@/lib/teeSheet/api";
import type { DayType, TeeBooking, TeeSlot } from "@/lib/teeSheet/types";

/** 서버(`tee_sheet.py` 의 `PLAYERS_PER_TEE_TIME`)와 같은 값. */
export const PLAYERS_PER_TEE_TIME = 4;

export type OpenTeeTime = {
  time: string;
  minutes: number;
  rate: number;
  /** 요금 구분 (0034). 9홀 요금·시각을 고른다. 옛 서버에는 없다. */
  dayType?: DayType;
  /** 그날 요금표의 9홀 요금·판매 시작(분) (0045). 옛 서버에는 없다. */
  rate9?: number;
  nineFrom?: number;
  /** 이 시각의 18홀 요금이 그날 기본가와 다르다(트와일라잇, 0041). 옛 서버에는 없다. */
  twilight?: boolean;
  /** 이 티타임에 아직 팔 수 있는 자리 수 (0이면 만석). */
  remaining: number;
};

export type DayPart = "morning" | "afternoon" | "evening";
export type DayPartFilter = DayPart | "all";

// ===== 날짜 헬퍼 ========================================================
//
// `new Date().toISOString().slice(0,10)` 을 쓰지 않는다. 그건 UTC 기준이라
// 온타리오 저녁 8시(= UTC 다음 날 01시)부터 "오늘" 이 내일로 바뀐다. 손님이
// 저녁에 열면 오늘 티타임이 목록에서 통째로 사라지는 셈이다.

export function toIsoDate(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function todayIso(): string {
  return toIsoDate(new Date());
}

/** ISO 날짜를 **현지 시간** Date 로. `new Date("2026-09-08")` 는 UTC 자정이라
 *  UTC-5 에서 하루 전으로 렌더된다. */
export function fromIsoDate(iso: string): Date {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(year, (month ?? 1) - 1, day ?? 1);
}

export function addDaysIso(iso: string, days: number): string {
  const date = fromIsoDate(iso);
  date.setDate(date.getDate() + days);
  return toIsoDate(date);
}

/** 오늘부터 `count` 일치 ISO 날짜. 날짜 칩 줄에 쓴다. */
export function upcomingDates(count: number, start = todayIso()): string[] {
  return Array.from({ length: count }, (_, index) => addDaysIso(start, index));
}

export function formatChipDate(iso: string): { weekday: string; day: string; month: string } {
  const date = fromIsoDate(iso);
  return {
    weekday: date.toLocaleDateString("en-US", { weekday: "short" }),
    day: String(date.getDate()),
    month: date.toLocaleDateString("en-US", { month: "short" }),
  };
}

export function formatLongDate(iso: string): string {
  return fromIsoDate(iso).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

/** 자정 기준 분. 서버의 `label_to_minutes` 와 같은 규칙. */
export function labelToMinutes(label: string): number | null {
  const match = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(label.trim());
  if (!match) return null;
  const hour = Number(match[1]) % 12;
  const offset = match[3].toUpperCase() === "PM" ? 12 : 0;
  return (hour + offset) * 60 + Number(match[2]);
}

export function dayPartOf(minutes: number): DayPart {
  if (minutes < 12 * 60) return "morning";
  if (minutes < 16 * 60) return "afternoon";
  return "evening";
}

export const DAY_PART_LABEL: Record<DayPartFilter, string> = {
  all: "Any time",
  morning: "Morning",
  afternoon: "Afternoon",
  evening: "Evening",
};

// ===== 자리 계산 ========================================================

/**
 * 슬롯 + 그날의 예약 → 손님이 실제로 살 수 있는 티타임.
 *
 * 규칙은 서버의 `tee_time_players()` 를 그대로 따른다: **취소된 예약은 자리를
 * 잡지 않는다.** 여기서 다르게 세면 손님 화면엔 자리가 보이는데 POST 는 409 로
 * 튕기는(또는 그 반대의) 어긋남이 생긴다.
 *
 * 서버 규칙에 **더해서** 두 가지를 손님에게서 숨긴다. 둘 다 서버는 막지 않으므로
 * 여기서 막지 않으면 손님이 못 쓸 시간을 사게 된다.
 *
 * 1. `blocked` 예약이 걸린 티타임. 대회·정비로 막아 둔 자리인데 플레이어가 0명이라
 *    자리 계산상으로는 4자리가 다 비어 보이고, POST 도 성공해 버린다.
 * 2. 이미 지나간 시각. 서버에는 "과거 티타임 예약 금지" 규칙이 없다. 오늘 날짜에서
 *    지난 시간을 파는 것은 손님에게도 프로 샵에게도 사고다.
 */
export function buildOpenTeeTimes(
  slots: TeeSlot[],
  bookings: TeeBooking[],
  isoDate: string,
  now: Date = new Date(),
): OpenTeeTime[] {
  const taken = new Map<string, number>();
  const blocked = new Set<string>();

  for (const booking of bookings) {
    if (booking.date !== isoDate) continue;
    if (booking.status === "cancelled") continue;
    if (booking.status === "blocked") blocked.add(booking.time);
    taken.set(booking.time, (taken.get(booking.time) ?? 0) + booking.players.length);
  }

  const isToday = isoDate === toIsoDate(now);
  const nowMinutes = now.getHours() * 60 + now.getMinutes();

  const open: OpenTeeTime[] = [];
  for (const slot of slots) {
    if (blocked.has(slot.time)) continue;
    if (isToday && slot.minutes <= nowMinutes) continue;
    open.push({
      time: slot.time,
      minutes: slot.minutes,
      rate: slot.rate,
      dayType: slot.dayType,
      rate9: slot.rate9,
      nineFrom: slot.nineFrom,
      remaining: Math.max(PLAYERS_PER_TEE_TIME - (taken.get(slot.time) ?? 0), 0),
    });
  }
  return open;
}

// ===== 오류 문구 ========================================================

export type BookingFailure = {
  /** 손님에게 보여줄 문장. 서버 주소는 절대 들어가지 않는다. */
  message: string;
  /** 네트워크가 안 닿았다 — 다시 시도 + 전화 안내가 맞는 착지점. */
  offline: boolean;
  /** 409: 고르는 사이에 자리가 나갔다. 목록을 다시 불러와야 한다. */
  conflict: boolean;
};

/**
 * `lib/teeSheet/api.ts` 는 `Response` 가 아니라 `ApiError` 를 던지므로
 * `app/simulator/page.tsx` 의 `readError(response, ...)` 를 그대로 쓸 수 없다.
 * 대신 같은 결을 지킨다 — 실패를 하나의 문구로 뭉개지 않고, 서버가 준 `detail`
 * 이 있으면 그걸 보여주고, 어떤 경우에도 백엔드 주소는 문구에 넣지 않는다.
 */
export function describeFailure(error: unknown, action: string): BookingFailure {
  if (error instanceof ApiError) {
    // status 0 은 "주소가 없다" 와 "못 닿았다" 둘 다다. 그 안의 message 는
    // fetch 가 뱉은 원문(호스트가 섞여 있을 수 있다)이라 손님에게 보여주지 않는다.
    if (error.status === 0) {
      return {
        message: `Could not reach the booking server. ${action} Please try again in a moment, or call us.`,
        offline: true,
        conflict: false,
      };
    }
    if (error.status === 409) {
      return {
        message: "Someone just took that tee time. Here are the times that are still open.",
        offline: false,
        conflict: true,
      };
    }
    // 그 외에는 서버가 보낸 detail 이 이미 사람이 읽는 문장이다 (422 검증 메시지 등).
    return { message: error.message || action, offline: false, conflict: false };
  }

  if (error instanceof TypeError) {
    return {
      message: `Could not reach the booking server. ${action} Please try again in a moment, or call us.`,
      offline: true,
      conflict: false,
    };
  }

  return {
    message: error instanceof Error && error.message ? error.message : action,
    offline: false,
    conflict: false,
  };
}

/** "Micah Xeric" -> ["Micah", "Xeric"]. 서버 `split_name` 과 같은 규칙(성은 마지막 토큰). */
export function splitName(full: string): [string, string] {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return ["Guest", ""];
  if (parts.length === 1) return [parts[0], ""];
  return [parts.slice(0, -1).join(" "), parts[parts.length - 1]];
}
