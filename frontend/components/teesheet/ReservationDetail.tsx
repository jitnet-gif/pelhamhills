"use client";

// 예약 상세 패널 (Reservation Detail).
//
// 레이아웃은 pelhamhills 의 하단 패널을 그대로 따른다:
//   ┌ 헤더 줄: ☎ 확인코드 · 홀 수 · 날짜 · 시각 ······ [Cancel] [Save]
//   ├ 왼쪽 아이콘 레일 │ 플레이어 카드 가로 나열
//   └ 노란 메모 줄
//
// 예전에는 **예약 단위**로 편집하는 화면이었다 (Title / Notes / Holes / Rate / Carts
// 한 묶음 + Check In All · Collect All · Mark No Show · Reopen 네 버튼). 레퍼런스는
// 그 반대로 **플레이어 단위**다 — 요금제도, 도착 여부도, 받을 돈도 사람마다 다르기
// 때문이다. 그래서 예약 단위로만 남은 것은 홀 수 · 날짜 · 시각 · 메모 넷뿐이고
// 나머지는 전부 카드 안으로 들어갔다.
//
// 모든 서버 호출은 controller 를 통해서만 한다. 이 파일에서 fetch 를 직접 부르지 않는다.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import Link from "next/link";

import { type Bill, posApi, type TeeBill } from "@/lib/pos/api";
import { billActions, getBillState, useCurrentBill } from "@/lib/pos/currentBill";
import { localBusinessDate } from "@/lib/retail/api";
import { printReceiptDoc, receiptSheetHtml } from "@/lib/retail/printReceipt";
import { CLUB_TIME_ZONE, PAYMENT_LABELS, saleReceipt } from "@/lib/retail/receipt";
import { computeTax, formatMoney } from "@/lib/retail/types";
import { longDate, money } from "@/lib/teeSheet/dates";
import { clubDate, confirmationCode, paidBillFor, teeReceiptFor } from "@/lib/teeSheet/receipt";
import { reservationTitle } from "@/lib/teeSheet/tone";
import type {
  AuditEntry,
  PatchBookingInput,
  PatchPlayerInput,
  Player,
  TeeBooking,
  TeeSheetController,
} from "@/lib/teeSheet/types";

import RainCheckDialog, { activeRainCheck, useRainChecks } from "./RainCheckDialog";

export type ReservationDetailProps = { controller: TeeSheetController };

// ===== constants =====

const MAX_PLAYERS = 4;
const PLAYER_DEBOUNCE_MS = 700;
const SAVED_FLASH_MS = 1800;

const CANCEL_PRESETS = [
  "Weather / course closed",
  "Guest requested cancellation",
  "Course maintenance",
  "No contact — released slot",
];

/**
 * 요금제 목록. 백엔드의 `ratePlan` 은 자유 문자열이지만 화면에서는 고르게 한다 —
 * 레퍼런스가 드롭다운이고, 무엇보다 `tone.ts` 의 색 규칙이 "Full Member" 라는
 * **정확한 접두사**를 보기 때문이다. 자유 입력이면 "full member" 같은 오타 하나로
 * 격자의 색이 조용히 달라진다.
 *
 * 서버가 목록에 없는 값을 들고 있으면 그 값을 그대로 한 항목 더 붙인다(아래 참고) —
 * 고르지 않았는데 저장 버튼 한 번에 값이 바뀌어 버리는 일이 없어야 한다.
 */
const RATE_PLANS = [
  "Public",
  "Public Senior",
  "Weekday Member - Single",
  "Weekday Member - Single with Weekday Cart",
  "Full Member - Single with 7 Day Cart",
  "GolfNow",
];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ===== local helpers =====

type PlayerDraft = { firstName: string; lastName: string; phone: string; email: string };
/** 예약 단위로 남은 편집 대상. Title·Carts 는 레퍼런스 패널에 없어서 빠졌다. */
type BookingDraft = { holes: 9 | 18; rate: string; notes: string };
type SaveState = { kind: "idle" | "saving" | "saved"; nonce: number };
type PanelMode = "none" | "cancel" | "delete";

function playerDraftOf(player: Player): PlayerDraft {
  return {
    firstName: player.firstName ?? "",
    lastName: player.lastName ?? "",
    phone: player.phone ?? "",
    email: player.email ?? "",
  };
}

function bookingDraftOf(booking: TeeBooking): BookingDraft {
  return {
    holes: booking.holes,
    rate: String(booking.rate),
    notes: booking.notes ?? "",
  };
}

function playerPatchFrom(player: Player, draft: PlayerDraft): PatchPlayerInput {
  const patch: PatchPlayerInput = {};
  if (draft.firstName !== (player.firstName ?? "")) patch.firstName = draft.firstName;
  if (draft.lastName !== (player.lastName ?? "")) patch.lastName = draft.lastName;
  if (draft.phone !== (player.phone ?? "")) patch.phone = draft.phone;
  if (draft.email !== (player.email ?? "")) patch.email = draft.email;
  return patch;
}

function bookingPatchFrom(booking: TeeBooking, draft: BookingDraft): PatchBookingInput {
  const patch: PatchBookingInput = {};
  if (draft.holes !== booking.holes) patch.holes = draft.holes;
  const rate = Number(draft.rate);
  if (draft.rate.trim() !== "" && Number.isFinite(rate) && rate >= 0 && rate !== booking.rate) {
    patch.rate = rate;
  }
  if (draft.notes !== (booking.notes ?? "")) patch.notes = draft.notes;
  return patch;
}

/** "3 minutes ago" — audit 타임스탬프는 ISO datetime 이므로 dates.ts 의 toDate 를 쓸 수 없다. */
function relativeTime(ts: string): string {
  const t = new Date(ts).getTime();
  if (!Number.isFinite(t)) return ts;
  const diff = Date.now() - t;
  if (diff < 0) return "just now";
  const seconds = Math.floor(diff / 1000);
  if (seconds < 45) return "just now";
  if (seconds < 90) return "1 minute ago";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return days === 1 ? "1 day ago" : `${days} days ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return months === 1 ? "1 month ago" : `${months} months ago`;
  const years = Math.floor(months / 12);
  return years === 1 ? "1 year ago" : `${years} years ago`;
}

const CLUB_DATE_TIME = new Intl.DateTimeFormat("en-CA", {
  timeZone: CLUB_TIME_ZONE,
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/** 결제·환불 시각을 클럽 현지 시각으로("Oct 10, 3:12 p.m."). 없으면 "—". */
function clubDateTime(iso: string | null | undefined): string {
  const value = iso ? new Date(iso) : null;
  return value && !Number.isNaN(value.getTime()) ? CLUB_DATE_TIME.format(value) : "—";
}

/** 계산서의 결제 수단 한 줄("Online · visa ****4242", "Cash + Card ****1111"). */
function billPaymentLabel(bill: TeeBill): string {
  const payments = bill.payments ?? [];
  if (payments.length === 0) return bill.payment_method ? (PAYMENT_LABELS[bill.payment_method] ?? bill.payment_method) : "No charge";
  return payments
    .map((payment) => {
      const name =
        payment.entry === "online" || bill.online
          ? `Online · ${bill.online?.card_brand || PAYMENT_LABELS[payment.method] || payment.method}`
          : (PAYMENT_LABELS[payment.method] ?? payment.method);
      return payment.card_last4 ? `${name} ****${payment.card_last4}` : name;
    })
    .join(" + ");
}

const CHIP =
  "flex items-center gap-1.5 border border-[#c7c7cc] bg-white px-2 py-1 text-[11px] outline-none focus:border-[#4533ff]";

// ===== 글리프 =====
//
// 이모지를 쓰지 않는다. 두 가지 이유가 있다:
//   1) 레퍼런스의 아이콘은 전부 **단색 선 아이콘**이다. 컬러 이모지를 섞으면 이 패널만
//      튀어 보인다.
//   2) 🏷 · 🗑 는 폰트에 따라 그냥 빈 네모로 떨어진다 — 실제로 그렇게 나왔다.
//      "삭제" 버튼이 빈 네모인 화면을 프로 샵에 내보낼 수는 없다.
// 전부 장식이므로 aria-hidden 이고, 뜻은 감싸는 버튼의 이름/툴팁이 전달한다.
const GLYPH_PATH: Record<string, string> = {
  phone: "M3 2.6h3l1 3-1.6 1.2a8 8 0 0 0 3.8 3.8L10.4 9l3 1v3a1 1 0 0 1-1.1 1A11.4 11.4 0 0 1 2 3.7 1 1 0 0 1 3 2.6z",
  calendar: "M2.5 3.6h11v9.8h-11zM2.5 6.4h11M5.4 1.8v2.4M10.6 1.8v2.4",
  clock: "M8 2.4a5.6 5.6 0 1 1 0 11.2 5.6 5.6 0 0 1 0-11.2zM8 5.2V8l2 1.4",
  people: "M6 3.2a2.3 2.3 0 1 1 0 4.6 2.3 2.3 0 0 1 0-4.6zM1.8 13.2c0-2.3 1.9-3.8 4.2-3.8s4.2 1.5 4.2 3.8M11 3.6a2.2 2.2 0 0 1 0 4.4M12.2 9.9c1.4.5 2.3 1.7 2.3 3.3",
  tag: "M2.4 2.4h5l6.2 6.2-5 5L2.4 7.4zM4.9 4.9h.01",
  copy: "M5.4 5.4h8.2v8.2H5.4zM10.6 5.4V2.4H2.4v8.2h3",
  trash: "M2.8 4.4h10.4M6.2 4.4V2.6h3.6v1.8M4.2 4.4l.7 9h6.2l.7-9M6.6 6.6v4.6M9.4 6.6v4.6",
  card: "M1.8 4.2h12.4v7.6H1.8zM1.8 6.8h12.4M4 9.6h2.4",
};

function Glyph({ name, className = "h-3.5 w-3.5" }: { name: keyof typeof GLYPH_PATH; className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={`${className} shrink-0`}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.4"
      viewBox="0 0 16 16"
    >
      <path d={GLYPH_PATH[name]} />
    </svg>
  );
}

// ===== component =====

export default function ReservationDetail({ controller }: ReservationDetailProps) {
  // 합산 계산서(0005). 훅이라 아래 이른 return 보다 위에 둔다.
  const billState = useCurrentBill();
  const booking = controller.selected;
  const bookingId = booking?.id ?? null;
  // 레인체크(0011). 0011 이 아직 안 돌았으면 missing — 버튼을 숨긴다.
  const rainChecks = useRainChecks(bookingId);
  // 레인체크 창에 띄울 사람들. 열 때 한 번 찍어 둔다(5초 새로고침마다 창이 다시 묻지 않게).
  const [rainCheckFor, setRainCheckFor] = useState<Player[] | null>(null);

  const [bookingDraft, setBookingDraft] = useState<BookingDraft | null>(null);
  const [playerDrafts, setPlayerDrafts] = useState<Record<string, PlayerDraft>>({});
  const [saveState, setSaveState] = useState<SaveState>({ kind: "idle", nonce: 0 });
  const [mode, setMode] = useState<PanelMode>("none");
  const [cancelReason, setCancelReason] = useState("");
  // 날짜 칩은 draft 를 거친다. <input type="date"> 의 change 는 값이 완성될 때마다
  // — 화살표로 연도를 한 칸 올릴 때마다 한 번씩 — 터지는데, 그때마다 moveBooking 을
  // 부르면 예약이 중간 날짜들을 하나씩 밟고 지나간다. blur 에서 한 번만 커밋한다.
  const [dateDraft, setDateDraft] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  // 카트 요금 입력 중인 글자. 이름·전화 draft 와 따로 둔다 — 그 draft 는 필드 전체를 한 번에
  // 찍어 두므로, 카트를 켜서 서버가 요금을 채운 직후에 이름 draft 가 커밋되면 옛 요금(0)을 되돌려 보낸다.
  const [feeDrafts, setFeeDrafts] = useState<Record<string, string>>({});
  // 영수증을 찍지 못한 이유 (결제가 서버에 기록되지 않았을 때).
  const [receiptNote, setReceiptNote] = useState<{ playerId: string; text: string } | null>(null);
  // 결제 전에 보여 주는 영수증 창. 한 사람일 수도(카드의 Payment), 일행 전체일 수도(Pay all) 있다.
  // `at` 은 아직 결제 시각이 없는 사람의 미리보기용 시각이다.
  const [preview, setPreview] = useState<{ playerIds: string[]; reprint: boolean; at: string } | null>(null);
  // 재인쇄할 때 찾은 결제 계산서. 카드 끝자리·승인번호·결제 시각은 여기에만 있다.
  // `at` 이 지금 열린 창(`preview.at`)과 같을 때만 그 창의 것이다. null = 찾아봤지만 없다.
  const [reprintBill, setReprintBill] = useState<{ at: string; bill: Bill | null } | null>(null);
  // 이 예약에 실렸던 결제·환불 계산서(0022). 환불하면 플레이어의 paid 가 지워지므로, 취소된 예약의
  // 받은 돈·영수증·환불 내역은 여기서만 보인다. `id` 가 지금 예약과 다르면 아직 안 읽은 것이다.
  const [teeBills, setTeeBills] = useState<{ id: string; bills: TeeBill[] } | null>(null);
  // 결제 기록 줄에서 연 계산서 영수증(환불된 것이면 *** REFUNDED *** 가 찍힌다).
  const [billPreview, setBillPreview] = useState<Bill | null>(null);

  // 최신 값을 debounce 타이머 콜백에서 읽기 위한 미러 ref 들.
  const bookingRef = useRef<TeeBooking | null>(booking);
  const draftsRef = useRef<Record<string, PlayerDraft>>(playerDrafts);
  const bookingDraftRef = useRef<BookingDraft | null>(bookingDraft);
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const inflightRef = useRef(0);
  // 진행 중인 카트 요금 저장. Payment 가 이것을 기다린다 — 요금 칸에서 바로 Payment 를 누르면
  // blur 의 저장과 결제 요청이 동시에 떠나고, 결제가 먼저 닿으면 영수증에 옛 요금이 찍힌다.
  const feeCommitsRef = useRef<Map<string, Promise<unknown>>>(new Map());

  useEffect(() => {
    bookingRef.current = booking;
  }, [booking]);
  useEffect(() => {
    draftsRef.current = playerDrafts;
  }, [playerDrafts]);
  useEffect(() => {
    bookingDraftRef.current = bookingDraft;
  }, [bookingDraft]);

  /**
   * 재인쇄 창이 열리면 그 사람들의 결제 계산서를 찾는다. 계산서의 영업일은 결제한 날(클럽 현지)이고
   * `paidAt` 도 같은 트랜잭션에서 찍히므로 그 날의 결제 목록만 보면 된다.
   * 못 찾으면(계산서 없이 결제로 표시했거나 조회 실패) 예전 티 시트 영수증으로 남는다.
   */
  useEffect(() => {
    if (!preview?.reprint) return;
    const at = preview.at;
    const current = bookingRef.current;
    const people = preview.playerIds
      .map((id) => current?.players.find((item) => item.id === id))
      .filter((item): item is Player => Boolean(item));
    const dates = [...new Set(people.map((person) => (person.paidAt ? clubDate(person.paidAt) : null)))].filter(
      (date): date is string => Boolean(date),
    );
    let live = true;
    const lookup =
      current && dates.length > 0
        ? Promise.all(dates.map((date) => posApi.listPaid(date))).then((lists) =>
            paidBillFor(lists.flat(), current.id, people),
          )
        : Promise.resolve(null);
    lookup
      .catch(() => null)
      .then((bill) => {
        if (live) setReprintBill({ at, bill });
      });
    return () => {
      live = false;
    };
  }, [preview]);

  /**
   * 결제 기록은 결제·환불·취소 때 바뀐다. 그때마다 감사 기록이 한 줄 늘거나 플레이어의 paid 가 바뀌므로
   * 그것을 열쇠로 삼는다 — 5초 새로고침마다 다시 묻지 않게. 0022 가 아직 없으면 조용히 비운다.
   */
  const teeBillsKey = booking
    ? `${booking.id}|${booking.status}|${booking.audit?.length ?? 0}|${booking.players
        .map((player) => `${player.id}:${player.paid ? 1 : 0}`)
        .join(",")}`
    : "";
  useEffect(() => {
    if (!bookingId) return;
    let live = true;
    posApi
      .teeBills(bookingId)
      .catch(() => [] as TeeBill[])
      .then((bills) => {
        if (live) setTeeBills({ id: bookingId, bills: Array.isArray(bills) ? bills : [] });
      });
    return () => {
      live = false;
    };
    // teeBillsKey 에 bookingId 가 들어 있다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teeBillsKey]);

  const clearTimers = useCallback(() => {
    for (const timer of timersRef.current.values()) clearTimeout(timer);
    timersRef.current.clear();
  }, []);

  // 선택이 바뀌면 draft 를 버린다 (id 기준 — booking 객체 identity 기준이 아니다.
  // 객체 기준으로 리셋하면 매 PATCH 응답마다 입력 중인 값이 날아간다).
  useEffect(() => {
    clearTimers();
    setBookingDraft(null);
    setPlayerDrafts({});
    setMode("none");
    setCancelReason("");
    setDateDraft(null);
    setHistoryOpen(false);
    setFeeDrafts({});
    setReceiptNote(null);
    setPreview(null);
    setBillPreview(null);
    setRainCheckFor(null);
    setSaveState({ kind: "idle", nonce: 0 });
  }, [bookingId, clearTimers]);

  useEffect(() => clearTimers, [clearTimers]);

  useEffect(() => {
    if (saveState.kind !== "saved") return;
    const timer = setTimeout(() => setSaveState({ kind: "idle", nonce: 0 }), SAVED_FLASH_MS);
    return () => clearTimeout(timer);
  }, [saveState]);

  const beginSave = useCallback(() => {
    inflightRef.current += 1;
    setSaveState((prev) => ({ kind: "saving", nonce: prev.nonce + 1 }));
  }, []);

  const endSave = useCallback((changed: boolean) => {
    inflightRef.current = Math.max(0, inflightRef.current - 1);
    if (inflightRef.current > 0) return;
    setSaveState((prev) => ({ kind: changed ? "saved" : "idle", nonce: prev.nonce + 1 }));
  }, []);

  /** draft 를 커밋한다. 응답 후에도 draft 가 그대로면(=그 사이 타이핑 없음) 지운다. */
  const commitPlayer = useCallback(
    async (playerId: string): Promise<boolean> => {
      const current = bookingRef.current;
      if (!current) return false;
      const draft = draftsRef.current[playerId];
      const player = current.players.find((p) => p.id === playerId);
      if (!draft || !player) return false;

      const patch = playerPatchFrom(player, draft);
      const dropIfUnchanged = () =>
        setPlayerDrafts((prev) => {
          const held = prev[playerId];
          if (!held) return prev;
          const same =
            held.firstName === draft.firstName &&
            held.lastName === draft.lastName &&
            held.phone === draft.phone &&
            held.email === draft.email;
          if (!same) return prev;
          const next = { ...prev };
          delete next[playerId];
          return next;
        });

      if (Object.keys(patch).length === 0) {
        dropIfUnchanged();
        return false;
      }

      // 이름이 바뀌면 예약 제목도 따라가야 한다. 제목은 만들 때 한 번 정해지고 서버에
      // 동기화 규칙이 없어서, 그냥 두면 주간 뷰 막대가 영영 "Guest" 로 남는다
      // (이 패널에는 제목 입력칸이 없으니 고칠 방법도 없다).
      //
      // 단, **제목이 아직 이름을 따라가고 있을 때만** 바꾼다. 지금 제목이 "고치기 전
      // 이름" 과 같으면 자동으로 붙어 있던 것이고, 다르면 다이얼로그에서 사람이 직접
      // 적은 단체명 같은 것이므로 건드리지 않는다. 이름을 다 지우면 reservationTitle
      // 이 "Guest" 를 돌려주므로 제목도 Guest 로 돌아간다.
      const leadChanged =
        current.players[0]?.id === playerId &&
        (patch.firstName !== undefined || patch.lastName !== undefined);
      const titleWasTracking = leadChanged && current.title === reservationTitle(current.players);

      const updated = await controller.patchPlayer(current.id, playerId, patch);
      if (updated && titleWasTracking) {
        const nextTitle = reservationTitle(updated.players);
        if (nextTitle !== updated.title) {
          await controller.patchBooking(updated.id, { title: nextTitle });
        }
      }
      dropIfUnchanged();
      return true;
    },
    [controller],
  );

  const flushPlayer = useCallback(
    async (playerId: string) => {
      const timer = timersRef.current.get(playerId);
      if (timer) {
        clearTimeout(timer);
        timersRef.current.delete(playerId);
      }
      // 실제로 바뀐 게 없으면 "saving…" 을 깜빡이지 않는다 (blur 마다 발생하므로).
      const current = bookingRef.current;
      const draft = current ? draftsRef.current[playerId] : undefined;
      const player = current?.players.find((p) => p.id === playerId);
      if (!current || !draft || !player || Object.keys(playerPatchFrom(player, draft)).length === 0) {
        await commitPlayer(playerId); // draft 정리만 하고 끝
        return;
      }
      beginSave();
      let changed = false;
      try {
        changed = await commitPlayer(playerId);
      } finally {
        endSave(changed);
      }
    },
    [beginSave, commitPlayer, endSave],
  );

  const schedulePlayerCommit = useCallback(
    (playerId: string) => {
      const existing = timersRef.current.get(playerId);
      if (existing) clearTimeout(existing);
      timersRef.current.set(
        playerId,
        setTimeout(() => {
          timersRef.current.delete(playerId);
          void flushPlayer(playerId);
        }, PLAYER_DEBOUNCE_MS),
      );
    },
    [flushPlayer],
  );

  const setPlayerField = useCallback(
    (player: Player, field: keyof PlayerDraft, value: string) => {
      setPlayerDrafts((prev) => {
        const base = prev[player.id] ?? playerDraftOf(player);
        return { ...prev, [player.id]: { ...base, [field]: value } };
      });
      schedulePlayerCommit(player.id);
    },
    [schedulePlayerCommit],
  );

  /** 카트 요금 칸을 커밋한다 (blur·Enter). 숫자가 아니거나 그대로면 보내지 않고 칸을 되돌린다. */
  const commitFee = useCallback(
    (playerId: string, text: string) => {
      setFeeDrafts((prev) => {
        if (!(playerId in prev)) return prev;
        const next = { ...prev };
        delete next[playerId];
        return next;
      });
      const current = bookingRef.current;
      const player = current?.players.find((p) => p.id === playerId);
      const fee = Number(text);
      if (!current || !player || text.trim() === "" || !Number.isFinite(fee) || fee < 0) return;
      const cents = Math.round(fee * 100);
      if (cents === Math.round((player.cartFee ?? 0) * 100)) return;

      const pending = controller.patchPlayer(current.id, playerId, { cartFee: cents / 100 });
      feeCommitsRef.current.set(playerId, pending);
      void pending.finally(() => {
        if (feeCommitsRef.current.get(playerId) === pending) feeCommitsRef.current.delete(playerId);
      });
    },
    [controller],
  );

  // ===== derived =====

  const effectiveBookingDraft = useMemo(
    () => (booking ? (bookingDraft ?? bookingDraftOf(booking)) : null),
    [booking, bookingDraft],
  );

  const pendingBookingPatch = useMemo(
    () => (booking && effectiveBookingDraft ? bookingPatchFrom(booking, effectiveBookingDraft) : {}),
    [booking, effectiveBookingDraft],
  );

  const dirtyPlayerIds = useMemo(() => {
    if (!booking) return [] as string[];
    return booking.players
      .filter((player) => {
        const draft = playerDrafts[player.id];
        return draft ? Object.keys(playerPatchFrom(player, draft)).length > 0 : false;
      })
      .map((player) => player.id);
  }, [booking, playerDrafts]);

  const bookingDirty = Object.keys(pendingBookingPatch).length > 0;
  const dirty = bookingDirty || dirtyPlayerIds.length > 0;

  const saveAll = useCallback(async () => {
    const current = bookingRef.current;
    if (!current) return;
    clearTimers();
    beginSave();
    let changed = false;
    try {
      // 플레이어부터 순차로. 각 응답이 booking 전체를 교체하므로 병렬 금지.
      for (const player of current.players) {
        const didChange = await commitPlayer(player.id);
        changed = changed || didChange;
      }
      const latest = bookingRef.current ?? current;
      const draft = bookingDraftRef.current;
      if (draft) {
        const patch = bookingPatchFrom(latest, draft);
        if (Object.keys(patch).length > 0) {
          await controller.patchBooking(latest.id, patch);
          changed = true;
        }
        setBookingDraft((prev) => (prev === draft ? null : prev));
      }
    } finally {
      endSave(changed);
    }
  }, [beginSave, clearTimers, commitPlayer, controller, endSave]);

  // ===== empty state =====

  if (!booking || !effectiveBookingDraft) {
    return (
      <section className="min-w-0 border-t border-[#d4d4d8] bg-[#dedee2] px-4 py-10">
        <div className="mx-auto max-w-sm text-center text-xs text-[#5c6270]">
          <p className="text-sm font-bold text-[#1f2328]">Select a tee time</p>
          <p className="mt-1">
            Pick a reservation on the grid above to see its players, payments and history here.
          </p>
        </div>
      </section>
    );
  }

  const draft = effectiveBookingDraft;
  const players = booking.players;
  const busy = controller.busy;
  const audit: AuditEntry[] = [...(booking.audit ?? [])].reverse();

  /** 카트를 쓰는 사람의 카트 요금, 아니면 0. */
  const cartPart = (player: Player) => (player.cart ? (player.cartFee ?? 0) : 0);
  const dueFor = (player: Player) => (player.paid || player.cancelled ? 0 : booking.rate + cartPart(player));

  // 전체 결제 대상과 그 청구액. 센트는 영수증과 **같은 방식**으로 만든다(사람마다 그린피·카트를
  // 따로 반올림한 뒤 더하고, 세금은 합계에 한 번). 그래야 버튼 금액과 종이의 Total 이 같다.
  const unpaidPlayers = players.filter((player) => !player.paid && !player.cancelled);
  const unpaidSubtotal = unpaidPlayers.reduce(
    (sum, player) => sum + Math.round(booking.rate * 100) + Math.round(cartPart(player) * 100),
    0,
  );
  const unpaidTotal = unpaidSubtotal + computeTax(unpaidSubtotal);

  /**
   * Payment 는 **영수증 창을 열기만** 한다. 실제 결제와 인쇄는 그 창의 버튼에서 한다 —
   * 무엇을 받는지 보고 나서 돈을 받는 순서다. 이미 결제한 카드면 재인쇄 창이 열린다.
   * 결제 취소는 카드 머리의 "Mark unpaid" 로만 한다.
   */
  const openReceipt = (people: Player[], reprint: boolean) => {
    setReceiptNote(null);
    setPreview({ playerIds: people.map((person) => person.id), reprint, at: new Date().toISOString() });
  };

  /**
   * 합산 계산서(0005)가 켜져 있으면 Payment 는 **계산서에 담기**다. 돈은 계산서 결제(카드면
   * 카드 단말기 승인번호)에서만 받는다 — 여기서 paid 를 직접 켜지 않는다(2026-09-10 결정).
   * 0005 가 아직 안 돌았으면(`missing`) 예전 영수증 결제 흐름으로 남는다. 그래야 마이그레이션
   * 전에 배포돼도 그린피를 받을 길이 끊기지 않는다.
   */
  const useBills = !billState.missing;
  const billOf = (playerId: string) =>
    billState.openBills.find((item) =>
      item.lines.some((line) => line.booking_id === booking.id && line.player_id === playerId),
    ) ?? null;
  const addToBill = async (people: Player[] | null) => {
    setReceiptNote(null);
    // 저장 안 된 편집(카트 요금 등)을 먼저 보낸다. 계산서는 서버의 예약 값으로 금액을 매긴다.
    for (const person of people ?? unpaidPlayers) await feeCommitsRef.current.get(person.id);
    if (dirty) await saveAll();
    const added = await billActions.addTee(booking.id, people?.map((person) => person.id));
    if (added) {
      controller.pushToast("success", `Added to bill #${added.id} — ${formatMoney(added.total)} so far. Charge it from the Bill button.`);
    } else {
      controller.pushToast("error", getBillState().error || "Could not add to the bill.");
    }
  };
  const unbilledUnpaid = unpaidPlayers.filter((player) => !billOf(player.id));

  // 레인체크는 결제한 사람에게만 나간다(낸 돈이 크레딧이다).
  const useRainCheck = !rainChecks.missing;
  const paidPlayers = players.filter((player) => player.paid && !player.cancelled);
  const withoutRainCheck = paidPlayers.filter((player) => !activeRainCheck(rainChecks.checks, player.id));

  const reprintLookup = preview?.reprint && reprintBill?.at === preview.at ? reprintBill : null;
  const reprintLoading = Boolean(preview?.reprint) && !reprintLookup;

  // 결제 기록(0022). 다른 예약의 것이 남아 있으면 버린다.
  const bookingBills = teeBills?.id === booking.id ? teeBills.bills : [];
  /** 이 사람의 그린피를 받았다가 돌려준 계산서. 환불하면 paid 가 지워지므로 이것으로만 안다. */
  const refundedBillOf = (playerId: string) =>
    bookingBills.find(
      (bill) =>
        bill.status === "refunded" &&
        bill.lines.some(
          (line) => line.kind === "tee_player" && line.booking_id === booking.id && line.player_id === playerId,
        ),
    );

  /** 재인쇄: 서버 상태는 건드리지 않는다. 결제 계산서가 있으면 그 영수증(결제 수단·카드 정보 포함)이다. */
  const reprintReceipt = (people: Player[]) => {
    setPreview(null);
    const bill = reprintLookup?.bill;
    printReceiptDoc(bill ? saleReceipt(bill) : teeReceiptFor(booking, people), { reprint: true });
  };

  /**
   * 결제 + 인쇄. 여러 명을 한 번에 받으면 영수증도 **한 장**이다(합계 하나).
   * PATCH 는 사람마다 **차례로** 보낸다: 응답이 예약 전체를 갈아 끼우므로 동시에 보내면
   * 마지막 응답이 앞사람의 결제를 덮어쓴 예약으로 화면을 되돌린다.
   */
  const payAndPrint = async (people: Player[]) => {
    setReceiptNote(null);
    setPreview(null);
    // 카드에 보이는 금액과 영수증 금액이 같아야 한다. 저장 안 된 편집(그린피·카트 요금)을 먼저 보낸다.
    for (const person of people) await feeCommitsRef.current.get(person.id);
    if (dirty) await saveAll();

    let updated: TeeBooking | null = null;
    for (const person of people) {
      updated = await controller.patchPlayer(booking.id, person.id, { paid: true });
      if (!updated) break;
    }
    const paid = people.map((person) => updated?.players.find((item) => item.id === person.id));
    // 종이는 서버가 결제를 기록한 뒤에만 나온다. 결제 시각은 서버만 찍으므로(로컬 사본은 null),
    // 그게 없으면 서버가 거절했거나 오프라인 사본이다. 한 명이라도 빠지면 찍지 않는다.
    if (!updated || paid.some((person) => !person?.paid || !person.paidAt)) {
      setReceiptNote({
        playerId: people[0]?.id ?? "",
        text: "Payment not saved to the server — no receipt printed.",
      });
      return;
    }
    printReceiptDoc(teeReceiptFor(updated, paid as Player[]));
  };

  // 시각 선택지는 그날의 실제 티타임 목록이다. 서버가 아직 슬롯을 안 줬거나 이 예약이
  // 목록에 없는 시각을 갖고 있으면(레거시 레코드) 현재 값을 한 항목 더 붙인다 —
  // 안 그러면 <select> 가 제멋대로 첫 항목을 고른 것처럼 보이고, 저장 한 번에
  // 예약이 다른 시각으로 옮겨 간다.
  const slotTimes = controller.slots.map((slot) => slot.time);
  const timeOptions = slotTimes.includes(booking.time) ? slotTimes : [booking.time, ...slotTimes];

  /**
   * 예약을 옮기고 **시트를 따라가게** 한다.
   * 따라가지 않으면 다른 주로 옮긴 순간 그 예약이 `visibleBookings` 에서 빠지고,
   * `selected` 가 풀리면서 상세 패널이 사용자 손 밑에서 그냥 닫힌다.
   */
  const moveTo = async (date: string, time: string) => {
    const moved = await controller.moveBooking(booking.id, date, time);
    if (moved) controller.setFocusedDate(moved.date);
  };

  const saveLabel =
    saveState.kind === "saving" ? "saving…" : saveState.kind === "saved" ? "saved" : dirty ? "unsaved" : "";

  // 영수증 창에 보여 줄 내용. 결제한 사람은 서버가 찍은 시각을, 아직 아닌 사람은 창을 연 시각을 쓴다.
  const previewPlayers = preview
    ? preview.playerIds
        .map((id) => players.find((item) => item.id === id))
        .filter((item): item is Player => Boolean(item))
    : [];
  const previewDoc =
    preview && previewPlayers.length > 0
      ? reprintLookup?.bill
        ? saleReceipt(reprintLookup.bill)
        : teeReceiptFor(booking, previewPlayers, preview.reprint ? {} : { at: preview.at })
      : null;

  return (
    <section className="min-w-0 border-t border-[#d4d4d8] bg-[#dedee2] text-xs text-[#1f2328]">
      {/* ===== 헤더 줄 ===== */}
      <div className="flex flex-wrap items-center gap-2 border-b border-[#c7c7cc] bg-white px-3 py-2">
        <span className="flex items-center gap-1.5 font-bold" title={`Reservation ${booking.id}`}>
          <Glyph className="h-3.5 w-3.5 text-[#4e5560]" name="phone" />
          {confirmationCode(booking.id)}
        </span>

        <label className={CHIP}>
          <span className="sr-only">Holes</span>
          <select
            className="bg-transparent outline-none"
            onChange={(event) => setBookingDraft({ ...draft, holes: Number(event.target.value) === 9 ? 9 : 18 })}
            value={String(draft.holes)}
          >
            <option value="9">9 holes</option>
            <option value="18">18 holes</option>
          </select>
        </label>

        {/* 날짜·시각은 draft 가 아니라 즉시 이동이다. `moveBooking` 은 목적지가 가득 찼는지
            서버가 판정해야 하므로 (좌석 정원 4명) Save 까지 미뤄 두면 실패를 늦게 알게 된다. */}
        <label className={CHIP} title="Move this reservation to another date">
          <Glyph className="h-3.5 w-3.5 text-[#4e5560]" name="calendar" />
          <span className="sr-only">Date</span>
          <input
            className="bg-transparent outline-none"
            disabled={busy}
            onBlur={() => {
              const next = dateDraft;
              setDateDraft(null);
              // 연도 자리를 다 채우기 전에 포커스가 빠지면 `0001-09-08` 같은 값이 남는다.
              // 실제로 그렇게 옮겨진 예약을 되돌려 본 적이 있다 — 그러니 커밋 전에 거른다.
              if (next && next !== booking.date && /^\d{4}-\d{2}-\d{2}$/.test(next) && next >= "1900-01-01") {
                void moveTo(next, booking.time);
              }
            }}
            onChange={(event) => setDateDraft(event.target.value)}
            type="date"
            value={dateDraft ?? booking.date}
          />
        </label>

        <label className={CHIP} title="Move this reservation to another tee time">
          <Glyph className="h-3.5 w-3.5 text-[#4e5560]" name="clock" />
          <span className="sr-only">Tee time</span>
          <select
            className="bg-transparent outline-none"
            disabled={busy}
            onChange={(event) => void moveTo(booking.date, event.target.value)}
            value={booking.time}
          >
            {timeOptions.map((time) => (
              <option key={time} value={time}>
                {time}
              </option>
            ))}
          </select>
        </label>

        {booking.cancelReason ? (
          <span className="border border-[#c47a63] bg-[#fbeae5] px-2 py-1 text-[#8a3f26]">
            Cancelled: {booking.cancelReason}
          </span>
        ) : null}

        {/* 일행 전체 결제. 카드의 Payment 는 한 사람, 이 버튼은 아직 안 낸 사람 전부를 한 장에 담는다.
            금액은 세금까지 더한 **실제 청구액**이다 — 카드의 Subtotal Due(세전)와 다른 숫자라
            버튼에 금액을 직접 적어 둔다. */}
        {useBills ? (
          <button
            className="border border-[#4533ff] bg-white px-3 py-1.5 font-bold text-[#4533ff] hover:bg-[#f0eeff] disabled:cursor-not-allowed disabled:border-[#c7c7cc] disabled:bg-white disabled:text-[#b6b6c0]"
            disabled={busy || billState.busy || unbilledUnpaid.length === 0}
            onClick={() => void addToBill(null)}
            title="Put everyone who has not paid yet on the current bill. Pro shop and snack bar items can go on the same bill."
            type="button"
          >
            Add all to bill ({unbilledUnpaid.length})
          </button>
        ) : (
          <button
            className="border border-[#4533ff] bg-white px-3 py-1.5 font-bold text-[#4533ff] hover:bg-[#f0eeff] disabled:cursor-not-allowed disabled:border-[#c7c7cc] disabled:bg-white disabled:text-[#b6b6c0]"
            disabled={busy || unpaidPlayers.length === 0}
            onClick={() => openReceipt(unpaidPlayers, false)}
            title="Take payment for everyone who has not paid yet — one receipt for the group"
            type="button"
          >
            Pay all ({unpaidPlayers.length}) {formatMoney(unpaidTotal)}
          </button>
        )}

        {/* 비로 라운드가 끊긴 일행. 아직 레인체크가 없는 결제자 전부에게 한 장씩. */}
        {useRainCheck && paidPlayers.length > 0 ? (
          <button
            className="border border-[#2f6f8f] bg-white px-3 py-1.5 font-bold text-[#2f6f8f] hover:bg-[#eef6fa] disabled:cursor-not-allowed disabled:border-[#c7c7cc] disabled:text-[#b6b6c0]"
            disabled={busy}
            onClick={() => setRainCheckFor(withoutRainCheck.length > 0 ? withoutRainCheck : paidPlayers)}
            title="Give each paid player a rain check slip with a barcode and an expiry date"
            type="button"
          >
            {withoutRainCheck.length > 0 ? `Rain checks (${withoutRainCheck.length})` : "Rain checks ✓"}
          </button>
        ) : null}

        <span
          aria-live="polite"
          className={`ml-auto min-w-[64px] text-right ${
            saveState.kind === "saved"
              ? "text-[#168a3c]"
              : saveState.kind === "saving"
                ? "text-[#4e5560]"
                : dirty
                  ? "font-bold text-[#8a3f26]"
                  : "text-transparent"
          }`}
        >
          {saveLabel}
        </span>

        <button
          className="border border-[#c7c7cc] bg-white px-4 py-1.5 font-bold text-[#4e5560] hover:border-[#4533ff] disabled:opacity-40"
          disabled={busy || booking.status === "cancelled"}
          onClick={() => setMode(mode === "cancel" ? "none" : "cancel")}
          title="Cancel this reservation"
          type="button"
        >
          Cancel
        </button>
        <button
          className="bg-[#4533ff] px-5 py-1.5 font-bold text-white disabled:cursor-not-allowed disabled:bg-[#b1a8ff]"
          disabled={busy || !dirty}
          onClick={() => void saveAll()}
          type="button"
        >
          Save
        </button>
      </div>

      {/* ===== 결제 기록 (0022) =====
          계산서 한 장에 한 줄: 영수증 번호 · 금액 · 결제 수단 · 결제 시각, 환불됐으면 환불 시각과 사유.
          환불하면 플레이어 카드의 paid 가 지워지므로, 취소된 예약의 돈 흐름은 여기서만 보인다. */}
      {bookingBills.length > 0 ? (
        <ul className="border-b border-[#c7c7cc] bg-[#f7f7f9]">
          {bookingBills.map((bill) => {
            const refunded = bill.status === "refunded";
            const voided = refunded && bill.online?.refund_kind === "void";
            return (
              <li
                className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-[#ececf0] px-3 py-1.5 last:border-b-0"
                key={bill.id}
              >
                <span className="font-bold tabular-nums">Receipt {bill.receipt_no}</span>
                <span className="tabular-nums">{formatMoney(bill.total)}</span>
                <span className="text-[#4e5560]">{billPaymentLabel(bill)}</span>
                <span className="text-[#4e5560]">Paid {clubDateTime(bill.paid_at)}</span>
                {refunded ? (
                  <span className="border border-[#c47a63] bg-[#fbeae5] px-1.5 py-0.5 font-bold text-[#8a3f26]">
                    {voided ? "Voided" : "Refunded"} {formatMoney(bill.total)} · {clubDateTime(bill.refunded_at)}
                    {bill.refund_reason ? ` — ${bill.refund_reason}` : ""}
                  </span>
                ) : (
                  <span className="border border-[#9fd2ae] bg-[#e8f6ec] px-1.5 py-0.5 font-bold text-[#168a3c]">Paid</span>
                )}
                <button
                  className="ml-auto border border-[#c7c7cc] bg-white px-2 py-1 font-bold hover:bg-[#f0eeff]"
                  onClick={() => setBillPreview(bill)}
                  title={refunded ? "Show the receipt marked REFUNDED" : "Show the receipt"}
                  type="button"
                >
                  Receipt
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}

      {/* ===== inline cancel form (window.prompt 대체) ===== */}
      {mode === "cancel" ? (
        <div className="border-b border-[#c47a63] bg-white p-3">
          <p className="font-bold text-[#8a3f26]">Cancel “{booking.title}” — why?</p>
          <div className="mt-2 flex flex-wrap gap-1">
            {CANCEL_PRESETS.map((preset) => (
              <button
                className="border border-[#d7d7dc] bg-[#f2f2f4] px-2 py-1 hover:border-[#8a3f26]"
                key={preset}
                onClick={() => setCancelReason(preset)}
                type="button"
              >
                {preset}
              </button>
            ))}
          </div>
          <textarea
            className="mt-2 h-16 w-full resize-none border border-[#d7d7dc] p-2 outline-none focus:border-[#8a3f26]"
            onChange={(event) => setCancelReason(event.target.value)}
            placeholder="Reason shown on the reservation and written to the history log"
            value={cancelReason}
          />
          <div className="mt-2 flex gap-2">
            <button
              className="border border-[#8a3f26] bg-[#8a3f26] px-4 py-2 font-bold text-white disabled:opacity-40"
              disabled={busy || cancelReason.trim().length === 0}
              onClick={async () => {
                // 실패(오프라인 거절·응답 없음)면 사유를 그대로 두고 폼을 열어 둔다 — 다시 누를 수 있게.
                const saved = await controller.setStatus(booking.id, "cancelled", cancelReason.trim());
                if (!saved) return;
                setMode("none");
                setCancelReason("");
              }}
              type="button"
            >
              Confirm Cancellation
            </button>
            <button
              className="border border-[#c7c7cc] bg-white px-4 py-2 font-bold"
              onClick={() => setMode("none")}
              type="button"
            >
              Back
            </button>
          </div>
        </div>
      ) : null}

      {/* ===== inline delete confirm (레일의 🗑) ===== */}
      {mode === "delete" ? (
        <div className="border-b border-[#8a3f26] bg-[#fbeae5] p-3">
          <p className="font-bold text-[#8a3f26]">
            Delete “{booking.title}” at {booking.time} on {longDate(booking.date)}?
          </p>
          <p className="mt-1 text-[#6d3a27]">
            This permanently removes the reservation and its {players.length}{" "}
            {players.length === 1 ? "player" : "players"}. Cancelling instead keeps the record with a reason.
          </p>
          <div className="mt-2 flex gap-2">
            <button
              className="border border-[#8a3f26] bg-[#8a3f26] px-4 py-2 font-bold text-white disabled:opacity-40"
              disabled={busy}
              onClick={async () => {
                if (!(await controller.deleteBooking(booking.id))) return;
                setMode("none");
              }}
              type="button"
            >
              Delete permanently
            </button>
            <button
              className="border border-[#c7c7cc] bg-white px-4 py-2 font-bold"
              onClick={() => setMode("none")}
              type="button"
            >
              Back
            </button>
          </div>
        </div>
      ) : null}

      {/* ===== 아이콘 레일 + 플레이어 카드 ===== */}
      <div className="flex items-stretch">
        <IconRail
          historyOpen={historyOpen}
          onClose={() => controller.select(null)}
          onDelete={() => setMode(mode === "delete" ? "none" : "delete")}
          onToggleHistory={() => setHistoryOpen((open) => !open)}
          playerCount={players.length}
        />

        <div className="flex min-w-0 flex-1 items-stretch gap-2 overflow-x-auto p-2">
          {players.map((player) => {
            const pd = playerDrafts[player.id] ?? playerDraftOf(player);
            const emailInvalid = pd.email.trim() !== "" && !EMAIL_RE.test(pd.email.trim());
            // 서버 값이 목록에 없으면 그 값도 항목으로 붙인다 (RATE_PLANS 주석 참고).
            const plan = player.ratePlan?.trim() || "Public";
            const planOptions = RATE_PLANS.includes(plan) ? RATE_PLANS : [plan, ...RATE_PLANS];
            const cartOn = player.cart === true;

            return (
              <article
                className="flex w-[212px] shrink-0 flex-col border border-[#c7c7cc] bg-white p-1.5"
                key={player.id}
              >
                <div className="mb-1.5 flex items-center gap-1.5">
                  <span
                    aria-hidden
                    className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#ececf0] text-[10px] text-[#6b7280]"
                  >
                    {player.type === "Guest" ? "G" : "●"}
                  </span>
                  <span className="truncate font-bold">{player.type}</span>
                  {player.paid ? (
                    // 계산서로 결제된 선수는 Mark unpaid 가 서버에서 막힌다(0005) — 환불은 계산서
                    // 단위로 Reports 에서 한다. 결제한 날(영업일) 목록을 바로 연다.
                    <Link
                      className="ml-auto whitespace-nowrap px-1 text-[10px] font-bold text-[#8a3f26] underline decoration-dotted"
                      href={`/admin/reports?date=${localBusinessDate(player.paidAt ? new Date(player.paidAt) : new Date())}`}
                      title="Refund the bill this player was paid on — Reports → Daily close. Card and debit payments are refunded from that screen."
                    >
                      Refund
                    </Link>
                  ) : null}
                  {player.paid ? (
                    <button
                      className="whitespace-nowrap px-1 text-[10px] text-[#4e5560] underline decoration-dotted hover:text-[#8a3f26] disabled:opacity-30"
                      disabled={busy}
                      onClick={() => void controller.patchPlayer(booking.id, player.id, { paid: false })}
                      title="Clear the payment on this card — only to fix a mistake"
                      type="button"
                    >
                      Mark unpaid
                    </button>
                  ) : null}
                  <button
                    className={`${player.paid ? "" : "ml-auto "}px-1 text-[#8a3f26] disabled:opacity-30`}
                    disabled={busy}
                    onClick={() => void controller.removePlayer(booking.id, player.id)}
                    title="Remove this player from the reservation"
                    type="button"
                  >
                    ×
                  </button>
                </div>

                <div className="grid grid-cols-2 gap-1">
                  <label className="block">
                    <span className="sr-only">Last Name</span>
                    <input
                      className="w-full border-b border-[#d7d7dc] px-1 py-1 font-bold outline-none focus:border-[#4533ff]"
                      onBlur={() => void flushPlayer(player.id)}
                      onChange={(event) => setPlayerField(player, "lastName", event.target.value)}
                      placeholder="Last Name"
                      value={pd.lastName}
                    />
                  </label>
                  <label className="block">
                    <span className="sr-only">First Name</span>
                    <input
                      className="w-full border-b border-[#d7d7dc] px-1 py-1 outline-none focus:border-[#4533ff]"
                      onBlur={() => void flushPlayer(player.id)}
                      onChange={(event) => setPlayerField(player, "firstName", event.target.value)}
                      placeholder="First Name"
                      value={pd.firstName}
                    />
                  </label>
                </div>

                {/* Postal / Mem # 은 레퍼런스에 있는 칸이지만 우리 Player 모델에는 없다.
                    입력을 받아 두고 조용히 버리면 프런트 데스크가 적어 넣은 회원번호가
                    사라지므로, 칸만 두고 `disabled` 로 잠근다. 백엔드에 필드가 생기면
                    여기만 풀면 된다. */}
                <div className="mt-1 grid grid-cols-[1.4fr_1fr_1fr] gap-1">
                  <label className="block">
                    <span className="sr-only">Phone</span>
                    <input
                      className="w-full border-b border-[#d7d7dc] px-1 py-1 outline-none focus:border-[#4533ff]"
                      inputMode="tel"
                      onBlur={() => void flushPlayer(player.id)}
                      onChange={(event) => setPlayerField(player, "phone", event.target.value)}
                      placeholder="Phone"
                      value={pd.phone}
                    />
                  </label>
                  <input
                    className="w-full cursor-not-allowed border-b border-[#ececf0] px-1 py-1 text-[#b6b6c0]"
                    disabled
                    placeholder="Postal"
                    title="No postal code field on the reservation record yet"
                  />
                  <input
                    className="w-full cursor-not-allowed border-b border-[#ececf0] px-1 py-1 text-[#b6b6c0]"
                    disabled
                    placeholder="Mem #"
                    title="No membership number field on the reservation record yet"
                  />
                </div>

                <label className="mt-1 block">
                  <span className="sr-only">Email</span>
                  <input
                    className={`w-full border-b px-1 py-1 outline-none focus:border-[#4533ff] ${
                      emailInvalid ? "border-[#8a3f26]" : "border-[#d7d7dc]"
                    }`}
                    inputMode="email"
                    onBlur={() => void flushPlayer(player.id)}
                    onChange={(event) => setPlayerField(player, "email", event.target.value)}
                    placeholder="Email"
                    value={pd.email}
                  />
                </label>
                {emailInvalid ? (
                  <span className="mt-1 block text-[10px] text-[#8a3f26]">Check this email address</span>
                ) : null}

                {/* 요금제. 격자의 셀 색이 여기서 정해진다 (tone.ts) — 그래서 바로 저장한다. */}
                <label className="mt-1.5 flex items-center gap-1 border border-[#c7c7cc] px-1.5 py-0.5">
                  <span aria-hidden className="text-[8px] leading-none text-[#4533ff]">
                    &#9679;
                  </span>
                  <span className="sr-only">Rate plan</span>
                  <select
                    className="w-full bg-transparent outline-none"
                    disabled={busy}
                    onChange={(event) =>
                      void controller.patchPlayer(booking.id, player.id, { ratePlan: event.target.value })
                    }
                    value={plan}
                  >
                    {planOptions.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                </label>

                <div className="mt-1.5 grid grid-cols-2 gap-1">
                  <button
                    className={`border px-1 py-1 font-bold disabled:opacity-40 ${
                      player.arrived ? "border-[#168a3c] bg-[#ecfff1] text-[#168a3c]" : "border-[#d7d7dc]"
                    }`}
                    disabled={busy}
                    onClick={() => void controller.patchPlayer(booking.id, player.id, { arrived: !player.arrived })}
                    type="button"
                  >
                    Arrived
                  </button>
                  <button
                    className={`border px-1 py-1 font-bold disabled:opacity-40 ${
                      player.no_show ? "border-[#8a3f26] bg-[#fff1ee] text-[#8a3f26]" : "border-[#d7d7dc]"
                    }`}
                    disabled={busy}
                    onClick={() => void controller.patchPlayer(booking.id, player.id, { no_show: !player.no_show })}
                    type="button"
                  >
                    No show
                  </button>
                </div>

                {/* 그린피 한 줄. 금액은 예약 단위 `rate` 라서 한 카드에서 고치면 모든
                    카드가 같이 바뀐다 — title 로 그 사실을 말해 둔다. 레퍼런스처럼
                    글자로 보이지만 실제로는 입력칸이다 (요금 편집을 잃지 않으려고). */}
                <div className="mt-1.5 flex items-center gap-1 border border-[#d7d7dc] px-1.5 py-1">
                  <span className="truncate">{booking.holes} Hole Green Fee</span>
                  <span aria-hidden className="ml-auto text-[#9aa0a6]">
                    $
                  </span>
                  <input
                    aria-label="Green fee for every player on this reservation"
                    className="w-12 bg-transparent text-right tabular-nums outline-none focus:text-[#4533ff]"
                    inputMode="decimal"
                    onChange={(event) => setBookingDraft({ ...draft, rate: event.target.value })}
                    title="Green fee — one rate for the whole reservation"
                    value={draft.rate}
                  />
                  <span
                    aria-hidden
                    className={`h-2 w-2 shrink-0 rounded-full border ${
                      player.paid ? "border-[#168a3c] bg-[#168a3c]" : "border-[#c7c7cc]"
                    }`}
                  />
                </div>
                {draft.rate.trim() !== "" && !Number.isFinite(Number(draft.rate)) ? (
                  <span className="mt-1 block text-[10px] text-[#8a3f26]">Not a number — will not be saved</span>
                ) : null}
                {/* 카트 한 줄. 켜면 서버가 금액을 채운다(`cart_fee_for`) — 세전 $19.00 한 가지이고,
                    카트가 포함된 회원 요금제만 $0 이다. 그린피와 달리 이 사람 것만 바뀐다.
                    결제한 뒤에는 잠근다: 받은 돈과 재인쇄 영수증이 달라지면 안 된다. */}
                <div
                  className={`mt-1 flex items-center gap-1 border px-1.5 py-1 ${
                    cartOn ? "border-[#d7d7dc]" : "border-dashed border-[#d7d7dc] text-[#9aa0a6]"
                  }`}
                >
                  {/* 글자는 "Half Cart" 만. 212px 카드에 "(18 Holes)" 까지 넣으면 잘린다 — 홀 수는
                      바로 위 그린피 줄과 영수증 품목 이름에 있다. */}
                  <label
                    className="flex min-w-0 items-center gap-1"
                    title={
                      player.paid
                        ? "Paid — mark unpaid to change the cart"
                        : `Add a half cart (${booking.holes} holes) for this player`
                    }
                  >
                    <input
                      checked={cartOn}
                      className="h-3 w-3 shrink-0 accent-[#4533ff]"
                      disabled={busy || player.paid || player.cancelled}
                      onChange={(event) =>
                        void controller.patchPlayer(booking.id, player.id, { cart: event.target.checked })
                      }
                      type="checkbox"
                    />
                    <span className="truncate">Half Cart</span>
                  </label>
                  <span aria-hidden className="ml-auto text-[#9aa0a6]">
                    $
                  </span>
                  <input
                    aria-label={`Cart fee for ${player.name}`}
                    className="w-12 bg-transparent text-right tabular-nums outline-none focus:text-[#4533ff] disabled:text-[#b6b6c0]"
                    disabled={!cartOn || player.paid}
                    inputMode="decimal"
                    onBlur={(event) => commitFee(player.id, event.currentTarget.value)}
                    onChange={(event) => setFeeDrafts((prev) => ({ ...prev, [player.id]: event.target.value }))}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") event.currentTarget.blur();
                    }}
                    title="Cart fee for this player only — filled in from the rate plan and holes"
                    value={feeDrafts[player.id] ?? cartPart(player).toFixed(2)}
                  />
                  <span
                    aria-hidden
                    className={`h-2 w-2 shrink-0 rounded-full border ${
                      !cartOn ? "border-transparent" : player.paid ? "border-[#168a3c] bg-[#168a3c]" : "border-[#c7c7cc]"
                    }`}
                  />
                </div>

                {player.cancelled ? (
                  <div className="mt-1 flex justify-between text-[#8a3f26]">
                    <span>Cancelled</span>
                    <span>−{money(booking.rate + cartPart(player))}</span>
                  </div>
                ) : null}
                {(() => {
                  const refunded = refundedBillOf(player.id);
                  return refunded ? (
                    <button
                      className="mt-1 flex justify-between border border-[#c47a63] bg-[#fbeae5] px-1 py-0.5 text-left text-[#8a3f26] hover:bg-[#f7dcd4]"
                      onClick={() => setBillPreview(refunded)}
                      title={`Refunded on receipt ${refunded.receipt_no} — show the receipt`}
                      type="button"
                    >
                      <span className="font-bold">Refunded</span>
                      <span className="tabular-nums">{refunded.receipt_no}</span>
                    </button>
                  ) : null;
                })()}

                <div className="mt-1.5 flex justify-between border-t border-[#ececf0] pt-1.5 font-bold">
                  <span>Subtotal Due</span>
                  <span className="tabular-nums">{money(dueFor(player))}</span>
                </div>

                <div className="mt-1.5 grid grid-cols-2 gap-1">
                  {/* 할인 API 가 아직 없다. 생김새만 맞추고 눌리지 않게 잠근다 —
                      눌러도 아무 일이 없는 버튼보다 잠긴 버튼이 정직하다. */}
                  <button
                    className="cursor-not-allowed border border-[#ececf0] px-1 py-1 font-bold text-[#b6b6c0]"
                    disabled
                    title="No discount API yet"
                    type="button"
                  >
                    Discount
                  </button>
                  <button
                    className={`flex items-center justify-center gap-1 px-1 py-1 font-bold text-white disabled:opacity-40 ${
                      player.paid ? "bg-[#4533ff]" : "bg-[#b1a8ff]"
                    }`}
                    disabled={
                      busy ||
                      player.cancelled ||
                      (useBills && !player.paid && (billState.busy || Boolean(billOf(player.id))))
                    }
                    onClick={() =>
                      player.paid || !useBills ? openReceipt([player], player.paid) : void addToBill([player])
                    }
                    title={
                      player.paid
                        ? "Paid — show the receipt to print again"
                        : useBills
                          ? billOf(player.id)
                            ? `Already on bill #${billOf(player.id)?.id}`
                            : "Put this player's green fee on the current bill"
                          : "Show the receipt, then take payment"
                    }
                    type="button"
                  >
                    {player.paid
                      ? "Payment"
                      : useBills
                        ? billOf(player.id)
                          ? `On bill #${billOf(player.id)?.id}`
                          : "Add to bill"
                        : "Payment"}
                    <Glyph className="h-3 w-3" name="card" />
                  </button>
                </div>
                {useRainCheck && player.paid && !player.cancelled
                  ? (() => {
                      const check = activeRainCheck(rainChecks.checks, player.id);
                      return (
                        <button
                          className={`mt-1 border px-1 py-1 font-bold disabled:opacity-40 ${
                            check
                              ? "border-[#2f6f8f] bg-[#eef6fa] text-[#2f6f8f]"
                              : "border-dashed border-[#2f6f8f] text-[#2f6f8f]"
                          }`}
                          disabled={busy}
                          onClick={() => setRainCheckFor([player])}
                          title={
                            check
                              ? `Rain check ${check.code} — reprint or void`
                              : "Give this player a rain check slip (barcode + expiry date)"
                          }
                          type="button"
                        >
                          {check
                            ? `Rain check ${formatMoney(check.amount)}${
                                check.status === "redeemed" ? " · used" : check.expired ? " · expired" : ""
                              }`
                            : "Rain check"}
                        </button>
                      );
                    })()
                  : null}
                {receiptNote?.playerId === player.id ? (
                  <span className="mt-1 block text-[10px] text-[#8a3f26]">{receiptNote.text}</span>
                ) : null}
              </article>
            );
          })}

          {/* 자리를 더 파는 길. 레퍼런스는 격자의 ⊕ 로만 사람을 넣지만 그것은 **새 예약**을
              여는 버튼이라, 이 카드를 없애면 기존 예약에 세 번째 사람을 붙일 방법이 사라진다. */}
          {players.length < MAX_PLAYERS ? (
            <button
              className="w-[52px] shrink-0 border border-dashed border-[#aeb2bb] bg-[#d5d5da] text-2xl text-[#9297a1] disabled:cursor-not-allowed disabled:opacity-40"
              disabled={busy}
              onClick={() => void controller.addPlayer(booking.id)}
              title="Add a player to this reservation"
              type="button"
            >
              +
            </button>
          ) : null}
        </div>
      </div>

      {/* ===== history (레일의 🕐) ===== */}
      {historyOpen ? (
        <div className="border-t border-[#c7c7cc] bg-white">
          <p className="px-3 py-1.5 font-bold">History ({audit.length})</p>
          <ul className="max-h-40 overflow-y-auto border-t border-[#ececf0]">
            {audit.length === 0 ? (
              <li className="px-3 py-2 text-[#9aa0a6]">No activity recorded yet.</li>
            ) : (
              audit.map((entry) => (
                <li className="flex gap-3 border-b border-[#f3f3f5] px-3 py-1.5 last:border-b-0" key={entry.id}>
                  <span className="w-28 shrink-0 text-[#9aa0a6]">{relativeTime(entry.ts)}</span>
                  <span className="min-w-0">{entry.message}</span>
                </li>
              ))
            )}
          </ul>
        </div>
      ) : null}

      {/* ===== 영수증 창 (Payment) =====
          종이에 나갈 것과 **같은 HTML**(receiptSheetHtml)을 같은 규칙(.rc-sheet)으로 72mm 폭에
          그린다. 여기서 Pay 를 눌러야 결제가 기록되고 인쇄가 나간다.
          프린터 선택 창은 브라우저 것이라 페이지에서 없앨 수 없다 — 프로 샵 PC 를
          `--kiosk-printing` 바로가기로 열어 두면 대화상자 없이 기본 프린터로 바로 나간다
          (docs/pro-shop-receipt-printing-2026-09-12.md). */}
      {preview && previewDoc && previewPlayers.length > 0 ? (
        <div
          aria-label="Receipt"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={(event) => {
            if (event.target === event.currentTarget) setPreview(null);
          }}
          role="dialog"
        >
          <div className="flex max-h-full w-full max-w-sm flex-col border border-[#c7c7cc] bg-[#f2f2f4]">
            <div className="flex items-center gap-2 border-b border-[#c7c7cc] bg-white px-3 py-2">
              <span className="font-bold">{preview.reprint ? "Reprint receipt" : "Receipt"}</span>
              <span className="min-w-0 truncate text-[#5c6270]">
                {previewPlayers.length === 1
                  ? previewPlayers[0].name
                  : `${previewPlayers.length} players — one receipt`}
              </span>
              <button
                className="ml-auto px-1 text-[15px] text-[#4e5560]"
                onClick={() => setPreview(null)}
                title="Close without printing"
                type="button"
              >
                <span aria-hidden>&times;</span>
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              <div
                className="rc-sheet mx-auto bg-white p-3 shadow"
                // 우리 포맷터가 만든 HTML 이다 — 사람이 입력한 글자는 전부 이스케이프돼 있다.
                dangerouslySetInnerHTML={{ __html: receiptSheetHtml(previewDoc, { reprint: preview.reprint }) }}
                style={{ width: "72mm" }}
              />
            </div>

            <div className="flex items-center gap-2 border-t border-[#c7c7cc] bg-white px-3 py-2">
              <button
                className="border border-[#c7c7cc] bg-white px-4 py-2 font-bold"
                onClick={() => setPreview(null)}
                type="button"
              >
                Cancel
              </button>
              <span className="text-[10px] leading-tight text-[#5c6270]">
                Prints 2 copies
                <br />
                customer + merchant
              </span>
              <button
                className="ml-auto bg-[#4533ff] px-5 py-2 font-bold text-white disabled:cursor-not-allowed disabled:bg-[#b1a8ff]"
                disabled={busy || reprintLoading}
                onClick={() =>
                  void (preview.reprint ? reprintReceipt(previewPlayers) : payAndPrint(previewPlayers))
                }
                type="button"
              >
                {reprintLoading
                  ? "Finding payment…"
                  : preview.reprint
                    ? "Print again"
                    : `Pay ${formatMoney(previewDoc.total)} & print`}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* ===== 계산서 영수증 창 (결제 기록 줄에서) =====
          이미 기록된 계산서를 보여 주고 다시 찍기만 한다. 환불된 계산서는 *** REFUNDED *** 와 사유가 찍힌다. */}
      {billPreview ? (
        <div
          aria-label="Receipt"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={(event) => {
            if (event.target === event.currentTarget) setBillPreview(null);
          }}
          role="dialog"
        >
          <div className="flex max-h-full w-full max-w-sm flex-col border border-[#c7c7cc] bg-[#f2f2f4]">
            <div className="flex items-center gap-2 border-b border-[#c7c7cc] bg-white px-3 py-2">
              <span className="font-bold">Receipt {billPreview.receipt_no}</span>
              <span className="min-w-0 truncate text-[#5c6270]">
                {billPreview.status === "refunded" ? "Refunded" : "Paid"}
              </span>
              <button
                className="ml-auto px-1 text-[15px] text-[#4e5560]"
                onClick={() => setBillPreview(null)}
                title="Close"
                type="button"
              >
                <span aria-hidden>&times;</span>
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              <div
                className="rc-sheet mx-auto bg-white p-3 shadow"
                // 우리 포맷터가 만든 HTML 이다 — 사람이 입력한 글자는 전부 이스케이프돼 있다.
                dangerouslySetInnerHTML={{ __html: receiptSheetHtml(saleReceipt(billPreview), { reprint: true }) }}
                style={{ width: "72mm" }}
              />
            </div>

            <div className="flex items-center gap-2 border-t border-[#c7c7cc] bg-white px-3 py-2">
              <button
                className="border border-[#c7c7cc] bg-white px-4 py-2 font-bold"
                onClick={() => setBillPreview(null)}
                type="button"
              >
                Close
              </button>
              <button
                className="ml-auto bg-[#4533ff] px-5 py-2 font-bold text-white"
                onClick={() => {
                  const bill = billPreview;
                  setBillPreview(null);
                  printReceiptDoc(saleReceipt(bill), { reprint: true });
                }}
                type="button"
              >
                Print again
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {rainCheckFor ? (
        <RainCheckDialog
          booking={booking}
          existing={rainChecks.checks}
          onChanged={rainChecks.reload}
          onClose={() => setRainCheckFor(null)}
          players={rainCheckFor}
        />
      ) : null}

      {/* ===== 노란 메모 줄 ===== */}
      <textarea
        aria-label="Reservation note"
        className="block h-8 w-full resize-none border-t border-[#c7c7cc] bg-[#fffbd5] px-3 py-2 leading-4 outline-none focus:h-16 focus:bg-[#fffde8]"
        onChange={(event) => setBookingDraft({ ...draft, notes: event.target.value })}
        placeholder="Type a note concerning this reservation..."
        value={draft.notes}
      />
    </section>
  );
}

/**
 * 상세 패널 왼쪽의 세로 아이콘 레일.
 *
 * 실제로 무언가 하는 것은 셋뿐이다 — 히스토리 · 삭제 · 닫기. 나머지 글리프는
 * 레퍼런스의 자리를 지키는 **표시**이고 버튼이 아니다(`<span>`). 눌러도 아무 일이
 * 없는 과녁을 일곱 개 만들어 두면 사용자는 앱이 고장 났다고 생각한다 — 사이드바의
 * Golf 드롭다운, 상단바 글리프와 같은 판단이다.
 */
function IconRail({
  playerCount,
  historyOpen,
  onToggleHistory,
  onDelete,
  onClose,
}: {
  playerCount: number;
  historyOpen: boolean;
  onToggleHistory: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const cell = "flex h-7 w-9 items-center justify-center";
  return (
    <div className="flex shrink-0 flex-col items-center gap-0.5 border-r border-[#c7c7cc] bg-[#d5d5da] py-2">
      <span className={`${cell} text-[#4e5560]`} title={`${playerCount} player(s)`}>
        <Glyph name="people" />
      </span>
      <button
        aria-pressed={historyOpen}
        className={`${cell} ${historyOpen ? "bg-white text-[#4533ff]" : "text-[#4e5560] hover:bg-white/60"}`}
        onClick={onToggleHistory}
        title="Reservation history"
        type="button"
      >
        <Glyph name="clock" />
      </button>
      <span className={`${cell} text-[#9297a1]`}>
        <Glyph name="tag" />
      </span>
      <span aria-hidden className={`${cell} text-[13px] text-[#9297a1]`}>
        ?
      </span>
      <span className={`${cell} text-[#9297a1]`}>
        <Glyph name="copy" />
      </span>
      <button
        className={`${cell} text-[15px] text-[#4e5560] hover:bg-white/60`}
        onClick={onClose}
        title="Close and expand the tee sheet"
        type="button"
      >
        <span aria-hidden>&times;</span>
      </button>
      <button
        className={`${cell} text-[#8a3f26] hover:bg-white/60`}
        onClick={onDelete}
        title="Delete this reservation"
        type="button"
      >
        <Glyph name="trash" />
      </button>
    </div>
  );
}
