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
 *
 * 현금은 받은 돈을 적으면 거스름돈을 보여 주고, 서버에는 **계산서에 들어간 몫**만 보낸다
 * (서버는 결제 합이 합계와 정확히 같아야 받는다).
 *
 * 레인체크(0011)는 전표 바코드를 쏘거나 코드를 쳐서 찾는다. 크레딧과 남은 금액 중 작은 쪽이
 * 들어가고, 쓰고 남는 크레딧은 사라진다(화면이 미리 알린다). 만료·사용 여부는 서버가 결제할 때 다시 본다.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { newCheckoutId, TERMINAL_METHODS, type Bill, type BillStation, type PaymentInput } from "@/lib/pos/api";
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
import { PAYMENT_METHODS, formatMoney, parseMoney, type PaymentMethod, type Sale } from "@/lib/retail/types";

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
};

export default function BillPanel({ station, demo = false, onPaid, revealPayments = 0 }: Props) {
  const current = useCurrentBill();
  const { bill, openBills, busy, error, missing } = current;
  const autoPrint = useSyncExternalStore(subscribeAutoPrint, readAutoPrint, () => false);
  const terminalSettings = useTerminalSettings();
  const useTerminal = terminalEnabled(terminalSettings);

  const [receipt, setReceipt] = useState<Sale | null>(null);
  const [payments, setPayments] = useState<PendingPayment[]>([]);
  const [charging, setCharging] = useState(false);

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

  async function charge() {
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
    // 인쇄는 다음 틱으로. `window.print()` 가 스크립트를 멈추면 비워진 화면이 인쇄 뒤에야 그려진다.
    if (autoPrint) window.setTimeout(() => printReceipt(paid), 0);
  }

  if (receipt) {
    return <PaidReceipt onDone={() => setReceipt(null)} sale={receipt} />;
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
              payments={payments}
              remaining={remaining}
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
  const others = openBills.filter((item) => item.id !== bill?.id);
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
  payments,
  remaining,
  setPayments,
  terminalSettings,
}: {
  billId: number;
  payments: PendingPayment[];
  remaining: number;
  setPayments: (update: (current: PendingPayment[]) => PendingPayment[]) => void;
  terminalSettings: TerminalSettings;
}) {
  const [method, setMethod] = useState<PaymentMethod>("card");
  const [amountInput, setAmountInput] = useState("");
  const [authCode, setAuthCode] = useState("");
  const [last4, setLast4] = useState("");
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
  const tip = tipInput.trim() ? parseMoney(tipInput) : 0;
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
          });
          if (!record.approved) {
            setFormError(describeTerminalResult(record));
            return;
          }
          const key = keyRef.current++;
          setPayments((current) => [...current, fromTerminal(key, record)]);
          setAmountInput("");
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
                taps, inserts or swipes there; tip and approval come back here.
              </p>
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
          {isRainCheck || integrated ? null : (
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

function PaidReceipt({ sale, onDone }: { sale: Sale; onDone: () => void }) {
  const methods = useMemo(
    () =>
      (sale.payments ?? []).map((payment, index) => (
        <li className="flex items-baseline justify-between gap-2" key={index}>
          <span>
            {PAYMENT_LABELS[payment.method]}
            {payment.auth_code ? <span className="text-[11px] text-[#6b7280]"> · {payment.auth_code}</span> : null}
            {payment.rain_check_code ? (
              <span className="text-[11px] text-[#6b7280]"> · {payment.rain_check_code}</span>
            ) : null}
          </span>
          <span className="tabular-nums">{formatMoney(payment.amount)}</span>
        </li>
      )),
    [sale.payments],
  );
  return (
    <div className="grid gap-3 p-3">
      <div>
        <p className="text-xs font-bold tracking-wide text-[#6b7280] uppercase">Paid</p>
        <p className="text-lg font-bold">{sale.receipt_no}</p>
        <p className="text-xs text-[#6b7280]">
          {sale.business_date}
          {sale.cashier ? ` · ${sale.cashier}` : ""}
        </p>
      </div>
      <ul className="grid gap-1 border-y border-[#d4d4d8] py-2 text-sm">
        {sale.lines.map((line, index) => (
          <li className="flex items-baseline justify-between gap-2" key={line.id ?? index}>
            <span className="min-w-0 truncate">
              {line.quantity}× {line.name}
            </span>
            <span className="shrink-0 tabular-nums">{formatMoney(line.line_total)}</span>
          </li>
        ))}
      </ul>
      <dl className="grid gap-1 text-sm">
        <Row label="Subtotal" value={formatMoney(sale.subtotal)} />
        {sale.discount > 0 ? <Row label="Discount" value={`−${formatMoney(sale.discount)}`} /> : null}
        <Row label="HST" value={formatMoney(sale.tax)} />
        <div className="flex items-baseline justify-between gap-2 border-t border-[#d4d4d8] pt-1.5">
          <dt className="font-bold">Total</dt>
          <dd className="text-xl font-bold tabular-nums">{formatMoney(sale.total)}</dd>
        </div>
      </dl>
      <ul className="grid gap-1 text-sm">{methods}</ul>
      <Button className="min-h-12" full onClick={() => printReceipt(sale)}>
        Print receipt
      </Button>
      <Button className="min-h-14 text-base" full onClick={onDone} tone="primary">
        New bill
      </Button>
    </div>
  );
}
