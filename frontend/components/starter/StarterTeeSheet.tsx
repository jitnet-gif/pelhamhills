"use client";

/**
 * 1번 티 스타터 폰의 티 시트(`/teesheet/mobile`). 회사 Android 폰의 Pelham Starter 앱이 이 화면을 띄운다.
 *
 * 하루를 세로 한 줄로: 지금 시각으로 자동 이동, 이름·전화 끝 4자리·확인 코드·QR 로 찾기, 줄을 누르면
 * 아래에서 예약 카드(선수별 체크인·카트·추가 품목), 탭 결제, 영수증(앱의 블루투스·와이파이 프린터, 승인 문자).
 *
 * 데이터와 규칙은 데스크톱 티 시트와 같다 — 예약은 `teeSheetApi`(Supabase), 돈은 계산서(`posApi`, 0005)와
 * 단말기 장부(0021)를 그대로 쓴다. 이 화면이 새로 정하는 금액은 없다: 계산서 SQL 이 합계를 매기고,
 * 결제는 승인된 단말기 기록(`terminal_txn`)으로만 계산서에 붙는다. 그래서 마감·Stripe check·승인 문자도 같다.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import CameraScanner, { type ScanOutcome } from "@/components/pos/CameraScanner";
import { describePosError, newCheckoutId, posApi, type Bill, type PaymentInput } from "@/lib/pos/api";
import { rememberedCashier } from "@/lib/pos/currentBill";
import { checkInByQr, checkinMessage, customerQrCode } from "@/lib/pos/customerQr";
import { describeTerminalResult, terminal, type TerminalRecord } from "@/lib/pos/terminal";
import { printReceipt } from "@/lib/retail/printReceipt";
import { formatMoney, type Cents, type Sale } from "@/lib/retail/types";
import { inStarterApp, starterPrinters, chooseStarterPrinter, type StarterPrinter } from "@/lib/starter/bridge";
import teeSheetApi, { ApiError } from "@/lib/teeSheet/api";
import { addDays, longDate, todayIso } from "@/lib/teeSheet/dates";
import { confirmationCode } from "@/lib/teeSheet/receipt";
import type { Player, TeeBooking, TeeExtraItem, TeeSlot } from "@/lib/teeSheet/types";

const SEATS = 4;
const POLL_MS = 15_000;
/** 티 시트 영수증 바코드: `ABCD-1234`, 뒤에 `-플레이어4자` 또는 `-ALL`(데스크톱 티 시트와 같다). */
const TEE_TICKET = /^([A-Z0-9]{4}-[A-Z0-9]{4})(?:-([A-Z0-9]{4}|ALL))?$/;

type Filter = "all" | "due" | "in" | "open";
type Row =
  | { kind: "booking"; booking: TeeBooking; minutes: number }
  | { kind: "open"; time: string; minutes: number; seats: number };

function errorText(error: unknown): string {
  if (error instanceof ApiError && error.status === 0) return "No connection. Check the phone's internet.";
  return describePosError(error);
}

function digits(value: string): string {
  return value.replace(/\D/g, "");
}

/** 직원이 오늘 그 사람 앞으로 받을 돈(세전 달러) — 화면 미리보기용. 진짜 합계는 계산서가 정한다. */
function playerDue(booking: TeeBooking, player: Player): number {
  const green = player.greenFee ?? booking.rate;
  const cart = player.cart ? player.cartFee : 0;
  const extras = (player.extras ?? []).reduce((sum, extra) => sum + extra.price, 0);
  return green + cart + extras;
}

const active = (booking: TeeBooking) => booking.players.filter((player) => !player.cancelled);
const unpaid = (booking: TeeBooking) => active(booking).filter((player) => !player.paid && !player.no_show);

function bookingTone(booking: TeeBooking): "paid" | "in" | "due" | "blocked" {
  if (booking.status === "blocked") return "blocked";
  if (unpaid(booking).length === 0 || booking.status === "paid") return "paid";
  if (booking.status === "checked_in" || active(booking).some((player) => player.arrived)) return "in";
  return "due";
}

const TONE_BORDER: Record<ReturnType<typeof bookingTone>, string> = {
  due: "border-l-[#2d5e8c]",
  in: "border-l-[#2f7d4f]",
  paid: "border-l-[#9aa59e] opacity-75",
  blocked: "border-l-[#6b7280] opacity-60",
};

function minutesNow(): number {
  const now = new Date();
  return now.getHours() * 60 + now.getMinutes();
}

function minutesOf(label: string): number {
  const match = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(label.trim());
  if (!match) return 0;
  const hour = Number(match[1]) % 12 + (match[3].toUpperCase() === "PM" ? 12 : 0);
  return hour * 60 + Number(match[2]);
}

function matches(booking: TeeBooking, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (/^\d{4}$/.test(q)) return booking.players.some((player) => digits(player.phone ?? "").endsWith(q));
  const code = q.toUpperCase();
  if (/^T[0-9A-F]{2,}$/.test(code) && (booking.confirmationCode ?? "").toUpperCase().startsWith(code)) return true;
  if (/^[A-Z0-9]{4}-?[A-Z0-9]{0,4}$/.test(code) && confirmationCode(booking.id).replace("-", "").startsWith(code.replace("-", "")))
    return true;
  if (booking.title.toLowerCase().includes(q)) return true;
  return booking.players.some((player) => player.name.toLowerCase().includes(q));
}

// ===== 본체 ==============================================================

export default function StarterTeeSheet() {
  const [date, setDateValue] = useState(todayIso);
  const [slots, setSlots] = useState<TeeSlot[]>([]);
  const [bookings, setBookings] = useState<TeeBooking[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [openId, setOpenId] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [amountOpen, setAmountOpen] = useState(false);
  const [printerOpen, setPrinterOpen] = useState(false);
  const [toast, setToast] = useState("");
  const [other, setOther] = useState<TeeBooking[] | null>(null);
  const [now, setNow] = useState(minutesNow);
  const scrolledFor = useRef("");
  const setDate = useCallback((next: string) => {
    setDateValue((current) => {
      if (current !== next) setLoading(true);
      return next;
    });
  }, []);
  const app = useMemo(() => (typeof window === "undefined" ? false : inStarterApp()), []);

  // 읽기는 then 안에서만 상태를 바꾼다. 날짜를 바꾸면 늦게 온 앞 날짜의 응답은 버린다.
  const load = useCallback(
    (quiet = false) =>
      Promise.all([teeSheetApi.getSlots(date).then((body) => body.slots), teeSheetApi.listBookings({ date })])
        .then(([slotList, list]) => {
          setSlots(slotList);
          setBookings(list);
          setError("");
        })
        .catch((cause: unknown) => {
          if (!quiet) setError(errorText(cause));
        })
        .finally(() => setLoading(false)),
    [date],
  );

  useEffect(() => {
    let alive = true;
    const guard = (quiet: boolean) => (alive ? load(quiet) : Promise.resolve());
    load().catch(() => undefined);
    const timer = window.setInterval(() => {
      setNow(minutesNow());
      if (document.visibilityState === "visible") void guard(true);
    }, POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [load]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 4000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const isToday = date === todayIso();

  const rows = useMemo<Row[]>(() => {
    const live = bookings.filter((booking) => booking.status !== "cancelled" && booking.date === date);
    const out: Row[] = live.map((booking) => ({
      kind: "booking",
      booking,
      minutes: slots.find((slot) => slot.time === booking.time)?.minutes ?? minutesOf(booking.time),
    }));
    for (const slot of slots) {
      const taken = live
        .filter((booking) => booking.time === slot.time)
        .reduce((sum, booking) => sum + Math.max(1, active(booking).length), 0);
      if (taken === 0) out.push({ kind: "open", time: slot.time, minutes: slot.minutes, seats: SEATS });
    }
    return out.sort((a, b) => a.minutes - b.minutes);
  }, [bookings, date, slots]);

  const shown = useMemo(
    () =>
      rows.filter((row) => {
        if (row.kind === "open") return !query.trim() && (filter === "all" || filter === "open");
        if (!matches(row.booking, query)) return false;
        const tone = bookingTone(row.booking);
        if (filter === "due") return tone === "due" || tone === "in";
        if (filter === "in") return tone === "in";
        if (filter === "open") return false;
        return true;
      }),
    [filter, query, rows],
  );

  // 오늘이면 처음 한 번 지금 시각 줄로 굴린다.
  useEffect(() => {
    if (!isToday || loading || scrolledFor.current === date) return;
    scrolledFor.current = date;
    window.requestAnimationFrame(() =>
      document.querySelector("[data-now-line]")?.scrollIntoView({ block: "center", behavior: "smooth" }),
    );
  }, [date, isToday, loading]);

  const next = useMemo(
    () =>
      rows.find(
        (row) => row.kind === "booking" && row.minutes >= now - 2 && bookingTone(row.booking) !== "paid",
      ) as Extract<Row, { kind: "booking" }> | undefined,
    [now, rows],
  );

  const opened = bookings.find((booking) => booking.id === openId) ?? other?.find((b) => b.id === openId) ?? null;

  const searchOtherDays = async () => {
    setOther([]);
    try {
      const list = await teeSheetApi.listBookings({ from: addDays(todayIso(), -7), to: addDays(todayIso(), 60) });
      setOther(list.filter((booking) => booking.status !== "cancelled" && booking.date !== date && matches(booking, query)));
    } catch (cause) {
      setOther(null);
      setToast(errorText(cause));
    }
  };

  const onScan = async (raw: string): Promise<ScanOutcome> => {
    const qr = customerQrCode(raw);
    if (qr) {
      try {
        const result = await checkInByQr(qr);
        if (result.bookingId) {
          if (result.date && result.date !== date) setDate(result.date);
          setOpenId(result.bookingId);
          setScanning(false);
          void load(true);
        }
        return { ok: result.status !== "none", message: checkinMessage(result) };
      } catch (cause) {
        return { ok: false, message: errorText(cause) };
      }
    }
    const ticket = TEE_TICKET.exec(raw.trim().toUpperCase());
    const found = ticket ? bookings.find((booking) => confirmationCode(booking.id) === ticket[1]) : undefined;
    if (found) {
      setOpenId(found.id);
      setScanning(false);
      return { ok: true, message: `${found.time} · ${found.title}` };
    }
    return { ok: false, message: ticket ? "That reservation is not on this day." : "Not a guest QR or tee sheet barcode." };
  };

  const nowAt = isToday ? shown.findIndex((row) => row.minutes >= now) : -1;
  return (
    <div className="pb-24">
      {/* 날짜 · 다음 티오프 */}
      <div className="sticky top-0 z-20 border-b border-[#dfe5df] bg-white">
        <div className="flex items-center gap-1 px-2 py-1.5">
          <button aria-label="Previous day" className="min-h-11 min-w-11 text-xl font-bold" onClick={() => setDate(addDays(date, -1))} type="button">
            ‹
          </button>
          <button className="min-h-11 flex-1 text-left text-base font-bold" onClick={() => setDate(todayIso())} type="button">
            {longDate(date)}
            {isToday ? null : <span className="ml-2 text-xs font-bold text-[#4533ff]">Today ›</span>}
          </button>
          <button aria-label="Next day" className="min-h-11 min-w-11 text-xl font-bold" onClick={() => setDate(addDays(date, 1))} type="button">
            ›
          </button>
        </div>
        {isToday && next ? (
          <p className="px-3 pb-1.5 text-sm font-bold text-[#1e5a3f]">
            Next tee-off {next.booking.time} · {next.booking.title}
          </p>
        ) : null}
        {/* 찾기 */}
        <div className="flex gap-2 px-2 pb-2">
          <label className="flex min-h-12 flex-1 items-center gap-2 rounded-xl border border-[#cfd8cf] bg-white px-3 focus-within:border-[#4533ff]">
            <span aria-hidden>🔍</span>
            <input
              autoCapitalize="none"
              autoComplete="off"
              className="w-full bg-transparent text-base outline-none"
              enterKeyHint="search"
              onChange={(event) => {
                setQuery(event.target.value);
                setOther(null);
              }}
              placeholder="Name · last 4 of phone · code"
              type="search"
              value={query}
            />
          </label>
          <button
            className="min-h-12 rounded-xl border-2 border-[#1e5a3f] px-3 text-sm font-bold text-[#1e5a3f]"
            onClick={() => setScanning(true)}
            type="button"
          >
            QR
          </button>
        </div>
        <div className="flex gap-1.5 overflow-x-auto px-2 pb-2">
          {(
            [
              ["all", "All"],
              ["due", "Due"],
              ["in", "Checked in"],
              ["open", "Open"],
            ] as const
          ).map(([key, label]) => (
            <button
              aria-pressed={filter === key}
              className={`min-h-9 shrink-0 rounded-full border px-3 text-sm font-bold ${
                filter === key ? "border-[#1e5a3f] bg-[#1e5a3f] text-white" : "border-[#cfd8cf] bg-white text-[#3f4a44]"
              }`}
              key={key}
              onClick={() => setFilter(key)}
              type="button"
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {error ? <p className="m-3 rounded-lg bg-[#fdf0f0] p-3 text-sm text-[#8a1f1f]">{error}</p> : null}
      {loading && rows.length === 0 ? <p className="p-6 text-center text-sm text-[#6b7280]">Loading…</p> : null}

      <ol className="grid gap-2 p-2">
        {shown.map((row, index) => {
          const line = index === nowAt ? <NowLine key="now" now={now} /> : null;
          if (row.kind === "open") {
            return [
              line,
              <li
                className="flex min-h-14 items-center gap-3 rounded-xl border border-dashed border-[#cfd8cf] bg-[#f8faf7] px-3 text-[#6b7280]"
                key={`open-${row.time}`}
              >
                <span className="w-16 text-base font-bold tabular-nums">{row.time.replace(/\s?[AP]M$/i, "")}</span>
                <span className="flex-1 text-sm">Open · {row.seats} seats</span>
              </li>,
            ];
          }
          const booking = row.booking;
          const tone = bookingTone(booking);
          const people = active(booking);
          const due = unpaid(booking).reduce((sum, player) => sum + playerDue(booking, player), 0);
          return [
            line,
            <li key={booking.id}>
              <button
                className={`flex min-h-16 w-full items-center gap-3 rounded-xl border border-l-[6px] border-[#dfe5df] bg-white px-3 py-2 text-left active:bg-[#eef1ee] ${TONE_BORDER[tone]}`}
                onClick={() => setOpenId(booking.id)}
                type="button"
              >
                <span className="w-16 shrink-0">
                  <span className="block text-lg leading-tight font-bold tabular-nums">{booking.time.replace(/\s?[AP]M$/i, "")}</span>
                  <span className="text-[11px] text-[#6b7280]">{booking.holes} holes</span>
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-base font-bold" data-no-translate>
                    {booking.title || people[0]?.name || "—"}
                  </span>
                  <span className="text-xs tracking-wider text-[#1e5a3f]" aria-label={`${people.length} players`}>
                    {"●".repeat(Math.min(people.length, SEATS))}
                    {"○".repeat(Math.max(SEATS - people.length, 0))}
                  </span>
                </span>
                <Badge due={due} tone={tone} />
              </button>
            </li>,
          ];
        })}
        {isToday && nowAt === -1 && shown.length > 0 ? <NowLine now={now} /> : null}
      </ol>

      {!loading && shown.length === 0 ? (
        <div className="grid gap-3 p-6 text-center text-sm text-[#6b7280]">
          <p>{query ? "No booking matches on this day." : "Nothing to show."}</p>
          {query ? (
            <button className="mx-auto min-h-11 rounded-xl border border-[#1e5a3f] px-4 font-bold text-[#1e5a3f]" onClick={searchOtherDays} type="button">
              Search other days
            </button>
          ) : null}
        </div>
      ) : null}
      {other && other.length > 0 ? (
        <ol className="grid gap-2 p-2">
          {other.map((booking) => (
            <li key={booking.id}>
              <button
                className="flex min-h-14 w-full items-center gap-3 rounded-xl border border-[#dfe5df] bg-white px-3 text-left"
                onClick={() => {
                  setDate(booking.date);
                  setOther(null);
                  setOpenId(booking.id);
                }}
                type="button"
              >
                <span className="w-24 text-sm font-bold">{longDate(booking.date)}</span>
                <span className="w-16 font-bold tabular-nums">{booking.time}</span>
                <span className="flex-1 truncate font-bold" data-no-translate>
                  {booking.title}
                </span>
              </button>
            </li>
          ))}
        </ol>
      ) : null}

      {/* 아래 고정 줄: 금액 직접 받기 · 프린터 */}
      <div className="pb-safe fixed inset-x-0 bottom-0 z-20 flex gap-2 border-t border-[#dfe5df] bg-white p-2">
        <button
          className="min-h-12 flex-1 rounded-xl bg-[#4533ff] text-base font-bold text-white disabled:opacity-40"
          disabled={!app}
          onClick={() => setAmountOpen(true)}
          type="button"
        >
          Charge an amount
        </button>
        <button
          className="min-h-12 rounded-xl border border-[#cfd8cf] px-4 text-base font-bold disabled:opacity-40"
          disabled={!app}
          onClick={() => setPrinterOpen(true)}
          type="button"
        >
          🖨
        </button>
      </div>
      {!app ? (
        <p className="px-4 pb-20 text-center text-xs text-[#6b7280]">
          Tap to pay and printing work in the Pelham Starter app on the club phone.
        </p>
      ) : null}

      {toast ? (
        <p className="fixed inset-x-3 bottom-20 z-50 rounded-xl bg-[#111315] p-3 text-center text-sm text-white" role="status">
          {toast}
        </p>
      ) : null}

      {opened ? (
        <BookingSheet
          app={app}
          booking={opened}
          onChanged={(updated) => setBookings((list) => list.map((item) => (item.id === updated.id ? updated : item)))}
          onClose={() => setOpenId(null)}
          onPaid={(message) => {
            setToast(message);
            void load(true);
          }}
        />
      ) : null}
      {amountOpen ? (
        <AmountSheet
          onClose={() => setAmountOpen(false)}
          onPaid={(message) => {
            setToast(message);
            setAmountOpen(false);
          }}
        />
      ) : null}
      {printerOpen ? <PrinterSheet onClose={() => setPrinterOpen(false)} /> : null}
      {scanning ? (
        <div className="fixed inset-0 z-50">
          <CameraScanner
            canPay={false}
            doneLabel="Close"
            onClose={() => setScanning(false)}
            onCode={onScan}
            onDone={() => setScanning(false)}
            summary={<span>Guest QR or tee sheet barcode</span>}
          />
        </div>
      ) : null}
    </div>
  );
}

function NowLine({ now }: { now: number }) {
  const hour = Math.floor(now / 60);
  const label = `${((hour + 11) % 12) + 1}:${String(now % 60).padStart(2, "0")}`;
  return (
    <li aria-label="Now" className="flex items-center gap-2 text-xs font-bold text-[#d4572a]" data-now-line>
      <span>Now {label}</span>
      <span className="h-0.5 flex-1 rounded bg-[#d4572a]" />
    </li>
  );
}

function Badge({ tone, due }: { tone: ReturnType<typeof bookingTone>; due: number }) {
  if (tone === "blocked") return <span className="rounded-full bg-[#eef1ee] px-2 py-1 text-xs font-bold text-[#6b7280]">Blocked</span>;
  if (tone === "paid") return <span className="rounded-full bg-[#e0f1e6] px-2 py-1 text-xs font-bold text-[#2f7d4f]">Paid</span>;
  return (
    <span className="grid justify-items-end gap-0.5">
      {tone === "in" ? <span className="rounded-full bg-[#e2ecf5] px-2 py-0.5 text-[11px] font-bold text-[#2d5e8c]">Checked in</span> : null}
      <span className="rounded-full bg-[#fbe5db] px-2 py-1 text-xs font-bold whitespace-nowrap text-[#b4451c]">
        ${due.toFixed(2)} due
      </span>
    </span>
  );
}

// ===== 아래에서 올라오는 판 ==================================================

function Sheet({ title, sub, onClose, children }: { title: string; sub?: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-40 flex flex-col justify-end">
      <button aria-label="Close" className="absolute inset-0 bg-[rgba(10,20,15,.4)]" onClick={onClose} type="button" />
      <div className="pb-safe relative max-h-[92dvh] overflow-y-auto rounded-t-2xl bg-white p-3 shadow-[0_-6px_20px_rgba(0,0,0,.18)]">
        <div className="mx-auto mb-2 h-1 w-10 rounded bg-[#cfd8cf]" />
        <div className="mb-2 flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-lg font-bold" data-no-translate>
              {title}
            </h2>
            {sub ? <p className="text-xs text-[#6b7280]">{sub}</p> : null}
          </div>
          <button className="min-h-11 min-w-11 text-xl" onClick={onClose} type="button" aria-label="Close">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

let extrasCache: Promise<TeeExtraItem[]> | null = null;

function BookingSheet({
  booking,
  app,
  onClose,
  onChanged,
  onPaid,
}: {
  booking: TeeBooking;
  app: boolean;
  onClose: () => void;
  onChanged: (booking: TeeBooking) => void;
  onPaid: (message: string) => void;
}) {
  const people = active(booking);
  const [ticked, setTicked] = useState<Set<string>>(() => new Set(unpaid(booking).map((player) => player.id)));
  const [expanded, setExpanded] = useState<string | null>(null);
  const [extras, setExtras] = useState<TeeExtraItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [paying, setPaying] = useState(false);

  useEffect(() => {
    extrasCache ??= teeSheetApi.listExtras().catch(() => {
      extrasCache = null;
      return [];
    });
    void extrasCache.then(setExtras);
  }, []);

  const run = async (task: () => Promise<TeeBooking>) => {
    setBusy(true);
    setError("");
    try {
      onChanged(await task());
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  const chosen = people.filter((player) => ticked.has(player.id));
  const chosenUnpaid = chosen.filter((player) => !player.paid);
  const preview = chosenUnpaid.reduce((sum, player) => sum + playerDue(booking, player), 0);
  const phone = people.find((player) => digits(player.phone ?? "").length >= 10)?.phone ?? "";

  const checkIn = () =>
    run(async () => {
      let latest = booking;
      for (const player of chosen.filter((item) => !item.arrived)) {
        latest = await teeSheetApi.patchPlayer(booking.id, player.id, { arrived: true, no_show: false });
      }
      const everyone = active(latest).every((player) => player.arrived || player.paid);
      if (everyone && latest.status === "reserved") latest = await teeSheetApi.patchBooking(booking.id, { status: "checked_in" });
      return latest;
    });

  if (paying) {
    return (
      <PayFlow
        onClose={() => setPaying(false)}
        onPaid={onPaid}
        phone={phone}
        prepare={async () => {
          const cashier = rememberedCashier();
          const bill = await posApi.open({
            station: "tee_sheet",
            label: `${booking.time} ${booking.title}`.slice(0, 60),
            ...(cashier ? { cashier } : {}),
          });
          try {
            return await posApi.addTee(bill.id, booking.id, chosenUnpaid.map((player) => player.id));
          } catch (cause) {
            await posApi.void(bill.id).catch(() => undefined);
            throw cause;
          }
        }}
        title={`${booking.time} · ${booking.title}`}
      />
    );
  }

  return (
    <Sheet
      onClose={onClose}
      sub={`${longDate(booking.date)} · ${booking.holes} holes${booking.cartCount ? ` · ${booking.cartCount} cart(s)` : ""}`}
      title={`${booking.time} · ${booking.title}`}
    >
      <ul className="grid">
        {people.map((player) => {
          const on = ticked.has(player.id);
          const codes = new Set((player.extras ?? []).map((extra) => extra.code));
          return (
            <li className="border-b border-[#eef1ee] py-1" key={player.id}>
              <div className="flex min-h-12 items-center gap-3">
                <button
                  aria-label={on ? "Untick" : "Tick"}
                  aria-pressed={on}
                  className={`grid h-7 w-7 shrink-0 place-items-center rounded-md border-2 text-sm text-white ${
                    on ? "border-[#1e5a3f] bg-[#1e5a3f]" : "border-[#9aa59e]"
                  }`}
                  onClick={() =>
                    setTicked((set) => {
                      const nextSet = new Set(set);
                      if (nextSet.has(player.id)) nextSet.delete(player.id);
                      else nextSet.add(player.id);
                      return nextSet;
                    })
                  }
                  type="button"
                >
                  {on ? "✓" : ""}
                </button>
                <button className="min-w-0 flex-1 text-left" onClick={() => setExpanded(expanded === player.id ? null : player.id)} type="button">
                  <span className="block truncate text-base font-bold" data-no-translate>
                    {player.name || "Guest"}
                  </span>
                  <span className="text-xs text-[#6b7280]">
                    {player.ratePlan || player.type}
                    {player.cart ? " · cart" : ""}
                    {player.arrived ? " · checked in" : ""}
                    {(player.extras ?? []).map((extra) => ` · ${extra.name}`).join("")}
                  </span>
                </button>
                {player.paid ? (
                  <span className="rounded-full bg-[#e0f1e6] px-2 py-1 text-xs font-bold text-[#2f7d4f]">Paid</span>
                ) : (
                  <span className="text-base font-bold tabular-nums">${playerDue(booking, player).toFixed(2)}</span>
                )}
              </div>
              {expanded === player.id && !player.paid ? (
                <div className="flex flex-wrap gap-2 pb-2 pl-10">
                  <Chip
                    on={player.cart}
                    disabled={busy}
                    onClick={() => run(() => teeSheetApi.patchPlayer(booking.id, player.id, { cart: !player.cart }))}
                  >
                    🛺 Cart
                  </Chip>
                  {extras.map((extra) => (
                    <Chip
                      disabled={busy}
                      key={extra.code}
                      on={codes.has(extra.code)}
                      onClick={() => {
                        const nextCodes = new Set(codes);
                        if (nextCodes.has(extra.code)) nextCodes.delete(extra.code);
                        else nextCodes.add(extra.code);
                        return run(() => teeSheetApi.setPlayerExtras(booking.id, player.id, [...nextCodes]));
                      }}
                    >
                      {extra.name} ${extra.price.toFixed(2)}
                    </Chip>
                  ))}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      <p className="mt-2 text-xs text-[#6b7280]">Tap a name for cart and add-ons. Amounts are before tax.</p>
      {error ? <p className="mt-2 rounded-lg bg-[#fdf0f0] p-2 text-sm text-[#8a1f1f]">{error}</p> : null}
      <div className="mt-3 grid grid-cols-[1fr_1.5fr] gap-2">
        <button
          className="min-h-14 rounded-xl border-2 border-[#1e5a3f] text-base font-bold text-[#1e5a3f] disabled:opacity-40"
          disabled={busy || chosen.length === 0 || chosen.every((player) => player.arrived)}
          onClick={checkIn}
          type="button"
        >
          Check in
        </button>
        <button
          className="min-h-14 rounded-xl bg-[#4533ff] text-base font-bold text-white disabled:opacity-40"
          disabled={busy || !app || chosenUnpaid.length === 0}
          onClick={() => setPaying(true)}
          type="button"
        >
          Tap to pay ${preview.toFixed(2)} + tax
        </button>
      </div>
    </Sheet>
  );
}

function Chip({
  on,
  disabled,
  onClick,
  children,
}: {
  on: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      aria-pressed={on}
      className={`min-h-10 rounded-lg border px-3 text-sm font-bold disabled:opacity-50 ${
        on ? "border-[#1e5a3f] bg-[#e1ede5] text-[#1e5a3f]" : "border-[#cfd8cf] bg-white"
      }`}
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
}

// ===== 금액 직접 받기 ======================================================

function AmountSheet({ onClose, onPaid }: { onClose: () => void; onPaid: (message: string) => void }) {
  const [cents, setCents] = useState(0);
  const [note, setNote] = useState("");
  const [paying, setPaying] = useState(false);
  const press = (key: string) =>
    setCents((value) => {
      if (key === "⌫") return Math.floor(value / 10);
      const nextValue = Number(`${value}${key}`);
      return nextValue > 999_999 ? value : nextValue;
    });

  if (paying) {
    return (
      <PayFlow
        onClose={onClose}
        onPaid={onPaid}
        phone=""
        prepare={async () => {
          const cashier = rememberedCashier();
          const bill = await posApi.open({ station: "tee_sheet", label: note.trim().slice(0, 60), ...(cashier ? { cashier } : {}) });
          try {
            return await posApi.addOpenItem(bill.id, { name: note.trim(), price: cents, quantity: 1, category: "Other" });
          } catch (cause) {
            await posApi.void(bill.id).catch(() => undefined);
            throw cause;
          }
        }}
        title={note.trim()}
      />
    );
  }

  return (
    <Sheet onClose={onClose} sub="Before tax. The bill adds HST." title="Charge an amount">
      <p className="py-2 text-center text-4xl font-bold tabular-nums">{formatMoney(cents)}</p>
      <input
        className="mb-2 min-h-12 w-full rounded-xl border border-[#cfd8cf] px-3 text-base"
        maxLength={60}
        onChange={(event) => setNote(event.target.value)}
        placeholder="What is it for? (required)"
        value={note}
      />
      <div className="grid grid-cols-3 gap-2">
        {["1", "2", "3", "4", "5", "6", "7", "8", "9", "00", "0", "⌫"].map((key) => (
          <button className="min-h-14 rounded-xl bg-[#eef1ee] text-2xl font-bold" key={key} onClick={() => press(key)} type="button">
            {key}
          </button>
        ))}
      </div>
      <button
        className="mt-3 min-h-14 w-full rounded-xl bg-[#4533ff] text-lg font-bold text-white disabled:opacity-40"
        disabled={cents <= 0 || !note.trim()}
        onClick={() => setPaying(true)}
        type="button"
      >
        Next
      </button>
    </Sheet>
  );
}

// ===== 결제 ================================================================

type PayStep =
  | { step: "preparing" }
  | { step: "review"; bill: Bill }
  | { step: "paying"; bill: Bill; status: string; record?: TerminalRecord }
  | { step: "recording"; bill: Bill; record: TerminalRecord; checkoutId: string; error?: string }
  | { step: "done"; bill: Bill; record: TerminalRecord }
  | { step: "failed"; message: string; bill?: Bill };

/**
 * 계산서를 만들고(prepare) → 합계 확인·문자 번호 → 탭 결제 → 승인된 기록으로 계산서 결제 → 영수증.
 * 결제 전에 닫으면 계산서를 지운다(void) — 열린 계산서가 계산대 목록에 남지 않게.
 */
function PayFlow({
  title,
  phone,
  prepare,
  onClose,
  onPaid,
}: {
  title: string;
  phone: string;
  prepare: () => Promise<Bill>;
  onClose: () => void;
  onPaid: (message: string) => void;
}) {
  const [state, setState] = useState<PayStep>({ step: "preparing" });
  const [receiptPhone, setReceiptPhone] = useState(phone);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    prepare().then(
      (bill) => setState({ step: "review", bill }),
      (cause: unknown) => setState({ step: "failed", message: errorText(cause) }),
    );
  }, [prepare]);

  const abandon = async () => {
    if ((state.step === "review" || state.step === "failed") && state.bill && state.bill.status === "open") {
      await posApi.void(state.bill.id).catch(() => undefined);
    }
    onClose();
  };

  const record = async (bill: Bill, rec: TerminalRecord, checkoutId: string) => {
    setState({ step: "recording", bill, record: rec, checkoutId });
    const payment: PaymentInput = {
      method: rec.card_type === "debit" ? "debit" : "card",
      amount: rec.requested_amount,
      ...(rec.tip > 0 ? { tip: rec.tip } : {}),
      ...(rec.auth_code ? { auth_code: rec.auth_code } : {}),
      ...(rec.card_last4 ? { card_last4: rec.card_last4 } : {}),
      terminal_txn: rec.id,
    };
    try {
      const paid = await posApi.pay(bill.id, checkoutId, [payment]);
      setState({ step: "done", bill: paid, record: rec });
      onPaid(`${formatMoney(paid.total)} paid${rec.card_last4 ? ` · ••••${rec.card_last4}` : ""}`);
    } catch (cause) {
      // 카드는 승인됐다. 같은 checkoutId 로 다시 부르면 서버가 한 번만 받는다.
      setState({ step: "recording", bill, record: rec, checkoutId, error: errorText(cause) });
    }
  };

  const pay = async (bill: Bill) => {
    setState({ step: "paying", bill, status: "Starting the payment…" });
    try {
      const fresh = await posApi.get(bill.id);
      const rec = await terminal.phoneSale(fresh.id, fresh.total, {
        receiptPhone,
        onStatus: (status) => setState((current) => (current.step === "paying" ? { ...current, status } : current)),
        onStarted: (started) => setState((current) => (current.step === "paying" ? { ...current, record: started } : current)),
      });
      if (!rec.approved) {
        setState({ step: "failed", bill: fresh, message: describeTerminalResult(rec) });
        return;
      }
      await record(fresh, rec, newCheckoutId());
    } catch (cause) {
      setState({ step: "failed", bill, message: cause instanceof Error && cause.message ? cause.message : errorText(cause) });
    }
  };

  const bill = "bill" in state ? state.bill : undefined;

  return (
    <div className="pt-safe pb-safe fixed inset-0 z-50 flex flex-col bg-[#111315] text-white">
      <div className="flex items-center gap-2 p-3">
        <p className="min-w-0 flex-1 truncate text-sm text-white/70" data-no-translate>
          {title}
        </p>
        {state.step === "review" || state.step === "failed" || state.step === "done" ? (
          <button className="min-h-11 px-3 text-sm font-bold" onClick={state.step === "done" ? onClose : abandon} type="button">
            {state.step === "done" ? "Done" : "Cancel"}
          </button>
        ) : null}
      </div>

      <div className="grid flex-1 content-center justify-items-center gap-4 overflow-y-auto p-5 text-center">
        {state.step === "preparing" ? <p className="text-lg">Preparing the bill…</p> : null}

        {state.step === "review" && bill ? (
          <>
            <ul className="grid w-full max-w-sm gap-1 text-left text-sm text-white/85">
              {bill.lines.map((line) => (
                <li className="flex justify-between gap-3" key={line.id}>
                  <span className="truncate" data-no-translate>
                    {line.name}
                  </span>
                  <span className="tabular-nums">{formatMoney(line.line_total)}</span>
                </li>
              ))}
              {bill.discount ? (
                <li className="flex justify-between">
                  <span>Discount</span>
                  <span className="tabular-nums">−{formatMoney(bill.discount)}</span>
                </li>
              ) : null}
              <li className="flex justify-between">
                <span>HST</span>
                <span className="tabular-nums">{formatMoney(bill.tax)}</span>
              </li>
            </ul>
            <p className="text-5xl font-bold tabular-nums">{formatMoney(bill.total)}</p>
            <label className="grid w-full max-w-sm gap-1 text-left text-sm">
              <span className="text-white/70">Text the receipt to (optional)</span>
              <input
                className="min-h-12 rounded-xl border border-white/30 bg-white/10 px-3 text-base text-white"
                inputMode="tel"
                onChange={(event) => setReceiptPhone(event.target.value)}
                placeholder="10-digit phone"
                value={receiptPhone}
              />
            </label>
            <button
              className="min-h-16 w-full max-w-sm rounded-2xl bg-[#4533ff] text-xl font-bold disabled:opacity-40"
              disabled={bill.total <= 0}
              onClick={() => void pay(bill)}
              type="button"
            >
              Tap to pay {formatMoney(bill.total)}
            </button>
          </>
        ) : null}

        {state.step === "paying" ? (
          <>
            <p className="text-5xl font-bold tabular-nums">{formatMoney(state.bill.total)}</p>
            <div className="relative grid h-32 w-32 place-items-center rounded-full border-2 border-[#7f8bff]">
              <span className="absolute inset-[-14px] animate-ping rounded-full border-2 border-[#7f8bff]/50" />
              <span className="text-4xl">📶</span>
            </div>
            <p className="text-lg font-bold">{state.status}</p>
            <p className="text-xs text-white/60">Visa · Mastercard · Amex · Interac · Apple Pay · Google Pay</p>
          </>
        ) : null}

        {state.step === "recording" ? (
          <>
            <p className="text-lg font-bold">Card approved — saving to the bill…</p>
            {state.error ? (
              <>
                <p className="rounded-lg bg-[#3a2219] p-3 text-sm">{state.error}</p>
                <button
                  className="min-h-14 w-full max-w-sm rounded-xl bg-white text-base font-bold text-[#111315]"
                  onClick={() => void record(state.bill, state.record, state.checkoutId)}
                  type="button"
                >
                  Try saving again
                </button>
                <p className="text-xs text-white/60">The card is not charged again. If this keeps failing, reopen bill #{state.bill.id} at the pro shop — the approval comes back there.</p>
              </>
            ) : null}
          </>
        ) : null}

        {state.step === "done" ? (
          <>
            <div className="grid h-24 w-24 place-items-center rounded-full bg-[#1f6b3a] text-5xl">✓</div>
            <p className="text-2xl font-bold">Approved</p>
            <p className="text-4xl font-bold tabular-nums">{formatMoney(state.bill.total)}</p>
            <p className="text-sm text-white/70">
              {state.record.card_brand ?? "Card"} ••••{state.record.card_last4 ?? "----"} · {state.bill.receipt_no}
            </p>
            {digits(receiptPhone).length >= 10 ? (
              <p className="text-sm text-[#7fd1a0]">Receipt text goes to ••• {digits(receiptPhone).slice(-4)}</p>
            ) : null}
            <div className="grid w-full max-w-sm grid-cols-2 gap-2">
              <button
                className="min-h-14 rounded-xl bg-white text-base font-bold text-[#111315]"
                onClick={() => printReceipt(state.bill as unknown as Sale)}
                type="button"
              >
                🖨 Print
              </button>
              <button className="min-h-14 rounded-xl border border-white/40 text-base font-bold" onClick={onClose} type="button">
                Done
              </button>
            </div>
          </>
        ) : null}

        {state.step === "failed" ? (
          <>
            <p className="text-2xl font-bold">Not paid</p>
            <p className="rounded-lg bg-[#3a2219] p-3 text-sm">{state.message}</p>
            {state.bill && state.bill.status === "open" ? (
              <button
                className="min-h-14 w-full max-w-sm rounded-xl bg-[#4533ff] text-base font-bold"
                onClick={() => setState({ step: "review", bill: state.bill as Bill })}
                type="button"
              >
                Try again
              </button>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}

// ===== 프린터 ==============================================================

function PrinterSheet({ onClose }: { onClose: () => void }) {
  const [current, setCurrent] = useState<StarterPrinter | null>(null);
  const [paired, setPaired] = useState<StarterPrinter[]>([]);
  const [host, setHost] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    starterPrinters().then(
      (body) => {
        setCurrent(body.current);
        setPaired(body.paired);
        if (body.current?.kind === "network") setHost(body.current.address);
      },
      (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)),
    );
  }, []);

  const choose = async (printer: StarterPrinter) => {
    setError("");
    try {
      await chooseStarterPrinter(printer);
      setCurrent(printer);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const test = () =>
    printReceipt({
      id: 0,
      receipt_no: "TEST",
      business_date: todayIso(),
      lines: [],
      subtotal: 0 as Cents,
      discount: 0,
      tax: 0,
      total: 0,
      payment_method: null,
      cashier: null,
      note: "Printer test",
      refunded_at: null,
      refund_reason: null,
      created_at: new Date().toISOString(),
    });

  return (
    <Sheet onClose={onClose} sub="Bluetooth printers must be paired in Android settings first." title="Receipt printer">
      <p className="mb-2 text-sm">
        Now: <b data-no-translate>{current ? `${current.name} (${current.kind === "network" ? current.address : "Bluetooth"})` : "none"}</b>
      </p>
      <ul className="grid gap-2">
        {paired.map((printer) => (
          <li key={printer.address}>
            <button
              className={`flex min-h-14 w-full items-center gap-3 rounded-xl border px-3 text-left ${
                current?.address === printer.address ? "border-[#1e5a3f] bg-[#e1ede5]" : "border-[#dfe5df]"
              }`}
              onClick={() => void choose(printer)}
              type="button"
            >
              <span aria-hidden>🖨</span>
              <span className="flex-1 font-bold" data-no-translate>
                {printer.name}
              </span>
              <span className="text-xs text-[#6b7280]">Bluetooth</span>
            </button>
          </li>
        ))}
      </ul>
      <div className="mt-3 flex gap-2">
        <input
          className="min-h-12 flex-1 rounded-xl border border-[#cfd8cf] px-3 text-base"
          inputMode="decimal"
          onChange={(event) => setHost(event.target.value)}
          placeholder="Wi-Fi printer IP, e.g. 192.168.0.50"
          value={host}
        />
        <button
          className="min-h-12 rounded-xl border border-[#1e5a3f] px-3 font-bold text-[#1e5a3f] disabled:opacity-40"
          disabled={!/^\d{1,3}(\.\d{1,3}){3}$/.test(host.trim())}
          onClick={() => void choose({ kind: "network", name: "TM-m30III", address: host.trim() })}
          type="button"
        >
          Use
        </button>
      </div>
      {error ? <p className="mt-2 rounded-lg bg-[#fdf0f0] p-2 text-sm text-[#8a1f1f]">{error}</p> : null}
      <button className="mt-3 min-h-12 w-full rounded-xl bg-[#1e5a3f] font-bold text-white disabled:opacity-40" disabled={!current} onClick={test} type="button">
        Print a test receipt
      </button>
    </Sheet>
  );
}
