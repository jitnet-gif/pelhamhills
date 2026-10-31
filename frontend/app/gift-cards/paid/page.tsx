"use client";

/**
 * 기프트카드 결제(Stripe Checkout)에서 돌아오는 자리: `/gift-cards/paid?invoice=PHG…` (취소하고 오면 `&cancelled=1`).
 * 회원권 결과 화면과 같은 생각이다 — 주소의 값은 믿지 않고 서버에 invoice 로 묻는다.
 * 승인되면 바코드를 그 자리에서 보여 준다. 문자·메일이 늦거나 번호를 잘못 넣어도 손님은 카드를 받는다.
 */

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState, type ReactNode } from "react";

import SiteFooter from "@/components/site/SiteFooter";
import SiteHeader from "@/components/site/SiteHeader";
import { giftOrderStatus, type GiftOrderResult } from "@/lib/giftShop";
import { CLUB, SITE_GIFT_CARDS } from "@/lib/nav";
import { code128ScreenWidth, code128Svg } from "@/lib/retail/barcode";

export default function GiftCardPaidPage() {
  return (
    <div className="min-h-dvh bg-[#f7f4ed] text-[#182118]">
      <SiteHeader />
      <main className="mx-auto max-w-2xl px-5 py-12 sm:py-16">
        <p className="text-sm font-bold tracking-[0.2em] text-[#8a6f30] uppercase">Gift card</p>
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

const cents = (n: number) => `$${(n / 100).toLocaleString("en-CA", { minimumFractionDigits: 2 })}`;

function PaidResult() {
  const params = useSearchParams();
  const invoice = (params.get("invoice") ?? "").trim();
  const cameBack = params.get("cancelled") === "1";
  const [order, setOrder] = useState<GiftOrderResult | null>(null);
  const [failed, setFailed] = useState(false);
  const [tries, setTries] = useState(0);

  useEffect(() => {
    if (!invoice) return;
    let alive = true;
    giftOrderStatus(invoice)
      .then((o) => {
        if (alive) setOrder(o);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [invoice, tries]);

  const pending = order?.status === "pending";
  useEffect(() => {
    if (!pending || cameBack || tries >= POLL_TRIES) return;
    const timer = window.setTimeout(() => setTries((n) => n + 1), POLL_MS);
    return () => window.clearTimeout(timer);
  }, [pending, cameBack, tries]);

  if (!invoice) {
    return (
      <Panel title="No order to show" tone="warn">
        <p>This link is missing its order reference. Call the pro shop and we&rsquo;ll look it up.</p>
        <Actions />
      </Panel>
    );
  }
  if (failed && !order) {
    return (
      <Panel title="We could not check your payment" tone="warn">
        <p>
          If you finished paying, please don&rsquo;t pay again. Your gift card is sent by email and text, or call the
          pro shop at {CLUB.phone} and we&rsquo;ll confirm it.
        </p>
        <Actions />
      </Panel>
    );
  }
  if (!order) return <Checking />;

  const card = order.card_last4 ? `${order.card_brand || "Card"} ending ${order.card_last4}` : "";

  if (order.status === "approved" && order.code) {
    return (
      <Panel title="Your gift card is ready" tone="ok">
        <p className="font-serif text-4xl font-semibold text-[#214d2f]">{cents(order.amount)}</p>
        {order.recipient ? <p className="mt-1">For {order.recipient}</p> : null}
        <div className="mt-5 overflow-x-auto bg-white py-2 text-center">
          {/* code128Svg 는 막대(rect)만 그린 SVG 다. 사람이 입력한 글자는 들어가지 않는다. */}
          <div
            className="mx-auto h-20 [&_svg]:h-full [&_svg]:w-full"
            dangerouslySetInnerHTML={{ __html: code128Svg(order.code) }}
            style={{ width: code128ScreenWidth(order.code) }}
          />
          <p className="mt-1 font-mono text-sm tracking-wider">{order.code}</p>
        </div>
        <dl className="mt-5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-1 text-sm">
          {card ? (
            <>
              <dt className="text-[#516050]">Paid with</dt>
              <dd>{card}</dd>
            </>
          ) : null}
          <dt className="text-[#516050]">Order</dt>
          <dd className="font-mono">{order.invoice}</dd>
        </dl>
        <p className="mt-5 font-semibold">The gift certificate and receipt are on their way by email, the barcode by text.</p>
        <p className="mt-2">Show this barcode at the counter. Anyone with it can spend the card, so keep it safe.</p>
        <Actions />
      </Panel>
    );
  }

  if (pending && cameBack) {
    return (
      <Panel title="Payment not completed" tone="warn">
        <p>No charge was made and no gift card was issued.</p>
        <Actions again />
      </Panel>
    );
  }

  if (pending) {
    return tries >= POLL_TRIES ? (
      <Panel title="Still confirming your payment" tone="warn">
        <p>
          Stripe has not told us the result yet. If you finished paying, your gift card will arrive by email and text
          within a few minutes. Please don&rsquo;t pay twice.
        </p>
        <Actions />
      </Panel>
    ) : (
      <Checking />
    );
  }

  if (order.status === "declined" || order.status === "error") {
    return (
      <Panel title="Payment didn't go through" tone="error">
        <p>Your card was not charged and no gift card was issued.</p>
        <Actions again />
      </Panel>
    );
  }

  if (order.reversal_failed) {
    return (
      <Panel title="Please call the pro shop" tone="warn">
        <p>
          We received {cents(order.amount)} but could not issue the gift card. The pro shop will refund it. Please call{" "}
          {CLUB.phone}.
        </p>
        <Actions />
      </Panel>
    );
  }

  // orphaned / refunded
  return (
    <Panel title="Payment refunded" tone="warn">
      <p>
        This payment of {cents(order.amount)} was returned to your card{card ? ` (${card})` : ""} and the gift card is no
        longer valid. It usually shows on your statement within 5–10 business days.
      </p>
      <Actions />
    </Panel>
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

function Actions({ again = false }: { again?: boolean }) {
  return (
    <div className="mt-6 flex flex-wrap gap-x-5 gap-y-2 text-sm font-bold text-[#214d2f]">
      <Link className="underline" href={SITE_GIFT_CARDS}>
        {again ? "Try again" : "Gift cards"}
      </Link>
      <a className="underline" href={CLUB.phoneHref}>
        Call {CLUB.phone}
      </a>
    </div>
  );
}
