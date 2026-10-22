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
 * Emmeline 만 본다(2026-10-22). 메뉴는 그 계정에만 뜨고(`lib/reports/access.ts`), 주소로 들어와도
 * 다른 계정에는 이유만 보여 준다. 그 계정은 현금 리포트 명단(0046)이라 현금까지 전부 보인다 —
 * 따로 로그인하는 `/cash` 도 그대로 있다. 탭은 `components/reports/ReportsView.tsx`.
 */

import AdminShell from "@/components/admin/AdminShell";
import ReportsView from "@/components/reports/ReportsView";
import { getSession } from "@/lib/teeSheet/session";
import { useReportsAccess } from "@/lib/reports/access";

export default function ReportsPage() {
  return (
    <AdminShell title="Reports">
      <ReportsGate />
    </AdminShell>
  );
}

/** AdminShell 이 로그인을 확인한 뒤에야 그려진다 — 그래서 세션의 이메일을 바로 읽어도 된다. */
function ReportsGate() {
  const allowed = useReportsAccess(getSession()?.email ?? "");

  if (allowed === null) return <p className="p-4 text-sm text-[#4e5560]">확인 중…</p>;
  if (!allowed) {
    return (
      <div className="mx-auto grid max-w-md gap-3 p-4">
        <div className="bg-white p-5 text-sm shadow-sm">
          <p className="font-bold">Reports are for Emmeline&apos;s account only.</p>
          <p className="mt-2 text-[#6b7280]">
            Sign out and sign in with Emmeline&apos;s ID to open Reports.
          </p>
        </div>
      </div>
    );
  }
  return <ReportsView cash />;
}
