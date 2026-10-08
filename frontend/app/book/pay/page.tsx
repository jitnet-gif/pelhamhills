"use client";

/**
 * Authorize.net 결제 폼에서 돌아오는 자리: `/book/pay?invoice=PHW…` (취소하고 오면 `&cancelled=1`).
 *
 * 돌아온 주소에는 결과가 없다(Authorize.net 은 거래 내용을 붙이지 않는다). 그래서 서버에 invoice 로
 * 묻는다 — 서버는 웹훅이 이미 기록했으면 그 값을, 아직이면 Authorize.net 에 직접 물어 기록한 값을 준다
 * (`backend/api/routes/payments.py` 의 `/status`). 확인 중이면 잠깐씩 다시 묻는다.
 *
 * `useSearchParams` 때문에 내용은 Suspense 안쪽(`PayResult`)에 둔다(`/book/lookup` 과 같은 이유).
 */

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";

import BookingShell from "@/components/booking/BookingShell";
import { money, paymentStatus, type OnlinePayment } from "@/lib/booking/payments";
import { CLUB, lookupHref } from "@/lib/nav";

export default function PayPage() {
  return (
    <BookingShell subtitle="Your online payment" title="Payment">
      <Suspense fallback={<Checking />}>
        <PayResult />
      </Suspense>
    </BookingShell>
  );
}

// 확인 중일 때 다시 묻는 간격과 횟수(약 1분). 그 뒤에도 pending 이면 웹훅이 마무리한다.
const POLL_MS = 3000;
const POLL_TRIES = 20;

function PayResult() {
  const params = useSearchParams();
  const invoice = (params.get("invoice") ?? "").trim();
  const cameBack = params.get("cancelled") === "1";
  const [payment, setPayment] = useState<OnlinePayment | null>(null);
  const [failed, setFailed] = useState(false);
  const [tries, setTries] = useState(0);

  useEffect(() => {
    if (!invoice) return;
    let alive = true;
    paymentStatus(invoice)
      .then((p) => {
        if (alive) setPayment(p);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [invoice, tries]);

  const pending = payment?.status === "pending";
  useEffect(() => {
    // 손님이 결제 폼에서 Cancel 을 눌렀으면 기다릴 것이 없다.
    if (!pending || cameBack || tries >= POLL_TRIES) return;
    const timer = window.setTimeout(() => setTries((n) => n + 1), POLL_MS);
    return () => window.clearTimeout(timer);
  }, [pending, cameBack, tries]);

  if (!invoice) {
    return (
      <Panel title="No payment to show" tone="warn">
        <p>This link is missing its payment reference. Find your booking with your confirmation code instead.</p>
        <Actions />
      </Panel>
    );
  }
  if (failed && !payment) {
    return (
      <Panel title="We could not check your payment" tone="warn">
        <p>
          Your booking is safe either way. Look it up in a minute to see whether the payment went through, or call
          the pro shop.
        </p>
        <Actions />
      </Panel>
    );
  }
  if (!payment) return <Checking />;

  const code = payment.confirmation_code;
  const card = payment.card_last4 ? `${payment.card_brand || "Card"} ending ${payment.card_last4}` : "";

  if (payment.status === "approved") {
    return (
      <Panel title="Payment received" tone="ok">
        <p className="text-3xl font-bold text-[#182118]">{money(payment.amount)}</p>
        <p className="mt-1">{payment.description}</p>
        <dl className="mt-4 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
          {card ? (
            <>
              <dt className="text-[#5c6459]">Card</dt>
              <dd>{card}</dd>
            </>
          ) : null}
          {payment.receipt_no ? (
            <>
              <dt className="text-[#5c6459]">Receipt</dt>
              <dd className="break-all font-mono">{payment.receipt_no}</dd>
            </>
          ) : null}
          <dt className="text-[#5c6459]">Booking</dt>
          <dd className="break-all font-mono">{code}</dd>
        </dl>
        <p className="mt-4 text-sm">
          Nothing more to pay at the club. Cancel online up to 24 hours before your start time for a full refund.
        </p>
        <Actions code={code} />
      </Panel>
    );
  }

  if (pending && cameBack) {
    return (
      <Panel title="Payment cancelled" tone="warn">
        <p>No charge was made. Your booking is still reserved — you can pay online later or at the club.</p>
        <Actions code={code} />
      </Panel>
    );
  }

  if (pending) {
    return tries >= POLL_TRIES ? (
      <Panel title="Still confirming your payment" tone="warn">
        <p>
          Authorize.net has not told us the result yet. If you finished paying, it will show on your booking within a
          few minutes — please don&apos;t pay twice. Your booking is reserved either way.
        </p>
        <Actions code={code} />
      </Panel>
    ) : (
      <Checking />
    );
  }

  if (payment.status === "declined" || payment.status === "error") {
    return (
      <Panel title="Payment didn't go through" tone="error">
        <p>
          Your card was not charged. Your booking is still reserved — try again from your booking, or pay at the club.
        </p>
        <Actions code={code} />
      </Panel>
    );
  }

  if (payment.status === "held") {
    return (
      <Panel title="Payment under review" tone="warn">
        <p>
          The card processor is reviewing this payment. Your booking is reserved; we will update it once the review
          finishes. Please don&apos;t pay again.
        </p>
        <Actions code={code} />
      </Panel>
    );
  }

  // orphaned / voided / refunded: 받았지만 예약에 붙일 수 없어 되돌렸거나, 이미 환불됐다.
  return (
    <Panel title={payment.reversal_failed ? "Please call the pro shop" : "Payment returned"} tone="warn">
      <p>
        {payment.reversal_failed
          ? `We received ${money(payment.amount)} but could not apply it to your booking. The pro shop will refund it — please call ${CLUB.phone}.`
          : `This payment of ${money(payment.amount)} could not be applied to your booking (it may have changed, or was already paid), so it was returned to your card${card ? ` (${card})` : ""}.`}
      </p>
      <Actions code={code} />
    </Panel>
  );
}

function Checking() {
  return (
    <div className="rounded-sm border border-[#d8d1c3] bg-white p-6" role="status">
      <p className="font-semibold text-[#182118]">Confirming your payment…</p>
      <p className="mt-1 text-sm text-[#5c6459]">This usually takes a few seconds. Please keep this page open.</p>
      <div className="mt-4 h-1 overflow-hidden rounded-full bg-[#efece3]">
        <div className="h-full w-1/3 animate-pulse rounded-full bg-[#214d2f]" />
      </div>
    </div>
  );
}

function Panel({
  children,
  title,
  tone,
}: {
  children: React.ReactNode;
  title: string;
  tone: "ok" | "warn" | "error";
}) {
  const skin =
    tone === "ok"
      ? "border-[#b9d3b9] bg-[#e4efe4] text-[#214d2f]"
      : tone === "error"
        ? "border-[#e0b3b3] bg-[#fbeeee] text-[#8a2f2f]"
        : "border-[#d6c28f] bg-[#f3ead2] text-[#5c4a1c]";
  return (
    <div className={`min-w-0 rounded-sm border p-6 ${skin}`} role="status">
      <h2 className="font-serif text-2xl font-semibold">{title}</h2>
      <div className="mt-2 text-[#3d453d]">{children}</div>
    </div>
  );
}

function Actions({ code }: { code?: string }) {
  return (
    <div className="mt-5 grid grid-cols-[minmax(0,1fr)] gap-2 sm:grid-cols-2">
      <Link
        className="tap-target flex items-center justify-center rounded-sm bg-[#214d2f] px-5 text-base font-bold text-white transition hover:bg-[#163820]"
        href={code ? lookupHref(code) : "/book/lookup"}
      >
        View my booking
      </Link>
      <a
        className="tap-target flex items-center justify-center rounded-sm border border-[#d8d1c3] bg-white px-5 text-base font-bold text-[#214d2f] transition hover:bg-[#f7f4ed]"
        href={CLUB.phoneHref}
      >
        Call {CLUB.phone}
      </a>
    </div>
  );
}
