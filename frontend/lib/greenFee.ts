/**
 * 그린피 미리보기. 진짜 값은 DB 가 매긴다(0045 `pelham_tee_rate_at`·`pelham_tee_plan_fee`) —
 * 슬롯이 그 시각의 18홀 요금(`rate`)과 그날 요금표의 9홀 요금·시작 시각(`rate9`·`nineFrom`)을 들고 온다.
 * 이 파일은 그 값을 읽기만 한다. `rate9` 가 없는 옛 서버만 아래 기본값(가을 숄더)으로 버틴다.
 */
import type { DayType, Player, TeeBooking } from "@/lib/teeSheet/types";

const NINE_FALLBACK = {
  weekday: { rate: 28.31, fromMinutes: 10 * 60 },
  weekend: { rate: 38.94, fromMinutes: 16 * 60 },
} as const;

type SlotLike = { rate: number; minutes: number; dayType?: DayType; rate9?: number; nineFrom?: number };

function nineTerms(slot: SlotLike): { rate: number; fromMinutes: number } {
  if (typeof slot.rate9 === "number" && typeof slot.nineFrom === "number") {
    return { rate: slot.rate9, fromMinutes: slot.nineFrom };
  }
  const kind = slot.dayType ?? ([4071, 3540].includes(Math.round(slot.rate * 100)) ? "weekday" : "weekend");
  return kind === "weekday" ? NINE_FALLBACK.weekday : NINE_FALLBACK.weekend;
}

export function greenFeeFor(slot: SlotLike, holes: 9 | 18): number {
  return holes === 9 ? nineTerms(slot).rate : slot.rate;
}

/** 손님이 이 티타임을 9홀로 잡을 수 있나. 직원 시트는 막지 않는다. */
export function nineHolesOpen(slot: SlotLike): boolean {
  return slot.minutes >= nineTerms(slot).fromMinutes;
}

function clock(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

/** "9 holes from 4:00 PM on this day" — 9홀 버튼이 꺼졌을 때 옆에 단다. */
export function nineHoleRule(slot: SlotLike): string {
  const from = nineTerms(slot).fromMinutes;
  return from >= 24 * 60 ? "18 holes only on this day" : `9 holes from ${clock(from)} on this day`;
}

/** 이 사람이 내는 그린피(세전): 요금제로 매긴 값(회원 0 등), 없으면 예약의 퍼블릭가. */
export function greenFeeOf(booking: Pick<TeeBooking, "rate">, player: Pick<Player, "greenFee">): number {
  return typeof player.greenFee === "number" ? player.greenFee : booking.rate;
}
