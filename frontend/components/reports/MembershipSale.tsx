"use client";

/**
 * 리포트의 회원권 줄을 눌렀을 때 — 영수증 대신 그 돈이 어느 회원의 것인지와 회원의 거래를 보여 준다.
 * 회원 찾는 규칙은 `membershipsForSale`. 못 찾으면 그렇게 말한다: 어느 회원 돈인지 모르는 매출이다.
 */

import Link from "next/link";
import { useEffect, useState } from "react";

import OnlineTransactions from "@/components/memberships/OnlineTransactions";
import { Modal } from "@/components/retail/ui";
import {
  STATUS_LABEL,
  balance,
  membershipsApi,
  membershipsForSale,
  money,
  typeInfo,
  type Membership,
} from "@/lib/memberships";
import { PAYMENT_LABELS, usDate } from "@/lib/retail/receipt";
import { formatMoney, type Sale, type SaleLine } from "@/lib/retail/types";

export type MembershipSaleRow = { sale: Sale; line: SaleLine };

export default function MembershipSale({
  row: { sale, line },
  onOpenReceipt,
  onClose,
}: {
  row: MembershipSaleRow;
  onOpenReceipt: () => void;
  onClose: () => void;
}) {
  const [found, setFound] = useState<{ rows: Membership[]; exact: boolean } | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // 시즌 전에 다음 해 회원권을 판다. 그 해와 다음 해 명부를 함께 본다.
    const year = Number(sale.business_date.slice(0, 4));
    Promise.all([membershipsApi.list(year), membershipsApi.list(year + 1)])
      .then(([current, next]) => {
        if (!cancelled) setFound(membershipsForSale([...next, ...current], sale, line));
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [sale, line]);

  return (
    <Modal onClose={onClose} title="Member transactions">
      <div className="grid gap-3">
        <section className="grid gap-1 border border-[#d4d4d8] p-2.5">
          <div className="flex items-baseline justify-between gap-2">
            <span className="min-w-0 truncate text-sm font-bold">{line.name}</span>
            <span className="shrink-0 text-sm font-bold tabular-nums">{formatMoney(sale.total)}</span>
          </div>
          <p className="text-xs text-[#3f434a]">
            {usDate(sale.business_date)} · <span translate="no">{sale.receipt_no}</span>
          </p>
          {(sale.payments ?? []).map((payment, index) => (
            <p className="text-xs text-[#3f434a]" key={index}>
              <span>{PAYMENT_LABELS[payment.method]}</span>
              <span className="tabular-nums" translate="no">
                {payment.card_last4 ? ` •••• ${payment.card_last4}` : ""}
                {payment.auth_code ? ` · ${payment.auth_code}` : ""}
                {` · ${formatMoney(payment.amount)}`}
              </span>
            </p>
          ))}
        </section>

        {failed ? (
          <p className="text-sm text-[#8a1f1f]">The membership list could not be loaded.</p>
        ) : !found ? (
          <p className="text-sm text-[#6b7280]">Loading…</p>
        ) : found.rows.length === 0 ? (
          <p className="border border-[#e0b4b4] bg-[#fdf3f3] p-2.5 text-sm text-[#8a1f1f]">
            No member is linked to this receipt. Add the receipt number to the member&apos;s notes in Memberships to link it.
          </p>
        ) : (
          <>
            {found.exact ? null : (
              <p className="text-xs font-bold text-[#8a5a00]">
                Possible match — same date and amount. Add the receipt number to the member&apos;s notes to confirm.
              </p>
            )}
            {found.rows.map((member) => (
              <MemberBlock key={member.id} member={member} />
            ))}
          </>
        )}

        <div className="grid grid-cols-2 gap-2">
          <button className="border border-[#d4d4d8] px-3 py-2 text-sm font-bold hover:border-[#4533ff]" onClick={onOpenReceipt} type="button">
            Open receipt
          </button>
          <Link className="border border-[#d4d4d8] px-3 py-2 text-center text-sm font-bold hover:border-[#4533ff]" href="/admin/memberships">
            Memberships
          </Link>
        </div>
      </div>
    </Modal>
  );
}

function MemberBlock({ member }: { member: Membership }) {
  const owing = balance(member);
  return (
    <section className="grid gap-2">
      <div className="grid gap-1 border border-[#d4d4d8] p-2.5 text-xs">
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="min-w-0 truncate text-sm font-bold">{member.member_name}</h3>
          <span className="shrink-0 font-bold">{STATUS_LABEL[member.status]}</span>
        </div>
        <p className="text-[#3f434a]">
          <span className="tabular-nums">{member.season}</span> <span className="font-bold">{typeInfo(member.membership_type).label}</span>{" "}
          · {member.plan === "spousal" ? "Spousal" : "Single"}
        </p>
        <p className="tabular-nums">
          {owing > 0 ? (
            <span className="font-bold text-[#8a1f1f]">{money(owing)} owing</span>
          ) : (
            <span className="font-bold text-[#1f6b3a]">Paid {money(member.amount_paid)}</span>
          )}
          <span className="text-[#6b7280]"> of {money(member.amount_due)}</span>
          {member.paid_on ? <span className="text-[#6b7280]"> · {usDate(member.paid_on)}</span> : null}
          {member.payment_method ? <span className="text-[#6b7280]"> · {member.payment_method}</span> : null}
        </p>
        {member.notes ? <p className="whitespace-pre-wrap text-[#3f434a]">{member.notes}</p> : null}
      </div>
      <OnlineTransactions membershipId={member.id} />
    </section>
  );
}
