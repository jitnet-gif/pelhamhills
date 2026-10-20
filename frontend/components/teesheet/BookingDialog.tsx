"use client";

// 새 예약 생성 다이얼로그. 쓰기는 전부 controller.createBooking을 통해서만 한다.
// (fetch/teeSheetApi를 직접 호출하지 않는다.)

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import { greenFeeFor } from "@/lib/greenFee";
import { money } from "@/lib/teeSheet/dates";
import { useSlotLocks } from "@/hooks/useSlotLocks";
import { isSlotLocked } from "@/lib/teeSheet/sun";
import type { PlayerType, TeeSheetController } from "@/lib/teeSheet/types";

import { MemberSuggestions, memberSummary, useMemberSearch, type MemberHit } from "./MemberSearch";

export type BookingDialogProps = {
  open: boolean;
  controller: TeeSheetController;
  initial?: { date?: string; time?: string };
  onClose: () => void;
};

type PlayerDraft = {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  type: PlayerType;
  ratePlan: string;
  /** 자동검색으로 고른 사람이면 true. 이름을 다시 고치면 연결이 풀린다. */
  linked: boolean;
  customerRef: string;
  memberNumber: string;
  /** 연결 표시줄 문구, 예: "Full 2026 · #1234". */
  memberLabel: string;
};

const PLAYER_TYPES: PlayerType[] = ["Existing Customer", "Guest"];

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

const FIELD =
  "w-full border border-[#d4d4d8] bg-white px-2 py-1.5 text-xs outline-none focus:border-[#4533ff] disabled:bg-[#f2f2f4] disabled:text-[#9aa0a6]";
const LABEL = "block text-[11px] font-bold uppercase tracking-wide text-[#4e5560]";

function emptyPlayer(): PlayerDraft {
  return {
    firstName: "",
    lastName: "",
    email: "",
    phone: "",
    type: "Existing Customer",
    ratePlan: "",
    linked: false,
    customerRef: "",
    memberNumber: "",
    memberLabel: "",
  };
}

/**
 * 한 티타임의 기본 좌석 수. 백엔드의 PLAYERS_PER_TEE_TIME 과 같은 값이어야 한다.
 *
 * 내보내는 이유: 티 시트 페이지의 Add 버튼도 "자리가 남은 첫 타임"을 찾을 때 이
 * 값을 본다. 손님 화면에도 같은 상수가 있지만(`components/booking/availability.ts`)
 * 그쪽은 일부러 어드민과 분리해 둔 모듈이라 가져다 쓰지 않는다.
 */
export const STANDARD_SEATS_PER_TEE_TIME = 4;

/**
 * 직원이 한 티타임에 넣을 수 있는 최대 인원 = 기본 4 + 추가 4. 백엔드의
 * STAFF_PLAYERS_PER_TEE_TIME(0052 도 같다)과 같은 값이어야 한다. 손님 길은 여전히 4자리.
 */
export const SEATS_PER_TEE_TIME = 8;

/**
 * 해당 날짜의 "티타임별로 이미 찬 좌석 수". 취소된 예약은 좌석을 잡지 않는다.
 *
 * 예전에는 시각의 Set 이었다 — 한 티타임에 예약이 하나라도 있으면 통째로 막았다.
 * 하지만 티타임은 예약 단위가 아니라 **좌석 4개 단위**다 (Chronogolf 도 그렇고,
 * 백엔드의 require_tee_time_capacity 도 그렇다). 2인 멤버 그룹이 잡힌 7:43 에
 * 2인 온라인 예약이 더 붙는 것은 정상이므로, 남은 좌석으로 판정해야 한다.
 */
function seatsTakenFor(
  bookings: TeeSheetController["bookings"],
  date: string,
): Map<string, number> {
  const seats = new Map<string, number>();
  for (const booking of bookings) {
    if (booking.date !== date) continue;
    if (booking.status === "cancelled") continue;
    seats.set(booking.time, (seats.get(booking.time) ?? 0) + booking.players.length);
  }
  return seats;
}

/** 그 티타임에 아직 남은 좌석 수 (0 이면 꽉 참). */
function seatsFree(seats: Map<string, number>, time: string): number {
  return Math.max(0, SEATS_PER_TEE_TIME - (seats.get(time) ?? 0));
}

export default function BookingDialog({ open, controller, initial, onClose }: BookingDialogProps) {
  const initialDate = initial?.date;
  const initialTime = initial?.time;

  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  // 잠긴 칸(일출 전·일몰 2시간 전 이후·직원 블록)은 고를 수 없다. 격자에서 이미 막혀 여기로 오지 않는다.
  const { locks } = useSlotLocks(date ? [date] : []);
  const [holes, setHoles] = useState<9 | 18>(18);
  const [rateInput, setRateInput] = useState("");
  const [rateTouched, setRateTouched] = useState(false);
  const [cartCount, setCartCount] = useState(0);
  const [title, setTitle] = useState("");
  const [titleTouched, setTitleTouched] = useState(false);
  const [notes, setNotes] = useState("");
  const [players, setPlayers] = useState<PlayerDraft[]>([emptyPlayer()]);

  // 회원 자동검색: 지금 이름 칸에 커서가 있는 줄 하나만 찾는다. 이미 고른 줄은 다시 찾지 않는다.
  const [searchRow, setSearchRow] = useState<number | null>(null);
  const [activeHit, setActiveHit] = useState(0);
  const searchPlayer = searchRow === null ? null : (players[searchRow] ?? null);
  const { hits, loading: searching } = useMemberSearch(
    searchPlayer ? `${searchPlayer.firstName} ${searchPlayer.lastName}` : "",
    searchPlayer !== null && !searchPlayer.linked,
  );
  const searchOpen = searchRow !== null && hits.length > 0;
  // Escape 는 문서 단계에서 창을 닫으므로, 목록이 열려 있으면 목록만 닫게 ref 로 알려 준다.
  const searchOpenRef = useRef(false);
  useEffect(() => {
    searchOpenRef.current = searchOpen;
  });
  // 결과가 줄어 커서가 목록 밖이면 첫 줄로.
  const activeIndex = activeHit < hits.length ? activeHit : 0;

  const panelRef = useRef<HTMLDivElement | null>(null);
  const firstFieldRef = useRef<HTMLInputElement | null>(null);
  const seededRef = useRef(false);
  // onClose는 페이지에서 인라인 화살표로 넘어오기 쉬우므로 ref로 잡아 effect가 재실행되지 않게 한다.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  const { bookings, busy, focusedDate, slots } = controller;

  // ----- open이 false -> true로 바뀌는 순간에만 폼을 시드한다 (실패 후 입력 보존) -----
  useEffect(() => {
    if (!open) {
      seededRef.current = false;
      return;
    }
    if (seededRef.current) return;
    seededRef.current = true;

    const seedDate = initialDate ?? focusedDate;
    setDate(seedDate);
    // WeekGrid가 이미 꽉 찬 슬롯을 넘겨줄 수도 있으므로 시드 단계에서 걸러낸다.
    const seats = seatsTakenFor(bookings, seedDate);
    setTime(initialTime && seatsFree(seats, initialTime) > 0 ? initialTime : "");
    setHoles(18);
    setRateInput("");
    setRateTouched(false);
    setCartCount(0);
    setTitle("");
    setTitleTouched(false);
    setNotes("");
    setPlayers([emptyPlayer()]);

    // controller.slots는 focusedDate 기준으로 로드되므로, 요금/슬롯 목록이
    // 다이얼로그의 날짜와 항상 같은 날을 가리키도록 시트를 그 날짜로 이동시킨다.
    if (seedDate !== focusedDate) controller.setFocusedDate(seedDate);
  }, [open, initialDate, initialTime, focusedDate, bookings, controller]);

  // ----- 모달 동작: Escape, 포커스 이동/트랩, 포커스 복원, 배경 스크롤 잠금 -----
  useEffect(() => {
    if (!open) return;

    const opener = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const focusTimer = window.setTimeout(() => firstFieldRef.current?.focus(), 0);

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        if (searchOpenRef.current) {
          setSearchRow(null);
          return;
        }
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;

      const root = panelRef.current;
      if (!root) return;
      const focusable = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (element) => element.offsetParent !== null || element === document.activeElement,
      );
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement | null;
      const inside = active !== null && root.contains(active);

      if (event.shiftKey && (!inside || active === first)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (!inside || active === last)) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
      window.clearTimeout(focusTimer);
      document.body.style.overflow = previousOverflow;
      opener?.focus?.();
    };
  }, [open]);

  const seatsTaken = useMemo(() => seatsTakenFor(bookings, date), [bookings, date]);

  const selectedSlot = useMemo(() => slots.find((slot) => slot.time === time) ?? null, [slots, time]);

  // 요금은 선택한 슬롯과 홀 수에서 파생된다 — 사용자가 직접 고친 뒤에는 입력값을 그대로 쓴다.
  const rate = rateTouched ? rateInput : selectedSlot ? greenFeeFor(selectedSlot, holes).toFixed(2) : "";

  const autoTitle = useMemo(() => {
    const lead = players[0];
    if (!lead) return "";
    return [lead.lastName.trim(), lead.firstName.trim()].filter(Boolean).join(", ");
  }, [players]);

  const resolvedTitle = titleTouched ? title : autoTitle;

  function updatePlayer(index: number, patch: Partial<PlayerDraft>) {
    setPlayers((current) => current.map((player, i) => (i === index ? { ...player, ...patch } : player)));
  }

  function addPlayer() {
    setPlayers((current) => (current.length >= SEATS_PER_TEE_TIME ? current : [...current, emptyPlayer()]));
  }

  function removePlayer(index: number) {
    setPlayers((current) => (current.length <= 1 ? current : current.filter((_, i) => i !== index)));
    setSearchRow(null);
  }

  /** 이름을 고친다. 회원을 골라 둔 줄이면 연결과 그 회원 요금제를 같이 푼다 — 다른 사람에게 회원가가 붙지 않게. */
  function updateName(index: number, patch: Pick<Partial<PlayerDraft>, "firstName" | "lastName">) {
    const player = players[index];
    const unlink = player?.linked
      ? { linked: false, customerRef: "", memberNumber: "", memberLabel: "", ratePlan: "" }
      : {};
    updatePlayer(index, { ...patch, ...unlink });
    setSearchRow(index);
    setActiveHit(0);
  }

  /** 자동검색에서 고른 사람으로 그 줄을 채운다. 회원권이 있으면 요금제도 회원 요금제로. */
  function pickMember(index: number, hit: MemberHit) {
    updatePlayer(index, {
      firstName: hit.firstName || hit.name,
      lastName: hit.lastName,
      email: hit.email,
      phone: hit.phone,
      type: "Existing Customer",
      ratePlan: hit.ratePlan,
      linked: true,
      customerRef: hit.customerRef ?? "",
      memberNumber: hit.memberNumber,
      memberLabel: memberSummary(hit) || "Customer",
    });
    setSearchRow(null);
  }

  function unlinkMember(index: number) {
    updatePlayer(index, { linked: false, customerRef: "", memberNumber: "", memberLabel: "", ratePlan: "" });
  }

  /** 이름 칸의 ↑↓ Enter. Enter 는 목록이 열려 있으면 폼 제출 대신 고르기다. */
  function handleNameKeyDown(index: number, event: ReactKeyboardEvent<HTMLInputElement>) {
    if (searchRow !== index || hits.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveHit((activeIndex + 1) % hits.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveHit((activeIndex - 1 + hits.length) % hits.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const hit = hits[activeIndex];
      if (hit) pickMember(index, hit);
    }
  }

  function handleDateChange(next: string) {
    if (!next) return;
    setDate(next);
    // 새 날짜의 슬롯을 다시 골라야 한다 (요금/중복 판정이 같은 날짜를 보게).
    setTime("");
    setRateTouched(false);
    if (next !== focusedDate) controller.setFocusedDate(next);
  }

  const rateValue = Number(rate);
  const playersValid =
    players.length >= 1 &&
    players.length <= SEATS_PER_TEE_TIME &&
    players.every((player) => player.firstName.trim() !== "" || player.lastName.trim() !== "");
  // 남은 좌석 판정은 인원 수에 달려 있다 — 1인은 들어가지만 3인은 못 들어가는 티타임이 있다.
  const freeSeats = time === "" ? SEATS_PER_TEE_TIME : seatsFree(seatsTaken, time);
  const timeValid = time !== "" && selectedSlot !== null && players.length <= freeSeats;
  const canSubmit =
    !busy &&
    date !== "" &&
    timeValid &&
    resolvedTitle.trim() !== "" &&
    rate.trim() !== "" &&
    Number.isFinite(rateValue) &&
    rateValue >= 0 &&
    playersValid;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;

    const created = await controller.createBooking({
      date,
      time,
      title: resolvedTitle.trim(),
      holes,
      rate: rateValue,
      cartCount,
      notes: notes.trim(),
      players: players.map((player) => ({
        firstName: player.firstName.trim(),
        lastName: player.lastName.trim(),
        email: player.email.trim(),
        phone: player.phone.trim(),
        type: player.type,
        ratePlan: player.ratePlan.trim(),
        ...(player.linked && player.customerRef ? { customerRef: player.customerRef } : {}),
        ...(player.linked && player.memberNumber ? { memberNumber: player.memberNumber } : {}),
      })),
    });

    // controller는 절대 throw하지 않는다. null이면 자체 에러 토스트를 이미 띄웠고,
    // 여기서는 입력을 그대로 둔 채 다이얼로그를 열어 둔다.
    if (created) onClose();
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        aria-labelledby="booking-dialog-title"
        aria-modal="true"
        className="my-6 w-full max-w-3xl rounded border border-[#d4d4d8] bg-white shadow-lg"
        ref={panelRef}
        role="dialog"
      >
        <form onSubmit={handleSubmit}>
          <div className="flex items-center justify-between border-b border-[#d4d4d8] px-4 py-3">
            <h2 className="text-sm font-bold" id="booking-dialog-title">
              New Reservation
            </h2>
            <button
              aria-label="Close dialog"
              className="px-2 text-lg leading-none text-[#6b7280] hover:text-[#1f2328]"
              onClick={onClose}
              type="button"
            >
              ×
            </button>
          </div>

          <div className="grid gap-4 px-4 py-4">
            {/* ===== 예약 정보 ===== */}
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <label className="grid gap-1">
                <span className={LABEL}>Date</span>
                <input
                  className={FIELD}
                  onChange={(event) => handleDateChange(event.target.value)}
                  ref={firstFieldRef}
                  required
                  type="date"
                  value={date}
                />
              </label>

              <label className="grid gap-1">
                <span className={LABEL}>Tee time</span>
                <select
                  className={FIELD}
                  disabled={slots.length === 0}
                  onChange={(event) => {
                    setTime(event.target.value);
                    setRateTouched(false);
                  }}
                  required
                  value={time}
                >
                  {slots.length === 0 ? (
                    <option value="">No tee times loaded</option>
                  ) : (
                    <>
                      <option value="">Select a tee time…</option>
                      {slots.map((slot) => {
                        // 꽉 찬 슬롯만 비활성화한다. 일부만 찬 슬롯은 남은 좌석을 알려 주고
                        // 고를 수 있게 둔다 — 그것이 분할 예약이 생기는 정상 경로다.
                        const free = seatsFree(seatsTaken, slot.time);
                        const dark = isSlotLocked(date, slot.minutes, locks);
                        return (
                          <option disabled={free === 0 || dark} key={slot.time} value={slot.time}>
                            {dark ? "🔒 " : ""}
                            {slot.time} · {money(slot.rate)}
                            {dark
                              ? " · locked"
                              : free === 0
                              ? " · full"
                              : free <= SEATS_PER_TEE_TIME - STANDARD_SEATS_PER_TEE_TIME
                                ? ` · 4 full · +${free} extra`
                                : free < SEATS_PER_TEE_TIME
                                  ? ` · ${free - (SEATS_PER_TEE_TIME - STANDARD_SEATS_PER_TEE_TIME)} of ${STANDARD_SEATS_PER_TEE_TIME} seats left`
                                  : ""}
                          </option>
                        );
                      })}
                    </>
                  )}
                </select>
              </label>

              <label className="grid gap-1">
                <span className={LABEL}>Holes</span>
                <select
                  className={FIELD}
                  onChange={(event) => setHoles(Number(event.target.value) === 9 ? 9 : 18)}
                  value={holes}
                >
                  <option value={9}>9 holes</option>
                  <option value={18}>18 holes</option>
                </select>
              </label>

              <label className="grid gap-1">
                <span className={LABEL}>Rate</span>
                <input
                  className={FIELD}
                  inputMode="decimal"
                  min="0"
                  onChange={(event) => {
                    setRateInput(event.target.value);
                    setRateTouched(true);
                  }}
                  step="0.01"
                  type="number"
                  value={rate}
                />
              </label>

              <label className="grid gap-1">
                <span className={LABEL}>Carts</span>
                <select
                  className={FIELD}
                  onChange={(event) => setCartCount(Number(event.target.value))}
                  value={cartCount}
                >
                  {[0, 1, 2, 3, 4].map((count) => (
                    <option key={count} value={count}>
                      {count}
                    </option>
                  ))}
                </select>
              </label>

              <label className="grid gap-1 sm:col-span-2 lg:col-span-3">
                <span className={LABEL}>Title</span>
                <input
                  className={FIELD}
                  onChange={(event) => {
                    setTitle(event.target.value);
                    setTitleTouched(true);
                  }}
                  placeholder="Last, First"
                  type="text"
                  value={resolvedTitle}
                />
              </label>
            </div>

            <label className="grid gap-1">
              <span className={LABEL}>Notes</span>
              <textarea
                className={`${FIELD} min-h-[56px] resize-y`}
                onChange={(event) => setNotes(event.target.value)}
                value={notes}
              />
            </label>

            {/* ===== 플레이어 (1–4명, 직원은 4명 더 = 최대 8명) ===== */}
            <div className="grid gap-2">
              <div className="flex items-center justify-between">
                <span className={LABEL}>
                  Players ({Math.min(players.length, STANDARD_SEATS_PER_TEE_TIME)}/{STANDARD_SEATS_PER_TEE_TIME}
                  {players.length > STANDARD_SEATS_PER_TEE_TIME
                    ? ` +${players.length - STANDARD_SEATS_PER_TEE_TIME} extra`
                    : ""}
                  )
                </span>
                <button
                  className="border border-[#d4d4d8] bg-white px-2 py-1 text-xs font-bold hover:bg-[#f2f2f4] disabled:opacity-40"
                  disabled={players.length >= SEATS_PER_TEE_TIME}
                  onClick={addPlayer}
                  type="button"
                >
                  Add player +
                </button>
              </div>

              {players.map((player, index) => (
                <div className="relative grid gap-2 rounded border border-[#ececf0] p-2 lg:grid-cols-6" key={index}>
                  <input
                    aria-autocomplete="list"
                    aria-controls={`member-search-${index}`}
                    aria-expanded={searchOpen && searchRow === index}
                    aria-label={`Player ${index + 1} first name`}
                    autoComplete="off"
                    className={FIELD}
                    onBlur={() => setSearchRow(null)}
                    onChange={(event) => updateName(index, { firstName: event.target.value })}
                    onFocus={() => setSearchRow(index)}
                    onKeyDown={(event) => handleNameKeyDown(index, event)}
                    placeholder="First name — type to search members"
                    role="combobox"
                    type="text"
                    value={player.firstName}
                  />
                  <input
                    aria-autocomplete="list"
                    aria-controls={`member-search-${index}`}
                    aria-expanded={searchOpen && searchRow === index}
                    aria-label={`Player ${index + 1} last name`}
                    autoComplete="off"
                    className={FIELD}
                    onBlur={() => setSearchRow(null)}
                    onChange={(event) => updateName(index, { lastName: event.target.value })}
                    onFocus={() => setSearchRow(index)}
                    onKeyDown={(event) => handleNameKeyDown(index, event)}
                    placeholder="Last name"
                    role="combobox"
                    type="text"
                    value={player.lastName}
                  />
                  <input
                    aria-label={`Player ${index + 1} email`}
                    className={FIELD}
                    onChange={(event) => updatePlayer(index, { email: event.target.value })}
                    placeholder="Email"
                    type="email"
                    value={player.email}
                  />
                  <input
                    aria-label={`Player ${index + 1} phone`}
                    className={FIELD}
                    onChange={(event) => updatePlayer(index, { phone: event.target.value })}
                    placeholder="Phone"
                    type="tel"
                    value={player.phone}
                  />
                  <select
                    aria-label={`Player ${index + 1} type`}
                    className={FIELD}
                    onChange={(event) =>
                      updatePlayer(index, { type: event.target.value as PlayerType })
                    }
                    value={player.type}
                  >
                    {PLAYER_TYPES.map((type) => (
                      <option key={type} value={type}>
                        {type}
                      </option>
                    ))}
                  </select>
                  <div className="flex gap-2">
                    <input
                      aria-label={`Player ${index + 1} rate plan`}
                      className={FIELD}
                      onChange={(event) => updatePlayer(index, { ratePlan: event.target.value })}
                      placeholder="Rate plan"
                      type="text"
                      value={player.ratePlan}
                    />
                    <button
                      aria-label={`Remove player ${index + 1}`}
                      className="shrink-0 border border-[#d4d4d8] bg-white px-2 text-xs font-bold text-[#8a3f26] hover:bg-[#f2f2f4] disabled:opacity-30"
                      disabled={players.length <= 1}
                      onClick={() => removePlayer(index)}
                      type="button"
                    >
                      ×
                    </button>
                  </div>
                  {player.linked ? (
                    <div className="flex items-center gap-2 text-[11px] font-semibold text-[#2f7d4f] lg:col-span-6">
                      <span>✓ Linked: {player.memberLabel}</span>
                      {player.ratePlan ? <span className="text-[#4e5560]">· {player.ratePlan}</span> : null}
                      <button
                        className="ml-auto text-[#6b7280] underline hover:text-[#1f2328]"
                        onClick={() => unlinkMember(index)}
                        type="button"
                      >
                        Unlink
                      </button>
                    </div>
                  ) : null}
                  {searchRow === index ? (
                    <MemberSuggestions
                      active={activeIndex}
                      hits={hits}
                      id={`member-search-${index}`}
                      loading={searching}
                      onHover={setActiveHit}
                      onPick={(hit) => pickMember(index, hit)}
                    />
                  ) : null}
                </div>
              ))}
            </div>

            {time !== "" && players.length > freeSeats ? (
              <p className="text-xs font-semibold text-[#8a3f26]">
                {freeSeats === 0
                  ? `${time} is full — all ${SEATS_PER_TEE_TIME} seats (4 + 4 extra) are taken. Pick another tee time.`
                  : `${time} has only ${freeSeats} of ${SEATS_PER_TEE_TIME} seats (4 + 4 extra) left, but you are booking ${players.length} players. Remove a player or pick another tee time.`}
              </p>
            ) : null}
          </div>

          <div className="flex items-center justify-end gap-2 border-t border-[#d4d4d8] px-4 py-3">
            <button
              className="border border-[#d7d7dc] bg-white px-4 py-1.5 text-xs font-bold hover:bg-[#f2f2f4]"
              onClick={onClose}
              type="button"
            >
              Cancel
            </button>
            <button
              className="bg-[#4533ff] px-5 py-1.5 text-xs font-bold text-white disabled:opacity-50"
              disabled={!canSubmit}
              type="submit"
            >
              {busy ? "Saving…" : "Create reservation"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
