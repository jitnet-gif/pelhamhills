/**
 * 티 시트 결제 → 영수증 내용(`ReceiptDoc`). 예약 카드의 Payment 버튼이 이것을 찍는다.
 * 모양(로고·클럽 머리글·표·바코드)은 리테일 영수증과 같은 `lib/retail/receipt.ts` 가 그린다.
 *
 * 품목 이름은 클럽이 쓰던 Lightspeed 영수증 그대로다: `18 Hole Green Fee - Public Senior`,
 * `Half Cart (18 Holes) - Public Senior`. 아래 줄은 `이름 - Tee Time: 09/15/2026 1:30 pm`.
 *
 * 금액: 티 시트는 달러 실수(`rate` 47.79)를 쓴다. 센트로는 **여기서 한 번만** 바꾼다.
 * 세금도 여기서 계산한다 — 티 시트 서버는 세금을 기록하지 않는다. 리테일과 같은 `computeTax`
 * (서버와 같은 은행가 반올림)를 쓰므로 계산대 영수증과 1센트도 다르지 않다.
 * 결제 금액을 따로 저장하지는 않는다. 결제 뒤에 그린피를 고치면 재인쇄 영수증도 새 금액을 따른다.
 *
 * 결제 수단은 적지 않는다. 이 영수증은 계산서 없이 결제로 표시만 한 경우(0005 이전 흐름)라
 * 현금인지 카드인지 모른다 — 지어낸 "Card" 대신 `Payment` 라고 찍는다.
 * 계산서(POS·온라인)로 낸 사람은 그 계산서에 카드 끝자리·승인번호가 있으므로 재인쇄는
 * `paidBillFor` 로 찾은 계산서 영수증을 찍는다.
 */

import type { Bill } from "../pos/api";
import { CLUB_TIME_ZONE, type ReceiptDoc, type ReceiptLine } from "../retail/receipt";
import { computeTax } from "../retail/types";
import type { Player, TeeBooking } from "./types";

/**
 * 확인 코드 — 레퍼런스의 `6HOR-4M6L` 자리. id 를 사람이 읽고 부를 수 있는 모양으로 자른다.
 *
 * **뒤에서** 8자를 쓴다. Chronogolf 에서 들여온 예약 id 는 전부 `chronogolf-csv-` 로 시작해서
 * 앞에서 자르면 수천 건이 모두 같은 코드(`CHRO-NOGO`)가 된다 — 실제로 그렇게 찍힌 영수증을 봤다.
 * 뒤 8자는 Chronogolf 예약 번호의 끝자리라 사람이 대조하기도 좋다.
 */
export function confirmationCode(bookingId: string): string {
  const clean = bookingId.replace(/[^a-z0-9]/gi, "").toUpperCase();
  const tail = clean.slice(-8).padStart(8, "0");
  return `${tail.slice(0, 4)}-${tail.slice(4, 8)}`;
}

/**
 * 영수증 번호 = 예약 확인 코드 + 플레이어 id 뒤 4자. 좌석 순번을 쓰지 않는 이유: 앞사람이
 * 빠지면 순번이 당겨져서 같은 결제의 재인쇄 번호가 달라진다. 리테일의 `PH-날짜-번호` 와는
 * 모양이 달라서 두 번호가 겹칠 일이 없다.
 */
export function teeTicket(booking: TeeBooking, player: Player): string {
  const tag = player.id.replace(/[^a-z0-9]/gi, "").toUpperCase().slice(-4).padStart(4, "0");
  return `${confirmationCode(booking.id)}-${tag}`;
}

/**
 * `at` 은 **아직 결제하지 않은** 사람의 영수증을 미리 보여 줄 때 쓰는 시각이다. 결제한 사람은
 * 서버가 찍은 `paidAt` 을 쓴다 — 미리보기라고 해서 결제 시각을 지어내지 않는다.
 */
/** 한 사람 몫. 일행을 한 장에 담으려면 `teeReceiptFor`. */
export function teeReceipt(booking: TeeBooking, player: Player, options: { at?: string } = {}): ReceiptDoc {
  return teeReceiptFor(booking, [player], options);
}

/**
 * 여러 명을 **한 장**에 담은 영수증. 일행이 한 번에 계산하는 흔한 경우다 — 사람마다 그린피·카트
 * 줄이 차례로 들어가고, 세금과 합계는 전체에 대해 한 번만 계산한다. 사람마다 따로 계산해서
 * 더하면 반올림이 한 번 더 일어나 합계가 1센트 어긋난다.
 */
export function teeReceiptFor(
  booking: TeeBooking,
  players: readonly Player[],
  options: { at?: string } = {},
): ReceiptDoc {
  const lines: ReceiptLine[] = [];
  for (const player of players) {
    const plan = player.ratePlan?.trim() || "Public";
    const detail = `${player.name} - Tee Time: ${usDate(booking.date)} ${booking.time.toLowerCase()}`;
    lines.push({
      name: `${booking.holes} Hole Green Fee - ${plan}`,
      detail,
      quantity: 1,
      amount: toCents(booking.rate),
    });
    if (player.cart) {
      lines.push({
        name: `Half Cart (${booking.holes} Holes) - ${plan}`,
        detail,
        quantity: 1,
        amount: toCents(player.cartFee ?? 0),
      });
    }
  }

  const subtotal = lines.reduce((sum, line) => sum + line.amount, 0);
  const tax = computeTax(subtotal);
  // 여럿이면 마지막으로 찍힌 결제 시각. 아직 아무도 결제 전이면 창을 연 시각(`at`).
  const stamps = players
    .map((player) => player.paidAt)
    .filter((stamp): stamp is string => Boolean(stamp))
    .sort();
  const paidAt = stamps.at(-1) ?? options.at ?? null;
  const single = players.length === 1 ? players[0] : undefined;

  return {
    // 한 사람이면 그 사람의 번호, 여럿이면 예약 번호 + ALL — 한 번의 결제가 한 장, 한 번호다.
    ticket: single ? teeTicket(booking, single) : `${confirmationCode(booking.id)}-ALL`,
    // 결제한 날의 영수증이다. 이 필드가 생기기 전에 결제한 사람은 시각을 모르므로 티 날짜만 찍는다.
    date: (paidAt && clubDate(paidAt)) || booking.date,
    time: paidAt,
    employee: null,
    lines,
    subtotal,
    discount: 0,
    tax,
    total: subtotal + tax,
    paymentLabel: "Payment",
    note: null,
    refundedAt: null,
    refundReason: null,
  };
}

/**
 * 이 사람들의 그린피를 받은 계산서. 결제 기록(카드 끝자리·승인번호·결제 시각)은 계산서에만 있다.
 * 모두가 **같은 한 장**에 있어야 그 장을 돌려준다 — 따로 낸 사람들을 한 장으로 섞지 않는다.
 * 무효(void) 계산서는 결제가 아니다. 못 찾으면 null(계산서 없이 결제로 표시한 경우).
 */
export function paidBillFor(bills: readonly Bill[], bookingId: string, players: readonly Player[]): Bill | null {
  const found = new Set<Bill>();
  for (const player of players) {
    const bill = bills.find(
      (item) =>
        item.status !== "void" &&
        item.lines.some(
          (line) => line.kind === "tee_player" && line.booking_id === bookingId && line.player_id === player.id,
        ),
    );
    if (!bill) return null;
    found.add(bill);
  }
  return found.size === 1 ? [...found][0] : null;
}

/** 달러 → 센트. 47.79 × 100 = 4778.999… 이므로 반드시 반올림한다. */
function toCents(dollars: number): number {
  return Math.round(dollars * 100);
}

function usDate(iso: string): string {
  const [year, month, day] = iso.split("-");
  return year && month && day ? `${month}/${day}/${year}` : iso;
}

const CLUB_DATE = new Intl.DateTimeFormat("en-CA", {
  timeZone: CLUB_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** ISO 시각의 클럽 현지 날짜 `YYYY-MM-DD`. 토론토 밤 9시 결제는 UTC 로는 다음 날이다. */
export function clubDate(iso: string): string | null {
  const value = new Date(iso);
  if (Number.isNaN(value.getTime())) return null;
  const parts = CLUB_DATE.formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}
