"use client";

import { useEffect, useState } from "react";

import { ErrorNote } from "@/components/retail/ui";
import { money as cents } from "@/lib/booking/payments";
import {
  TRANSACTION_STATUS_LABEL,
  membershipsApi,
  type MembershipTransaction,
} from "@/lib/memberships";
import { stripeUrl } from "@/lib/reports/stripeReconcile";
import { CLUB_TIME_ZONE, clubDateTime } from "@/lib/retail/receipt";

/** 타임스탬프 → 클럽 현지 `MM/DD/YYYY h:mm am`. */
function clubStamp(iso: string): string {
  return clubDateTime(new Date(iso).toLocaleDateString("en-CA", { timeZone: CLUB_TIME_ZONE }), iso);
}

/** 온라인 카드 거래(0146). 온라인으로 낸 적이 없는 회원은 아무것도 보이지 않는다. */
export default function OnlineTransactions({ membershipId }: { membershipId: string }) {
  const [rows, setRows] = useState<MembershipTransaction[] | null>(null);
  const [environment, setEnvironment] = useState<"test" | "live" | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    membershipsApi
      .transactions(membershipId)
      .then((list) => {
        if (!cancelled) setRows(list);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    // Stripe 링크만 빠질 뿐 거래는 그대로 보인다.
    membershipsApi
      .stripeEnvironment()
      .then((value) => {
        if (!cancelled) setEnvironment(value);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [membershipId]);

  if (failed) return <ErrorNote>Online transactions could not be loaded.</ErrorNote>;
  if (!rows?.length) return null;

  return (
    <section className="grid gap-2 border border-[#d4d4d8] p-2.5">
      <h3 className="text-xs font-bold">Online transactions</h3>
      {rows.map((row) => (
        <div className="grid gap-0.5 text-xs" key={row.invoice}>
          <div className="flex items-baseline justify-between gap-2">
            <span className="font-bold">{TRANSACTION_STATUS_LABEL[row.status]}</span>
            <span className="font-bold tabular-nums">{cents(row.amount)}</span>
          </div>
          <p className="tabular-nums text-[#3f434a]">
            <span>{clubStamp(row.transacted_at)}</span>
            {row.card_last4 ? (
              <span translate="no">
                {" · "}
                {row.card_brand ?? "Card"} •••• {row.card_last4}
              </span>
            ) : null}
          </p>
          {row.refunded_at ? (
            <p className="tabular-nums text-[#3f434a]">
              <span>Refunded</span> <span>{clubStamp(row.refunded_at)}</span>
            </p>
          ) : null}
          <p className="break-all text-[#6b7280]" translate="no">
            {row.invoice}
            {row.trans_id ? " · " : ""}
            {row.trans_id && environment ? (
              <a className="underline" href={stripeUrl(environment, row.trans_id)} rel="noreferrer" target="_blank">
                {row.trans_id}
              </a>
            ) : (
              row.trans_id
            )}
          </p>
          {row.status !== "approved" && row.status !== "refunded" && row.response_text ? (
            <p className="text-[#8a1f1f]">{row.response_text}</p>
          ) : null}
        </div>
      ))}
    </section>
  );
}
