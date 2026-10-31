"use client";

/**
 * Operations 리포트의 숫자를 눌렀을 때 그 숫자를 이루는 예약·선수를 펼쳐 보여 준다.
 *
 * 서버를 다시 부르지 않고 컨트롤러가 이미 읽어 둔 그 주 예약(`controller.bookings`)에서
 * `pelham_tee_daily_report`(0004·0026) 와 같은 규칙으로 거른다:
 * - 금액·인원 = 취소되지 않은 예약의 취소되지 않은 선수. 1인 = 예약 rate + 카트 요금 + 추가 품목.
 * - 체크인·취소·노쇼 = 예약의 status. 카트 = 취소되지 않은 예약의 cartCount.
 * 그래서 합계는 누른 칸의 숫자와 같아야 한다. 다르면(목록을 읽은 뒤 예약이 바뀌었거나 만료된
 * 음성 홀드) 아래 안내 줄에서 바로 보인다.
 *
 * 줄을 누르면 티 시트에서 그 예약을 연다. POS 계산서에는 예약 id 가 없어 영수증으로는 못 간다.
 */

import Link from "next/link";

import { EmptyNote, Modal } from "@/components/retail/ui";
import { columnLabel, longDate, money } from "@/lib/teeSheet/dates";
import type { Player, TeeBooking } from "@/lib/teeSheet/types";

export type ReportMetric =
  | "booked"
  | "total"
  | "collected"
  | "outstanding"
  | "checked_in"
  | "cancelled"
  | "no_show"
  | "carts";

export type ReportDrill = {
  metric: ReportMetric;
  dates: string[];
  /** 누른 칸의 숫자. 목록의 합과 다르면 안내한다. */
  expected: number;
};

const TITLES: Record<ReportMetric, string> = {
  booked: "Booked players",
  total: "Total",
  collected: "Collected",
  outstanding: "Outstanding",
  checked_in: "Checked in",
  cancelled: "Cancelled",
  no_show: "No show",
  carts: "Carts",
};

const BOOKING_STATUS: Partial<Record<ReportMetric, TeeBooking["status"]>> = {
  checked_in: "checked_in",
  cancelled: "cancelled",
  no_show: "no_show",
};

type Row = {
  key: string;
  booking: TeeBooking;
  primary: string;
  badge: string;
  /** 선수 줄은 달러, 카트 칸은 대수. 건수만 세는 칸(`isCount`)에서는 쓰지 않는다. */
  amount: number;
};

/** 서버 일일 리포트·`useTeeSheet` 의 stats 와 같은 식. */
function playerDue(booking: TeeBooking, player: Player): number {
  return (
    booking.rate +
    (player.cart ? (player.cartFee ?? 0) : 0) +
    (player.extras ?? []).reduce((sum, extra) => sum + extra.price, 0)
  );
}

function round2(value: number) {
  return Math.round(value * 100) / 100;
}

function playerRows(bookings: TeeBooking[], metric: ReportMetric): Row[] {
  return bookings
    .filter((booking) => booking.status !== "cancelled")
    .flatMap((booking) =>
      booking.players
        .filter((player) => !player.cancelled)
        .filter((player) =>
          metric === "collected" ? player.paid : metric === "outstanding" ? !player.paid : true,
        )
        .map((player) => ({
          key: `${booking.id}-${player.id}`,
          booking,
          primary: player.name.trim() || booking.title,
          badge: player.paid ? "Paid" : "Unpaid",
          amount: playerDue(booking, player),
        })),
    );
}

function rowsFor(bookings: TeeBooking[], metric: ReportMetric): Row[] {
  const status = BOOKING_STATUS[metric];
  if (status) {
    return bookings
      .filter((booking) => booking.status === status)
      .map((booking) => ({
        key: booking.id,
        booking,
        primary: booking.title,
        badge: "",
        amount: 0,
      }));
  }
  if (metric === "carts") {
    return bookings
      .filter((booking) => booking.status !== "cancelled" && booking.cartCount > 0)
      .map((booking) => ({
        key: booking.id,
        booking,
        primary: booking.title,
        badge: "",
        amount: booking.cartCount,
      }));
  }
  return playerRows(bookings, metric);
}

export default function ReportDrilldown({
  drill,
  bookings,
  onClose,
}: {
  drill: ReportDrill;
  bookings: TeeBooking[];
  onClose: () => void;
}) {
  const { metric, dates, expected } = drill;
  const inRange = bookings.filter((booking) => dates.includes(booking.date));
  const rows = rowsFor(inRange, metric);
  const isMoney = metric === "total" || metric === "collected" || metric === "outstanding";
  const isCount = metric === "booked" || BOOKING_STATUS[metric] !== undefined;
  const sum = isCount ? rows.length : round2(rows.reduce((total, row) => total + row.amount, 0));
  const format = (value: number) => (isMoney ? money(value) : String(value));
  const range =
    dates.length === 1 ? longDate(dates[0]) : `${longDate(dates[0])} → ${longDate(dates[dates.length - 1])}`;

  return (
    <Modal onClose={onClose} title={TITLES[metric]}>
      <div className="grid gap-3">
        <p className="text-xs text-[#6b7280]">{range}</p>

        {rows.length === 0 ? (
          <EmptyNote>Nothing here for this date.</EmptyNote>
        ) : (
          <ul className="grid gap-1.5">
            {rows.map((row) => (
              <li key={row.key}>
                <Link
                  className="flex w-full items-center justify-between gap-3 border border-[#e4e4e8] px-3 py-2 text-left hover:border-[#4533ff]"
                  href={`/teesheet?date=${encodeURIComponent(row.booking.date)}&booking=${encodeURIComponent(row.booking.id)}`}
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-bold">{row.primary}</span>
                    <span className="block truncate text-xs text-[#6b7280]">
                      {dates.length > 1 ? `${columnLabel(row.booking.date)} · ` : ""}
                      {row.booking.time}
                      {row.primary === row.booking.title ? "" : ` · ${row.booking.title}`}
                      {row.badge ? " · " : ""}
                      {row.badge ? <span>{row.badge}</span> : null}
                    </span>
                  </span>
                  {isCount ? null : (
                    <span className="shrink-0 text-sm font-bold tabular-nums">{format(row.amount)}</span>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        )}

        <div className="flex items-baseline justify-between gap-2 border-t border-[#d4d4d8] pt-2">
          <span className="text-sm font-bold">Total</span>
          <span className="text-lg font-bold tabular-nums">{format(sum)}</span>
        </div>
        {Math.abs(sum - expected) >= 0.005 ? (
          <p className="text-[11px] text-[#8a3f26]">
            The report shows {format(expected)}. Press Refresh to reload it.
          </p>
        ) : null}
        <p className="text-[11px] text-[#6b7280]">Tap a row to open it in the tee sheet.</p>
      </div>
    </Modal>
  );
}
