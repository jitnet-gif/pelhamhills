"use client";

// Indoor Golf Simulator — Bay Sheet (GolfOClock 방식 관리자 화면)
// 가로축 = 베이, 세로축 = 15분 슬롯. 빈 칸 클릭 → 새 예약, 블록 드래그 → 베이/시간 이동.
// 2026-09-30: 꺼진 FastAPI 대신 Supabase 직원 함수(`lib/simulator/api.ts`, 마이그레이션 0007)를
// 부른다. 손님이 `/book/indoor` 에서 잡은 예약도 같은 표라 여기 그대로 보인다.
// 예전 "local sample mode"(가짜 예약)는 없앴다 — 직원이 가짜를 진짜로 읽으면 겹쳐 받는다.

import {
  PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Link from "next/link";

import AdminShell from "@/components/admin/AdminShell";
import BillDrawer from "@/components/pos/BillDrawer";
import BillPanel from "@/components/pos/BillPanel";
import { billActions } from "@/lib/pos/currentBill";
import { BOOK_INDOOR } from "@/lib/nav";
import { ApiError } from "@/lib/teeSheet/api";
import {
  describeSimError,
  RIGHT_HAND_ONLY_BAYS,
  simApi,
  type BayStatus,
  type SimBay as Bay,
  type SimReservation as Reservation,
  type SimSource as ResSource,
  type SimStatus as ResStatus,
} from "@/lib/simulator/api";

type Draft = Omit<Reservation, "id" | "confirmation_code"> & {
  id?: Reservation["id"];
  confirmation_code?: string;
};

// backend/api/routes/simulator.py 와 동일한 운영 규칙
const OPEN_HOUR = 14;
const CLOSE_HOUR = 22;
const SLOT_MIN = 15;
const CLOSED_WEEKDAYS = [1, 2]; // JS: 0=Sun, 1=Mon, 2=Tue
const HST = 0.13;
const ROW_H = 22; // px per 15-min slot
const SLOTS = ((CLOSE_HOUR - OPEN_HOUR) * 60) / SLOT_MIN;

const BAY_TYPE_LABEL: Record<string, string> = {
  right_handed: "Right-Handed",
  left_right: "Right & Left Handed",
  vip: "VIP Lounge",
};

const STATUS_STYLE: Record<ResStatus, { box: string; label: string }> = {
  confirmed: { box: "bg-[#0034c9] text-white", label: "Booked" },
  checked_in: { box: "bg-[#ffd400] text-[#1d232b]", label: "Checked In" },
  paid: { box: "bg-[#16a34a] text-white", label: "Paid" },
  no_show: {
    box: "bg-[#fde2dd] text-[#9e2f20] line-through",
    label: "No Show",
  },
  cancelled: {
    box: "bg-[#ececf0] text-[#8a8f98] line-through",
    label: "Cancelled",
  },
};

const SOURCE_LABEL: Record<ResSource, string> = {
  online: "WEB",
  phone: "PHONE",
  walk_in: "WALK-IN",
  voice_ai: "AI CALL",
};

// ---------- helpers ----------
function toMin(hhmm: string) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}
function fromMin(total: number) {
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
function fmt12(hhmm: string) {
  const [h, m] = hhmm.split(":").map(Number);
  const suffix = h >= 12 ? "PM" : "AM";
  const hh = h % 12 === 0 ? 12 : h % 12;
  return `${hh}:${String(m).padStart(2, "0")} ${suffix}`;
}
function isoDate(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function parseIso(iso: string) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}
function addDays(iso: string, n: number) {
  const d = parseIso(iso);
  d.setDate(d.getDate() + n);
  return isoDate(d);
}
function isClosed(iso: string) {
  return CLOSED_WEEKDAYS.includes(parseIso(iso).getDay());
}
function nextOpen(iso: string) {
  let d = iso;
  for (let i = 0; i < 7 && isClosed(d); i++) d = addDays(d, 1);
  return d;
}
function money(v: number) {
  return `$${v.toFixed(2)}`;
}
function overlaps(
  a: { start: number; end: number },
  b: { start: number; end: number },
) {
  return a.start < b.end && b.start < a.end;
}
// ---------- page ----------
export default function SimulatorSheetPage() {
  const todayIso = useMemo(() => isoDate(new Date()), []);
  const [date, setDate] = useState(() => nextOpen(isoDate(new Date())));
  const [bays, setBays] = useState<Bay[]>([]);
  const [reservations, setReservations] = useState<Reservation[]>([]);
  // false = 마지막 불러오기·저장이 실패했다(노란 배지).
  const [ok, setOk] = useState(true);
  const [message, setMessage] = useState("Loading…");
  const [draft, setDraft] = useState<Draft | null>(null);
  // 예약·빈칸을 열 때마다 1씩 는다(좁은 화면에서 편집 패널로 스크롤하는 신호).
  const [opened, setOpened] = useState(0);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [showCancelled, setShowCancelled] = useState(false);
  const [nowMin, setNowMin] = useState<number | null>(null);
  const [billOpen, setBillOpen] = useState(false);
  // 담은 뒤 서랍의 결제 칸으로 스크롤시키는 값(BillPanel 참고).
  const [revealPayments, setRevealPayments] = useState(0);

  const closed = isClosed(date);

  function fail(prefix: string, err: unknown) {
    setOk(false);
    setMessage(`${prefix}: ${describeSimError(err)}`.slice(0, 200));
  }

  // 베이와 그날의 예약. 날짜를 바꾸면 한 번, 그 뒤로는 1분마다 다시 읽는다 — 손님이 온라인으로
  // 잡은 예약과 다른 기기에서 바꾼 베이 상태가 새로고침 없이 나타나야 겹쳐 받지 않는다.
  // `reload()` 는 이 숫자를 올려 아래 effect 들을 다시 돌린다.
  const [refresh, setRefresh] = useState(0);
  const reload = useCallback(() => setRefresh((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    simApi
      .bays()
      .then((list) => {
        if (!cancelled) setBays(list.filter((b) => b.is_active !== false));
      })
      .catch((err) => {
        if (!cancelled) fail("Couldn't load bays", err);
      });
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  // 베이 상태는 서버(0007 `pelham_sim_bays.status`)가 원본이다. 모든 직원 화면·온라인 예약이 같은 값을 본다.
  const bayState = useMemo<Record<number, BayStatus>>(
    () => Object.fromEntries(bays.map((b) => [b.id, b.status ?? "open"])),
    [bays],
  );

  useEffect(() => {
    let cancelled = false; // 응답이 오는 사이 다른 날로 넘어갔으면 버린다.
    simApi
      .reservations(date)
      .then((list) => {
        if (cancelled) return;
        setReservations(list);
        setOk(true);
        setMessage(
          `Live · updated ${new Date().toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit" })}`,
        );
      })
      .catch((err) => {
        if (!cancelled) fail("Couldn't load reservations", err);
      });
    return () => {
      cancelled = true;
    };
  }, [date, refresh]);

  useEffect(() => {
    const t = setInterval(reload, 60_000);
    return () => clearInterval(t);
  }, [reload]);

  // 날짜를 옮기면 열린 편집과 이전 날의 예약을 먼저 비운다(새 날 응답이 오기 전에 옛 날이 보이지 않게).
  function goTo(next: string) {
    if (next === date) return;
    setDraft(null);
    setReservations([]);
    setDate(next);
  }

  // now-line
  useEffect(() => {
    function tick() {
      const n = new Date();
      setNowMin(n.getHours() * 60 + n.getMinutes());
    }
    tick();
    const t = setInterval(tick, 60_000);
    return () => clearInterval(t);
  }, []);

  // 취소와 노쇼는 베이를 비운다(0007). 기록은 "Show cancelled & no-shows" 로 볼 수 있다.
  const freesBay = (r: Reservation) =>
    r.status === "cancelled" || r.status === "no_show";
  const visible = reservations.filter((r) => showCancelled || !freesBay(r));
  const active = reservations.filter((r) => !freesBay(r));
  const bookedHours = active.reduce((s, r) => s + r.duration_hours, 0);
  const capacityHours = closed ? 0 : bays.length * (CLOSE_HOUR - OPEN_HOUR);
  const utilization = capacityHours
    ? Math.round((bookedHours / capacityHours) * 100)
    : 0;
  const bayById = useMemo(
    () => Object.fromEntries(bays.map((b) => [b.id, b])),
    [bays],
  );
  const revenue = active.reduce(
      (s, r) => s + (bayById[r.bay_id]?.hourly_rate ?? 20) * r.duration_hours,
      0,
    );
  const players = active.reduce((s, r) => s + r.player_count, 0);

  function conflicts(candidate: {
    id?: Reservation["id"];
    bay_id: number;
    start_time: string;
    duration_hours: number;
  }) {
    const a = {
      start: toMin(candidate.start_time),
      end: toMin(candidate.start_time) + candidate.duration_hours * 60,
    };
    return active.some(
      (r) =>
        r.id !== candidate.id &&
        r.bay_id === candidate.bay_id &&
        overlaps(a, {
          start: toMin(r.start_time),
          end: toMin(r.start_time) + r.duration_hours * 60,
        }),
    );
  }
  function withinHours(start: string, hours: number) {
    return (
      toMin(start) >= OPEN_HOUR * 60 &&
      toMin(start) + hours * 60 <= CLOSE_HOUR * 60
    );
  }
  function maxHoursFrom(bay_id: number, start: string, id?: Reservation["id"]) {
    let h = 0;
    for (let n = 1; n <= 4; n++) {
      if (
        !withinHours(start, n) ||
        conflicts({ id, bay_id, start_time: start, duration_hours: n })
      )
        break;
      h = n;
    }
    return h;
  }

  // ---------- actions ----------
  function openNew(bay_id: number, start: string) {
    if (closed) return;
    if (bayState[bay_id] && bayState[bay_id] !== "open") {
      setMessage(
        `Bay ${bayById[bay_id]?.bay_number} is ${bayState[bay_id]} — set it to Open first.`,
      );
      return;
    }
    if (maxHoursFrom(bay_id, start) < 1) {
      setMessage("Not enough free time from that slot (min 1 hour).");
      return;
    }
    setConfirmCancel(false);
    // 1분 주기를 기다리지 않고 그날 예약을 다시 읽는다 — 방금 들어온 온라인 예약도 막히게.
    reload();
    setDraft({
      bay_id,
      date,
      start_time: start,
      duration_hours: 1,
      player_count: 2,
      customer_name: "",
      customer_email: "",
      phone: "",
      notes: "",
      status: "confirmed",
      source: "walk_in",
    });
    setOpened((n) => n + 1);
  }

  function openExisting(r: Reservation) {
    setConfirmCancel(false);
    setDraft({ ...r });
    setOpened((n) => n + 1);
  }

  async function saveDraft() {
    if (!draft) return;
    if (!draft.customer_name.trim()) {
      setMessage("Customer name is required.");
      return;
    }
    if (!withinHours(draft.start_time, draft.duration_hours)) {
      setMessage("Reservation must end by 10:00 PM.");
      return;
    }
    if (conflicts(draft)) {
      setMessage("That bay is already booked for part of this time.");
      return;
    }

    const { id, ...rest } = draft;
    delete rest.confirmation_code;
    const fields = rest;
    try {
      if (id === undefined) {
        const created = await simApi.create(fields);
        setReservations((cur) => [...cur, created]);
      } else {
        const updated = await simApi.update(id, fields);
        setReservations((cur) => cur.map((r) => (r.id === id ? updated : r)));
      }
      setOk(true);
      setMessage("Saved");
      setDraft(null);
    } catch (err) {
      fail("Save failed", err);
      // 409 = 그 사이 다른 사람(대개 온라인 손님)이 그 베이를 잡았다. 표를 새로 읽어 보여 준다.
      if (err instanceof ApiError && err.status === 409) reload();
    }
  }

  async function patchReservation(
    id: Reservation["id"],
    patch: Partial<Reservation>,
    note: string,
  ) {
    try {
      const updated = await simApi.update(id, patch);
      setReservations((cur) => cur.map((r) => (r.id === id ? updated : r)));
      setDraft((d) => (d && d.id === id ? { ...d, ...updated } : d));
      setOk(true);
      setMessage(note);
    } catch (err) {
      fail("Update failed", err);
      if (err instanceof ApiError && err.status === 409) reload();
    }
  }

  // 손님이 와서 낸다: 예약을 지금 계산서에 담고 결제 서랍을 연다. 담기에 실패해도 서랍은
  // 연다 — 오류 문구(이미 다른 계산서에 있음 등)가 서랍 안 BillPanel 에 뜬다.
  async function payReservation(id: Reservation["id"]) {
    const bill = await billActions.addSim(Number(id));
    setBillOpen(true);
    if (bill) setRevealPayments((n) => n + 1);
  }

  async function changeBayStatus(bay: Bay, status: BayStatus) {
    try {
      const updated = await simApi.setBayStatus(bay.id, status);
      setBays((cur) => cur.map((b) => (b.id === bay.id ? updated : b)));
      setOk(true);
      // 점검으로 돌리면 이미 잡힌 예약은 남는다 — 옮겨야 할 건수를 알려 준다.
      const stuck = active.filter((r) => r.bay_id === bay.id).length;
      setMessage(
        status === "maintenance" && stuck
          ? `Bay ${bay.bay_number} under maintenance — ${stuck} booking${stuck > 1 ? "s" : ""} on this day still need moving`
          : `Bay ${bay.bay_number} set to ${status}`,
      );
    } catch (err) {
      fail("Couldn't change bay status", err);
    }
  }

  // ---------- drag to move ----------
  const gridRef = useRef<HTMLDivElement>(null);
  const drawerRef = useRef<HTMLElement>(null);

  // xl 보다 좁으면(iPad) 편집 패널이 그리드 아래로 내려간다. 예약을 열면 거기로 스크롤해
  // 준다 — 안 하면 화면 밖에서 열려 탭이 먹지 않은 것처럼 보인다.
  useEffect(() => {
    if (!opened || !drawerRef.current) return;
    if (!window.matchMedia("(max-width: 1279px)").matches) return;
    drawerRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [opened]);
  const [drag, setDrag] = useState<{
    id: Reservation["id"];
    startX: number;
    startY: number;
    slop: number;
    moved: boolean;
    bay_id: number;
    start_time: string;
    ok: boolean;
  } | null>(null);

  function locate(clientX: number, clientY: number) {
    const el = gridRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const col = Math.floor(((clientX - rect.left) / rect.width) * bays.length);
    const slot = Math.floor((clientY - rect.top) / ROW_H);
    if (col < 0 || col >= bays.length || slot < 0 || slot >= SLOTS) return null;
    return { bay_id: bays[col].id, slot };
  }

  function onBlockDown(e: ReactPointerEvent, r: Reservation) {
    if (r.status === "cancelled") return openExisting(r);
    // 블록 자체(currentTarget)가 포인터를 잡아야 한다. 안쪽 글자(span)가 잡으면 그 글자가
    // 다시 그려질 때 캡처가 풀려 드래그가 중간에 끊긴다.
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({
      id: r.id,
      startX: e.clientX,
      startY: e.clientY,
      // 손가락은 탭하는 동안에도 몇 px 흔들린다. 마우스 기준(6px)을 쓰면 iPad 에서 탭이
      // 드래그로 잡혀 예약이 열리지 않는다.
      slop: e.pointerType === "mouse" ? 6 : 14,
      moved: false,
      bay_id: r.bay_id,
      start_time: r.start_time,
      ok: true,
    });
  }

  function onBlockMove(e: ReactPointerEvent, r: Reservation) {
    if (!drag || drag.id !== r.id) return;
    const moved =
      drag.moved ||
      Math.abs(e.clientX - drag.startX) + Math.abs(e.clientY - drag.startY) >
        drag.slop;
    if (!moved) return;
    // 블록의 윗부분을 잡은 위치를 유지하기 위해 이동량 기준으로 계산
    const dy = Math.round((e.clientY - drag.startY) / ROW_H);
    const hit = locate(e.clientX, e.clientY);
    const bay_id = hit ? hit.bay_id : drag.bay_id;
    const start = Math.min(
      Math.max(toMin(r.start_time) + dy * SLOT_MIN, OPEN_HOUR * 60),
      CLOSE_HOUR * 60 - r.duration_hours * 60,
    );
    const start_time = fromMin(start);
    const ok =
      bayState[bay_id] !== "cleaning" &&
      bayState[bay_id] !== "maintenance" &&
      !conflicts({
        id: r.id,
        bay_id,
        start_time,
        duration_hours: r.duration_hours,
      });
    setDrag({ ...drag, moved: true, bay_id, start_time, ok });
  }

  function onBlockUp(r: Reservation) {
    if (!drag || drag.id !== r.id) return;
    const d = drag;
    setDrag(null);
    // 제자리에 내려놓았으면 탭으로 본다.
    if (!d.moved || (d.bay_id === r.bay_id && d.start_time === r.start_time))
      return openExisting(r);
    if (!d.ok) {
      setMessage(
        "Can't move there — overlaps another booking or the bay is unavailable.",
      );
      return;
    }
    patchReservation(
      r.id,
      { bay_id: d.bay_id, start_time: d.start_time },
      `Moved ${r.customer_name} → Bay ${bayById[d.bay_id]?.bay_number} at ${fmt12(d.start_time)}`,
    );
  }

  // ---------- render helpers ----------
  const hours = Array.from(
    { length: CLOSE_HOUR - OPEN_HOUR },
    (_, i) => OPEN_HOUR + i,
  );
  const dateLabel = parseIso(date).toLocaleDateString("en-CA", {
    weekday: "long",
    month: "short",
    year: "numeric",
  });
  const dayNum = parseIso(date).getDate();
  const showNow =
    date === todayIso &&
    nowMin !== null &&
    nowMin >= OPEN_HOUR * 60 &&
    nowMin <= CLOSE_HOUR * 60;
  const draftBay = draft ? bayById[draft.bay_id] : undefined;
  const subtotal =
    draft && draftBay ? draftBay.hourly_rate * draft.duration_hours : 0;
  const draftMaxHours = draft
    ? maxHoursFrom(draft.bay_id, draft.start_time, draft.id)
    : 1;
  // 편집 패널의 Bay·Start 도 그날의 기존 예약을 본다 — 이미 찬 베이·시각은 고를 수 없다.
  // 자기 자신(draft.id)은 빼고 본다. 옮기는 중인 예약이 제 자리를 막지 않게.
  function bayBlocked(bay_id: number) {
    if (!draft) return false;
    if (bayState[bay_id] && bayState[bay_id] !== "open") return true;
    return maxHoursFrom(bay_id, draft.start_time, draft.id) < 1;
  }
  function startBlocked(start: string) {
    if (!draft) return false;
    return maxHoursFrom(draft.bay_id, start, draft.id) < 1;
  }
  // 베이나 시작 시각을 바꾸면 그 자리에서 가능한 만큼으로 시간을 줄인다.
  function moveDraft(next: { bay_id?: number; start_time?: string }) {
    if (!draft) return;
    const bay_id = next.bay_id ?? draft.bay_id;
    const start_time = next.start_time ?? draft.start_time;
    const max = maxHoursFrom(bay_id, start_time, draft.id);
    setDraft({
      ...draft,
      bay_id,
      start_time,
      duration_hours: Math.max(1, Math.min(draft.duration_hours, max)),
    });
  }
  const startOptions = Array.from({ length: SLOTS }, (_, i) =>
    fromMin(OPEN_HOUR * 60 + i * SLOT_MIN),
  );

  return (
    <AdminShell
      actions={
        <>
          <Link
            className="border border-[#d7d7dc] px-3 py-1.5 text-xs font-bold"
            href={BOOK_INDOOR}
          >
            Online Booking Page
          </Link>
          <button
            className="bg-[#4533ff] px-4 py-1.5 text-xs font-bold text-white disabled:opacity-40"
            disabled={closed}
            onClick={() => {
              const firstOpenBay = bays.find(
                (b) => (bayState[b.id] ?? "open") === "open",
              );
              if (!firstOpenBay) return;
              const base =
                date === todayIso && nowMin
                  ? Math.ceil(nowMin / SLOT_MIN) * SLOT_MIN
                  : OPEN_HOUR * 60;
              openNew(firstOpenBay.id, fromMin(Math.max(base, OPEN_HOUR * 60)));
            }}
          >
            Add Walk-in +
          </button>
        </>
      }
      title="Indoor Golf Simulator · Bay Sheet"
    >
      <div className="grid min-w-0 grid-rows-[auto_1fr]">
        {/* stats + date nav */}
        <section className="border-b border-[#d4d4d8] bg-white px-4 py-3">
          <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
            <div className="flex flex-wrap items-center gap-3 text-xs">
              <span className="rounded bg-[#111315] px-2 py-1 text-white">
                {active.length} Reservations
              </span>
              <span>{players} Players</span>
              <span>
                {bookedHours}h / {capacityHours}h booked
              </span>
              <span className="font-bold">{utilization}% utilization</span>
              <span>{money(revenue)} before tax</span>
              <span
                className={`rounded px-2 py-1 ${ok ?"bg-[#dbf5e3] text-[#126c31]" : "bg-[#fff3cd] text-[#8a5b00]"}`}
              >
                {message}
              </span>
            </div>
            <div className="flex items-center gap-3">
              <button
                aria-label="Previous day"
                className="border border-[#d7d7dc] px-2 py-1 text-xs font-bold"
                onClick={() => goTo(addDays(date, -1))}
              >
                ‹
              </button>
              <div className="text-center">
                <p className="text-3xl font-semibold leading-none">{dayNum}</p>
                <p className="text-xs font-semibold">{dateLabel}</p>
              </div>
              <button
                aria-label="Next day"
                className="border border-[#d7d7dc] px-2 py-1 text-xs font-bold"
                onClick={() => goTo(addDays(date, 1))}
              >
                ›
              </button>
            </div>
            <div className="flex items-center gap-2 text-xs">
              <button
                className="border border-[#d7d7dc] px-3 py-1.5 font-bold"
                onClick={() => goTo(nextOpen(todayIso))}
              >
                Today
              </button>
              <input
                className="border border-[#d7d7dc] px-2 py-1"
                id="sim-date"
                onChange={(e) => e.target.value && goTo(e.target.value)}
                type="date"
                value={date}
              />
              <label className="flex items-center gap-1">
                <input
                  checked={showCancelled}
                  id="sim-show-cancelled"
                  onChange={(e) => setShowCancelled(e.target.checked)}
                  type="checkbox"
                />
                Show cancelled &amp; no-shows
              </label>
            </div>
          </div>
        </section>

        {/* grid + drawer */}
        <section className="grid min-w-0 gap-0 xl:grid-cols-[1fr_320px]">
          <div className="min-w-0 overflow-auto p-4">
            {closed ? (
              <div className="grid place-items-center gap-3 rounded border border-[#d6d6dc] bg-white p-10 text-center">
                <p className="text-lg font-bold">
                  Simulators are closed on Mondays and Tuesdays
                </p>
                <p className="text-sm text-[#5d6673]">
                  Hours: Wednesday – Sunday, 2:00 PM – 10:00 PM
                </p>
                <button
                  className="bg-[#4533ff] px-4 py-2 text-xs font-bold text-white"
                  onClick={() => goTo(nextOpen(date))}
                >
                  Go to next open day
                </button>
              </div>
            ) : (
              <div
                className="rounded border border-[#d6d6dc] bg-white"
                style={{ minWidth: 64 + bays.length * 170 }}
              >
                {/* bay header */}
                <div
                  className="grid border-b border-[#d6d6dc] bg-[#d7d5da] text-xs"
                  style={{
                    gridTemplateColumns: `64px repeat(${bays.length}, 1fr)`,
                  }}
                >
                  <div className="p-2 font-bold">Time</div>
                  {bays.map((b) => {
                    const st = bayState[b.id] ?? "open";
                    return (
                      <div className="border-l border-[#c9c7cc] p-2" key={b.id}>
                        <div className="flex items-center justify-between">
                          <span className="font-bold">Bay {b.bay_number}</span>
                          <span className="text-[#5d6673]">
                            {money(b.hourly_rate)}/h
                          </span>
                        </div>
                        <div className="mt-1 flex items-center justify-between gap-1">
                          <span className="truncate text-[11px] text-[#4e5560]">
                            {RIGHT_HAND_ONLY_BAYS.includes(b.bay_number)
                              ? BAY_TYPE_LABEL.right_handed
                              : BAY_TYPE_LABEL[b.bay_type] ?? b.bay_type}
                          </span>
                          <select
                            aria-label={`Bay ${b.bay_number} status`}
                            className={`rounded px-1 py-0.5 text-[10px] font-bold ${
                              st === "open"
                                ? "bg-[#dbf5e3] text-[#126c31]"
                                : st === "cleaning"
                                  ? "bg-[#fff3cd] text-[#8a5b00]"
                                  : "bg-[#fde2dd] text-[#9e2f20]"
                            }`}
                            id={`bay-state-${b.id}`}
                            onChange={(e) =>
                              void changeBayStatus(b, e.target.value as BayStatus)
                            }
                            value={st}
                          >
                            <option value="open">Open</option>
                            <option value="cleaning">Cleaning</option>
                            <option value="maintenance">Maintenance</option>
                          </select>
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* body */}
                <div
                  className="grid"
                  style={{ gridTemplateColumns: `64px 1fr` }}
                >
                  {/* time labels */}
                  <div>
                    {hours.map((h) => (
                      <div
                        className="border-b border-[#d6d6dc] px-2 text-[11px] font-semibold text-[#4e5560]"
                        key={h}
                        style={{ height: ROW_H * 4 }}
                      >
                        {fmt12(`${String(h).padStart(2, "0")}:00`)}
                      </div>
                    ))}
                  </div>

                  {/* bay columns */}
                  <div
                    className="relative"
                    ref={gridRef}
                    style={{ height: SLOTS * ROW_H }}
                  >
                    <div
                      className="absolute inset-0 grid"
                      style={{
                        gridTemplateColumns: `repeat(${bays.length}, 1fr)`,
                      }}
                    >
                      {bays.map((b) => {
                        const st = bayState[b.id] ?? "open";
                        return (
                          <div
                            className={`border-l border-[#e3e3e8] ${st !== "open" ? "bg-[repeating-linear-gradient(135deg,#f4f4f6_0_8px,#ececf0_8px_16px)]" : ""}`}
                            key={b.id}
                          >
                            {startOptions.map((t, i) => (
                              <button
                                aria-label={`Book Bay ${b.bay_number} at ${fmt12(t)}`}
                                className={`block w-full hover:bg-[#eef0ff] ${i % 4 === 3 ? "border-b border-[#d6d6dc]" : "border-b border-dashed border-[#f0f0f3]"}`}
                                key={t}
                                onClick={() => openNew(b.id, t)}
                                style={{ height: ROW_H }}
                              />
                            ))}
                          </div>
                        );
                      })}
                    </div>

                    {/* now line */}
                    {showNow && nowMin !== null && (
                      <div
                        className="pointer-events-none absolute left-0 right-0 z-20 border-t-2 border-[#e11d48]"
                        style={{
                          top: ((nowMin - OPEN_HOUR * 60) / SLOT_MIN) * ROW_H,
                        }}
                      >
                        <span className="absolute -top-2 left-0 rounded bg-[#e11d48] px-1 text-[9px] font-bold text-white">
                          NOW
                        </span>
                      </div>
                    )}

                    {/* reservations */}
                    {visible.map((r) => {
                      const isDrag = drag?.id === r.id && drag.moved;
                      const bayId = isDrag ? drag.bay_id : r.bay_id;
                      const start = isDrag ? drag.start_time : r.start_time;
                      const col = bays.findIndex((b) => b.id === bayId);
                      if (col < 0) return null;
                      const top =
                        ((toMin(start) - OPEN_HOUR * 60) / SLOT_MIN) * ROW_H;
                      const height = r.duration_hours * 4 * ROW_H;
                      const s = STATUS_STYLE[r.status];
                      const selected = draft?.id === r.id;
                      return (
                        <div
                          className={`absolute z-10 cursor-grab touch-none select-none overflow-hidden rounded-sm px-2 py-1 text-[11px] leading-4 shadow-sm ${s.box} ${
                            selected ? "ring-2 ring-[#111315]" : ""
                          } ${isDrag ? (drag.ok ? "opacity-80 ring-2 ring-[#4533ff]" : "opacity-80 ring-2 ring-[#e11d48]") : ""}`}
                          key={r.id}
                          onPointerDown={(e) => onBlockDown(e, r)}
                          onPointerMove={(e) => onBlockMove(e, r)}
                          onPointerUp={() => onBlockUp(r)}
                          // 스크롤·알림 등으로 드래그가 취소되면 제자리로 돌린다.
                          // 안 하면 블록이 옮기던 자리에 떠 있는 채로 남는다.
                          onPointerCancel={() => setDrag(null)}
                          role="button"
                          style={{
                            top: top + 1,
                            height: height - 2,
                            left: `calc(${(col / bays.length) * 100}% + 3px)`,
                            width: `calc(${100 / bays.length}% - 6px)`,
                          }}
                          tabIndex={0}
                          onKeyDown={(e) =>
                            e.key === "Enter" && openExisting(r)
                          }
                        >
                          <div className="flex items-center justify-between gap-1 font-bold">
                            <span className="truncate">
                              ● {r.customer_name}
                            </span>
                            <span className="shrink-0 rounded bg-black/15 px-1 text-[9px]">
                              {SOURCE_LABEL[r.source ?? "online"]}
                            </span>
                          </div>
                          <div className="truncate opacity-90">
                            {fmt12(start)} · {r.duration_hours}h · 👥{" "}
                            {r.player_count}
                          </div>
                          {height > 60 && (
                            <div className="truncate opacity-80">
                              {s.label} · #{r.confirmation_code}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}

            <div className="mt-3 flex flex-wrap gap-3 text-[11px] text-[#4e5560]">
              {(Object.keys(STATUS_STYLE) as ResStatus[]).map((k) => (
                <span className="flex items-center gap-1" key={k}>
                  <span
                    className={`inline-block h-3 w-4 rounded-sm ${STATUS_STYLE[k].box}`}
                  />{" "}
                  {STATUS_STYLE[k].label}
                </span>
              ))}
              <span>
                · Click an empty slot to book · Drag a booking to move it
              </span>
            </div>
          </div>

          {/* drawer */}
          <aside
            className="scroll-mt-4 border-l border-[#d4d4d8] bg-[#dedee2] p-3"
            ref={drawerRef}
          >
            {!draft ? (
              <div className="grid gap-3 text-xs">
                <p className="font-bold">Bay status now</p>
                {bays.map((b) => {
                  const cur =
                    date === todayIso && nowMin !== null
                      ? active.find(
                          (r) =>
                            r.bay_id === b.id &&
                            toMin(r.start_time) <= nowMin &&
                            nowMin <
                              toMin(r.start_time) + r.duration_hours * 60,
                        )
                      : undefined;
                  const next = active
                    .filter(
                      (r) =>
                        r.bay_id === b.id &&
                        (!nowMin ||
                          date !== todayIso ||
                          toMin(r.start_time) > nowMin),
                    )
                    .sort(
                      (a, c) => toMin(a.start_time) - toMin(c.start_time),
                    )[0];
                  return (
                    <div
                      className="border border-[#c7c7cc] bg-white p-2"
                      key={b.id}
                    >
                      <div className="flex justify-between font-bold">
                        <span>Bay {b.bay_number}</span>
                        <span
                          className={cur ? "text-[#0034c9]" : "text-[#126c31]"}
                        >
                          {cur
                            ? "In use"
                            : (bayState[b.id] ?? "open") === "open"
                              ? "Free"
                              : bayState[b.id]}
                        </span>
                      </div>
                      <p className="mt-1 text-[#5d6673]">
                        {cur
                          ? `${cur.customer_name} until ${fmt12(fromMin(toMin(cur.start_time) + cur.duration_hours * 60))}`
                          : next
                            ? `Next: ${next.customer_name} at ${fmt12(next.start_time)}`
                            : "No more bookings"}
                      </p>
                    </div>
                  );
                })}
                <p className="text-[11px] text-[#5d6673]">
                  Select a booking or an empty slot to edit.
                </p>
              </div>
            ) : (
              <div className="grid gap-2 text-xs">
                <div className="flex items-center justify-between">
                  <span className="font-bold">
                    {draft.id === undefined
                      ? "New Reservation"
                      : `#${draft.confirmation_code}`}
                  </span>
                  <button
                    aria-label="Close"
                    className="px-2 text-lg leading-none"
                    onClick={() => setDraft(null)}
                  >
                    ×
                  </button>
                </div>
                {draft.id !== undefined && (
                  <span
                    className={`w-fit rounded px-2 py-0.5 font-bold ${STATUS_STYLE[draft.status].box}`}
                  >
                    {STATUS_STYLE[draft.status].label}
                  </span>
                )}

                <label className="grid gap-1">
                  Customer name
                  <input
                    className="border border-[#c7c7cc] bg-white px-2 py-1"
                    id="sim-name"
                    onChange={(e) =>
                      setDraft({ ...draft, customer_name: e.target.value })
                    }
                    placeholder="Last, First"
                    value={draft.customer_name}
                  />
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <label className="grid gap-1">
                    Phone
                    <input
                      className="border border-[#c7c7cc] bg-white px-2 py-1"
                      id="sim-phone"
                      onChange={(e) =>
                        setDraft({ ...draft, phone: e.target.value })
                      }
                      placeholder="+1 905 …"
                      value={draft.phone}
                    />
                  </label>
                  <label className="grid gap-1">
                    Players
                    <select
                      className="border border-[#c7c7cc] bg-white px-2 py-1"
                      id="sim-players"
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          player_count: Number(e.target.value),
                        })
                      }
                      value={draft.player_count}
                    >
                      {/* 0003/0007 의 한도(1–4명)와 같다. */}
                      {[1, 2, 3, 4].map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <label className="grid gap-1">
                  Email
                  <input
                    className="border border-[#c7c7cc] bg-white px-2 py-1"
                    id="sim-email"
                    onChange={(e) =>
                      setDraft({ ...draft, customer_email: e.target.value })
                    }
                    placeholder="optional for walk-ins"
                    value={draft.customer_email}
                  />
                </label>
                <div className="grid grid-cols-3 gap-2">
                  <label className="grid gap-1">
                    Bay
                    <select
                      className="border border-[#c7c7cc] bg-white px-1 py-1"
                      id="sim-bay"
                      onChange={(e) => moveDraft({ bay_id: Number(e.target.value) })}
                      value={draft.bay_id}
                    >
                      {bays.map((b) => {
                        const st = bayState[b.id] ?? "open";
                        const blocked = bayBlocked(b.id);
                        return (
                          <option
                            disabled={blocked && b.id !== draft.bay_id}
                            key={b.id}
                            value={b.id}
                          >
                            Bay {b.bay_number}
                            {blocked ? (st !== "open" ? ` · ${st}` : " · booked") : ""}
                          </option>
                        );
                      })}
                    </select>
                  </label>
                  <label className="grid gap-1">
                    Start
                    <select
                      className="border border-[#c7c7cc] bg-white px-1 py-1"
                      id="sim-start"
                      onChange={(e) => moveDraft({ start_time: e.target.value })}
                      value={draft.start_time}
                    >
                      {startOptions.map((t) => {
                        const blocked = startBlocked(t);
                        return (
                          <option
                            disabled={blocked && t !== draft.start_time}
                            key={t}
                            value={t}
                          >
                            {fmt12(t)}
                            {blocked ? " · booked" : ""}
                          </option>
                        );
                      })}
                    </select>
                  </label>
                  <label className="grid gap-1">
                    Hours
                    <select
                      className="border border-[#c7c7cc] bg-white px-1 py-1"
                      id="sim-hours"
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          duration_hours: Number(e.target.value),
                        })
                      }
                      value={draft.duration_hours}
                    >
                      {[1, 2, 3, 4].map((n) => (
                        <option
                          disabled={n > draftMaxHours && n !== draft.duration_hours}
                          key={n}
                          value={n}
                        >
                          {n}h
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <label className="grid gap-1">
                  Source
                  <select
                    className="border border-[#c7c7cc] bg-white px-2 py-1"
                    id="sim-source"
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        source: e.target.value as ResSource,
                      })
                    }
                    value={draft.source}
                  >
                    <option value="walk_in">Walk-in</option>
                    <option value="phone">Phone</option>
                    <option value="online">Online</option>
                    <option value="voice_ai">AI Call</option>
                  </select>
                </label>
                <label className="grid gap-1">
                  Notes
                  <textarea
                    className="border border-[#c7c7cc] bg-white px-2 py-1"
                    id="sim-notes"
                    onChange={(e) =>
                      setDraft({ ...draft, notes: e.target.value })
                    }
                    rows={2}
                    value={draft.notes}
                  />
                </label>

                <div className="grid gap-1 border border-[#c7c7cc] bg-white p-2">
                  <div className="flex justify-between">
                    <span>
                      Bay {draftBay?.bay_number} · {draft.duration_hours}h ×{" "}
                      {money(draftBay?.hourly_rate ?? 0)}
                    </span>
                    <span>{money(subtotal)}</span>
                  </div>
                  <div className="flex justify-between text-[#5d6673]">
                    <span>HST 13%</span>
                    <span>{money(subtotal * HST)}</span>
                  </div>
                  <div className="flex justify-between border-t pt-1 font-bold">
                    <span>Total</span>
                    <span>{money(subtotal * (1 + HST))}</span>
                  </div>
                  <p className="text-[10px] text-[#5d6673]">
                    {fmt12(draft.start_time)} –{" "}
                    {fmt12(
                      fromMin(
                        toMin(draft.start_time) + draft.duration_hours * 60,
                      ),
                    )}
                  </p>
                </div>

                {draft.id !== undefined && draft.status !== "cancelled" && (
                  <div className="grid grid-cols-3 gap-1">
                    <button
                      className="border border-[#c7c7cc] bg-white px-1 py-1.5 font-bold"
                      onClick={() =>
                        patchReservation(
                          draft.id!,
                          { status: "checked_in" },
                          "Checked in",
                        )
                      }
                    >
                      Check In
                    </button>
                    {/* 결제는 계산서로만(0008). 예약은 계산서가 결제될 때 서버가 paid 로 바꾼다. */}
                    <button
                      className="bg-[#16a34a] px-1 py-1.5 font-bold text-white disabled:opacity-60"
                      disabled={draft.status === "paid"}
                      onClick={() => void payReservation(draft.id!)}
                      title={
                        draft.status === "paid"
                          ? "Paid on a bill. Refund that bill in Reports → Daily close to undo."
                          : "Put this booking on the bill and take payment"
                      }
                    >
                      {draft.status === "paid" ? "Paid ✓" : "Pay"}
                    </button>
                    <button
                      className="border border-[#c47a63] bg-white px-1 py-1.5 font-bold text-[#8a3f26]"
                      onClick={() =>
                        patchReservation(
                          draft.id!,
                          { status: "no_show" },
                          "Marked no-show",
                        )
                      }
                    >
                      No Show
                    </button>
                  </div>
                )}

                <div className="flex gap-2">
                  {draft.id !== undefined &&
                    draft.status !== "cancelled" &&
                    !confirmCancel && (
                      <button
                        className="flex-1 border border-[#c47a63] bg-white px-2 py-2 font-bold text-[#8a3f26]"
                        onClick={() => setConfirmCancel(true)}
                      >
                        Cancel booking
                      </button>
                    )}
                  {confirmCancel && (
                    <button
                      className="flex-1 bg-[#b42318] px-2 py-2 font-bold text-white"
                      onClick={() => {
                        setConfirmCancel(false);
                        patchReservation(
                          draft.id!,
                          { status: "cancelled" },
                          "Booking cancelled",
                        );
                      }}
                    >
                      Confirm cancel
                    </button>
                  )}
                  <button
                    className="flex-1 bg-[#4533ff] px-2 py-2 font-bold text-white"
                    onClick={saveDraft}
                  >
                    {draft.id === undefined ? "Book" : "Save"}
                  </button>
                </div>
                <p className="text-[10px] leading-4 text-[#5d6673]">
                  Guests can change or cancel online, by phone or by text until 24h
                  before start. After that, only staff can.
                </p>
              </div>
            )}
          </aside>
        </section>
      </div>

      {billOpen ? (
        <BillDrawer
          onClose={() => {
            setBillOpen(false);
            setRevealPayments(0);
          }}
        >
          <BillPanel
            onPaid={() => {
              // 서버가 예약을 paid 로 바꿨다. 열린 편집 칸은 옛 상태라 닫고 표를 새로 읽는다.
              setDraft(null);
              reload();
            }}
            revealPayments={revealPayments}
            station="simulator"
          />
        </BillDrawer>
      ) : null}
    </AdminShell>
  );
}
