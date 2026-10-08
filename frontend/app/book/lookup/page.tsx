"use client";

/**
 * 확인 코드 + 이메일로 예약을 찾고, **직접 바꾸거나 취소한다**(실내 골프·티타임).
 *
 * ## 왜 페이지가 얇은 래퍼인가
 * `useSearchParams()` 를 쓰는 컴포넌트는 반드시 `<Suspense>` 안에 있어야 한다.
 * 없으면 `next build` 가 "useSearchParams() should be wrapped in a suspense
 * boundary" 로 **빌드 자체를 실패**시킨다(정적 export 라 더 그렇다). 그래서 실제
 * 내용은 `LookupPanel` 로 빼고 이 페이지는 경계만 친다.
 *
 * ## 서버가 정한다
 * 찾기·수정·취소는 전부 Supabase 함수다(`supabase/migrations/0012_guest_manage_booking.sql`).
 * - 본인 확인은 코드 + 예약 때 쓴 이메일. 틀리면 어느 쪽이 틀렸는지 말하지 않는다.
 * - 코드 모양으로 갈린다: 16진수 10자 = 실내 골프, `T` + 9자 = 티타임, UUID = 0012 이전 티타임 번호.
 * - 바꿀 수 있는지(`editable`)와 못 바꾸는 이유(`reason`)는 서버가 돌려준다. 원래 시작 24시간
 *   전이 마감인데, 손님 기기 시계가 아니라 서버(클럽 현지) 시계로 판정해야 하기 때문이다.
 * - 시간 목록의 "꽉 참" 표시는 안내일 뿐이다. 마지막 판정은 저장할 때 서버가 한다.
 *
 * ## 온라인 결제(0020)
 * - `PayOnline` 이 결제 칸을 그린다(낼 수 있으면 Pay now, 냈으면 영수증 한 줄).
 * - 온라인으로 낸 예약은 0012 기준으로 "결제됨" 이라 수정·일반 취소가 닫힌다. 대신 마감 전이면
 *   **취소 + 자동 환불**(FastAPI `/payments/online/cancel`)을 연다. 수정은 프로 샵에서 한다.
 */

// `useSearchParams` 는 아래 `LookupPanel` 에서만 쓴다 — 반드시 Suspense 경계 안쪽이다.
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState, type ReactNode } from "react";

import BookingShell from "@/components/booking/BookingShell";
import PayOnline from "@/components/booking/PayOnline";
import { formatLongDate, todayIso } from "@/components/booking/availability";
import { NO_API_MESSAGE } from "@/lib/apiHost";
import { cancelAndRefund, money, type PaymentQuote } from "@/lib/booking/payments";
import { bookingConfigured, bookingRpc } from "@/lib/booking/rpc";
import { ApiError } from "@/lib/teeSheet/api";
import { CLUB } from "@/lib/nav";

export default function LookupPage() {
  return (
    <BookingShell
      subtitle="Find, change or cancel your booking with your confirmation code and email."
      title="My Booking"
    >
      <Suspense fallback={<PanelSkeleton />}>
        <LookupPanel />
      </Suspense>
    </BookingShell>
  );
}

function PanelSkeleton() {
  return (
    <div aria-busy="true" className="space-y-3">
      <div className="h-28 animate-pulse rounded-sm border border-[#e2ddd0] bg-[#efece3]" />
      <div className="h-40 animate-pulse rounded-sm border border-[#e2ddd0] bg-[#efece3]" />
    </div>
  );
}

type SimBooking = {
  confirmation_code: string;
  bay_number: number | null;
  bay_type: string;
  hourly_rate: number;
  date: string;
  /** "HH:MM" 24시간 */
  start_time: string;
  duration_hours: number;
  player_count: number;
  customer_name: string;
  customer_email: string;
  phone: string;
  total_price: number | null;
  status: string;
};

type TeeGuestBooking = {
  confirmation_code: string;
  date: string;
  /** 티 시트 라벨, 예: "8:01 AM" */
  time: string;
  holes: 9 | 18;
  players: number;
  rate: number;
  cart_count: number;
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  status: string;
};

type Meta = {
  editable: boolean;
  reason: string | null;
  /** 클럽 현지 "YYYY-MM-DDTHH:MM" — 이 시각까지 온라인으로 바꿀 수 있다. */
  change_deadline: string;
};

type Found = (Meta & { kind: "sim"; booking: SimBooking }) | (Meta & { kind: "tee"; booking: TeeGuestBooking });

type Credentials = { code: string; email: string };

/** 실내 골프 16진수 10자, 티타임 `T` + 9자, 0012 이전 티타임 UUID. */
const CODE_SHAPE =
  /^([0-9a-f]{10}|T[0-9a-f]{9}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** 서버 주소는 문구에 넣지 않는다. 방문자에게 우리 호스트를 알려 줄 이유가 없다. */
function networkMessage(err: unknown, action: string): string {
  if ((err instanceof ApiError && err.status === 0) || err instanceof TypeError) {
    return `Could not reach the booking server. ${action} Please try again in a moment, or call ${CLUB.phone}.`;
  }
  return err instanceof Error && err.message ? err.message : action;
}

/** "18:00" → "6:00 PM" */
function fmt12(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

function toMin(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function fromMin(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

function formatDeadline(local: string): string {
  const [date, time] = local.split("T");
  return `${formatLongDate(date)}, ${fmt12(time)}`;
}

const inputClass = "w-full rounded-sm border border-[#d8d1c3] bg-white px-3 py-2 text-base";
const labelClass = "mb-1 block text-sm font-semibold text-[#3d453d]";

function LookupPanel() {
  const params = useSearchParams();

  const [code, setCode] = useState(params.get("code") ?? "");
  const [email, setEmail] = useState("");
  /** 온라인 조회를 열 수 있는가. `null` 은 "아직 모름"(마운트 전). */
  const [bookingReady, setBookingReady] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [found, setFound] = useState<Found | null>(null);
  /** 찾을 때 쓴 코드·이메일. 수정·취소는 이것으로 다시 본인 확인을 한다. */
  const [creds, setCreds] = useState<Credentials | null>(null);
  const [mode, setMode] = useState<"view" | "edit" | "cancel">("view");
  const [done, setDone] = useState("");
  /** 온라인 결제 견적·상태. 결제 서버가 꺼져 있거나 닿지 않으면 null. */
  const [payQuote, setPayQuote] = useState<PaymentQuote | null>(null);

  useEffect(() => {
    setBookingReady(bookingConfigured());
  }, []);

  async function lookup() {
    const wanted = { code: code.trim(), email: email.trim() };
    if (!wanted.code || !wanted.email) return;
    setFound(null);
    setPayQuote(null);
    setError("");
    setDone("");
    setMode("view");
    if (!bookingReady) {
      setError(NO_API_MESSAGE);
      return;
    }
    setLoading(true);
    try {
      const result = await bookingRpc<Found | null>("pelham_booking_find", {
        p_code: wanted.code,
        p_email: wanted.email,
      });
      if (!result) {
        setError(
          "We could not find a booking with that confirmation code and email. Use the email you booked with, or call the pro shop.",
        );
        return;
      }
      setFound(result);
      setCreds(wanted);
    } catch (err) {
      setError(networkMessage(err, "Your booking could not be loaded."));
    } finally {
      setLoading(false);
    }
  }

  function applied(next: Found, message: string) {
    setFound(next);
    setMode("view");
    setDone(message);
  }

  /** 환불·취소 뒤 예약 카드를 서버 값으로 다시 그린다. */
  async function reload(message: string) {
    if (!creds) return;
    try {
      const next = await bookingRpc<Found | null>("pelham_booking_find", {
        p_code: creds.code,
        p_email: creds.email,
      });
      if (next) applied(next, message);
      else setDone(message);
    } catch {
      setDone(message);
    }
  }

  const offline = bookingReady === false;
  const trimmed = code.trim();
  const paidOnline =
    payQuote?.enabled === true && payQuote.payment?.status === "approved" ? payQuote : null;

  return (
    <div className="min-w-0">
      <form
        className="rounded-sm border border-[#d8d1c3] bg-white p-5"
        onSubmit={(event) => {
          event.preventDefault();
          void lookup();
        }}
      >
        <label className={labelClass} htmlFor="lookup-code">
          Confirmation code
        </label>
        <input
          autoCapitalize="characters"
          autoCorrect="off"
          className="w-full rounded-sm border border-[#d8d1c3] px-4 py-3 text-base uppercase tracking-widest"
          id="lookup-code"
          onChange={(event) => setCode(event.target.value)}
          placeholder="A1B2C3D4E5"
          spellCheck={false}
          type="text"
          value={code}
        />
        <p className="mt-2 text-xs text-[#5c6459]">
          Shown on screen when you booked. Indoor golf codes are 10 letters and numbers; tee time
          codes start with T.
        </p>

        <label className={`${labelClass} mt-4`} htmlFor="lookup-email">
          Email used for the booking
        </label>
        <input
          autoComplete="email"
          className="w-full rounded-sm border border-[#d8d1c3] px-4 py-3 text-base"
          id="lookup-email"
          inputMode="email"
          onChange={(event) => setEmail(event.target.value)}
          placeholder="you@example.com"
          type="email"
          value={email}
        />

        <button
          className={`tap-target mt-4 w-full rounded-sm py-3 text-base font-bold text-white transition ${
            trimmed && email.trim() && !loading
              ? "bg-[#214d2f] hover:bg-[#163820]"
              : "cursor-not-allowed bg-[#a9b0a6]"
          }`}
          disabled={!trimmed || !email.trim() || loading}
          type="submit"
        >
          {loading ? "Looking…" : "Find my booking"}
        </button>

        {trimmed && !CODE_SHAPE.test(trimmed) ? (
          <p className="mt-3 text-sm text-[#8a6f30]">
            That does not look like a confirmation code — check the code shown when you booked.
          </p>
        ) : null}
      </form>

      {offline ? (
        <Notice tone="warn" title="Booking lookup is offline">
          <p>{NO_API_MESSAGE}</p>
        </Notice>
      ) : null}

      {loading ? <PanelSkeleton /> : null}

      {error ? (
        <Notice tone="error" title="We could not open that booking">
          <p>{error}</p>
        </Notice>
      ) : null}

      {done ? (
        <div
          className="mt-5 rounded-sm border border-[#b9d3b9] bg-[#e4efe4] p-4 text-sm font-semibold text-[#214d2f]"
          role="status"
        >
          {done}
        </div>
      ) : null}

      {found && creds ? (
        <>
          {found.kind === "sim" ? (
            <SimCard booking={found.booking} />
          ) : (
            <TeeCard booking={found.booking} />
          )}

          {/* key: 취소·환불 뒤(done 이 바뀌면) 결제 상태를 다시 묻는다. */}
          <PayOnline creds={creds} key={`${creds.code}|${done}`} onQuote={setPayQuote} />

          {paidOnline ? (
            <PaidOnlineActions
              creds={creds}
              deadline={found.change_deadline}
              kind={found.kind}
              mode={mode}
              onMode={(next) => {
                setDone("");
                setMode(next);
              }}
              onRefunded={(message) => void reload(message)}
              quote={paidOnline}
            />
          ) : found.editable ? (
            mode === "edit" ? (
              found.kind === "sim" ? (
                <SimEditForm
                  booking={found.booking}
                  creds={creds}
                  onCancel={() => setMode("view")}
                  onSaved={(next) => applied(next, "Your booking has been updated.")}
                />
              ) : (
                <TeeEditForm
                  booking={found.booking}
                  creds={creds}
                  onCancel={() => setMode("view")}
                  onSaved={(next) => applied(next, "Your tee time has been updated.")}
                />
              )
            ) : mode === "cancel" ? (
              <CancelConfirm
                creds={creds}
                kind={found.kind}
                onBack={() => setMode("view")}
                onCancelled={(next) => applied(next, "Your booking has been cancelled.")}
              />
            ) : (
              <div className="mt-3 rounded-sm border border-[#d8d1c3] bg-white p-4">
                <p className="text-sm text-[#5c6459]">
                  You can change or cancel online until{" "}
                  <span className="font-semibold text-[#182118]">
                    {formatDeadline(found.change_deadline)}
                  </span>{" "}
                  (24 hours before the start).
                </p>
                <div className="mt-3 grid grid-cols-[minmax(0,1fr)] gap-2 sm:grid-cols-2">
                  <button
                    className="tap-target rounded-sm bg-[#214d2f] px-5 text-base font-bold text-white transition hover:bg-[#163820]"
                    onClick={() => {
                      setDone("");
                      setMode("edit");
                    }}
                    type="button"
                  >
                    Change booking
                  </button>
                  <button
                    className="tap-target rounded-sm border border-[#e0b3b3] bg-white px-5 text-base font-bold text-[#8a2f2f] transition hover:bg-[#fbeeee]"
                    onClick={() => {
                      setDone("");
                      setMode("cancel");
                    }}
                    type="button"
                  >
                    Cancel booking
                  </button>
                </div>
              </div>
            )
          ) : found.reason && found.booking.status !== "cancelled" ? (
            <Notice tone="warn" title="This booking can't be changed online">
              <p>{found.reason} Please call the pro shop and they will help.</p>
            </Notice>
          ) : null}
        </>
      ) : null}

      <div className="mt-5 rounded-sm border border-[#d8d1c3] bg-white p-4 text-sm text-[#5c6459]">
        <p className="font-semibold text-[#182118]">Need help?</p>
        <p className="mt-1">
          Online changes and cancellations close 24 hours before your start time. After that, or if
          your booking was paid at the club, call{" "}
          <a className="font-semibold text-[#214d2f] underline" href={CLUB.phoneHref}>
            {CLUB.phone}
          </a>{" "}
          or email{" "}
          <a className="font-semibold text-[#214d2f] underline" href={CLUB.emailHref}>
            {CLUB.email}
          </a>
          .
        </p>
      </div>
    </div>
  );
}

function Notice({
  children,
  title,
  tone,
}: {
  children: ReactNode;
  title: string;
  tone: "warn" | "error";
}) {
  const skin =
    tone === "error"
      ? "border-[#e0b3b3] bg-[#fbeeee] text-[#8a2f2f]"
      : "border-[#d6c28f] bg-[#f3ead2] text-[#5c4a1c]";
  return (
    <div className={`mt-5 rounded-sm border p-5 ${skin}`}>
      <p className="font-semibold">{title}</p>
      <div className="mt-1 text-sm">{children}</div>
      <a
        className="tap-target mt-4 flex items-center justify-center rounded-sm bg-[#214d2f] px-5 text-sm font-bold text-white transition hover:bg-[#163820]"
        href={CLUB.phoneHref}
      >
        Call {CLUB.phone}
      </a>
    </div>
  );
}

function StatusBadge({ status, live }: { status: string; live: boolean }) {
  return (
    <span
      className={`rounded-sm px-2 py-1 text-xs font-bold uppercase ${
        live ? "bg-[#e4efe4] text-[#214d2f]" : "bg-[#efece3] text-[#8a2f2f]"
      }`}
    >
      {status.replace("_", " ")}
    </span>
  );
}

function CardShell({
  children,
  code,
  kicker,
  status,
  live,
}: {
  children: ReactNode;
  code: string;
  kicker: string;
  status: string;
  live: boolean;
}) {
  return (
    <div className="mt-5 rounded-sm border border-[#d8d1c3] bg-white p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-xs font-bold uppercase tracking-[0.14em] text-[#8a6f30]">{kicker}</p>
        <StatusBadge live={live} status={status} />
      </div>
      {children}
      <div className="mt-3 min-w-0">
        <p className="text-sm font-semibold text-[#8a6f30]">Confirmation code</p>
        <p className="break-all font-mono font-bold tracking-widest text-[#214d2f]">{code}</p>
      </div>
    </div>
  );
}

function SimCard({ booking }: { booking: SimBooking }) {
  return (
    <CardShell
      code={booking.confirmation_code}
      kicker="Indoor Golf"
      live={booking.status === "confirmed" || booking.status === "checked_in" || booking.status === "paid"}
      status={booking.status}
    >
      <p className="mt-2 text-sm text-[#5c6459]">{formatLongDate(booking.date)}</p>
      <p className="mt-1 text-3xl font-bold">{fmt12(booking.start_time)}</p>
      <p className="mt-1 text-sm text-[#3d453d]">
        {booking.duration_hours} hour{booking.duration_hours > 1 ? "s" : ""} ·{" "}
        {booking.player_count} player{booking.player_count > 1 ? "s" : ""}
        {booking.bay_number ? ` · Bay ${booking.bay_number}` : ""}
      </p>
      <dl className="mt-4 grid grid-cols-2 gap-3 border-t border-[#d8d1c3] pt-4 text-sm">
        <div className="min-w-0">
          <dt className="font-semibold text-[#8a6f30]">Name</dt>
          <dd className="break-words">{booking.customer_name}</dd>
        </div>
        <div className="min-w-0">
          <dt className="font-semibold text-[#8a6f30]">Phone</dt>
          <dd className="break-words">{booking.phone || "—"}</dd>
        </div>
        <div className="min-w-0">
          <dt className="font-semibold text-[#8a6f30]">Total</dt>
          <dd className="font-bold text-[#214d2f]">
            {booking.total_price === null ? "—" : `$${Number(booking.total_price).toFixed(2)}`}
          </dd>
        </div>
      </dl>
    </CardShell>
  );
}

function TeeCard({ booking }: { booking: TeeGuestBooking }) {
  const name = `${booking.first_name} ${booking.last_name}`.trim();
  return (
    <CardShell
      code={booking.confirmation_code}
      kicker="Tee Time"
      live={booking.status !== "cancelled" && booking.status !== "no_show"}
      status={booking.status}
    >
      <p className="mt-2 text-sm text-[#5c6459]">{formatLongDate(booking.date)}</p>
      <p className="mt-1 text-3xl font-bold">{booking.time}</p>
      <p className="mt-1 text-sm text-[#3d453d]">
        {booking.players} player{booking.players === 1 ? "" : "s"} · {booking.holes} holes
      </p>
      <dl className="mt-4 grid grid-cols-2 gap-3 border-t border-[#d8d1c3] pt-4 text-sm">
        <div className="min-w-0">
          <dt className="font-semibold text-[#8a6f30]">Name</dt>
          <dd className="break-words">{name || "—"}</dd>
        </div>
        <div className="min-w-0">
          <dt className="font-semibold text-[#8a6f30]">Phone</dt>
          <dd className="break-words">{booking.phone || "—"}</dd>
        </div>
        <div className="min-w-0">
          <dt className="font-semibold text-[#8a6f30]">Green fees</dt>
          <dd className="font-bold text-[#214d2f]">
            ${Number(booking.rate).toFixed(2)} × {booking.players} = $
            {(Number(booking.rate) * booking.players).toFixed(2)}
          </dd>
        </div>
      </dl>
    </CardShell>
  );
}

function FormShell({
  children,
  error,
  onCancel,
  saving,
  title,
}: {
  children: ReactNode;
  error: string;
  onCancel: () => void;
  saving: boolean;
  title: string;
}) {
  return (
    <div className="mt-3 rounded-sm border border-[#214d2f] bg-white p-5">
      <p className="font-serif text-lg font-semibold text-[#214d2f]">{title}</p>
      <div className="mt-4 grid grid-cols-[minmax(0,1fr)] gap-4 sm:grid-cols-2">{children}</div>
      {error ? (
        <p className="mt-4 rounded-sm bg-[#fbeeee] p-3 text-sm text-[#8a2f2f]" role="alert">
          {error}
        </p>
      ) : null}
      <div className="mt-4 grid grid-cols-[minmax(0,1fr)] gap-2 sm:grid-cols-2">
        <button
          className={`tap-target rounded-sm px-5 text-base font-bold text-white transition ${
            saving ? "cursor-not-allowed bg-[#a9b0a6]" : "bg-[#214d2f] hover:bg-[#163820]"
          }`}
          disabled={saving}
          type="submit"
        >
          {saving ? "Saving…" : "Save changes"}
        </button>
        <button
          className="tap-target rounded-sm border border-[#d8d1c3] bg-white px-5 text-base font-bold text-[#214d2f] transition hover:bg-[#f7f4ed]"
          onClick={onCancel}
          type="button"
        >
          Keep as is
        </button>
      </div>
    </div>
  );
}

function SimEditForm({
  booking,
  creds,
  onCancel,
  onSaved,
}: {
  booking: SimBooking;
  creds: Credentials;
  onCancel: () => void;
  onSaved: (next: Found) => void;
}) {
  const [date, setDate] = useState(booking.date);
  const [start, setStart] = useState(booking.start_time);
  const [duration, setDuration] = useState(booking.duration_hours);
  const [players, setPlayers] = useState(booking.player_count);
  const [name, setName] = useState(booking.customer_name);
  const [phone, setPhone] = useState(booking.phone);
  /** 서버가 비어 있다고 한 시작 시각들. `null` 은 아직 모름. */
  const [open, setOpen] = useState<Set<string> | null>(null);
  const [closedReason, setClosedReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setOpen(null);
    setClosedReason("");
    bookingRpc<{ is_closed: boolean; reason?: string | null; available_slots: { time: string }[] }>(
      "pelham_sim_availability",
      { p_date: date, p_bay_type: "left_right", p_duration_hours: duration },
    )
      .then((res) => {
        if (cancelled) return;
        setOpen(new Set(res.available_slots.map((s) => s.time)));
        setClosedReason(res.is_closed ? res.reason ?? "Closed on this date." : "");
      })
      .catch(() => {
        // 안내가 없어도 저장할 때 서버가 다시 본다. 목록은 전부 고를 수 있게 둔다(null).
      });
    return () => {
      cancelled = true;
    };
  }, [date, duration]);

  // 가용 목록은 이 손님 자신의 예약도 "찬 자리" 로 센다. 같은 날 원래 시간과 겹치는 시각은
  // 자기 자리라 비울 수 있으니 막지 않는다.
  const ownStart = toMin(booking.start_time);
  const ownEnd = ownStart + booking.duration_hours * 60;
  const startOptions: { value: string; full: boolean }[] = [];
  for (let m = 14 * 60; m + duration * 60 <= 22 * 60; m += 15) {
    const value = fromMin(m);
    const overlapsOwn = date === booking.date && m < ownEnd && m + duration * 60 > ownStart;
    const full = open !== null && !open.has(value) && !overlapsOwn;
    startOptions.push({ value, full });
  }
  const startStillValid = startOptions.some((o) => o.value === start);

  async function save() {
    setError("");
    if (!name.trim()) {
      setError("Please enter a name.");
      return;
    }
    if (!startStillValid) {
      setError("Please pick a start time.");
      return;
    }
    setSaving(true);
    try {
      const next = await bookingRpc<Found>("pelham_sim_guest_update", {
        p_code: creds.code,
        p_email: creds.email,
        p: {
          date,
          start_time: start,
          duration_hours: duration,
          player_count: players,
          customer_name: name.trim(),
          phone: phone.trim(),
        },
      });
      onSaved(next);
    } catch (err) {
      setError(networkMessage(err, "Your changes could not be saved."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <FormShell error={error} onCancel={onCancel} saving={saving} title="Change your bay booking">
        <div className="min-w-0">
          <label className={labelClass} htmlFor="sim-date">
            Date
          </label>
          <input
            className={inputClass}
            id="sim-date"
            min={todayIso()}
            onChange={(e) => e.target.value && setDate(e.target.value)}
            type="date"
            value={date}
          />
          {closedReason ? <p className="mt-1 text-xs text-[#8a2f2f]">{closedReason}</p> : null}
        </div>
        <div className="min-w-0">
          <label className={labelClass} htmlFor="sim-duration">
            Hours
          </label>
          <select
            className={inputClass}
            id="sim-duration"
            onChange={(e) => setDuration(Number(e.target.value))}
            value={duration}
          >
            {[1, 2, 3, 4, 5].map((h) => (
              <option key={h} value={h}>
                {h} hour{h > 1 ? "s" : ""}
              </option>
            ))}
          </select>
        </div>
        <div className="min-w-0">
          <label className={labelClass} htmlFor="sim-start">
            Start time
          </label>
          <select
            className={inputClass}
            id="sim-start"
            onChange={(e) => setStart(e.target.value)}
            value={startStillValid ? start : ""}
          >
            {startStillValid ? null : (
              <option disabled value="">
                Pick a time
              </option>
            )}
            {startOptions.map((o) => (
              <option disabled={o.full} key={o.value} value={o.value}>
                {fmt12(o.value)}
                {o.full ? " · full" : ""}
              </option>
            ))}
          </select>
        </div>
        <div className="min-w-0">
          <label className={labelClass} htmlFor="sim-players">
            Players
          </label>
          <select
            className={inputClass}
            id="sim-players"
            onChange={(e) => setPlayers(Number(e.target.value))}
            value={players}
          >
            {[1, 2, 3, 4].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>
        <div className="min-w-0">
          <label className={labelClass} htmlFor="sim-name">
            Name
          </label>
          <input
            autoComplete="name"
            className={inputClass}
            id="sim-name"
            maxLength={120}
            onChange={(e) => setName(e.target.value)}
            value={name}
          />
        </div>
        <div className="min-w-0">
          <label className={labelClass} htmlFor="sim-phone">
            Phone
          </label>
          <input
            autoComplete="tel"
            className={inputClass}
            id="sim-phone"
            maxLength={40}
            onChange={(e) => setPhone(e.target.value)}
            type="tel"
            value={phone}
          />
        </div>
        <p className="text-sm text-[#5c6459] sm:col-span-2">
          New total: <span className="font-bold text-[#214d2f]">${(booking.hourly_rate * duration).toFixed(2)}</span>{" "}
          (paid at the club).
        </p>
      </FormShell>
    </form>
  );
}

function TeeEditForm({
  booking,
  creds,
  onCancel,
  onSaved,
}: {
  booking: TeeGuestBooking;
  creds: Credentials;
  onCancel: () => void;
  onSaved: (next: Found) => void;
}) {
  const [date, setDate] = useState(booking.date);
  const [time, setTime] = useState(booking.time);
  const [holes, setHoles] = useState<9 | 18>(booking.holes);
  const [players, setPlayers] = useState(booking.players);
  const [firstName, setFirstName] = useState(booking.first_name);
  const [lastName, setLastName] = useState(booking.last_name);
  const [phone, setPhone] = useState(booking.phone);
  const [times, setTimes] = useState<{ time: string; remaining: number }[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setTimes(null);
    bookingRpc<{ times: { time: string; remaining: number }[] }>("pelham_tee_availability", {
      p_date: date,
    })
      .then((res) => {
        if (!cancelled) setTimes(res.times);
      })
      .catch(() => {
        if (!cancelled) setTimes([]);
      });
    return () => {
      cancelled = true;
    };
  }, [date]);

  // 남은 자리 수에는 이 예약 자신의 인원도 빠져 있다. 원래 티타임이면 그만큼 돌려받는다.
  const options = (times ?? []).map((t) => {
    const own = date === booking.date && t.time === booking.time ? booking.players : 0;
    return { time: t.time, free: t.remaining + own, full: t.remaining + own < players };
  });
  const timeStillValid = options.some((o) => o.time === time);

  async function save() {
    setError("");
    if (!firstName.trim() && !lastName.trim()) {
      setError("Please enter a name.");
      return;
    }
    if (!timeStillValid) {
      setError("Please pick a tee time.");
      return;
    }
    setSaving(true);
    try {
      const next = await bookingRpc<Found>("pelham_tee_guest_update", {
        p_code: creds.code,
        p_email: creds.email,
        p: {
          date,
          time,
          holes,
          players,
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          phone: phone.trim(),
        },
      });
      onSaved(next);
    } catch (err) {
      setError(networkMessage(err, "Your changes could not be saved."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <FormShell error={error} onCancel={onCancel} saving={saving} title="Change your tee time">
        <div className="min-w-0">
          <label className={labelClass} htmlFor="tee-date">
            Date
          </label>
          <input
            className={inputClass}
            id="tee-date"
            min={todayIso()}
            onChange={(e) => e.target.value && setDate(e.target.value)}
            type="date"
            value={date}
          />
        </div>
        <div className="min-w-0">
          <label className={labelClass} htmlFor="tee-time">
            Tee time
          </label>
          <select
            className={inputClass}
            disabled={times === null}
            id="tee-time"
            onChange={(e) => setTime(e.target.value)}
            value={timeStillValid ? time : ""}
          >
            {timeStillValid ? null : (
              <option disabled value="">
                {times === null ? "Loading…" : times.length ? "Pick a time" : "No tee times this day"}
              </option>
            )}
            {options.map((o) => (
              <option disabled={o.full} key={o.time} value={o.time}>
                {o.time}
                {o.full ? " · full" : ` · ${o.free} open`}
              </option>
            ))}
          </select>
        </div>
        <div className="min-w-0">
          <label className={labelClass} htmlFor="tee-players">
            Players
          </label>
          <select
            className={inputClass}
            id="tee-players"
            onChange={(e) => setPlayers(Number(e.target.value))}
            value={players}
          >
            {[1, 2, 3, 4].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>
        <div className="min-w-0">
          <label className={labelClass} htmlFor="tee-holes">
            Holes
          </label>
          <select
            className={inputClass}
            id="tee-holes"
            onChange={(e) => setHoles(Number(e.target.value) === 9 ? 9 : 18)}
            value={holes}
          >
            <option value={18}>18 holes</option>
            <option value={9}>9 holes</option>
          </select>
        </div>
        <div className="min-w-0">
          <label className={labelClass} htmlFor="tee-first">
            First name
          </label>
          <input
            autoComplete="given-name"
            className={inputClass}
            id="tee-first"
            maxLength={60}
            onChange={(e) => setFirstName(e.target.value)}
            value={firstName}
          />
        </div>
        <div className="min-w-0">
          <label className={labelClass} htmlFor="tee-last">
            Last name
          </label>
          <input
            autoComplete="family-name"
            className={inputClass}
            id="tee-last"
            maxLength={60}
            onChange={(e) => setLastName(e.target.value)}
            value={lastName}
          />
        </div>
        <div className="min-w-0 sm:col-span-2">
          <label className={labelClass} htmlFor="tee-phone">
            Phone
          </label>
          <input
            autoComplete="tel"
            className={inputClass}
            id="tee-phone"
            maxLength={40}
            onChange={(e) => setPhone(e.target.value)}
            type="tel"
            value={phone}
          />
        </div>
      </FormShell>
    </form>
  );
}

function CancelConfirm({
  creds,
  kind,
  onBack,
  onCancelled,
}: {
  creds: Credentials;
  kind: Found["kind"];
  onBack: () => void;
  onCancelled: (next: Found) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function cancel() {
    setBusy(true);
    setError("");
    try {
      const next = await bookingRpc<Found>(
        kind === "sim" ? "pelham_sim_guest_cancel" : "pelham_tee_guest_cancel",
        { p_code: creds.code, p_email: creds.email },
      );
      onCancelled(next);
    } catch (err) {
      setError(networkMessage(err, "Your booking could not be cancelled."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 rounded-sm border border-[#e0b3b3] bg-[#fbeeee] p-5 text-[#8a2f2f]">
      <p className="font-semibold">Cancel this booking?</p>
      <p className="mt-1 text-sm">
        The {kind === "sim" ? "bay" : "tee time"} will be released for other golfers. This can&apos;t be
        undone online.
      </p>
      {error ? (
        <p className="mt-3 text-sm font-semibold" role="alert">
          {error}
        </p>
      ) : null}
      <div className="mt-4 grid grid-cols-[minmax(0,1fr)] gap-2 sm:grid-cols-2">
        <button
          className={`tap-target rounded-sm px-5 text-base font-bold text-white transition ${
            busy ? "cursor-not-allowed bg-[#a9b0a6]" : "bg-[#8a2f2f] hover:bg-[#6e2424]"
          }`}
          disabled={busy}
          onClick={() => void cancel()}
          type="button"
        >
          {busy ? "Cancelling…" : "Yes, cancel it"}
        </button>
        <button
          className="tap-target rounded-sm border border-[#d8d1c3] bg-white px-5 text-base font-bold text-[#214d2f] transition hover:bg-[#f7f4ed]"
          onClick={onBack}
          type="button"
        >
          Keep my booking
        </button>
      </div>
    </div>
  );
}

/**
 * 온라인으로 낸 예약: 수정은 프로 샵, 취소는 마감 전이면 여기서 하고 카드에 자동 환불된다.
 * 환불이 카드사에서 실패하면 예약은 그대로 남는다(서버가 되돌린다) — 손님에게 전화를 안내한다.
 */
function PaidOnlineActions({
  creds,
  deadline,
  kind,
  mode,
  onMode,
  onRefunded,
  quote,
}: {
  creds: Credentials;
  deadline: string;
  kind: Found["kind"];
  mode: "view" | "edit" | "cancel";
  onMode: (next: "view" | "cancel") => void;
  onRefunded: (message: string) => void;
  quote: Extract<PaymentQuote, { enabled: true }>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const paid = quote.payment!;
  const allowed = quote.cancel_refund?.allowed === true;
  const card = paid.card_last4 ? `${paid.card_brand || "card"} ending ${paid.card_last4}` : "card";

  async function cancel() {
    setBusy(true);
    setError("");
    try {
      const result = await cancelAndRefund(creds);
      onRefunded(
        result.booking_cancelled
          ? `Your booking has been cancelled and ${money(paid.amount)} is going back to your ${card}.`
          : `${money(paid.amount)} is going back to your ${card}. The pro shop will finish cancelling your booking.`,
      );
    } catch (err) {
      setError(networkMessage(err, "Your booking could not be cancelled."));
    } finally {
      setBusy(false);
    }
  }

  if (!allowed) {
    return (
      <Notice tone="warn" title="This booking can't be changed online">
        <p>
          {quote.cancel_refund?.reason ?? "This booking was paid online."} Please call the pro shop and they
          will help.
        </p>
      </Notice>
    );
  }

  if (mode === "cancel") {
    return (
      <div className="mt-3 rounded-sm border border-[#e0b3b3] bg-[#fbeeee] p-5 text-[#8a2f2f]">
        <p className="font-semibold">Cancel and refund {money(paid.amount)}?</p>
        <p className="mt-1 text-sm">
          The {kind === "sim" ? "bay" : "tee time"} will be released for other golfers and the full amount goes
          back to your {card}. This can&apos;t be undone online.
        </p>
        {error ? (
          <p className="mt-3 text-sm font-semibold" role="alert">
            {error}
          </p>
        ) : null}
        <div className="mt-4 grid grid-cols-[minmax(0,1fr)] gap-2 sm:grid-cols-2">
          <button
            className={`tap-target rounded-sm px-5 text-base font-bold text-white transition ${
              busy ? "cursor-not-allowed bg-[#a9b0a6]" : "bg-[#8a2f2f] hover:bg-[#6e2424]"
            }`}
            disabled={busy}
            onClick={() => void cancel()}
            type="button"
          >
            {busy ? "Refunding…" : "Yes, cancel and refund"}
          </button>
          <button
            className="tap-target rounded-sm border border-[#d8d1c3] bg-white px-5 text-base font-bold text-[#214d2f] transition hover:bg-[#f7f4ed]"
            disabled={busy}
            onClick={() => onMode("view")}
            type="button"
          >
            Keep my booking
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-3 rounded-sm border border-[#d8d1c3] bg-white p-4">
      <p className="text-sm text-[#5c6459]">
        You paid online, so changes are made by the pro shop. You can cancel here for a full refund until{" "}
        <span className="font-semibold text-[#182118]">{formatDeadline(deadline)}</span> (24 hours before the
        start).
      </p>
      <button
        className="tap-target mt-3 w-full rounded-sm border border-[#e0b3b3] bg-white px-5 text-base font-bold text-[#8a2f2f] transition hover:bg-[#fbeeee]"
        onClick={() => onMode("cancel")}
        type="button"
      >
        Cancel and refund
      </button>
    </div>
  );
}
