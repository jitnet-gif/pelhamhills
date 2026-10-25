"use client";

/**
 * 계산대 첫 화면. Lightspeed R-Series 의 Register 화면을 그대로 옮겼다 — 직원들이 그 화면에
 * 손이 익어 있다(2026-10-12). 위 줄은 지금 손님(Continue Sale / Refund / New Sale), 아래 줄은
 * 이 계산대 자체(Close Register / Receipt Printer), 맨 아래는 오늘 이 계산대의 영수증.
 *
 * Lightspeed 의 Special Order · Layaway · Payout/Drop · Add Amount 는 아직 없다. 빈 타일을
 * 두면 눌러 보고 "고장" 이라고 판단하므로 그리지 않는다.
 *
 * 화면은 홈이지만 계산대(RegisterTab)는 뒤에 켜 둔 채다. 홈에서 바코드를 쏘면 곧장 판매로
 * 넘어가고, 영수증을 쏘면 여기 Refund 창이 그 영수증으로 열린다(`RetailWorkspace`).
 */

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import { ReceiptPrinterSetup } from "@/components/pos/ReceiptPrinterSetup";
import SaleDetail from "@/components/reports/SaleDetail";
import { REGISTER_GUIDE } from "@/lib/nav";
import { posApi, type Bill, type BillStation } from "@/lib/pos/api";
import { billActions, useCurrentBill } from "@/lib/pos/currentBill";
import retailApi, { localBusinessDate, toRetailError } from "@/lib/retail/api";
import { CLUB_TIME_ZONE, stationLabel } from "@/lib/retail/receipt";
import {
  readReceiptPrinterMode,
  subscribeReceiptPrinter,
} from "@/lib/retail/receiptPrinter";
import { formatMoney, type Sale } from "@/lib/retail/types";

import RegisterClose from "./RegisterClose";
import { EmptyNote, ErrorNote, Modal, SkeletonRows, TextInput } from "./ui";

type Props = {
  /** 화면에 보이는가. 다시 보일 때마다 최근 영수증을 새로 읽는다. */
  active: boolean;
  registerName: string;
  station: BillStation;
  demo: boolean;
  /** 판매 화면으로. */
  onOpenSale: () => void;
  /** 홈에서 영수증을 쐈다 → 그 번호로 Refund 창을 연다. 값이 바뀔 때마다 연다. */
  refundRequest: { code: string; at: number } | null;
};

type Dialog =
  | { kind: "refund"; code: string }
  | { kind: "continue" }
  | { kind: "close" }
  | { kind: "printer" }
  | { kind: "sale"; sale: Sale };

const RECENT_COUNT = 10;

export default function RegisterHome({
  active,
  registerName,
  station,
  demo,
  onOpenSale,
  refundRequest,
}: Props) {
  const { bill, openBills } = useCurrentBill();
  const printerMode = useSyncExternalStore(
    subscribeReceiptPrinter,
    readReceiptPrinterMode,
    () => "browser" as const,
  );
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [recent, setRecent] = useState<Sale[] | null>(null);
  const [recentError, setRecentError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  // 담당자별 마감(서랍 현금·팁 나누기)은 현금 리포트 계정만 연다(0046). 그 밖의 계정에는 버튼을 숨긴다.
  const [cashAccess, setCashAccess] = useState(false);
  const today = localBusinessDate();

  useEffect(() => {
    if (demo) return;
    let cancelled = false;
    retailApi
      .cashAccess()
      .then((allowed) => {
        if (!cancelled) setCashAccess(allowed);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [demo]);

  // 이어 갈 손님: 지금 계산서가 있으면 그것, 없으면 열린 계산서 목록.
  const continueCount = bill ? Math.max(openBills.length, 1) : openBills.length;

  useEffect(() => {
    if (!active || demo) return;
    let cancelled = false;
    retailApi
      .listSales(today)
      .then((list) => {
        if (cancelled) return;
        setRecentError("");
        setRecent(
          list
            .filter((sale) => sale.station === station)
            .sort((a, b) => b.created_at.localeCompare(a.created_at))
            .slice(0, RECENT_COUNT),
        );
      })
      .catch((cause) => {
        if (!cancelled) setRecentError(toRetailError(cause).message);
      });
    return () => {
      cancelled = true;
    };
  }, [active, demo, station, today, reloadKey]);

  // 새 요청이 오면 렌더 중에 창을 연다(effect 로 하면 홈에 돌아올 때마다 지난 요청으로 다시 열린다).
  const [seenRequest, setSeenRequest] = useState(refundRequest);
  if (refundRequest !== seenRequest) {
    setSeenRequest(refundRequest);
    if (refundRequest) setDialog({ kind: "refund", code: refundRequest.code });
  }

  const continueSale = useCallback(() => {
    if (bill) {
      onOpenSale();
      return;
    }
    if (openBills.length === 1) {
      void billActions.select(openBills[0].id).then(onOpenSale);
      return;
    }
    if (openBills.length > 1) setDialog({ kind: "continue" });
  }, [bill, onOpenSale, openBills]);

  const newSale = useCallback(() => {
    // 지금 계산서는 열린 채 목록에 남는다(Hold 와 같다). 첫 상품을 담는 순간 새 계산서가 생긴다.
    billActions.park();
    onOpenSale();
  }, [onOpenSale]);

  const refund = useCallback(() => setDialog({ kind: "refund", code: "" }), []);

  // Lightspeed 와 같은 단축키. 한글 입력기에서도 되도록 `code`(물리 키)로 본다.
  useEffect(() => {
    if (!active || dialog) return;
    const onKey = (event: KeyboardEvent) => {
      if (!event.altKey || event.ctrlKey || event.metaKey) return;
      const action =
        event.code === "KeyS"
          ? continueSale
          : event.code === "KeyR"
            ? refund
            : event.code === "KeyN"
              ? newSale
              : null;
      if (!action) return;
      event.preventDefault();
      action();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, dialog, continueSale, refund, newSale]);

  return (
    <div className="grid min-w-0 gap-6">
      <Section title="Current sale">
        <Tile
          disabled={continueCount === 0}
          hint={
            continueCount === 0
              ? "No open sale"
              : bill
                ? `Bill #${bill.id} · ${formatMoney(bill.total)}`
                : `${continueCount} open`
          }
          icon={<ContinueIcon />}
          label="Continue Sale"
          onClick={continueSale}
          shortcut="Alt+S"
        />
        <Tile
          disabled={demo}
          icon={<RefundIcon />}
          label="Refund"
          onClick={refund}
          shortcut="Alt+R"
        />
        <Tile
          icon={<PlusIcon />}
          label="New Sale"
          onClick={newSale}
          shortcut="Alt+N"
          tone="primary"
        />
      </Section>

      <Section
        note={`The register is where you do sales and refunds. You are using ${registerName} at Pelham Hills Golf Club.`}
        title={`Current register is ${registerName}`}
      >
        <Tile
          disabled={demo}
          icon={<PowerIcon />}
          label="Close Register"
          onClick={() => setDialog({ kind: "close" })}
        />
        <Tile
          hint={
            printerMode === "bluetooth"
              ? "Bluetooth"
              : printerMode === "network"
                ? "Network"
                : printerMode === "app"
                  ? "Epson app"
                  : "Print dialog"
          }
          icon={<PrinterIcon />}
          label="Receipt Printer"
          onClick={() => setDialog({ kind: "printer" })}
        />
      </Section>

      <section className="grid min-w-0 gap-2">
        <SectionTitle>Recent activity</SectionTitle>
        {demo ? (
          <EmptyNote>
            Demo data — connect to the server to see today&apos;s sales.
          </EmptyNote>
        ) : recentError ? (
          <ErrorNote>{recentError}</ErrorNote>
        ) : recent === null ? (
          <SkeletonRows count={3} />
        ) : recent.length === 0 ? (
          <EmptyNote>No sales on this register yet today.</EmptyNote>
        ) : (
          <ul className="grid min-w-0 border border-[#d4d4d8] bg-white">
            {recent.map((sale) => (
              <li
                className="border-b border-[#e4e4e8] last:border-b-0"
                key={sale.id}
              >
                <SaleRow
                  onClick={() => setDialog({ kind: "sale", sale })}
                  sale={sale}
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* 이 화면 사용법(나레이션 프레젠테이션). 새 탭으로 열어 계산대는 그대로 둔다. */}
      <a
        className="justify-self-start text-sm font-bold text-[#4533ff] underline"
        href={REGISTER_GUIDE}
        rel="noopener"
        target="_blank"
      >
        ▶ How this screen works (Korean / English)
      </a>

      {dialog?.kind === "refund" ? (
        <RefundLookup
          date={today}
          initialCode={dialog.code}
          onClose={() => setDialog(null)}
          onPick={(sale) => setDialog({ kind: "sale", sale })}
        />
      ) : null}

      {dialog?.kind === "sale" ? (
        <SaleDetail
          onClose={() => setDialog(null)}
          onRefunded={(updated) => {
            setDialog({ kind: "sale", sale: updated });
            setReloadKey((key) => key + 1);
          }}
          sale={dialog.sale}
        />
      ) : null}

      {dialog?.kind === "continue" ? (
        <Modal onClose={() => setDialog(null)} title="Continue sale">
          <ul className="grid gap-1.5">
            {openBills.map((item) => (
              <li key={item.id}>
                <OpenBillButton
                  bill={item}
                  onClick={() => {
                    setDialog(null);
                    void billActions.select(item.id).then(onOpenSale);
                  }}
                />
              </li>
            ))}
          </ul>
        </Modal>
      ) : null}

      {dialog?.kind === "close" ? (
        <Modal
          onClose={() => setDialog(null)}
          title={`Close register · ${today}`}
          wide
        >
          <RegisterClose
            date={today}
            onCancel={() => setDialog(null)}
            blindCash={!cashAccess}
            registerName={registerName}
            station={station}
          />
        </Modal>
      ) : null}

      {dialog?.kind === "printer" ? (
        <Modal onClose={() => setDialog(null)} title="Receipt printer">
          <ReceiptPrinterSetup />
        </Modal>
      ) : null}
    </div>
  );
}

// ===== Refund: 영수증 찾기 ==============================================

/**
 * 영수증을 쏘거나 번호를 치면 찾고, 아니면 그 날 영수증 목록에서 고른다(기본은 오늘).
 * 지난 날 목록은 매니저와 admin@·proshop@·analysis@ 만 고른다(0096). 다른 계정은 오늘 목록만 보고,
 * 지난 영수증은 종이 영수증을 쏘거나 번호를 쳐서 연다.
 */
function RefundLookup({
  date,
  initialCode,
  onClose,
  onPick,
}: {
  date: string;
  initialCode: string;
  onClose: () => void;
  onPick: (sale: Sale) => void;
}) {
  const [query, setQuery] = useState(initialCode);
  const [day, setDay] = useState(date);
  const [pastAccess, setPastAccess] = useState(false);
  const [sales, setSales] = useState<Sale[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const needle = query.trim().toLowerCase();
  const shown = useMemo(
    () =>
      (sales ?? []).filter(
        (sale) =>
          !needle ||
          sale.receipt_no.toLowerCase().includes(needle) ||
          isShortHit(sale, needle) ||
          (sale.cashier ?? "").toLowerCase().includes(needle) ||
          formatMoney(sale.total).includes(needle),
      ),
    [needle, sales],
  );

  /**
   * 고른 날 목록에서 먼저 찾는다 — 영수증 번호 전체, 끝 번호(77 → …-0077), 카드 뒷 4자리.
   * 하나면 바로 열고, 여럿이면 목록을 그것만 남겨 고르게 한다.
   * 목록에 없는 영수증 번호(다른 날 것)는 서버에서 번호로 찾는다.
   */
  const lookUp = useCallback(
    async (code: string, list: Sale[] | null = sales) => {
      const wanted = code.trim();
      if (!wanted) return;
      const full = fullReceiptNo(wanted);
      const hits = (list ?? []).filter(
        (sale) =>
          sale.receipt_no.toUpperCase() === full || isShortHit(sale, wanted),
      );
      if (hits.length === 1) {
        onPick(hits[0]);
        return;
      }
      setError("");
      if (hits.length > 1) return;
      if (SHORT_NUMBER.test(wanted)) {
        setError(
          `Nothing ${day === date ? "today" : `on ${day}`} with receipt #${wanted} or a card ending ${wanted}. ${pastAccess ? "Pick the day of the sale above." : "Type the full receipt number from the paper receipt."}`,
        );
        return;
      }
      setBusy(true);
      try {
        const found = await posApi.byReceipt(full);
        onPick(await retailApi.getSale(found.id));
      } catch {
        setError(
          `No receipt "${wanted}". Check the number on the paper receipt, or type the card's last 4 digits.`,
        );
      } finally {
        setBusy(false);
      }
    },
    [date, day, onPick, pastAccess, sales],
  );

  // 창이 열릴 때와 날짜를 바꿀 때 읽는다. 홈에서 영수증을 쏘고 열렸으면 첫 목록이 오는 대로 그 영수증으로 간다.
  const firstLookUp = useRef({ code: initialCode, lookUp });
  useEffect(() => {
    let cancelled = false;
    retailApi
      .listSales(day)
      .then((list) => {
        if (cancelled) return;
        const sorted = [...list].sort((a, b) =>
          b.created_at.localeCompare(a.created_at),
        );
        setSales(sorted);
        const { code, lookUp: find } = firstLookUp.current;
        firstLookUp.current.code = "";
        if (code) void find(code, sorted);
      })
      .catch((cause) => {
        if (!cancelled) setError(toRetailError(cause).message);
      });
    return () => {
      cancelled = true;
    };
  }, [day]);

  useEffect(() => {
    let cancelled = false;
    retailApi
      .pastSalesAccess()
      .then((allowed) => {
        if (!cancelled) setPastAccess(allowed);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const isToday = day === date;

  return (
    <Modal onClose={onClose} title="Refund — find the receipt">
      <div className="grid gap-3">
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void lookUp(query);
          }}
        >
          <div className="min-w-0 flex-1">
            <TextInput
              aria-label="Receipt number or card last 4"
              autoFocus
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Scan, receipt # (77), or card last 4"
              type="search"
              value={query}
            />
          </div>
          <button
            className="min-h-11 shrink-0 bg-[#4533ff] px-4 text-sm font-bold text-white hover:bg-[#3a2ae0] disabled:opacity-50"
            disabled={busy || !query.trim()}
            type="submit"
          >
            {busy ? "Finding…" : "Find"}
          </button>
        </form>

        {error ? <ErrorNote>{error}</ErrorNote> : null}

        <div className="grid gap-1.5">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[11px] font-bold tracking-wide text-[#6b7280] uppercase">
              {isToday ? "Today" : day} · all registers
            </p>
            {pastAccess ? (
              <div className="w-40 shrink-0">
                <TextInput
                  aria-label="Sale date"
                  max={date}
                  onChange={(event) => {
                    const next = event.target.value;
                    if (!next || next === day) return;
                    setSales(null);
                    setError("");
                    setDay(next);
                  }}
                  type="date"
                  value={day}
                />
              </div>
            ) : null}
          </div>
          {sales === null && !error ? (
            <SkeletonRows count={3} />
          ) : shown.length === 0 ? (
            <EmptyNote>
              {needle
                ? `Nothing ${isToday ? "today" : "that day"} matches — press Find to look it up.`
                : `No sales ${isToday ? "today" : "that day"}.`}
            </EmptyNote>
          ) : (
            <ul className="grid border border-[#d4d4d8]">
              {shown.map((sale) => (
                <li
                  className="border-b border-[#e4e4e8] last:border-b-0"
                  key={sale.id}
                >
                  <SaleRow
                    onClick={() => onPick(sale)}
                    sale={sale}
                    showStation
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Modal>
  );
}

/** 숫자 1~4자리 = 영수증 끝 번호이거나 카드 뒷 4자리. */
const SHORT_NUMBER = /^\d{1,4}$/;

/** 끝 번호(77 → PH-…-0077)나 카드 뒷 4자리가 맞는가. */
function isShortHit(sale: Sale, wanted: string): boolean {
  if (!SHORT_NUMBER.test(wanted)) return false;
  const seq = sale.receipt_no.match(/-(\d+)$/)?.[1];
  if (seq && Number(seq) === Number(wanted)) return true;
  return (
    wanted.length === 4 &&
    (sale.payments ?? []).some((payment) => payment.card_last4 === wanted)
  );
}

/** `20261021-77`, `ph20261021-0077` 처럼 친 것을 `PH-20261021-0077` 로. 모양이 다르면 그대로(대문자). */
function fullReceiptNo(wanted: string): string {
  const parts = wanted
    .toUpperCase()
    .replace(/\s+/g, "")
    .match(/^(?:PH-?)?(\d{8})-?(\d{1,4})$/);
  if (!parts) return wanted.toUpperCase();
  return `PH-${parts[1]}-${parts[2].padStart(4, "0")}`;
}

// ===== 조각 ============================================================

const TIME_FORMAT = new Intl.DateTimeFormat("en-CA", {
  hour: "numeric",
  minute: "2-digit",
  timeZone: CLUB_TIME_ZONE,
});

function timeOf(iso: string): string {
  const value = new Date(iso);
  return Number.isNaN(value.getTime()) ? "" : TIME_FORMAT.format(value);
}

function SaleRow({
  sale,
  onClick,
  showStation = false,
}: {
  sale: Sale;
  onClick: () => void;
  showStation?: boolean;
}) {
  const refunded = Boolean(sale.refunded_at);
  return (
    <button
      className="flex min-h-12 w-full min-w-0 items-center justify-between gap-3 px-3 py-2 text-left hover:bg-[#f2f2f4]"
      onClick={onClick}
      type="button"
    >
      <span className="min-w-0">
        <span
          className={`block truncate text-sm font-bold ${refunded ? "text-[#6b7280] line-through" : ""}`}
        >
          {sale.receipt_no}
        </span>
        <span className="block truncate text-[11px] text-[#6b7280]">
          {[
            timeOf(sale.created_at),
            showStation ? stationLabel(sale.station) : "",
            sale.cashier ?? "",
            `${sale.lines.length} line${sale.lines.length === 1 ? "" : "s"}`,
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-2">
        {refunded ? (
          <span className="bg-[#fdf0f0] px-1.5 py-0.5 text-[10px] font-bold text-[#8a1f1f] uppercase">
            Refunded
          </span>
        ) : null}
        <span
          className={`text-sm font-bold tabular-nums ${refunded ? "text-[#6b7280] line-through" : ""}`}
        >
          {formatMoney(sale.total)}
        </span>
      </span>
    </button>
  );
}

function OpenBillButton({
  bill,
  onClick,
}: {
  bill: Bill;
  onClick: () => void;
}) {
  return (
    <button
      className="flex min-h-12 w-full items-center justify-between gap-3 border border-[#d4d4d8] px-3 py-2 text-left hover:border-[#4533ff]"
      onClick={onClick}
      type="button"
    >
      <span className="min-w-0">
        <span className="block truncate text-sm font-bold">
          {`Bill #${bill.id}`}
          {bill.label ? ` · ${bill.label}` : ""}
        </span>
        <span className="block truncate text-[11px] text-[#6b7280]">
          {[
            stationLabel(bill.station),
            bill.cashier ?? "",
            `${bill.lines.length} line${bill.lines.length === 1 ? "" : "s"}`,
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </span>
      <span className="shrink-0 text-sm font-bold tabular-nums">
        {formatMoney(bill.total)}
      </span>
    </button>
  );
}

function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <h2 className="border-b border-[#d4d4d8] pb-2 text-sm font-bold tracking-wide text-[#3f434a] uppercase">
      {children}
    </h2>
  );
}

function Section({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: ReactNode;
}) {
  return (
    <section className="grid min-w-0 gap-3">
      <SectionTitle>{title}</SectionTitle>
      {note ? <p className="text-sm text-[#3f434a]">{note}</p> : null}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(132px,1fr))] gap-3 sm:grid-cols-[repeat(auto-fill,160px)]">
        {children}
      </div>
    </section>
  );
}

const TILE =
  "relative flex aspect-square min-h-[120px] flex-col items-center justify-center gap-3 border p-3 text-center shadow-sm";

function Tile({
  icon,
  label,
  hint,
  shortcut,
  onClick,
  href,
  disabled = false,
  tone = "plain",
}: {
  icon: ReactNode;
  label: string;
  hint?: string;
  shortcut?: string;
  onClick?: () => void;
  href?: string;
  disabled?: boolean;
  tone?: "plain" | "primary";
}) {
  const look = disabled
    ? "cursor-not-allowed border-[#e4e4e8] bg-[#f7f7f8] text-[#a1a1aa]"
    : tone === "primary"
      ? "border-[#4533ff] bg-white text-[#1f2328] hover:bg-[#f4f3ff] active:bg-[#ebe9ff]"
      : "border-[#d4d4d8] bg-white text-[#1f2328] hover:border-[#4533ff] active:bg-[#f2f2f4]";
  const body = (
    <>
      {shortcut ? (
        <span className="absolute top-1.5 right-2 hidden text-[11px] text-[#6b7280] lg:block">
          {shortcut}
        </span>
      ) : null}
      <span
        aria-hidden
        className={`h-12 w-12 ${disabled ? "" : tone === "primary" ? "text-[#4533ff]" : "text-[#2b2f36]"}`}
      >
        {icon}
      </span>
      <span className="grid gap-0.5">
        <span className="text-base leading-tight font-bold">{label}</span>
        {hint ? (
          <span className="truncate text-[11px] text-[#6b7280]">{hint}</span>
        ) : null}
      </span>
    </>
  );
  if (href && !disabled) {
    return (
      <Link className={`${TILE} ${look}`} href={href}>
        {body}
      </Link>
    );
  }
  return (
    <button
      className={`${TILE} ${look}`}
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      {body}
    </button>
  );
}

// ===== 아이콘(Lightspeed 타일과 같은 뜻) =================================

const SVG = {
  viewBox: "0 0 24 24",
  fill: "currentColor",
  className: "h-full w-full",
} as const;

function ContinueIcon() {
  return (
    <svg {...SVG}>
      <path d="M14 4l7 6.5-7 6.5v-4C8.5 13 5.5 15 3 20c.5-6.5 4-11 11-12V4z" />
    </svg>
  );
}

function RefundIcon() {
  return (
    <svg {...SVG}>
      <path d="M15.5 2.5l6 6-1.6 1.6a1.8 1.8 0 00-2.5 2.5l-6.9 6.9-6-6 6.9-6.9a1.8 1.8 0 002.5-2.5l1.6-1.6zm-1.4 4.2l-7.4 7.4 3.2 3.2 7.4-7.4-3.2-3.2z" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg {...SVG}>
      <path d="M10 3h4v7h7v4h-7v7h-4v-7H3v-4h7V3z" />
    </svg>
  );
}

function PrinterIcon() {
  return (
    <svg {...SVG} fillRule="evenodd">
      <path d="M6 2h12v5H6V2zM4 8h16a2 2 0 012 2v7h-4v5H6v-5H2v-7a2 2 0 012-2zm4 7v5h8v-5H8zm10-4.5a1 1 0 100 2 1 1 0 000-2z" />
    </svg>
  );
}

function PowerIcon() {
  return (
    <svg
      {...SVG}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeWidth="2.6"
    >
      <path d="M12 3v8" />
      <path d="M6.3 6.8a8 8 0 1011.4 0" />
    </svg>
  );
}
