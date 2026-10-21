"use client";

// 예약 상세 패널 (Reservation Detail).
//
// 레이아웃은 pelhamhills 의 하단 패널을 그대로 따른다:
//   ┌ 헤더 줄: ☎ 확인코드 · 홀 수 · 날짜 · 시각 ······ [Cancel] [Save]
//     Cancel 은 저장 안 한 입력을 버리고 패널을 닫는다(예약 취소가 아니다 — 그건 레일의 🗑 에서).
//     Save 는 언제나 누를 수 있고, 저장한 뒤 패널을 닫는다.
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

import { type Bill, type BillLine, posApi, type TeeBill } from "@/lib/pos/api";
import { billActions, getBillState, useCurrentBill } from "@/lib/pos/currentBill";
import retailApi, { localBusinessDate, toRetailError } from "@/lib/retail/api";
import { printReceiptDoc, receiptSheetHtml } from "@/lib/retail/printReceipt";
import { CLUB_TIME_ZONE, PAYMENT_LABELS, saleReceipt } from "@/lib/retail/receipt";
import { computeTax, formatMoney, type Sale } from "@/lib/retail/types";
import { greenFeeOf } from "@/lib/greenFee";
import { longDate, money } from "@/lib/teeSheet/dates";
import { useSlotLocks } from "@/hooks/useSlotLocks";
import { isSlotLocked, slotLockReason } from "@/lib/teeSheet/sun";
import { copyBookingInput } from "@/lib/teeSheet/copy";
import { clubDate, confirmationCode, paidBillFor, teeReceiptFor } from "@/lib/teeSheet/receipt";
import { GUEST_NAME, reservationTitle } from "@/lib/teeSheet/tone";
import type {
  AuditEntry,
  PatchBookingInput,
  PatchPlayerInput,
  Player,
  TeeBooking,
  TeeExtraItem,
  TeeSheetController,
} from "@/lib/teeSheet/types";

import BillPanel from "../pos/BillPanel";
import SaleDetail from "../reports/SaleDetail";
import { SEATS_PER_TEE_TIME } from "./BookingDialog";
import RainCheckDialog, { activeRainCheck, rainCheckTitle, rainCheckTone, useRainChecks } from "./RainCheckDialog";

export type ReservationDetailProps = { controller: TeeSheetController };

// ===== constants =====

/** 예약 한 건 최대 인원 = 기본 4 + 직원 추가 4. 티타임 전체 합계는 서버(0052)가 다시 센다. */
const MAX_PLAYERS = SEATS_PER_TEE_TIME;
const SAVED_FLASH_MS = 1800;

const CANCEL_PRESETS = [
  "Weather / course closed",
  "Guest requested cancellation",
  "Course maintenance",
  "No contact — released slot",
];

/**
 * 요금제 목록. 백엔드의 `ratePlan` 은 자유 문자열이지만 화면에서는 고르게 한다 —
 * 레퍼런스가 드롭다운이고, 무엇보다 `tone.ts` 의 색 규칙이 요금제 이름 속
 * 등급 단어(Full·Weekday·Intermediate·9 Hole·Twilight·Junior·Senior·Staff·GolfNow)를
 * 보기 때문이다. 자유 입력이면 오타 하나로 격자의 색이 조용히 달라진다.
 *
 * 서버가 목록에 없는 값을 들고 있으면 그 값을 그대로 한 항목 더 붙인다(아래 참고) —
 * 고르지 않았는데 저장 버튼 한 번에 값이 바뀌어 버리는 일이 없어야 한다.
 */
const RATE_PLANS = [
  "Public",
  "Public Senior",
  "Public Junior",
  "GolfNow",
  "Friends & Family",
  "LS League",
  "Full Member - Single",
  "Full Member - Single with 7 Day Cart",
  "Weekday Member - Single",
  "Weekday Member - Single with Weekday Cart",
  "Intermediate Member",
  "Restricted Member",
  "Corporate Full Member",
  "9 Hole Member - Single",
  "Twilight Member - Single",
  "Junior Member",
  "Pelham Staff",
];

/** 선수 카드를 Delete 에 놓았을 때 고르는 사유(적요). 직접 적어도 된다. */
const REMOVE_PRESETS = ["Booked twice", "Guest not coming", "Moved to another tee time", "Entered by mistake"];

/** 카드를 끌어다 놓는 곳. 셋 다 매니저 PIN 이 필요하고 사유(적요)가 예약 History 에 남는다(0024 · 0056). */
type DropAction = "raincheck" | "refund" | "delete";

/** Clone 드롭다운에 내놓는 최대 개수 (레퍼런스는 끝없이 늘어나지만 하루 단체가 이 이상인 일은 없다). */
const MAX_CLONES = 20;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ===== local helpers =====

type PlayerDraft = { firstName: string; lastName: string; phone: string; email: string };
/** 예약 단위로 남은 편집 대상. Title·Carts 는 레퍼런스 패널에 없어서 빠졌다.
 *  홀 수는 고르는 즉시 저장한다(그린피가 같이 바뀌어야 해서) — 그래서 draft 에 없다. */
type BookingDraft = { rate: string; notes: string };
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

/** 이름 없는 자리는 서버가 이름을 "Guest" 로 채워 둔다(0003·0004). 그 칸에 타이핑하면
 *  "Guest" 를 지우고 새로 친 글자만 남긴다 — 일일이 지우고 다시 쓰지 않게.
 *  지우기만 했으면(글자가 줄었으면) 그대로 둔다. */
function replaceGuestOnType(prev: string, next: string): string {
  if (prev !== GUEST_NAME || next.length <= prev.length) return next;
  let head = 0;
  while (head < prev.length && next[head] === prev[head]) head += 1;
  let tail = 0;
  while (tail < prev.length - head && next[next.length - 1 - tail] === prev[prev.length - 1 - tail]) tail += 1;
  return next.slice(head, next.length - tail);
}

function bookingDraftOf(booking: TeeBooking): BookingDraft {
  return {
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
  golf: "M8 2.2a5.8 5.8 0 1 1 0 11.6A5.8 5.8 0 0 1 8 2.2zM6.2 5.6h.01M8.6 5h.01M10.2 6.8h.01M7.4 7.6h.01M9.6 9.2h.01M5.8 9h.01",
  umbrella: "M1.8 8a6.2 5.4 0 0 1 12.4 0zM8 2.6V1.8M8 8v4.6a1.3 1.3 0 0 1-2.6 0",
  refund: "M3 5.4a5.6 5.6 0 1 1-.6 4.4M3 2.4v3h3M8 4.8v6.4M9.6 6.2c-.3-.6-.9-.9-1.6-.9-.9 0-1.6.5-1.6 1.2 0 1.6 3.2.9 3.2 2.6 0 .7-.7 1.2-1.6 1.2-.8 0-1.4-.3-1.7-1",
  dots: "M8 3.2h.01M8 8h.01M8 12.8h.01",
  grip: "M6 3.6h.01M10 3.6h.01M6 8h.01M10 8h.01M6 12.4h.01M10 12.4h.01",
  dollar: "M8 1.8a6.2 6.2 0 1 1 0 12.4A6.2 6.2 0 0 1 8 1.8zM8 4.4v7.2M9.8 6c-.3-.6-1-1-1.8-1-1 0-1.8.5-1.8 1.3 0 1.8 3.6 1 3.6 2.9 0 .8-.8 1.3-1.8 1.3-.9 0-1.6-.4-1.9-1.1",
  check: "M8 1.8a6.2 6.2 0 1 1 0 12.4A6.2 6.2 0 0 1 8 1.8zM5.2 8.2l2 2 3.6-4",
  ban: "M8 1.8a6.2 6.2 0 1 1 0 12.4A6.2 6.2 0 0 1 8 1.8zM3.6 3.6l8.8 8.8",
  basket: "M1.8 6.2h12.4l-1.4 7H3.2zM5 6.2l2-4M11 6.2l-2-4M5.6 8.6v2.6M8 8.6v2.6M10.4 8.6v2.6",
  register: "M2 8.6h12v4.8H2zM3.4 8.6l1-3.4h7.2l1 3.4M5.6 5.2V2.4h4.8v2.8M5 11h6",
  person: "M8 2.6a2.6 2.6 0 1 1 0 5.2 2.6 2.6 0 0 1 0-5.2zM2.8 14c0-2.8 2.3-4.6 5.2-4.6s5.2 1.8 5.2 4.6",
  cart: "M1.6 4.2h8.6v5.2H1.6zM3 4.2 4 2.2h4.4l1 2M10.2 6.6h3.2l1 2.8v1.4h-4.2M1.6 10.8h12.8M3.2 12.6a1 1 0 1 0 2 0 1 1 0 1 0-2 0M10.6 12.6a1 1 0 1 0 2 0 1 1 0 1 0-2 0",
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

// 줄 끝의 $ 동전 — 결제됐으면 초록으로 채우고, 아니면 회색 테두리만.
function PaidCoin({ paid }: { paid: boolean }) {
  return (
    <span
      aria-label={paid ? "Paid" : "Not paid"}
      className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-bold leading-none ${
        paid ? "bg-[#168a3c] text-white" : "border border-[#c7c7cc] text-[#b6b6c0]"
      }`}
      role="img"
    >
      $
    </span>
  );
}

/**
 * 품목 줄 끝의 표시. 레퍼런스(Chronogolf)처럼 계산서에 담긴(Select 된) 줄은 보라색으로 채운 동그라미,
 * 아직이면 보라색 테두리만. 결제가 끝난 줄은 초록 $ 동전이다.
 */
function LineMark({ paid, selected }: { paid: boolean; selected: boolean }) {
  if (paid) return <PaidCoin paid />;
  return (
    <span
      aria-label={selected ? "Selected for payment" : "Not selected"}
      className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2 border-[#4533ff] ${
        selected ? "bg-[#4533ff]" : "bg-white"
      }`}
      role="img"
    >
      {selected ? <span className="h-1.5 w-1.5 rounded-full bg-white" /> : null}
    </span>
  );
}

/** 이 사람에게 붙은 추가 품목의 합(세전 달러). */
function extrasTotal(player: Player): number {
  return (player.extras ?? []).reduce((sum, extra) => sum + extra.price, 0);
}

// ===== component =====

export default function ReservationDetail({ controller }: ReservationDetailProps) {
  // 합산 계산서(0005). 훅이라 아래 이른 return 보다 위에 둔다.
  const billState = useCurrentBill();
  const booking = controller.selected;
  const { locks } = useSlotLocks(booking ? [booking.date] : []);
  const bookingId = booking?.id ?? null;
  // 레인체크(0011). 0011 이 아직 안 돌았으면 missing — 버튼을 숨긴다.
  const rainChecks = useRainChecks(bookingId);
  // 레인체크 창에 띄울 사람들. 열 때 한 번 찍어 둔다(5초 새로고침마다 창이 다시 묻지 않게).
  const [rainCheckFor, setRainCheckFor] = useState<Player[] | null>(null);
  // 카드의 ⋮ 메뉴(Raincheck · Refund · Mark unpaid · Delete)가 열린 선수.
  const [menuFor, setMenuFor] = useState<string | null>(null);
  // 카드 드래그 앤 드롭: 끌고 있는 선수와 그 아래 놓일 곳. 놓으면 Rain check · Refund · Delete 창이 뜬다.
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropOver, setDropOver] = useState<DropAction | null>(null);
  // Delete 에 놓았을 때(또는 ⋮ → Delete) 묻는 사유(적요). 사유와 승인 매니저가 History 에 남는다(0056).
  const [removeAsk, setRemoveAsk] = useState<{ playerId: string; reason: string } | null>(null);
  // Refund 에 놓았을 때 여는 계산서 — Reports 의 환불 창과 같은 것(사유 필수 · 카드는 리더에서 먼저).
  const [refundSale, setRefundSale] = useState<Sale | null>(null);

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
  // 레일의 $ — 왼쪽의 Take Payment 패널(지금 계산서). 카드의 Select 를 누르면 저절로 열린다.
  const [payOpen, setPayOpen] = useState(false);
  // Take Payment 패널의 두 단계: 요약(Paid By · 수단 · 품목 · 합계) → 실제 결제(BillPanel).
  const [payStep, setPayStep] = useState<"summary" | "checkout">("summary");
  const [payMethod, setPayMethod] = useState<"card" | "cash">("card");
  // 레일의 복사 아이콘 — Clone Reservation 패널. 열리면 카드 자리를 차지한다(레퍼런스와 같다).
  const [cloneOpen, setCloneOpen] = useState(false);
  // 레일의 바구니 · 카드의 + — Add Products 패널. `productsFor` 는 품목을 붙일 선수.
  const [productsOpen, setProductsOpen] = useState(false);
  const [productsFor, setProductsFor] = useState<string | null>(null);
  // 추가 품목 카탈로그(0026). 패널을 처음 열 때 읽는다. null = 아직, "error" = 못 읽음(0026 이 없을 수도).
  const [catalog, setCatalog] = useState<TeeExtraItem[] | "error" | null>(null);
  const [cloneCount, setCloneCount] = useState(1);
  const [cloning, setCloning] = useState(false);
  // 카트 요금 입력 중인 글자. 이름·전화 draft 와 따로 둔다 — 그 draft 는 필드 전체를 한 번에
  // 찍어 두므로, 카트를 켜서 서버가 요금을 채운 직후에 이름 draft 가 커밋되면 옛 요금(0)을 되돌려 보낸다.
  const [feeDrafts, setFeeDrafts] = useState<Record<string, string>>({});
  // 그린피 입력 중인 글자(선수별, 0055)와 정상가가 아닌 금액의 사유를 묻는 칸.
  const [greenDrafts, setGreenDrafts] = useState<Record<string, string>>({});
  const [priceAsk, setPriceAsk] = useState<{ playerId: string; fee: number; reason: string } | null>(null);
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

  // 비동기 저장 도중에도 최신 값을 읽기 위한 미러 ref 들.
  const bookingRef = useRef<TeeBooking | null>(booking);
  const draftsRef = useRef<Record<string, PlayerDraft>>(playerDrafts);
  const bookingDraftRef = useRef<BookingDraft | null>(bookingDraft);
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

  // 선택이 바뀌면 draft 를 버린다 (id 기준 — booking 객체 identity 기준이 아니다.
  // 객체 기준으로 리셋하면 매 PATCH 응답마다 입력 중인 값이 날아간다).
  useEffect(() => {
    setBookingDraft(null);
    setPlayerDrafts({});
    setMode("none");
    setCancelReason("");
    setDateDraft(null);
    setHistoryOpen(false);
    setCloneOpen(false);
    setCloneCount(1);
    setProductsOpen(false);
    setProductsFor(null);
    setFeeDrafts({});
    setPayStep("summary");
    setReceiptNote(null);
    setPreview(null);
    setBillPreview(null);
    setRainCheckFor(null);
    setMenuFor(null);
    setDragging(null);
    setDropOver(null);
    setRemoveAsk(null);
    setRefundSale(null);
    setSaveState({ kind: "idle", nonce: 0 });
  }, [bookingId]);

  // 카탈로그는 패널을 열 때 읽는다. 못 읽었으면 다음에 열 때 다시 묻는다.
  const { loadExtras } = controller;
  useEffect(() => {
    if (!productsOpen || Array.isArray(catalog)) return;
    let live = true;
    loadExtras()
      .then((list) => {
        if (live) setCatalog(Array.isArray(list) ? list : []);
      })
      .catch(() => {
        if (live) setCatalog("error");
      });
    return () => {
      live = false;
    };
    // catalog 는 결과를 담을 뿐 — 다시 읽는 계기는 패널을 여는 것이다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productsOpen, loadExtras]);

  // ⋮ 메뉴는 바깥을 누르거나 Esc 로 닫는다. 메뉴 안의 클릭은 data-player-menu 로 걸러 낸다.
  useEffect(() => {
    if (!menuFor) return;
    const onDown = (event: MouseEvent) => {
      if (!(event.target as Element | null)?.closest?.("[data-player-menu]")) setMenuFor(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuFor(null);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuFor]);

  // Add Products 드롭다운도 바깥을 누르거나 Esc 로 닫는다. 레일의 바구니·카드의 + 는 스스로 여닫는다.
  useEffect(() => {
    if (!productsOpen) return;
    const onDown = (event: MouseEvent) => {
      if (!(event.target as Element | null)?.closest?.("[data-products-menu]")) setProductsOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setProductsOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [productsOpen]);

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

  /** draft 를 커밋한다. 응답 후에도 draft 가 그대로면(=그 사이 타이핑 없음) 지운다.
   *  바뀐 게 있어 보냈으면 true, 보낼 게 없었으면 false, 서버가 거절했으면 null(draft 는 남긴다). */
  const commitPlayer = useCallback(
    async (playerId: string): Promise<boolean | null> => {
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
      if (!updated) return null;
      if (titleWasTracking) {
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

  // 이름·전화·이메일은 draft 로만 들고 있다가 Save 에서 보낸다 — Cancel 이 되돌릴 수 있게.
  // (예전에는 타이핑을 멈추거나 칸을 벗어나면 바로 저장돼서 Cancel 로 되돌릴 게 없었다.)
  const setPlayerField = useCallback((player: Player, field: keyof PlayerDraft, value: string) => {
    setPlayerDrafts((prev) => {
      const base = prev[player.id] ?? playerDraftOf(player);
      return { ...prev, [player.id]: { ...base, [field]: replaceGuestOnType(base[field], value) } };
    });
  }, []);

  /** 그린피 칸을 커밋한다 (blur·Enter). 이 사람 몫만 바뀐다(0055) — 그룹·패밀리 예약이라도 한 명씩 고친다.
   *  요금표 값과 같으면 정정을 지우고(PIN 없음), 다르면 카드 안에 사유 칸을 연다. 사유를 적고 Save 를 누르면
   *  서버가 매니저 승인(0024 `price`)을 요구해 PIN 창이 뜬다. 정상가가 아닌 금액은 Reports 의 Price review 에 남는다. */
  const commitGreenFee = useCallback(
    (playerId: string, text: string) => {
      setGreenDrafts((prev) => {
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
      if (cents === Math.round(greenFeeOf(current, player) * 100)) return;
      const standard = player.priceOverride?.standard;
      if (typeof standard === "number" && cents === Math.round(standard * 100)) {
        void controller.setPlayerGreenFee(current.id, playerId, null, "");
        return;
      }
      // 같은 예약에서 바로 전에 적은 사유를 채워 둔다 — 일행 여럿을 같은 이유로 고칠 때 다시 치지 않게.
      const lastReason = current.players.find((p) => p.priceOverride?.reason)?.priceOverride?.reason ?? "";
      setPriceAsk({ playerId, fee: cents / 100, reason: lastReason });
    },
    [controller],
  );

  const savePriceAsk = useCallback(async () => {
    const current = bookingRef.current;
    if (!current || !priceAsk || !priceAsk.reason.trim()) return;
    const updated = await controller.setPlayerGreenFee(current.id, priceAsk.playerId, priceAsk.fee, priceAsk.reason.trim());
    if (updated) setPriceAsk(null);
  }, [controller, priceAsk]);

  /** 홀 수를 바로 저장한다. 서버(0036)가 그린피를 새 홀 수의 요금표 값으로 바꿔 돌려주므로 그린피 칸도 그 값으로 맞춘다. */
  const commitHoles = useCallback(
    async (holes: 9 | 18) => {
      const current = bookingRef.current;
      if (!current || holes === current.holes) return;
      const updated = await controller.patchBooking(current.id, { holes });
      if (updated) setBookingDraft((prev) => (prev ? { ...prev, rate: String(updated.rate) } : prev));
    },
    [controller],
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

  /** 남은 draft 를 전부 보낸다. 하나라도 서버가 거절하면 false — 그 draft 는 칸에 남는다. */
  const saveAll = useCallback(async (): Promise<boolean> => {
    const current = bookingRef.current;
    if (!current) return false;
    beginSave();
    let changed = false;
    let ok = true;
    try {
      // 플레이어부터 순차로. 각 응답이 booking 전체를 교체하므로 병렬 금지.
      for (const player of current.players) {
        const result = await commitPlayer(player.id);
        if (result === null) ok = false;
        changed = changed || result === true;
      }
      const latest = bookingRef.current ?? current;
      const draft = bookingDraftRef.current;
      if (draft) {
        const patch = bookingPatchFrom(latest, draft);
        if (Object.keys(patch).length > 0) {
          if (await controller.patchBooking(latest.id, patch)) changed = true;
          else ok = false;
        }
        if (ok) setBookingDraft((prev) => (prev === draft ? null : prev));
      }
    } finally {
      endSave(changed);
    }
    return ok;
  }, [beginSave, commitPlayer, controller, endSave]);

  /** 헤더의 Cancel — 저장 안 한 입력(이름·전화·이메일·메모·적다 만 요금)을 버린다.
   *  홀 수·날짜·시각·요금제·카트처럼 고르는 즉시 저장되는 것은 이미 서버에 있으므로 되돌리지 않는다. */
  const discardEdits = useCallback(() => {
    setBookingDraft(null);
    setPlayerDrafts({});
    setFeeDrafts({});
    setDateDraft(null);
    setMode("none");
    setCancelReason("");
  }, []);

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
  /** 그린피를 뺀 이 사람 몫(카트 + 추가 품목). */
  const addOnsOf = (player: Player) => cartPart(player) + extrasTotal(player);
  const dueFor = (player: Player) => (player.paid || player.cancelled ? 0 : greenFeeOf(booking, player) + addOnsOf(player));

  // 전체 결제 대상과 그 청구액. 센트는 영수증과 **같은 방식**으로 만든다(사람마다 그린피·카트를
  // 따로 반올림한 뒤 더하고, 세금은 합계에 한 번). 그래야 버튼 금액과 종이의 Total 이 같다.
  const unpaidPlayers = players.filter((player) => !player.paid && !player.cancelled);
  const unpaidSubtotal = unpaidPlayers.reduce(
    (sum, player) =>
      sum +
      Math.round(greenFeeOf(booking, player) * 100) +
      Math.round(cartPart(player) * 100) +
      (player.extras ?? []).reduce((cents, extra) => cents + Math.round(extra.price * 100), 0),
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
      setPayStep("summary");
      setPayOpen(true);
      controller.pushToast("success", `Added to bill #${added.id} — ${formatMoney(added.total)} so far.`);
    } else {
      controller.pushToast("error", getBillState().error || "Could not add to the bill.");
    }
  };
  const unbilledUnpaid = unpaidPlayers.filter((player) => !billOf(player.id));

  // 레인체크는 결제한 사람에게만 나간다(낸 돈이 크레딧이다).
  const useRainCheck = !rainChecks.missing;
  const paidPlayers = players.filter((player) => player.paid && !player.cancelled);
  const withoutRainCheck = paidPlayers.filter((player) => !activeRainCheck(rainChecks.checks, player.id));

  /**
   * Clone 대상: 같은 날 **이 예약 뒤의** 티 타임 가운데 이 일행이 통째로 들어가는 곳, 이른 순.
   * 좌석 계산은 서버의 require_capacity 와 같다(취소된 예약은 자리를 잡지 않는다).
   * 슬롯 목록은 controller.slots(= focusedDate 의 것)뿐이라, 다른 날을 보고 있으면 비워 둔다.
   */
  const groupSize = Math.max(1, players.filter((player) => !player.cancelled).length);
  const cloneTargets = (() => {
    if (controller.focusedDate !== booking.date) return [];
    const sorted = [...controller.slots].sort((a, b) => a.minutes - b.minutes);
    const start = sorted.find((slot) => slot.time === booking.time)?.minutes;
    if (start === undefined) return [];
    const taken = new Map<string, number>();
    for (const item of controller.bookings) {
      if (item.date !== booking.date || item.status === "cancelled") continue;
      taken.set(item.time, (taken.get(item.time) ?? 0) + item.players.length);
    }
    return sorted
      .filter(
        (slot) =>
          slot.minutes > start &&
          !isSlotLocked(booking.date, slot.minutes, locks) &&
          (taken.get(slot.time) ?? 0) + groupSize <= SEATS_PER_TEE_TIME,
      )
      .slice(0, MAX_CLONES)
      .map((slot) => slot.time);
  })();
  const cloneN = Math.min(cloneCount, cloneTargets.length);

  /**
   * 복제가 무엇을 옮기는지는 copyBookingInput(lib/teeSheet/copy.ts)이 정한다. 한 건씩 **차례로**
   * 만든다 — 하나가 정원에 걸려 실패해도(다른 화면이 먼저 채운 경우) 앞의 것은 남고, 몇 건이
   * 됐는지 정확히 알린다.
   */
  const cloneReservation = async () => {
    if (cloning || cloneN === 0) return;
    setCloning(true);
    let made = 0;
    try {
      if (dirty) await saveAll();
      const source = bookingRef.current ?? booking;
      for (const time of cloneTargets.slice(0, cloneN)) {
        const created = await controller.createBooking(copyBookingInput(source, source.date, time));
        if (!created) break;
        made += 1;
      }
    } finally {
      setCloning(false);
    }
    if (made > 0) {
      controller.pushToast("success", `Cloned into ${made} tee time${made === 1 ? "" : "s"}.`);
      setCloneOpen(false);
      setCloneCount(1);
    }
  };

  /** Add Products 의 대상 선수. 고른 사람이 없거나 사라졌으면 아직 안 낸 첫 사람, 그도 없으면 첫 사람. */
  const productTarget =
    players.find((player) => player.id === productsFor) ?? unpaidPlayers[0] ?? players[0] ?? null;
  const openProducts = (playerId: string | null) => {
    setCloneOpen(false);
    setProductsFor(playerId);
    setProductsOpen(true);
  };
  /** 품목을 붙이거나 뗀다. 붙어 있던 줄은 붙일 때의 값을 그대로 보낸다(서버도 그 값을 지킨다). */
  const addExtra = (player: Player, item: TeeExtraItem) =>
    void controller.setPlayerExtras(booking.id, player.id, [
      ...(player.extras ?? []),
      { code: item.code, name: item.name, price: Number(item.price) },
    ]);
  const removeExtra = (player: Player, index: number) =>
    void controller.setPlayerExtras(
      booking.id,
      player.id,
      (player.extras ?? []).filter((_, at) => at !== index),
    );

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

  /** 이 사람의 그린피를 받은 결제 계산서(아직 환불 안 된 것). 없으면 계산서 없이 결제로 표시한 옛 기록이다. */
  const paidBillOf = (playerId: string) =>
    bookingBills.find(
      (bill) =>
        bill.status === "paid" &&
        bill.lines.some(
          (line) => line.kind === "tee_player" && line.booking_id === booking.id && line.player_id === playerId,
        ),
    );

  /** Refund: 그 계산서를 Reports 와 같은 환불 창으로 연다. 계산서 하나에 일행·상품이 같이 있으면 통째로 환불된다. */
  const openRefund = async (player: Player) => {
    const bill = paidBillOf(player.id);
    if (!bill) {
      controller.pushToast("error", "No paid bill on file for this player — refund it from Reports → Daily close.");
      return;
    }
    try {
      setRefundSale(await retailApi.getSale(bill.id));
    } catch (error) {
      controller.pushToast("error", toRetailError(error).message);
    }
  };

  /** 놓을 수 있나. 안 되면 그 이유(놓는 곳에 회색으로 보인다). */
  const dropBlock = (action: DropAction, player: Player): string | null => {
    if (action === "raincheck") {
      if (!useRainCheck) return "Not set up";
      return player.paid && !player.cancelled ? null : "Paid players only";
    }
    if (action === "refund") {
      if (!player.paid) return "Not paid";
      return paidBillOf(player.id) ? null : "No bill — use Reports";
    }
    return players.length > 1 ? null : "Last player";
  };

  const runDrop = (action: DropAction, player: Player) => {
    setMenuFor(null);
    const block = dropBlock(action, player);
    if (block) {
      controller.pushToast("error", `${player.name || "Player"}: ${block}.`);
      return;
    }
    if (action === "raincheck") setRainCheckFor([player]);
    else if (action === "refund") void openRefund(player);
    else setRemoveAsk({ playerId: player.id, reason: "" });
  };
  const draggedPlayer = dragging ? (players.find((player) => player.id === dragging) ?? null) : null;
  const removePlayer = removeAsk ? (players.find((player) => player.id === removeAsk.playerId) ?? null) : null;

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
            disabled={busy}
            onChange={(event) => void commitHoles(Number(event.target.value) === 9 ? 9 : 18)}
            title="9 or 18 holes — saved right away. The green fee is reset to the rate card unless someone has paid."
            value={String(booking.holes)}
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
            {timeOptions.map((time) => {
              // 잠긴 칸(일출 전·일몰 2시간 전 이후·직원 블록)은 고를 수 없다. 이 예약이 이미 그 시각이면 그대로 보여 준다.
              const dark = time !== booking.time && Boolean(slotLockReason(booking.date, time, locks));
              return (
                <option disabled={dark} key={time} value={time}>
                  {dark ? `🔒 ${time}` : time}
                </option>
              );
            })}
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
          disabled={busy}
          onClick={() => {
            discardEdits();
            controller.select(null);
          }}
          title="Discard what you typed and close"
          type="button"
        >
          Cancel
        </button>
        <button
          className="bg-[#4533ff] px-5 py-1.5 font-bold text-white disabled:cursor-not-allowed disabled:bg-[#b1a8ff]"
          disabled={busy}
          onClick={async () => {
            // 칸에서 바로 Save 를 누르면 카트 요금의 blur 저장이 아직 가는 중일 수 있다.
            await Promise.all(feeCommitsRef.current.values());
            // 실패하면 패널을 열어 둔다 — 고친 값이 칸에 남아 있어 다시 누를 수 있다.
            if (await saveAll()) controller.select(null);
          }}
          title="Save and close"
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
            {booking.status !== "cancelled" ? (
              <button
                className="border border-[#8a3f26] bg-white px-4 py-2 font-bold text-[#8a3f26] disabled:opacity-40"
                disabled={busy}
                onClick={() => setMode("cancel")}
                type="button"
              >
                Cancel reservation instead
              </button>
            ) : null}
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

      {/* ===== 선수 삭제 사유(적요) — 카드를 Delete 에 놓거나 ⋮ → Delete =====
          매니저 PIN 은 서버가 요구한다(0024). 사유와 승인 매니저는 History 에 남는다(0056). */}
      {removeAsk && removePlayer ? (
        <form
          className="border-b border-[#8a3f26] bg-[#fbeae5] p-3"
          onSubmit={async (event) => {
            event.preventDefault();
            const reason = removeAsk.reason.trim();
            if (!reason) return;
            if (await controller.removePlayer(booking.id, removePlayer.id, reason)) setRemoveAsk(null);
          }}
        >
          <p className="font-bold text-[#8a3f26]">Remove {removePlayer.name || "this player"} from the reservation — why?</p>
          {removePlayer.paid ? (
            <p className="mt-1 text-[#6d3a27]">
              This player has paid. Removing does not give the money back — drag the card onto Refund first.
            </p>
          ) : null}
          <div className="mt-2 flex flex-wrap gap-1">
            {REMOVE_PRESETS.map((preset) => (
              <button
                className="border border-[#d7d7dc] bg-[#f2f2f4] px-2 py-1 hover:border-[#8a3f26]"
                key={preset}
                onClick={() => setRemoveAsk({ ...removeAsk, reason: preset })}
                type="button"
              >
                {preset}
              </button>
            ))}
          </div>
          <input
            autoFocus
            className="mt-2 w-full border border-[#d7d7dc] bg-white p-2 outline-none focus:border-[#8a3f26]"
            maxLength={200}
            onChange={(event) => setRemoveAsk({ ...removeAsk, reason: event.target.value })}
            placeholder="Reason — written to History with the approving manager"
            value={removeAsk.reason}
          />
          <div className="mt-2 flex items-center gap-2">
            <button
              className="border border-[#8a3f26] bg-[#8a3f26] px-4 py-2 font-bold text-white disabled:opacity-40"
              disabled={busy || !removeAsk.reason.trim()}
              type="submit"
            >
              Remove player
            </button>
            <button
              className="border border-[#c7c7cc] bg-white px-4 py-2 font-bold"
              onClick={() => setRemoveAsk(null)}
              type="button"
            >
              Back
            </button>
            <span className="text-[10px] text-[#6d3a27]">Manager PIN needed</span>
          </div>
        </form>
      ) : null}

      {/* ===== 아이콘 레일 + 플레이어 카드 ===== */}
      <div className="flex items-stretch">
        <IconRail
          canPay={useBills}
          cloneOpen={cloneOpen}
          onToggleClone={() => {
            setProductsOpen(false);
            setCloneOpen((open) => !open);
          }}
          productsOpen={productsOpen}
          onToggleProducts={() => (productsOpen ? setProductsOpen(false) : openProducts(productsFor))}
          historyOpen={historyOpen}
          onTogglePay={() => setPayOpen((open) => !open)}
          payOpen={payOpen && useBills}
          onDelete={() => setMode(mode === "delete" ? "none" : "delete")}
          onToggleHistory={() => setHistoryOpen((open) => !open)}
          playerCount={players.length}
        />

        {/* ===== Take Payment (레일의 $) =====
            레퍼런스처럼 카드 왼쪽에 지금 계산서를 펼친다. 카드의 Select 로 라운드를 담고 여기서 받는다 —
            계산대·스낵바에서 담은 상품도 같은 계산서에 있다. 비어 있으면 안내만. */}
        {payOpen && useBills ? (
          <div className="w-[260px] shrink-0 overflow-y-auto border-r border-[#c7c7cc] bg-white">
            {billState.bill && billState.bill.lines.length > 0 ? (
              <TakePaymentSummary
                bill={billState.bill}
                booking={booking}
                busy={busy || billState.busy}
                method={payMethod}
                onMethod={setPayMethod}
                onPaidBy={(name) => void billActions.update({ label: name }, "tee_sheet")}
                onTakePayment={() => setPayStep("checkout")}
              />
            ) : (
              <div className="flex h-full flex-col items-center justify-center px-6 py-8 text-center">
                <span className="flex h-14 w-14 items-center justify-center rounded-full bg-[#1f2328] text-white">
                  <Glyph className="h-9 w-9" name="dollar" />
                </span>
                <p className="mt-4 text-sm font-bold">Please select rounds</p>
                <p className="mt-2 text-[#4e5560]">This allows you to combine multiple rounds into one invoice.</p>
              </div>
            )}
          </div>
        ) : null}

        {/* ===== Sales 화면 =====
            Take Payment 를 누르면 Lightspeed 의 Sales 화면처럼 넓게 펼친다 — 품목 표(DESCRIPTION · PRICE · QTY ·
            TAX · SUBTOTAL)와 오른쪽 합계·결제. 같은 계산서(BillPanel)라 계산대에서 받는 것과 규칙이 같다. */}
        {payOpen && useBills && payStep === "checkout" ? (
          <div
            aria-label="Sales"
            aria-modal="true"
            className="fixed inset-0 z-[70] flex flex-col bg-white text-[13px] text-[#1f2328]"
            role="dialog"
          >
            <div className="flex items-center gap-3 border-b border-[#d4d4d8] bg-white px-4 py-2.5">
              <button
                className="flex items-center gap-1 border border-[#c7c7cc] px-3 py-1.5 font-bold hover:bg-[#f2f2f5]"
                onClick={() => setPayStep("summary")}
                title="Back to the reservation — the bill stays open"
                type="button"
              >
                <span aria-hidden>&larr;</span> Tee sheet
              </button>
              <Glyph className="h-5 w-5 text-[#4e5560]" name="register" />
              <h2 className="text-[17px] font-normal">Sales</h2>
            </div>
            <div className="min-h-0 flex-1">
              <BillPanel
                customer={billState.bill?.label ?? undefined}
                describeLine={(line) => describeTeeLine(line, booking)}
                initialMethod={payMethod}
                key={payMethod}
                layout="sales"
                onDone={() => {
                  setPayStep("summary");
                  setPayOpen(false);
                }}
                onPaid={() => void controller.refresh()}
                station="tee_sheet"
              />
            </div>
          </div>
        ) : null}

        {cloneOpen ? (
          <ClonePanel
            busy={cloning}
            count={cloneN}
            groupSize={groupSize}
            onCancel={() => setCloneOpen(false)}
            onChangeCount={setCloneCount}
            onClone={() => void cloneReservation()}
            otherDay={controller.focusedDate !== booking.date}
            targets={cloneTargets}
          />
        ) : (
        <div className="relative flex min-w-0 flex-1">
        <div className="flex min-w-0 flex-1 items-stretch gap-2 overflow-x-auto p-2">
          {players.map((player) => {
            const pd = playerDrafts[player.id] ?? playerDraftOf(player);
            const emailInvalid = pd.email.trim() !== "" && !EMAIL_RE.test(pd.email.trim());
            // 서버 값이 목록에 없으면 그 값도 항목으로 붙인다 (RATE_PLANS 주석 참고).
            const plan = player.ratePlan?.trim() || "Public";
            const planOptions = RATE_PLANS.includes(plan) ? RATE_PLANS : [plan, ...RATE_PLANS];
            const cartOn = player.cart === true;
            // 이 선수의 라운드가 열린 계산서에 담겼나(= 레퍼런스의 Select 된 상태).
            const onBill = useBills ? billOf(player.id) : null;
            const selected = !player.paid && Boolean(onBill);

            return (
              <article
                className={`flex w-[264px] shrink-0 flex-col border bg-white p-1.5 ${
                  dragging === player.id ? "border-dashed border-[#4533ff] opacity-50" : "border-[#c7c7cc]"
                }`}
                key={player.id}
              >
                {/* 머리 줄이 드래그 손잡이다 — 카드 전체를 끌게 하면 이름·전화 칸에서 글자를 고를 수 없다.
                    Chrome 은 dragstart 안에서 DOM 이 바뀌면 끌기를 취소하므로 놓을 곳은 다음 틱에 띄운다. */}
                <div
                  className={`mb-1.5 flex items-center gap-1.5 ${busy ? "" : "cursor-grab active:cursor-grabbing"}`}
                  draggable={!busy}
                  onDragEnd={() => {
                    setDragging(null);
                    setDropOver(null);
                  }}
                  onDragStart={(event) => {
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData("text/plain", player.id);
                    const card = event.currentTarget.closest("article");
                    if (card) event.dataTransfer.setDragImage(card, 24, 16);
                    setMenuFor(null);
                    window.setTimeout(() => setDragging(player.id), 0);
                  }}
                  title="Drag this card onto Rain check, Refund or Delete"
                >
                  <Glyph className="-mx-0.5 h-3.5 w-3.5 text-[#b6b6c0]" name="grip" />
                  {player.type === "Guest" ? null : (
                    <span
                      aria-hidden
                      className="flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-full border border-[#c7c7cc] bg-[#f2f2f4] text-[#9aa0a6]"
                    >
                      <Glyph className="mt-1.5 h-6 w-6" name="person" />
                    </span>
                  )}
                  <span className="truncate text-[13px]">{player.type}</span>
                  {/* 레퍼런스의 머리 ⋮ — 선수 한 명에게 하는 드문 일(레인체크·환불·삭제)을 한곳에 모은다.
                      환불은 계산서 단위라 Reports → Daily close 의 그 영업일로 보낸다(0005). */}
                  {/* 레인체크·환불·빼기는 ⋮ 안에만 있으면 직원이 못 찾는다 — 카드마다 아이콘으로 꺼내 둔다
                      (⋮ 메뉴와 같은 길). 지금 못 하는 것은 흐리게 두고 이유를 툴팁으로 보인다. */}
                  {useRainCheck
                    ? (() => {
                        // 이미 내준 사람은 ☂ 를 채운다(파랑 = 쓸 수 있음, 회색 = 썼거나 지남). 눌러도 다시
                        // 발행하지 않고 같은 창에서 재인쇄·문자·무효만 한다(RainCheckDialog).
                        const check = activeRainCheck(rainChecks.checks, player.id);
                        const tone = check ? rainCheckTone(check) : null;
                        return (
                          <button
                            aria-label={check ? rainCheckTitle(check) : `Rain check for ${player.name || "this player"}`}
                            aria-pressed={Boolean(check)}
                            className={`ml-auto flex items-center p-1 disabled:text-[#c7c7cc] disabled:hover:bg-transparent ${
                              tone === "live"
                                ? "bg-[#1d6fb8] text-white hover:bg-[#175c99]"
                                : tone === "spent"
                                  ? "bg-[#9aa0a6] text-white hover:bg-[#80868b]"
                                  : "text-[#1d6fb8] hover:bg-[#eef5fc]"
                            }`}
                            disabled={busy || (!check && (!player.paid || Boolean(player.cancelled)))}
                            onClick={() => (check ? setRainCheckFor([player]) : runDrop("raincheck", player))}
                            title={
                              check
                                ? `${rainCheckTitle(check)} — reprint, text or void`
                                : player.paid && !player.cancelled
                                  ? "Give this player a rain check slip (barcode + expiry date) (manager PIN)"
                                  : "Rain check — paid players only"
                            }
                            type="button"
                          >
                            <Glyph className="h-3.5 w-3.5" name="umbrella" />
                          </button>
                        );
                      })()
                    : null}
                  {player.paid && !paidBillOf(player.id) ? (
                    <Link
                      aria-label={`Refund ${player.name || "this player"}`}
                      className={`flex items-center p-1 text-[#8a3f26] hover:bg-[#fff1ee] ${useRainCheck ? "" : "ml-auto"}`}
                      href={`/admin/reports?date=${localBusinessDate(player.paidAt ? new Date(player.paidAt) : new Date())}`}
                      title="Refund the bill this player was paid on — Reports → Daily close. Card and debit payments are refunded from that screen."
                    >
                      <Glyph className="h-3.5 w-3.5" name="refund" />
                    </Link>
                  ) : (
                    <button
                      aria-label={`Refund ${player.name || "this player"}`}
                      className={`flex items-center p-1 text-[#8a3f26] hover:bg-[#fff1ee] disabled:text-[#c7c7cc] disabled:hover:bg-transparent ${
                        useRainCheck ? "" : "ml-auto"
                      }`}
                      disabled={busy || !player.paid}
                      onClick={() => runDrop("refund", player)}
                      title={
                        player.paid
                          ? "Refund the bill this player was paid on (reason + manager PIN)"
                          : "Refund — this player has not paid"
                      }
                      type="button"
                    >
                      <Glyph className="h-3.5 w-3.5" name="refund" />
                    </button>
                  )}
                  <button
                    aria-label={`Remove ${player.name || "this player"} from the reservation`}
                    className="flex items-center p-1 text-[#c0262d] hover:bg-[#fff1ee] disabled:text-[#c7c7cc] disabled:hover:bg-transparent"
                    disabled={busy || players.length <= 1}
                    onClick={() => runDrop("delete", player)}
                    title={
                      players.length <= 1
                        ? "Last player — cancel or delete the whole reservation from the rail instead"
                        : "Remove only this player — the rest of the group stays booked (reason + manager PIN)"
                    }
                    type="button"
                  >
                    <Glyph className="h-3.5 w-3.5" name="trash" />
                  </button>
                  <div className="relative" data-player-menu>
                    <button
                      aria-expanded={menuFor === `${player.id}:card`}
                      aria-haspopup="menu"
                      aria-label="More actions for this player"
                      className={`flex items-center p-1 disabled:opacity-40 ${
                        menuFor === `${player.id}:card` ? "bg-[#f3f2ff] text-[#4533ff]" : "hover:bg-[#f2f2f5]"
                      }`}
                      disabled={busy}
                      onClick={() => setMenuFor(menuFor === `${player.id}:card` ? null : `${player.id}:card`)}
                      type="button"
                    >
                      <Glyph className="h-3.5 w-3.5" name="dots" />
                    </button>
                    {menuFor === `${player.id}:card` ? (
                      <div
                        className="absolute right-0 top-full z-20 mt-1 min-w-[150px] border border-[#c7c7cc] bg-white py-1 text-[12px] shadow-lg"
                        role="menu"
                      >
                        {useRainCheck && player.paid && !player.cancelled ? (
                          <button
                            className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-[#f2f2f5]"
                            onClick={() => {
                              setMenuFor(null);
                              setRainCheckFor([player]);
                            }}
                            role="menuitem"
                            title="Give this player a rain check slip (barcode + expiry date), or reprint / void one"
                            type="button"
                          >
                            <Glyph className="h-4 w-4" name="umbrella" />
                            Raincheck
                            <span className="ml-auto pl-2 text-[10px] text-[#9aa0a6]">Manager</span>
                          </button>
                        ) : null}
                        {player.paid && paidBillOf(player.id) ? (
                          <button
                            className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-[#f2f2f5]"
                            onClick={() => runDrop("refund", player)}
                            role="menuitem"
                            title="Refund the bill this player was paid on — a reason and a manager PIN are needed"
                            type="button"
                          >
                            <Glyph className="h-4 w-4" name="refund" />
                            Refund
                            <span className="ml-auto pl-2 text-[10px] text-[#9aa0a6]">Manager</span>
                          </button>
                        ) : player.paid ? (
                          <Link
                            className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-[#f2f2f5]"
                            href={`/admin/reports?date=${localBusinessDate(player.paidAt ? new Date(player.paidAt) : new Date())}`}
                            onClick={() => setMenuFor(null)}
                            role="menuitem"
                            title="Refund the bill this player was paid on — Reports → Daily close. Card and debit payments are refunded from that screen."
                          >
                            <Glyph className="h-4 w-4" name="refund" />
                            Refund
                          </Link>
                        ) : null}
                        {player.paid ? (
                          <button
                            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[#4e5560] hover:bg-[#f2f2f5]"
                            onClick={() => {
                              setMenuFor(null);
                              void controller.patchPlayer(booking.id, player.id, { paid: false });
                            }}
                            role="menuitem"
                            title="Clear the payment on this card — only to fix a mistake"
                            type="button"
                          >
                            <Glyph className="h-4 w-4" name="card" />
                            Mark unpaid
                            <span className="ml-auto pl-2 text-[10px] text-[#9aa0a6]">Manager</span>
                          </button>
                        ) : null}
                        <button
                          className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[#c0262d] hover:bg-[#fff1ee]"
                          onClick={() => runDrop("delete", player)}
                          role="menuitem"
                          title="Remove this player from the reservation — a reason and a manager PIN are needed"
                          type="button"
                        >
                          <Glyph className="h-4 w-4" name="trash" />
                          Delete
                          <span className="ml-auto pl-2 text-[10px] text-[#9aa0a6]">Manager</span>
                        </button>
                      </div>
                    ) : null}
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-1">
                  <label className="block">
                    <span className="sr-only">Last Name</span>
                    <input
                      className="w-full border-b border-[#d7d7dc] px-1 py-1 font-bold outline-none focus:border-[#4533ff]"
                      onChange={(event) => setPlayerField(player, "lastName", event.target.value)}
                      placeholder="Last Name"
                      value={pd.lastName}
                    />
                  </label>
                  <label className="block">
                    <span className="sr-only">First Name</span>
                    <input
                      className="w-full border-b border-[#d7d7dc] px-1 py-1 outline-none focus:border-[#4533ff]"
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

                {/* 레퍼런스처럼 Arrived | No show 두 칸 + ⋮. 각 칸은 자기 상태를 켜고 끈다 — 하나를 켜면
                    다른 하나는 끈다(도착한 사람이 노쇼일 수는 없다). ⋮ 는 둘 다 지우기. */}
                <div className="mt-1.5 grid grid-cols-[1fr_1fr_auto] gap-1 bg-[#f2f2f4] p-1">
                  <button
                    aria-pressed={player.arrived && !player.no_show}
                    className={`flex items-center justify-center gap-1.5 border px-1 py-1 font-bold disabled:opacity-40 ${
                      player.arrived && !player.no_show
                        ? "border-[#168a3c] bg-[#e8f6ec] text-[#168a3c]"
                        : "border-[#d7d7dc] bg-white text-[#4e5560] hover:border-[#9aa0a6]"
                    }`}
                    disabled={busy}
                    onClick={() =>
                      void controller.patchPlayer(
                        booking.id,
                        player.id,
                        player.arrived && !player.no_show ? { arrived: false } : { arrived: true, no_show: false },
                      )
                    }
                    title={player.arrived && !player.no_show ? "Undo arrived" : "Check this player in"}
                    type="button"
                  >
                    <Glyph className="h-3.5 w-3.5" name="check" />
                    Arrived
                  </button>
                  <button
                    aria-pressed={player.no_show}
                    className={`flex items-center justify-center gap-1.5 border px-1 py-1 font-bold disabled:opacity-40 ${
                      player.no_show
                        ? "border-[#c0262d] bg-[#fff1ee] text-[#c0262d]"
                        : "border-[#d7d7dc] bg-white text-[#4e5560] hover:border-[#9aa0a6]"
                    }`}
                    disabled={busy}
                    onClick={() =>
                      void controller.patchPlayer(
                        booking.id,
                        player.id,
                        player.no_show ? { no_show: false } : { no_show: true, arrived: false },
                      )
                    }
                    title={player.no_show ? "Clear the no show" : "Mark this player as a no show"}
                    type="button"
                  >
                    <Glyph className="h-3.5 w-3.5" name="ban" />
                    No show
                  </button>
                  <div className="relative" data-player-menu>
                    <button
                      aria-expanded={menuFor === `${player.id}:status`}
                      aria-haspopup="menu"
                      aria-label="More check-in actions"
                      className={`flex h-full items-center border px-1.5 disabled:opacity-40 ${
                        menuFor === `${player.id}:status` ? "border-[#4533ff] bg-[#f3f2ff]" : "border-[#d7d7dc] bg-white"
                      }`}
                      disabled={busy}
                      onClick={() =>
                        setMenuFor(menuFor === `${player.id}:status` ? null : `${player.id}:status`)
                      }
                      type="button"
                    >
                      <Glyph className="h-3.5 w-3.5" name="dots" />
                    </button>
                    {menuFor === `${player.id}:status` ? (
                      <div
                        className="absolute right-0 top-full z-20 mt-1 min-w-[150px] border border-[#c7c7cc] bg-white py-1 text-[12px] shadow-lg"
                        role="menu"
                      >
                        <button
                          className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-[#f2f2f5] disabled:opacity-40"
                          disabled={!player.arrived && !player.no_show}
                          onClick={() => {
                            setMenuFor(null);
                            void controller.patchPlayer(booking.id, player.id, { arrived: false, no_show: false });
                          }}
                          role="menuitem"
                          type="button"
                        >
                          <Glyph className="h-4 w-4" name="refund" />
                          Clear check-in
                        </button>
                      </div>
                    ) : null}
                  </div>
                </div>

                {/* 그린피 한 줄 — 이 사람 몫만(0055). 그룹·패밀리 예약이라도 한 명씩 고친다. 요금표와 다른 금액은
                    사유 + 매니저 PIN 이 있어야 저장되고, Reports 의 Price review 에 남는다. 결제한 뒤에는 잠근다.
                    레퍼런스처럼 글자로 보이지만 실제로는 입력칸이다. */}
                <div
                  className={`mt-1.5 flex items-center gap-1 border px-1.5 py-1.5 ${
                    player.priceOverride ? "border-[#e0b44c] bg-[#fff8e6]" : "border-[#d7d7dc]"
                  }`}
                >
                  <Glyph className="h-3.5 w-3.5 text-[#4e5560]" name="golf" />
                  <span className="truncate">{booking.holes} Hole Green Fee</span>
                  {player.priceOverride ? (
                    <span
                      className="shrink-0 bg-[#e0b44c] px-1 text-[9px] font-bold uppercase tracking-wide text-white"
                      title={`Rate plan $${player.priceOverride.standard.toFixed(2)} · ${player.priceOverride.reason}${
                        player.priceOverride.manager ? ` · approved by ${player.priceOverride.manager}` : ""
                      }`}
                    >
                      Adjusted
                    </span>
                  ) : null}
                  <span aria-hidden className="ml-auto text-[#9aa0a6]">
                    $
                  </span>
                  <input
                    aria-label={`Green fee for ${player.name}`}
                    className="w-12 bg-transparent text-right tabular-nums outline-none focus:text-[#4533ff] disabled:text-[#1f2328]"
                    disabled={player.paid || player.cancelled}
                    inputMode="decimal"
                    onBlur={(event) => commitGreenFee(player.id, event.currentTarget.value)}
                    onChange={(event) => setGreenDrafts((prev) => ({ ...prev, [player.id]: event.target.value }))}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") event.currentTarget.blur();
                    }}
                    title="Green fee for this player only. A price that is not the rate plan needs a reason and a manager PIN, and shows on the report."
                    value={
                      greenDrafts[player.id] ??
                      (priceAsk?.playerId === player.id ? priceAsk.fee : greenFeeOf(booking, player)).toFixed(2)
                    }
                  />
                  <LineMark paid={player.paid} selected={selected} />
                </div>
                {greenDrafts[player.id] !== undefined && !Number.isFinite(Number(greenDrafts[player.id])) ? (
                  <span className="mt-1 block text-[10px] text-[#8a3f26]">Not a number — will not be saved</span>
                ) : null}
                {player.priceOverride && priceAsk?.playerId !== player.id ? (
                  <div className="mt-0.5 flex items-center gap-1 text-[10px] text-[#8a5a00]">
                    <span className="min-w-0 truncate">
                      Rate plan ${player.priceOverride.standard.toFixed(2)} · {player.priceOverride.reason}
                      {player.priceOverride.manager ? ` · ${player.priceOverride.manager}` : ""}
                    </span>
                    {player.paid || player.cancelled ? null : (
                      <button
                        className="ml-auto shrink-0 font-semibold text-[#4533ff] hover:underline disabled:opacity-40"
                        disabled={busy}
                        onClick={() => void controller.setPlayerGreenFee(booking.id, player.id, null, "")}
                        title="Go back to the rate plan price"
                        type="button"
                      >
                        Reset
                      </button>
                    )}
                  </div>
                ) : null}
                {priceAsk?.playerId === player.id ? (
                  <form
                    className="mt-1 grid gap-1 border border-[#e0b44c] bg-[#fff8e6] p-1.5 text-[11px]"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void savePriceAsk();
                    }}
                  >
                    <span className="text-[#8a5a00]">
                      ${priceAsk.fee.toFixed(2)} is not the rate plan price. Why? (shows on the report)
                    </span>
                    <input
                      autoFocus
                      className="w-full border-b border-[#d7d7dc] bg-white px-1 py-1 outline-none focus:border-[#4533ff]"
                      maxLength={200}
                      onChange={(event) => setPriceAsk({ ...priceAsk, reason: event.target.value })}
                      placeholder="Reason, e.g. family discount"
                      value={priceAsk.reason}
                    />
                    <div className="flex justify-end gap-1">
                      <button
                        className="px-2 py-1 text-[#4e5560] hover:bg-[#f2f2f5]"
                        onClick={() => setPriceAsk(null)}
                        type="button"
                      >
                        Cancel
                      </button>
                      <button
                        className="bg-[#4533ff] px-2 py-1 font-semibold text-white disabled:opacity-40"
                        disabled={busy || !priceAsk.reason.trim()}
                        type="submit"
                      >
                        Save · manager PIN
                      </button>
                    </div>
                  </form>
                ) : null}
                {/* 카트 한 줄. 켜면 서버가 금액을 채운다(`cart_fee_for`) — 세전 18홀 $19.47(Senior $17.70) · 9홀 $11.50 이고,
                    카트가 포함된 회원 요금제만 $0 이다. 그린피와 달리 이 사람 것만 바뀐다.
                    결제한 뒤에는 잠근다: 받은 돈과 재인쇄 영수증이 달라지면 안 된다. */}
                {/* 카트 한 줄 — 레퍼런스처럼 **켜져 있을 때만** 보인다. 켜는 것은 아래 + (Add Products 의 Carts).
                    서버가 금액을 채운다(`cart_fee_for`) — 세전 18홀 $19.47(Senior $17.70) · 9홀 $11.50 이고, 카트가 포함된
                    회원 요금제만 $0 이다. 그린피와 달리 이 사람 것만 바뀐다. 결제한 뒤에는 잠근다. */}
                {cartOn ? (
                  <div className="group/row mt-1 flex items-center gap-1 border border-[#d7d7dc] px-1.5 py-1.5">
                    <Glyph className="h-3.5 w-3.5 text-[#4e5560]" name="cart" />
                    <span className="min-w-0 truncate">Half Cart ({booking.holes} Holes)</span>
                    <span aria-hidden className="ml-auto text-[#9aa0a6]">
                      $
                    </span>
                    <input
                      aria-label={`Cart fee for ${player.name}`}
                      className="w-12 bg-transparent text-right tabular-nums outline-none focus:text-[#4533ff] disabled:text-[#1f2328]"
                      disabled={player.paid}
                      inputMode="decimal"
                      onBlur={(event) => commitFee(player.id, event.currentTarget.value)}
                      onChange={(event) => setFeeDrafts((prev) => ({ ...prev, [player.id]: event.target.value }))}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") event.currentTarget.blur();
                      }}
                      title="Cart fee for this player only — filled in from the rate plan and holes. Changing it needs a manager PIN."
                      value={feeDrafts[player.id] ?? cartPart(player).toFixed(2)}
                    />
                    {player.paid || player.cancelled ? null : (
                      <button
                        aria-label="Remove the cart"
                        className="hidden px-0.5 group-hover/row:block group-focus-within/row:block text-[14px] leading-none text-[#9aa0a6] hover:text-[#c0262d] disabled:opacity-40"
                        disabled={busy}
                        onClick={() => void controller.patchPlayer(booking.id, player.id, { cart: false })}
                        title="Take the half cart off this player"
                        type="button"
                      >
                        <span aria-hidden>&times;</span>
                      </button>
                    )}
                    <LineMark paid={player.paid} selected={selected} />
                  </div>
                ) : null}

                {/* 추가 품목 줄(0026). 결제 전에는 × 로 뗀다. */}
                {(player.extras ?? []).map((extra, index) => (
                  <div
                    className="mt-1 flex items-center gap-1 border border-[#d7d7dc] px-1.5 py-1"
                    key={`${extra.code}-${index}`}
                  >
                    <Glyph className="h-3.5 w-3.5 text-[#4e5560]" name="basket" />
                    <span className="min-w-0 truncate">{extra.name}</span>
                    <span className="ml-auto tabular-nums">{money(extra.price)}</span>
                    {player.paid || player.cancelled ? null : (
                      <button
                        aria-label={`Remove ${extra.name}`}
                        className="px-0.5 text-[14px] leading-none text-[#9aa0a6] hover:text-[#c0262d] disabled:opacity-40"
                        disabled={busy}
                        onClick={() => removeExtra(player, index)}
                        title={`Remove ${extra.name}`}
                        type="button"
                      >
                        <span aria-hidden>&times;</span>
                      </button>
                    )}
                    <LineMark paid={player.paid} selected={selected} />
                  </div>
                ))}

                {/* 레퍼런스의 줄 아래 + — 이 선수의 Add Products 를 카드 안 드롭다운으로 연다. 카드 옆에 패널을
                    따로 펼치지 않는다. 카드 줄은 가로 스크롤 상자 안이라 띄우지 않고 + 바로 아래에 끼워 넣는다. */}
                <div className="mt-1 flex flex-col" data-products-menu>
                  <button
                    aria-expanded={productsOpen && productTarget?.id === player.id}
                    className={`border py-1 text-[15px] leading-none disabled:opacity-40 ${
                      productsOpen && productTarget?.id === player.id
                        ? "border-[#4533ff] bg-[#f3f2ff] text-[#4533ff]"
                        : "border-[#d7d7dc] bg-[#f2f2f4] text-[#4e5560] hover:bg-[#e8e8ec]"
                    }`}
                    disabled={busy || player.cancelled || player.paid}
                    onClick={() =>
                      productsOpen && productTarget?.id === player.id ? setProductsOpen(false) : openProducts(player.id)
                    }
                    title={
                      player.paid
                        ? "Paid — mark unpaid to add more"
                        : cartOn
                          ? "Add extras (pull cart, range basket) for this player"
                          : "Add a half cart or extras (pull cart, range basket) for this player"
                    }
                    type="button"
                  >
                    +
                  </button>
                  {productsOpen && productTarget?.id === player.id ? (
                    <ProductsMenu
                      busy={busy}
                      catalog={catalog}
                      holes={booking.holes}
                      onAddExtra={(item) => addExtra(player, item)}
                      onToggleCart={() => void controller.patchPlayer(booking.id, player.id, { cart: !cartOn })}
                      player={player}
                    />
                  ) : null}
                </div>

                {player.cancelled ? (
                  <div className="mt-1 flex justify-between text-[#8a3f26]">
                    <span>Cancelled</span>
                    <span>−{money(greenFeeOf(booking, player) + addOnsOf(player))}</span>
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

                {/* 레퍼런스의 Select — 담기 전에는 흰 바탕에 빈 동그라미, 담기면 보라색으로 채운다. 담긴 것을
                    다시 누르면 그 계산서를 이 계산대의 "지금 계산서" 로 불러와 Take Payment 를 펼친다(다른 탭·
                    계산대에서 담았거나 계산서를 잠시 놓아 두면 패널이 비어 받을 길이 없었다). 결제된 선수는
                    영수증을 다시 연다. */}
                <button
                  className={`mt-1.5 flex items-center justify-center gap-1.5 border px-1 py-1.5 font-bold disabled:opacity-40 ${
                    player.paid
                      ? "border-[#168a3c] bg-white text-[#168a3c] hover:bg-[#e8f6ec]"
                      : selected || !useBills
                        ? "border-[#4533ff] bg-[#4533ff] text-white hover:bg-[#3a2ae0]"
                        : "border-[#c7c7cc] bg-[#f7f7f9] text-[#1f2328] hover:border-[#4533ff]"
                  }`}
                  disabled={busy || player.cancelled || (useBills && !player.paid && billState.busy)}
                  onClick={() => {
                    if (player.paid || !useBills) return openReceipt([player], player.paid);
                    if (onBill) {
                      if (billState.bill?.id !== onBill.id) void billActions.select(onBill.id);
                      setPayStep("summary");
                      setPayOpen(true);
                      return;
                    }
                    void addToBill([player]);
                  }}
                  title={
                    player.paid
                      ? "Paid — show the receipt to print again"
                      : useBills
                        ? onBill
                          ? `On bill #${onBill.id} — open it to take payment`
                          : "Put this player's round on the current bill"
                        : "Show the receipt, then take payment"
                  }
                  type="button"
                >
                  {player.paid ? (
                    <Glyph className="h-4 w-4" name="card" />
                  ) : selected ? (
                    <Glyph className="h-4 w-4" name="check" />
                  ) : (
                    <span aria-hidden className="h-3.5 w-3.5 rounded-full border-[1.5px] border-current" />
                  )}
                  {player.paid ? "Receipt" : useBills ? "Select" : "Payment"}
                </button>
                {useRainCheck && player.paid && !player.cancelled
                  ? (() => {
                      const check = activeRainCheck(rainChecks.checks, player.id);
                      // 새로 내주는 것은 ⋮ → Raincheck. 여기는 이미 내준 레인체크의 상태만 보여 준다.
                      if (!check) return null;
                      return (
                        <button
                          className="mt-1 border border-[#2f6f8f] bg-[#eef6fa] px-1 py-1 font-bold text-[#2f6f8f] disabled:opacity-40"
                          disabled={busy}
                          onClick={() => setRainCheckFor([player])}
                          title={`Rain check ${check.code} — reprint or void`}
                          type="button"
                        >
                          {`Rain check ${formatMoney(check.amount)}${
                            check.status === "redeemed" ? " · used" : check.expired ? " · expired" : ""
                          }`}
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

        {/* ===== 놓을 곳 — 카드를 끄는 동안만 카드 위 아래쪽에 뜬다 ===== */}
        {draggedPlayer ? (
          <div className="pointer-events-none absolute inset-x-2 bottom-2 z-30 grid grid-cols-3 gap-2">
            {(
              [
                { action: "raincheck", label: "Rain check", glyph: "umbrella", tone: "#2f6f8f", bg: "#eef6fa" },
                { action: "refund", label: "Refund", glyph: "refund", tone: "#b26a00", bg: "#fff4e0" },
                { action: "delete", label: "Delete", glyph: "trash", tone: "#c0262d", bg: "#fff1ee" },
              ] as const
            ).map((zone) => {
              const block = dropBlock(zone.action, draggedPlayer);
              const over = dropOver === zone.action && !block;
              return (
                <div
                  className={`pointer-events-auto flex flex-col items-center justify-center gap-0.5 border-2 border-dashed px-2 py-3 text-center shadow-lg transition-colors ${
                    block ? "border-[#c7c7cc] bg-[#f2f2f4] text-[#9aa0a6]" : ""
                  }`}
                  key={zone.action}
                  onDragLeave={() => setDropOver((current) => (current === zone.action ? null : current))}
                  onDragOver={(event) => {
                    if (block) return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                    if (dropOver !== zone.action) setDropOver(zone.action);
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    setDragging(null);
                    setDropOver(null);
                    runDrop(zone.action, draggedPlayer);
                  }}
                  style={
                    block
                      ? undefined
                      : {
                          borderColor: zone.tone,
                          color: over ? "#fff" : zone.tone,
                          background: over ? zone.tone : zone.bg,
                        }
                  }
                >
                  {/* 안쪽 요소가 drag 이벤트를 받으면 dragleave 가 번갈아 터져 색이 깜박인다. */}
                  <Glyph className="pointer-events-none h-5 w-5" name={zone.glyph} />
                  <span className="pointer-events-none text-[13px] font-bold">{zone.label}</span>
                  <span className="pointer-events-none text-[10px] opacity-80">{block ?? "Manager PIN · reason"}</span>
                </div>
              );
            })}
          </div>
        ) : null}
        </div>
        )}
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

      {refundSale ? (
        <SaleDetail
          onClose={() => setRefundSale(null)}
          onRefunded={(updated) => {
            setRefundSale(null);
            controller.pushToast("success", `Refunded ${updated.receipt_no}.`);
            void controller.refresh();
          }}
          sale={refundSale}
        />
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
 * 실제로 무언가 하는 것은 결제 · 히스토리 · 복제 · 삭제뿐이다. 나머지 글리프는
 * 레퍼런스의 자리를 지키는 **표시**이고 버튼이 아니다(`<span>`). 눌러도 아무 일이
 * 없는 과녁을 일곱 개 만들어 두면 사용자는 앱이 고장 났다고 생각한다 — 사이드바의
 * Golf 드롭다운, 상단바 글리프와 같은 판단이다.
 */
function IconRail({
  playerCount,
  historyOpen,
  onToggleHistory,
  canPay,
  payOpen,
  onTogglePay,
  cloneOpen,
  onToggleClone,
  productsOpen,
  onToggleProducts,
  onDelete,
}: {
  playerCount: number;
  historyOpen: boolean;
  onToggleHistory: () => void;
  canPay: boolean;
  payOpen: boolean;
  onTogglePay: () => void;
  cloneOpen: boolean;
  onToggleClone: () => void;
  productsOpen: boolean;
  onToggleProducts: () => void;
  onDelete: () => void;
}) {
  const cell = "flex h-7 w-9 items-center justify-center";
  return (
    <div className="flex shrink-0 flex-col items-center gap-0.5 border-r border-[#c7c7cc] bg-[#d5d5da] py-2">
      <span className={`${cell} text-[#4e5560]`} title={`${playerCount} player(s)`}>
        <Glyph name="people" />
      </span>
      {canPay ? (
        <button
          aria-pressed={payOpen}
          className={`${cell} ${payOpen ? "bg-white text-[#1f2328]" : "text-[#4e5560] hover:bg-white/60"}`}
          onClick={onTogglePay}
          title="Take Payment"
          type="button"
        >
          <Glyph className="h-4 w-4" name="dollar" />
        </button>
      ) : null}
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
      <button
        aria-pressed={productsOpen}
        className={`${cell} ${productsOpen ? "bg-white text-[#1f2328]" : "text-[#4e5560] hover:bg-white/60"}`}
        data-products-menu
        onClick={onToggleProducts}
        title="Add Products"
        type="button"
      >
        <Glyph className="h-4 w-4" name="basket" />
      </button>
      <span aria-hidden className={`${cell} text-[13px] text-[#9297a1]`}>
        ?
      </span>
      <button
        aria-pressed={cloneOpen}
        className={`${cell} ${cloneOpen ? "bg-white text-[#4533ff]" : "text-[#4e5560] hover:bg-white/60"}`}
        onClick={onToggleClone}
        title="Clone Reservation"
        type="button"
      >
        <Glyph name="copy" />
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

/**
 * Clone Reservation — 레퍼런스(Lightspeed)의 복제 화면. 이 예약을 같은 날 **다음 빈 티 타임 N개**에
 * 그대로 복사한다. 단체를 한 번에 잡을 때 쓴다. 대상 시각은 부모가 계산해서 넘긴다.
 */
function ClonePanel({
  targets,
  count,
  groupSize,
  otherDay,
  busy,
  onChangeCount,
  onClone,
  onCancel,
}: {
  targets: string[];
  count: number;
  groupSize: number;
  otherDay: boolean;
  busy: boolean;
  onChangeCount: (count: number) => void;
  onClone: () => void;
  onCancel: () => void;
}) {
  const none = targets.length === 0;
  return (
    <div className="flex min-w-0 flex-1 flex-wrap items-start gap-x-10 gap-y-4 bg-white px-8 py-6">
      <div className="min-w-[260px] max-w-[420px]">
        <Glyph className="h-12 w-12 text-[#1f2328]" name="copy" />
        <h3 className="mt-3 text-2xl font-bold text-[#1f2328]">Clone Reservation</h3>
        <p className="mt-2 text-sm text-[#4e5560]">
          Copy this reservation across the next available tee times. This is useful for quickly reserving for a
          group.
        </p>
        <div className="mt-5 flex gap-2">
          <button className="border border-[#c7c7cc] bg-white px-5 py-2 font-bold" onClick={onCancel} type="button">
            Cancel
          </button>
          <button
            className="bg-[#4533ff] px-6 py-2 font-bold text-white disabled:opacity-40"
            disabled={busy || none}
            onClick={onClone}
            type="button"
          >
            {busy ? "Cloning…" : `Clone Reservation (${count})`}
          </button>
        </div>
      </div>
      <div className="min-w-[240px] flex-1">
        <p className="text-sm text-[#1f2328]">Clone this reservation over the next</p>
        {none ? (
          <p className="mt-2 text-[#8a3f26]">
            {otherDay
              ? "Open this reservation's day on the tee sheet to see its tee times."
              : `No later tee time today has room for ${groupSize} player${groupSize === 1 ? "" : "s"}.`}
          </p>
        ) : (
          <>
            <select
              aria-label="Number of tee times to clone into"
              className="mt-2 w-full border border-[#c7c7cc] bg-white px-2 py-2 text-sm"
              disabled={busy}
              onChange={(event) => onChangeCount(Number(event.target.value))}
              value={count}
            >
              {targets.map((_, index) => (
                <option key={index + 1} value={index + 1}>
                  {index === 0 ? "available tee time" : `${index + 1} available tee times`}
                </option>
              ))}
            </select>
            <p className="mt-2 text-[#4e5560]">{targets.slice(0, count).join(" · ")}</p>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Add Products — 카드의 + 아래에 펼치는 드롭다운 목록. 카드 옆에 패널을 따로 펼치지 않는다.
 *   Carts  : 이 선수의 Half Cart 를 켜고 끈다(카드의 카트 줄과 같은 값 — 요금은 서버가 채운다).
 *   Extras : 0026 카탈로그. 누를 때마다 그 선수 몫에 한 줄 붙는다(같은 것을 두 번 붙일 수 있다).
 */
function ProductsMenu({
  player,
  holes,
  catalog,
  busy,
  onToggleCart,
  onAddExtra,
}: {
  player: Player;
  holes: number;
  catalog: TeeExtraItem[] | "error" | null;
  busy: boolean;
  onToggleCart: () => void;
  onAddExtra: (item: TeeExtraItem) => void;
}) {
  const row =
    "flex w-full items-center gap-2 px-2 py-1.5 text-left hover:bg-[#f2f2f5] disabled:cursor-not-allowed disabled:opacity-40";
  const heading = "px-2 pb-0.5 pt-1.5 text-[10px] font-bold uppercase tracking-wide text-[#9aa0a6]";
  const cartOn = player.cart === true;
  const locked = player.paid || player.cancelled;
  return (
    <div className="border border-t-0 border-[#c7c7cc] bg-white py-1 text-[12px] shadow-md" role="menu">
      {locked ? (
        <p className="px-2 py-1 text-[#8a3f26]">{player.paid ? "Paid — mark unpaid to change" : "Cancelled"}</p>
      ) : null}
      <p className={heading}>Carts</p>
      <button
        aria-checked={cartOn}
        className={row}
        disabled={busy || locked}
        onClick={onToggleCart}
        role="menuitemcheckbox"
        title={cartOn ? "Take the half cart off this player" : "Add a half cart — the fee comes from the rate plan"}
        type="button"
      >
        <Glyph className="h-3.5 w-3.5 text-[#4e5560]" name="cart" />
        <span className="min-w-0 truncate">Half Cart ({holes} Holes)</span>
        <span className={`ml-auto shrink-0 ${cartOn ? "text-[#4533ff]" : "text-[#9aa0a6]"}`}>
          {cartOn ? "✓ Added" : "Add"}
        </span>
      </button>

      <p className={heading}>Extras</p>
      {catalog === null ? (
        <p className="px-2 py-1 text-[#9aa0a6]">Loading…</p>
      ) : catalog === "error" ? (
        <p className="px-2 py-1 text-[#8a3f26]">Could not load extras. Close and open again to retry.</p>
      ) : catalog.length === 0 ? (
        <p className="px-2 py-1 text-[#9aa0a6]">No extras are turned on.</p>
      ) : (
        catalog.map((item) => (
          <button
            className={row}
            disabled={busy || locked}
            key={item.code}
            onClick={() => onAddExtra(item)}
            role="menuitem"
            title={`Add ${item.name} for this player`}
            type="button"
          >
            <Glyph className="h-3.5 w-3.5 text-[#4e5560]" name="basket" />
            <span className="min-w-0 truncate">{item.name}</span>
            <span className="ml-auto shrink-0 tabular-nums">{money(Number(item.price))}</span>
          </button>
        ))
      )}
    </div>
  );
}

/**
 * Take Payment 첫 화면 — 레퍼런스(Chronogolf)의 왼쪽 결제 패널. Paid By · Payment Method · Items ·
 * Subtotal Due 를 보여 주고, Take Payment 를 누르면 실제 결제(BillPanel)로 넘어간다. 고른 수단이 그쪽의
 * 첫 결제 수단이 된다(카드 = 단말기, 금전함 = 현금).
 *
 * 품목은 계산서 줄에서 온다. 이 예약의 그린피 줄은 "그린피 · 카트 · 추가 품목" 으로 나눠 보여 주는데,
 * 나눈 합이 그 줄의 금액과 다르면(담은 뒤 카트를 바꾼 경우) 나누지 않고 서버의 줄 그대로 보인다 —
 * 화면의 숫자가 받을 돈과 어긋나면 안 된다.
 */
function TakePaymentSummary({
  bill,
  booking,
  busy,
  method,
  onMethod,
  onPaidBy,
  onTakePayment,
}: {
  bill: Bill;
  booking: TeeBooking;
  busy: boolean;
  method: "card" | "cash";
  onMethod: (method: "card" | "cash") => void;
  onPaidBy: (name: string) => void;
  onTakePayment: () => void;
}) {
  const cents = (dollars: number) => Math.round(dollars * 100);
  const items: { name: string; amount: number }[] = [];
  const payers: string[] = [];
  for (const line of bill.lines) {
    const player =
      line.kind === "tee_player" && line.booking_id === booking.id
        ? booking.players.find((item) => item.id === line.player_id)
        : undefined;
    if (player) {
      const name = player.name.trim() || [player.firstName, player.lastName].join(" ").trim();
      if (name && !payers.includes(name)) payers.push(name);
      const parts = [
        { name: `${booking.holes} Hole Green Fee`, amount: cents(greenFeeOf(booking, player)) },
        ...(player.cart ? [{ name: `Half Cart (${booking.holes} Holes)`, amount: cents(player.cartFee ?? 0) }] : []),
        ...(player.extras ?? []).map((extra) => ({ name: extra.name, amount: cents(extra.price) })),
      ];
      const sum = parts.reduce((total, part) => total + part.amount, 0);
      if (line.discount === 0 && sum === line.line_total) {
        items.push(...parts);
        continue;
      }
    }
    items.push({ name: line.quantity > 1 ? `${line.name} ×${line.quantity}` : line.name, amount: line.line_total });
  }
  // 같은 품목은 한 줄로(레퍼런스처럼 사람 수만큼 반복하지 않는다).
  const grouped: { name: string; amount: number; count: number }[] = [];
  for (const item of items) {
    const match = grouped.find((row) => row.name === item.name && row.amount === item.amount * row.count);
    if (match) {
      match.amount += item.amount;
      match.count += 1;
    } else {
      grouped.push({ ...item, count: 1 });
    }
  }
  const paidBy = bill.label?.trim() || payers[0] || "";
  const options = paidBy && !payers.includes(paidBy) ? [paidBy, ...payers] : payers;
  const due = bill.subtotal - bill.discount;
  const tile = "flex h-14 items-center justify-center border bg-white disabled:opacity-40";

  return (
    <div className="flex h-full flex-col px-4 py-4 text-[13px]">
      <span className="mx-auto flex h-9 w-9 items-center justify-center rounded-full bg-[#1f2328] text-white">
        <Glyph className="h-6 w-6" name="dollar" />
      </span>

      <p className="mt-4 font-bold">Paid By</p>
      <select
        aria-label="Paid by"
        className="mt-1.5 w-full border border-[#c7c7cc] bg-white px-2.5 py-2 font-bold outline-none focus:border-[#4533ff]"
        disabled={busy || options.length === 0}
        onChange={(event) => onPaidBy(event.target.value)}
        value={paidBy}
      >
        {options.length === 0 ? <option value="">—</option> : null}
        {options.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>

      <p className="mt-4 font-bold">Payment Method</p>
      <div className="mt-1.5 grid grid-cols-2 gap-2">
        <button
          aria-label="Card"
          aria-pressed={method === "card"}
          className={`${tile} ${method === "card" ? "border-2 border-[#4533ff]" : "border-[#c7c7cc] hover:border-[#9aa0a6]"}`}
          disabled={busy}
          onClick={() => onMethod("card")}
          title="Card — the amount goes to the card reader"
          type="button"
        >
          <Glyph className="h-6 w-6" name="card" />
        </button>
        <button
          aria-label="Cash"
          aria-pressed={method === "cash"}
          className={`${tile} ${method === "cash" ? "border-2 border-[#4533ff]" : "border-[#c7c7cc] hover:border-[#9aa0a6]"}`}
          disabled={busy}
          onClick={() => onMethod("cash")}
          title="Cash — enter what the guest hands over and see the change"
          type="button"
        >
          <Glyph className="h-6 w-6" name="register" />
        </button>
      </div>

      <p className="mt-5 font-bold">Items</p>
      <ul className="mt-1 grid gap-0.5">
        {grouped.map((row) => (
          <li className="flex justify-between gap-2" key={`${row.name}-${row.amount}`}>
            <span className="min-w-0 truncate">
              {row.name}
              {row.count > 1 ? ` ×${row.count}` : ""}
            </span>
            <span className="tabular-nums">{formatMoney(row.amount)}</span>
          </li>
        ))}
        {bill.discount > 0 ? (
          <li className="flex justify-between gap-2 text-[#168a3c]">
            <span>Discount</span>
            <span className="tabular-nums">−{formatMoney(bill.discount)}</span>
          </li>
        ) : null}
      </ul>

      <div className="mt-auto pt-5">
        <div className="flex justify-between border-t border-[#ececf0] pt-3 text-[14px] font-bold">
          <span>Subtotal Due</span>
          <span className="tabular-nums">{formatMoney(due)}</span>
        </div>
        <p className="mt-0.5 text-right text-[11px] text-[#9aa0a6]">+ HST at checkout</p>
        <button
          className="mt-3 w-full bg-[#4533ff] py-2.5 font-bold text-white hover:bg-[#3a2ae0] disabled:cursor-not-allowed disabled:bg-[#b1a8ff]"
          disabled={busy}
          onClick={onTakePayment}
          type="button"
        >
          Take Payment
        </button>
      </div>
    </div>
  );
}

/** "10:07 AM" → "10:07", "1:15 PM" → "13:15". Lightspeed 의 줄 설명은 24시간제다. */
function clock24(label: string): string {
  const match = /^(\d{1,2}):(\d{2})\s*([AP]M)?$/i.exec(label.trim());
  if (!match) return label;
  let hour = Number(match[1]) % 12;
  if (match[3]?.toUpperCase() === "PM") hour += 12;
  if (!match[3]) hour = Number(match[1]);
  return `${String(hour).padStart(2, "0")}:${match[2]}`;
}

/**
 * Sales 화면의 그린피 줄 설명 — Lightspeed 처럼 두 줄:
 *   "18 Hole Green Fee - Public"
 *   "Mackey Michelle (#T1A2B3C4D5) - Tee Time: 2026-10-18 10:07"
 * 이 예약의 줄만 안다. 다른 예약·상품 줄은 null 이라 BillPanel 의 기본 설명을 쓴다.
 */
function describeTeeLine(line: BillLine, booking: TeeBooking): { title: string; detail?: string } | null {
  if (line.kind !== "tee_player" || line.booking_id !== booking.id) return null;
  const player = booking.players.find((item) => item.id === line.player_id);
  if (!player) return null;
  const plan = player.ratePlan?.trim() || "Public";
  const parts = [`${booking.holes} Hole Green Fee - ${plan}`];
  if (player.cart) parts.push(`Half Cart (${booking.holes} Holes)`);
  for (const extra of player.extras ?? []) parts.push(extra.name);
  const name =
    [player.lastName, player.firstName].map((part) => part?.trim()).filter(Boolean).join(" ") ||
    player.name.trim() ||
    player.type;
  const code = booking.confirmationCode ?? confirmationCode(booking.id);
  return {
    title: parts.join(" + "),
    detail: `${name} (#${code}) - Tee Time: ${booking.date} ${clock24(booking.time)}`,
  };
}
