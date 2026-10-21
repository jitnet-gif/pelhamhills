/**
 * 예약 한 건을 다른 티 타임에 **복사**하는 규칙. 상세 패널의 Clone 과 티 시트 두 장 사이의
 * 드래그 복사(WeekGrid)가 같은 것을 옮겨야 해서 여기 한 곳에 둔다.
 *
 * 옮기는 것: 이름·연락처·요금제·카트와 예약의 홀 수·요금·색·메모.
 * 옮기지 않는 것: 도착·결제·노쇼 — 새 라운드의 일이다. 취소된 선수도 뺀다.
 */
import type { CreateBookingInput, TeeBooking } from "./types";

/** 복사본이 잡을 좌석 수 = 취소되지 않은 선수 수(최소 1). */
export function copySeats(source: TeeBooking): number {
  return Math.max(1, source.players.filter((player) => !player.cancelled).length);
}

export function copyBookingInput(source: TeeBooking, date: string, time: string): CreateBookingInput {
  return {
    date,
    time,
    title: source.title,
    holes: source.holes,
    rate: source.rate,
    cartCount: source.cartCount,
    color: source.color,
    notes: source.notes ?? "",
    players: source.players
      .filter((player) => !player.cancelled)
      .map((player) => ({
        firstName: player.firstName ?? "",
        lastName: player.lastName ?? "",
        email: player.email ?? "",
        phone: player.phone ?? "",
        type: player.type,
        ratePlan: player.ratePlan,
        cart: player.cart === true,
        cartFee: player.cart ? (player.cartFee ?? 0) : 0,
      })),
  };
}
