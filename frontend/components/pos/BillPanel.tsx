"use client";

/**
 * 합산 계산서 한 장. 리테일 계산대·스낵바·티 시트가 **같은 컴포넌트**를 쓴다 — 두 벌이면
 * 한쪽에만 결제 규칙이 추가된다.
 *
 * 결제 순서
 * 1. 계산서가 다 차면 결제 줄을 하나씩 더한다. 카드·체크카드 줄을 더하는 순간 서버에서 합계를
 *    다시 읽는다 — 단말기로 가는 금액이 곧 그 값이다.
 * 2. 단말기 연동이 켜진 기기(`lib/pos/terminal.ts`, "integrated"): 금액이 Stripe 리더(S700 등)로 가고, 손님이
 *    카드를 대면 승인번호·끝 4자리·팁이 저절로 결제 줄이 된다. 승인은 Charge 전에 이미 서버에 남는다(0021) —
 *    화면을 닫았다 열어도 결제 줄이 되살아난다. 결제 줄을 지우면 환불한다(신용카드는 카드 없이, Interac 은
 *    손님이 카드를 다시 댄다). 연동이 꺼진 기기("keyed"): 직원이 단말기에 금액을 치고 승인번호를 여기 적는다.
 * 3. 남은 금액이 0 이 되면 Charge. 서버는 한 트랜잭션에서 재고·티 시트 paid·영수증 번호를 처리한다.
 *    단말기 승인으로 남은 금액이 0 이 되면 Charge 를 누르지 않아도 저절로 마무리하고, "결제 완료 ·
 *    영수증을 뽑을까요?" 만 묻는다(2026-10-18).
 *
 * 현금은 받은 돈을 적으면 거스름돈을 보여 주고, 서버에는 **계산서에 들어간 몫**만 보낸다
 * (서버는 결제 합이 합계와 정확히 같아야 받는다).
 *
 * 레인체크(0011)는 전표 바코드를 쏘거나 코드를 쳐서 찾는다. 크레딧과 남은 금액 중 작은 쪽이
 * 들어가고, 쓰고 남는 크레딧은 사라진다(화면이 미리 알린다). 만료·사용 여부는 서버가 결제할 때 다시 본다.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import {
  billTakesTip,
  newCheckoutId,
  TERMINAL_METHODS,
  type Bill,
  type BillLine,
  type BillStation,
  type PaymentInput,
} from "@/lib/pos/api";
import { billActions, recentCashiers, rememberCashier, rememberedCashier, useCurrentBill } from "@/lib/pos/currentBill";
import {
  describeTerminalResult,
  terminal,
  terminalConfig,
  terminalEnabled,
  TerminalError,
  useTerminalSettings,
  writeTerminalSettings,
  type Reader,
  type TerminalMode,
  type TerminalRecord,
  type TerminalSettings,
} from "@/lib/pos/terminal";
import {
  describeRainCheckError,
  isRainCheckCode,
  rainCheckApi,
  subscribeRainCheckCode,
  takeRainCheckCode,
  type RainCheck,
} from "@/lib/pos/rainCheck";
import { printReceipt } from "@/lib/retail/printReceipt";
import { PAYMENT_LABELS, usDate } from "@/lib/retail/receipt";
import retailApi from "@/lib/retail/api";
import {
  PAYMENT_METHODS,
  formatMoney,
  parseMoney,
  type PaymentMethod,
  type Product,
  type RetailCategory,
  type Sale,
} from "@/lib/retail/types";

import { Button, EmptyNote, ErrorNote, Field, Select, TextInput } from "@/components/retail/ui";

// ===== 자동 인쇄 스위치 (이 브라우저에만) ==============================

const AUTO_PRINT_KEY = "pelham.retail.autoPrint";
let autoPrintFallback = false;
const autoPrintListeners = new Set<() => void>();

function readAutoPrint(): boolean {
  try {
    return window.localStorage.getItem(AUTO_PRINT_KEY) === "on";
  } catch {
    return autoPrintFallback;
  }
}

function writeAutoPrint(on: boolean): void {
  autoPrintFallback = on;
  try {
    window.localStorage.setItem(AUTO_PRINT_KEY, on ? "on" : "off");
  } catch {
    // 메모리 값으로 버틴다.
  }
  autoPrintListeners.forEach((listener) => listener());
}

function subscribeAutoPrint(listener: () => void): () => void {
  autoPrintListeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    autoPrintListeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

// ===== 본체 ============================================================

type PendingPayment = PaymentInput & { key: number; cashReceived?: number; terminalRecord?: TerminalRecord };

/** 단말기 승인 기록 → 결제 줄. */
function fromTerminal(key: number, record: TerminalRecord): PendingPayment {
  return {
    key,
    method: record.card_type === "debit" ? "debit" : "card",
    amount: record.requested_amount,
    ...(record.tip > 0 ? { tip: record.tip } : {}),
    ...(record.auth_code ? { auth_code: record.auth_code } : {}),
    ...(record.card_last4 ? { card_last4: record.card_last4 } : {}),
    terminal_txn: record.id,
    terminalRecord: record,
  };
}

function terminalErrorText(error: unknown): string {
  if (error instanceof TerminalError) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return "The terminal did not answer. Look at its screen before trying again.";
}

/** 서버에 보내는 모양. 화면용 key·받은 현금은 뺀다. */
function toPaymentInput(payment: PendingPayment): PaymentInput {
  return {
    method: payment.method,
    amount: payment.amount,
    ...(payment.tip ? { tip: payment.tip } : {}),
    ...(payment.auth_code ? { auth_code: payment.auth_code } : {}),
    ...(payment.card_last4 ? { card_last4: payment.card_last4 } : {}),
    ...(payment.rain_check_code ? { rain_check_code: payment.rain_check_code } : {}),
    ...(payment.terminal_txn ? { terminal_txn: payment.terminal_txn } : {}),
  };
}

type Props = {
  station: BillStation;
  /** 서버 없이 예시 데이터를 보는 중. 계산서를 만들지 않는다. */
  demo?: boolean;
  /** 결제가 끝났을 때(재고를 다시 읽는 등). */
  onPaid?: (bill: Bill) => void;
  /** 값이 (0 이 아닌 값으로) 바뀌면 결제 칸으로 스크롤한다. 계산대에서 스캔으로 담았을 때. */
  revealPayments?: number;
  /** 결제 칸이 처음 고르고 있을 수단. 티 시트의 Take Payment 에서 카드·현금 타일을 고르고 들어올 때. */
  initialMethod?: PaymentMethod;
  /**
   * "panel" = 좁은 옆 칸(계산대·티 시트 기본). "sales" = Lightspeed 의 Sales 화면처럼 넓게 — 왼쪽에 품목 찾기와
   * DESCRIPTION · PRICE · QTY · TAX · SUBTOTAL 표, 오른쪽에 합계와 결제. 티 시트의 Take Payment 가 쓴다.
   */
  layout?: "panel" | "sales";
  /** sales 화면에서 줄의 두 줄 설명(예: "18 Hole Green Fee - Public" / "Mackey Michelle (#R…) - Tee Time: …"). */
  describeLine?: (line: BillLine) => { title: string; detail?: string } | null;
  /** sales 화면의 손님 칸(왼쪽 위). 없으면 계산서 이름. */
  customer?: string;
  /** 결제 뒤 영수증 화면에서 Done 을 눌렀을 때. 없으면 빈 계산서로 돌아간다. */
  onDone?: () => void;
};

export default function BillPanel({
  station,
  demo = false,
  onPaid,
  revealPayments = 0,
  initialMethod,
  layout = "panel",
  describeLine,
  customer,
  onDone,
}: Props) {
  const current = useCurrentBill();
  const { bill, openBills, busy, error, missing } = current;
  const autoPrint = useSyncExternalStore(subscribeAutoPrint, readAutoPrint, () => false);
  const terminalSettings = useTerminalSettings();
  const useTerminal = terminalEnabled(terminalSettings);

  const [receipt, setReceipt] = useState<Sale | null>(null);
  const [payments, setPayments] = useState<PendingPayment[]>([]);
  const [charging, setCharging] = useState(false);
  // 단말기 승인이 막 결제 줄이 됐다. 남은 금액이 0 이면 아래 효과가 Charge 를 대신 누른다.
  const autoChargeRef = useRef(false);

  // 결제 한 번 = checkout_id 하나. 계산서나 결제 줄이 바뀌면 새로 만든다. 연결이 끊겨 다시
  // 누르는 경우에만 같은 값을 쓴다 — 서버가 같은 결제를 두 번 받지 않는다.
  const checkoutRef = useRef<string>("");
  const paymentsKey = JSON.stringify(payments.map(toPaymentInput));
  useEffect(() => {
    checkoutRef.current = "";
  }, [bill?.id, bill?.total, paymentsKey]);

  // 다른 계산서로 옮겨 타면 적어 둔 결제 줄은 버린다(그 계산서의 돈이 아니다).
  const billId = bill?.id ?? null;
  const [paymentsFor, setPaymentsFor] = useState<number | null>(billId);
  if (paymentsFor !== billId) {
    setPaymentsFor(billId);
    setPayments([]);
  }

  // 단말기가 승인했는데 Charge 전에 화면이 닫혔던 결제를 되살린다(서버 기록, 0021). 결과를 모르던
  // 거래는 서버가 Stripe 에 물어 먼저 마무리한다.
  const [terminalNote, setTerminalNote] = useState("");
  useEffect(() => {
    if (!billId || !useTerminal || demo) return;
    let cancelled = false;
    void (async () => {
      try {
        await terminal.recover(billId).catch(() => []);
        const approved = await terminal.pending(billId);
        if (cancelled || approved.length === 0) return;
        setPayments((current) => {
          const known = new Set(current.map((payment) => payment.terminal_txn));
          const restored = approved.filter((record) => !known.has(record.id));
          return restored.length === 0
            ? current
            : [...current, ...restored.map((record) => fromTerminal(-record.id, record))];
        });
        setTerminalNote(
          `${approved.length} card payment${approved.length === 1 ? " was" : "s were"} already approved on the terminal for this bill and ${
            approved.length === 1 ? "is" : "are"
          } back on the list.`,
        );
      } catch {
        // 되살리기만 못 했다. 결제는 계속할 수 있고, 다음에 이 계산서를 열 때 다시 본다.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [billId, useTerminal, demo]);

  // 담당자 이름. 담당자별 마감과 팁 나누기가 이 이름으로 묶인다(0010). 계산서에 없으면 이 기기가
  // 마지막으로 쓴 이름을 미리 넣는다 — 서버에는 칸을 떠날 때나 Charge 직전에 보낸다.
  const [cashier, setCashier] = useState("");
  const [cashierFor, setCashierFor] = useState<number | null>(null);
  const [cashierError, setCashierError] = useState("");
  if (cashierFor !== billId) {
    setCashierFor(billId);
    setCashier(bill?.cashier ?? (billId ? rememberedCashier() : ""));
    setCashierError("");
  }

  async function commitCashier(): Promise<boolean> {
    const name = cashier.trim().replace(/\s+/g, " ");
    if (!name) return false;
    rememberCashier(name);
    if (bill && name !== (bill.cashier ?? "")) {
      const updated = await billActions.update({ cashier: name }, station);
      if (!updated) return false;
    }
    return true;
  }

  const paymentsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!revealPayments) return;
    // 숨겨진 쪽(데스크톱의 모바일 시트, 휴대폰의 옆 계산서)은 크기가 없어 아무 일도 안 한다.
    paymentsRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [revealPayments]);

  const total = bill?.total ?? 0;
  const paidSoFar = payments.reduce((sum, payment) => sum + payment.amount, 0);
  const remaining = Math.max(total - paidSoFar, 0);
  const lines = bill?.lines ?? [];

  // 전액 할인(컴프·GolfNow 선결제 등)이면 받을 돈이 없다. 결제 줄 없이 닫는다.
  const noCharge = Boolean(bill) && lines.length > 0 && total === 0;
  const canCharge = remaining === 0 && (payments.length > 0 || noCharge);

  async function charge(fromTerminal = false) {
    if (!bill || !canCharge || charging) return;
    if (!cashier.trim()) {
      setCashierError("Enter who is ringing this in. Close-outs and tips go by this name.");
      return;
    }
    setCharging(true);
    if (!(await commitCashier())) {
      setCharging(false);
      return;
    }
    if (!checkoutRef.current) checkoutRef.current = newCheckoutId();
    const paid = await billActions.pay(checkoutRef.current, payments.map(toPaymentInput));
    setCharging(false);
    if (!paid) return;
    setReceipt(paid);
    setPayments([]);
    onPaid?.(paid);
    // 카드를 대고 끝난 결제는 영수증을 뽑을지 화면이 묻는다. 그때는 자동 인쇄를 하지 않는다.
    // 인쇄는 다음 틱으로. `window.print()` 가 스크립트를 멈추면 비워진 화면이 인쇄 뒤에야 그려진다.
    if (autoPrint && !fromTerminal) window.setTimeout(() => printReceipt(paid), 0);
  }

  // 카드를 대서 계산서가 다 찼으면 바로 마무리한다. 현금 등 다른 줄이 남았으면 평소처럼 Charge 를 누른다.
  useEffect(() => {
    if (!autoChargeRef.current) return;
    autoChargeRef.current = false;
    // 이 렌더의 결제 줄로 마무리한다(다음 틱 — 렌더 중 상태를 바꾸지 않게).
    if (canCharge) window.setTimeout(() => void charge(true), 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 결제 줄이 더해진 그 렌더에서 한 번만 본다.
  }, [payments]);

  if (receipt) {
    const done = () => {
      setReceipt(null);
      onDone?.();
    };
    return layout === "sales" ? (
      <div className="mx-auto w-full max-w-md py-6">
        <PaidReceipt onDone={done} sale={receipt} />
      </div>
    ) : (
      <PaidReceipt onDone={done} sale={receipt} />
    );
  }

  if (layout === "sales") {
    return (
      <SalesLayout
        bill={bill}
        busy={busy}
        cashierField={
          <>
            <Field hint="Close-outs and tips go by it" label="Cashier">
              <TextInput
                autoComplete="off"
                list="pelham-cashiers"
                onBlur={() => void commitCashier()}
                onChange={(event) => {
                  setCashier(event.target.value);
                  setCashierError("");
                }}
                placeholder="Who is ringing this in"
                value={cashier}
              />
            </Field>
            <datalist id="pelham-cashiers">
              {recentCashiers().map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
            {cashierError ? <ErrorNote>{cashierError}</ErrorNote> : null}
          </>
        }
        chargeButton={
          <>
            <label className="flex min-h-9 items-center gap-2 text-xs">
              <input
                checked={autoPrint}
                className="h-4 w-4 accent-[#4533ff]"
                onChange={(event) => writeAutoPrint(event.target.checked)}
                type="checkbox"
              />
              Print receipt after charge
            </label>
            <TerminalSetup settings={terminalSettings} />
            <button
              className="min-h-14 w-full bg-[#5cb85c] text-base font-bold text-white hover:bg-[#4cae4c] disabled:cursor-not-allowed disabled:bg-[#a8d8a8]"
              disabled={demo || charging || busy || !canCharge}
              onClick={() => void charge()}
              type="button"
            >
              {charging
                ? "Charging…"
                : noCharge
                  ? "Close bill — no charge"
                  : canCharge
                    ? `Charge ${formatMoney(total)}`
                    : `Add payments — ${formatMoney(remaining)} left`}
            </button>
          </>
        }
        customer={customer}
        demo={demo}
        describeLine={describeLine}
        error={error}
        paymentsEditor={
          bill ? (
            <div ref={paymentsRef}>
              {terminalNote ? <p className="bg-[#eef6f0] px-2 py-2 text-xs text-[#1f6b3a]">{terminalNote}</p> : null}
              <PaymentsEditor
                billId={bill.id}
                initialMethod={initialMethod}
                payments={payments}
                remaining={remaining}
                takesTip={billTakesTip(bill)}
                onTerminalApproved={() => (autoChargeRef.current = true)}
                setPayments={setPayments}
                terminalSettings={terminalSettings}
              />
            </div>
          ) : null
        }
        station={station}
      />
    );
  }

  return (
    <div className="grid gap-3 p-3">
      <BillHeader bill={bill} busy={busy} demo={demo} openBills={openBills} />

      {missing ? <ErrorNote>{error}</ErrorNote> : null}

      {lines.length === 0 ? (
        <EmptyNote>
          {station === "tee_sheet"
            ? "Pick a reservation and press Add to bill. Products scanned at the register land on the same bill."
            : station === "simulator"
              ? "Pick a bay booking and press Pay. Products scanned at the register land on the same bill."
              : "Scan or tap a product to start. Green fees and simulator bays added on their sheets show up here too."}
        </EmptyNote>
      ) : (
        <ul className="grid gap-2">
          {lines.map((line) => (
            <BillLineRow key={line.id} line={line} station={station} />
          ))}
        </ul>
      )}

      {bill && lines.length > 0 ? (
        <>
          <MoneyField
            key={`discount-${bill.id}-${bill.discount}`}
            initial={bill.discount}
            label="Bill discount"
            onCommit={(cents) => billActions.update({ discount: cents }, station)}
          />

          <dl className="grid gap-1 border-t border-[#d4d4d8] pt-2 text-sm">
            <Row label="Subtotal" value={formatMoney(bill.subtotal)} />
            {bill.discount > 0 ? <Row label="Discount" value={`−${formatMoney(bill.discount)}`} /> : null}
            <Row label="HST (13%)" value={formatMoney(bill.tax)} />
            <div className="flex items-baseline justify-between gap-2 border-t border-[#d4d4d8] pt-1.5">
              <dt className="font-bold">Total</dt>
              <dd className="text-xl font-bold tabular-nums">{formatMoney(bill.total)}</dd>
            </div>
          </dl>

          <div ref={paymentsRef}>
            {terminalNote ? <p className="bg-[#eef6f0] px-2 py-2 text-xs text-[#1f6b3a]">{terminalNote}</p> : null}
            <PaymentsEditor
              billId={bill.id}
              initialMethod={initialMethod}
              payments={payments}
              remaining={remaining}
              takesTip={billTakesTip(bill)}
              onTerminalApproved={() => (autoChargeRef.current = true)}
              setPayments={setPayments}
              terminalSettings={terminalSettings}
            />
          </div>

          <Field hint="Your name — close-outs and tips go by it" label="Cashier">
            <TextInput
              autoComplete="off"
              list="pelham-cashiers"
              onBlur={() => void commitCashier()}
              onChange={(event) => {
                setCashier(event.target.value);
                setCashierError("");
              }}
              placeholder="Who is ringing this in"
              value={cashier}
            />
          </Field>
          <datalist id="pelham-cashiers">
            {recentCashiers().map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
          {cashierError ? <ErrorNote>{cashierError}</ErrorNote> : null}
        </>
      ) : null}

      {error && !missing ? <ErrorNote>{error}</ErrorNote> : null}

      {demo ? (
        <p className="bg-[#fff8e1] px-2 py-2 text-xs text-[#5b4708]">
          예시 데이터입니다. 서버에 연결되기 전까지는 계산서를 만들 수 없습니다.
        </p>
      ) : null}

      {bill && lines.length > 0 ? (
        <>
          <label className="flex min-h-11 items-center gap-2 text-sm">
            <input
              checked={autoPrint}
              className="h-5 w-5 accent-[#4533ff]"
              onChange={(event) => writeAutoPrint(event.target.checked)}
              type="checkbox"
            />
            Print receipt after charge
          </label>
          <TerminalSetup settings={terminalSettings} />
          <Button
            className="min-h-14 text-base"
            disabled={demo || charging || busy || !canCharge}
            full
            onClick={() => void charge()}
            tone="primary"
          >
            {charging
              ? "Charging…"
              : noCharge
                ? "Close bill — no charge"
                : canCharge
                  ? `Charge ${formatMoney(total)}`
                  : `Add payments — ${formatMoney(remaining)} left`}
          </Button>
        </>
      ) : null}
    </div>
  );
}

// ===== Sales 화면 (Lightspeed 모양) =====================================

/** 품목 찾기 옆의 색 버튼 — Lightspeed 계산대처럼 분류마다 한 색. 누르면 그 분류의 상품이 아래에 펼쳐진다. */
const QUICK_CATEGORIES: { category: RetailCategory; label: string; color: string }[] = [
  { category: "Rentals", label: "Carts", color: "bg-[#3c9a4a] hover:bg-[#33873f]" },
  { category: "Equipment", label: "Range", color: "bg-[#c0392b] hover:bg-[#a93226]" },
  { category: "Balls", label: "Balls", color: "bg-[#e67e22] hover:bg-[#cf711f]" },
  { category: "Accessories", label: "Accessories", color: "bg-[#8fb3d9] hover:bg-[#7aa3cf]" },
  { category: "Apparel", label: "Apparel", color: "bg-[#2b2b2b] hover:bg-[#111111]" },
  { category: "Food & Beverage", label: "Food & Beverage", color: "bg-[#0b4f8a] hover:bg-[#09406f]" },
];

function SalesLayout({
  bill,
  busy,
  cashierField,
  chargeButton,
  customer,
  demo,
  describeLine,
  error,
  paymentsEditor,
  station,
}: {
  bill: Bill | null;
  busy: boolean;
  cashierField: React.ReactNode;
  chargeButton: React.ReactNode;
  customer?: string;
  demo: boolean;
  describeLine?: (line: BillLine) => { title: string; detail?: string } | null;
  error: string;
  paymentsEditor: React.ReactNode;
  station: BillStation;
}) {
  const lines = bill?.lines ?? [];
  const [discountOpen, setDiscountOpen] = useState(false);
  const who = (customer ?? bill?.label ?? "").trim();

  return (
    <div className="flex h-full min-h-0 flex-col bg-white text-[13px] text-[#1f2328] md:flex-row">
      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* 손님 · 계산서 일 */}
        <div className="flex flex-wrap items-center gap-1.5 border-b border-[#d4d4d8] bg-[#e9edf2] px-3 py-2">
          <span className="border border-[#c7c7cc] bg-white px-3 py-1.5 text-[11px] font-bold tracking-wide uppercase">
            {who || "No customer"}
          </span>
          {bill ? (
            <>
              <button
                className="border border-[#c7c7cc] bg-white px-3 py-1.5 hover:bg-[#f2f2f5]"
                onClick={() => billActions.park()}
                title="Keep this bill open and start another"
                type="button"
              >
                Hold
              </button>
              <button
                className="border border-[#c7c7cc] bg-white px-3 py-1.5 text-[#8a1f1f] hover:bg-[#fff1ee]"
                onClick={() => {
                  if (window.confirm(`Void bill #${bill.id}? Nothing was charged.`)) void billActions.voidBill(bill.id);
                }}
                title="Throw this bill away. Nothing was charged."
                type="button"
              >
                Void
              </button>
              <span className="ml-auto text-[#6b7280]">
                Bill #{bill.id}
                {busy ? " · saving…" : ""}
              </span>
            </>
          ) : null}
        </div>

        <ItemFinder disabled={demo || !bill} station={station} />

        {/* 줄 표 */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b border-[#d4d4d8] text-[11px] tracking-wide text-[#4e5560] uppercase">
                <th className="w-12" />
                <th className="py-1.5 text-left font-normal">Description</th>
                <th className="w-20 py-1.5 text-right font-normal">Price</th>
                <th className="w-20 py-1.5 pl-3 text-left font-normal">Qty.</th>
                <th className="w-14 py-1.5 text-center font-normal">Tax</th>
                <th className="w-24 py-1.5 pr-3 text-right font-normal">Subtotal</th>
              </tr>
            </thead>
            <tbody>
              {lines.length === 0 ? (
                <tr>
                  <td className="px-3 py-6 text-center text-[#6b7280]" colSpan={6}>
                    {bill ? "Search for an item or tap a category to add it." : "No open bill."}
                  </td>
                </tr>
              ) : (
                lines.map((line) => (
                  <SalesLineRow
                    describe={describeLine?.(line) ?? null}
                    key={line.id}
                    line={line}
                    station={station}
                  />
                ))
              )}
            </tbody>
          </table>

          {bill && lines.length > 0 ? (
            <div className="flex flex-wrap items-start justify-end gap-1.5 border-t border-[#d4d4d8] px-3 py-2">
              {discountOpen ? (
                <div className="w-48">
                  <MoneyField
                    compact
                    initial={bill.discount}
                    key={`discount-${bill.id}-${bill.discount}`}
                    label="Bill discount"
                    onCommit={(cents) => billActions.update({ discount: cents }, station)}
                  />
                </div>
              ) : null}
              <button
                aria-pressed={discountOpen}
                className="border border-[#c7c7cc] bg-white px-3 py-1.5 hover:bg-[#f2f2f5]"
                onClick={() => setDiscountOpen((open) => !open)}
                type="button"
              >
                Apply Discount
              </button>
            </div>
          ) : null}
          {error ? (
            <div className="px-3 pb-3">
              <ErrorNote>{error}</ErrorNote>
            </div>
          ) : null}
        </div>
      </section>

      {/* 합계 · 결제 */}
      <aside className="grid w-full shrink-0 content-start gap-3 overflow-y-auto border-t border-[#d4d4d8] bg-white p-3 md:w-[320px] md:border-t-0 md:border-l">
        <dl className="grid gap-1.5 text-[12px]">
          <Row label="Subtotal" value={formatMoney(bill?.subtotal ?? 0)} />
          <Row label="Discounts" value={formatMoney(bill?.discount ?? 0)} />
          <Row label="HST" value={formatMoney(bill?.tax ?? 0)} />
          <div className="mt-1 flex items-baseline justify-between gap-2 border-t border-[#d4d4d8] pt-2">
            <dt className="text-base font-bold">Total</dt>
            <dd className="text-xl font-bold tabular-nums">{formatMoney(bill?.total ?? 0)}</dd>
          </div>
        </dl>
        {bill && lines.length > 0 ? (
          <>
            {paymentsEditor}
            {cashierField}
            {chargeButton}
          </>
        ) : null}
        {demo ? (
          <p className="bg-[#fff8e1] px-2 py-2 text-xs text-[#5b4708]">
            예시 데이터입니다. 서버에 연결되기 전까지는 계산서를 만들 수 없습니다.
          </p>
        ) : null}
      </aside>
    </div>
  );
}

function SalesLineRow({
  line,
  station,
  describe,
}: {
  line: BillLine;
  station: BillStation;
  describe: { title: string; detail?: string } | null;
}) {
  // 그린피·베이 줄은 예약 하나 = 한 줄. 수량을 바꿀 수 없다.
  const fixed = line.kind === "tee_player" || line.kind === "sim_booking";
  const [qty, setQty] = useState(String(line.quantity));
  const [qtyFor, setQtyFor] = useState(line.quantity);
  if (qtyFor !== line.quantity) {
    setQtyFor(line.quantity);
    setQty(String(line.quantity));
  }
  const commitQty = () => {
    const next = Number.parseInt(qty, 10);
    if (!Number.isFinite(next) || next < 0) {
      setQty(String(line.quantity));
      return;
    }
    if (next !== line.quantity) void billActions.setQuantity(line.id, next, station);
  };
  const title = describe?.title ?? line.name;
  const detail =
    describe?.detail ??
    (line.kind === "tee_player"
      ? `Tee Time: ${line.tee_date ?? ""} ${line.tee_time ?? ""}`.trim()
      : line.kind === "sim_booking"
        ? `Bay Sheet: ${line.tee_date ?? ""} ${line.tee_time ?? ""}`.trim()
        : line.sku);

  return (
    <tr className="border-b border-[#e4e4e8] align-middle">
      <td className="py-2 pl-3">
        <button
          aria-label={`Remove ${line.name}`}
          className="flex h-7 w-7 items-center justify-center border border-[#c7c7cc] bg-white text-[#6b7280] hover:border-[#c0262d] hover:text-[#c0262d]"
          onClick={() => void billActions.setQuantity(line.id, 0, station)}
          title="Remove this line"
          type="button"
        >
          <svg aria-hidden className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.4" viewBox="0 0 16 16">
            <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5M7 7v4M9 7v4" />
          </svg>
        </button>
      </td>
      <td className="min-w-0 py-2 pl-2">
        <span className="block text-[14px] leading-snug text-[#2a6ebb]">{title}</span>
        {detail ? <span className="block text-[13px] leading-snug text-[#2a6ebb]">{detail}</span> : null}
        {line.discount > 0 ? (
          <span className="block text-[11px] text-[#1f6b3a]">Discount −{formatMoney(line.discount)}</span>
        ) : null}
      </td>
      <td className="py-2 text-right text-[14px] tabular-nums">{formatMoney(line.unit_price)}</td>
      <td className="py-2 pl-3">
        <input
          aria-label={`Quantity of ${line.name}`}
          className="w-14 border border-[#c7c7cc] px-2 py-1.5 tabular-nums outline-none focus:border-[#4533ff] disabled:bg-[#f7f7f9]"
          disabled={fixed}
          inputMode="numeric"
          onBlur={commitQty}
          onChange={(event) => setQty(event.target.value.replace(/[^0-9]/g, ""))}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
          title={fixed ? "One player per line" : undefined}
          value={qty}
        />
      </td>
      <td className="py-2 text-center text-[14px]">Yes</td>
      <td className="py-2 pr-3 text-right text-[14px] tabular-nums">{formatMoney(line.line_total)}</td>
    </tr>
  );
}

/** Item 찾기 + 분류 버튼. 활성 상품만, 처음 열 때 한 번 읽는다. */
function ItemFinder({ station, disabled }: { station: BillStation; disabled: boolean }) {
  const [products, setProducts] = useState<Product[] | "error" | null>(null);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<RetailCategory | null>(null);

  useEffect(() => {
    let alive = true;
    retailApi
      .listProducts({ active: true })
      .then((list) => {
        if (alive) setProducts(list);
      })
      .catch(() => {
        if (alive) setProducts("error");
      });
    return () => {
      alive = false;
    };
  }, []);

  const needle = query.trim().toLowerCase();
  const list = Array.isArray(products) ? products : [];
  const shown = needle
    ? list.filter(
        (item) =>
          item.name.toLowerCase().includes(needle) ||
          item.sku.toLowerCase().includes(needle) ||
          (item.barcode ?? "").toLowerCase() === needle,
      )
    : category
      ? list.filter((item) => item.category === category)
      : [];
  const open = needle !== "" || category !== null;

  async function add(product: Product) {
    const added = await billActions.addProduct(product.id, station);
    if (added) setQuery("");
  }

  return (
    <div className="border-b border-[#d4d4d8] bg-[#e8f1dc] px-3 py-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <form
          className="flex"
          onSubmit={(event) => {
            event.preventDefault();
            if (shown.length === 1) void add(shown[0]);
          }}
        >
          <input
            aria-label="Search items by name, SKU or barcode"
            className="w-48 border border-[#c7c7cc] bg-white px-2 py-1.5 outline-none focus:border-[#4533ff]"
            disabled={disabled}
            onChange={(event) => {
              setQuery(event.target.value);
              setCategory(null);
            }}
            placeholder="Item"
            type="search"
            value={query}
          />
          <button
            className="border border-l-0 border-[#c7c7cc] bg-white px-3 py-1.5 hover:bg-[#f2f2f5] disabled:opacity-40"
            disabled={disabled}
            type="submit"
          >
            Search
          </button>
        </form>
        <span className="w-2" />
        {QUICK_CATEGORIES.map((item) => (
          <button
            aria-pressed={category === item.category}
            className={`px-3 py-1.5 text-white disabled:opacity-40 ${item.color} ${
              category === item.category ? "ring-2 ring-[#1f2328] ring-offset-1" : ""
            }`}
            disabled={disabled}
            key={item.category}
            onClick={() => {
              setQuery("");
              setCategory((current) => (current === item.category ? null : item.category));
            }}
            type="button"
          >
            {item.label}
          </button>
        ))}
      </div>
      {open ? (
        <div className="mt-2">
          {products === null ? (
            <p className="text-[#6b7280]">Loading items…</p>
          ) : products === "error" ? (
            <p className="text-[#8a1f1f]">Could not load items.</p>
          ) : shown.length === 0 ? (
            <p className="text-[#6b7280]">No items match.</p>
          ) : (
            <div className="grid max-h-48 grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-1.5 overflow-y-auto">
              {shown.map((product) => (
                <button
                  className="flex min-h-12 flex-col justify-between border border-[#c7c7cc] bg-white px-2 py-1 text-left hover:border-[#4533ff] disabled:opacity-40"
                  disabled={disabled || (product.stock !== null && product.stock <= 0)}
                  key={product.id}
                  onClick={() => void add(product)}
                  type="button"
                >
                  <span className="line-clamp-2 font-bold">{product.name}</span>
                  <span className="text-[#4e5560] tabular-nums">
                    {formatMoney(product.price)}
                    {product.stock !== null ? ` · ${product.stock} left` : ""}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

// ===== 머리: 열린 계산서 목록 ===========================================

function BillHeader({
  bill,
  openBills,
  busy,
  demo,
}: {
  bill: Bill | null;
  openBills: Bill[];
  busy: boolean;
  demo: boolean;
}) {
  // 빈 영수증(줄 0개)은 고를 이유가 없어 목록에서 뺀다.
  const others = openBills.filter((item) => item.id !== bill?.id && item.lines.length > 0);
  return (
    <div className="grid gap-2">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-bold">
          {bill ? `Bill #${bill.id}` : "New bill"}
          {busy ? <span className="ml-2 text-xs font-normal text-[#6b7280]">saving…</span> : null}
        </h2>
        {bill ? (
          <div className="flex gap-1.5">
            <Button className="min-h-9 px-2 text-xs" onClick={() => billActions.park()} title="Keep this bill open and start another">
              Hold
            </Button>
            <Button
              className="min-h-9 px-2 text-xs"
              onClick={() => void billActions.voidBill(bill.id)}
              title="Throw this bill away. Nothing was charged."
              tone="danger"
            >
              Void
            </Button>
          </div>
        ) : null}
      </div>
      {others.length > 0 && !demo ? (
        <Select
          aria-label="Switch to another open bill"
          className="min-h-14 text-xl font-semibold"
          onChange={(event) => {
            const id = Number(event.target.value);
            if (id) void billActions.select(id);
          }}
          value=""
        >
          <option value="">{`${others.length} other open bill${others.length === 1 ? "" : "s"} — switch…`}</option>
          {others.map((item) => (
            <option key={item.id} value={item.id}>
              {`#${item.id} · ${formatMoney(item.total)} · ${item.lines.length} line${item.lines.length === 1 ? "" : "s"}${
                item.label ? ` · ${item.label}` : ""
              }`}
            </option>
          ))}
        </Select>
      ) : null}
    </div>
  );
}

// ===== 줄 ==============================================================

function BillLineRow({ line, station }: { line: Bill["lines"][number]; station: BillStation }) {
  // 그린피·베이 줄은 예약 하나 = 한 줄. 수량을 바꿀 수 없다.
  const isTee = line.kind === "tee_player";
  const isSim = line.kind === "sim_booking";
  return (
    <li className="min-w-0 border border-[#e4e4e8] p-2">
      <div className="flex items-start justify-between gap-2">
        <span className="min-w-0">
          <span className="block text-sm leading-tight font-bold">{line.name}</span>
          <span className="block text-[11px] text-[#6b7280]">
            {isTee
              ? `Tee sheet · ${line.tee_date ?? ""}`
              : isSim
                ? `Bay Sheet · ${line.tee_date ?? ""}`
                : `${line.sku} · ${formatMoney(line.unit_price)} each`}
          </span>
        </span>
        <button
          aria-label={`Remove ${line.name}`}
          className="tap-target -mt-1 -mr-1 flex shrink-0 items-center justify-center text-lg leading-none text-[#8a1f1f]"
          onClick={() => void billActions.setQuantity(line.id, 0, station)}
          type="button"
        >
          <span aria-hidden>×</span>
        </button>
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        {isTee || isSim ? (
          <span className="text-xs text-[#6b7280]">{isTee ? "1 player" : "1 booking"}</span>
        ) : (
          <div className="flex items-center">
            <button
              aria-label={`Decrease ${line.name}`}
              className="tap-target flex items-center justify-center border border-[#d4d4d8] text-lg font-bold"
              onClick={() => void billActions.setQuantity(line.id, line.quantity - 1, station)}
              type="button"
            >
              <span aria-hidden>−</span>
            </button>
            <span className="min-w-11 px-1 text-center text-base font-bold tabular-nums">{line.quantity}</span>
            <button
              aria-label={`Increase ${line.name}`}
              className="tap-target flex items-center justify-center border border-[#d4d4d8] text-lg font-bold"
              onClick={() => void billActions.setQuantity(line.id, line.quantity + 1, station)}
              type="button"
            >
              <span aria-hidden>+</span>
            </button>
          </div>
        )}
        <span className="text-base font-bold tabular-nums">{formatMoney(line.line_total)}</span>
      </div>
      <MoneyField
        compact
        key={`d-${line.id}-${line.discount}`}
        initial={line.discount}
        label="Line discount"
        onCommit={(cents) => billActions.setLineDiscount(line.id, cents, station)}
      />
    </li>
  );
}

// ===== 결제 줄 ==========================================================

function PaymentsEditor({
  billId,
  initialMethod = "card",
  payments,
  remaining,
  onTerminalApproved,
  setPayments,
  takesTip,
  terminalSettings,
}: {
  billId: number;
  initialMethod?: PaymentMethod;
  payments: PendingPayment[];
  /** 리더가 승인해 결제 줄이 하나 더해졌을 때. */
  onTerminalApproved?: () => void;
  remaining: number;
  setPayments: (update: (current: PendingPayment[]) => PendingPayment[]) => void;
  /** F&B 가 담긴 계산서만 팁을 받는다(`billTakesTip`). */
  takesTip: boolean;
  terminalSettings: TerminalSettings;
}) {
  const [method, setMethod] = useState<PaymentMethod>(initialMethod);
  const [amountInput, setAmountInput] = useState("");
  const [authCode, setAuthCode] = useState("");
  const [last4, setLast4] = useState("");
  // 단말기 승인 문자를 받을 번호. 비우면 서버가 계산서에 담긴 예약의 번호로 보낸다(0028).
  const [receiptPhone, setReceiptPhone] = useState("");
  const [tipInput, setTipInput] = useState("");
  const [formError, setFormError] = useState("");
  const [preparing, setPreparing] = useState(false);
  const keyRef = useRef(1);
  // 레인체크: 친 코드와 서버에서 찾은 전표.
  const [rcCode, setRcCode] = useState("");
  const [rcFound, setRcFound] = useState<RainCheck | null>(null);
  const [rcLooking, setRcLooking] = useState(false);

  const isRainCheck = method === "rain_check";

  const lookUpRainCheck = useCallback(async (raw: string) => {
    const code = raw.trim().toUpperCase();
    setRcCode(code);
    setRcFound(null);
    setFormError("");
    if (!code) return;
    if (!isRainCheckCode(code)) {
      setFormError(`"${code}" is not a rain check code. It looks like RC-1A2B3C4D5E.`);
      return;
    }
    setRcLooking(true);
    try {
      setRcFound(await rainCheckApi.byCode(code));
    } catch (error) {
      setFormError(describeRainCheckError(error));
    } finally {
      setRcLooking(false);
    }
  }, []);

  // 계산대·티 시트에서 쏜 레인체크 전표. 수단을 레인체크로 바꾸고 바로 찾는다.
  useEffect(() => {
    const use = (code: string) => {
      setMethod("rain_check");
      setAmountInput("");
      setTipInput("");
      void lookUpRainCheck(code);
    };
    const waiting = takeRainCheckCode();
    if (waiting) use(waiting);
    return subscribeRainCheckCode(use);
  }, [lookUpRainCheck]);

  const rcUsable = rcFound !== null && rcFound.status === "issued" && !rcFound.expired;
  const rcProblem = !rcFound
    ? ""
    : rcFound.status === "redeemed"
      ? `Already used${rcFound.redeemed_receipt ? ` on bill ${rcFound.redeemed_receipt}` : ""}.`
      : rcFound.status === "void"
        ? `Voided${rcFound.void_reason ? ` — ${rcFound.void_reason}` : ""}.`
        : rcFound.expired
          ? `Expired on ${usDate(rcFound.expires_on)}.`
          : "";
  const rcApplied = rcFound && rcUsable ? Math.min(rcFound.amount, remaining) : 0;
  const rcLeftOver = rcFound && rcUsable ? rcFound.amount - rcApplied : 0;

  const needsTerminal = TERMINAL_METHODS.includes(method);
  // 단말기 연동: 금액을 단말기로 보낸다. 단말기가 꺼졌으면 "Enter manually" 로 예전처럼 친다.
  const [manual, setManual] = useState(false);
  const integrated = needsTerminal && terminalEnabled(terminalSettings) && !manual;
  const [terminalStatus, setTerminalStatus] = useState("");
  const [running, setRunning] = useState(false);
  // 리더에서 진행 중인 거래(취소·시험 버튼이 쓴다).
  const [inFlight, setInFlight] = useState<number | null>(null);
  const [testMode, setTestMode] = useState(false);
  useEffect(() => {
    if (!terminalEnabled(terminalSettings)) return;
    let alive = true;
    void terminalConfig().then((config) => {
      if (alive) setTestMode(config.environment === "test");
    });
    return () => {
      alive = false;
    };
  }, [terminalSettings]);
  const [removing, setRemoving] = useState<number | null>(null);
  // 팁은 계산서 합계 밖이다(매출이 아니라 직원 몫 — 마감에서 근무시간으로 나눈다).
  // 카드·체크카드는 단말기 전표의 팁을, 현금은 손님이 "잔돈은 두세요" 한 만큼을 적는다.
  const tip = takesTip && tipInput.trim() ? parseMoney(tipInput) : 0;
  const isCash = method === "cash";
  const typed = amountInput.trim() ? parseMoney(amountInput) : remaining + (isCash ? tip : 0);
  // 현금: 받은 돈에서 팁을 먼저 떼고 계산서에 넣는다. 남으면 거스름돈.
  const cashForBill = isCash ? Math.min(typed - tip, remaining) : typed;
  const change = isCash && typed - tip > remaining ? typed - tip - remaining : 0;

  async function add() {
    setFormError("");
    if (isRainCheck) {
      if (!rcFound || !rcUsable) {
        setFormError(rcProblem || "Scan the rain check, or type its code and press Enter.");
        return;
      }
      if (payments.some((payment) => payment.rain_check_code === rcFound.code)) {
        setFormError(`Rain check ${rcFound.code} is already on this bill.`);
        return;
      }
      // 화면의 합계가 낡았을 수 있다(다른 기기가 줄을 더했다). 들어갈 금액은 서버 합계로 다시 잡는다.
      setPreparing(true);
      const fresh = await billActions.reload();
      setPreparing(false);
      if (!fresh) return;
      const freshRemaining = Math.max(fresh.total - payments.reduce((sum, p) => sum + p.amount, 0), 0);
      const applied = Math.min(rcFound.amount, freshRemaining);
      if (applied <= 0) {
        setFormError("Nothing is left to pay on this bill.");
        return;
      }
      const key = keyRef.current++;
      setPayments((current) => [
        ...current,
        { key, method: "rain_check", amount: applied, rain_check_code: rcFound.code },
      ]);
      setRcCode("");
      setRcFound(null);
      return;
    }
    if (needsTerminal) {
      // 단말기에 칠 금액은 서버의 합계다. 더하기 직전에 다시 읽는다.
      setPreparing(true);
      const fresh = await billActions.reload();
      setPreparing(false);
      if (!fresh) return;
      const freshRemaining = Math.max(fresh.total - payments.reduce((sum, p) => sum + p.amount, 0), 0);
      if (typed > freshRemaining) {
        setFormError(`Only ${formatMoney(freshRemaining)} is left on the bill. Check the amount on the terminal.`);
        return;
      }
      if (integrated) {
        if (typed <= 0) {
          setFormError("Enter an amount above $0.00.");
          return;
        }
        setRunning(true);
        setTerminalStatus("Sending to the reader…");
        try {
          const record = await terminal.sale(terminalSettings, billId, typed, {
            onStatus: setTerminalStatus,
            onStarted: (started) => setInFlight(started.id),
            receiptPhone,
          });
          if (!record.approved) {
            setFormError(describeTerminalResult(record));
            return;
          }
          const key = keyRef.current++;
          setPayments((current) => [...current, fromTerminal(key, record)]);
          setAmountInput("");
          setReceiptPhone("");
          onTerminalApproved?.();
        } catch (error) {
          setFormError(terminalErrorText(error));
        } finally {
          setRunning(false);
          setInFlight(null);
          setTerminalStatus("");
        }
        return;
      }
      if (!authCode.trim()) {
        setFormError("Enter the approval code printed by the card terminal.");
        return;
      }
      if (last4 && !/^\d{4}$/.test(last4)) {
        setFormError("Last 4 must be four digits.");
        return;
      }
    }
    if (tip < 0) {
      setFormError("Tip cannot be negative.");
      return;
    }
    if (typed <= 0) {
      setFormError("Enter an amount above $0.00.");
      return;
    }
    if (isCash && cashForBill <= 0) {
      setFormError("The cash received does not cover the tip.");
      return;
    }
    // 현금은 받은 돈이 남은 금액보다 많아도 된다(거스름돈). 계산서에는 남은 금액만큼만 들어간다.
    const applied = cashForBill;
    if (applied > remaining) {
      setFormError(`Only ${formatMoney(remaining)} is left on the bill.`);
      return;
    }
    const key = keyRef.current++;
    setPayments((current) => [
      ...current,
      {
        key,
        method,
        amount: applied,
        ...(tip > 0 ? { tip } : {}),
        ...(method === "cash" ? { cashReceived: typed } : {}),
        ...(needsTerminal ? { auth_code: authCode.trim(), ...(last4 ? { card_last4: last4 } : {}) } : {}),
      },
    ]);
    setAmountInput("");
    setAuthCode("");
    setLast4("");
    setTipInput("");
  }

  /**
   * 결제 줄 지우기. 단말기가 승인한 줄은 돈이 이미 나갔으니 먼저 돌려준다:
   * 신용카드는 Stripe 환불(카드 필요 없음), Interac 은 리더에서 환불(손님이 카드를 다시 댄다).
   */
  async function removePayment(payment: PendingPayment) {
    const record = payment.terminalRecord;
    if (!record) {
      setPayments((current) => current.filter((item) => item.key !== payment.key));
      return;
    }
    const debit = record.card_type === "debit";
    const amount = record.requested_amount + record.tip;
    const ok = window.confirm(
      debit
        ? `Refund ${formatMoney(amount)} to the customer's Interac card? They will tap the card on the reader again.`
        : `Refund the ${formatMoney(amount)} card payment? The card is not needed.`,
    );
    if (!ok) return;
    setFormError("");
    setRemoving(payment.key);
    setTerminalStatus(debit ? "Tap the card on the reader for the refund…" : "Refunding…");
    try {
      const result = await terminal.refund(terminalSettings, billId, record, {
        onStatus: setTerminalStatus,
        onStarted: (started) => setInFlight(started.pending ? started.id : null),
      });
      if (!result.approved) {
        setFormError(`Refund did not go through: ${describeTerminalResult(result)}`);
        return;
      }
      setPayments((current) => current.filter((item) => item.key !== payment.key));
    } catch (error) {
      setFormError(terminalErrorText(error));
    } finally {
      setRemoving(null);
      setInFlight(null);
      setTerminalStatus("");
    }
  }

  // 리더에서 진행 중인 거래(판매·Interac 환불). 남은 금액이 0 이어도 보여야 한다(결제 줄 삭제 중).
  const terminalBox =
    running || (removing !== null && terminalStatus) ? (
    <div className="flex items-center justify-between gap-2 border border-[#4533ff] bg-white p-2 text-sm">
      <span className="font-bold">{terminalStatus || "Waiting for the terminal…"}</span>
      <span className="flex shrink-0 flex-wrap justify-end gap-1">
        {testMode && inFlight !== null ? (
          <>
            <Button className="min-h-9 px-2 text-xs" onClick={() => void terminal.simulate(inFlight).catch(() => undefined)}>
              Simulate card tap
            </Button>
            <Button
              className="min-h-9 px-2 text-xs"
              onClick={() => void terminal.simulate(inFlight, true).catch(() => undefined)}
            >
              Simulate Interac
            </Button>
          </>
        ) : null}
        {running && inFlight !== null ? (
          <Button
            className="min-h-9 px-2 text-xs"
            onClick={() => void terminal.cancel(inFlight).catch(() => undefined)}
            tone="danger"
          >
            Cancel
          </Button>
        ) : null}
      </span>
    </div>
  ) : null;

  return (
    <div className="grid gap-2 border-t border-[#d4d4d8] pt-2">
      <h3 className="text-xs font-bold tracking-wide text-[#6b7280] uppercase">Payments</h3>
      {payments.length > 0 ? (
        <ul className="grid gap-1 text-sm">
          {payments.map((payment) => (
            <li className="flex items-baseline justify-between gap-2" key={payment.key}>
              <span className="min-w-0">
                {PAYMENT_LABELS[payment.method]}
                {payment.rain_check_code ? (
                  <span className="block text-[11px] text-[#6b7280]">{payment.rain_check_code}</span>
                ) : null}
                {payment.auth_code ? (
                  <span className="block text-[11px] text-[#6b7280]">
                    {payment.terminalRecord?.card_brand ? `${payment.terminalRecord.card_brand} · ` : ""}
                    Approval {payment.auth_code}
                    {payment.card_last4 ? ` · ****${payment.card_last4}` : ""}
                    {payment.terminalRecord ? " · from terminal" : ""}
                  </span>
                ) : null}
                {payment.tip ? (
                  <span className="block text-[11px] text-[#6b7280]">+ tip {formatMoney(payment.tip)}</span>
                ) : null}
                {payment.cashReceived && payment.cashReceived > payment.amount + (payment.tip ?? 0) ? (
                  <span className="block text-[11px] font-bold text-[#1f6b3a]">
                    Change {formatMoney(payment.cashReceived - payment.amount - (payment.tip ?? 0))}
                  </span>
                ) : null}
              </span>
              <span className="flex shrink-0 items-center gap-2 tabular-nums">
                {formatMoney(payment.amount)}
                <button
                  aria-label={`Remove ${PAYMENT_LABELS[payment.method]} payment`}
                  className="text-[#8a1f1f] disabled:opacity-40"
                  disabled={running || removing !== null}
                  onClick={() => void removePayment(payment)}
                  type="button"
                >
                  {removing === payment.key ? "…" : "×"}
                </button>
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {remaining > 0 ? (
        <div className="grid gap-2 bg-[#f6f6f8] p-2">
          <p className="text-sm font-bold">Left to pay: {formatMoney(remaining)}</p>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Method">
              <Select
                onChange={(event) => {
                  setMethod(event.target.value as PaymentMethod);
                  setFormError("");
                }}
                value={method}
              >
                {PAYMENT_METHODS.map((item) => (
                  <option key={item} value={item}>
                    {PAYMENT_LABELS[item]}
                  </option>
                ))}
              </Select>
            </Field>
            {isRainCheck ? (
              <Field label="Rain check code">
                <TextInput
                  autoComplete="off"
                  onBlur={(event) => {
                    const typed = event.target.value.trim().toUpperCase();
                    if (typed && typed !== (rcFound?.code ?? "")) void lookUpRainCheck(typed);
                  }}
                  onChange={(event) => {
                    setRcCode(event.target.value);
                    setRcFound(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void lookUpRainCheck(event.currentTarget.value);
                    }
                  }}
                  placeholder="Scan the slip"
                  value={rcCode}
                />
              </Field>
            ) : (
              <Field label={method === "cash" ? "Cash received" : "Amount"}>
                <TextInput
                  inputMode="decimal"
                  onChange={(event) => setAmountInput(event.target.value)}
                  placeholder={((remaining + (isCash ? tip : 0)) / 100).toFixed(2)}
                  value={amountInput}
                />
              </Field>
            )}
          </div>
          {isRainCheck && rcLooking ? <p className="text-xs text-[#6b7280]">Looking up the rain check…</p> : null}
          {isRainCheck && rcFound ? (
            <div
              className={`grid gap-0.5 border p-2 text-xs ${
                rcUsable ? "border-[#1f6b3a] bg-white" : "border-[#8a1f1f] bg-[#fff1ee] text-[#8a1f1f]"
              }`}
            >
              <p className="font-bold">
                {rcFound.code} · {rcFound.player_name}
              </p>
              <p>
                Credit {formatMoney(rcFound.amount)} · valid through {usDate(rcFound.expires_on)}
              </p>
              {rcProblem ? <p className="font-bold">{rcProblem}</p> : null}
              {rcUsable && rcLeftOver > 0 ? (
                <p className="font-bold text-[#5b4708]">
                  This bill uses {formatMoney(rcApplied)}. The other {formatMoney(rcLeftOver)} of credit is lost — a
                  rain check is one use. Add more to the bill first if the guest wants to use it all.
                </p>
              ) : null}
            </div>
          ) : null}
          {integrated ? (
            <div className="grid gap-1 text-xs">
              <p className="text-[#5b4708]">
                {testMode ? "Stripe test mode — no card is charged. " : ""}
                <b>{formatMoney(typed)}</b> goes to {terminalSettings.readerLabel || "the card reader"}. The customer
                taps, inserts or swipes there; {takesTip ? "tip (on food & drink only) and " : ""}approval come
                back here.
              </p>
              <Field hint="Leave blank to use the phone on the booking" label="Text the approval to (optional)">
                <TextInput
                  autoComplete="off"
                  inputMode="tel"
                  onChange={(event) => setReceiptPhone(event.target.value)}
                  placeholder="905-555-0101"
                  value={receiptPhone}
                />
              </Field>
              <button className="justify-self-start text-[#4533ff] underline" onClick={() => setManual(true)} type="button">
                Terminal not working? Enter the approval code by hand
              </button>
            </div>
          ) : null}
          {terminalBox}
          {needsTerminal && !integrated ? (
            <>
              {manual ? (
                <button className="justify-self-start text-xs text-[#4533ff] underline" onClick={() => setManual(false)} type="button">
                  Use the terminal link again
                </button>
              ) : null}
              <p className="text-xs text-[#5b4708]">
                Key <b>{formatMoney(typed)}</b> on the card terminal. When it approves, copy the approval code from the
                slip.
              </p>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Approval code">
                  <TextInput
                    autoComplete="off"
                    onChange={(event) => setAuthCode(event.target.value)}
                    placeholder="e.g. 083412"
                    value={authCode}
                  />
                </Field>
                <Field label="Card last 4 (optional)">
                  <TextInput
                    autoComplete="off"
                    inputMode="numeric"
                    maxLength={4}
                    onChange={(event) => setLast4(event.target.value.replace(/\D/g, ""))}
                    placeholder="4242"
                    value={last4}
                  />
                </Field>
              </div>
            </>
          ) : null}
          {isRainCheck || integrated || !takesTip ? null : (
            <Field
              hint={needsTerminal ? "From the terminal slip" : isCash ? "Only if they leave it as a tip" : undefined}
              label="Tip (optional)"
            >
              <TextInput
                inputMode="decimal"
                onChange={(event) => setTipInput(event.target.value)}
                placeholder="0.00"
                value={tipInput}
              />
            </Field>
          )}
          {change > 0 ? (
            <p className="text-sm font-bold text-[#1f6b3a]">Change due: {formatMoney(change)}</p>
          ) : null}
          {formError ? <ErrorNote>{formError}</ErrorNote> : null}
          <Button
            disabled={preparing || running || removing !== null || (isRainCheck && (rcLooking || !rcUsable))}
            full
            onClick={() => void add()}
            tone={integrated ? "primary" : undefined}
          >
            {preparing
              ? "Checking total…"
              : running
                ? "On the terminal…"
                : isRainCheck && rcUsable
                  ? `Add rain check ${formatMoney(rcApplied)}`
                  : integrated
                    ? `Send ${formatMoney(typed)} to terminal`
                    : `Add ${PAYMENT_LABELS[method]} payment`}
          </Button>
        </div>
      ) : (
        <>
          {terminalBox ?? (terminalStatus ? <p className="text-sm font-bold">{terminalStatus}</p> : null)}
          {formError ? <ErrorNote>{formError}</ErrorNote> : null}
        </>
      )}
    </div>
  );
}

// ===== 단말기 설정 (이 기기에만) =======================================

const TERMINAL_MODE_LABELS: Record<TerminalMode, string> = {
  off: "Off — key amounts on the terminal by hand",
  live: "Linked — send amounts to a Stripe card reader",
};

function TerminalSetup({ settings }: { settings: TerminalSettings }) {
  const [readers, setReaders] = useState<Reader[] | null>(null);
  const [environment, setEnvironment] = useState<"test" | "live" | null>(null);
  const [code, setCode] = useState("");
  const [message, setMessage] = useState("");
  const [working, setWorking] = useState(false);

  async function load() {
    setWorking(true);
    setMessage("");
    try {
      const found = await terminal.readers();
      setReaders(found.readers);
      setEnvironment(found.environment);
    } catch (error) {
      // 목록을 못 받았어도 "Loading readers…" 에 멈춰 있지 않게 한다. 오류는 아래 줄에 보인다.
      setReaders((current) => current ?? []);
      setMessage(terminalErrorText(error));
    } finally {
      setWorking(false);
    }
  }

  async function test() {
    setWorking(true);
    setMessage("");
    try {
      setMessage(await terminal.test(settings));
    } catch (error) {
      setMessage(terminalErrorText(error));
    } finally {
      setWorking(false);
    }
  }

  /** 리더 등록. 진짜 리더는 리더 화면의 등록 코드, 테스트 모드에서는 가상 리더(simulated-s700). */
  async function register(registrationCode: string, label: string) {
    setWorking(true);
    setMessage("");
    try {
      const reader = await terminal.register(registrationCode, label);
      writeTerminalSettings({ ...settings, mode: "live", readerId: reader.id, readerLabel: reader.label });
      setCode("");
      setMessage(`Registered ${reader.label}. This register now sends card payments to it.`);
      await load();
    } catch (error) {
      setMessage(terminalErrorText(error));
    } finally {
      setWorking(false);
    }
  }

  return (
    <details
      className="border border-[#e4e4e8] p-2 text-sm"
      onToggle={(event) => {
        if ((event.currentTarget as HTMLDetailsElement).open && settings.mode === "live" && readers === null) {
          void load();
        }
      }}
    >
      <summary className="cursor-pointer font-bold">
        Card terminal: {settings.mode === "off" ? "not linked" : settings.readerLabel || "linked"}
      </summary>
      <div className="mt-2 grid gap-2">
        <Field hint="Each register computer has its own setting" label="Mode">
          <Select
            onChange={(event) => {
              const mode = event.target.value as TerminalMode;
              writeTerminalSettings({ ...settings, mode });
              if (mode === "live" && readers === null) void load();
            }}
            value={settings.mode}
          >
            {(Object.keys(TERMINAL_MODE_LABELS) as TerminalMode[]).map((mode) => (
              <option key={mode} value={mode}>
                {TERMINAL_MODE_LABELS[mode]}
              </option>
            ))}
          </Select>
        </Field>
        {settings.mode === "live" ? (
          <>
            {environment === "test" ? (
              <p className="text-xs font-bold text-[#5b4708]">Stripe test mode — no real cards are charged.</p>
            ) : null}
            <Field hint="Readers registered to the club's Stripe account" label="Card reader">
              <Select
                onChange={(event) => {
                  const reader = readers?.find((item) => item.id === event.target.value);
                  writeTerminalSettings({
                    ...settings,
                    readerId: reader?.id ?? "",
                    readerLabel: reader?.label ?? "",
                  });
                }}
                value={settings.readerId}
              >
                <option value="">{readers === null ? "Loading readers…" : "Pick a reader"}</option>
                {settings.readerId && !readers?.some((item) => item.id === settings.readerId) ? (
                  <option value={settings.readerId}>{settings.readerLabel || settings.readerId}</option>
                ) : null}
                {(readers ?? []).map((reader) => (
                  <option key={reader.id} value={reader.id}>
                    {reader.label} · {reader.status ?? "unknown"}
                    {reader.simulated ? " · simulated" : ""}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button className="min-h-9 px-2 text-xs" disabled={working || !settings.readerId} onClick={() => void test()}>
                {working ? "Checking…" : "Test connection"}
              </Button>
              <Button className="min-h-9 px-2 text-xs" disabled={working} onClick={() => void load()}>
                Refresh list
              </Button>
              {environment === "test" ? (
                <Button
                  className="min-h-9 px-2 text-xs"
                  disabled={working}
                  onClick={() => void register("simulated-s700", "Simulated S700")}
                >
                  Add a simulated reader
                </Button>
              ) : null}
            </div>
            <Field hint="Shown on a new reader's screen during setup" label="Register a new reader">
              <div className="flex gap-2">
                <TextInput
                  autoComplete="off"
                  onChange={(event) => setCode(event.target.value)}
                  placeholder="e.g. sepia-cerulean-aardvark"
                  value={code}
                />
                <Button
                  className="min-h-9 shrink-0 px-2 text-xs"
                  disabled={working || code.trim().length < 3}
                  onClick={() => void register(code.trim(), "Pro shop")}
                >
                  Register
                </Button>
              </div>
            </Field>
          </>
        ) : null}
        {message ? <p className="text-xs wrap-anywhere">{message}</p> : null}
      </div>
    </details>
  );
}

// ===== 작은 입력 ========================================================

/** 달러 입력칸. 치는 동안에는 문자열로 두고, 칸을 떠날 때 한 번만 서버에 보낸다. */
function MoneyField({
  initial,
  label,
  onCommit,
  compact = false,
}: {
  initial: number;
  label: string;
  onCommit: (cents: number) => void;
  compact?: boolean;
}) {
  const [value, setValue] = useState(initial > 0 ? (initial / 100).toFixed(2) : "");
  const commit = () => {
    const cents = value.trim() ? parseMoney(value) : 0;
    if (cents !== initial) onCommit(Math.max(cents, 0));
  };
  const input = (
    <TextInput
      aria-label={label}
      className={compact ? "min-h-11 flex-1" : undefined}
      inputMode="decimal"
      onBlur={commit}
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") commit();
      }}
      placeholder="0.00"
      value={value}
    />
  );
  if (compact) {
    return (
      <label className="mt-2 flex items-center gap-2 text-xs">
        <span className="shrink-0 font-bold text-[#6b7280]">{label}</span>
        {input}
      </label>
    );
  }
  return <Field label={label}>{input}</Field>;
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-[#6b7280]">{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}

// ===== 결제 끝 ==========================================================

/** 결제가 끝나면 "결제 완료" 와 영수증을 뽑을지만 묻는다. 어느 쪽을 골라도 새 계산서로 간다. */
function PaidReceipt({ sale, onDone }: { sale: Sale; onDone: () => void }) {
  const card = (sale.payments ?? []).find((payment) => payment.card_last4);
  return (
    <div className="grid gap-4 p-3 text-center">
      <div className="grid gap-1 py-4">
        <p className="text-3xl leading-none text-[#1f6b3a]" aria-hidden>
          ✓
        </p>
        <p className="text-xl font-bold">Payment complete</p>
        <p className="text-2xl font-bold tabular-nums">{formatMoney(sale.total)}</p>
        <p className="text-xs text-[#6b7280]">
          {sale.receipt_no}
          {card ? ` · ${PAYMENT_LABELS[card.method]} ••••${card.card_last4}` : ""}
        </p>
      </div>
      <p className="text-base font-bold">Print a receipt?</p>
      <div className="grid grid-cols-2 gap-2">
        <Button className="min-h-14 text-base" full onClick={onDone}>
          No
        </Button>
        <Button
          className="min-h-14 text-base"
          full
          onClick={() => {
            printReceipt(sale);
            onDone();
          }}
          tone="primary"
        >
          Print
        </Button>
      </div>
    </div>
  );
}
