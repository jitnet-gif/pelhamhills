"use client";

// 티 시트 그리드. 예약 막대는 절대 좌표(px)가 아니라 실제 CSS grid 자식으로
// `gridColumn` / `gridRow`에 배치된다 — 컬럼 폭이나 행 높이가 뷰포트에 따라
// 변해도 정렬이 구조적으로 유지된다. 매직 픽셀 오프셋은 하나도 없다.
//
// 이 파일은 성격이 다른 두 화면을 담는다. 훅(useMemo 캐스케이드)은 공유하고
// 본문 JSX만 갈라진다 — 훅을 조건부로 부를 수 없기 때문이다.
//
//   * 주간 뷰(week): 컬럼 = 날짜, 셀 하나 = 예약 막대(BookingBar). 예약 단위 색
//     `booking.color` 가 COLOR_CLASS 로 그대로 쓰인다.
//   * 일간 시트(day): Chronogolf/pelhamhills 관리자 시트의 복제.
//     구조가 **행 → 세그먼트 → 셀** 3단계라는 점이 핵심이고, 이걸 2단계로
//     접으면 화면이 틀린다.
//       - 행(row)      = 티타임 하나. 트랙: Time | Rate | 플레이어 4칸 | Cart | Timer.
//       - 세그먼트     = 예약 하나. players.length 만큼의 플레이어 칸을 span 하고,
//         **예약 단위 크롬**(9홀 배지 · 메모 아이콘 · 선택 링 · 클릭 타깃)을 소유한다.
//       - 셀(cell)     = 세그먼트 안의 플레이어 하나. 이름과 **플레이어 단위 배경톤**을
//         소유한다. 그래서 분홍 그룹 안에 마젠타 플레이어 한 명이 섞일 수 있다.
//     한 행에 예약이 둘일 수 있다 — 백엔드가 합계 4명 이하면 같은 티타임 공유를
//     허용한다. 세그먼트는 좌→우로 깔리고 남는 칸은 기존 `+` 생성 버튼이 채운다.

import { Fragment, useCallback, useMemo, useState } from "react";
import type { CSSProperties, DragEvent } from "react";

import {
  columnLabel,
  dayIndexIn,
  isWeekend,
  longDate,
  minutesToTime,
  money,
  timeToMinutes,
  toDate,
  todayIso,
} from "@/lib/teeSheet/dates";
import { dayTypeLabel, useRateDays } from "@/hooks/useRateDays";
import { GUEST_NAME, TONE_CLASS, isDeadPlayer, playerLabel, playerTone } from "@/lib/teeSheet/tone";
import type {
  BookingColor,
  BookingStatus,
  TeeBooking,
  TeeSheetController,
  TeeSlot,
} from "@/lib/teeSheet/types";

export type WeekGridProps = {
  controller: TeeSheetController;
  onCreateAt: (date: string, time: string) => void;
};

const MONTH_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** "2026-09-11" -> "Sep 11" (aria-label 전용 짧은 형식). */
function shortDate(iso: string): string {
  const date = toDate(iso);
  return `${MONTH_SHORT[date.getMonth()]} ${date.getDate()}`;
}

const STATUS_LABEL: Record<BookingStatus, string> = {
  reserved: "Reserved",
  checked_in: "Checked in",
  paid: "Paid",
  cancelled: "Cancelled",
  no_show: "No show",
  blocked: "Blocked",
};

const COLOR_CLASS: Record<BookingColor, string> = {
  blue: "bg-[#0034c9] text-white",
  gold: "bg-[#ffd400] text-[#1d232b]",
  gray: "bg-[#ececf0] text-[#4e5560]",
};

/** 취소선 처리된 대각 해칭 — blocked 예약 전용 배경. */
const HATCH_STYLE: CSSProperties = {
  backgroundImage:
    "repeating-linear-gradient(45deg, #d5d5dd 0px, #d5d5dd 4px, #ececf0 4px, #ececf0 9px)",
};

const FOCUS_RING =
  "outline-none focus-visible:ring-2 focus-visible:ring-[#4533ff] focus-visible:ring-offset-0";

function bookingCapacity(booking: TeeBooking): number {
  return Math.max(4, booking.players.length);
}

function isDead(booking: TeeBooking): boolean {
  return booking.status === "cancelled" || booking.status === "no_show";
}

// ===================== 일간 시트 전용 상수 =====================

/** 한 티타임의 플레이어 칸 수. 백엔드 정원과 같은 값. */
const DAY_SEATS = 4;
/** 트랙 라인 번호: 1=Time, 2=Rate, 3..6=플레이어, 7=Cart, 8=Timer, 9=끝 라인. */
const DAY_PLAYER_COL = 3;
const DAY_CART_COL = DAY_PLAYER_COL + DAY_SEATS;
const DAY_TIMER_COL = DAY_CART_COL + 1;
const DAY_ROW_END = DAY_TIMER_COL + 1;
/** Time 열 폭. gridTemplateColumns 와 Rate 열의 sticky `left` 오프셋이 **같은 값**을
 *  써야 한다 — 어긋나면 Rate 열이 조용히 고정 해제된다. 그래서 상수 하나로 둔다. */
const DAY_TIME_COL_PX = 88;
const DAY_RATE_COL_PX = 64;
/** 셀에 이름이 들어가므로 행이 주간 뷰보다 넉넉해야 한다. */
// 일간 뷰 행 높이. 실제 값은 CSS 변수 `--day-row` 가 정하고 이 상수는 폴백이다.
// 인라인 style 로 그리드 트랙을 만들기 때문에 Tailwind 브레이크포인트가 닿지 않는데,
// 데스크톱은 한 화면에 슬롯을 많이 보여 주는 밀도가 중요하고 휴대폰은 손가락으로
// 정확히 누르는 것이 더 중요하다. CSS 변수면 한 줄로 둘 다 만족한다
// (globals.css 에서 1023px 이하일 때만 44px 로 키운다).
const DAY_ROW_PX = 36;
const DAY_BAND_PX = 22;

/** 시(hour) 밴드용. 파싱 불가 슬롯(minutes=MAX_SAFE_INTEGER 폴백)은 밴드를 만들지 않는다. */
function slotHour(slot: TeeSlot): number | null {
  if (!Number.isFinite(slot.minutes) || slot.minutes < 0 || slot.minutes >= 1440) return null;
  return Math.floor(slot.minutes / 60);
}

/**
 * 한 행 안의 세그먼트 순서. visibleBookings 배열 순서에 기대면 새로고침마다
 * 두 예약의 좌우가 뒤바뀐다 — 그래서 생성 시각(동률이면 id)으로 확정한다.
 */
function bySeatOrder(a: TeeBooking, b: TeeBooking): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

type DayLine =
  | { kind: "band"; key: string; label: string }
  | { kind: "slot"; key: string; slot: TeeSlot };

type DaySegment = { booking: TeeBooking; start: number; width: number };
type DayPack = {
  segments: DaySegment[];
  free: number[];
  overflow: TeeBooking[];
  /** 좌석을 하나도 잡지 않는 예약(취소됨 · 플레이어 0명). 행에는 놓을 수 없고 아래 스트립으로 간다. */
  unseated: TeeBooking[];
};

const EMPTY_PACK: DayPack = { segments: [], free: [0, 1, 2, 3], overflow: [], unseated: [] };

/**
 * 백엔드 `tee_time_players()` 와 **글자 그대로 같은** 좌석 산술.
 * 취소된 예약은 자리를 반납하고(취소 후 그 자리는 다시 팔 수 있어야 한다),
 * 플레이어가 0명인 예약은 애초에 자리를 잡지 않는다.
 * 여기서 백엔드와 1이라도 어긋나면 서버가 받아 준 새 예약이 화면에서는
 * "자리 없음" 으로 밀려나는(혹은 그 반대의) 유령 불일치가 생긴다.
 */
function daySeats(booking: TeeBooking): number {
  if (booking.status === "cancelled") return 0;
  // 정원을 넘는 인원(백엔드상 불가능하지만 레거시 레코드는 있을 수 있다)도
  // 사라지면 안 되므로 4칸까지는 그린다.
  return Math.min(booking.players.length, DAY_SEATS);
}

/**
 * 드래그로 옮길 때 도착 칸에 남은 자리를 셀 때 쓰는 좌석 수. `daySeats` 와 달리 4로 자르지
 * 않는다 — 백엔드 `require_capacity` 가 보는 값 그대로여야 "놓았는데 서버가 거절" 이 없다.
 */
function heldSeats(booking: TeeBooking): number {
  return booking.status === "cancelled" ? 0 : booking.players.length;
}

/** 드래그 중인 예약 id 를 싣는 dataTransfer 형식. 다른 앱에서 끌어온 글자와 구분한다. */
const DRAG_MIME = "application/x-pelham-tee-booking";

/** 드래그로 옮길 수 없는 예약. 취소·노쇼는 자리를 잡지 않으니 옮길 이유가 없다. */
function isDraggable(booking: TeeBooking): boolean {
  return !isDead(booking);
}

/**
 * 일간 시트에서 "예약 한 건의 배경색" 을 정하는 단일 규칙.
 * 그리드 세그먼트와 오버플로 스트립이 **같은 함수**를 부르게 강제한다 —
 * 두 곳이 각자 색을 고르면 스트립의 색이 채널을 뜻하는지 요금제를 뜻하는지
 * 읽는 사람이 알 수 없게 된다. (tone.ts: 일간 시트에서 booking.color 는
 * "blue" 만 의미가 있고 gold/gray 는 무시된다.)
 */
function daySurfaceClass(booking: TeeBooking): string {
  // 잠긴 티타임은 레퍼런스에서 흰 줄이다 — 색이 붙으면 "예약이 들어찬 줄" 로 읽힌다.
  if (booking.status === "blocked") return "bg-white text-[#4e5560]";
  const first = booking.players[0];
  return first ? TONE_CLASS[playerTone(booking, first)] : "bg-[#ececf0] text-[#4e5560]";
}

export default function WeekGrid({ controller, onCreateAt }: WeekGridProps) {
  const { view, weekDates, focusedDate, weekStart, visibleBookings, slots, selectedId } = controller;
  const isDayView = view === "day";
  const today = todayIso();

  // ===== 컬럼: 실제 ISO 날짜. 하드코딩된 요일 배열은 쓰지 않는다. =====
  // useTeeSheet이 weekDates를 매 렌더 새로 만들 수도 있으므로 배열 identity가 아니라
  // 값(join)으로 의존한다 — 아래의 모든 useMemo 캐스케이드가 헛돌지 않게.
  const weekKey = weekDates.join(",");
  const columns = useMemo(
    () => (isDayView ? [focusedDate] : weekKey.split(",")),
    [isDayView, focusedDate, weekKey],
  );

  const colIndex = useMemo(() => {
    const map = new Map<string, number>();
    columns.forEach((iso, index) => map.set(iso, index));
    return map;
  }, [columns]);

  // ===== 행: 슬롯이 없으면 보이는 예약의 시각에서 파생시킨다 (예약이 사라지면 안 됨). =====
  const slotsLoading = slots.length === 0;

  const rows = useMemo<TeeSlot[]>(() => {
    if (slots.length > 0) {
      return [...slots].sort((a, b) => a.minutes - b.minutes);
    }
    const derived = new Map<string, TeeSlot>();
    for (const booking of visibleBookings) {
      if (derived.has(booking.time)) continue;
      const minutes = timeToMinutes(booking.time);
      derived.set(booking.time, {
        time: booking.time,
        minutes: Number.isFinite(minutes) ? minutes : Number.MAX_SAFE_INTEGER,
        rate: booking.rate,
        cartsTotal: 0,
      });
    }
    return [...derived.values()].sort((a, b) => a.minutes - b.minutes);
  }, [slots, visibleBookings]);

  // 주간 뷰: 열마다 그 날 요금(주중·주말·공휴일). 한 주에 요금이 섞이면 Rate 열은 비우고
  // 열 머리의 금액을 보게 한다 — 행 하나에 고른 날의 요금만 찍으면 다른 날 칸이 틀린 값을 단다.
  const rateDays = useRateDays(columns);
  const weekRate = useMemo<number | null>(() => {
    const values = columns.map((iso) => rateDays.get(iso)?.rate);
    if (values.some((value) => value === undefined)) return rows[0]?.rate ?? null;
    return values.every((value) => value === values[0]) ? (values[0] as number) : null;
  }, [columns, rateDays, rows]);

  const rowIndex = useMemo(() => {
    const map = new Map<string, number>();
    rows.forEach((slot, index) => map.set(slot.time, index));
    return map;
  }, [rows]);

  // ===== `${date}|${time}` 버킷. 같은 칸의 예약들은 한 grid 자식 안에서 나란히 놓인다. =====
  const buckets = useMemo(() => {
    const map = new Map<string, TeeBooking[]>();
    for (const booking of visibleBookings) {
      if (!colIndex.has(booking.date) || !rowIndex.has(booking.time)) continue;
      const key = `${booking.date}|${booking.time}`;
      const list = map.get(key);
      if (list) list.push(booking);
      else map.set(key, [booking]);
    }
    return map;
  }, [visibleBookings, colIndex, rowIndex]);

  // 그리드에 놓을 수 없는 예약들 — 조용히 사라지지 않도록 아래 스트립으로 뺀다.
  const offGrid = useMemo(() => {
    const noSlot: TeeBooking[] = [];
    const otherDays: TeeBooking[] = [];
    const outOfRange: TeeBooking[] = [];
    for (const booking of visibleBookings) {
      const hasRow = rowIndex.has(booking.time);
      const hasCol = colIndex.has(booking.date);
      if (hasRow && hasCol) continue;
      if (!hasRow) {
        noSlot.push(booking);
      } else if (isDayView && dayIndexIn(weekStart, booking.date) >= 0) {
        otherDays.push(booking);
      } else {
        outOfRange.push(booking);
      }
    }
    return { noSlot, otherDays, outOfRange };
  }, [visibleBookings, rowIndex, colIndex, isDayView, weekStart]);

  // 행별 카트 집계: 보이는 범위 전체에서 해당 슬롯에 잡힌 카트 수.
  const cartsByTime = useMemo(() => {
    const map = new Map<string, number>();
    for (const booking of visibleBookings) {
      if (!colIndex.has(booking.date) || isDead(booking)) continue;
      map.set(booking.time, (map.get(booking.time) ?? 0) + (booking.cartCount || 0));
    }
    return map;
  }, [visibleBookings, colIndex]);

  // ===== 일간 시트: 시(hour) 밴드를 섞은 "라인" 목록 =====
  // 매 시각의 첫 티타임 **앞에** 전폭 밴드(6:00 AM · 7:00 AM …)를 깐다.
  // 즉 6:58 은 6시대이므로 그 아래에 7:00 AM 밴드가 온다.
  // 첫 행 위에도 밴드가 온다 — 레퍼런스의 맨 윗줄이 "6:00 AM" 이다. 헤더 행을 없앤
  // 지금은 이 밴드가 시트의 시작을 알리는 유일한 표시이기도 하다.
  const dayLines = useMemo<DayLine[]>(() => {
    if (!isDayView) return [];
    const lines: DayLine[] = [];
    let prevHour: number | null = null;
    rows.forEach((slot) => {
      const hour = slotHour(slot);
      if (hour !== null && hour !== prevHour) {
        lines.push({ kind: "band", key: `band-${slot.time}`, label: minutesToTime(hour * 60) });
      }
      if (hour !== null) prevHour = hour;
      lines.push({ kind: "slot", key: `slot-${slot.time}`, slot });
    });
    return lines;
  }, [isDayView, rows]);

  // grid row 번호는 `dayLines` 인덱스 + 2 다 (1행은 헤더). 밴드가 섞여 있으므로
  // 슬롯 인덱스가 아니라 **라인 인덱스**를 써야 한다 — 렌더에서 그대로 계산한다.

  // ===== 일간 시트: 행마다 세그먼트를 좌→우로 패킹 =====
  // 한 티타임에 예약이 둘 이상 올 수 있다(합계 4명 이하면 백엔드가 허용). 자리는
  // 한 번만 계산하고 렌더와 오버플로 스트립이 같은 결과를 읽는다 — 두 번 계산하면
  // 화면과 "사라진 예약" 목록이 어긋난다.
  //
  // 규칙은 한 문장이다: **세그먼트의 span 은 언제나 그 예약의 백엔드 좌석 수와 같다.**
  //   - 좌석 수가 0인 예약(취소됨 · 플레이어 0명)은 세그먼트가 될 수 없다 → `unseated`
  //     로 빼서 아래 전용 스트립에 드러낸다. 남는 칸에 한 칸씩 끼워 넣지 않는 이유:
  //     그러면 `free`(= 새로 팔 수 있는 자리)가 백엔드 잔여 정원과 다시 어긋난다.
  //   - 남은 칸보다 인원이 많으면 **잘라서 넣지 않고** overflow 로 뺀다. 잘라 넣으면
  //     안쪽 flex-1 플레이어 셀이 플레이어 컬럼 경계와 어긋난다.
  const dayPacks = useMemo(() => {
    const map = new Map<string, DayPack>();
    if (!isDayView) return map;
    for (const slot of rows) {
      const list = [...(buckets.get(`${focusedDate}|${slot.time}`) ?? [])].sort(bySeatOrder);
      const segments: DaySegment[] = [];
      const overflow: TeeBooking[] = [];
      const unseated: TeeBooking[] = [];
      let used = 0;
      for (const booking of list) {
        const seats = daySeats(booking);
        if (seats === 0) {
          unseated.push(booking);
          continue;
        }
        if (used + seats > DAY_SEATS) {
          overflow.push(booking);
          continue;
        }
        segments.push({ booking, start: used, width: seats });
        used += seats;
      }
      // 여기까지의 `used` 는 백엔드 tee_time_players() 결과와 같은 값이다.
      const free: number[] = [];
      for (let seat = used; seat < DAY_SEATS; seat += 1) free.push(seat);
      map.set(slot.time, { segments, free, overflow, unseated });
    }
    return map;
  }, [isDayView, rows, buckets, focusedDate]);

  // 4칸을 넘겨 자리를 못 받은 예약 — 아래 스트립으로 반드시 드러낸다.
  const dayOverflow = useMemo(() => {
    const out: TeeBooking[] = [];
    for (const pack of dayPacks.values()) out.push(...pack.overflow);
    return out;
  }, [dayPacks]);

  // 좌석을 잡지 않는 예약(취소됨 · 플레이어 0명). 행에서는 자리를 비워 두지만
  // 예약 자체가 사라지면 안 되므로 전용 스트립에서 계속 선택·편집할 수 있다.
  const dayUnseated = useMemo(() => {
    const out: TeeBooking[] = [];
    for (const pack of dayPacks.values()) out.push(...pack.unseated);
    return out;
  }, [dayPacks]);

  // 그리드 라인 좌표. 주간 트랙: [Time, Rate, ...days, Cart]
  const dayColStart = 3;
  const cartCol = dayColStart + columns.length;
  const fullRowEnd = cartCol + 1; // 마지막 라인 (= 트랙 수 + 1)
  const bodyRowEnd = rows.length + 2;
  /** 일간 시트에는 헤더 행이 없다 → 첫 라인이 grid row 1. 주간 뷰는 헤더가 1행이라 2부터다. */
  const DAY_ROW_BASE = 1;
  const dayBodyRowEnd = dayLines.length + DAY_ROW_BASE;

  const gridTemplateColumns = isDayView
    ? `${DAY_TIME_COL_PX}px ${DAY_RATE_COL_PX}px repeat(${DAY_SEATS}, minmax(112px, 1fr)) 56px 44px`
    : `86px 48px repeat(${columns.length}, minmax(120px, 1fr)) 64px`;

  const gridTemplateRows = isDayView
    ? dayLines.length > 0
      ? [
          ...dayLines.map((line) =>
            line.kind === "band" ? `${DAY_BAND_PX}px` : `minmax(var(--day-row, ${DAY_ROW_PX}px), auto)`,
          ),
        ].join(" ")
      : "auto"
    : rows.length > 0
      ? `auto repeat(${rows.length}, minmax(29px, auto))`
      : "auto";

  const cellAlign = "items-center";

  // 예약이 차지한 칸에는 "빈 칸" 버튼을 그리지 않는다.
  const covered = useMemo(() => {
    const set = new Set<string>();
    for (const [key, list] of buckets) {
      const [date, time] = key.split("|");
      const row = rowIndex.get(time)!;
      const col = colIndex.get(date)!;
      const span = isDayView
        ? 1
        : Math.min(
            Math.max(1, ...list.map((booking) => Math.max(1, booking.span || 1))),
            columns.length - col,
          );
      for (let offset = 0; offset < span; offset += 1) set.add(`${row}|${col + offset}`);
    }
    return set;
  }, [buckets, rowIndex, colIndex, isDayView, columns.length]);

  // ===== 드래그 앤 드롭으로 시간 옮기기 =====
  // 예약 막대(주간)·세그먼트(일간)를 끌어 빈 칸에 놓으면 그 날짜·티 타임으로 옮긴다.
  // 저장은 상세 패널의 날짜·티 타임 드롭다운과 같은 `controller.moveBooking` 이다.
  //
  // 네이티브 HTML5 드래그를 쓴다: 격자가 스크롤 컨테이너 안에 있어서, 브라우저가 가장자리
  // 자동 스크롤을 해 주는 쪽이 포인터 좌표를 직접 칸으로 환산하는 것보다 훨씬 덜 깨진다.
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropKey, setDropKey] = useState<string | null>(null);
  const { moveBooking, pushToast, select } = controller;

  const draggedBooking = useMemo(
    () => (dragId ? visibleBookings.find((booking) => booking.id === dragId) ?? null : null),
    [dragId, visibleBookings],
  );

  /** 드래그한 예약을 뺀 나머지가 그 칸에서 잡고 있는 좌석 수. */
  const seatsTakenAt = useCallback(
    (date: string, time: string, exceptId: string) =>
      (buckets.get(`${date}|${time}`) ?? [])
        .filter((booking) => booking.id !== exceptId)
        .reduce((sum, booking) => sum + heldSeats(booking), 0),
    [buckets],
  );

  const canDropAt = useCallback(
    (date: string, time: string) => {
      if (!draggedBooking) return false;
      if (draggedBooking.date === date && draggedBooking.time === time) return false;
      return seatsTakenAt(date, time, draggedBooking.id) + heldSeats(draggedBooking) <= DAY_SEATS;
    },
    [draggedBooking, seatsTakenAt],
  );

  const endDrag = useCallback(() => {
    setDragId(null);
    setDropKey(null);
  }, []);

  const startDrag = useCallback((event: DragEvent, booking: TeeBooking) => {
    event.dataTransfer.setData(DRAG_MIME, booking.id);
    event.dataTransfer.effectAllowed = "move";
    setDragId(booking.id);
  }, []);

  const dropBooking = useCallback(
    (date: string, time: string) => {
      const booking = draggedBooking;
      endDrag();
      if (!booking || (booking.date === date && booking.time === time)) return;
      const free = DAY_SEATS - seatsTakenAt(date, time, booking.id);
      if (heldSeats(booking) > free) {
        pushToast(
          "error",
          `${time} on ${shortDate(date)} has ${Math.max(0, free)} open spot(s) — ${booking.title} has ${heldSeats(booking)} players.`,
        );
        return;
      }
      select(booking.id);
      void moveBooking(booking.id, date, time);
    },
    [draggedBooking, endDrag, moveBooking, pushToast, seatsTakenAt, select],
  );

  /**
   * 놓을 수 있는 칸에 붙이는 핸들러 묶음. `dragover` 에서 preventDefault 를 해야 그 칸이
   * 드롭 대상이 된다 — 자리가 모자라는 칸은 하지 않아서 커서가 "금지" 로 바뀐다.
   */
  const dropTarget = (date: string, time: string) => {
    const key = `${date}|${time}`;
    return {
      onDragOver: (event: DragEvent) => {
        if (!dragId || !canDropAt(date, time)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        if (dropKey !== key) setDropKey(key);
      },
      onDragLeave: () => {
        if (dropKey === key) setDropKey(null);
      },
      onDrop: (event: DragEvent) => {
        event.preventDefault();
        dropBooking(date, time);
      },
    };
  };

  const dropHighlight = (date: string, time: string) =>
    dropKey === `${date}|${time}` ? "bg-[#dcd8ff] ring-2 ring-inset ring-[#4533ff]" : "";

  const dragProps = (booking: TeeBooking) => ({
    dragging: dragId === booking.id,
    onDragStart: isDraggable(booking) ? (event: DragEvent) => startDrag(event, booking) : undefined,
    onDragEnd: endDrag,
  });

  // Time 열 폭 — Rate 열의 sticky left 오프셋 계산에 쓴다.
  const timeColWidth = isDayView ? DAY_TIME_COL_PX : 86;

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      {/* 스크롤 컨테이너는 반드시 하나. 가로·세로를 한 컨테이너가 잡아야
          헤더 행과 Time/Rate 열을 position:sticky 로 고정("프리즈")할 수 있다.
          페이지 본문은 여전히 가로로 밀리지 않는다. */}
      <div className="min-h-0 min-w-0 flex-1 overflow-auto border-t border-[#d6d6dc] bg-white">
        <div className={isDayView ? "min-w-[700px]" : "min-w-[1050px]"}>
          <div className="grid text-xs" style={{ gridTemplateColumns, gridTemplateRows }}>
            {/* ================= 주간 뷰 본문 (그대로 유지) =================
                주간 뷰는 컬럼이 **날짜**라서 헤더 행이 있어야 어느 칸이 어느 날인지 알 수 있다.
                일간 시트에는 헤더 행이 없다 — 컬럼이 그냥 좌석 1~4번이고, 날짜는 위의
                상태 스트립이 이미 크게 말하고 있다 (레퍼런스와 동일). */}
            {!isDayView && (
              <>
            <div
              className="sticky top-0 left-0 z-40 border-b border-[#d6d6dc] bg-[#d7d5da] px-2 py-1 text-left font-bold"
              style={{ gridColumn: 1, gridRow: 1 }}
            >
              Time
            </div>
            <div
              className="sticky top-0 z-40 border-b border-[#d6d6dc] bg-[#d7d5da] px-2 py-1 text-center font-bold"
              style={{ gridColumn: 2, gridRow: 1, left: timeColWidth }}
            >
              {weekRate === null ? "Rate ↗" : "Rate"}
            </div>

            {columns.map((iso, index) => {
              const isToday = iso === today;
              const weekend = isWeekend(iso);
              const isFocused = iso === focusedDate;
              return (
                <button
                  key={iso}
                  type="button"
                  onClick={() => controller.setFocusedDate(iso)}
                  aria-label={`Show ${longDate(iso)}`}
                  aria-pressed={isFocused}
                  title={longDate(iso)}
                  className={`sticky top-0 z-30 border-b border-[#d6d6dc] px-2 py-1 text-center font-bold ${FOCUS_RING} ${
                    isToday
                      ? "bg-[#4533ff] text-white"
                      : weekend
                        ? "bg-[#cdcbd2] text-[#1f2328]"
                        : "bg-[#d7d5da] text-[#1f2328]"
                  } ${isFocused && !isToday ? "underline decoration-[#4533ff] decoration-2 underline-offset-2" : ""}`}
                  style={{ gridColumn: dayColStart + index, gridRow: 1 }}
                >
                  {columnLabel(iso)}
                  {rateDays.get(iso) && (
                    <span
                      className={`block text-[10px] leading-tight font-semibold tabular-nums ${
                        isToday ? "text-white/85" : rateDays.get(iso)!.dayType === "holiday" ? "text-[#b4530a]" : "text-[#4e5560]"
                      }`}
                      title={dayTypeLabel(rateDays.get(iso)!)}
                    >
                      {rateDays.get(iso)!.dayType === "holiday" ? "★ " : ""}
                      {money(rateDays.get(iso)!.rate)}
                    </span>
                  )}
                </button>
              );
            })}

            <div
              className="sticky top-0 z-30 border-b border-[#d6d6dc] bg-[#d7d5da] px-2 py-1 text-center font-bold"
              style={{ gridColumn: cartCol, gridRow: 1 }}
            >
              Cart
            </div>

            {/* ---------- 배경 레이어: 컬럼 세로줄 + 주말 틴트 (본문 전체 높이) ---------- */}
            {rows.length > 0 &&
              columns.map((iso, index) => (
                <div
                  key={`col-bg-${iso}`}
                  aria-hidden
                  className={`pointer-events-none border-l border-[#ececf0] ${
                    isWeekend(iso) ? "bg-[#f6f6fa]" : ""
                  }`}
                  style={{
                    gridColumn: dayColStart + index,
                    gridRow: `2 / ${bodyRowEnd}`,
                  }}
                />
              ))}
            {rows.length > 0 && (
              <div
                aria-hidden
                className="pointer-events-none border-l border-[#ececf0]"
                style={{ gridColumn: cartCol, gridRow: `2 / ${bodyRowEnd}` }}
              />
            )}

            {/* ---------- 배경 레이어: 행 구분선 ---------- */}
            {rows.map((slot, index) =>
              index === rows.length - 1 ? null : (
                <div
                  key={`row-bg-${slot.time}`}
                  aria-hidden
                  className="pointer-events-none border-b border-[#ececf0]"
                  style={{ gridColumn: `1 / ${fullRowEnd}`, gridRow: index + 2 }}
                />
              ),
            )}

            {/* ---------- Time / Rate / Cart 셀 ---------- */}
            {rows.map((slot, index) => {
              const booked = cartsByTime.get(slot.time) ?? 0;
              return (
                <Fragment key={`meta-${slot.time}`}>
                  <div
                    className={`sticky left-0 z-20 flex ${cellAlign} bg-white px-2 font-semibold ${
                      index === rows.length - 1 ? "" : "border-b border-[#ececf0]"
                    }`}
                    style={{ gridColumn: 1, gridRow: index + 2 }}
                  >
                    {slot.time}
                  </div>
                  <div
                    className={`sticky z-20 flex ${cellAlign} justify-center bg-white text-[#9aa0a6] ${
                      index === rows.length - 1 ? "" : "border-b border-[#ececf0]"
                    }`}
                    style={{ gridColumn: 2, gridRow: index + 2, left: timeColWidth }}
                  >
                    {weekRate === null ? "" : money(weekRate)}
                  </div>
                  <div
                    className={`relative flex ${cellAlign} justify-center gap-1 text-[#3f4650]`}
                    style={{ gridColumn: cartCol, gridRow: index + 2 }}
                    title={
                      slot.cartsTotal > 0
                        ? `${booked} cart(s) booked at ${slot.time} across ${columns.length} day(s) · ${slot.cartsTotal} available per day`
                        : `${booked} cart(s) booked at ${slot.time}`
                    }
                  >
                    <span aria-hidden>🚗</span>
                    <span className={booked > slot.cartsTotal && slot.cartsTotal > 0 ? "font-bold text-[#8a3f26]" : ""}>
                      {slot.cartsTotal > 0 ? `${booked}/${slot.cartsTotal}` : booked}
                    </span>
                  </div>
                </Fragment>
              );
            })}

            {/* ---------- 빈 칸 버튼 ---------- */}
            {rows.map((slot, rowIdx) =>
              columns.map((iso, colIdx) => {
                if (covered.has(`${rowIdx}|${colIdx}`)) return null;
                return (
                  <button
                    key={`empty-${iso}-${slot.time}`}
                    type="button"
                    onClick={() => onCreateAt(iso, slot.time)}
                    {...dropTarget(iso, slot.time)}
                    aria-label={`Create reservation on ${shortDate(iso)} at ${slot.time}`}
                    className={`group relative flex scroll-mt-10 items-center justify-center hover:bg-[#f0efff] ${dropHighlight(iso, slot.time)} ${FOCUS_RING}`}
                    style={{ gridColumn: dayColStart + colIdx, gridRow: rowIdx + 2 }}
                  >
                    <span
                      aria-hidden
                      className="text-[13px] leading-none font-bold text-[#b6b6c0] opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
                    >
                      +
                    </span>
                  </button>
                );
              }),
            )}

            {/* ---------- 예약 막대 — 진짜 grid 자식 ---------- */}
            {[...buckets.entries()].map(([key, list]) => {
              const [date, time] = key.split("|");
              const rowIdx = rowIndex.get(time)!;
              const colIdx = colIndex.get(date)!;
              const span = Math.min(
                Math.max(1, ...list.map((booking) => Math.max(1, booking.span || 1))),
                columns.length - colIdx,
              );
              return (
                <div
                  key={`bucket-${key}`}
                  // scroll-mt: 고정된 헤더 행 뒤로 숨은 채 스크롤되지 않도록
                  // (키보드 포커스/프로그램 스크롤이 헤더 아래에 멈추게 한다).
                  // 자리가 남은 칸이면 예약이 이미 있어도 여기로 끌어다 합칠 수 있다.
                  {...dropTarget(date, time)}
                  className={`relative z-10 flex min-w-0 scroll-mt-10 items-center gap-[2px] px-[3px] py-[4px] ${dropHighlight(date, time)}`}
                  style={{
                    gridColumn: `${dayColStart + colIdx} / span ${span}`,
                    gridRow: rowIdx + 2,
                  }}
                >
                  {list.map((booking) => (
                    <BookingBar
                      key={booking.id}
                      {...dragProps(booking)}
                      booking={booking}
                      selected={booking.id === selectedId}
                      onSelect={controller.select}
                    />
                  ))}
                </div>
              );
            })}
              </>
            )}

            {/* ================= 일간 시트 본문 ================= */}
            {isDayView && (
              <>
                {/* 세로 구분선 (본문 전체 높이) */}
                {dayLines.length > 0 &&
                  Array.from({ length: DAY_SEATS + 2 }, (_, index) => (
                    <div
                      key={`day-col-bg-${index}`}
                      aria-hidden
                      className="pointer-events-none border-l border-[#ececf0]"
                      style={{
                        gridColumn: DAY_PLAYER_COL + index,
                        gridRow: `${DAY_ROW_BASE} / ${dayBodyRowEnd}`,
                      }}
                    />
                  ))}

                {dayLines.map((line, lineIdx) => {
                  const gridRow = lineIdx + DAY_ROW_BASE;

                  if (line.kind === "band") {
                    return (
                      <div
                        key={line.key}
                        className="z-[15] flex items-center border-y border-[#c9d8e8] bg-[#dde7f2]"
                        style={{ gridColumn: `1 / ${DAY_ROW_END}`, gridRow }}
                      >
                        {/* 가로 스크롤 시에도 시각 라벨이 보이도록 라벨만 sticky. */}
                        <span className="sticky left-0 px-2 text-[11px] font-semibold text-[#4e5560]">
                          {line.label}
                        </span>
                      </div>
                    );
                  }

                  const slot = line.slot;
                  const pack = dayPacks.get(slot.time) ?? EMPTY_PACK;
                  const carts = cartsByTime.get(slot.time) ?? 0;
                  // 행 밑줄은 셀마다 그린다. 빈 자리 버튼에도 반드시 붙여야
                  // 선이 플레이어 칸 구간에서 끊겼다가 다시 나타나지 않는다.
                  // 바로 아래가 시(hour) 밴드면 밴드의 border-t 와 겹쳐 2px 이 되므로 생략.
                  const last = lineIdx === dayLines.length - 1;
                  const nextIsBand = dayLines[lineIdx + 1]?.kind === "band";
                  const rule = last || nextIsBand ? "" : "border-b border-[#ececf0]";
                  // Timer 는 실제 동작하는 컨트롤이다: 이 행의 첫 "체크인 가능한" 예약을
                  // 체크인한다. 취소/노쇼/blocked 는 체크인할 사람이 없으므로 건너뛴다.
                  const checkInTarget = pack.segments.find(
                    ({ booking }) => !isDead(booking) && booking.status !== "blocked",
                  )?.booking;

                  return (
                    <Fragment key={line.key}>
                      <div
                        className={`sticky left-0 z-20 flex items-center bg-white px-2 font-bold text-[#1f2328] ${rule}`}
                        style={{ gridColumn: 1, gridRow }}
                      >
                        {slot.time}
                      </div>
                      <div
                        className={`sticky z-20 flex items-center justify-center bg-white px-1 ${rule}`}
                        style={{ gridColumn: 2, gridRow, left: DAY_TIME_COL_PX }}
                      >
                        <RateTag slot={slot} open={pack.free.length > 0} />
                      </div>

                      {/* 세그먼트 = 예약 하나. 좌→우 순서는 dayPacks 가 확정해 둔다. */}
                      {pack.segments.map(({ booking, start, width }) => (
                        <DaySegmentCard
                          key={booking.id}
                          {...dragProps(booking)}
                          booking={booking}
                          selected={booking.id === selectedId}
                          onSelect={controller.select}
                          rule={rule}
                          style={{
                            gridColumn: `${DAY_PLAYER_COL + start} / span ${width}`,
                            gridRow,
                          }}
                        />
                      ))}

                      {/* 남는 칸 = 새 예약 자리. */}
                      {pack.free.map((seat) => (
                        <button
                          key={`day-empty-${slot.time}-${seat}`}
                          type="button"
                          onClick={() => onCreateAt(focusedDate, slot.time)}
                          {...dropTarget(focusedDate, slot.time)}
                          aria-label={`Create reservation on ${shortDate(focusedDate)} at ${slot.time}`}
                          title={`Create reservation at ${slot.time}`}
                          className={`group relative flex scroll-mt-10 items-center justify-center hover:bg-[#f0efff] ${dropHighlight(focusedDate, slot.time)} ${rule} ${FOCUS_RING}`}
                          style={{ gridColumn: DAY_PLAYER_COL + seat, gridRow }}
                        >
                          <span
                            aria-hidden
                            className="flex h-[15px] w-[15px] items-center justify-center rounded-full border border-[#c2c2cc] text-[11px] leading-none font-bold text-[#9aa0a6] group-hover:border-[#4533ff] group-hover:text-[#4533ff]"
                          >
                            +
                          </span>
                        </button>
                      ))}

                      {/* Cart: 0이면 아예 아무것도 그리지 않는다 (스크린샷과 동일). */}
                      <div
                        className={`flex items-center justify-center gap-1 text-[11px] text-[#3f4650] ${rule}`}
                        style={{ gridColumn: DAY_CART_COL, gridRow }}
                        title={carts > 0 ? `${carts} cart(s) booked at ${slot.time}` : undefined}
                      >
                        {carts > 0 && (
                          <>
                            <span aria-hidden>🚗</span>
                            <span
                              className={
                                slot.cartsTotal > 0 && carts > slot.cartsTotal
                                  ? "font-bold text-[#8a3f26]"
                                  : "font-semibold"
                              }
                            >
                              {carts}
                            </span>
                          </>
                        )}
                      </div>

                      <div
                        className={`flex items-center justify-center ${rule}`}
                        style={{ gridColumn: DAY_TIMER_COL, gridRow }}
                      >
                        <button
                          type="button"
                          disabled={!checkInTarget}
                          onClick={
                            checkInTarget
                              ? () => void controller.setStatus(checkInTarget.id, "checked_in")
                              : undefined
                          }
                          aria-label={
                            checkInTarget
                              ? `Check in ${checkInTarget.title}`
                              : `Nothing to check in at ${slot.time}`
                          }
                          title={
                            checkInTarget
                              ? `Check in ${checkInTarget.title}`
                              : `Nothing to check in at ${slot.time}`
                          }
                          className={`flex h-11 w-11 items-center justify-center rounded-sm border border-[#c7c7cc] text-[11px] leading-none lg:h-[22px] lg:w-[22px] ${FOCUS_RING} ${
                            checkInTarget
                              ? "text-[#3f4650] hover:border-[#4533ff] hover:bg-[#f0efff]"
                              : "text-[#c7c7cc]"
                          }`}
                        >
                          <span aria-hidden>⏱</span>
                        </button>
                      </div>
                    </Fragment>
                  );
                })}
              </>
            )}
          </div>

          {/* rows가 0이면 grid 본문 자체를 그리지 않는다 (repeat(0, …)는 무효 CSS). */}
          {rows.length === 0 && (
            <p className="px-3 py-6 text-center text-xs text-[#6b7280]">
              {controller.connection === "offline"
                ? "Offline — no tee times cached for this range yet."
                : "Loading tee times…"}
            </p>
          )}
        </div>
      </div>

      {/* 격자 아래 보조 영역: 화면 고정 레이아웃에서 자라지 않도록 상한을 두고
          자체 스크롤시킨다 (한 화면 규칙이 깨지면 안 된다). */}
      <div className="max-h-[22vh] shrink-0 overflow-y-auto">
        {slotsLoading && rows.length > 0 && (
          <p className="mt-2 text-[11px] text-[#6b7280]">
            {controller.connection === "offline"
              ? "Offline — showing only the tee times that already have reservations."
              : "Loading the full tee time list… showing times taken from existing reservations."}
          </p>
        )}

        {/* 일간 시트는 한 티타임에 4칸뿐이다. 넘친 예약도 조용히 잘리면 안 된다. */}
        <OffGridStrip
          title="Too many players for the tee time"
          hint="This tee time already has 4 player columns filled, so these reservations could not be laid out. Move them to another tee time or remove players."
          bookings={dayOverflow}
          selectedId={selectedId}
          onSelect={controller.select}
          dayTone={isDayView}
        />
        {/* 좌석을 잡지 않는 예약(취소됨 · 플레이어 0명). 백엔드도 이들을 정원에서 빼므로
            격자에서 칸을 차지하면 안 되지만, 예약 자체는 계속 보이고 편집 가능해야 한다. */}
        <OffGridStrip
          title="Holding no player column"
          hint="Cancelled reservations release their seats, and a reservation with no players never took one — so the four player columns stay available for bookings that do hold a seat. These are still selectable and editable here."
          bookings={dayUnseated}
          selectedId={selectedId}
          onSelect={controller.select}
          dayTone={isDayView}
        />
        <OffGridStrip
          title="Unscheduled / off-grid — no matching tee time"
          hint="These reservations have a time that is not on the current tee sheet. They are still open and editable."
          bookings={offGrid.noSlot}
          selectedId={selectedId}
          onSelect={controller.select}
          dayTone={isDayView}
        />
        <OffGridStrip
          title="Other days this week"
          hint="Outside the focused day. Switch to week view or pick the date to see them in the grid."
          bookings={offGrid.otherDays}
          selectedId={selectedId}
          onSelect={controller.select}
          dayTone={isDayView}
        />
        <OffGridStrip
          title="Outside the visible range"
          hint="These reservations fall outside the dates currently shown."
          bookings={offGrid.outOfRange}
          selectedId={selectedId}
          onSelect={controller.select}
          dayTone={isDayView}
        />
      </div>
    </div>
  );
}

// ===================== 하위 컴포넌트 =====================

type BookingButtonProps = {
  booking: TeeBooking;
  selected: boolean;
  onSelect: (bookingId: string | null) => void;
  /** 이 예약을 끌고 있는 중이면 true — 제자리 막대를 흐리게 그려 "옮기는 중" 을 보인다. */
  dragging?: boolean;
  /** 없으면 끌 수 없는 예약(취소·노쇼)이다. */
  onDragStart?: (event: DragEvent) => void;
  onDragEnd?: () => void;
};

/** 주간 뷰의 압축 막대. */
function BookingBar({ booking, selected, onSelect, dragging, onDragStart, onDragEnd }: BookingButtonProps) {
  const blocked = booking.status === "blocked";
  const cancelled = isDead(booking);
  return (
    <button
      type="button"
      draggable={Boolean(onDragStart)}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={() => onSelect(booking.id)}
      aria-pressed={selected}
      title={`${booking.title} · ${booking.time} · ${STATUS_LABEL[booking.status]}`}
      style={blocked ? HATCH_STYLE : undefined}
      className={`flex h-[19px] min-w-0 flex-1 items-center gap-1 overflow-hidden rounded-sm px-1.5 text-left text-[11px] leading-none font-bold shadow-sm ${FOCUS_RING} ${
        blocked ? "text-[#4e5560]" : COLOR_CLASS[booking.color]
      } ${cancelled ? "line-through opacity-55" : ""} ${selected ? "ring-2 ring-[#111315]" : ""} ${
        onDragStart ? "cursor-grab active:cursor-grabbing" : ""
      } ${dragging ? "opacity-40" : ""}`}
    >
      <span className="truncate">{blocked ? "Blocked" : booking.title}</span>
      {!blocked && (
        <span className="ml-auto shrink-0 rounded-sm bg-black/15 px-1 text-[10px] font-bold">
          {booking.players.length}/{bookingCapacity(booking)}
        </span>
      )}
    </button>
  );
}

/**
 * 일간 시트의 **세그먼트** = 예약 하나.
 * 예약 단위 크롬(9홀 배지 · 메모 아이콘 · 선택 링 · 클릭 타깃)만 소유하고,
 * 이름과 배경톤은 안쪽 **셀**(플레이어 하나)이 소유한다. 이 두 층을 합치면
 * "분홍 그룹 안의 마젠타 플레이어" 같은 표현이 불가능해진다.
 *
 * 배경을 첫 플레이어 톤으로 깔아두는 이유: 배지/메모가 붙는 왼쪽 크롬 띠가
 * 흰 구멍처럼 보이지 않도록. 각 셀은 자기 톤으로 다시 덮는다.
 */
function DaySegmentCard({
  booking,
  selected,
  onSelect,
  rule,
  style,
  dragging,
  onDragStart,
  onDragEnd,
}: BookingButtonProps & { rule: string; style: CSSProperties }) {
  const blocked = booking.status === "blocked";
  const cancelled = isDead(booking);
  const hasChrome = booking.holes === 9 || booking.notes.trim().length > 0;

  return (
    <button
      type="button"
      draggable={Boolean(onDragStart)}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={() => onSelect(booking.id)}
      aria-pressed={selected}
      // 9홀 배지와 메모 아이콘은 시각 정보이므로 aria-hidden 이다 — 대신 그 내용을
      // 버튼 이름에 넣어야 스크린리더 사용자가 같은 정보를 얻는다.
      aria-label={[
        booking.title,
        booking.time,
        STATUS_LABEL[booking.status],
        `${booking.players.length} of ${bookingCapacity(booking)} players`,
        `${booking.holes} holes`,
        booking.notes.trim() ? `Note: ${booking.notes.trim()}` : null,
      ]
        .filter(Boolean)
        .join(" · ")}
      title={`${booking.title} · ${booking.time} · ${STATUS_LABEL[booking.status]}`}
      // 잠긴 티타임에는 해칭을 깔지 않는다 — 레퍼런스는 흰 줄에 자물쇠 하나뿐이고,
      // 해칭은 "여기 뭔가 예약이 있다" 처럼 읽혀서 오히려 헷갈린다.
      style={style}
      // scroll-mt: 고정 헤더 뒤에 숨은 채로 스크롤되지 않게.
      // 세그먼트가 셀을 꽉 채우므로 행 밑줄도 스스로 그린다 — 안 그리면 위아래
      // 행의 같은 색 세그먼트가 한 덩어리로 뭉쳐 보인다.
      className={`z-10 flex min-w-0 scroll-mt-10 items-stretch overflow-hidden rounded-sm text-left text-[11px] leading-none ${rule} ${FOCUS_RING} ${daySurfaceClass(
        booking,
      )} ${cancelled ? "opacity-60" : ""} ${selected ? "ring-2 ring-[#111315] ring-inset" : ""} ${
        onDragStart ? "cursor-grab active:cursor-grabbing" : ""
      } ${dragging ? "opacity-40" : ""}`}
    >
      {blocked && (
        <span className="flex min-w-0 flex-1 items-center justify-center text-[#6b7280]">
          <span aria-hidden>&#128274;</span>
        </span>
      )}

      {!blocked && hasChrome && (
        <span className="flex shrink-0 flex-col items-center justify-center gap-[2px] px-[3px]">
          {booking.holes === 9 && (
            <span
              aria-hidden
              title="9 holes"
              className="rounded-[2px] bg-[#2b2f38] px-[3px] py-px text-[9px] font-bold text-white"
            >
              9
            </span>
          )}
          {booking.notes.trim().length > 0 && (
            <span aria-hidden title={booking.notes} className="text-[10px] leading-none">
              🗒
            </span>
          )}
        </span>
      )}

      {blocked ? null : booking.players.length === 0 ? (
        // 방어용 경로. dayPacks 가 좌석 0인 예약(플레이어 0명 · 취소됨)을 세그먼트로
        // 만들지 않으므로 지금은 도달하지 않지만, 그런 예약이 이 컴포넌트까지 오더라도
        // 이름 없이 빈 칸으로 그려지는 일은 없어야 한다.
        <span className="flex min-w-0 flex-1 items-center px-1 font-bold">
          <span className={`truncate ${cancelled ? "line-through" : ""}`}>
            {blocked ? "Blocked" : booking.title}
          </span>
        </span>
      ) : (
        booking.players.map((player) => {
          const tone = playerTone(booking, player);
          const dead = cancelled || isDeadPlayer(player);
          return (
            <span
              key={player.id}
              className={`flex min-w-0 flex-1 items-center gap-1 px-1 ${TONE_CLASS[tone]} ${
                dead ? "line-through opacity-70" : ""
              }`}
            >
              <span
                aria-hidden
                className="h-[7px] w-[7px] shrink-0 rounded-full border border-current opacity-70"
              />
              <span className="truncate">
                {/* type 이 아니라 이름으로 가른다. 온라인 예약(0003 `pelham_tee_book`)은
                    예약한 본인까지 type "Guest" 로 저장하므로, type 을 보면 대표자 이름이
                    격자에서 사라진다. 이름 없는 자리만 이탤릭 Guest 다. */}
                {playerLabel(player) === GUEST_NAME ? <em>{GUEST_NAME}</em> : playerLabel(player)}
              </span>
            </span>
          );
        })
      )}
    </button>
  );
}

type OffGridStripProps = {
  title: string;
  hint: string;
  bookings: TeeBooking[];
  selectedId: string | null;
  onSelect: (bookingId: string | null) => void;
  /** 일간 시트에서 렌더 중인가. 색 체계가 뷰마다 다르므로 반드시 넘겨야 한다 (아래 참고). */
  dayTone: boolean;
};

/**
 * 그리드에 놓을 수 없는 예약을 드러내는 스트립. 절대 조용히 버리지 않는다.
 *
 * 칩 색은 **위 격자와 같은 뜻이어야** 한다. 주간 뷰는 예약 단위 색(COLOR_CLASS)을
 * 쓰지만 일간 시트는 그 체계를 무의미하다고 선언했으므로(tone.ts) 같은 스트립이라도
 * 일간에서는 daySurfaceClass 를 쓴다 — 안 그러면 gold 회원 예약이 스트립에서만
 * 게스트 노랑(#ffd400)으로 보여 읽는 사람이 색의 의미를 알 수 없다.
 */
function OffGridStrip({ title, hint, bookings, selectedId, onSelect, dayTone }: OffGridStripProps) {
  if (bookings.length === 0) return null;
  return (
    <section className="mt-3 rounded border border-[#d6d6dc] bg-white p-3 text-xs">
      <h3 className="flex items-center gap-2 font-bold text-[#1f2328]">
        <span className="rounded-sm bg-[#ffd400] px-1.5 py-0.5 text-[10px] text-[#1d232b]">
          {bookings.length}
        </span>
        {title}
      </h3>
      <p className="mt-1 text-[11px] text-[#6b7280]">{hint}</p>
      <ul className="mt-2 flex flex-wrap gap-2">
        {bookings.map((booking) => (
          <li key={booking.id}>
            <button
              type="button"
              onClick={() => onSelect(booking.id)}
              aria-pressed={booking.id === selectedId}
              className={`flex items-center gap-2 rounded-sm border border-[#d6d6dc] px-2 py-1 text-left text-[11px] ${FOCUS_RING} ${
                dayTone ? daySurfaceClass(booking) : COLOR_CLASS[booking.color]
              } ${isDead(booking) ? "line-through opacity-60" : ""} ${
                booking.id === selectedId ? "ring-2 ring-[#111315]" : ""
              }`}
            >
              <span className="font-bold">{booking.title}</span>
              <span className="opacity-90">
                {shortDate(booking.date)} · {booking.time}
              </span>
              <span className="rounded-sm bg-black/15 px-1 text-[10px] font-bold">
                {booking.players.length}/{bookingCapacity(booking)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * 일간 시트의 그린피 꼬리표(레퍼런스의 회색 가격표). 팔 자리가 남은 티타임은 진한 글자,
 * 꽉 찼거나 막힌 티타임은 흐리게 — 프로 샵이 "지금 팔 수 있는 시각" 을 금액 열만 보고 고른다.
 * 공휴일은 주황 테두리. 금액은 서버가 날짜로 정한 값(주중·주말·공휴일, 0025)이다.
 */
function RateTag({ slot, open }: { slot: TeeSlot; open: boolean }) {
  const holiday = slot.dayType === "holiday";
  const kind = slot.dayType ? dayTypeLabel({ dayType: slot.dayType, holiday: slot.holiday ?? null }) : "";
  return (
    <span
      title={`${kind ? `${kind} rate` : "Rate"} ${money(slot.rate)}${open ? "" : " · no open spots"}`}
      className={`flex h-[26px] w-full items-center justify-center bg-[#f2f2f4] pr-1.5 text-[12px] font-semibold tabular-nums ${
        open ? "text-[#1f2328]" : "text-[#c2c5cb]"
      } ${holiday ? "shadow-[inset_0_0_0_1px_#e0a46a]" : ""}`}
      style={{ clipPath: "polygon(0 0, calc(100% - 7px) 0, 100% 50%, calc(100% - 7px) 100%, 0 100%)" }}
    >
      {money(slot.rate)}
    </span>
  );
}
