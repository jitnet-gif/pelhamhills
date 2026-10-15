"use client";

/**
 * 클럽 종합 매출 보고서 — 티 시트·실내 베이·스낵바·프로 샵 리테일을 한 화면에. 매출을 보는
 * 곳은 여기 하나다(리테일 작업 화면의 Sales 탭은 이리로 오는 링크가 됐다).
 *
 * 세 사업부 메뉴의 "Reports" 가 모두 여기로 온다. 예전 이 화면은 숫자가 전부 박혀 있는
 * 샘플(매출 $8,421, 가운데 표의 손님까지)이라, 실제로 무엇이 팔렸든 늘 같은 값을 보여 줬다.
 *
 * 매출은 계산서 한 장부(`pelham_bills`, 0005)에 모두 모인다. 사업부는 팔린 것(분류)으로
 * 나눈다 — `lib/retail/divisions.ts`. 여기는 데모로 내려가지 않는다: 서버가 안 되면 오류를
 * 보여 준다. 가짜 숫자 옆의 진짜 숫자가 이 화면이 고치려던 바로 그 문제다.
 *
 * 탭 세 개: Daily close(하루 마감·영수증·환불), Accounting(기간 회계 보고서, 엑셀 모양 +
 * .xlsx 내려받기 — `components/reports/AccountingWorkbook.tsx`), Stripe check(Stripe 가 받은 카드 돈과
 * 우리 기록 대조 — `components/reports/StripeReconcile.tsx`). `?view=stripe` 로 바로 열 수 있다.
 */

import { useState } from "react";

import AdminShell from "@/components/admin/AdminShell";
import AccountingWorkbook from "@/components/reports/AccountingWorkbook";
import SalesReport from "@/components/reports/SalesReport";
import StripeReconcile from "@/components/reports/StripeReconcile";
import { Chip } from "@/components/retail/ui";

const VIEWS = [
  { key: "daily", label: "Daily close" },
  { key: "accounting", label: "Accounting (Excel)" },
  { key: "stripe", label: "Stripe check" },
] as const;

type View = (typeof VIEWS)[number]["key"];

export default function ReportsPage() {
  const [view, setView] = useState<View>(() => {
    const wanted = typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("view");
    return VIEWS.find((item) => item.key === wanted)?.key ?? "daily";
  });

  return (
    <AdminShell title="Reports">
      <div className="grid min-w-0 gap-3 p-4">
        <div className="flex flex-wrap gap-2">
          {VIEWS.map((item) => (
            <Chip active={view === item.key} key={item.key} onClick={() => setView(item.key)}>
              {item.label}
            </Chip>
          ))}
        </div>
        {view === "daily" ? <SalesReport /> : view === "accounting" ? <AccountingWorkbook /> : <StripeReconcile />}
      </div>
    </AdminShell>
  );
}
