"use client";

/**
 * Price review — 그날 플레이한 티 타임 중 그린피·카트 요금이 요금표와 다른 선수(0055 `pelham_staff_price_review`).
 * Daily close(`SalesReport`) 안에 붙는다. 날짜는 **플레이 날짜**다(결제한 날이 아니다).
 *
 * 줄마다 무엇이 바뀌었는지(선수별 정정·예약 전체 그린피·카트), 정상가와 받은 값, 차액, 사유, 승인한 매니저를 보여 준다.
 * 선수별 정정의 사유는 티 시트 카드에서 매니저 PIN 을 받기 전에 적은 것이다. 예약 전체 그린피·카트 요금 변경은
 * 사유 칸이 없어서 0024 승인 기록의 매니저만 보인다.
 */

import { useEffect, useState } from "react";

import { staffPriceReview } from "@/lib/teeSheet/staffRpc";
import type { PriceReviewRow } from "@/lib/teeSheet/types";

import { EmptyNote, ErrorNote, Panel, SkeletonRows } from "@/components/retail/ui";

const KIND_LABEL: Record<PriceReviewRow["kind"], string> = {
  player: "Player price",
  reservation: "Reservation rate",
  cart: "Cart fee",
};

function money(value: number): string {
  const sign = value < 0 ? "−" : "";
  return `${sign}$${Math.abs(value).toFixed(2)}`;
}

function clock(iso: string | null): string {
  if (!iso) return "";
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? "" : at.toLocaleString("en-CA", { dateStyle: "short", timeStyle: "short" });
}

export default function PriceReview({ date }: { date: string }) {
  const [rows, setRows] = useState<PriceReviewRow[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setError("");
    staffPriceReview(date, date)
      .then((result) => {
        if (!cancelled) setRows(result ?? []);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setRows([]);
        setError(cause instanceof Error ? cause.message : "Could not load the price review.");
      });
    return () => {
      cancelled = true;
    };
  }, [date]);

  const total = (rows ?? []).reduce((sum, row) => sum + row.difference, 0);

  return (
    <Panel
      actions={
        rows && rows.length > 0 ? (
          <span className="text-xs text-[#8a5a00]">
            {rows.length} to review · {money(Math.round(total * 100) / 100)} vs rate card (tax excl.)
          </span>
        ) : null
      }
      title="Price review — tee times played this day"
    >
      {error ? (
        <ErrorNote>{error}</ErrorNote>
      ) : rows === null ? (
        <SkeletonRows count={3} />
      ) : rows.length === 0 ? (
        <EmptyNote>Every player paid the rate card price.</EmptyNote>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-xs">
            <thead className="text-[11px] uppercase tracking-wide text-[#6b7280]">
              <tr className="border-b border-[#ececf0]">
                <th className="px-2 py-1.5 font-semibold">Tee time</th>
                <th className="px-2 py-1.5 font-semibold">Player</th>
                <th className="px-2 py-1.5 font-semibold">Change</th>
                <th className="px-2 py-1.5 text-right font-semibold">Rate card</th>
                <th className="px-2 py-1.5 text-right font-semibold">Charged</th>
                <th className="px-2 py-1.5 text-right font-semibold">Diff.</th>
                <th className="px-2 py-1.5 font-semibold">Reason</th>
                <th className="px-2 py-1.5 font-semibold">Approved by</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr className="border-b border-[#f2f2f4] align-top" key={`${row.bookingId}-${row.playerId}`}>
                  <td className="px-2 py-1.5 tabular-nums">
                    {row.time}
                    <span className="block text-[11px] text-[#6b7280]">
                      {row.holes} holes{row.code ? ` · ${row.code}` : ""}
                    </span>
                  </td>
                  <td className="px-2 py-1.5">
                    {row.player}
                    <span className="block text-[11px] text-[#6b7280]">
                      {row.ratePlan || "Public"}
                      {row.paid ? " · paid" : ""}
                    </span>
                  </td>
                  <td className="px-2 py-1.5">
                    <span className="bg-[#fff1cc] px-1 py-0.5 text-[11px] font-semibold text-[#8a5a00]">
                      {KIND_LABEL[row.kind]}
                    </span>
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">
                    {money(row.greenStandard)}
                    {row.cartStandard || row.cartCharged ? (
                      <span className="block text-[11px] text-[#6b7280]">cart {money(row.cartStandard)}</span>
                    ) : null}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">
                    {money(row.greenCharged)}
                    {row.cartStandard || row.cartCharged ? (
                      <span className="block text-[11px] text-[#6b7280]">cart {money(row.cartCharged)}</span>
                    ) : null}
                  </td>
                  <td
                    className={`px-2 py-1.5 text-right font-semibold tabular-nums ${
                      row.difference < 0 ? "text-[#b42318]" : "text-[#1f2328]"
                    }`}
                  >
                    {money(row.difference)}
                  </td>
                  <td className="px-2 py-1.5">{row.reason || <span className="text-[#9aa0a6]">—</span>}</td>
                  <td className="px-2 py-1.5">
                    {row.manager || <span className="text-[#b42318]">No approval on record</span>}
                    {row.approvedAt ? (
                      <span className="block text-[11px] text-[#6b7280]">{clock(row.approvedAt)}</span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
