"use client";

/**
 * 회원권 카드 결제(Stripe Checkout)에서 돌아오는 자리: `/memberships/application/paid?invoice=PHM…`
 * (취소하고 오면 `&cancelled=1`). `/book/pay` 와 같은 생각이다 — 주소의 값은 믿지 않고 서버에 invoice 로
 * 묻는다. 서버는 웹훅이 이미 기록했으면 그 값을, 아직이면 Stripe 에 직접 물어 기록한 값을 준다.
 *
 * 다시 결제하는 버튼은 이 탭에 남겨 둔 열쇠(`rememberPayCredentials`)가 있을 때만 그린다.
 */

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState, type ReactNode } from "react";

import SiteFooter from "@/components/site/SiteFooter";
import SiteHeader from "@/components/site/SiteHeader";
import {
  membershipPaymentStatus,
  money,
  recallPayCredentials,
  startMembershipCheckout,
  typeInfo,
  type MembershipPayment,
} from "@/lib/memberships";
import { CLUB, SITE_MEMBERSHIPS, SITE_MEMBERSHIP_APPLY, SITE_MEMBERSHIP_EARLY_BIRD } from "@/lib/nav";

export default function MembershipPaidPage() {
  return (
    <div className="min-h-dvh bg-[#f7f4ed] text-[#182118]">
      <SiteHeader />
      <main className="mx-auto max-w-2xl px-5 py-12 sm:py-16">
        <p className="text-sm font-bold tracking-[0.2em] text-[#8a6f30] uppercase">Membership payment</p>
        <Suspense fallback={<Checking />}>
          <PaidResult />
        </Suspense>
      </main>
      <SiteFooter />
    </div>
  );
}

// 확인 중일 때 다시 묻는 간격과 횟수(약 1분). 그 뒤에도 pending 이면 웹훅이 마무리한다.
const POLL_MS = 3000;
const POLL_TRIES = 20;

/** 센트 → "$3,142.53" */
const cents = (n: number) => money(n / 100);

function PaidResult() {
  const params = useSearchParams();
  const invoice = (params.get("invoice") ?? "").trim();
  const cameBack = params.get("cancelled") === "1";
  const [payment, setPayment] = useState<MembershipPayment | null>(null);
  const [failed, setFailed] = useState(false);
  const [tries, setTries] = useState(0);

  useEffect(() => {
    if (!invoice) return;
    let alive = true;
    membershipPaymentStatus(invoice)
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
    if (!pending || cameBack || tries >= POLL_TRIES) return;
    const timer = window.setTimeout(() => setTries((n) => n + 1), POLL_MS);
    return () => window.clearTimeout(timer);
  }, [pending, cameBack, tries]);

  if (!invoice) {
    return (
      <Panel title="No payment to show" tone="warn">
        <p>This link is missing its payment reference. Call the pro shop and we&rsquo;ll look it up.</p>
        <Actions />
      </Panel>
    );
  }
  if (failed && !payment) {
    return (
      <Panel title="We could not check your payment" tone="warn">
        <p>
          Your application is saved either way. If you finished paying, please don&rsquo;t pay again — call the pro
          shop at {CLUB.phone} and we&rsquo;ll confirm it.
        </p>
        <Actions />
      </Panel>
    );
  }
  if (!payment) return <Checking />;

  const what =
    payment.season && payment.membership_type
      ? `${payment.season} ${typeInfo(payment.membership_type).label} Membership (${payment.plan === "spousal" ? "Spousal" : "Single"})`
      : "Membership";
  const card = payment.card_last4 ? `${payment.card_brand || "Card"} ending ${payment.card_last4}` : "";

  if (payment.status === "approved") {
    return (
      <Panel title={`Welcome, ${payment.member_name ?? "member"}!`} tone="ok">
        <p className="font-serif text-4xl font-semibold text-[#214d2f]">{cents(payment.amount)}</p>
        <p className="mt-1">{what} — paid by card.</p>
        <dl className="mt-5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-1 text-sm">
          {card ? (
            <>
              <dt className="text-[#516050]">Card</dt>
              <dd>{card}</dd>
            </>
          ) : null}
          <dt className="text-[#516050]">Reference</dt>
          <dd className="font-mono">{payment.reference}</dd>
          <dt className="text-[#516050]">Payment</dt>
          <dd className="font-mono">{payment.invoice}</dd>
        </dl>
        <p className="mt-5 font-semibold">A receipt is on its way to your email.</p>
        <p className="mt-2 leading-7">
          {payment.membership_status === "active"
            ? "Your membership is paid in full. Your indoor golf simulator coupons will be sent by email, and you can book tee times 14 days ahead once the season opens."
            : `Thank you — ${money(payment.balance ?? 0)} is still owing. The pro shop will be in touch.`}
        </p>
        <Actions benefits />
      </Panel>
    );
  }

  if (pending && cameBack) {
    return (
      <Panel title="Payment not completed" tone="warn">
        <p>No charge was made. Your application is saved — pay by card now, or the pro shop will call you.</p>
        <Retry />
        <Actions />
      </Panel>
    );
  }

  if (pending) {
    return tries >= POLL_TRIES ? (
      <Panel title="Still confirming your payment" tone="warn">
        <p>
          Stripe has not told us the result yet. If you finished paying, it will show up within a few minutes —
          please don&rsquo;t pay twice.
        </p>
        <Actions />
      </Panel>
    ) : (
      <Checking />
    );
  }

  if (payment.status === "declined" || payment.status === "error") {
    return (
      <Panel title="Payment didn't go through" tone="error">
        <p>Your card was not charged. Your application is saved — try another card, or the pro shop will call you.</p>
        <Retry />
        <Actions />
      </Panel>
    );
  }

  if (payment.reversal_failed) {
    return (
      <Panel title="Please call the pro shop" tone="warn">
        <p>
          We received {cents(payment.amount)} but could not apply it to your membership. The pro shop will refund it —
          please call {CLUB.phone}.
        </p>
        <Actions />
      </Panel>
    );
  }

  // orphaned / refunded
  const reversed = payment.status === "orphaned" || Boolean(payment.reversed);
  return (
    <Panel title={reversed ? "Payment returned" : "Payment refunded"} tone="warn">
      <p>
        {reversed
          ? `This payment of ${cents(payment.amount)} could not be applied (your membership may already be paid), so it ${payment.status === "orphaned" ? "is being" : "was"} returned to your card${card ? ` (${card})` : ""}.`
          : `This payment of ${cents(payment.amount)} was refunded to your card${card ? ` (${card})` : ""}. It usually shows on your statement within 5–10 business days.`}
      </p>
      <Actions />
    </Panel>
  );
}

function Retry() {
  const [creds] = useState(recallPayCredentials);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!creds) return null;
  return (
    <div className="mt-5 grid gap-2">
      <button
        className="min-h-12 rounded-sm bg-[#214d2f] px-6 text-sm font-extrabold tracking-[0.12em] text-white uppercase transition hover:bg-[#163820] disabled:opacity-60"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError("");
          try {
            await startMembershipCheckout(creds);
          } catch (err) {
            setBusy(false);
            setError((err as Error)?.message || "We couldn't open the card payment page.");
          }
        }}
        type="button"
      >
        {busy ? "Opening…" : "Try paying by card again"}
      </button>
      {error ? <p className="text-sm font-bold text-[#8a1f1f]">{error}</p> : null}
    </div>
  );
}

function Checking() {
  return (
    <div className="mt-4 rounded-sm border border-[#d8d1c3] bg-white p-6" role="status">
      <p className="font-semibold">Confirming your payment…</p>
      <p className="mt-1 text-sm text-[#516050]">This usually takes a few seconds. Please keep this page open.</p>
      <div className="mt-4 h-1 overflow-hidden rounded-full bg-[#efece3]">
        <div className="h-full w-1/3 animate-pulse rounded-full bg-[#214d2f]" />
      </div>
    </div>
  );
}

const TONE = {
  ok: "border-[#214d2f]",
  warn: "border-[#d6c28f]",
  error: "border-[#e2a5a5]",
} as const;

function Panel({ title, tone, children }: { title: string; tone: keyof typeof TONE; children: ReactNode }) {
  return (
    <section className={`mt-4 rounded-sm border-2 bg-white p-6 leading-7 text-[#3d453d] sm:p-8 ${TONE[tone]}`}>
      <h1 className="mb-4 font-serif text-3xl font-semibold text-[#182118]">{title}</h1>
      {children}
    </section>
  );
}

function Actions({ benefits = false }: { benefits?: boolean }) {
  return (
    <div className="mt-6 flex flex-wrap gap-x-5 gap-y-2 text-sm font-bold text-[#214d2f]">
      {benefits ? (
        <Link className="underline" href={SITE_MEMBERSHIP_EARLY_BIRD}>
          Early Bird benefits
        </Link>
      ) : (
        <Link className="underline" href={SITE_MEMBERSHIP_APPLY}>
          Application
        </Link>
      )}
      <Link className="underline" href={SITE_MEMBERSHIPS}>
        Memberships
      </Link>
      <a className="underline" href={CLUB.phoneHref}>
        Call {CLUB.phone}
      </a>
    </div>
  );
}
