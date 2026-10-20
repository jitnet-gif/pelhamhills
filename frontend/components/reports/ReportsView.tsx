"use client";

/**
 * Reports 의 탭 네 개. 두 화면이 같이 쓴다:
 * - `/admin/reports`      — `cash={false}`. 현금 숫자(By payment 의 Cash, 담당자별 마감, 회계 보고서의 Cash 칸)가 없다.
 * - `/cash` — `cash`. 현금까지 전부. 따로 로그인하는 현금 리포트 사이트, 현금 리포트 계정(0046 의 명단)만 연다.
 * 서버도 명단 밖 계정에는 현금을 주지 않는다(0046) — 화면에서 거르는 것은 두 번째 울타리다.
 *
 * 탭: Daily close(하루 마감·영수증·환불), Accounting(기간 회계 보고서, 엑셀 모양 + .xlsx 내려받기 —
 * `AccountingWorkbook.tsx`), Stripe check(Stripe 가 받은 카드 돈과 우리 기록 대조 — `StripeReconcile.tsx`),
 * Bookings(웹사이트·전화로 들어온 티 타임·베이 예약 — `BookingsReport.tsx`). `?view=stripe`·`?view=bookings` 로 바로 열 수 있다.
 */

import { useState, type ReactNode } from "react";

import AccountingWorkbook from "@/components/reports/AccountingWorkbook";
import BookingsReport from "@/components/reports/BookingsReport";
import SalesReport from "@/components/reports/SalesReport";
import StripeReconcile from "@/components/reports/StripeReconcile";
import { Chip } from "@/components/retail/ui";

const VIEWS = [
  { key: "daily", label: "Daily close" },
  { key: "accounting", label: "Accounting (Excel)" },
  { key: "stripe", label: "Stripe check" },
  { key: "bookings", label: "Bookings (web + phone)" },
] as const;

type View = (typeof VIEWS)[number]["key"];

/** `aside` = 탭 줄 오른쪽 끝(예: 현금 리포트로 가는 링크). */
export default function ReportsView({ cash, aside }: { cash: boolean; aside?: ReactNode }) {
  const [view, setView] = useState<View>(() => {
    const wanted = typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("view");
    return VIEWS.find((item) => item.key === wanted)?.key ?? "daily";
  });

  return (
    <div className="grid min-w-0 gap-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        {VIEWS.map((item) => (
          <Chip active={view === item.key} key={item.key} onClick={() => setView(item.key)}>
            {item.label}
          </Chip>
        ))}
        {aside ? <span className="ml-auto">{aside}</span> : null}
      </div>
      {view === "daily" ? (
        <SalesReport cash={cash} />
      ) : view === "accounting" ? (
        <AccountingWorkbook cash={cash} />
      ) : view === "stripe" ? (
        <StripeReconcile />
      ) : (
        <BookingsReport />
      )}
    </div>
  );
}
