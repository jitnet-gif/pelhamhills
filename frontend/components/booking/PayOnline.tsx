"use client";

/**
 * 예약 확정 화면과 `/book/lookup` 에 붙는 "지금 결제" 칸(Authorize.net, 선택 결제).
 *
 * - 서버가 결제를 켜 두지 않았으면(`enabled: false`) 아무것도 그리지 않는다. 예약 흐름은 그대로다.
 * - 금액·낼 수 있는지는 서버(SQL 0020)가 정한다. 이 칸은 받은 값을 보여 주기만 한다.
 * - 이미 온라인으로 냈으면 영수증 한 줄, 환불됐으면 환불 한 줄.
 * - 프로 샵에서 이미 냈거나 계산서를 시작한 예약은 조용히 숨는다(손님이 할 일이 없다).
 */

import { useEffect, useState } from "react";

import {
  money,
  quotePayment,
  startCheckout,
  type Credentials,
  type PaymentQuote,
} from "@/lib/booking/payments";
import { ApiError } from "@/lib/teeSheet/api";

type Props = {
  creds: Credentials;
  /** 견적이 오면 부모에게도 알려 준다(조회 화면이 취소 버튼을 고를 때 쓴다). */
  onQuote?: (quote: PaymentQuote | null) => void;
};

export default function PayOnline({ creds, onQuote }: Props) {
  const [quote, setQuote] = useState<PaymentQuote | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    quotePayment(creds)
      .then((q) => {
        if (!alive) return;
        setQuote(q);
        onQuote?.(q);
      })
      .catch(() => {
        // 결제 서버가 안 닿으면 칸을 숨긴다. 예약은 이미 됐고, 프로 샵에서 내면 된다.
        if (!alive) return;
        setQuote(null);
        onQuote?.(null);
      });
    return () => {
      alive = false;
    };
    // creds 객체가 매번 새로 와도 코드·이메일이 같으면 다시 묻지 않는다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [creds.code, creds.email]);

  if (!quote || !quote.enabled) return null;
  const paid = quote.payment;

  if (paid && paid.status === "approved") {
    return (
      <div className="mt-5 rounded-sm border border-[#b9d3b9] bg-[#e4efe4] p-4 text-sm text-[#214d2f]" role="status">
        <p className="font-semibold">
          Paid online · {money(paid.amount)}
          {paid.card_last4 ? ` · ${paid.card_brand || "Card"} ending ${paid.card_last4}` : ""}
        </p>
        <p className="mt-1 text-[#3d453d]">
          {paid.receipt_no ? `Receipt ${paid.receipt_no}. ` : ""}Nothing more to pay for this booking at the club.
          {paid.refund_pending ? " A refund is in progress." : ""}
        </p>
      </div>
    );
  }

  if (paid && (paid.status === "refunded" || paid.status === "voided") && !quote.payable) {
    return (
      <div className="mt-5 rounded-sm border border-[#d8d1c3] bg-white p-4 text-sm text-[#3d453d]" role="status">
        <p className="font-semibold text-[#182118]">Refunded {money(paid.amount)}</p>
        <p className="mt-1">
          {paid.status === "voided"
            ? "The charge was cancelled before it settled, so it will drop off your statement."
            : `The refund goes back to your ${paid.card_brand || "card"}${paid.card_last4 ? ` ending ${paid.card_last4}` : ""} and can take 3–5 business days to appear.`}
        </p>
      </div>
    );
  }

  if (!quote.payable) return null;

  async function pay() {
    setBusy(true);
    setError("");
    try {
      await startCheckout(creds);
      // 이 탭은 이제 Authorize.net 으로 넘어간다. busy 를 풀지 않는다(두 번 누르지 않게).
    } catch (err) {
      setBusy(false);
      setError(
        err instanceof ApiError && err.status !== 0 && err.status < 500
          ? err.message
          : "Online payment is not available right now. You can pay at the club when you arrive.",
      );
    }
  }

  return (
    <div className="mt-5 rounded-sm border border-[#d8d1c3] bg-white p-5 text-left">
      <p className="text-xs font-bold uppercase tracking-[0.14em] text-[#8a6f30]">Pay now (optional)</p>
      <p className="mt-1 text-sm text-[#5c6459]">
        Skip the line at the {quote.kind === "sim" ? "front desk" : "pro shop"} — or pay when you arrive, as usual.
      </p>
      <dl className="mt-4 grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 text-sm">
        {quote.lines.map((line, i) => (
          <div className="contents" key={`${line.name}-${i}`}>
            <dt className="min-w-0 break-words text-[#3d453d]">{line.name}</dt>
            <dd className="text-right tabular-nums">{money(line.amount)}</dd>
          </div>
        ))}
        <dt className="mt-2 border-t border-[#d8d1c3] pt-2 text-[#5c6459]">Subtotal</dt>
        <dd className="mt-2 border-t border-[#d8d1c3] pt-2 text-right tabular-nums">{money(quote.subtotal)}</dd>
        <dt className="text-[#5c6459]">HST 13%</dt>
        <dd className="text-right tabular-nums">{money(quote.tax)}</dd>
        <dt className="font-bold text-[#182118]">Total</dt>
        <dd className="text-right font-bold tabular-nums text-[#182118]">{money(quote.total)}</dd>
      </dl>
      {quote.kind === "tee" ? (
        <p className="mt-2 text-xs text-[#5c6459]">Cart rental, if you need one, is paid at the pro shop.</p>
      ) : null}
      {error ? (
        <p className="mt-3 text-sm font-semibold text-[#8a2f2f]" role="alert">
          {error}
        </p>
      ) : null}
      <button
        className={`tap-target mt-4 w-full rounded-sm px-5 text-base font-bold text-white transition ${
          busy ? "cursor-not-allowed bg-[#a9b0a6]" : "bg-[#214d2f] hover:bg-[#163820]"
        }`}
        disabled={busy}
        onClick={() => void pay()}
        type="button"
      >
        {busy ? "Opening secure payment…" : `Pay ${money(quote.total)} now`}
      </button>
      <p className="mt-2 text-xs text-[#5c6459]">
        You enter your card on Authorize.net&apos;s secure page; we never see your card number. Cancel online up to
        24 hours before your start time for a full refund.
      </p>
    </div>
  );
}
