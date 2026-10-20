"use client";

/**
 * 채널별 예약 — 웹사이트와 전화로 들어온 예약을 티 타임·실내 베이 구분 없이 한 목록에.
 * Reports(`/admin/reports?view=bookings`)의 한 탭이다.
 *
 * 채널은 각 장부의 `source` 칸으로 나눈다(새 저장소 없음):
 *   - 티 시트(`pelham_tee_bookings`, 0002): web → Website, voice → Phone(음성 에이전트).
 *     voice_hold 는 통화 중 임시 잠금이라 예약이 아니다 — 뺀다. staff 는 직원이 직접 넣은 것.
 *   - 베이(`pelham_sim_reservations`, 0007): online → Website, phone·voice_ai → Phone. walk_in 은 뺀다.
 * 직원이 전화를 받아 티 시트에 직접 넣은 예약은 source 가 staff 라 여기서 전화로 구분할 수 없다.
 *
 * 날짜는 **플레이 날짜**다. 서버 함수가 그것으로만 거른다. 접수 시각은 Booked 열에 따로 보인다
 * (티 타임만 — 베이 예약에는 그 칸이 내려오지 않는다).
 */

import { Fragment, useEffect, useMemo, useState } from "react";

import { describeSimError, simApi, type SimReservation, type SimSource } from "@/lib/simulator/api";
import { ApiError } from "@/lib/teeSheet/api";
import { addDays, minutesToTime, timeToMinutes } from "@/lib/teeSheet/dates";
import { staffBookings } from "@/lib/teeSheet/staffRpc";
import type { BookingSource, TeeBooking } from "@/lib/teeSheet/types";
import { localBusinessDate } from "@/lib/retail/api";
import { datesBetween } from "@/lib/reports/accountingWorkbook";

import { Chip, EmptyNote, ErrorNote, Field, SkeletonRows, StatCard, TextInput } from "@/components/retail/ui";

const MAX_DAYS = 62;
const CONCURRENCY = 6;

type Channel = "web" | "phone";
type Area = "tee" | "bay";

type Row = {
  key: string;
  area: Area;
  channel: Channel;
  /** 사람이 읽는 채널 이름. 음성 에이전트가 받은 전화는 따로 적는다. */
  via: string;
  date: string;
  minutes: number;
  time: string;
  where: string;
  name: string;
  contact: string;
  players: number;
  status: string;
  cancelled: boolean;
  code: string;
  bookedAt: string | null;
};

const TEE_CHANNEL: Partial<Record<BookingSource, { channel: Channel; via: string }>> = {
  web: { channel: "web", via: "Website" },
  voice: { channel: "phone", via: "Phone · AI agent" },
};

const SIM_CHANNEL: Partial<Record<SimSource, { channel: Channel; via: string }>> = {
  online: { channel: "web", via: "Website" },
  phone: { channel: "phone", via: "Phone" },
  voice_ai: { channel: "phone", via: "Phone · AI agent" },
};

const STATUS_LABEL: Record<string, string> = {
  reserved: "Reserved",
  confirmed: "Confirmed",
  checked_in: "Checked in",
  paid: "Paid",
  cancelled: "Cancelled",
  no_show: "No-show",
};

function teeRow(booking: TeeBooking): Row | null {
  const channel = TEE_CHANNEL[booking.source];
  if (!channel || booking.status === "blocked") return null;
  const players = booking.players.filter((player) => !player.cancelled);
  const lead = booking.players[0];
  return {
    key: `tee-${booking.id}`,
    area: "tee",
    ...channel,
    date: booking.date,
    minutes: timeToMinutes(booking.time) || 0,
    time: booking.time,
    where: `Tee time · ${booking.holes} holes`,
    name: booking.title || lead?.name || "—",
    contact: [lead?.phone, lead?.email].filter(Boolean).join(" · "),
    players: players.length,
    status: STATUS_LABEL[booking.status] ?? booking.status,
    cancelled: booking.status === "cancelled",
    code: booking.confirmationCode ?? "",
    bookedAt: booking.createdAt || null,
  };
}

function simRow(reservation: SimReservation, bayNumbers: Map<number, number>): Row | null {
  const channel = SIM_CHANNEL[reservation.source];
  if (!channel) return null;
  const [hour, minute] = reservation.start_time.split(":").map(Number);
  const minutes = hour * 60 + (minute || 0);
  const bay = bayNumbers.get(reservation.bay_id) ?? reservation.bay_id;
  return {
    key: `bay-${reservation.id}`,
    area: "bay",
    ...channel,
    date: reservation.date,
    minutes,
    time: minutesToTime(minutes),
    where: `Indoor bay ${bay} · ${reservation.duration_hours}h`,
    name: reservation.customer_name || "—",
    contact: [reservation.phone, reservation.customer_email].filter(Boolean).join(" · "),
    players: reservation.player_count,
    status: STATUS_LABEL[reservation.status] ?? reservation.status,
    cancelled: reservation.status === "cancelled",
    code: reservation.confirmation_code,
    bookedAt: null,
  };
}

/** 베이 장부에는 기간 함수가 없다. 하루씩 읽되 한꺼번에 수십 개를 쏘지 않는다. */
async function loadSim(dates: string[]): Promise<{ rows: SimReservation[]; failed: number; error: string }> {
  const rows: SimReservation[] = [];
  let failed = 0;
  let error = "";
  let next = 0;
  async function worker() {
    while (next < dates.length) {
      const date = dates[next++];
      try {
        rows.push(...(await simApi.reservations(date)));
      } catch (cause) {
        failed += 1;
        error = describeSimError(cause);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, dates.length) }, worker));
  return { rows, failed, error };
}

function describe(cause: unknown): string {
  if (cause instanceof ApiError && cause.status === 0) return "Can't reach the server. Check the connection and try again.";
  return (cause as Error)?.message ?? "Something went wrong.";
}

function shortDate(iso: string): string {
  return new Date(`${iso}T12:00:00`).toLocaleDateString("en-CA", { weekday: "short", month: "short", day: "numeric" });
}

function bookedLabel(iso: string | null): string {
  if (!iso) return "—";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "—";
  return at.toLocaleString("en-CA", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

const CHANNELS = [
  { key: "all", label: "Website + Phone" },
  { key: "web", label: "Website" },
  { key: "phone", label: "Phone" },
] as const;

const AREAS = [
  { key: "all", label: "Tee times + Bays" },
  { key: "tee", label: "Tee times" },
  { key: "bay", label: "Indoor bays" },
] as const;

export default function BookingsReport() {
  const today = localBusinessDate();
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(() => addDays(today, 6));
  const [channel, setChannel] = useState<(typeof CHANNELS)[number]["key"]>("all");
  const [area, setArea] = useState<(typeof AREAS)[number]["key"]>("all");
  const [showCancelled, setShowCancelled] = useState(false);
  // 마지막으로 읽어 온 기간. 지금 기간과 다르면 읽는 중이다.
  const [loaded, setLoaded] = useState<{ range: string; rows: Row[]; errors: string[] } | null>(null);

  const dates = useMemo(() => datesBetween(from, to), [from, to]);
  const rangeError =
    dates.length === 0
      ? "From must be on or before To."
      : dates.length > MAX_DAYS
        ? `Pick ${MAX_DAYS} days or fewer.`
        : "";
  const range = `${from}..${to}`;
  const loading = loaded?.range !== range;
  const rows = useMemo(() => (loaded && !loading ? loaded.rows : []), [loaded, loading]);
  const errors = loaded && !loading ? loaded.errors : [];

  useEffect(() => {
    if (rangeError) return;
    let cancelled = false;

    // 한쪽 장부가 안 읽혀도 다른 쪽은 보여 준다. 무엇이 빠졌는지는 오류 줄로 알린다.
    Promise.allSettled([
      staffBookings(from, to),
      Promise.all([simApi.bays().catch(() => []), loadSim(dates)]),
    ]).then(([tee, sim]) => {
      if (cancelled) return;
      const next: Row[] = [];
      const problems: string[] = [];
      if (tee.status === "fulfilled") {
        for (const booking of tee.value) {
          const row = teeRow(booking);
          if (row) next.push(row);
        }
      } else {
        problems.push(`Tee times not loaded — ${describe(tee.reason)}`);
      }
      if (sim.status === "fulfilled") {
        const [bays, loaded] = sim.value;
        const bayNumbers = new Map(bays.map((bay) => [bay.id, bay.bay_number]));
        for (const reservation of loaded.rows) {
          const row = simRow(reservation, bayNumbers);
          if (row) next.push(row);
        }
        if (loaded.failed > 0) problems.push(`Indoor bays: ${loaded.failed} day(s) not loaded — ${loaded.error}`);
      } else {
        problems.push(`Indoor bays not loaded — ${describe(sim.reason)}`);
      }
      next.sort((a, b) => a.date.localeCompare(b.date) || a.minutes - b.minutes || a.where.localeCompare(b.where));
      setLoaded({ range, rows: next, errors: problems });
    });

    return () => {
      cancelled = true;
    };
  }, [from, to, range, dates, rangeError]);

  const live = useMemo(() => rows.filter((row) => !row.cancelled), [rows]);
  const count = (pick: (row: Row) => boolean) => {
    const matched = live.filter(pick);
    return { bookings: matched.length, players: matched.reduce((sum, row) => sum + row.players, 0) };
  };
  const webTee = count((row) => row.channel === "web" && row.area === "tee");
  const phoneTee = count((row) => row.channel === "phone" && row.area === "tee");
  const webBay = count((row) => row.channel === "web" && row.area === "bay");
  const phoneBay = count((row) => row.channel === "phone" && row.area === "bay");
  const cancelledCount = rows.length - live.length;

  const visible = rows.filter(
    (row) =>
      (channel === "all" || row.channel === channel) &&
      (area === "all" || row.area === area) &&
      (showCancelled || !row.cancelled),
  );

  return (
    <div className="grid min-w-0 gap-3">
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Play date from">
          <TextInput max={to} onChange={(event) => setFrom(event.target.value)} type="date" value={from} />
        </Field>
        <Field label="To">
          <TextInput min={from} onChange={(event) => setTo(event.target.value)} type="date" value={to} />
        </Field>
      </div>

      {rangeError ? <ErrorNote>{rangeError}</ErrorNote> : null}
      {errors.map((message) => (
        <ErrorNote key={message}>{message}</ErrorNote>
      ))}

      {loading && !rangeError ? (
        <SkeletonRows count={6} />
      ) : rangeError ? null : (
        <>
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
            <StatCard hint={`${webTee.players} player(s)`} label="Website · Tee times" strong value={String(webTee.bookings)} />
            <StatCard hint={`${phoneTee.players} player(s)`} label="Phone · Tee times" strong value={String(phoneTee.bookings)} />
            <StatCard hint={`${webBay.players} player(s)`} label="Website · Indoor bays" value={String(webBay.bookings)} />
            <StatCard hint={`${phoneBay.players} player(s)`} label="Phone · Indoor bays" value={String(phoneBay.bookings)} />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {CHANNELS.map((item) => (
              <Chip active={channel === item.key} key={item.key} onClick={() => setChannel(item.key)}>
                {item.label}
              </Chip>
            ))}
            <span className="mx-1 h-6 w-px bg-[#d4d4d8]" />
            {AREAS.map((item) => (
              <Chip active={area === item.key} key={item.key} onClick={() => setArea(item.key)}>
                {item.label}
              </Chip>
            ))}
            <label className="ml-auto flex min-h-11 items-center gap-2 text-sm">
              <input
                checked={showCancelled}
                onChange={(event) => setShowCancelled(event.target.checked)}
                type="checkbox"
              />
              Show cancelled ({cancelledCount})
            </label>
          </div>

          {visible.length === 0 ? (
            <EmptyNote>No website or phone bookings for these dates.</EmptyNote>
          ) : (
            <div className="min-w-0 overflow-x-auto border border-[#d4d4d8] bg-white">
              <table className="w-full min-w-[880px] text-left text-sm">
                <thead className="bg-[#f3f4f6] text-xs text-[#3f434a] uppercase">
                  <tr>
                    <th className="px-3 py-2">Time</th>
                    <th className="px-3 py-2">Booking</th>
                    <th className="px-3 py-2">Channel</th>
                    <th className="px-3 py-2">Customer</th>
                    <th className="px-3 py-2 text-right">Players</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2">Booked</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((row, index) => (
                    <Fragment key={row.key}>
                      {index === 0 || visible[index - 1].date !== row.date ? (
                        <tr className="bg-[#eef2ff]">
                          <td className="px-3 py-1.5 text-xs font-bold" colSpan={7}>
                            {shortDate(row.date)}
                          </td>
                        </tr>
                      ) : null}
                      <tr className={`border-t border-[#ececf0] ${row.cancelled ? "text-[#9ca3af] line-through" : ""}`}>
                        <td className="px-3 py-2 tabular-nums whitespace-nowrap">{row.time}</td>
                        <td className="px-3 py-2">
                          <span className="block">{row.where}</span>
                          {row.code ? <span className="block text-xs text-[#6b7280]">#{row.code}</span> : null}
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap">
                          <span
                            className={`inline-block px-1.5 py-0.5 text-xs font-bold ${
                              row.channel === "web" ? "bg-[#e0e7ff] text-[#3730a3]" : "bg-[#dcfce7] text-[#166534]"
                            }`}
                          >
                            {row.via}
                          </span>
                        </td>
                        <td className="px-3 py-2">
                          <span className="block">{row.name}</span>
                          {row.contact ? <span className="block text-xs text-[#6b7280]">{row.contact}</span> : null}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">{row.players}</td>
                        <td className="px-3 py-2 whitespace-nowrap">{row.status}</td>
                        <td className="px-3 py-2 text-xs whitespace-nowrap text-[#6b7280]">{bookedLabel(row.bookedAt)}</td>
                      </tr>
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="text-xs text-[#6b7280]">
            Dates are play dates. Tee times the pro shop entered by hand are not listed — they are saved as staff
            bookings, so a call the staff took cannot be told apart from a walk-in.
          </p>
        </>
      )}
    </div>
  );
}
