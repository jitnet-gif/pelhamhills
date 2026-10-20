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
 * 현금은 여기 없다(2026-10-19). 현금까지 든 리포트는 따로 로그인하는 사이트 `/cash` 에서 현금 리포트
 * 계정만 본다(2026-10-20). 여기 로그인한 계정이 그 계정일 때만 오른쪽 위에 링크가 뜬다 — 그래도 `/cash` 는
 * 자기 로그인을 따로 묻는다. 탭은 `components/reports/ReportsView.tsx`.
 */

import { useEffect, useState } from "react";

import AdminShell from "@/components/admin/AdminShell";
import ReportsView from "@/components/reports/ReportsView";
import retailApi from "@/lib/retail/api";

export default function ReportsPage() {
  const [cashAccess, setCashAccess] = useState(false);

  useEffect(() => {
    let cancelled = false;
    retailApi
      .cashAccess()
      .then((allowed) => {
        if (!cancelled) setCashAccess(allowed);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <AdminShell title="Reports">
      <ReportsView
        aside={
          cashAccess ? (
            // 일반 <a>: 페이지를 새로 열어야 `/cash` 의 따로 된 로그인 칸을 읽는다.
            <a className="text-sm font-semibold text-[#4533ff] hover:underline" href="/cash">
              Cash report →
            </a>
          ) : null
        }
        cash={false}
      />
    </AdminShell>
  );
}
