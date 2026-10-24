"use client";

/**
 * 카드 매출 — Daily close 의 Card·Debit 숫자를 Stripe 가 보여 주는 숫자로 이어 준다(2026-10-23).
 *
 * 두 숫자는 같은 결제를 다르게 센다. 그래서 "Stripe 와 마감이 안 맞는다" 고 보이지만 대부분은 아래 차이다:
 * - By payment 의 Card·Debit 은 **팁을 뺀** 금액이다(팁은 Tips 칸). Stripe 는 팁까지 한 번에 승인한다.
 * - 환불된 계산서는 마감에서 통째로 빠진다(서버가 이미 뺐다). Stripe 는 승인을 그대로 두고 환불을 따로 적는다.
 * - Stripe 는 카드·Interac 체크카드를 한 목록에 둔다. 마감은 Card 와 Debit 두 줄이다.
 * - 손으로 친 전표(entry `keyed`)는 Stripe 를 거치지 않았다 — 마감에는 있고 Stripe 에는 없다.
 * - 온라인 예약 결제(Stripe Checkout)도 Card 줄에 들어 있다. 계산대 단말기(S700)에는 없다.
 *
 * 우리 쪽은 그 날 계산서 목록(`sales`, paid + refunded)의 결제 줄로 다시 더한다. Stripe 쪽은 Stripe check 와
 * 같은 서버 대조(`fetchReconcile`)의 합계를 읽는다 — 결제 하나하나의 어긋남은 그 화면이 보여 준다.
 *
 * 줄마다 눌러서 그 숫자를 이루는 결제를 본다(2026-10-24, `Detail`). Difference 는 계산서마다 "Stripe 가 받은 돈 −
 * 우리 기록" 을 나란히 놓고, 0 이 아닌 계산서와 계산서 없는 Stripe 승인만 보인다. 그 합이 Difference 와 다르면
 * 나머지를 따로 적는다(숨기지 않는다).
 */

import { useEffect, useMemo, useState, type ReactNode } from "react";

import { CLUB_TIME_ZONE, PAYMENT_LABELS } from "@/lib/retail/receipt";
import { formatMoney, type Cents, type Sale, type SalePayment } from "@/lib/retail/types";
import { saleTime } from "@/lib/reports/shiftReport";
import { fetchReconcile, type ReconcileReport, type ReconcileRow } from "@/lib/reports/stripeReconcile";

import StaffName from "@/components/reports/StaffName";
import { Button, EmptyNote, ErrorNote, Modal, Panel } from "@/components/retail/ui";

type Source = "reader" | "online" | "keyed";

export type CardSalesSummary = {
  /** By payment 의 Card·Debit 과 같은 값 — paid 계산서, 팁 제외. */
  card: Cents;
  debit: Cents;
  /** paid 계산서의 카드·체크카드 팁. */
  tips: Cents;
  /** 환불된 계산서의 카드·체크카드 결제(팁 포함) — 승인은 됐다가 돌려준 돈. */
  refunded: Cents;
  /** 카드로 승인된 전부(팁 포함, 환불 계산서 포함)를 어디서 받았는지로. */
  charged: Record<Source, Cents>;
  /** 그중 환불된 계산서 몫. */
  refundedBy: Record<Source, Cents>;
};

function sourceOf(entry: string): Source {
  return entry === "integrated" ? "reader" : entry === "online" ? "online" : "keyed";
}

export function cardSalesSummary(sales: readonly Sale[]): CardSalesSummary {
  const summary: CardSalesSummary = {
    card: 0,
    debit: 0,
    tips: 0,
    refunded: 0,
    charged: { reader: 0, online: 0, keyed: 0 },
    refundedBy: { reader: 0, online: 0, keyed: 0 },
  };
  for (const sale of sales) {
    if (sale.status === "open" || sale.status === "void") continue;
    const refunded = Boolean(sale.refunded_at) || sale.status === "refunded";
    for (const pay of sale.payments ?? []) {
      if (pay.method !== "card" && pay.method !== "debit") continue;
      const total = pay.amount + pay.tip;
      const source = sourceOf(pay.entry);
      summary.charged[source] += total;
      if (refunded) {
        summary.refunded += total;
        summary.refundedBy[source] += total;
      } else {
        summary[pay.method] += pay.amount;
        summary.tips += pay.tip;
      }
    }
  }
  return summary;
}

/** 줄을 눌러 여는 상세. */
type Detail =
  | "card"
  | "debit"
  | "tips"
  | "refunded"
  | "charged"
  | "reader"
  | "online"
  | "keyed"
  | "in_stripe"
  | "voided"
  | "expected"
  | "stripe_charged"
  | "difference"
  | "refunded_here"
  | "stripe_refunded"
  | "attempts";

const SOURCE_LABELS: Record<Source, string> = { reader: "S700 reader", online: "Online", keyed: "Keyed by hand" };

/** 상세 목록의 한 줄. sale 이 있으면 눌러서 영수증을 연다. */
type Item = {
  key: string;
  primary: string;
  secondary: string;
  /** 누가 처리했나(`StaffName`). */
  staff?: ReactNode;
  amount: Cents;
  sale?: Sale;
  tone?: "warn" | "muted";
};

type PaymentRow = { sale: Sale; pay: SalePayment; refunded: boolean; source: Source };

/** 그 날 계산서의 카드·체크카드 결제 줄(열린·void 계산서 제외). */
function cardPayments(sales: readonly Sale[]): PaymentRow[] {
  const rows: PaymentRow[] = [];
  for (const sale of sales) {
    if (sale.status === "open" || sale.status === "void") continue;
    const refunded = Boolean(sale.refunded_at) || sale.status === "refunded";
    for (const pay of sale.payments ?? []) {
      if (pay.method !== "card" && pay.method !== "debit") continue;
      rows.push({ sale, pay, refunded, source: sourceOf(pay.entry) });
    }
  }
  return rows.sort((a, b) => new Date(a.sale.created_at).getTime() - new Date(b.sale.created_at).getTime());
}

function paymentItem(row: PaymentRow, amount: Cents, index: number): Item {
  const { sale, pay } = row;
  return {
    key: `${sale.id}-${index}`,
    primary: sale.receipt_no,
    staff: <StaffName date={sale.business_date} name={sale.cashier} />,
    secondary: [
      saleTime(sale),
      PAYMENT_LABELS[pay.method],
      SOURCE_LABELS[row.source],
      pay.card_last4 ? `•••• ${pay.card_last4}` : "",
      pay.tip ? `tip ${formatMoney(pay.tip)}` : "",
      row.refunded ? "refunded" : "",
    ]
      .filter(Boolean)
      .join(" · "),
    amount,
    sale,
  };
}

function cardName(brand: string, last4: string): string {
  return [brand, last4 ? `•••• ${last4}` : ""].filter(Boolean).join(" ");
}

const STRIPE_TIME = new Intl.DateTimeFormat("en-US", { timeZone: CLUB_TIME_ZONE, hour: "numeric", minute: "2-digit" });

function stripeTime(created: number): string {
  return STRIPE_TIME.format(new Date(created * 1000));
}

function stripeItem(row: ReconcileRow, amount: Cents, salesById: Map<number, Sale>, note = ""): Item {
  const stripe = row.stripe;
  const ours = row.ours;
  const sale = ours?.bill_id ? salesById.get(ours.bill_id) : undefined;
  return {
    key: row.key,
    primary: ours?.receipt_no ?? (ours?.voided ? "Voided on the reader" : "No bill here"),
    secondary: [
      stripe ? stripeTime(stripe.created) : "",
      stripe ? cardName(stripe.card_brand, stripe.card_last4) : "",
      stripe?.payment_intent ?? "",
      note,
    ]
      .filter(Boolean)
      .join(" · "),
    amount,
    sale,
  };
}

/**
 * Difference 를 계산서마다 나눈다. 우리 쪽 = 그 계산서의 단말기·온라인 카드 결제(금액 + 팁, 환불 계산서 포함 —
 * "Should be charged" 와 같은 범위), Stripe 쪽 = 그 계산서에 붙은 Stripe 승인. 단말기에서 VOID 한 승인은 양쪽에
 * 같은 금액이 더해져(+ Voided) 차이를 만들지 않는다.
 */
function differenceItems(
  payments: readonly PaymentRow[],
  report: ReconcileReport,
  salesById: Map<number, Sale>,
): Item[] {
  const ours = new Map<number, Cents>();
  for (const row of payments) {
    if (row.source === "keyed") continue;
    ours.set(row.sale.id, (ours.get(row.sale.id) ?? 0) + row.pay.amount + row.pay.tip);
  }
  const stripeByBill = new Map<number, ReconcileRow[]>();
  const items: Item[] = [];
  for (const row of report.rows) {
    if (!row.stripe || row.ours?.voided) continue;
    const bill = row.ours?.bill_id ?? null;
    if (bill === null || !salesById.has(bill)) {
      // 계산서가 없거나 이 날 계산서가 아니다 — Stripe 만 받은 돈.
      if (row.stripe.amount !== 0) {
        items.push({
          ...stripeItem(
            row,
            row.stripe.amount,
            salesById,
            bill === null ? "charged in Stripe, no bill here" : `bill ${row.ours?.business_date ?? "on another day"}`,
          ),
          tone: "warn",
        });
      }
      continue;
    }
    stripeByBill.set(bill, [...(stripeByBill.get(bill) ?? []), row]);
  }
  for (const id of new Set([...ours.keys(), ...stripeByBill.keys()])) {
    const sale = salesById.get(id);
    if (!sale) continue;
    const rows = stripeByBill.get(id) ?? [];
    const inStripe = rows.reduce((sum, row) => sum + (row.stripe?.amount ?? 0), 0);
    const here = ours.get(id) ?? 0;
    if (inStripe === here) continue;
    const why =
      rows.length === 0
        ? "on the bill, not found in Stripe"
        : here === 0
          ? "charged in Stripe, not a card payment on the bill"
          : `Stripe ${formatMoney(inStripe)} vs bill ${formatMoney(here)}`;
    items.push({
      key: `bill-${id}`,
      primary: sale.receipt_no,
      staff: <StaffName date={sale.business_date} name={sale.cashier} />,
      secondary: [saleTime(sale), why, ...rows.flatMap((row) => row.issues.map((issue) => issue.message))]
        .filter(Boolean)
        .join(" · "),
      amount: inStripe - here,
      sale,
      tone: "warn",
    });
  }
  return items;
}

export default function CardSales({
  date,
  sales,
  onOpenSale,
}: {
  date: string;
  sales: readonly Sale[];
  /** 상세 목록에서 계산서를 누르면 영수증을 연다. */
  onOpenSale?: (sale: Sale) => void;
}) {
  const summary = useMemo(() => cardSalesSummary(sales), [sales]);
  const payments = useMemo(() => cardPayments(sales), [sales]);
  const salesById = useMemo(() => new Map(sales.map((sale) => [sale.id, sale])), [sales]);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [nonce, setNonce] = useState(0);
  const requestKey = `${date}#${nonce}`;
  const [loaded, setLoaded] = useState<{ key: string; report: ReconcileReport | null; error: string } | null>(null);
  const loading = loaded?.key !== requestKey;
  const stripe = loading ? null : loaded.report;

  useEffect(() => {
    let cancelled = false;
    fetchReconcile(date, date)
      .then((report) => {
        if (!cancelled) setLoaded({ key: requestKey, report, error: "" });
      })
      .catch((cause) => {
        if (!cancelled) {
          setLoaded({
            key: requestKey,
            report: null,
            error: cause instanceof Error ? cause.message : "Could not reach Stripe.",
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [date, requestKey]);

  const charged = summary.charged.reader + summary.charged.online + summary.charged.keyed;
  const inStripe = summary.charged.reader + summary.charged.online;
  const refundedInStripe = summary.refundedBy.reader + summary.refundedBy.online;
  const open = (key: Detail) => () => setDetail(key);

  return (
    <Panel
      actions={
        <Button disabled={loading} onClick={() => setNonce((value) => value + 1)}>
          Refresh
        </Button>
      }
      title={`Card & debit vs. Stripe — ${date}`}
    >
      <div className="grid gap-3">
        <p className="text-xs text-[#6b7280]">
          Card and Debit under By payment leave tips out and drop refunded sales. Stripe charges the tip with the sale,
          keeps refunded charges (the refund is a separate line), and lists card and Interac debit together. Card slips
          keyed in by hand never went through Stripe. Online booking payments are in Card but not on the register
          reader. Canceled and declined attempts show in Stripe&apos;s list but no money moved.
        </p>

        <div className="grid gap-3 lg:grid-cols-2">
          <ul className="grid content-start gap-1 text-sm">
            <Row label="Card (By payment)" onClick={open("card")} value={summary.card} />
            <Row label="Debit (By payment)" onClick={open("debit")} value={summary.debit} />
            <Row label="+ Tips on card & debit" onClick={open("tips")} value={summary.tips} />
            <Row
              label="+ Refunded sales (charged, then refunded)"
              onClick={open("refunded")}
              value={summary.refunded}
            />
            <Row bold label="= Charged on cards" onClick={open("charged")} value={charged} />
            <Row indent label="Register reader (S700)" onClick={open("reader")} value={summary.charged.reader} />
            <Row
              indent
              label="Online booking (Stripe Checkout)"
              onClick={open("online")}
              value={summary.charged.online}
            />
            <Row
              indent
              label="Keyed by hand — not in Stripe"
              onClick={open("keyed")}
              value={summary.charged.keyed}
              warn={summary.charged.keyed > 0}
            />
          </ul>

          <ul className="grid content-start gap-1 text-sm">
            <Row label="Reader + online" onClick={open("in_stripe")} value={inStripe} />
            {loading ? (
              <li className="text-xs text-[#6b7280]">Reading Stripe…</li>
            ) : stripe ? (
              <StripeSide
                date={date}
                inStripe={inStripe}
                onOpen={setDetail}
                refundedInStripe={refundedInStripe}
                report={stripe}
              />
            ) : (
              <li>
                <ErrorNote>{loaded?.error || "Could not read Stripe."}</ErrorNote>
              </li>
            )}
          </ul>
        </div>
        <p className="text-[11px] text-[#6b7280]">Tap any line to see the payments behind it.</p>
      </div>

      {detail ? (
        <DetailModal
          detail={detail}
          onClose={() => setDetail(null)}
          onOpenSale={
            onOpenSale
              ? (sale) => {
                  setDetail(null);
                  onOpenSale(sale);
                }
              : undefined
          }
          payments={payments}
          salesById={salesById}
          stripe={stripe}
          totals={{ inStripe, refundedInStripe }}
        />
      ) : null}
    </Panel>
  );
}

const DETAIL_TITLES: Record<Detail, string> = {
  card: "Card (By payment) — tips out, refunded sales out",
  debit: "Debit (By payment) — tips out, refunded sales out",
  tips: "Tips on card & debit",
  refunded: "Refunded sales — charged, then refunded",
  charged: "Charged on cards — every card & debit payment",
  reader: "Register reader (S700)",
  online: "Online booking (Stripe Checkout)",
  keyed: "Keyed by hand — not in Stripe",
  in_stripe: "Reader + online",
  voided: "Voided on the reader before the bill",
  expected: "Should be charged in Stripe",
  stripe_charged: "Stripe charged",
  difference: "Difference — Stripe charged vs. should be charged",
  refunded_here: "Refunded & voided here (reader & online)",
  stripe_refunded: "Stripe refunded",
  attempts: "Canceled / declined in Stripe — no money moved",
};

function DetailModal({
  detail,
  payments,
  salesById,
  stripe,
  totals,
  onOpenSale,
  onClose,
}: {
  detail: Detail;
  payments: readonly PaymentRow[];
  salesById: Map<number, Sale>;
  stripe: ReconcileReport | null;
  totals: { inStripe: Cents; refundedInStripe: Cents };
  onOpenSale?: (sale: Sale) => void;
  onClose: () => void;
}) {
  const pay = (filter: (row: PaymentRow) => boolean, amount: (row: PaymentRow) => Cents) =>
    payments
      .filter(filter)
      .map((row, index) => paymentItem(row, amount(row), index))
      .filter((item) => item.amount !== 0);
  const full = (row: PaymentRow) => row.pay.amount + row.pay.tip;
  const voidedRows = (stripe?.rows ?? []).filter((row) => row.ours?.voided);
  const voidedItems = voidedRows.map((row) =>
    stripeItem(row, row.stripe ? row.stripe.amount : (row.ours?.amount ?? 0), salesById, "voided before the bill"),
  );

  let items: Item[] = [];
  let note: ReactNode = null;
  let expectedTotal: Cents | null = null;
  switch (detail) {
    case "card":
    case "debit":
      items = pay((row) => !row.refunded && row.pay.method === detail, (row) => row.pay.amount);
      break;
    case "tips":
      items = pay((row) => !row.refunded, (row) => row.pay.tip);
      break;
    case "refunded":
      items = pay((row) => row.refunded, full);
      break;
    case "charged":
      items = pay(() => true, full);
      break;
    case "reader":
    case "online":
    case "keyed":
      items = pay((row) => row.source === detail, full);
      if (detail === "keyed") {
        note = "Typed into the card machine by hand — Stripe never saw these, so they are not in Stripe charged.";
      }
      break;
    case "in_stripe":
      items = pay((row) => row.source !== "keyed", full);
      break;
    case "voided":
      items = voidedItems;
      note = "Approved on the S700, then voided before it was put on a bill. Stripe keeps the charge and its refund.";
      break;
    case "expected":
      items = [...pay((row) => row.source !== "keyed", full), ...voidedItems];
      break;
    case "stripe_charged":
      items = (stripe?.rows ?? [])
        .filter((row) => row.stripe && row.stripe.amount !== 0)
        .map((row) => stripeItem(row, row.stripe?.amount ?? 0, salesById, row.stripe?.status ?? ""));
      break;
    case "difference": {
      items = stripe ? differenceItems(payments, stripe, salesById) : [];
      const s = stripe?.summary;
      expectedTotal = s ? s.stripe_charged - (totals.inStripe + (s.voided_amount ?? 0)) : null;
      note =
        "Plus = Stripe took more than this bill shows; minus = the bill shows more than Stripe took. " +
        "Bills that match are left out.";
      break;
    }
    case "refunded_here":
      items = [...pay((row) => row.refunded && row.source !== "keyed", full), ...voidedItems];
      break;
    case "stripe_refunded":
      items = (stripe?.rows ?? [])
        .filter((row) => (row.stripe?.refunded ?? 0) !== 0)
        .map((row) => stripeItem(row, row.stripe?.refunded ?? 0, salesById, "refunded in Stripe"));
      break;
    case "attempts":
      items = (stripe?.attempts ?? []).map((attempt) => ({
        key: attempt.payment_intent,
        primary: attempt.label || attempt.status_label,
        secondary: [
          STRIPE_TIME.format(new Date(attempt.at)),
          attempt.status_label,
          cardName(attempt.card_brand, attempt.card_last4),
          attempt.message || attempt.reason,
        ]
          .filter(Boolean)
          .join(" · "),
        amount: attempt.amount,
        tone: "muted" as const,
      }));
      note = "The card was never charged for these — they are not in any total.";
      break;
  }

  const total = items.reduce((sum, item) => sum + item.amount, 0);
  const rest = expectedTotal !== null ? expectedTotal - total : 0;

  return (
    <Modal onClose={onClose} title={DETAIL_TITLES[detail]} wide>
      <div className="grid gap-3">
        {note ? <p className="text-xs text-[#6b7280]">{note}</p> : null}
        {items.length === 0 ? (
          <EmptyNote>
            {detail === "difference" ? "Every bill matches Stripe." : "Nothing here for this date."}
          </EmptyNote>
        ) : (
          <ul className="grid gap-1.5">
            {items.map((item) => (
              <li key={item.key}>
                <DetailRow
                  item={item}
                  onOpen={item.sale && onOpenSale ? () => onOpenSale(item.sale as Sale) : undefined}
                />
              </li>
            ))}
          </ul>
        )}
        {rest !== 0 ? (
          <p className="bg-[#fff8e1] px-3 py-2 text-xs text-[#5b4708]">
            {formatMoney(rest)} of the difference is not tied to one bill (for example a payment made on another day, or
            a card payment recorded without its reader approval). Open Stripe check to see every payment.
          </p>
        ) : null}
        <div className="flex items-baseline justify-between gap-2 border-t border-[#d4d4d8] pt-2">
          <span className="text-sm font-bold">
            Total <span className="text-xs font-normal text-[#6b7280]">{items.length} line(s)</span>
          </span>
          <span className="text-lg font-bold tabular-nums">{formatMoney(expectedTotal ?? total)}</span>
        </div>
        {onOpenSale ? <p className="text-[11px] text-[#6b7280]">Tap a receipt to open it.</p> : null}
      </div>
    </Modal>
  );
}

function DetailRow({ item, onOpen }: { item: Item; onOpen?: () => void }) {
  const body = (
    <>
      <span className="min-w-0">
        <span className="block truncate text-sm font-bold">{item.primary}</span>
        <span className="block text-xs break-words text-[#6b7280]">
          {item.staff ? (
            <>
              <span className="font-semibold text-[#3f434a]">{item.staff}</span>
              {item.secondary ? " · " : ""}
            </>
          ) : null}
          {item.secondary}
        </span>
      </span>
      <span
        className={`shrink-0 text-sm font-bold tabular-nums ${
          item.tone === "warn" ? "text-[#8a1f1f]" : item.tone === "muted" ? "text-[#6b7280]" : ""
        }`}
      >
        {item.tone === "warn" && item.amount > 0 ? "+" : ""}
        {formatMoney(item.amount)}
      </span>
    </>
  );
  const className = "flex w-full items-center justify-between gap-3 border border-[#e4e4e8] px-3 py-2 text-left";
  return onOpen ? (
    <button className={`${className} hover:border-[#4533ff]`} onClick={onOpen} type="button">
      {body}
    </button>
  ) : (
    <div className={className}>{body}</div>
  );
}

/**
 * Stripe 쪽. 단말기에서 승인했다가 계산서에 쓰기 전에 VOID 한 것은 계산서가 없어 왼쪽에 없지만 Stripe 에는
 * 승인과 환불로 남는다 — 그래서 여기서 더해 맞춘다. 취소·거절된 시도는 돈이 오가지 않아 합계 밖에 둔다.
 */
function StripeSide({
  report,
  inStripe,
  refundedInStripe,
  date,
  onOpen,
}: {
  report: ReconcileReport;
  inStripe: Cents;
  refundedInStripe: Cents;
  date: string;
  onOpen: (detail: Detail) => void;
}) {
  const s = report.summary;
  const voided = s.voided_amount ?? 0;
  const expected = inStripe + voided;
  const expectedRefunds = refundedInStripe + voided;
  return (
    <>
      <Row
        label={`+ Voided on the reader before the bill ×${s.voided ?? 0}`}
        onClick={() => onOpen("voided")}
        value={voided}
      />
      <Row bold label="= Should be charged in Stripe" onClick={() => onOpen("expected")} value={expected} />
      <Row
        bold
        label={`Stripe charged${report.environment === "test" ? " (test mode)" : ""}`}
        onClick={() => onOpen("stripe_charged")}
        value={s.stripe_charged}
      />
      <Row
        bold
        label="Difference"
        onClick={() => onOpen("difference")}
        value={s.stripe_charged - expected}
        warn={s.stripe_charged !== expected}
      />
      <Row
        label="Refunded & voided here (reader & online)"
        onClick={() => onOpen("refunded_here")}
        value={expectedRefunds}
      />
      <Row
        label="Stripe refunded"
        onClick={() => onOpen("stripe_refunded")}
        value={s.stripe_refunded}
        warn={s.stripe_refunded !== expectedRefunds}
      />
      {s.attempts !== undefined ? (
        <Row
          label={`Canceled / declined in Stripe ×${s.attempts} — no money moved`}
          muted
          onClick={() => onOpen("attempts")}
          value={s.attempts_amount ?? 0}
        />
      ) : null}
      <li className="pt-1 text-xs text-[#6b7280]">
        {s.errors + s.warnings > 0
          ? `${s.errors} problem(s) and ${s.warnings} to check, payment by payment — `
          : "Every Stripe payment matched a record here — "}
        <a className="font-semibold text-[#4533ff] underline" href={`?view=stripe&date=${date}`}>
          open Stripe check
        </a>
        . A refund made on another day shows on that day in Stripe but takes the sale out of this day here.
      </li>
    </>
  );
}

/** `onClick` 이 있으면 줄 전체가 버튼 — 그 숫자를 이루는 결제를 연다. */
function Row({
  label,
  value,
  bold = false,
  indent = false,
  warn = false,
  muted = false,
  onClick,
}: {
  label: string;
  value: Cents;
  bold?: boolean;
  indent?: boolean;
  warn?: boolean;
  muted?: boolean;
  onClick?: () => void;
}) {
  const body = (
    <>
      <span className="min-w-0">{label}</span>
      <span className="shrink-0 tabular-nums">{formatMoney(value)}</span>
    </>
  );
  return (
    <li
      className={`${bold ? "border-t border-[#ececf0] pt-1 font-bold" : ""} ${indent ? "pl-4 text-[#4b5563]" : ""} ${
        warn ? "text-[#8a1f1f]" : muted ? "text-[#6b7280]" : ""
      }`}
    >
      {onClick ? (
        <button
          className="flex w-full items-baseline justify-between gap-2 text-left hover:text-[#4533ff] hover:underline"
          onClick={onClick}
          type="button"
        >
          {body}
        </button>
      ) : (
        <span className="flex items-baseline justify-between gap-2">{body}</span>
      )}
    </li>
  );
}
