"use client";

/**
 * 고객용 티타임 검색 + 예약.
 *
 * 어드민 티 시트(`/admin`)와 같은 데이터를 보지만 화면은 정반대다. 직원은
 * "하루 전체가 어떻게 차 있나" 를 보고, 손님은 "내가 원하는 시간에 자리가 있나"
 * 하나만 본다. 그래서 여기에는 격자도 사이드바도 없고, 날짜 → 인원 → 시간 →
 * 이름 네 걸음뿐이다.
 *
 * 가용성 계산(취소 제외 / blocked 숨김 / 지난 시각 숨김)과 정원 검사는 Supabase 함수
 * `pelham_tee_availability` / `pelham_tee_book` 이 맡는다(`lib/booking/rpc.ts`).
 * 다른 손님의 예약 행은 이 화면에 오지 않는다 — 남은 자리 수만 온다.
 */

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import BookingShell from "@/components/booking/BookingShell";
import PayOnline from "@/components/booking/PayOnline";
import VoiceBooking from "@/components/booking/VoiceBooking";
import {
  DAY_PART_LABEL,
  type DayPartFilter,
  type OpenTeeTime,
  dayPartOf,
  describeFailure,
  formatChipDate,
  formatLongDate,
  splitName,
  todayIso,
  upcomingDates,
} from "@/components/booking/availability";
import { NO_API_MESSAGE } from "@/lib/apiHost";
import { bookingConfigured, bookingRpc } from "@/lib/booking/rpc";
import { CLUB, bookNav, lookupHref } from "@/lib/nav";
import type { TeeBooking } from "@/lib/teeSheet/types";

/** 오늘부터 2주. 그 너머는 프로 샵이 요금·행사를 아직 확정하지 않은 구간이다. */
const DAYS_AHEAD = 14;
const PARTY_SIZES = [1, 2, 3, 4] as const;
const DAY_PARTS: DayPartFilter[] = ["all", "morning", "afternoon", "evening"];
/** 음성 예약 서버(Fly)가 다시 켜지면 true 로. */
const VOICE_BOOKING_ENABLED = false;

export default function TeeTimeBookingPage() {
  // `null` 은 "아직 모름"(마운트 전), `false` 는 "이 사이트엔 예약 서버가 없다".
  // 브라우저에서만 판단할 수 있는 값이라 모듈 상수가 아니라 state 다 —
  // 정적 export 는 서버에서 한 번, 브라우저에서 다시 평가된다.
  const [apiReady, setApiReady] = useState<boolean | null>(null);

  const [date, setDate] = useState(todayIso());
  const [party, setParty] = useState(2);
  const [dayPart, setDayPart] = useState<DayPartFilter>("all");

  const [openTimes, setOpenTimes] = useState<OpenTeeTime[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [reloadToken, setReloadToken] = useState(0);

  const [selected, setSelected] = useState<OpenTeeTime | null>(null);
  const [created, setCreated] = useState<TeeBooking | null>(null);

  const dates = useMemo(() => upcomingDates(DAYS_AHEAD), []);

  useEffect(() => {
    setApiReady(bookingConfigured());
  }, []);

  useEffect(() => {
    if (apiReady !== true) return;

    let cancelled = false;
    setLoading(true);
    setLoadError("");

    bookingRpc<{ date: string; times: OpenTeeTime[] }>("pelham_tee_availability", { p_date: date })
      .then((response) => {
        if (cancelled) return;
        setOpenTimes(response.times);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setOpenTimes([]);
        setLoadError(describeFailure(error, "Tee times could not be loaded.").message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [apiReady, date, reloadToken]);

  const refresh = useCallback(() => setReloadToken((token) => token + 1), []);

  const visible = useMemo(() => {
    if (!openTimes) return [];
    return openTimes.filter((slot) => dayPart === "all" || dayPartOf(slot.minutes) === dayPart);
  }, [openTimes, dayPart]);

  const bookable = visible.filter((slot) => slot.remaining >= party).length;

  // 예약 서버가 없는 배포에서는 검색 폼을 아예 열지 않는다. 날짜와 시간을 고른 뒤
  // 마지막에 실패하는 것보다, 첫 화면에서 전화번호를 주는 편이 정직하다.
  if (apiReady === false) {
    return (
      <BookingShell subtitle="Online tee time booking is not available here." title="Tee Times">
        <div className="rounded-sm border border-[#d8d1c3] bg-white p-6">
          <p className="text-[#3d453d]">{NO_API_MESSAGE}</p>
          <a
            className="tap-target mt-5 flex items-center justify-center rounded-sm bg-[#214d2f] px-6 text-base font-bold text-white transition hover:bg-[#163820]"
            href={CLUB.phoneHref}
          >
            Call {CLUB.phone}
          </a>
        </div>
      </BookingShell>
    );
  }

  if (created) {
    return (
      <BookingShell subtitle="We will see you on the first tee." title="You are booked">
        <Confirmation
          booking={created}
          onBookAnother={() => {
            setCreated(null);
            setSelected(null);
            refresh();
          }}
        />
      </BookingShell>
    );
  }

  if (selected) {
    return (
      <BookingShell subtitle={`${formatLongDate(date)} · ${selected.time}`} title="Your details">
        <BookingForm
          date={date}
          onBack={() => setSelected(null)}
          onBooked={(booking) => setCreated(booking)}
          onSlotGone={() => {
            setSelected(null);
            refresh();
          }}
          party={party}
          setParty={setParty}
          slot={selected}
        />
      </BookingShell>
    );
  }

  return (
    <BookingShell
      subtitle="Pick a day, tell us how many are playing, and choose a time."
      title="Tee Times"
    >
      {/* 말로 하는 입구. 폼을 대신하는 게 아니라 **옆에** 둔다 — 마이크를 못 쓰거나
          조용한 곳에 있는 손님에게는 아래 폼이 여전히 유일한 길이다.
          예약 서버가 없는 배포에서는 음성도 어차피 불가능하므로 아예 그리지 않는다.
          지금은 꺼 둔다: 음성은 ElevenLabs 키를 든 FastAPI(`/voice/session`)가 있어야 하는데
          그 서버(Fly)가 멈췄다. 누르면 "쓸 수 없음" 만 뜨는 버튼을 손님에게 보이지 않는다. */}
      {apiReady === true && VOICE_BOOKING_ENABLED ? (
        <div className="mb-6">
          <VoiceBooking onFinished={refresh} />
        </div>
      ) : null}

      <DateStrip dates={dates} onChange={setDate} value={date} />

      <div className="mt-6 grid grid-cols-[minmax(0,1fr)] gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Fieldset label="Players">
          <div className="flex gap-2">
            {PARTY_SIZES.map((size) => (
              <button
                aria-pressed={party === size}
                className={`tap-target min-w-0 flex-1 rounded-sm border text-base font-semibold transition ${
                  party === size
                    ? "border-[#214d2f] bg-[#214d2f] text-white"
                    : "border-[#d8d1c3] bg-white text-[#182118] hover:border-[#214d2f]"
                }`}
                key={size}
                onClick={() => setParty(size)}
                type="button"
              >
                {size}
              </button>
            ))}
          </div>
        </Fieldset>

        <Fieldset label="Time of day">
          <div className="flex gap-2">
            {DAY_PARTS.map((part) => (
              <button
                aria-pressed={dayPart === part}
                className={`tap-target min-w-0 flex-1 truncate rounded-sm border px-1 text-sm font-semibold transition ${
                  dayPart === part
                    ? "border-[#214d2f] bg-[#214d2f] text-white"
                    : "border-[#d8d1c3] bg-white text-[#182118] hover:border-[#214d2f]"
                }`}
                key={part}
                onClick={() => setDayPart(part)}
                type="button"
              >
                {part === "all" ? "Any" : DAY_PART_LABEL[part]}
              </button>
            ))}
          </div>
        </Fieldset>
      </div>

      <div className="mt-8">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-serif text-xl font-semibold">{formatLongDate(date)}</h2>
          {!loading && !loadError && openTimes ? (
            <p className="text-sm text-[#5c6459]">
              {bookable} tee time{bookable === 1 ? "" : "s"} open for {party} player
              {party === 1 ? "" : "s"}
            </p>
          ) : null}
        </div>

        <div className="mt-4">
          {apiReady === null || loading ? (
            <SlotSkeleton />
          ) : loadError ? (
            <LoadFailure message={loadError} onRetry={refresh} />
          ) : visible.length === 0 ? (
            <EmptyDay
              dayPart={dayPart}
              onClearFilter={() => setDayPart("all")}
              onNextDay={() => {
                const next = dates[Math.min(dates.indexOf(date) + 1, dates.length - 1)];
                setDate(next);
              }}
            />
          ) : (
            <SlotGrid onPick={setSelected} party={party} slots={visible} />
          )}
        </div>
      </div>
    </BookingShell>
  );
}

// ===== 날짜 칩 =========================================================

function DateStrip({
  dates,
  onChange,
  value,
}: {
  dates: string[];
  onChange: (iso: string) => void;
  value: string;
}) {
  return (
    <div className="min-w-0">
      <p className="mb-2 text-sm font-semibold text-[#3d453d]">Date</p>
      {/* 칩 줄은 **자기 안에서** 가로 스크롤한다 — 페이지를 밀면 안 된다.
          `-mx-4 px-4` 로 화면 가장자리까지 스크롤되게 하되 본문 여백은 유지한다. */}
      <div className="no-scrollbar -mx-4 flex snap-x gap-2 overflow-x-auto px-4 pb-1">
        {dates.map((iso, index) => {
          const { weekday, day, month } = formatChipDate(iso);
          const active = iso === value;
          return (
            <button
              aria-pressed={active}
              className={`tap-target w-16 shrink-0 snap-start rounded-sm border px-1 py-2 text-center transition ${
                active
                  ? "border-[#214d2f] bg-[#214d2f] text-white"
                  : "border-[#d8d1c3] bg-white text-[#182118] hover:border-[#214d2f]"
              }`}
              key={iso}
              onClick={() => onChange(iso)}
              type="button"
            >
              <span className="block text-[11px] font-semibold uppercase tracking-wide opacity-80">
                {index === 0 ? "Today" : weekday}
              </span>
              <span className="block text-lg font-bold leading-tight">{day}</span>
              <span className="block text-[11px] opacity-80">{month}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Fieldset({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="min-w-0">
      <p className="mb-2 text-sm font-semibold text-[#3d453d]">{label}</p>
      {children}
    </div>
  );
}

// ===== 시간 격자 =======================================================

function SlotGrid({
  onPick,
  party,
  slots,
}: {
  onPick: (slot: OpenTeeTime) => void;
  party: number;
  slots: OpenTeeTime[];
}) {
  return (
    <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-6">
      {slots.map((slot) => {
        const full = slot.remaining < party;
        return (
          <button
            className={`tap-target flex min-w-0 flex-col items-center justify-center rounded-sm border px-1 py-2 transition ${
              full
                ? "cursor-not-allowed border-[#e2ddd0] bg-[#efece3] text-[#a8a698]"
                : "border-[#d8d1c3] bg-white text-[#182118] hover:border-[#214d2f] hover:bg-[#f2f6f2]"
            }`}
            disabled={full}
            key={slot.time}
            onClick={() => onPick(slot)}
            type="button"
          >
            <span className="text-sm font-bold leading-tight">{slot.time}</span>
            <span className="text-[11px] leading-tight">
              {slot.remaining === 0 ? "Full" : `${slot.remaining} left`}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function SlotSkeleton() {
  // 스피너 하나로 화면 전체를 비우지 않는다. 자리를 미리 잡아 두면 로딩이 끝났을 때
  // 화면이 튀지 않고, 손님은 "여기에 시간이 나온다" 를 미리 안다.
  return (
    <div aria-busy="true" className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-6">
      {Array.from({ length: 18 }, (_, index) => (
        <div
          className="h-14 animate-pulse rounded-sm border border-[#e2ddd0] bg-[#efece3]"
          key={index}
        />
      ))}
    </div>
  );
}

function LoadFailure({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="rounded-sm border border-[#e0b3b3] bg-[#fbeeee] p-5">
      <p className="font-semibold text-[#8a2f2f]">{message}</p>
      <div className="mt-4 flex flex-wrap gap-2">
        <button
          className="tap-target rounded-sm bg-[#214d2f] px-5 text-sm font-bold text-white transition hover:bg-[#163820]"
          onClick={onRetry}
          type="button"
        >
          Try again
        </button>
        <a
          className="tap-target flex items-center rounded-sm border border-[#d8d1c3] bg-white px-5 text-sm font-bold text-[#214d2f] transition hover:bg-[#f7f4ed]"
          href={CLUB.phoneHref}
        >
          Call {CLUB.phone}
        </a>
      </div>
    </div>
  );
}

function EmptyDay({
  dayPart,
  onClearFilter,
  onNextDay,
}: {
  dayPart: DayPartFilter;
  onClearFilter: () => void;
  onNextDay: () => void;
}) {
  return (
    <div className="rounded-sm border border-[#d6c28f] bg-[#f3ead2] p-5 text-[#5c4a1c]">
      <p className="font-semibold">
        {dayPart === "all"
          ? "There are no tee times left on this day."
          : `No ${DAY_PART_LABEL[dayPart].toLowerCase()} tee times are left on this day.`}
      </p>
      <p className="mt-1 text-sm">Try another date — the next two weeks are open above.</p>
      <div className="mt-4 flex flex-wrap gap-2">
        {dayPart === "all" ? null : (
          <button
            className="tap-target rounded-sm border border-[#8a6f30] bg-white px-5 text-sm font-bold text-[#5c4a1c] transition hover:bg-[#f7f4ed]"
            onClick={onClearFilter}
            type="button"
          >
            Show all times
          </button>
        )}
        <button
          className="tap-target rounded-sm bg-[#214d2f] px-5 text-sm font-bold text-white transition hover:bg-[#163820]"
          onClick={onNextDay}
          type="button"
        >
          Try the next day
        </button>
      </div>
    </div>
  );
}

// ===== 예약 폼 =========================================================

function BookingForm({
  date,
  onBack,
  onBooked,
  onSlotGone,
  party,
  setParty,
  slot,
}: {
  date: string;
  onBack: () => void;
  onBooked: (booking: TeeBooking) => void;
  onSlotGone: () => void;
  party: number;
  setParty: (size: number) => void;
  slot: OpenTeeTime;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [holes, setHoles] = useState<9 | 18>(18);
  const [cart, setCart] = useState(true);
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const maxParty = Math.min(4, slot.remaining);
  const size = Math.min(party, maxParty);
  const carts = cart ? Math.ceil(size / 2) : 0;
  const ready = name.trim().length > 0 && email.trim().length > 0 && !submitting;
  const total = slot.rate * size;

  const submit = async () => {
    setSubmitting(true);
    setError("");
    try {
      const [firstName, lastName] = splitName(name);
      // 요금은 보내지 않는다 — 함수가 그날의 요금을 매긴다. `players` 수만큼 자리를
      // 잡고, 첫 사람이 예약자, 나머지는 Guest 로 만든다. 예약 노트 끝의
      // "Booked online at pelhamhills.com." 도 함수가 붙인다.
      const booking = await bookingRpc<TeeBooking>("pelham_tee_book", {
        p: {
          date,
          time: slot.time,
          holes,
          cartCount: carts,
          players: size,
          firstName,
          lastName,
          email: email.trim(),
          phone: phone.trim(),
          notes: notes.trim(),
        },
      });
      onBooked(booking);
    } catch (failure) {
      const described = describeFailure(failure, "Your tee time could not be booked.");
      if (described.conflict) {
        // 자리가 나간 것은 실패가 아니라 **상태가 변한 것**이다. 폼에 붉은 배너만
        // 띄워 두면 손님은 이미 없는 시간을 계속 누르게 된다. 목록으로 돌려보낸다.
        onSlotGone();
        return;
      }
      setError(described.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-w-0">
      <button
        className="tap-target -ml-2 flex items-center px-2 text-sm font-semibold text-[#214d2f]"
        onClick={onBack}
        type="button"
      >
        <span aria-hidden className="mr-1">
          ←
        </span>
        Choose a different time
      </button>

      <div className="mt-3 rounded-sm border border-[#d8d1c3] bg-white p-5">
        <dl className="grid grid-cols-2 gap-3 text-sm">
          <div className="min-w-0">
            <dt className="font-semibold text-[#8a6f30]">Date</dt>
            <dd>{formatLongDate(date)}</dd>
          </div>
          <div className="min-w-0">
            <dt className="font-semibold text-[#8a6f30]">Tee time</dt>
            <dd className="text-base font-bold">{slot.time}</dd>
          </div>
          <div className="min-w-0">
            <dt className="font-semibold text-[#8a6f30]">Green fee</dt>
            <dd>${slot.rate.toFixed(2)} per player</dd>
          </div>
          <div className="min-w-0">
            <dt className="font-semibold text-[#8a6f30]">Estimated total</dt>
            <dd className="font-bold text-[#214d2f]">${total.toFixed(2)}</dd>
          </div>
        </dl>
      </div>

      {error ? (
        <div className="mt-4 rounded-sm border border-[#e0b3b3] bg-[#fbeeee] p-4 text-sm text-[#8a2f2f]">
          <p className="font-semibold">{error}</p>
          <a className="mt-2 inline-block font-bold underline" href={CLUB.phoneHref}>
            Call {CLUB.phone}
          </a>
        </div>
      ) : null}

      <div className="mt-4 space-y-5 rounded-sm border border-[#d8d1c3] bg-white p-5">
        <Field htmlFor="tt-name" label="Name">
          <input
            autoComplete="name"
            className="w-full rounded-sm border border-[#d8d1c3] px-4 py-3 text-base"
            id="tt-name"
            onChange={(event) => setName(event.target.value)}
            placeholder="Full name"
            type="text"
            value={name}
          />
        </Field>

        <Field htmlFor="tt-email" label="Email">
          <input
            autoComplete="email"
            className="w-full rounded-sm border border-[#d8d1c3] px-4 py-3 text-base"
            id="tt-email"
            inputMode="email"
            onChange={(event) => setEmail(event.target.value)}
            placeholder="your@email.com"
            type="email"
            value={email}
          />
        </Field>

        <Field htmlFor="tt-phone" label="Phone (optional)">
          <input
            autoComplete="tel"
            className="w-full rounded-sm border border-[#d8d1c3] px-4 py-3 text-base"
            id="tt-phone"
            inputMode="tel"
            onChange={(event) => setPhone(event.target.value)}
            placeholder="(905) 123-4567"
            type="tel"
            value={phone}
          />
        </Field>

        <Field htmlFor="tt-players" label="Players">
          <select
            className="w-full rounded-sm border border-[#d8d1c3] px-4 py-3 text-base"
            id="tt-players"
            onChange={(event) => setParty(Number(event.target.value))}
            value={size}
          >
            {Array.from({ length: maxParty }, (_, index) => index + 1).map((count) => (
              <option key={count} value={count}>
                {count} player{count === 1 ? "" : "s"}
              </option>
            ))}
          </select>
          {maxParty < 4 ? (
            <p className="mt-1 text-xs text-[#8a6f30]">
              Only {maxParty} spot{maxParty === 1 ? "" : "s"} left at {slot.time}.
            </p>
          ) : null}
        </Field>

        <div>
          <p className="mb-2 text-sm font-semibold text-[#3d453d]">Holes</p>
          <div className="flex gap-2">
            {([9, 18] as const).map((count) => (
              <button
                aria-pressed={holes === count}
                className={`tap-target min-w-0 flex-1 rounded-sm border text-base font-semibold transition ${
                  holes === count
                    ? "border-[#214d2f] bg-[#214d2f] text-white"
                    : "border-[#d8d1c3] bg-white text-[#182118] hover:border-[#214d2f]"
                }`}
                key={count}
                onClick={() => setHoles(count)}
                type="button"
              >
                {count} holes
              </button>
            ))}
          </div>
        </div>

        <label className="flex items-start gap-3 text-base" htmlFor="tt-cart">
          <input
            checked={cart}
            className="mt-1 h-5 w-5"
            id="tt-cart"
            onChange={(event) => setCart(event.target.checked)}
            type="checkbox"
          />
          <span className="min-w-0">
            <span className="font-semibold">Power cart</span>
            {/* 서버의 동기화 패스는 cartCount > 인원이면 경고를 남긴다. 카트 한 대에
                두 명이 타므로 인원의 절반(올림)만 잡는다. */}
            <span className="block text-sm text-[#5c6459]">
              {carts > 0
                ? `We will hold ${carts} cart${carts === 1 ? "" : "s"} for your group. Pay at the pro shop.`
                : "Walking. Tell us if that changes."}
            </span>
          </span>
        </label>

        <Field htmlFor="tt-notes" label="Notes (optional)">
          <textarea
            className="w-full rounded-sm border border-[#d8d1c3] px-4 py-3 text-base"
            id="tt-notes"
            onChange={(event) => setNotes(event.target.value)}
            placeholder="Anything the pro shop should know"
            rows={3}
            value={notes}
          />
        </Field>
      </div>

      <button
        className={`tap-target mt-5 w-full rounded-sm py-3 text-base font-bold text-white transition ${
          ready ? "bg-[#214d2f] hover:bg-[#163820]" : "cursor-not-allowed bg-[#a9b0a6]"
        }`}
        disabled={!ready}
        onClick={submit}
        type="button"
      >
        {submitting ? "Booking…" : `Book ${slot.time}`}
      </button>

      <p className="mt-3 text-xs text-[#5c6459]">
        Pay green fees online right after booking, or at the pro shop. Please arrive 15 minutes before
        your tee time.
      </p>
    </div>
  );
}

function Field({
  children,
  htmlFor,
  label,
}: {
  children: ReactNode;
  htmlFor: string;
  label: string;
}) {
  return (
    <div className="min-w-0">
      {/* 입력 글자가 16px 미만이면 iOS 가 포커스 시 화면을 확대한다. 라벨은 작아도
          되지만 input/select/textarea 는 전부 `text-base` 다. */}
      <label className="mb-2 block text-sm font-semibold text-[#3d453d]" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
    </div>
  );
}

// ===== 확정 화면 =======================================================

function Confirmation({
  booking,
  onBookAnother,
}: {
  booking: TeeBooking;
  onBookAnother: () => void;
}) {
  const players = booking.players.length;
  const code = booking.confirmationCode ?? booking.id;
  // 온라인 결제의 본인 확인도 조회 화면과 같다: 코드 + 예약한 사람의 이메일.
  const email = booking.players.find((p) => p.email)?.email ?? "";
  return (
    <div className="min-w-0">
      <div className="rounded-sm border border-[#d8d1c3] bg-white p-6 text-center">
        <div aria-hidden className="mb-3 text-4xl text-[#214d2f]">
          ✓
        </div>
        <h2 className="font-serif text-2xl font-semibold text-[#214d2f]">
          Your tee time is reserved
        </h2>

        <div className="mt-5 rounded-sm bg-[#f7f4ed] p-5 text-left">
          <p className="text-sm text-[#5c6459]">{formatLongDate(booking.date)}</p>
          <p className="mt-1 text-3xl font-bold">{booking.time}</p>
          <p className="mt-1 text-sm text-[#3d453d]">
            {players} player{players === 1 ? "" : "s"} · {booking.holes} holes ·{" "}
            {booking.cartCount > 0
              ? `${booking.cartCount} cart${booking.cartCount === 1 ? "" : "s"}`
              : "Walking"}
          </p>
          <p className="mt-1 text-sm text-[#3d453d]">
            ${booking.rate.toFixed(2)} per player · ${(booking.rate * players).toFixed(2)} total
          </p>

          <div className="mt-4 border-t border-[#d8d1c3] pt-4">
            <p className="text-sm font-semibold text-[#8a6f30]">Confirmation code</p>
            {/* 0012 이전 서버면 코드가 없어 UUID 를 보여 준다. 길어서 반드시 꺾는다. */}
            <p className="break-all font-mono text-lg font-bold tracking-widest text-[#214d2f]">
              {code}
            </p>
          </div>
        </div>

        <p className="mt-4 text-sm text-[#5c6459]">
          Save this code. With it and your email you can change or cancel your tee time online
          up to 24 hours before — or call the pro shop at {CLUB.phone}.
        </p>
      </div>

      {booking.confirmationCode && email ? <PayOnline creds={{ code, email }} /> : null}

      <div className="mt-5 grid grid-cols-[minmax(0,1fr)] gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Link
          className="tap-target flex items-center justify-center rounded-sm border border-[#d8d1c3] bg-white px-5 text-base font-bold text-[#214d2f] transition hover:bg-[#f7f4ed]"
          href={lookupHref(code)}
        >
          {bookNav[2].label}
        </Link>
        <button
          className="tap-target rounded-sm bg-[#214d2f] px-5 text-base font-bold text-white transition hover:bg-[#163820]"
          onClick={onBookAnother}
          type="button"
        >
          Book another tee time
        </button>
      </div>
    </div>
  );
}
