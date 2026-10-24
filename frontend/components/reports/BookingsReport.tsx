"use client";

/**
 * 실시간 예약 현황 — 들어온 경로별로. 티 타임·실내 베이를 한 목록에. Reports(`/admin/reports?view=bookings`)의 한 탭.
 *
 * 경로는 각 장부의 `source` 칸과 예약 내용으로 나눈다:
 *   - 티 시트(`pelham_tee_bookings`, 0002):
 *       web → Website, voice → Phone · AI agent, staff → Pro shop.
 *       GolfNow  = 선수 요금제에 "GolfNow" 가 있거나 예약 색이 blue(외부 채널 표시, `tone.ts`)이거나
 *                  Chronogolf 가져오기 기록의 Reservation Source 가 GolfNow(0066 과 같은 판정).
 *       Chronogolf = id 가 `chronogolf-` 인 가져온 예약(Reservation Source 를 작게 붙인다).
 *       voice_hold 는 AI 가 **지금 통화 중** 잡아 둔 자리다 — 예약 수에 넣지 않고 맨 위 띠에 보인다.
 *   - 베이(`pelham_sim_reservations`, 0007): online → Website, voice_ai → Phone · AI agent,
 *     phone → Phone · staff, walk_in → Walk-in.
 *   - 웹 예약에는 유입 경로(0067 `pelham_staff_booking_attribution`)를 붙인다: Google search, Google Ads, Direct …
 *     0067 을 실행하기 전이면 그 줄만 "source not recorded" 로 보이고 나머지는 그대로다.
 *
 * 실시간: 화면이 보이는 동안 POLL_MS 마다 다시 읽는다(탭이 숨으면 멈추고, 돌아오면 바로 읽는다).
 * 이 화면을 연 뒤 새로 생긴 예약에는 NEW 표시가 붙는다. 다시 읽는 동안 표를 비우지 않는다.
 *
 * 날짜 칸은 **플레이 날짜**다. "Booked today" 는 그 기간 안에서 오늘 접수된 것이다.
 *
 * 위 숫자 칸과 웹 유입 경로 줄은 먼저 요약(경로별·유입 경로별·플레이 날짜별), 줄을 누르면 그 예약들(2026-10-24, `ReportDrill`).
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { describeSimError, simApi, type SimReservation, type SimSource } from "@/lib/simulator/api";
import { ApiError } from "@/lib/teeSheet/api";
import { addDays, minutesToTime, timeToMinutes } from "@/lib/teeSheet/dates";
import { staffBookingAttribution, staffBookings, type BookingAttribution } from "@/lib/teeSheet/staffRpc";
import type { TeeBooking } from "@/lib/teeSheet/types";
import { localBusinessDate } from "@/lib/retail/api";
import { datesBetween } from "@/lib/reports/accountingWorkbook";

import ReportDrill, { type DrillGroup } from "@/components/reports/ReportDrill";
import { Button, Chip, EmptyNote, ErrorNote, Field, SkeletonRows, StatCard, TextInput } from "@/components/retail/ui";

const MAX_DAYS = 31;
const CONCURRENCY = 6;
const POLL_MS = 30_000;

type Channel = "web" | "phone_ai" | "phone_staff" | "pro_shop" | "golfnow" | "chronogolf" | "walk_in";
type Area = "tee" | "bay";

const CHANNEL: Record<Channel, { label: string; className: string }> = {
  web: { label: "Website", className: "bg-[#e0e7ff] text-[#3730a3]" },
  phone_ai: { label: "Phone · AI agent", className: "bg-[#dcfce7] text-[#166534]" },
  phone_staff: { label: "Phone · staff", className: "bg-[#ecfccb] text-[#3f6212]" },
  pro_shop: { label: "Pro shop", className: "bg-[#f3f4f6] text-[#374151]" },
  golfnow: { label: "GolfNow", className: "bg-[#0b2a7a] text-white" },
  chronogolf: { label: "Chronogolf import", className: "bg-[#e8f1ff] text-[#1d4ed8]" },
  walk_in: { label: "Walk-in", className: "bg-[#fef3c7] text-[#92400e]" },
};
const CHANNEL_ORDER: Channel[] = ["web", "phone_ai", "phone_staff", "pro_shop", "golfnow", "chronogolf", "walk_in"];

type Row = {
  key: string;
  area: Area;
  /** 0067 과 맞추는 열쇠: 티는 예약 id, 베이는 숫자 id. */
  ref: string;
  channel: Channel;
  /** 경로 옆에 작게: 가져오기의 Reservation Source, 웹 유입 경로 등. */
  detail: string;
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

type Hold = { key: string; date: string; time: string; players: number; expiresAt: string | null };

const STATUS_LABEL: Record<string, string> = {
  reserved: "Reserved",
  confirmed: "Confirmed",
  checked_in: "Checked in",
  paid: "Paid",
  cancelled: "Cancelled",
  no_show: "No-show",
};

const SIM_CHANNEL: Record<SimSource, Channel> = {
  online: "web",
  voice_ai: "phone_ai",
  phone: "phone_staff",
  walk_in: "walk_in",
};

function importSource(notes: string): string {
  return /"reservationSource":\s*"([^"]*)"/.exec(notes ?? "")?.[1] ?? "";
}

function teeChannel(booking: TeeBooking): { channel: Channel; detail: string } {
  const imported = importSource(booking.notes);
  const golfnowPlan = booking.players.some((player) => /golf ?now/i.test(player.ratePlan ?? ""));
  if (golfnowPlan || /golf ?now/i.test(imported)) return { channel: "golfnow", detail: imported && !/golf ?now/i.test(imported) ? imported : "" };
  if (booking.id.startsWith("chronogolf-")) return { channel: "chronogolf", detail: imported };
  if (booking.source === "web") return { channel: "web", detail: "" };
  if (booking.source === "voice") return { channel: "phone_ai", detail: "" };
  // 직원이 넣은 예약 중 색이 blue 인 것은 외부 온라인 채널(GolfNow)로 표시한 것(`tone.ts`).
  if (booking.color === "blue") return { channel: "golfnow", detail: "marked blue" };
  return { channel: "pro_shop", detail: "" };
}

function teeRow(booking: TeeBooking): Row | null {
  if (booking.status === "blocked" || booking.source === "voice_hold") return null;
  const players = booking.players.filter((player) => !player.cancelled);
  const lead = booking.players[0];
  return {
    key: `tee-${booking.id}`,
    area: "tee",
    ref: booking.id,
    ...teeChannel(booking),
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
    ref: String(reservation.id),
    channel,
    detail: "",
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
    bookedAt: reservation.created_at ?? null,
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

function clock(at: Date): string {
  return at.toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit", second: "2-digit" });
}

function bookedOn(iso: string | null): string {
  if (!iso) return "";
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? "" : localBusinessDate(at);
}

/** 웹 예약 한 줄에 붙는 유입 경로 문구. */
function webSource(found: BookingAttribution | undefined): { label: string; hint: string } {
  if (!found) return { label: "Source not recorded", hint: "" };
  const hint = [
    found.referrerHost ? `from ${found.referrerHost}` : "",
    found.landing ? `landed on ${found.landing}` : "",
    found.utmCampaign ? `campaign ${found.utmCampaign}` : "",
    found.utmTerm ? `term “${found.utmTerm}”` : "",
    found.device ?? "",
    found.firstLabel && found.firstLabel !== found.label ? `first visit: ${found.firstLabel}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return { label: found.label, hint };
}

const PRESETS = [
  { days: 1, label: "Today" },
  { days: 7, label: "7 days" },
  { days: 14, label: "14 days" },
  { days: 31, label: "31 days" },
] as const;

const AREAS = [
  { key: "all", label: "Tee times + Bays" },
  { key: "tee", label: "Tee times" },
  { key: "bay", label: "Indoor bays" },
] as const;

type Loaded = {
  range: string;
  rows: Row[];
  holds: Hold[];
  sources: Map<string, BookingAttribution>;
  sourcesMissing: boolean;
  errors: string[];
  at: Date;
};

export default function BookingsReport() {
  const today = localBusinessDate();
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(() => addDays(today, 6));
  const [channel, setChannel] = useState<Channel | "all">("all");
  const [area, setArea] = useState<(typeof AREAS)[number]["key"]>("all");
  // 숫자 칸을 눌러 연 요약 — 무엇으로 묶을지(경로·웹 유입 경로·플레이 날짜).
  const [drill, setDrill] = useState<{ title: string; rows: Row[]; by: "channel" | "web" | "date" } | null>(null);
  const [showCancelled, setShowCancelled] = useState(false);
  const [paused, setPaused] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // 이 기간을 처음 읽었을 때 있던 예약. 그 뒤에 나타난 예약이 NEW 다.
  const seen = useRef<{ range: string; keys: Set<string> } | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(() => new Set());

  const dates = useMemo(() => datesBetween(from, to), [from, to]);
  const rangeError =
    dates.length === 0 ? "From must be on or before To." : dates.length > MAX_DAYS ? `Pick ${MAX_DAYS} days or fewer.` : "";
  const range = `${from}..${to}`;
  const loading = loaded?.range !== range;

  const load = useCallback(async (): Promise<Loaded> => {
    // 한쪽 장부가 안 읽혀도 다른 쪽은 보여 준다. 무엇이 빠졌는지는 오류 줄로 알린다.
    const [tee, sim, sources] = await Promise.allSettled([
      staffBookings(from, to),
      Promise.all([simApi.bays().catch(() => []), loadSim(dates)]),
      staffBookingAttribution(from, to),
    ]);
    const rows: Row[] = [];
    const holds: Hold[] = [];
    const errors: string[] = [];
    if (tee.status === "fulfilled") {
      for (const booking of tee.value) {
        if (booking.source === "voice_hold" && booking.status !== "cancelled") {
          holds.push({
            key: booking.id,
            date: booking.date,
            time: booking.time,
            players: booking.players.filter((player) => !player.cancelled).length,
            expiresAt: booking.holdExpiresAt,
          });
          continue;
        }
        const row = teeRow(booking);
        if (row) rows.push(row);
      }
    } else {
      errors.push(`Tee times not loaded — ${describe(tee.reason)}`);
    }
    if (sim.status === "fulfilled") {
      const [bays, result] = sim.value;
      const bayNumbers = new Map(bays.map((bay) => [bay.id, bay.bay_number]));
      for (const reservation of result.rows) {
        const row = simRow(reservation, bayNumbers);
        if (row) rows.push(row);
      }
      if (result.failed > 0) errors.push(`Indoor bays: ${result.failed} day(s) not loaded — ${result.error}`);
    } else {
      errors.push(`Indoor bays not loaded — ${describe(sim.reason)}`);
    }
    const map = new Map<string, BookingAttribution>();
    if (sources.status === "fulfilled") {
      for (const item of sources.value) map.set(`${item.kind}-${item.bookingRef}`, item);
    }
    rows.sort((a, b) => a.date.localeCompare(b.date) || a.minutes - b.minutes || a.where.localeCompare(b.where));
    return {
      range: `${from}..${to}`,
      rows,
      holds,
      sources: map,
      sourcesMissing: sources.status === "rejected",
      errors,
      at: new Date(),
    };
  }, [from, to, dates]);

  const apply = useCallback((next: Loaded) => {
    const keys = new Set(next.rows.map((row) => row.key));
    if (seen.current?.range !== next.range) {
      seen.current = { range: next.range, keys };
      setFresh(new Set());
    } else {
      const known = seen.current.keys;
      const added = next.rows.filter((row) => !known.has(row.key)).map((row) => row.key);
      if (added.length > 0) {
        setFresh((current) => new Set([...current, ...added]));
        for (const key of added) known.add(key);
      }
    }
    setLoaded(next);
  }, []);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      apply(await load());
    } finally {
      setRefreshing(false);
    }
  }, [apply, load]);

  // 기간이 바뀌면 새로 읽는다.
  useEffect(() => {
    if (rangeError) return;
    let cancelled = false;
    load().then((next) => {
      if (!cancelled) apply(next);
    });
    return () => {
      cancelled = true;
    };
  }, [load, apply, rangeError]);

  // 실시간: 보이는 동안만 다시 읽는다. 탭으로 돌아오면 바로 한 번.
  useEffect(() => {
    if (rangeError || paused) return;
    const tick = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    const timer = window.setInterval(tick, POLL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [refresh, paused, rangeError]);

  // "n초 전" 과 홀드 남은 시간을 위해 화면만 다시 그린다.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 5_000);
    return () => window.clearInterval(timer);
  }, []);

  const current = loaded && !loading ? loaded : null;
  const rows = useMemo(() => current?.rows ?? [], [current]);
  const live = useMemo(() => rows.filter((row) => !row.cancelled), [rows]);
  const inArea = live.filter((row) => area === "all" || row.area === area);

  const byChannel = CHANNEL_ORDER.map((key) => {
    const matched = inArea.filter((row) => row.channel === key);
    return {
      key,
      bookings: matched.length,
      players: matched.reduce((sum, row) => sum + row.players, 0),
      tee: matched.filter((row) => row.area === "tee").length,
      bay: matched.filter((row) => row.area === "bay").length,
      today: matched.filter((row) => bookedOn(row.bookedAt) === today).length,
    };
  }).filter((line) => line.bookings > 0);

  const webSources = (() => {
    const counts = new Map<string, { bookings: number; players: number }>();
    for (const row of inArea) {
      if (row.channel !== "web") continue;
      const label = webSource(current?.sources.get(row.key)).label;
      const entry = counts.get(label) ?? { bookings: 0, players: 0 };
      entry.bookings += 1;
      entry.players += row.players;
      counts.set(label, entry);
    }
    return [...counts.entries()].sort((a, b) => b[1].bookings - a[1].bookings);
  })();

  const totalPlayers = inArea.reduce((sum, row) => sum + row.players, 0);
  const bookedToday = inArea.filter((row) => bookedOn(row.bookedAt) === today);
  const feed = [...bookedToday].sort((a, b) => (b.bookedAt ?? "").localeCompare(a.bookedAt ?? "")).slice(0, 8);
  const holds = (current?.holds ?? []).filter((hold) => !hold.expiresAt || new Date(hold.expiresAt).getTime() > now);
  const cancelledCount = rows.filter((row) => row.cancelled && (area === "all" || row.area === area)).length;

  const visible = rows.filter(
    (row) =>
      (channel === "all" || row.channel === channel) &&
      (area === "all" || row.area === area) &&
      (showCancelled || !row.cancelled),
  );

  const ago = current ? Math.max(0, Math.round((now - current.at.getTime()) / 1000)) : 0;

  return (
    <div className="grid min-w-0 gap-3">
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Play date from">
          <TextInput max={to} onChange={(event) => setFrom(event.target.value)} type="date" value={from} />
        </Field>
        <Field label="To">
          <TextInput min={from} onChange={(event) => setTo(event.target.value)} type="date" value={to} />
        </Field>
        {PRESETS.map((preset) => (
          <Chip
            active={from === today && to === addDays(today, preset.days - 1)}
            key={preset.days}
            onClick={() => {
              setFrom(today);
              setTo(addDays(today, preset.days - 1));
            }}
          >
            {preset.label}
          </Chip>
        ))}
        <span className="ml-auto flex items-center gap-2 text-sm">
          <span className={`inline-flex items-center gap-1.5 font-bold ${paused ? "text-[#6b7280]" : "text-[#166534]"}`}>
            <span
              aria-hidden
              className={`inline-block h-2.5 w-2.5 rounded-full ${paused ? "bg-[#9ca3af]" : "animate-pulse bg-[#16a34a]"}`}
            />
            {paused ? "Paused" : "Live"}
          </span>
          <span className="text-xs text-[#6b7280] tabular-nums">
            {current ? `Updated ${clock(current.at)}${ago >= 10 ? ` · ${ago}s ago` : ""}` : "Loading…"}
          </span>
          <Button disabled={refreshing || loading} onClick={() => void refresh()} tone="plain">
            {refreshing ? "Refreshing…" : "Refresh"}
          </Button>
          <Button onClick={() => setPaused((value) => !value)} tone="plain">
            {paused ? "Resume" : "Pause"}
          </Button>
        </span>
      </div>

      {rangeError ? <ErrorNote>{rangeError}</ErrorNote> : null}
      {current?.errors.map((message) => <ErrorNote key={message}>{message}</ErrorNote>)}

      {loading && !rangeError ? (
        <SkeletonRows count={6} />
      ) : rangeError || !current ? null : (
        <>
          {holds.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2 border border-[#86efac] bg-[#f0fdf4] px-3 py-2 text-sm">
              <span className="font-bold text-[#166534]">📞 AI agent on a call now</span>
              {holds.map((hold) => {
                const left = hold.expiresAt ? Math.max(0, Math.round((new Date(hold.expiresAt).getTime() - now) / 1000)) : null;
                return (
                  <span className="bg-white px-2 py-0.5 text-xs" key={hold.key}>
                    Holding {shortDate(hold.date)} {hold.time} · {hold.players} player(s)
                    {left !== null ? ` · ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")} left` : ""}
                  </span>
                );
              })}
            </div>
          ) : null}

          <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
            <StatCard
              hint={`${totalPlayers} player(s)`}
              label="Bookings"
              onClick={() => setDrill({ title: "Bookings", rows: inArea, by: "channel" })}
              strong
              value={String(inArea.length)}
            />
            <StatCard
              hint={`${bookedToday.reduce((sum, row) => sum + row.players, 0)} player(s)`}
              label="Booked today"
              onClick={() => setDrill({ title: "Booked today", rows: bookedToday, by: "channel" })}
              strong
              value={String(bookedToday.length)}
            />
            <StatCard
              hint={`${inArea.filter((row) => row.channel === "web").reduce((sum, row) => sum + row.players, 0)} player(s)`}
              label="Online (website)"
              onClick={() =>
                setDrill({ title: "Online (website)", rows: inArea.filter((row) => row.channel === "web"), by: "web" })
              }
              value={String(inArea.filter((row) => row.channel === "web").length)}
            />
            <StatCard
              hint={holds.length > 0 ? `${holds.length} call(s) holding a time now` : "No call in progress"}
              label="Phone (AI + staff)"
              onClick={() =>
                setDrill({
                  title: "Phone (AI + staff)",
                  rows: inArea.filter((row) => row.channel === "phone_ai" || row.channel === "phone_staff"),
                  by: "channel",
                })
              }
              value={String(inArea.filter((row) => row.channel === "phone_ai" || row.channel === "phone_staff").length)}
            />
          </div>

          <div className="grid min-w-0 gap-3 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
            <div className="min-w-0 overflow-x-auto border border-[#d4d4d8] bg-white">
              <table className="w-full min-w-[520px] text-left text-sm">
                <thead className="bg-[#f3f4f6] text-xs text-[#3f434a] uppercase">
                  <tr>
                    <th className="px-3 py-2">How it came in</th>
                    <th className="px-3 py-2 text-right">Bookings</th>
                    <th className="px-3 py-2 text-right">Players</th>
                    <th className="px-3 py-2 text-right">Tee</th>
                    <th className="px-3 py-2 text-right">Bays</th>
                    <th className="px-3 py-2 text-right">Booked today</th>
                  </tr>
                </thead>
                <tbody>
                  {byChannel.length === 0 ? (
                    <tr>
                      <td className="px-3 py-4 text-center text-[#6b7280]" colSpan={6}>
                        No bookings for these dates.
                      </td>
                    </tr>
                  ) : (
                    byChannel.map((line) => (
                      <tr
                        className={`cursor-pointer border-t border-[#ececf0] hover:bg-[#f9fafb] ${channel === line.key ? "bg-[#eef2ff]" : ""}`}
                        key={line.key}
                        onClick={() => setChannel(channel === line.key ? "all" : line.key)}
                      >
                        <td className="px-3 py-2">
                          <span className={`inline-block px-1.5 py-0.5 text-xs font-bold ${CHANNEL[line.key].className}`}>
                            {CHANNEL[line.key].label}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right font-bold tabular-nums">{line.bookings}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{line.players}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{line.tee}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{line.bay}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{line.today || "—"}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            <div className="min-w-0 border border-[#d4d4d8] bg-white">
              <p className="bg-[#f3f4f6] px-3 py-2 text-xs font-bold text-[#3f434a] uppercase">Website — where they came from</p>
              {current.sourcesMissing ? (
                <p className="px-3 py-3 text-xs text-[#92400e]">
                  Web sources are not on yet. Run supabase/migrations/0067_booking_attribution.sql in the Supabase SQL
                  editor.
                </p>
              ) : webSources.length === 0 ? (
                <p className="px-3 py-3 text-sm text-[#6b7280]">No website bookings for these dates.</p>
              ) : (
                <ul className="divide-y divide-[#ececf0] text-sm">
                  {webSources.map(([label, count]) => (
                    <li key={label}>
                      <button
                        className="flex w-full items-center justify-between px-3 py-2 text-left hover:bg-[#f9fafb] hover:text-[#4533ff]"
                        onClick={() =>
                          setDrill({
                            title: `Website — ${label}`,
                            rows: inArea.filter(
                              (row) => row.channel === "web" && webSource(current.sources.get(row.key)).label === label,
                            ),
                            by: "date",
                          })
                        }
                        type="button"
                      >
                        <span className={label === "Source not recorded" ? "text-[#9ca3af]" : ""}>{label}</span>
                        <span className="tabular-nums">
                          <b>{count.bookings}</b> <span className="text-xs text-[#6b7280]">· {count.players} pl.</span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          {feed.length > 0 ? (
            <div className="min-w-0 border border-[#d4d4d8] bg-white">
              <p className="bg-[#f3f4f6] px-3 py-2 text-xs font-bold text-[#3f434a] uppercase">Just in — booked today</p>
              <ul className="divide-y divide-[#ececf0] text-sm">
                {feed.map((row) => (
                  <li className="flex flex-wrap items-center gap-2 px-3 py-2" key={row.key}>
                    <span className="w-20 shrink-0 text-xs text-[#6b7280] tabular-nums">
                      {row.bookedAt ? new Date(row.bookedAt).toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit" }) : ""}
                    </span>
                    <span className={`px-1.5 py-0.5 text-xs font-bold ${CHANNEL[row.channel].className}`}>
                      {CHANNEL[row.channel].label}
                    </span>
                    {row.channel === "web" ? (
                      <span className="text-xs text-[#4b5563]">{webSource(current.sources.get(row.key)).label}</span>
                    ) : null}
                    <span className="min-w-0 truncate">
                      {row.name} · {row.players} pl. · {shortDate(row.date)} {row.time} · {row.where}
                    </span>
                    {fresh.has(row.key) ? <span className="bg-[#dc2626] px-1 text-[10px] font-bold text-white">NEW</span> : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            <Chip active={channel === "all"} onClick={() => setChannel("all")}>
              All channels
            </Chip>
            {CHANNEL_ORDER.filter((key) => rows.some((row) => row.channel === key)).map((key) => (
              <Chip active={channel === key} key={key} onClick={() => setChannel(key)}>
                {CHANNEL[key].label}
              </Chip>
            ))}
            <span className="mx-1 h-6 w-px bg-[#d4d4d8]" />
            {AREAS.map((item) => (
              <Chip active={area === item.key} key={item.key} onClick={() => setArea(item.key)}>
                {item.label}
              </Chip>
            ))}
            <label className="ml-auto flex min-h-11 items-center gap-2 text-sm">
              <input checked={showCancelled} onChange={(event) => setShowCancelled(event.target.checked)} type="checkbox" />
              Show cancelled ({cancelledCount})
            </label>
          </div>

          {visible.length === 0 ? (
            <EmptyNote>No bookings match these filters.</EmptyNote>
          ) : (
            <div className="min-w-0 overflow-x-auto border border-[#d4d4d8] bg-white">
              <table className="w-full min-w-[960px] text-left text-sm">
                <thead className="bg-[#f3f4f6] text-xs text-[#3f434a] uppercase">
                  <tr>
                    <th className="px-3 py-2">Time</th>
                    <th className="px-3 py-2">Booking</th>
                    <th className="px-3 py-2">Came in by</th>
                    <th className="px-3 py-2">Customer</th>
                    <th className="px-3 py-2 text-right">Players</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2">Booked</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((row, index) => {
                    const source = row.channel === "web" ? webSource(current.sources.get(row.key)) : null;
                    return (
                      <Fragment key={row.key}>
                        {index === 0 || visible[index - 1].date !== row.date ? (
                          <tr className="bg-[#eef2ff]">
                            <td className="px-3 py-1.5 text-xs font-bold" colSpan={7}>
                              {shortDate(row.date)}
                            </td>
                          </tr>
                        ) : null}
                        <tr
                          className={`border-t border-[#ececf0] ${row.cancelled ? "text-[#9ca3af] line-through" : ""} ${
                            fresh.has(row.key) ? "bg-[#fef9c3]" : ""
                          }`}
                        >
                          <td className="px-3 py-2 tabular-nums whitespace-nowrap">{row.time}</td>
                          <td className="px-3 py-2">
                            <span className="block">{row.where}</span>
                            {row.code ? <span className="block text-xs text-[#6b7280]">#{row.code}</span> : null}
                          </td>
                          <td className="px-3 py-2">
                            <span className={`inline-block px-1.5 py-0.5 text-xs font-bold whitespace-nowrap ${CHANNEL[row.channel].className}`}>
                              {CHANNEL[row.channel].label}
                            </span>
                            {fresh.has(row.key) ? (
                              <span className="ml-1 bg-[#dc2626] px-1 text-[10px] font-bold text-white">NEW</span>
                            ) : null}
                            {source ? (
                              <span className="block text-xs text-[#4b5563]" title={source.hint || undefined}>
                                {source.label}
                                {source.hint ? <span className="block text-[11px] text-[#9ca3af]">{source.hint}</span> : null}
                              </span>
                            ) : row.detail ? (
                              <span className="block text-xs text-[#6b7280]">{row.detail}</span>
                            ) : null}
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
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="text-xs text-[#6b7280]">
            Dates are play dates. Refreshes every {POLL_MS / 1000} seconds while this tab is open. Pro shop = tee times
            staff entered by hand (a call the staff took cannot be told apart from a walk-in on the tee sheet). Website
            sources are recorded from the visitor&apos;s entry page; Google search and a Google Maps link look the same
            unless the Maps link carries utm tags. Tap a number at the top or a website source for a summary, then the
            bookings.
          </p>
          {drill ? (
            <ReportDrill
              detailOf={(list) => `${list.reduce((sum, row) => sum + row.players, 0)} player(s)`}
              groupName={drill.by === "channel" ? "channels" : drill.by === "web" ? "sources" : "dates"}
              groupOf={(row): DrillGroup =>
                drill.by === "channel"
                  ? { key: row.channel, label: CHANNEL[row.channel].label }
                  : drill.by === "web"
                    ? (({ label }) => ({ key: label, label }))(webSource(current.sources.get(row.key)))
                    : { key: row.date, label: shortDate(row.date) }
              }
              itemOf={(row) => ({
                key: row.key,
                primary: `${shortDate(row.date)} ${row.time} · ${row.name}`,
                secondary: [CHANNEL[row.channel].label, row.where, row.status, row.code ? `#${row.code}` : "", row.contact]
                  .filter(Boolean)
                  .join(" · "),
                value: `${row.players} pl.`,
              })}
              key={drill.title}
              onClose={() => setDrill(null)}
              rows={drill.rows}
              title={drill.title}
              unit="booking"
            />
          ) : null}
        </>
      )}
    </div>
  );
}
