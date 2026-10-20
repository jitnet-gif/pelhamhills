// 클럽의 일출·일몰 — 티시트 상단 표시(DateNav)와 자물쇠 칸(WeekGrid·예약 화면)이 함께 쓴다.
//
// SQL `pelham_tee_sun`(0048)·백엔드 `tee_sheet.sun_minutes` 와 **같은 식, 같은 반올림**(분 아래 버림)이다.
// 셋이 어긋나면 화면에서 열린 칸을 DB 트리거가 거절하거나 그 반대가 된다.
// 자동으로 열리는 칸: 일출 <= 티타임 <= 일몰 - 2시간 (0051). 그날 격자에는 일출 칸이 하나 더 있다.
// 직원이 칸마다 블록·릴리스한 값(`pelham_tee_slot_locks`)이 자동 판정보다 앞선다.

import { minutesToTime, timeToMinutes, toDate } from "@/lib/teeSheet/dates";

// Pelham Hills Golf Club, Welland ON. 시간대를 고정 상수로 두는 이유: 서버(UTC일 수 있음)와
// 브라우저가 서로 다른 TZ여도 같은 문자열이 나와야 하이드레이션이 깨지지 않는다.
export const CLUB_LAT = 43.03;
export const CLUB_LON = -79.29;
export const CLUB_TZ = "America/Toronto";
const CLUB_CLOCK = new Intl.DateTimeFormat("en-US", {
  hour: "2-digit",
  hourCycle: "h23",
  minute: "2-digit",
  timeZone: CLUB_TZ,
});

/** UTC 자정 기준 분 → 클럽 현지(America/Toronto) 자정 기준 분. */
function toClubMinutes(iso: string, utcMinutes: number): number {
  if (!Number.isFinite(utcMinutes)) return Number.NaN;
  const [y, m, d] = iso.split("-").map(Number);
  const instant = new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1) + utcMinutes * 60_000);
  const [hh, mm] = CLUB_CLOCK.format(instant).split(":").map(Number);
  return hh * 60 + mm;
}

/**
 * NOAA General Solar Position Calculations (태양 천정각 90.833°)의 축약 구현.
 * 결과는 "클럽 현지 시각" 기준 자정부터의 분이며, 해가 뜨지 않는 위도에서는 acos가 NaN을 낸다.
 */
export function sunMinutes(iso: string): { sunrise: number; sunset: number } {
  const date = toDate(iso);
  const dayOfYear = Math.round((date.getTime() - new Date(date.getFullYear(), 0, 1).getTime()) / 86_400_000) + 1;
  const g = ((2 * Math.PI) / 365) * (dayOfYear - 1); // fractional year, 정오 기준
  const eqTime =
    229.18 *
    (0.000075 +
      0.001868 * Math.cos(g) -
      0.032077 * Math.sin(g) -
      0.014615 * Math.cos(2 * g) -
      0.040849 * Math.sin(2 * g));
  const decl =
    0.006918 -
    0.399912 * Math.cos(g) +
    0.070257 * Math.sin(g) -
    0.006758 * Math.cos(2 * g) +
    0.000907 * Math.sin(2 * g) -
    0.002697 * Math.cos(3 * g) +
    0.00148 * Math.sin(3 * g);
  const lat = (CLUB_LAT * Math.PI) / 180;
  const cosHa = Math.cos((90.833 * Math.PI) / 180) / (Math.cos(lat) * Math.cos(decl)) - Math.tan(lat) * Math.tan(decl);
  const ha = (Math.acos(cosHa) * 180) / Math.PI; // |cosHa| > 1 → NaN (백야/극야)
  const solarNoonUtc = 720 - 4 * CLUB_LON - eqTime; // UTC 자정부터의 분
  return {
    sunrise: toClubMinutes(iso, solarNoonUtc - 4 * ha),
    sunset: toClubMinutes(iso, solarNoonUtc + 4 * ha),
  };
}

/** 일몰 몇 분 전까지 티타임을 받나. SQL `pelham_tee_window` 의 120 과 같다. */
export const LAST_TEE_BEFORE_SUNSET_MINUTES = 120;

// 9분 격자(6:40 AM ~ 6:58 PM). `pelham_tee_grid`·`tee_sheet.py` 와 같다.
const GRID_FIRST = 400;
const GRID_LAST = 1138;
const GRID_STEP = 9;

/** 그날 자동으로 열리는 첫 티(일출)와 마지막 티(일몰 2시간 전). */
export function teeWindow(iso: string): { first: number; last: number } {
  const { sunrise, sunset } = sunMinutes(iso);
  return { first: sunrise, last: sunset - LAST_TEE_BEFORE_SUNSET_MINUTES };
}

/** 그날 격자 위의 시각인가: 9분 격자 + 일출 칸. */
export function isOnGrid(iso: string, minutes: number): boolean {
  if (minutes >= GRID_FIRST && minutes <= GRID_LAST && (minutes - GRID_FIRST) % GRID_STEP === 0) return true;
  const { sunrise } = sunMinutes(iso);
  return minutes === sunrise && sunrise > GRID_FIRST && sunrise < GRID_LAST;
}

/** 수동 설정 없이 잠기는 칸인가(일출 전, 일몰 2시간 전 이후). 계산이 안 되는 날(NaN)은 잠그지 않는다. */
export function isAutoLocked(iso: string, minutes: number): boolean {
  const { first, last } = teeWindow(iso);
  if (!Number.isFinite(first) || !Number.isFinite(last)) return false;
  return minutes < first || minutes > last;
}

/** 수동 블록·릴리스. 키는 `slotLockKey`, 값 true = 블록, false = 릴리스. */
export type SlotLocks = ReadonlyMap<string, boolean>;

export function slotLockKey(iso: string, minutes: number): string {
  return `${iso}|${minutes}`;
}

/** 그 칸이 지금 잠겨 있나 — 수동 설정이 있으면 그것, 없으면 자동 판정. 그날 격자 밖은 늘 잠김. */
export function isSlotLocked(iso: string, minutes: number, locks: SlotLocks): boolean {
  if (!isOnGrid(iso, minutes)) return true;
  return locks.get(slotLockKey(iso, minutes)) ?? isAutoLocked(iso, minutes);
}

/** 잠긴 칸이면 직원에게 보일 이유 한 줄, 아니면 null. 트리거(0051)의 문구와 맞춘다. */
export function slotLockReason(iso: string, time: string, locks: SlotLocks): string | null {
  const minutes = timeToMinutes(time);
  if (!Number.isFinite(minutes) || !isSlotLocked(iso, minutes, locks)) return null;
  if (!isOnGrid(iso, minutes)) return `${time} is not a tee time on this day.`;
  if (locks.get(slotLockKey(iso, minutes)) === true) return `${time} is blocked. Click the lock to release it.`;
  const { first, last } = teeWindow(iso);
  return minutes < first
    ? `${time} is before sunrise (${minutesToTime(first)}). Click the lock to release it.`
    : `${time} is too close to sunset — the last tee time is ${minutesToTime(last)}. Click the lock to release it.`;
}
