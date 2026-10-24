"use client";

/**
 * Cancels & voids — 그 날 취소된 것을 한 칸에(2026-10-23). Daily close 의 카드 매출 칸 아래.
 *
 * 1. 환불한 계산서 — 그 날 계산서 목록(`sales`)에서 refunded 인 것. 매출에서는 서버가 이미 뺐다.
 * 2. void 한 계산서 — 결제 전에 지운 계산서(0088). 영수증 번호·영업일이 없어 매출 리포트 어디에도 없었다.
 *    void 한 시각의 클럽 날짜로 묶는다.
 * 3. 예약 취소 — 그 날 **플레이** 하기로 했던 티 타임·실내 베이 예약 중 취소된 것(Bookings 탭과 같은 날짜 기준).
 *    한 예약 안에서 몇 사람만 뺀 것도 따로 센다.
 * 카드 쪽 취소(Stripe 의 Canceled·거절, 단말기 VOID)는 위 Card & debit 칸과 Stripe check 에 있다.
 *
 * 세 목록은 따로 읽는다 — 하나가 실패해도(0088 전 등) 나머지는 보인다.
 */

import { useEffect, useMemo, useState, type ReactNode } from "react";

import retailApi, { toRetailError } from "@/lib/retail/api";
import { PAYMENT_LABELS, stationLabel } from "@/lib/retail/receipt";
import { formatMoney, type Sale, type VoidBill } from "@/lib/retail/types";
import { describeSimError, simApi, type SimReservation } from "@/lib/simulator/api";
import { staffBookings } from "@/lib/teeSheet/staffRpc";
import type { TeeBooking } from "@/lib/teeSheet/types";
import { clubTime } from "@/lib/reports/stripeReconcile";

import { Button, EmptyNote, ErrorNote, Panel, SkeletonRows } from "@/components/retail/ui";

type Loaded<T> = { key: string; rows: T[]; error: string };

function useList<T>(key: string, load: () => Promise<T[]>, describe: (cause: unknown) => string) {
  const [loaded, setLoaded] = useState<Loaded<T> | null>(null);
  useEffect(() => {
    let cancelled = false;
    load()
      .then((rows) => {
        if (!cancelled) setLoaded({ key, rows, error: "" });
      })
      .catch((cause) => {
        if (!cancelled) setLoaded({ key, rows: [], error: describe(cause) });
      });
    return () => {
      cancelled = true;
    };
    // `load` 은 매번 새 함수다 — key 가 바뀔 때만 다시 읽는다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return loaded?.key === key ? loaded : null;
}

const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : "Could not load.");

export default function Cancellations({
  date,
  sales,
  onOpenSale,
}: {
  date: string;
  sales: readonly Sale[];
  onOpenSale: (sale: Sale) => void;
}) {
  const [nonce, setNonce] = useState(0);
  const key = `${date}#${nonce}`;
  const voids = useList<VoidBill>(key, () => retailApi.listVoidBills(date), (cause) => toRetailError(cause).message);
  const tee = useList<TeeBooking>(key, () => staffBookings(date, date), errorText);
  const bays = useList<SimReservation>(key, () => simApi.reservations(date), describeSimError);

  const refunds = useMemo(
    () => sales.filter((sale) => sale.refunded_at || sale.status === "refunded"),
    [sales],
  );
  const teeCancelled = useMemo(
    () => (tee?.rows ?? []).filter((b) => b.status === "cancelled" && b.source !== "voice_hold"),
    [tee],
  );
  // 예약은 그대로인데 몇 사람만 취소된 것.
  const playersDropped = useMemo(
    () =>
      (tee?.rows ?? [])
        .filter((b) => b.status !== "cancelled" && b.status !== "blocked")
        .flatMap((b) => b.players.filter((p) => p.cancelled).map((p) => ({ booking: b, player: p }))),
    [tee],
  );
  const bayCancelled = useMemo(() => (bays?.rows ?? []).filter((r) => r.status === "cancelled"), [bays]);

  const refundTotal = refunds.reduce((sum, sale) => sum + sale.total, 0);
  const voidTotal = (voids?.rows ?? []).reduce((sum, bill) => sum + bill.total, 0);

  return (
    <Panel
      actions={<Button onClick={() => setNonce((value) => value + 1)}>Refresh</Button>}
      title={`Cancels & voids — ${date}`}
    >
      <div className="grid gap-4 lg:grid-cols-3">
        <Section count={refunds.length} hint="already taken out of sales" title="Refunded sales" total={refundTotal}>
          {refunds.length === 0 ? (
            <EmptyNote>No refunds.</EmptyNote>
          ) : (
            <ul className="grid gap-1">
              {refunds.map((sale) => (
                <li key={sale.id}>
                  <button className={ROW} onClick={() => onOpenSale(sale)} type="button">
                    <span className="min-w-0">
                      <span className="block font-semibold">{sale.receipt_no}</span>
                      <span className="block text-xs text-[#6b7280]">
                        {[
                          clubTime(sale.refunded_at),
                          sale.payment_method ? PAYMENT_LABELS[sale.payment_method] : "",
                          sale.refund_reason,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </span>
                    <span className="shrink-0 tabular-nums">{formatMoney(sale.total)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section
          count={voids?.rows.length ?? 0}
          hint="deleted before payment · never in sales"
          title="Voided bills"
          total={voidTotal}
        >
          {!voids ? (
            <SkeletonRows count={2} />
          ) : voids.error ? (
            <ErrorNote>{voids.error}</ErrorNote>
          ) : voids.rows.length === 0 ? (
            <EmptyNote>No voided bills.</EmptyNote>
          ) : (
            <ul className="grid gap-1">
              {voids.rows.map((bill) => (
                <li className="flex items-baseline justify-between gap-2 py-0.5" key={bill.id}>
                  <span className="min-w-0">
                    <span className="block font-semibold">
                      {bill.label || `Bill #${bill.id}`}{" "}
                      <span className="text-xs font-normal text-[#6b7280]">{stationLabel(bill.station)}</span>
                    </span>
                    <span className="block text-xs text-[#6b7280]">
                      {[clubTime(bill.voided_at), bill.cashier, linesText(bill)].filter(Boolean).join(" · ")}
                    </span>
                  </span>
                  <span className="shrink-0 tabular-nums">{formatMoney(bill.total)}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section
          count={teeCancelled.length + bayCancelled.length}
          hint="bookings for this play date"
          title="Cancelled bookings"
        >
          {!tee || !bays ? (
            <SkeletonRows count={2} />
          ) : (
            <div className="grid gap-2">
              {tee.error ? <ErrorNote>Tee sheet: {tee.error}</ErrorNote> : null}
              {bays.error ? <ErrorNote>Indoor bays: {bays.error}</ErrorNote> : null}
              {teeCancelled.length + bayCancelled.length + playersDropped.length === 0 ? (
                <EmptyNote>No cancellations.</EmptyNote>
              ) : (
                <ul className="grid gap-1">
                  {teeCancelled.map((booking) => {
                    const lead = booking.players[0];
                    const paid = booking.players.some((p) => p.paid);
                    return (
                      <li className="py-0.5" key={`tee-${booking.id}`}>
                        <span className="block font-semibold">
                          {booking.time} tee time · {booking.title || lead?.name || "—"}
                        </span>
                        <span className="block text-xs text-[#6b7280]">
                          {[
                            `${booking.players.length} player(s)`,
                            booking.source === "web" ? "Online" : booking.source === "voice" ? "Phone AI" : "",
                            paid ? "was paid — check the refund" : "",
                            booking.cancelReason,
                            booking.confirmationCode,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      </li>
                    );
                  })}
                  {bayCancelled.map((reservation) => (
                    <li className="py-0.5" key={`bay-${reservation.id}`}>
                      <span className="block font-semibold">
                        {reservation.start_time} indoor bay · {reservation.customer_name || "—"}
                      </span>
                      <span className="block text-xs text-[#6b7280]">
                        {[`${reservation.duration_hours}h`, `${reservation.player_count} player(s)`, reservation.confirmation_code]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </li>
                  ))}
                  {playersDropped.map(({ booking, player }) => (
                    <li className="py-0.5" key={`player-${booking.id}-${player.id}`}>
                      <span className="block">
                        {booking.time} tee time · {player.name || "Player"} dropped
                      </span>
                      <span className="block text-xs text-[#6b7280]">
                        {[booking.title, player.paid ? "was paid — check the refund" : ""].filter(Boolean).join(" · ")}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </Section>
      </div>
    </Panel>
  );
}

function Section({
  title,
  hint,
  count,
  total,
  children,
}: {
  title: string;
  hint: string;
  count: number;
  total?: number;
  children: ReactNode;
}) {
  return (
    <section className="grid min-w-0 content-start gap-2 text-sm">
      <header className="flex items-baseline justify-between gap-2 border-b border-[#ececf0] pb-1">
        <span className="min-w-0">
          <h3 className="font-bold">
            {title} <span className="text-xs font-normal text-[#6b7280]">×{count}</span>
          </h3>
          <span className="block text-[11px] text-[#6b7280]">{hint}</span>
        </span>
        {total !== undefined ? <span className="shrink-0 font-bold tabular-nums">{formatMoney(total)}</span> : null}
      </header>
      {children}
    </section>
  );
}

const ROW = "flex w-full items-baseline justify-between gap-2 py-0.5 text-left hover:text-[#4533ff]";

function linesText(bill: VoidBill): string {
  const names = bill.lines.map((line) => (line.quantity > 1 ? `${line.name} ×${line.quantity}` : line.name));
  return names.length > 3 ? `${names.slice(0, 3).join(", ")} +${names.length - 3}` : names.join(", ");
}
