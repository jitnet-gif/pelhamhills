"use client";

/**
 * 손님 티타임 목록 — GolfNow 처럼 시간대별 카드.
 *
 * 카드 한 장에 시간 · 1인 그린피(세전) · 홀 수 · 잡을 수 있는 인원이 다 보인다. 손님은 시간을
 * 누르기 전에 가격을 안다. 값은 전부 `pelham_tee_availability` 가 이미 보내 주는 것이다
 * (rate · rate9 · nineFrom · twilight · remaining). 해 뜨기 전·진 뒤의 칸은 0048 이 목록에서 뺀다.
 *
 * 묶음 경계: 오전 11시, 오후 2시. 2시는 트와일라잇 요금(0041)이 시작되는 시각이라
 * Afternoon 카드는 모두 트와일라잇 가격이다.
 */

import type { OpenTeeTime } from "@/components/booking/availability";
import { nineHolesOpen } from "@/lib/greenFee";

const GROUPS = [
  { key: "morning", label: "Morning", hint: "Before 11 AM", from: 0, until: 11 * 60 },
  { key: "midday", label: "Mid-day", hint: "11 AM – 2 PM", from: 11 * 60, until: 14 * 60 },
  { key: "afternoon", label: "Afternoon", hint: "From 2 PM · twilight", from: 14 * 60, until: 24 * 60 },
] as const;

export function TeeTimeGroups({
  onPick,
  party,
  slots,
}: {
  onPick: (slot: OpenTeeTime) => void;
  party: number;
  slots: OpenTeeTime[];
}) {
  // 꽉 찬 시간은 보여 주지 않는다 — 누를 수 없는 카드가 줄을 채우면 열린 시간이 묻힌다.
  const open = slots.filter((slot) => slot.remaining > 0);
  return (
    <div className="space-y-8">
      {GROUPS.map((group) => {
        const list = open.filter((slot) => slot.minutes >= group.from && slot.minutes < group.until);
        if (list.length === 0) return null;
        return (
          <section aria-labelledby={`tt-group-${group.key}`} className="min-w-0" key={group.key}>
            <h3 className="flex flex-wrap items-baseline gap-x-2 font-serif text-lg font-semibold" id={`tt-group-${group.key}`}>
              {group.label} Tee Times
              <span className="font-sans text-xs font-normal text-[#5c6459]">{group.hint}</span>
            </h3>
            <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
              {list.map((slot) => (
                <TeeTimeCard key={slot.time} onPick={onPick} party={party} slot={slot} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function TeeTimeCard({
  onPick,
  party,
  slot,
}: {
  onPick: (slot: OpenTeeTime) => void;
  party: number;
  slot: OpenTeeTime;
}) {
  const short = slot.remaining < party;
  const [clock, meridiem] = slot.time.split(" ");
  const [dollars, cents] = slot.rate.toFixed(2).split(".");
  const nine = nineHolesOpen(slot);
  const golfers = slot.remaining === 1 ? "1" : `1-${slot.remaining}`;
  return (
    <button
      aria-label={`${slot.time}, $${slot.rate.toFixed(2)} per golfer, ${slot.remaining} spot${slot.remaining === 1 ? "" : "s"} left`}
      className={`min-w-0 overflow-hidden rounded-md border text-center shadow-sm transition ${
        short
          ? "cursor-not-allowed border-[#e2ddd0] bg-[#efece3] opacity-60 grayscale"
          : "border-[#d8d1c3] bg-white hover:-translate-y-0.5 hover:border-[#214d2f] hover:shadow-md"
      }`}
      disabled={short}
      onClick={() => onPick(slot)}
      type="button"
    >
      <span className="block bg-[#214d2f] py-2 text-base font-bold text-white">
        {clock}
        <sup className="ml-0.5 text-[10px] font-semibold">{meridiem}</sup>
      </span>
      <span className="block px-1 pb-3 pt-2">
        <span className="block text-2xl font-bold leading-tight text-[#182118]">
          ${dollars}
          <sup className="ml-0.5 text-xs font-semibold">{cents}</sup>
        </span>
        <span className="block text-xs text-[#5c6459]">
          {slot.twilight ? <span className="font-bold text-[#8a6f30]">Twilight · </span> : null}
          18 Holes
        </span>
        <span className="mt-1 flex items-center justify-center gap-1 text-xs text-[#3d453d]">
          <FlagIcon />
          {nine ? "18·9" : "18"}
          <span aria-hidden>/</span>
          <GolfersIcon />
          {golfers}
        </span>
      </span>
    </button>
  );
}

function FlagIcon() {
  return (
    <svg aria-hidden className="h-3 w-3 fill-current" viewBox="0 0 16 16">
      <path d="M4 1h1.4v14H4zM5.4 1.5l7 2.8-7 2.8z" />
    </svg>
  );
}

function GolfersIcon() {
  return (
    <svg aria-hidden className="h-3 w-3 fill-current" viewBox="0 0 16 16">
      <circle cx="5.5" cy="5" r="2.3" />
      <circle cx="11" cy="5.5" r="2" />
      <path d="M1 13c0-2.6 2-4.4 4.5-4.4S10 10.4 10 13zM10.6 13c0-1.6-.5-2.9-1.5-3.8.6-.3 1.2-.5 1.9-.5 2.2 0 3.9 1.6 3.9 4.3z" />
    </svg>
  );
}
