"use client";

/**
 * PH Indoor Golf(시뮬레이터 베이) 예약. 원래 `app/simulator/page.tsx` 였고
 * 예약 사이트가 `/book/*` 로 모이면서 이리로 옮겨 왔다. 옛 주소는
 * `app/simulator/page.tsx` 가 이 페이지를 그대로 재수출해서 계속 살아 있다 —
 * 명함·구글 검색 결과에 그 주소가 이미 나가 있다.
 *
 * 예약 로직(가용성 조회 · 4단계 마법사 · 확정)은 손대지 않았다. 바뀐 것은 셋이다.
 * 1. 자기 머리글(`PageHeader`) 대신 `BookingShell` 을 쓴다 — 예약 사이트의
 *    다른 화면과 같은 내비게이션을 갖기 위해서다. 껍데기가 헤더를 그리므로
 *    옛 `PageHeader` 는 지웠다(두 번 그려지면 머리글이 겹친다).
 * 2. 모바일 품질: 입력 글자 16px(그 미만이면 iOS 가 확대한다), 시간 슬롯 격자를
 *    390px 에서 3열로, 누르는 것은 최소 44px.
 * 3. "오늘" 을 현지 날짜로 계산한다. `toISOString()` 은 UTC 라 온타리오 저녁
 *    7시부터 내일이 오늘이 되어, 당일 예약이 통째로 사라졌다.
 *
 * 가용성·예약은 Supabase 함수 `pelham_sim_availability` / `pelham_sim_reserve` 를
 * `lib/booking/rpc.ts` 로 부른다. 예전 FastAPI 서버(Fly)는 2026-09-16 에 멈췄다.
 */

import { useState, useEffect } from "react";

import BookingShell from "@/components/booking/BookingShell";
import PayOnline from "@/components/booking/PayOnline";
import { formatLongDate, todayIso } from "@/components/booking/availability";
import { NO_API_MESSAGE } from "@/lib/apiHost";
import { bookingConfigured, bookingRpc } from "@/lib/booking/rpc";
import { ApiError } from "@/lib/teeSheet/api";
import { CLUB, lookupHref } from "@/lib/nav";

interface TimeSlot {
  time: string;
  available_bays: number;
  total_bays: number;
}

interface AvailabilityResponse {
  date: string;
  bay_type: string;
  duration_hours: number;
  is_closed: boolean;
  available_slots: TimeSlot[];
  /** 슬롯이 비었을 때 그 이유. 서버가 사람이 읽을 문장으로 채워 준다. */
  reason?: string | null;
}

interface ReservationResponse {
  id: number;
  confirmation_code: string;
  bay_type: string;
  bay_number?: number;
  date: string;
  start_time: string;
  duration_hours: number;
  player_count: number;
  total_price: number;
}

/**
 * 서버 주소는 문구에 넣지 않는다. 예전엔 `${BACKEND_URL}` 을 그대로 끼워 넣어서
 * 배포된 사이트가 방문자에게 "http://localhost:8000" 을 보여줬다.
 * 연결 실패(status 0)만 "닿지 않았다" 로 쓰고, 그 외에는 함수가 보낸 문장을 그대로 쓴다.
 */
function networkMessage(err: unknown, action: string): string {
  if ((err instanceof ApiError && err.status === 0) || err instanceof TypeError) {
    return `Could not reach the booking server. ${action} Please try again in a moment, or call ${CLUB.phone}.`;
  }
  return err instanceof Error && err.message ? err.message : action;
}

export default function IndoorGolfBooking() {
  const [step, setStep] = useState(1);
  const [selectedDate, setSelectedDate] = useState("");
  const [selectedBayType, setSelectedBayType] = useState("left_right");
  const [playerCount, setPlayerCount] = useState(1);
  const [duration, setDuration] = useState(1);
  const [selectedTime, setSelectedTime] = useState("");
  const [availability, setAvailability] = useState<TimeSlot[]>([]);
  const [isLoadingAvailability, setIsLoadingAvailability] = useState(false);
  /** "슬롯이 없다"는 정상 응답에 대한 안내. 붉은 오류 배너와 구분해서 쓴다. */
  const [slotNotice, setSlotNotice] = useState("");
  /** 휴무일 안내. 단계와 무관하게 상단에 띄운다. */
  const [closedNotice, setClosedNotice] = useState("");

  // Step 3 form
  const [customerName, setCustomerName] = useState("");
  const [customerEmail, setCustomerEmail] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [notes, setNotes] = useState("");

  // Step 4 confirmation
  const [reservation, setReservation] = useState<ReservationResponse | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState("");

  /** 온라인 예약을 열 수 있는가. `null` 은 "아직 모름"(마운트 전). */
  const [bookingReady, setBookingReady] = useState<boolean | null>(null);
  const bookingOffline = bookingReady === false;

  // Set minimum date to today
  useEffect(() => {
    // 현지 날짜다. `new Date().toISOString().split("T")[0]` 은 UTC 라
    // 온타리오 저녁부터 하루 앞선 날짜를 고르게 만든다.
    setSelectedDate(todayIso());
    setBookingReady(bookingConfigured());
  }, []);

  // Fetch availability when date, bay type, or duration changes
  useEffect(() => {
    if (!selectedDate || !bookingReady) return;

    const fetchAvailability = async () => {
      setIsLoadingAvailability(true);
      setError("");
      try {
        const data = await bookingRpc<AvailabilityResponse>("pelham_sim_availability", {
          p_date: selectedDate,
          p_bay_type: selectedBayType,
          p_duration_hours: duration,
        });
        setAvailability(data.available_slots);
        // 시간을 고른 뒤 인원/시간을 바꾸면 그 슬롯이 사라질 수 있다.
        // 사라진 시간을 들고 다음 단계로 넘어가지 못하게 여기서 비운다.
        setSelectedTime((current) =>
          data.available_slots.some((slot) => slot.time === current) ? current : ""
        );
        // 슬롯이 없는 건 오류가 아니다. 휴무일인지, 그 타입 베이가 없는지,
        // 그냥 다 찼는지는 서버가 `reason` 으로 알려준다.
        setSlotNotice(data.available_slots.length === 0 ? data.reason ?? "" : "");
        // 휴무일은 날짜를 고르는 1단계에서 바로 보여야 한다. 2단계 슬롯 영역에만
        // 띄우면, 월요일을 고른 사람이 아무 경고 없이 NEXT 를 누르게 된다.
        setClosedNotice(data.is_closed ? data.reason ?? "" : "");
      } catch (err) {
        setError(networkMessage(err, "Failed to load available time slots."));
        setAvailability([]);
        setSlotNotice("");
        setClosedNotice("");
      } finally {
        setIsLoadingAvailability(false);
      }
    };

    fetchAvailability();
  }, [selectedDate, selectedBayType, duration, bookingReady]);

  const handleCreateReservation = async () => {
    if (!bookingReady) {
      setError(NO_API_MESSAGE);
      return;
    }

    setIsSubmitting(true);
    setError("");

    try {
      // 베이는 서버가 고른다. 예전에는 여기서 `/bays` 목록의 첫 번째를 무조건
      // 집었기 때문에, 우타 베이 3개 중 2개가 비어 있어도 같은 시간대 두 번째
      // 예약이 "이미 예약됨" 으로 막혔다.
      const data = await bookingRpc<ReservationResponse>("pelham_sim_reserve", {
        p: {
          bay_type: selectedBayType,
          date: selectedDate,
          start_time: selectedTime,
          duration_hours: duration,
          player_count: playerCount,
          customer_name: customerName,
          customer_email: customerEmail,
          phone: customerPhone,
          notes,
        },
      });
      setReservation(data);
      setStep(4);
    } catch (err) {
      setError(networkMessage(err, "Booking failed."));
    } finally {
      setIsSubmitting(false);
    }
  };

  /** 날짜 라벨은 현지 시간 기준으로 만든다 — `new Date("2026-09-08")` 은 UTC 자정이라
   *  UTC-5 에서 하루 전으로 찍힌다. */
  const formatDate = (dateStr: string) => (dateStr ? formatLongDate(dateStr) : "");

  // 베이는 3개, 모두 오른손·왼손 겸용이다(0009). 고를 종류가 하나뿐이다.
  const bayTypeDisplay = {
    left_right: "Right & Left Handed Bay",
  };

  // 서버(`backend/services/simulator_store.py`)의 시간당 요금과 같은 값.
  // 확정 화면의 예상 금액용이고, 청구되는 금액은 서버가 돌려주는 total_price 다.
  const bayHourlyRate: Record<keyof typeof bayTypeDisplay, number> = {
    left_right: 20,
  };

  const selectedBayLabel =
    bayTypeDisplay[selectedBayType as keyof typeof bayTypeDisplay];
  const estimatedTotal =
    (bayHourlyRate[selectedBayType as keyof typeof bayHourlyRate] ?? 20) * duration;

  // 예약 서버가 없는 배포에서는 마법사를 아예 열지 않는다. 4단계를 다 채우고
  // 마지막에 실패하는 것보다, 첫 화면에서 전화번호를 주는 편이 정직하다.
  if (bookingOffline) {
    return (
      <BookingShell subtitle="Online booking is not available here." title="Indoor Golf">
        <div className="rounded-sm border border-[#d8d1c3] bg-white p-6">
          <h2 className="mb-4 font-serif text-xl font-semibold">
            Book the simulator by phone
          </h2>
          <p className="mb-6 text-[#3d453d]">{NO_API_MESSAGE}</p>
          <div className="mb-6 rounded-sm bg-[#f7f4ed] p-4 text-sm">
            <p className="mb-1">
              <span className="font-semibold">Phone:</span>{" "}
              <a className="underline" href={CLUB.phoneHref}>
                {CLUB.phone}
              </a>
            </p>
            <p className="mb-1">
              <span className="font-semibold">Email:</span>{" "}
              <a className="underline" href={CLUB.emailHref}>
                {CLUB.email}
              </a>
            </p>
            <p className="text-[#5c6459]">
              Simulator hours: Wednesday–Sunday, 2:00 PM – 10:00 PM. Closed Monday and
              Tuesday.
            </p>
          </div>
          <a
            className="tap-target flex items-center justify-center rounded-sm bg-[#214d2f] px-6 text-base font-bold text-white transition hover:bg-[#163820]"
            href={CLUB.phoneHref}
          >
            Call {CLUB.phone}
          </a>
        </div>
      </BookingShell>
    );
  }

  return (
    <BookingShell
      subtitle="Reserve a simulator bay by the hour. Wednesday–Sunday, 2:00 PM – 10:00 PM."
      title="Indoor Golf"
    >
      {/* Progress Steps */}
      <div className="mb-8 flex justify-between">
        {[1, 2, 3, 4].map((s) => (
          <div key={s} className="flex min-w-0 flex-col items-center">
            <div
              className={`flex h-10 w-10 items-center justify-center rounded-full font-semibold ${
                s <= step
                  ? "bg-[#214d2f] text-white"
                  : "bg-[#d8d1c3] text-[#8a6f30]"
              }`}
            >
              {s}
            </div>
            <div className="mt-2 text-center text-xs font-semibold sm:text-sm">
              {s === 1 && "Choose"}
              {s === 2 && "Options"}
              {s === 3 && "Details"}
              {s === 4 && "Confirm"}
            </div>
          </div>
        ))}
      </div>

      {error && (
        <div className="mb-6 rounded-sm border border-[#e0b3b3] bg-[#fbeeee] p-4 text-[#8a2f2f]">
          <p className="font-semibold">{error}</p>
          <a className="mt-2 inline-block font-bold underline" href={CLUB.phoneHref}>
            Call {CLUB.phone}
          </a>
        </div>
      )}

      {!error && closedNotice && (
        <div className="mb-6 rounded-sm border border-[#d6c28f] bg-[#f3ead2] p-4 text-[#5c4a1c]">
          {closedNotice}
        </div>
      )}

      {/* Step 1: Choose Date & Bay Type */}
      {step === 1 && (
        <div className="rounded-sm border border-[#d8d1c3] bg-white p-5 sm:p-8">
          <h2 className="mb-6 font-serif text-2xl font-semibold">Choose a date</h2>

          <div className="mb-8">
            <label className="mb-2 block text-sm font-semibold" htmlFor="sim-date">
              Date
            </label>
            <input
              className="w-full rounded-sm border border-[#d8d1c3] px-4 py-3 text-base"
              id="sim-date"
              min={todayIso()}
              onChange={(e) => setSelectedDate(e.target.value)}
              type="date"
              value={selectedDate}
            />
          </div>

          <div className="mb-8">
            <p className="mb-3 block text-sm font-semibold">Bay</p>
            <div className="grid grid-cols-[minmax(0,1fr)] gap-2">
              {(
                Object.entries(bayTypeDisplay) as [
                  keyof typeof bayTypeDisplay,
                  string
                ][]
              ).map(([key, label]) => (
                <button
                  aria-pressed={selectedBayType === key}
                  className={`tap-target min-w-0 rounded-sm border-2 px-4 py-3 text-center text-base font-semibold transition ${
                    selectedBayType === key
                      ? "border-[#214d2f] bg-[#214d2f] text-white"
                      : "border-[#d8d1c3] bg-white text-[#182118] hover:border-[#214d2f]"
                  }`}
                  key={key}
                  onClick={() => setSelectedBayType(key)}
                  type="button"
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <button
            className="tap-target w-full rounded-sm bg-[#214d2f] py-3 text-base font-bold text-white transition hover:bg-[#163820]"
            onClick={() => setStep(2)}
            type="button"
          >
            NEXT
          </button>
        </div>
      )}

      {/* Step 2: Choose Options */}
      {step === 2 && (
        <div className="rounded-sm border border-[#d8d1c3] bg-white p-5 sm:p-8">
          <h2 className="mb-6 font-serif text-2xl font-semibold">Choose your options</h2>

          <p className="mb-6 text-sm text-[#5c6459]">
            {selectedBayLabel}. Allow approximately 1 hour per golfer to complete 18
            holes. Add 1 hour for each additional golfer.
          </p>

          {/* Date Display */}
          <div className="mb-6 rounded-sm bg-[#f7f4ed] p-4">
            <p className="text-sm font-semibold">{formatDate(selectedDate)}</p>
            <p className="text-sm text-[#5c6459]">
              {bayTypeDisplay[selectedBayType as keyof typeof bayTypeDisplay]}
            </p>
          </div>

          {/* Player Count */}
          <div className="mb-6">
            <label className="mb-2 block text-sm font-semibold" htmlFor="sim-players">
              Number of players in group
            </label>
            <select
              className="w-full rounded-sm border border-[#d8d1c3] px-4 py-3 text-base"
              id="sim-players"
              onChange={(e) => setPlayerCount(parseInt(e.target.value))}
              value={playerCount}
            >
              {[1, 2, 3, 4].map((n) => (
                <option key={n} value={n}>
                  {n} player{n > 1 ? "s" : ""}
                </option>
              ))}
            </select>
          </div>

          {/* Duration */}
          <div className="mb-6">
            <label className="mb-2 block text-sm font-semibold" htmlFor="sim-hours">
              Number of hours
            </label>
            <select
              className="w-full rounded-sm border border-[#d8d1c3] px-4 py-3 text-base"
              id="sim-hours"
              onChange={(e) => setDuration(parseInt(e.target.value))}
              value={duration}
            >
              {[1, 2, 3, 4, 5].map((h) => (
                <option key={h} value={h}>
                  {h} hour{h > 1 ? "s" : ""}
                </option>
              ))}
            </select>
          </div>

          {/* Time Slots */}
          <div className="mb-6">
            <p className="mb-3 block text-sm font-semibold">Select a time slot</p>
            {isLoadingAvailability ? (
              // 스피너 하나로 영역을 비우지 않는다. 자리를 잡아 두면 로딩이 끝나도
              // 화면이 튀지 않는다.
              <div aria-busy="true" className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                {Array.from({ length: 12 }, (_, index) => (
                  <div
                    className="h-11 animate-pulse rounded-sm border border-[#e2ddd0] bg-[#efece3]"
                    key={index}
                  />
                ))}
              </div>
            ) : availability.length === 0 ? (
              <p className="text-sm text-[#8a6f30]">
                {slotNotice || "No available time slots for this date and duration."}
              </p>
            ) : (
              // 390px 에서 4열이면 "14:15" 가 줄바꿈되어 버튼이 뭉개진다.
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                {availability.map((slot) => (
                  <button
                    className={`tap-target min-w-0 rounded-sm border px-2 text-sm font-semibold transition ${
                      selectedTime === slot.time
                        ? "border-[#214d2f] bg-[#214d2f] text-white"
                        : slot.available_bays === 0
                          ? "cursor-not-allowed border-[#e2ddd0] bg-[#efece3] text-[#a8a698]"
                          : "border-[#d8d1c3] bg-white hover:border-[#214d2f]"
                    }`}
                    disabled={slot.available_bays === 0}
                    key={slot.time}
                    onClick={() => setSelectedTime(slot.time)}
                    type="button"
                  >
                    {slot.time}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="flex gap-3">
            <button
              className="tap-target flex-1 rounded-sm border border-[#d8d1c3] py-3 text-base font-bold text-[#214d2f] transition hover:bg-[#f7f4ed]"
              onClick={() => setStep(1)}
              type="button"
            >
              BACK
            </button>
            <button
              className={`tap-target flex-1 rounded-sm py-3 text-base font-bold text-white transition ${
                selectedTime
                  ? "bg-[#214d2f] hover:bg-[#163820]"
                  : "cursor-not-allowed bg-[#a9b0a6]"
              }`}
              disabled={!selectedTime}
              onClick={() => setStep(3)}
              type="button"
            >
              NEXT
            </button>
          </div>
        </div>
      )}

      {/* Step 3: Enter Details */}
      {step === 3 && (
        <div className="rounded-sm border border-[#d8d1c3] bg-white p-5 sm:p-8">
          <h2 className="mb-6 font-serif text-2xl font-semibold">Booking information</h2>

          {/* Booking Summary */}
          <div className="mb-6 rounded-sm bg-[#f7f4ed] p-4">
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div className="min-w-0">
                <p className="font-semibold text-[#8a6f30]">Date</p>
                <p>{formatDate(selectedDate)}</p>
              </div>
              <div className="min-w-0">
                <p className="font-semibold text-[#8a6f30]">Time</p>
                <p>{selectedTime}</p>
              </div>
              <div className="min-w-0">
                <p className="font-semibold text-[#8a6f30]">Duration</p>
                <p>
                  {duration} hour{duration > 1 ? "s" : ""}
                </p>
              </div>
              <div className="min-w-0">
                <p className="font-semibold text-[#8a6f30]">Players</p>
                <p>{playerCount}</p>
              </div>
            </div>
          </div>

          {/* Contact Form */}
          <div className="mb-6">
            <label className="mb-2 block text-sm font-semibold" htmlFor="sim-name">
              Name
            </label>
            <input
              autoComplete="name"
              className="w-full rounded-sm border border-[#d8d1c3] px-4 py-3 text-base"
              id="sim-name"
              onChange={(e) => setCustomerName(e.target.value)}
              placeholder="Full name"
              type="text"
              value={customerName}
            />
          </div>

          <div className="mb-6">
            <label className="mb-2 block text-sm font-semibold" htmlFor="sim-email">
              Email
            </label>
            <input
              autoComplete="email"
              className="w-full rounded-sm border border-[#d8d1c3] px-4 py-3 text-base"
              id="sim-email"
              inputMode="email"
              onChange={(e) => setCustomerEmail(e.target.value)}
              placeholder="your@email.com"
              type="email"
              value={customerEmail}
            />
          </div>

          <div className="mb-6">
            <label className="mb-2 block text-sm font-semibold" htmlFor="sim-phone">
              Phone (Optional)
            </label>
            <input
              autoComplete="tel"
              className="w-full rounded-sm border border-[#d8d1c3] px-4 py-3 text-base"
              id="sim-phone"
              inputMode="tel"
              onChange={(e) => setCustomerPhone(e.target.value)}
              placeholder="+1 (905) 123-4567"
              type="tel"
              value={customerPhone}
            />
          </div>

          <div className="mb-6">
            <label className="mb-2 block text-sm font-semibold" htmlFor="sim-notes">
              Notes (Optional)
            </label>
            <textarea
              className="w-full rounded-sm border border-[#d8d1c3] px-4 py-3 text-base"
              id="sim-notes"
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Any special requests or notes..."
              rows={3}
              value={notes}
            />
          </div>

          <div className="flex gap-3">
            <button
              className="tap-target flex-1 rounded-sm border border-[#d8d1c3] py-3 text-base font-bold text-[#214d2f] transition hover:bg-[#f7f4ed]"
              onClick={() => setStep(2)}
              type="button"
            >
              BACK
            </button>
            <button
              className={`tap-target flex-1 rounded-sm py-3 text-base font-bold text-white transition ${
                customerName && customerEmail
                  ? "bg-[#214d2f] hover:bg-[#163820]"
                  : "cursor-not-allowed bg-[#a9b0a6]"
              }`}
              disabled={!customerName || !customerEmail}
              onClick={() => setStep(4)}
              type="button"
            >
              REVIEW
            </button>
          </div>
        </div>
      )}

      {/* Step 4: Confirm */}
      {step === 4 && !reservation && (
        <div className="rounded-sm border border-[#d8d1c3] bg-white p-5 sm:p-8">
          <h2 className="mb-6 font-serif text-2xl font-semibold">Confirm your booking</h2>

          {/* Booking Summary */}
          <div className="mb-6 rounded-sm bg-[#f7f4ed] p-4">
            <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2 text-sm">
              <p className="font-semibold text-[#8a6f30]">
                {bayTypeDisplay[selectedBayType as keyof typeof bayTypeDisplay]}
              </p>
              <p className="font-semibold text-[#214d2f]">${estimatedTotal.toFixed(2)}</p>
            </div>

            <div className="border-t border-[#d8d1c3] pt-4 text-sm">
              <p>
                <span className="font-semibold">Date:</span> {formatDate(selectedDate)}
              </p>
              <p>
                <span className="font-semibold">Time:</span> {selectedTime} ({duration}{" "}
                hour{duration > 1 ? "s" : ""})
              </p>
              <p>
                <span className="font-semibold">Players:</span> {playerCount}
              </p>
            </div>

            <div className="mt-4 border-t border-[#d8d1c3] pt-4">
              <p className="break-words text-sm">
                <span className="font-semibold">Name:</span> {customerName}
              </p>
              <p className="break-words text-sm">
                <span className="font-semibold">Email:</span> {customerEmail}
              </p>
              {customerPhone && (
                <p className="text-sm">
                  <span className="font-semibold">Phone:</span> {customerPhone}
                </p>
              )}
            </div>
          </div>

          {/* Booking Policies */}
          <div className="mb-6 text-sm text-[#5c6459]">
            <ul className="list-disc space-y-2 pl-5">
              {/* 결제는 선택이다: 확정 화면의 Pay now(Authorize.net, 0020) 또는 와서 프런트에서 계산서로(0008). */}
              <li className="font-semibold text-[#214d2f]">
                Pay online after you book, or at the front desk when you arrive.
              </li>
              {/* 시스템이 실제로 지키는 규칙만 적는다: 온라인·전화·문자 변경·취소는 시작 24시간
                  전까지(0012·0016). 수수료 규칙은 시스템에 없으므로 적지 않는다. */}
              <li>
                Change or cancel online, by phone or by text up to 24 hours before your
                start time. After that, please call the pro shop.
              </li>
              <li>
                Please bring indoor or CLEAN golf shoes for simulators. Dirty Shoes will
                not be allowed in the simulators
              </li>
            </ul>
          </div>

          <div className="flex flex-col gap-3 sm:flex-row">
            <button
              className="tap-target flex-1 rounded-sm border border-[#d8d1c3] py-3 text-base font-bold text-[#214d2f] transition hover:bg-[#f7f4ed]"
              onClick={() => setStep(3)}
              type="button"
            >
              BACK
            </button>
            <button
              className={`tap-target flex-1 rounded-sm py-3 text-base font-bold text-white transition ${
                isSubmitting
                  ? "cursor-not-allowed bg-[#a9b0a6]"
                  : "bg-[#214d2f] hover:bg-[#163820]"
              }`}
              disabled={isSubmitting}
              onClick={handleCreateReservation}
              type="button"
            >
              {isSubmitting ? "BOOKING..." : "CONFIRM AND RESERVE"}
            </button>
          </div>
        </div>
      )}

      {/* Step 4: Confirmation */}
      {reservation && (
        <div className="rounded-sm border border-[#d8d1c3] bg-white p-5 text-center sm:p-8">
          <div className="mb-6">
            <div aria-hidden className="mb-4 text-5xl text-[#214d2f]">
              ✓
            </div>
            <h2 className="font-serif text-2xl font-semibold text-[#214d2f] sm:text-3xl">
              Your booking is confirmed
            </h2>
          </div>

          <div className="mb-8 rounded-sm bg-[#f7f4ed] p-5 sm:p-6">
            <p className="mb-4 text-sm text-[#5c6459]">
              {bayTypeDisplay[selectedBayType as keyof typeof bayTypeDisplay]} on{" "}
              {formatDate(selectedDate)}
            </p>

            <div className="mb-4 grid grid-cols-2 gap-4 text-sm">
              <div className="min-w-0">
                <p className="font-semibold text-[#8a6f30]">{reservation.start_time}</p>
                <p className="text-[#5c6459]">
                  {reservation.duration_hours} hour
                  {reservation.duration_hours > 1 ? "s" : ""}
                </p>
              </div>
              <div className="min-w-0">
                <p className="font-semibold text-[#214d2f]">
                  ${reservation.total_price.toFixed(2)}
                </p>
                <p className="text-xs text-[#5c6459]">+ HST · pay online or on arrival</p>
                <p className="text-[#5c6459]">
                  {reservation.player_count} player
                  {reservation.player_count > 1 ? "s" : ""}
                </p>
              </div>
            </div>

            <div className="border-t border-[#d8d1c3] pt-4">
              <p className="mb-2 text-sm">
                <span className="font-semibold">Confirmation Code:</span>
              </p>
              <p className="break-all text-2xl font-bold tracking-widest text-[#214d2f]">
                {reservation.confirmation_code}
              </p>
            </div>
          </div>

          {/* 확정 메일은 지금 나가지 않는다 — 메일 발송은 멈춘 FastAPI 서버(SMTP)에 있었다.
              보내지 않은 메일을 보냈다고 쓰지 않는다. */}
          <p className="mb-4 break-words text-sm text-[#5c6459]">
            Save or screenshot this code. With it and your email you can change or cancel online up to 24 hours before your start time.
          </p>

          <p className="mb-6 text-sm text-[#5c6459]">
            Please arrive 15 minutes early. Contact {CLUB.email} or call {CLUB.phone} with
            any questions.
          </p>

          <PayOnline creds={{ code: reservation.confirmation_code, email: customerEmail }} />

          {/* 확인 코드로 다시 찾아볼 수 있는 자리를 준다. */}
          <a
            className="tap-target mt-5 flex items-center justify-center rounded-sm bg-[#214d2f] px-6 text-base font-bold text-white transition hover:bg-[#163820]"
            href={lookupHref(reservation.confirmation_code)}
          >
            View or change this booking
          </a>
        </div>
      )}
    </BookingShell>
  );
}
