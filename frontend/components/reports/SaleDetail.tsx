"use client";

/**
 * 영수증 한 장의 상세 + 환불. Reports 의 매출 목록과 계산대 첫 화면(Refund · Recent activity)이
 * 같이 쓴다 — 환불 규칙(사유 필수, 단말기 먼저)이 두 곳에서 따로 늙지 않게 한 벌로 둔다.
 */

import { useEffect, useMemo, useState } from "react";

import {
  describeTerminalResult,
  terminal,
  terminalEnabled,
  TerminalError,
  useTerminalSettings,
  type TerminalRecord,
} from "@/lib/pos/terminal";
import retailApi, { toRetailError } from "@/lib/retail/api";
import { printReceipt } from "@/lib/retail/printReceipt";
import { PAYMENT_LABELS } from "@/lib/retail/receipt";
import { formatMoney, type Sale, type SalePayment } from "@/lib/retail/types";

import {
  Button,
  ErrorNote,
  Field,
  Modal,
  TextArea,
} from "@/components/retail/ui";

// ===== 영수증 상세 + 환불 ===============================================

export default function SaleDetail({
  sale,
  onClose,
  onRefunded,
}: {
  sale: Sale;
  onClose: () => void;
  onRefunded: (updated: Sale) => void;
}) {
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // 리더로 받았는데 아직 카드로 돌려주지 않은 결제 수. 0 이 아니면 장부 환불을 막는다 —
  // 2026-10-21 PH-20261021-0005 가 장부만 환불되고 Stripe 에는 돈이 남았다.
  const [cardsPending, setCardsPending] = useState(0);
  const keyedCard = (sale.payments ?? []).some(
    (payment) =>
      payment.entry !== "integrated" &&
      (payment.method === "card" || payment.method === "debit"),
  );

  const created = useMemo(() => {
    // 서버 시각은 ISO-8601 UTC 다. 매장 사람이 읽는 것은 현지 시각이므로 변환한다.
    const value = new Date(sale.created_at);
    return Number.isNaN(value.getTime())
      ? sale.created_at
      : value.toLocaleString("en-CA");
  }, [sale.created_at]);

  async function refund() {
    if (!reason.trim()) return;
    setBusy(true);
    setError("");
    try {
      const updated = await retailApi.refundSale(sale.id, {
        reason: reason.trim(),
      });
      // 서버가 갱신된 Sale 을 준다는 것은 계약에 명시돼 있지 않다. 형태가
      // 아니면 화면에서 만들어 내지 말고 원본을 그대로 두고 목록을 다시 읽게 한다.
      onRefunded(
        updated && typeof updated === "object" && "id" in updated
          ? updated
          : sale,
      );
      setConfirming(false);
    } catch (cause) {
      setError(toRetailError(cause).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal onClose={onClose} title={sale.receipt_no}>
      <div className="grid gap-3">
        <div>
          <p className="text-xs text-[#6b7280]">
            {sale.business_date} · {created}
          </p>
          <p className="text-xs text-[#6b7280]">
            {sale.payments && sale.payments.length > 1
              ? sale.payments
                  .map((payment) => PAYMENT_LABELS[payment.method])
                  .join(" + ")
              : sale.payment_method
                ? PAYMENT_LABELS[sale.payment_method]
                : "No charge"}
            {sale.cashier ? ` · ${sale.cashier}` : ""}
          </p>
        </div>

        {sale.refunded_at ? (
          <div className="border border-[#e2a5a5] bg-[#fdf0f0] px-3 py-2 text-sm text-[#8a1f1f]">
            <p className="font-bold">Refunded</p>
            {sale.refund_reason ? <p>{sale.refund_reason}</p> : null}
          </div>
        ) : null}

        <ul className="grid gap-1 border-y border-[#d4d4d8] py-2 text-sm">
          {sale.lines.map((line, index) => (
            <li key={line.id ?? `${line.product_id}-${line.sku}-${index}`}>
              <div className="flex items-baseline justify-between gap-2">
                <span className="min-w-0 truncate">
                  {line.quantity}× {line.name}
                </span>
                <span className="shrink-0 tabular-nums">
                  {formatMoney(line.line_total)}
                </span>
              </div>
              <p className="text-[11px] text-[#6b7280]">
                {line.kind === "tee_player"
                  ? `Green fee · tee time ${line.tee_date ?? ""}`
                  : line.kind === "sim_booking"
                    ? `Simulator · ${line.tee_date ?? ""} ${line.tee_time ?? ""}`
                    : line.sku}{" "}
                · {formatMoney(line.unit_price)} each
                {line.discount > 0 ? ` · −${formatMoney(line.discount)}` : ""}
              </p>
            </li>
          ))}
        </ul>

        <dl className="grid gap-1 text-sm">
          <SummaryRow label="Subtotal" value={formatMoney(sale.subtotal)} />
          {sale.discount > 0 ? (
            <SummaryRow
              label="Order discount"
              value={`−${formatMoney(sale.discount)}`}
            />
          ) : null}
          <SummaryRow label="HST" value={formatMoney(sale.tax)} />
          <div className="flex items-baseline justify-between gap-2 border-t border-[#d4d4d8] pt-1.5">
            <dt className="font-bold">Total</dt>
            <dd className="text-lg font-bold tabular-nums">
              {formatMoney(sale.total)}
            </dd>
          </div>
        </dl>

        {sale.payments && sale.payments.length > 0 ? (
          <ul className="grid gap-1 text-sm">
            {sale.payments.map((payment, index) => (
              <li
                className="flex items-baseline justify-between gap-2"
                key={index}
              >
                <span className="min-w-0">
                  {PAYMENT_LABELS[payment.method]}
                  {payment.auth_code ? (
                    <span className="text-[11px] text-[#6b7280]">
                      {" "}
                      · Approval {payment.auth_code}
                      {payment.card_last4 ? ` · ****${payment.card_last4}` : ""}
                    </span>
                  ) : null}
                </span>
                <span className="shrink-0 tabular-nums">
                  {formatMoney(payment.amount)}
                </span>
              </li>
            ))}
          </ul>
        ) : null}

        {sale.note ? (
          <p className="text-xs text-[#6b7280]">{sale.note}</p>
        ) : null}

        {/* 다시 찍은 종이에는 REPRINT 가 찍힌다. 원본과 사본을 들고 두 번 환불받으러
            오는 것을 창구에서 가려낼 수 있어야 한다. */}
        <Button full onClick={() => printReceipt(sale, { reprint: true })}>
          Reprint receipt
        </Button>

        {error ? <ErrorNote>{error}</ErrorNote> : null}

        {sale.refunded_at ? (
          // 장부는 환불됐어도 카드 돈이 남아 있을 수 있다. 그때 돌려줄 버튼이 사라지면 안 된다.
          <TerminalRefunds onPendingChange={setCardsPending} sale={sale} />
        ) : confirming ? (
          <div className="grid gap-2 border border-[#e2a5a5] p-2">
            <TerminalRefunds onPendingChange={setCardsPending} sale={sale} />
            {keyedCard ? (
              <p className="bg-[#fff8e1] px-2 py-2 text-xs text-[#5b4708]">
                A card or debit payment on this sale did not go through the
                reader. Refund it in the Stripe Dashboard first.
              </p>
            ) : null}
            <p className="text-xs text-[#6b7280]">
              Confirm refund only fixes the books: it puts stock back and marks
              any green fees on this bill unpaid again. It does not send money
              back to a card.
            </p>
            {cardsPending > 0 ? (
              <p className="bg-[#fff8e1] px-2 py-2 text-xs font-bold text-[#5b4708]">
                Refund the card payment above first. Confirm refund unlocks
                once the money is back on the card.
              </p>
            ) : null}
            <Field
              hint="Required — it goes on the day's reconciliation"
              label="Refund reason"
            >
              <TextArea
                onChange={(event) => setReason(event.target.value)}
                placeholder="Wrong size, customer cancelled…"
                value={reason}
              />
            </Field>
            <div className="flex gap-2">
              <Button
                className="flex-1"
                disabled={busy || !reason.trim() || cardsPending > 0}
                onClick={refund}
                tone="danger"
              >
                {busy ? "Refunding…" : "Confirm refund"}
              </Button>
              <Button className="flex-1" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <Button full onClick={() => setConfirming(true)} tone="danger">
            Refund this sale
          </Button>
        )}
      </div>
    </Modal>
  );
}

/**
 * 단말기 연동으로 받은 카드 결제(`entry = "integrated"`, Stripe Terminal)를 돌려준다. 신용카드는 Stripe
 * 환불(카드 필요 없음), Interac 은 리더에서 손님이 카드를 다시 댄다. 돌려준 뒤 아래 *Confirm refund* 로
 * 장부를 맞춘다. 손으로 친("keyed") 결제는 Stripe Dashboard 에서 돌려준다.
 *
 * `onPendingChange` 는 아직 돌려주지 않은 리더 결제 수를 알린다. 리더 승인 기록을 못 찾은 결제는
 * 여기서 돌려줄 수 없으니(대시보드로 안내) 세지 않는다 — 세면 장부 환불이 영영 막힌다.
 * 기록을 못 읽었을 때도 막지 않는다(0).
 */
function TerminalRefunds({
  sale,
  onPendingChange,
}: {
  sale: Sale;
  onPendingChange: (count: number) => void;
}) {
  const settings = useTerminalSettings();
  const linked = (sale.payments ?? []).filter(
    (payment) =>
      payment.entry === "integrated" &&
      (payment.method === "card" || payment.method === "debit"),
  );
  const [records, setRecords] = useState<TerminalRecord[]>([]);
  const [working, setWorking] = useState<number | null>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");

  const hasLinked = linked.length > 0;
  useEffect(() => {
    if (!hasLinked) return;
    let cancelled = false;
    terminal
      .forBill(sale.id)
      .then((list) => {
        if (!cancelled) setRecords(list);
      })
      .catch(() => {
        // 기록을 못 읽었다. 버튼은 그대로 쓸 수 있다.
      });
    return () => {
      cancelled = true;
    };
  }, [hasLinked, sale.id]);

  /** 이 결제 줄의 판매 기록(Charge 때 묶인 것). */
  const saleFor = (payment: SalePayment) =>
    records.find(
      (record) =>
        record.kind === "sale" &&
        record.approved &&
        record.used &&
        record.auth_code === payment.auth_code,
    );
  const done = (payment: SalePayment) => {
    const original = saleFor(payment);
    return records.some(
      (record) =>
        record.kind === "refund" &&
        record.approved &&
        (original
          ? record.refund_of === original.id
          : record.original_auth_code === payment.auth_code),
    );
  };
  const pending = linked.filter(
    (payment) => saleFor(payment) && !done(payment),
  ).length;
  useEffect(() => {
    onPendingChange(pending);
  }, [onPendingChange, pending]);

  if (!hasLinked) return null;

  async function reverse(index: number, payment: SalePayment) {
    const original = saleFor(payment);
    if (!original) {
      setError(
        "Could not find the reader approval for this payment. Refund it in the Stripe Dashboard.",
      );
      return;
    }
    setWorking(index);
    setError("");
    try {
      const record = await terminal.refund(settings, sale.id, original, {
        onStatus: setStatus,
      });
      setRecords((current) => [...current, record]);
      if (!record.approved)
        setError(
          `Refund did not go through: ${describeTerminalResult(record)}`,
        );
    } catch (cause) {
      setError(
        cause instanceof TerminalError || cause instanceof Error
          ? cause.message
          : "The reader did not answer.",
      );
    } finally {
      setWorking(null);
      setStatus("");
    }
  }

  return (
    <div className="grid gap-2 border border-[#d4d4d8] p-2 text-sm">
      <p className="text-xs font-bold tracking-wide text-[#6b7280] uppercase">
        Paid through the card reader
      </p>
      {linked.some((payment) => payment.method === "debit") &&
      !terminalEnabled(settings) ? (
        <p className="text-xs text-[#5b4708]">
          Interac refunds need the card reader. Do it on a register that is
          linked to the reader.
        </p>
      ) : null}
      {linked.map((payment, index) => (
        <div className="grid gap-1" key={index}>
          <p>
            {PAYMENT_LABELS[payment.method]}{" "}
            {formatMoney(payment.amount + (payment.tip ?? 0))}
            <span className="text-[11px] text-[#6b7280]">
              {" "}
              · Approval {payment.auth_code}
              {payment.card_last4 ? ` · ****${payment.card_last4}` : ""}
            </span>
          </p>
          {done(payment) ? (
            <p className="text-xs font-bold text-[#1f6b3a]">
              Refunded to the card.
            </p>
          ) : (
            <Button
              className="min-h-9 justify-self-start px-2 text-xs"
              disabled={
                working !== null ||
                (payment.method === "debit" && !terminalEnabled(settings))
              }
              onClick={() => void reverse(index, payment)}
            >
              {payment.method === "debit"
                ? "Refund on reader (customer taps card)"
                : "Refund to card"}
            </Button>
          )}
        </div>
      ))}
      {status ? <p className="text-xs font-bold">{status}</p> : null}
      {error ? <ErrorNote>{error}</ErrorNote> : null}
    </div>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-[#6b7280]">{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}
