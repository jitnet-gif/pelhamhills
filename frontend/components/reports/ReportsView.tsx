"use client";

/**
 * Reports 의 탭들. 두 화면이 같이 쓴다:
 * - `/admin/reports` — `cash`. Emmeline 계정에만 메뉴가 뜨고 화면이 열린다(2026-10-22, `lib/reports/access.ts`).
 * - `/cash` — `cash`. 현금까지 전부. 따로 로그인하는 현금 리포트 사이트, 현금 리포트 계정(0046 의 명단)만 연다.
 * 서버도 명단 밖 계정에는 현금을 주지 않는다(0046) — 화면에서 거르는 것은 두 번째 울타리다.
 *
 * 탭: Daily close(하루 마감·영수증·환불), Accounting(기간 회계 보고서, 엑셀 모양 + .xlsx 내려받기 —
 * `AccountingWorkbook.tsx`), Stripe check(Stripe 가 받은 카드 돈과 우리 기록 대조 — `StripeReconcile.tsx`),
 * Bookings(실시간 예약 현황 — 들어온 경로별, 웹은 유입 경로까지 — `BookingsReport.tsx`·0067), Change log(모든 변경의 전·후, 지운 것까지 —
 * `ChangeLog.tsx`·0057·0075), Phone callbacks(업무시간 밖 전화에서 직원 전화를 기다리는 손님 —
 * `PhoneCallbacks.tsx`·0059), Rain checks(발행한 레인체크·사용·만료·문자 여부 — `RainChecksReport.tsx`·0062),
 * Register closes(기간 안의 계산대 마감 기록 — 기대 금액·센 돈·과부족·다시 세기, `RegisterClosesReport.tsx`·0065).
 * `?view=closes`·`?view=stripe`·`?view=bookings`·`?view=callbacks`·`?view=rainchecks`·`?view=changes` 로 바로 열 수 있다.
 */

import { useState, type ReactNode } from "react";

import AccountingWorkbook from "@/components/reports/AccountingWorkbook";
import BookingsReport from "@/components/reports/BookingsReport";
import ChangeLog from "@/components/reports/ChangeLog";
import PhoneCallbacks from "@/components/reports/PhoneCallbacks";
import RainChecksReport from "@/components/reports/RainChecksReport";
import RegisterClosesReport from "@/components/reports/RegisterClosesReport";
import SalesReport from "@/components/reports/SalesReport";
import StripeReconcile from "@/components/reports/StripeReconcile";
import { Chip } from "@/components/retail/ui";

const VIEWS = [
  { key: "daily", label: "Daily close" },
  { key: "closes", label: "Register closes" },
  { key: "accounting", label: "Accounting (Excel)" },
  { key: "stripe", label: "Stripe check" },
  { key: "bookings", label: "Bookings (live)" },
  { key: "rainchecks", label: "Rain checks" },
  { key: "callbacks", label: "Phone callbacks" },
  { key: "changes", label: "Change log" },
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
      {/* 모바일은 탭 여덟 개가 네 줄로 쌓이지 않게 가로로 밀어 본다. */}
      <div className="-mx-4 flex items-center gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 sm:pb-0">
        {VIEWS.map((item) => (
          <Chip active={view === item.key} key={item.key} onClick={() => setView(item.key)}>
            {item.label}
          </Chip>
        ))}
        {aside ? <span className="ml-auto">{aside}</span> : null}
      </div>
      {view === "daily" ? (
        <SalesReport cash={cash} />
      ) : view === "closes" ? (
        <RegisterClosesReport cash={cash} />
      ) : view === "accounting" ? (
        <AccountingWorkbook cash={cash} />
      ) : view === "stripe" ? (
        <StripeReconcile />
      ) : view === "changes" ? (
        <ChangeLog />
      ) : view === "callbacks" ? (
        <PhoneCallbacks />
      ) : view === "rainchecks" ? (
        <RainChecksReport />
      ) : (
        <BookingsReport />
      )}
    </div>
  );
}
