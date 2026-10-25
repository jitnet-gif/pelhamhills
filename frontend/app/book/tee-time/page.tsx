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
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import BookingShell from "@/components/booking/BookingShell";
import IdScanUpload from "@/components/booking/IdScanUpload";
import { MemberLookupList, memberLabel, usePublicMemberSearch, type PublicMember } from "@/components/booking/MemberLookup";
import PayOnline from "@/components/booking/PayOnline";
import VoiceBooking from "@/components/booking/VoiceBooking";
import { TeeTimeGroups } from "@/components/booking/TeeTimeCards";
import {
  type OpenTeeTime,
  describeFailure,
  formatChipDate,
  formatLongDate,
  fromIsoDate,
  splitName,
  todayIso,
  upcomingDates,
} from "@/components/booking/availability";
import { NO_API_MESSAGE } from "@/lib/apiHost";
import { recordBookingSource } from "@/lib/booking/attribution";
import { memberSessionExpired, useMemberSession } from "@/lib/booking/memberSession";
import { bookingConfigured, bookingRpc } from "@/lib/booking/rpc";
import { greenFeeFor, nineHoleRule, nineHolesOpen } from "@/lib/greenFee";
import { BOOK_LOGIN, CLUB, bookNav, lookupHref } from "@/lib/nav";
import { ApiError } from "@/lib/teeSheet/api";
import { minutesToTime } from "@/lib/teeSheet/dates";
import { teeWindow } from "@/lib/teeSheet/sun";
import type { TeeBooking } from "@/lib/teeSheet/types";

/** 오늘부터 2주. 그 너머는 프로 샵이 요금·행사를 아직 확정하지 않은 구간이다. */
const DAYS_AHEAD = 14;
const PARTY_SIZES = [1, 2, 3, 4] as const;
/** 음성 예약 서버(Fly)가 다시 켜지면 true 로. */
const VOICE_BOOKING_ENABLED = false;

export default function TeeTimeBookingPage() {
  // `null` 은 "아직 모름"(마운트 전), `false` 는 "이 사이트엔 예약 서버가 없다".
  // 브라우저에서만 판단할 수 있는 값이라 모듈 상수가 아니라 state 다 —
  // 정적 export 는 서버에서 한 번, 브라우저에서 다시 평가된다.
  const [apiReady, setApiReady] = useState<boolean | null>(null);

  const [date, setDate] = useState(todayIso());
  const [party, setParty] = useState(2);

  const [openTimes, setOpenTimes] = useState<OpenTeeTime[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [reloadToken, setReloadToken] = useState(0);

  const [selected, setSelected] = useState<OpenTeeTime | null>(null);
  const [created, setCreated] = useState<TeeBooking | null>(null);
  const pendingTime = useRef<string | null>(null);

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
        // 주소로 들어온 티타임(아래 `pendingTime`)은 첫 목록이 오면 한 번만 연다. 그 사이 나갔으면 목록에 남는다.
        if (pendingTime.current) {
          const wanted = response.times.find((slot) => slot.time === pendingTime.current && slot.remaining > 0);
          pendingTime.current = null;
          if (wanted) setSelected(wanted);
        }
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

  // 주소에 날짜·시간을 싣는다(`?date=…&time=…`). 링크를 보내거나 새로고침해도 같은 티타임 상세가
  // 다시 열린다. 정적 export 라 `useSearchParams`(Suspense 필요) 대신 location 을 직접 읽는다.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const wantDate = params.get("date");
    if (wantDate && dates.includes(wantDate)) setDate(wantDate);
    const wantTime = params.get("time");
    if (wantTime) pendingTime.current = wantTime;
    const onPop = () => {
      if (!new URLSearchParams(window.location.search).get("time")) setSelected(null);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [dates]);

  const pick = useCallback(
    (slot: OpenTeeTime) => {
      setSelected(slot);
      window.history.pushState(null, "", `?date=${date}&time=${encodeURIComponent(slot.time)}`);
      window.scrollTo({ top: 0 });
    },
    [date],
  );
  const unpick = useCallback(() => {
    setSelected(null);
    window.history.replaceState(null, "", `?date=${date}`);
  }, [date]);

  const visible = useMemo(() => (openTimes ?? []).filter((slot) => slot.remaining > 0), [openTimes]);

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
            unpick();
            refresh();
          }}
        />
      </BookingShell>
    );
  }

  if (selected) {
    return (
      <BookingShell subtitle={`${formatLongDate(date)} · ${selected.time}`} title="Tee Time">
        <BookingForm
          date={date}
          onBack={unpick}
          onBooked={(booking) => setCreated(booking)}
          onSlotGone={() => {
            unpick();
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

        <SunTimes date={date} />
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
              onNextDay={() => {
                const next = dates[Math.min(dates.indexOf(date) + 1, dates.length - 1)];
                setDate(next);
              }}
            />
          ) : (
            <TeeTimeGroups onPick={pick} party={party} slots={visible} />
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

// ===== 해 =============================================================

/** 그날 첫 티·마지막 티. 목록은 서버(0048·`pelham_tee_window`)가 이미 이 사이로 자른다 — 여기는 안내만. */
function SunTimes({ date }: { date: string }) {
  const { first, last } = teeWindow(date);
  if (!Number.isFinite(first) || !Number.isFinite(last)) return null;
  return (
    <Fieldset label="Daylight">
      <p className="flex min-h-11 flex-wrap items-center gap-x-4 gap-y-1 rounded-sm border border-[#d6c28f] bg-[#f3ead2] px-4 text-sm font-semibold text-[#5c4a1c]">
        <span>☀ First tee {minutesToTime(first)}</span>
        <span>Last tee {minutesToTime(last)}</span>
      </p>
    </Fieldset>
  );
}

function SlotSkeleton() {
  // 스피너 하나로 화면 전체를 비우지 않는다. 자리를 미리 잡아 두면 로딩이 끝났을 때
  // 화면이 튀지 않고, 손님은 "여기에 시간이 나온다" 를 미리 안다.
  return (
    <div aria-busy="true" className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      {Array.from({ length: 10 }, (_, index) => (
        <div
          className="h-28 animate-pulse rounded-md border border-[#e2ddd0] bg-[#efece3]"
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

function EmptyDay({ onNextDay }: { onNextDay: () => void }) {
  return (
    <div className="rounded-sm border border-[#d6c28f] bg-[#f3ead2] p-5 text-[#5c4a1c]">
      <p className="font-semibold">There are no tee times left on this day.</p>
      <p className="mt-1 text-sm">Try another date — the next two weeks are open above.</p>
      <div className="mt-4 flex flex-wrap gap-2">
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
  // 이름 칸의 회원 찾기(0109). 고른 회원은 이름을 다시 고치면 풀린다 — 다른 이름에 회원이 붙지 않게.
  const [member, setMember] = useState<PublicMember | null>(null);
  const [nameFocused, setNameFocused] = useState(false);
  const [activeHit, setActiveHit] = useState(0);
  const { hits } = usePublicMemberSearch(name, nameFocused && member === null);
  const listOpen = nameFocused && member === null && hits.length > 0;
  const activeIndex = activeHit < hits.length ? activeHit : 0;
  // 로그인한 회원(0111)이면 이름·이메일·전화는 계정 것으로 가고, 위의 회원 찾기는 쓰지 않는다.
  const session = useMemberSession();
  const signedIn = session ? session.member : null;
  const memberBadge = member
    ? memberLabel(member)
    : signedIn?.membershipType && signedIn.season
      ? memberLabel({ membershipType: signedIn.membershipType, season: signedIn.season })
      : null;

  const maxParty = Math.min(4, slot.remaining);
  const size = Math.min(party, maxParty);
  const carts = cart ? Math.ceil(size / 2) : 0;
  const ready = (signedIn !== null || (name.trim().length > 0 && email.trim().length > 0)) && !submitting;
  // 9홀은 정해진 시각부터만(0034). 이른 티타임이면 버튼을 끄고 18홀로 둔다.
  const nineOpen = nineHolesOpen(slot);
  const fee = greenFeeFor(slot, holes);
  // 카트는 1인 요금(세전) — 웹 예약은 모두 Public 이다. 진짜 값은 DB(0050·`pelham_tee_cart_fee_on`)가 매긴다.
  const cartFee = cart ? (holes === 9 ? 11.5 : 19.47) : 0;

  const submit = async () => {
    setSubmitting(true);
    setError("");
    try {
      const [firstName, lastName] = splitName(name);
      // 요금은 보내지 않는다 — 함수가 그날의 요금을 매긴다. `players` 수만큼 자리를
      // 잡고, 첫 사람이 예약자, 나머지는 Guest 로 만든다. 예약 노트 끝의
      // "Booked online at pelhamhills.com." 도 함수가 붙인다.
      const p = {
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
      };
      // 회원을 골랐으면 회원 예약으로. 이메일·전화가 회원 기록과 맞는지는 함수가 본다(`memberVerified`).
      const booking = session
        ? await bookingRpc<TeeBooking>("pelham_tee_book_signed_in", { p, p_token: session.token })
        : member
        ? await bookingRpc<TeeBooking>("pelham_tee_book_member", { p, p_member: member.ref })
        : await bookingRpc<TeeBooking>("pelham_tee_book", { p });
      recordBookingSource("tee", booking.confirmationCode);
      onBooked(booking);
    } catch (failure) {
      if (session && failure instanceof ApiError && failure.status === 401) {
        // 로그인이 지났다. 로그아웃 상태로 돌리면 폼이 손님 입력칸을 다시 보여 준다.
        memberSessionExpired();
        setError("Your member sign-in has expired. Sign in again, or book with your details below.");
        return;
      }
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

  const [step, setStep] = useState<"choose" | "details">("choose");
  // 회원 본인 그린피는 회원권 요금제로 서버가 매긴다(대부분 $0). 미리보기는 손님 몫만 더한다.
  const memberSeats = memberBadge ? 1 : 0;
  const total = fee * (size - memberSeats) + cartFee * size;
  const greenTotal = fee * (size - memberSeats);
  const cartTotal = cartFee * size;
  // 미리보기 HST. 진짜 세금은 결제할 때 서버 견적(PayOnline)이 매긴다.
  const tax = Math.round((greenTotal + cartTotal) * 13) / 100;
  const segment = (on: boolean) =>
    `tap-target min-w-0 flex-1 border-l border-[#d8d1c3] text-base font-semibold transition first:border-l-0 disabled:cursor-not-allowed disabled:opacity-40 ${
      on ? "bg-[#2f8a4f] text-white" : "bg-white text-[#182118] enabled:hover:bg-[#f2f6f2]"
    }`;

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
        All tee times
      </button>

      {/* 넓은 화면: 왼쪽 사진·정보(위)와 입력칸(아래), 오른쪽에 붙는 요약 패널.
          좁은 화면: 사진 → 패널 → 입력칸 순서로 쌓인다(DOM 순서 그대로). */}
      <div className="mt-3 grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <div className="min-w-0 lg:col-start-1 lg:row-start-1">
          {/* next/image 를 쓰지 않는다: `output: "export"` (예약 허브와 같은 이유). */}
          <img
            alt="Fairway at Pelham Hills Golf Club"
            className="h-52 w-full rounded-xl object-cover sm:h-72"
            src="/pelham-hills/hero-course.png"
          />
          <h2 className="mt-4 font-serif text-2xl font-semibold">{CLUB.name}</h2>
          <p className="mt-1 text-sm text-[#5c6459]">{CLUB.address}</p>
          <p className="mt-3 text-sm text-[#3d453d]">
            Please arrive 15 minutes before your tee time. Check in at the pro shop.
          </p>
        </div>

        <aside className="min-w-0 lg:sticky lg:top-20 lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:self-start">
          <div className="rounded-xl border border-[#d8d1c3] bg-white p-5 shadow-sm">
            <dl className="grid grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)_minmax(0,0.6fr)] gap-3">
              <div className="min-w-0">
                <dt className="text-xs text-[#5c6459]">Date</dt>
                <dd className="font-semibold">{shortDate(date)}</dd>
              </div>
              <div className="min-w-0">
                <dt className="text-xs text-[#5c6459]">Time</dt>
                <dd className="font-semibold">{slot.time}</dd>
              </div>
              <div className="min-w-0">
                <dt className="text-xs text-[#5c6459]">Holes</dt>
                <dd className="font-semibold">{holes}</dd>
              </div>
            </dl>

            <div className="mt-3 flex flex-wrap gap-2 text-xs">
              <span className="rounded-full border border-[#182118] px-3 py-0.5">{nineOpen ? "9 or 18 holes" : "18 holes"}</span>
              <span className="rounded-full border border-[#182118] px-3 py-0.5">{cart ? "Power cart" : "Walking"}</span>
              {slot.twilight ? (
                <span className="rounded-full border border-[#8a6f30] px-3 py-0.5 font-semibold text-[#8a6f30]">Twilight</span>
              ) : null}
            </div>

            <p className="mt-5 text-sm font-semibold text-[#3d453d]">Holes</p>
            <div className="mt-2 flex overflow-hidden rounded-md border border-[#d8d1c3]">
              {([9, 18] as const).map((count) => (
                <button
                  aria-pressed={holes === count}
                  className={segment(holes === count)}
                  disabled={count === 9 && !nineOpen}
                  key={count}
                  onClick={() => setHoles(count)}
                  type="button"
                >
                  {count}
                </button>
              ))}
            </div>
            {nineOpen ? null : <p className="mt-1 text-xs text-[#8a6f30]">{nineHoleRule(slot)}.</p>}

            <p className="mt-5 text-sm">
              <span className="text-lg font-bold">${fee.toFixed(2)}</span>
              <span className="text-xs font-semibold text-[#5c6459]"> CAD / golfer</span>
            </p>
            <p className="mt-2 text-sm font-semibold text-[#3d453d]">Number of Golfers</p>
            <div className="mt-2 flex overflow-hidden rounded-md border border-[#d8d1c3]">
              {PARTY_SIZES.map((count) => (
                <button
                  aria-pressed={size === count}
                  className={segment(size === count)}
                  disabled={count > maxParty}
                  key={count}
                  onClick={() => setParty(count)}
                  type="button"
                >
                  {count}
                </button>
              ))}
            </div>
            {maxParty < 4 ? (
              <p className="mt-1 text-xs text-[#8a6f30]">
                Only {maxParty} spot{maxParty === 1 ? "" : "s"} left at {slot.time}.
              </p>
            ) : null}

            <label className="mt-4 flex items-start gap-3 text-sm" htmlFor="tt-cart">
              <input
                checked={cart}
                className="mt-0.5 h-5 w-5"
                id="tt-cart"
                onChange={(event) => setCart(event.target.checked)}
                type="checkbox"
              />
              {/* 서버의 동기화 패스는 cartCount > 인원이면 경고를 남긴다. 카트 한 대에
                  두 명이 타므로 인원의 절반(올림)만 잡는다. */}
              <span className="min-w-0">
                <span className="font-semibold">Power cart</span>
                <span className="block text-xs text-[#5c6459]">
                  {carts > 0
                    ? `${carts} cart${carts === 1 ? "" : "s"} held for your group — $${(holes === 9 ? 11.5 : 19.47).toFixed(2)} per player.`
                    : "Walking. Tell us if that changes."}
                </span>
              </span>
            </label>

            <dl className="mt-5 space-y-2 border-t border-[#e2ddd0] pt-4 text-sm">
              {memberBadge ? (
                <div className="flex justify-between gap-3">
                  <dt className="text-[#3d453d]">You ({memberBadge})</dt>
                  <dd className="text-[#2f7d4f]">Member rate</dd>
                </div>
              ) : null}
              {size - memberSeats > 0 ? (
                <div className="flex justify-between gap-3">
                  <dt className="text-[#3d453d]">
                    Green Fees ({size - memberSeats} {memberBadge ? "Guest" : "Golfer"}
                    {size - memberSeats === 1 ? "" : "s"} × ${fee.toFixed(2)})
                  </dt>
                  <dd className="tabular-nums">${greenTotal.toFixed(2)}</dd>
                </div>
              ) : null}
              {cartTotal > 0 ? (
                <div className="flex justify-between gap-3">
                  <dt className="text-[#3d453d]">
                    Power cart ({size} × ${cartFee.toFixed(2)})
                  </dt>
                  <dd className="tabular-nums">${cartTotal.toFixed(2)}</dd>
                </div>
              ) : null}
              <div className="flex justify-between gap-3">
                <dt className="text-[#3d453d]">Estimated HST 13%</dt>
                <dd className="tabular-nums">${tax.toFixed(2)}</dd>
              </div>
              <div className="flex justify-between gap-3 border-t border-[#e2ddd0] pt-3 text-base font-bold">
                <dt>Total</dt>
                <dd className="tabular-nums">${(total + tax).toFixed(2)} CAD</dd>
              </div>
            </dl>

            {error ? (
              <div className="mt-4 rounded-sm border border-[#e0b3b3] bg-[#fbeeee] p-4 text-sm text-[#8a2f2f]">
                <p className="font-semibold">{error}</p>
                <a className="mt-2 inline-block font-bold underline" href={CLUB.phoneHref}>
                  Call {CLUB.phone}
                </a>
              </div>
            ) : null}

            {step === "choose" ? (
              <button
                className="tap-target mt-5 w-full rounded-full bg-[#2f8a4f] py-3 text-base font-bold text-white transition hover:bg-[#256f3f]"
                onClick={() => {
                  setStep("details");
                  // 좁은 화면에서는 입력칸이 패널 아래에 있다 — 그쪽으로 내려 준다.
                  window.setTimeout(() => document.getElementById("tt-name")?.focus(), 50);
                }}
                type="button"
              >
                Continue to Book
              </button>
            ) : (
              <button
                className={`tap-target mt-5 w-full rounded-full py-3 text-base font-bold text-white transition ${
                  ready ? "bg-[#2f8a4f] hover:bg-[#256f3f]" : "cursor-not-allowed bg-[#a9b0a6]"
                }`}
                disabled={!ready}
                onClick={submit}
                type="button"
              >
                {submitting ? "Booking…" : `Book ${slot.time}`}
              </button>
            )}
            <p className="mt-3 text-center text-xs text-[#5c6459]">
              No booking fee. Pay online right after booking, or at the pro shop.
            </p>
          </div>
        </aside>

        {step === "details" ? (
          <div className="min-w-0 space-y-5 rounded-xl border border-[#d8d1c3] bg-white p-5 lg:col-start-1 lg:row-start-2 lg:self-start">
            <h3 className="font-serif text-xl font-semibold">Your details</h3>
            {signedIn ? (
              <div className="rounded-sm border border-[#cfe3d4] bg-[#f2f8f3] p-4">
                <p className="font-semibold">{signedIn.name}</p>
                {memberBadge ? (
                  <p className="mt-1">
                    <span className="rounded-full bg-[#e3f0e6] px-3 py-0.5 text-sm font-semibold text-[#2f7d4f]">
                      {memberBadge}
                    </span>
                  </p>
                ) : (
                  <p className="mt-1 text-sm text-[#8a6f30]">
                    No active membership today — this books at the regular rate and the pro shop will check.
                  </p>
                )}
                <p className="mt-2 text-sm text-[#5c6459]">
                  {[signedIn.email, signedIn.phone].filter(Boolean).join(" · ")}
                </p>
                <p className="mt-2 text-sm">
                  <Link className="font-semibold text-[#214d2f] underline" href={BOOK_LOGIN}>
                    Not you? Sign out
                  </Link>
                </p>
              </div>
            ) : (
            <>
            <Field htmlFor="tt-name" label="Name">
              <div className="relative">
                <input
                  aria-activedescendant={listOpen ? `tt-members-${activeIndex}` : undefined}
                  aria-autocomplete="list"
                  aria-controls="tt-members"
                  aria-expanded={listOpen}
                  autoComplete="name"
                  className="w-full rounded-sm border border-[#d8d1c3] px-4 py-3 text-base"
                  id="tt-name"
                  onBlur={() => setNameFocused(false)}
                  onChange={(event) => {
                    setName(event.target.value);
                    setMember(null);
                    setActiveHit(0);
                  }}
                  onFocus={() => setNameFocused(true)}
                  onKeyDown={(event) => {
                    if (!listOpen) return;
                    if (event.key === "ArrowDown") {
                      event.preventDefault();
                      setActiveHit((activeIndex + 1) % hits.length);
                    } else if (event.key === "ArrowUp") {
                      event.preventDefault();
                      setActiveHit((activeIndex - 1 + hits.length) % hits.length);
                    } else if (event.key === "Enter") {
                      event.preventDefault();
                      const hit = hits[activeIndex];
                      setMember(hit);
                      setName(hit.name);
                    } else if (event.key === "Escape") {
                      setNameFocused(false);
                    }
                  }}
                  placeholder="Full name"
                  role="combobox"
                  type="text"
                  value={name}
                />
                {listOpen ? (
                  <MemberLookupList
                    active={activeIndex}
                    hits={hits}
                    id="tt-members"
                    onHover={setActiveHit}
                    onPick={(hit) => {
                      setMember(hit);
                      setName(hit.name);
                    }}
                  />
                ) : null}
              </div>
              {member ? (
                <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                  <span className="rounded-full bg-[#e3f0e6] px-3 py-0.5 font-semibold text-[#2f7d4f]">
                    {memberLabel(member)}
                  </span>
                  <span className="text-[#5c6459]">
                    Use the email or phone we have on file to book at your member rate.
                  </span>
                  <button
                    className="font-semibold text-[#214d2f] underline"
                    onClick={() => setMember(null)}
                    type="button"
                  >
                    Not me
                  </button>
                </p>
              ) : (
                <p className="mt-2 text-xs text-[#5c6459]">
                  Members:{" "}
                  <Link className="font-semibold text-[#214d2f] underline" href={BOOK_LOGIN}>
                    sign in
                  </Link>{" "}
                  to book at your member rate, or start typing your name and pick it from the list.
                </p>
              )}
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

            <Field htmlFor="tt-phone" label={member ? "Phone (or use the email on file)" : "Phone (optional)"}>
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
            </>
            )}

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
        ) : null}
      </div>
    </div>
  );
}

/** "Thu., Oct 22, 2026" — 패널은 좁아서 요일·월을 줄인다. */
function shortDate(iso: string): string {
  return fromIsoDate(iso).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
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
  const cartTotal = booking.players.reduce((sum, p) => sum + (p.cart ? (p.cartFee ?? 0) : 0), 0);
  // 회원으로 잡힌 첫 사람은 그린피가 다르다(0109) — 선수별 greenFee 가 있으면 그걸 더한다.
  const greenTotal = booking.players.reduce((sum, p) => sum + (p.greenFee ?? booking.rate), 0);
  // `pelham_tee_book_member` 만 붙인다. 일반 예약이면 undefined.
  const memberVerified = (booking as TeeBooking & { memberVerified?: boolean }).memberVerified;
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
            {`$${booking.rate.toFixed(2)} per player`}
            {cartTotal > 0 ? ` + cart $${cartTotal.toFixed(2)}` : ""}
            {` · $${(greenTotal + cartTotal).toFixed(2)} total`}
          </p>
          {memberVerified === true ? (
            <p className="mt-2 text-sm font-semibold text-[#2f7d4f]">
              Booked as a member — your member rate is applied. Guests pay the regular rate.
            </p>
          ) : memberVerified === false ? (
            <p className="mt-2 text-sm font-semibold text-[#8a6f30]">
              We couldn&apos;t match your email or phone to our member records, so this is booked at the regular
              rate. The pro shop will check your membership when you arrive.
            </p>
          ) : null}

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
      {booking.confirmationCode && email ? <IdScanUpload code={code} email={email} /> : null}

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
