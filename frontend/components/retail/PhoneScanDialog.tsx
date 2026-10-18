"use client";

/**
 * 휴대폰을 이 계산대의 스캐너로 쓴다. PC 화면에 QR 을 띄우고, 휴대폰 카메라로 찍으면
 * `/admin/scan?bill=<id>` 가 열려 **이 계산서**에 바로 담는다.
 *
 * 왜 계산서 번호를 싣는가: "지금 채우는 계산서" 는 브라우저마다 localStorage 에 따로 있다
 * (`lib/pos/currentBill.ts`). 번호 없이 휴대폰에서 `/admin/scan` 을 열면 휴대폰이 제 계산서를 새로 연다.
 *
 * 계산서 저장소는 폴링하지 않는다. 휴대폰이 담는 것을 PC 에서 보려면 누군가 다시 읽어야 하므로,
 * 이 창이 떠 있는 동안만 2초마다 다시 읽는다. 닫으면 멈춘다.
 */

import { useEffect, useRef } from "react";

import { billActions, useCurrentBill } from "@/lib/pos/currentBill";
import type { BillStation } from "@/lib/pos/api";
import { ADMIN_SCAN } from "@/lib/nav";
import { formatMoney } from "@/lib/retail/types";

import { Button, ErrorNote, Modal } from "./ui";

const POLL_MS = 2000;
const QR_SIZE = 240;

export default function PhoneScanDialog({ station, onClose }: { station: BillStation; onClose: () => void }) {
  const { bill, billId, error } = useCurrentBill();
  const qrBox = useRef<HTMLDivElement>(null);

  // QR 에 넣을 번호가 있어야 하므로 계산서가 없으면 빈 것을 연다.
  useEffect(() => {
    if (!billId) void billActions.ensure(station);
  }, [billId, station]);

  const link = billId ? `${window.location.origin}${ADMIN_SCAN}?bill=${billId}` : "";

  useEffect(() => {
    const box = qrBox.current;
    if (!box || !link) return;
    let cancelled = false;
    // 카메라 스캐너처럼 이 창을 열 때만 라이브러리를 부른다.
    void import("@zxing/browser").then(({ BrowserQRCodeSvgWriter }) => {
      if (cancelled) return;
      const svg = new BrowserQRCodeSvgWriter().write(link, QR_SIZE, QR_SIZE);
      svg.setAttribute("aria-label", "QR code for phone scanning");
      box.replaceChildren(svg);
    });
    return () => {
      cancelled = true;
    };
  }, [link]);

  // 휴대폰이 담은 줄을 이 화면에 보이게 한다. 탭이 숨겨져 있으면 쉬었다가 돌아오면 바로 읽는다.
  useEffect(() => {
    if (!billId) return;
    const tick = () => {
      if (document.visibilityState === "visible") void billActions.reload();
    };
    const timer = window.setInterval(tick, POLL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [billId]);

  const lines = bill?.lines ?? [];
  const recent = lines.slice(-4).reverse();

  return (
    <Modal onClose={onClose} title="Scan with your phone">
      <div className="grid gap-3">
        <p className="text-sm text-[#3f434a]">
          Point your phone camera at this code, sign in if asked, then scan barcodes. Items go straight onto this bill.
        </p>
        <div className="flex justify-center">
          <div className="flex size-[240px] items-center justify-center bg-white text-sm text-[#6b7280]" ref={qrBox}>
            {link ? null : "Opening a bill…"}
          </div>
        </div>
        {error ? <ErrorNote>{error}</ErrorNote> : null}
        <div className="border border-[#d4d4d8] bg-[#fafafa] p-3">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-xs font-bold text-[#6b7280]">
              {bill ? `Bill #${bill.id} · ${lines.length} line${lines.length === 1 ? "" : "s"}` : "No bill yet"}
            </span>
            <span className="text-lg font-bold tabular-nums">{formatMoney(bill?.total ?? 0)}</span>
          </div>
          {recent.length ? (
            <ul className="mt-2 grid gap-1 text-sm">
              {recent.map((line) => (
                <li className="flex justify-between gap-3" key={line.id}>
                  <span className="min-w-0 truncate">
                    {line.quantity > 1 ? `${line.quantity} × ` : ""}
                    {line.name}
                  </span>
                  <span className="shrink-0 tabular-nums">{formatMoney(line.line_total)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-sm text-[#6b7280]">Waiting for the first scan…</p>
          )}
        </div>
        <Button onClick={onClose} type="button">
          Done
        </Button>
      </div>
    </Modal>
  );
}
