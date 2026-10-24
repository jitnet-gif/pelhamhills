"use client";

/**
 * Stripe check 의 한 줄 상세 — 무슨 일이 있었는지 보여 주고, 이 카드 돈을 매출로 반영할지 정한다(0089).
 *
 * 고를 수 있는 것(줄의 상태에 따라 되는 것만 연다):
 *   Count as sale  — 단말기 승인을 그 계산서의 카드 결제로 붙이고 계산서를 끝낸다. void 계산서는 되살린다.
 *                    계산서 합계 ≠ 카드 금액이면 여기서 못 끝낸다 — 계산대에서 그 계산서를 열게 한다.
 *   Not a sale     — 카드에 돌려준다(기존 단말기 환불, 0021·0024). Interac 은 리더에 카드를 다시 대야 해서
 *                    이 기기에 리더가 골라져 있어야 한다.
 *   Leave as is    — 돈은 그대로, 이유만 남긴다(예: 현금으로 돌려줬다). 줄은 Reviewed 가 된다.
 * 매출 반영·그대로 둠은 Pelham Shift ID 승인을 받는다(ManagerApprovalHost 가 창을 띄운다).
 */

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";

import { terminal, useTerminalSettings } from "@/lib/pos/terminal";
import { retailApi } from "@/lib/retail/api";
import { PAYMENT_LABELS } from "@/lib/retail/receipt";
import { formatMoney, type Sale } from "@/lib/retail/types";
import {
  cardText,
  clubTime,
  DECISION_LABEL,
  keepAsSale,
  LEVEL_LABEL,
  recordDecision,
  rowDifference,
  SOURCE_LABEL,
  stripeUrl,
  type ReconcileRow,
} from "@/lib/reports/stripeReconcile";

import StaffName from "@/components/reports/StaffName";
import { Button, ErrorNote, Modal, SkeletonRows, TextArea } from "@/components/retail/ui";

type Choice = "sale" | "refund" | "note";

const LEVEL_TONE = {
  error: "border-[#e2a5a5] bg-[#fdecec] text-[#8a1f1f]",
  warn: "border-[#e8c873] bg-[#fff6e0] text-[#7a5200]",
  ok: "border-[#a8d5b5] bg-[#ecf7ef] text-[#1d6b34]",
} as const;

// 문제 코드 → 직원이 읽는 설명. 서버 메시지(issue.message)는 무엇이 어긋났는지, 여기는 왜 그런지와 무엇을 고를지.
const EXPLAIN: Record<string, string> = {
  not_on_bill:
    "The guest's card was charged on the reader, but the payment never landed on a bill — usually the bill was voided " +
    "or the screen closed before Charge. The money is in Stripe but not in our sales.",
  bill_open:
    "The guest's card was charged, but the bill was never finished. The money is in Stripe but not in our sales yet.",
  bill_refunded_card_not:
    "The bill was refunded at the register, but the card refund never went through. Our sales show the refund; " +
    "the guest still has the charge on their card.",
  card_refunded_bill_paid: "The card was refunded in Stripe, but the bill here still shows paid.",
  stripe_only: "Stripe took this money but we have no record of it.",
  not_recorded: "Stripe took this money but our record says it did not go through.",
  ours_only: "We recorded this as paid, but Stripe did not take the money.",
  amount: "Stripe and our record have different amounts.",
  refund_stripe_only: "Stripe refunded more than our records show — maybe refunded straight from the Stripe dashboard.",
  refund_ours_only: "Our records show a refund that Stripe did not make.",
  refund_pending: "A refund on the reader has not finished.",
  bill_line: "The bill's payment line and the card charge are different amounts.",
  disputed: "The guest disputed this charge with their bank. Answer it in Stripe.",
  orphaned: "Paid online, but the booking could not be made. The guest must be refunded.",
};

export default function ReconcileDetail({
  row,
  environment,
  onClose,
  onChanged,
}: {
  row: ReconcileRow;
  environment: "test" | "live";
  onClose: () => void;
  /** 돈이나 장부를 바꿨다 — 대사를 다시 읽는다. */
  onChanged: () => void;
}) {
  const ours = row.ours;
  const stripe = row.stripe;
  const [bill, setBill] = useState<{ id: number; sale: Sale | null; error: string } | null>(null);
  const billId = ours?.bill_id ?? null;

  useEffect(() => {
    if (billId === null) return;
    let cancelled = false;
    retailApi
      .getSale(billId)
      .then((sale) => !cancelled && setBill({ id: billId, sale, error: "" }))
      .catch((cause: unknown) => {
        if (!cancelled) setBill({ id: billId, sale: null, error: cause instanceof Error ? cause.message : "Could not load the bill." });
      });
    return () => {
      cancelled = true;
    };
    // 결정 뒤 대사를 다시 읽으면 row 가 새 값으로 온다 — 계산서도 다시 읽는다.
  }, [billId, row]);

  const loadedBill = bill && bill.id === billId ? bill : null;
  const net = stripe ? stripe.amount - stripe.refunded : 0;
  const title = [SOURCE_LABEL[row.source], cardText(row), clubTime(row.at)].filter(Boolean).join(" · ");

  return (
    <Modal onClose={onClose} title={title || "Card payment"} wide>
      <div className="grid gap-4 text-sm">
        <section className={`grid gap-1 border px-3 py-2 ${LEVEL_TONE[row.level]}`}>
          <p className="font-bold">
            {row.reviewed ? "Reviewed" : LEVEL_LABEL[row.level]}
            {stripe ? ` · ${formatMoney(net)} on the card in Stripe` : ""}
          </p>
          {row.issues.length ? (
            row.issues.map((issue) => (
              <p key={issue.code}>
                {issue.message}
                {EXPLAIN[issue.code] ? <span className="block text-xs opacity-80">{EXPLAIN[issue.code]}</span> : null}
              </p>
            ))
          ) : (
            <p>Stripe and our record agree.</p>
          )}
        </section>

        {row.decision ? (
          <p className="border border-[#c7c2ff] bg-[#f3f2ff] px-3 py-2 text-[#2e2499]">
            <b>{DECISION_LABEL[row.decision.decision]}</b>
            {row.decision.staff_name ? ` by ${row.decision.staff_name}` : ""} · {clubTime(row.decision.created_at)}
            {row.decision.note ? <span className="block">“{row.decision.note}”</span> : null}
          </p>
        ) : null}

        <div className="grid gap-3 md:grid-cols-2">
          <Facts title="Stripe">
            {stripe ? (
              <>
                <Fact label="Payment">
                  <a
                    className="break-all text-[#4533ff] underline"
                    href={stripeUrl(environment, stripe.payment_intent)}
                    rel="noreferrer"
                    target="_blank"
                  >
                    {stripe.payment_intent}
                  </a>
                </Fact>
                <Fact label="Status">{stripe.status}</Fact>
                <Fact label="Charged">{formatMoney(stripe.amount)}</Fact>
                <Fact label="Refunded">{stripe.refunded ? formatMoney(stripe.refunded) : "—"}</Fact>
                <Fact label="Card">
                  {cardText(row) || "—"}
                  {stripe.method === "interac_present" ? " (Interac debit)" : ""}
                </Fact>
                {stripe.disputed ? <Fact label="Dispute">Disputed by the guest</Fact> : null}
              </>
            ) : (
              <p className="text-[#8a1f1f]">Not in Stripe.</p>
            )}
          </Facts>

          <Facts title="Our record">
            {ours ? (
              <>
                <Fact label="Record">{ours.label}</Fact>
                {ours.customer_name ? <Fact label="Guest">{ours.customer_name}</Fact> : null}
                <Fact label="Result">
                  {ours.status}
                  {ours.voided ? " · voided on the reader" : ""}
                  {ours.source === "terminal" ? (ours.on_bill ? " · on the bill" : " · not on any bill") : ""}
                </Fact>
                <Fact label="Amount">
                  {formatMoney(ours.amount)}
                  {ours.tip ? ` (incl. tip ${formatMoney(ours.tip)})` : ""}
                </Fact>
                <Fact label="Refunded">{ours.refunded ? formatMoney(ours.refunded) : "—"}</Fact>
                <Fact label="Difference">{rowDifference(row) ? formatMoney(rowDifference(row)) : "—"}</Fact>
              </>
            ) : (
              <p className="text-[#8a1f1f]">No record here.</p>
            )}
          </Facts>
        </div>

        {billId !== null ? <BillFacts bill={loadedBill} /> : null}

        <Decide bill={loadedBill?.sale ?? null} environment={environment} onChanged={onChanged} row={row} />
      </div>
    </Modal>
  );
}

function Facts({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="grid content-start gap-1 border border-[#d4d4d8] p-3">
      <h3 className="text-[11px] font-bold tracking-wide text-[#6b7280] uppercase">{title}</h3>
      {children}
    </section>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <p className="flex gap-2">
      <span className="w-20 shrink-0 text-[#6b7280]">{label}</span>
      <span className="min-w-0">{children}</span>
    </p>
  );
}

function BillFacts({ bill }: { bill: { sale: Sale | null; error: string } | null }) {
  if (!bill) return <SkeletonRows count={3} />;
  if (!bill.sale) return <ErrorNote>{bill.error}</ErrorNote>;
  const sale = bill.sale;
  const when =
    sale.status === "void"
      ? "voided"
      : sale.status === "refunded"
        ? `refunded ${clubTime(sale.refunded_at)}`
        : sale.status === "paid"
          ? `paid ${clubTime(sale.created_at)}`
          : "still open";
  return (
    <Facts title={`Bill ${sale.receipt_no || `#${sale.id}`} · ${when}`}>
      {sale.refund_reason ? <Fact label="Reason">{sale.refund_reason}</Fact> : null}
      <Fact label="Cashier">
        <StaffName date={sale.business_date} name={sale.cashier} />
      </Fact>
      <ul className="grid gap-0.5">
        {sale.lines.map((line, index) => (
          <li className="flex justify-between gap-2" key={line.id ?? index}>
            <span className="min-w-0">
              {line.quantity > 1 ? `${line.quantity} × ` : ""}
              {line.name}
            </span>
            <span className="shrink-0 tabular-nums">{formatMoney(line.line_total)}</span>
          </li>
        ))}
      </ul>
      <p className="flex justify-between border-t border-[#ececef] pt-1 font-bold">
        <span>Total{sale.tax ? ` (incl. HST ${formatMoney(sale.tax)})` : ""}</span>
        <span className="tabular-nums">{formatMoney(sale.total)}</span>
      </p>
      {sale.payments?.length ? (
        <ul className="grid gap-0.5 text-xs text-[#6b7280]">
          {sale.payments.map((payment, index) => (
            <li className="flex justify-between gap-2" key={index}>
              <span>
                {PAYMENT_LABELS[payment.method] ?? payment.method}
                {payment.card_last4 ? ` •${payment.card_last4}` : ""}
                {payment.tip ? ` + tip ${formatMoney(payment.tip)}` : ""}
              </span>
              <span className="tabular-nums">{formatMoney(payment.amount)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-[#6b7280]">No payments on this bill.</p>
      )}
    </Facts>
  );
}

// ===== 정하기 ==========================================================

type Option = { key: Choice; label: string; hint: string; blocked?: ReactNode };

function Decide({
  row,
  bill,
  environment,
  onChanged,
}: {
  row: ReconcileRow;
  bill: Sale | null;
  environment: "test" | "live";
  onChanged: () => void;
}) {
  const settings = useTerminalSettings();
  const [choice, setChoice] = useState<Choice | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState("");

  const ours = row.ours;
  const stripe = row.stripe;
  const net = stripe ? stripe.amount - stripe.refunded : 0;
  const terminalSale = ours?.source === "terminal" && stripe ? ours : null;
  const stillCharged = !!terminalSale && net > 0 && !terminalSale.refunded && !terminalSale.pending_refunds;
  const billStatus = ours?.bill_status ?? null;
  const debit = terminalSale?.card_type === "debit" || stripe?.method === "interac_present";

  if (!stripe || (row.level === "ok" && !row.reviewed)) return null;

  const options: Option[] = [];
  if (stillCharged && terminalSale && !terminalSale.on_bill && !terminalSale.voided) {
    const charge = terminalSale.amount - (terminalSale.tip ?? 0);
    const mismatch = bill && bill.total !== charge;
    options.push({
      key: "sale",
      label: "Count as sale",
      hint:
        billStatus === "void"
          ? `Bring bill #${terminalSale.bill_id} back and mark it paid with this card. It shows in today's sales with a new receipt.`
          : `Finish bill #${terminalSale.bill_id} with this card payment. It shows in today's sales.`,
      blocked:
        billStatus !== "open" && billStatus !== "void" ? (
          `The bill is ${billStatus ?? "missing"}, so it cannot take this payment. Refund the card instead.`
        ) : mismatch ? (
          <>
            The bill total is {formatMoney(bill.total)} but the card paid {formatMoney(charge)}.{" "}
            {billStatus === "open" ? (
              <Link className="font-semibold text-[#4533ff] underline" href={`/admin/retail?bill=${terminalSale.bill_id}`}>
                Open the bill at the register
              </Link>
            ) : (
              "Ring it up again at the register"
            )}{" "}
            — the card payment is waiting there.
          </>
        ) : undefined,
    });
  }
  if (stillCharged && terminalSale && terminalSale.bill_id !== null && !terminalSale.voided) {
    options.push({
      key: "refund",
      label: billStatus === "refunded" ? "Refund the card now" : "Not a sale — refund the card",
      hint:
        `Give ${formatMoney(net)} back to ${cardText(row) || "the card"}.` +
        (debit ? " Interac: the guest taps the card on the reader." : " The card does not need to be there.") +
        (billStatus === "open" ? " The bill stays open — void it at the register if it should not be sold." : ""),
      blocked:
        debit && !settings.readerId
          ? "Interac refunds need the guest's card on the reader. Pick a reader on this device (Register → card reader) first."
          : undefined,
    });
  }
  if (row.level !== "ok") {
    options.push({
      key: "note",
      label: billStatus === "refunded" ? "Leave it — refunded another way" : "Leave as is",
      hint:
        billStatus === "refunded"
          ? "The guest got the money back another way (cash, etc.). Nothing moves; your reason is kept."
          : "Nothing moves. Your reason is kept and this row stops counting as a problem.",
    });
  }

  if (done) {
    return <p className="border border-[#a8d5b5] bg-[#ecf7ef] px-3 py-2 font-semibold text-[#1d6b34]">{done}</p>;
  }
  if (options.length === 0) {
    return (
      <p className="text-xs text-[#6b7280]">
        Nothing to decide here — fix it in the{" "}
        <a className="text-[#4533ff] underline" href={stripeUrl(environment, stripe.payment_intent)} rel="noreferrer" target="_blank">
          Stripe dashboard
        </a>{" "}
        or the bill.
      </p>
    );
  }

  const picked = options.find((option) => option.key === choice) ?? null;
  const needsNote = choice === "note";

  async function confirm() {
    if (!picked || picked.blocked || !stripe) return;
    setBusy(true);
    setError("");
    setStatus("");
    try {
      if (picked.key === "sale" && terminalSale) {
        const result = await keepAsSale(terminalSale.id, note);
        setDone(`Counted as sale on bill ${result.bill.receipt_no}.`);
      } else if (picked.key === "refund" && terminalSale && terminalSale.bill_id !== null) {
        const refund = await terminal.refund(settings, terminalSale.bill_id, { id: terminalSale.id }, { onStatus: setStatus });
        if (!refund.approved) throw new Error(refund.host_message || "The card refund did not go through.");
        try {
          await recordDecision({
            payment_intent: stripe.payment_intent,
            decision: "refund",
            note,
            terminal_txn: terminalSale.id,
          });
        } catch {
          // 환불은 됐다. 기록만 못 남겼다 — 대사는 Stripe·단말기 기록으로 맞춰진다.
        }
        setDone(`Refunded ${formatMoney(refund.total_amount)} to the card.`);
      } else if (picked.key === "note") {
        await recordDecision({
          payment_intent: stripe.payment_intent,
          decision: "note",
          note,
          terminal_txn: terminalSale?.id ?? null,
        });
        setDone("Saved. This row now shows as Reviewed.");
      }
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That did not work.");
    } finally {
      setBusy(false);
      setStatus("");
    }
  }

  return (
    <section className="grid gap-2 border-t border-[#d4d4d8] pt-3">
      <h3 className="text-[11px] font-bold tracking-wide text-[#6b7280] uppercase">
        {row.decision ? "Decide again" : "What should happen to this money?"}
      </h3>
      <div className="grid gap-2 sm:grid-cols-3">
        {options.map((option) => (
          <button
            aria-pressed={choice === option.key}
            className={`grid content-start gap-1 border p-3 text-left ${
              choice === option.key ? "border-[#111827] bg-[#f4f4f5]" : "border-[#d4d4d8] hover:border-[#9ca3af]"
            }`}
            disabled={busy}
            key={option.key}
            onClick={() => {
              setChoice(option.key);
              setError("");
            }}
            type="button"
          >
            <span className="font-bold">{option.label}</span>
            <span className="text-xs text-[#6b7280]">{option.hint}</span>
          </button>
        ))}
      </div>

      {picked ? (
        <>
          {picked.blocked ? <p className="border border-[#e8c873] bg-[#fff6e0] px-3 py-2 text-[#7a5200]">{picked.blocked}</p> : null}
          <TextArea
            onChange={(event) => setNote(event.target.value)}
            placeholder={needsNote ? "Why does it stay as it is? (required)" : "Note (optional)"}
            rows={2}
            value={note}
          />
          {error ? <ErrorNote>{error}</ErrorNote> : null}
          {status ? <p className="text-xs text-[#6b7280]">{status}</p> : null}
          <div className="flex justify-end">
            <Button
              disabled={busy || !!picked.blocked || (needsNote && !note.trim())}
              onClick={confirm}
              tone="primary"
            >
              {busy ? "Working…" : CONFIRM[picked.key]}
            </Button>
          </div>
        </>
      ) : null}
    </section>
  );
}

const CONFIRM: Record<Choice, string> = {
  sale: "Count it as a sale",
  refund: "Refund the card",
  note: "Save and leave as is",
};
