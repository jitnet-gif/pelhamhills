/**
 * 홀 수별 1인 그린피(세전)와 9홀 시각 규칙. 2026-10-18 클럽 요금표:
 *   - 9홀 평일 $28.31, 오전 10시부터 마감까지
 *   - 9홀 주말·공휴일 $38.94, 오후 3시부터 마감까지 (공휴일 개별 18홀 요금과 무관)
 * DB 의 `pelham_tee_rate_for`·`pelham_tee_nine_from`(0034), 백엔드 `tee_sheet.py` 의 NINE_HOLE_* 와
 * 같은 값이어야 한다 — 화면이 미리 보여 주는 금액·버튼과 서버가 실제로 받는 것이 달라지지 않게.
 * 요금을 바꾸면 세 곳을 같이 고쳐라.
 */
import type { DayType } from "@/lib/teeSheet/types";

const NINE_HOLES = {
  weekday: { rate: 28.31, fromMinutes: 10 * 60, rule: "9 holes from 10:00 AM on weekdays" },
  weekend: { rate: 38.94, fromMinutes: 15 * 60, rule: "9 holes from 3:00 PM on weekends & holidays" },
} as const;

/** 18홀 요금과 dayType 만 아는 슬롯. dayType 이 없으면(0034 이전 서버) 평일 18홀 요금인지로 가른다. */
type SlotLike = { rate: number; minutes: number; dayType?: DayType };

function nineTerms(slot: SlotLike) {
  const kind = slot.dayType ?? (Math.round(slot.rate * 100) === 4779 ? "weekday" : "weekend");
  return kind === "weekday" ? NINE_HOLES.weekday : NINE_HOLES.weekend;
}

export function greenFeeFor(slot: SlotLike, holes: 9 | 18): number {
  return holes === 9 ? nineTerms(slot).rate : slot.rate;
}

/** 손님이 이 티타임을 9홀로 잡을 수 있나. 직원 시트는 막지 않는다. */
export function nineHolesOpen(slot: SlotLike): boolean {
  return slot.minutes >= nineTerms(slot).fromMinutes;
}

/** "9 holes from 10:00 AM on weekdays" — 9홀 버튼이 꺼졌을 때 옆에 단다. */
export function nineHoleRule(slot: SlotLike): string {
  return nineTerms(slot).rule;
}
