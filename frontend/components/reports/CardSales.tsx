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
 */

import { useEffect, useMemo, useState } from "react";

import { formatMoney, type Cents, type Sale } from "@/lib/retail/types";
import { fetchReconcile, type ReconcileReport } from "@/lib/reports/stripeReconcile";

import { Button, ErrorNote, Panel } from "@/components/retail/ui";

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

export default function CardSales({ date, sales }: { date: string; sales: readonly Sale[] }) {
  const summary = useMemo(() => cardSalesSummary(sales), [sales]);
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
          reader.
        </p>

        <div className="grid gap-3 lg:grid-cols-2">
          <ul className="grid content-start gap-1 text-sm">
            <Row label="Card (By payment)" value={summary.card} />
            <Row label="Debit (By payment)" value={summary.debit} />
            <Row label="+ Tips on card & debit" value={summary.tips} />
            <Row label="+ Refunded sales (charged, then refunded)" value={summary.refunded} />
            <Row bold label="= Charged on cards" value={charged} />
            <Row indent label="Register reader (S700)" value={summary.charged.reader} />
            <Row indent label="Online booking (Stripe Checkout)" value={summary.charged.online} />
            <Row indent label="Keyed by hand — not in Stripe" value={summary.charged.keyed} warn={summary.charged.keyed > 0} />
          </ul>

          <ul className="grid content-start gap-1 text-sm">
            <Row bold label="Should be charged in Stripe" value={inStripe} />
            {loading ? (
              <li className="text-xs text-[#6b7280]">Reading Stripe…</li>
            ) : stripe ? (
              <>
                <Row
                  bold
                  label={`Stripe charged${stripe.environment === "test" ? " (test mode)" : ""}`}
                  value={stripe.summary.stripe_charged}
                />
                <Row
                  bold
                  label="Difference"
                  value={stripe.summary.stripe_charged - inStripe}
                  warn={stripe.summary.stripe_charged !== inStripe}
                />
                <Row label="Refunded here (reader & online)" value={refundedInStripe} />
                <Row
                  label="Stripe refunded"
                  value={stripe.summary.stripe_refunded}
                  warn={stripe.summary.stripe_refunded !== refundedInStripe}
                />
                <li className="pt-1 text-xs text-[#6b7280]">
                  {stripe.summary.errors + stripe.summary.warnings > 0
                    ? `${stripe.summary.errors} problem(s) and ${stripe.summary.warnings} to check, payment by payment — `
                    : "Every Stripe payment matched a record here — "}
                  <a className="font-semibold text-[#4533ff] underline" href={`?view=stripe&date=${date}`}>
                    open Stripe check
                  </a>
                  . A refund made on another day shows on that day in Stripe but takes the sale out of this day here.
                </li>
              </>
            ) : (
              <li>
                <ErrorNote>{loaded?.error || "Could not read Stripe."}</ErrorNote>
              </li>
            )}
          </ul>
        </div>
      </div>
    </Panel>
  );
}

function Row({
  label,
  value,
  bold = false,
  indent = false,
  warn = false,
}: {
  label: string;
  value: Cents;
  bold?: boolean;
  indent?: boolean;
  warn?: boolean;
}) {
  return (
    <li
      className={`flex items-baseline justify-between gap-2 ${bold ? "border-t border-[#ececf0] pt-1 font-bold" : ""} ${
        indent ? "pl-4 text-[#4b5563]" : ""
      } ${warn ? "text-[#8a1f1f]" : ""}`}
    >
      <span className="min-w-0">{label}</span>
      <span className="shrink-0 tabular-nums">{formatMoney(value)}</span>
    </li>
  );
}
