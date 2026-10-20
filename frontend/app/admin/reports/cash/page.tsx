"use client";

/**
 * 현금 리포트 — `/admin/reports` 와 같은 탭에 현금까지(By payment 의 Cash, 담당자별 마감·서랍 현금·팁 나누기,
 * 회계 보고서의 Cash 칸). 현금 리포트 계정(0046 의 `pelham_cash_viewers`, 지금은 Emmeline 의
 * admin@pelhamhills.ca — 로그인 아이디 `emmeline`)만 연다.
 *
 * 막는 것은 서버다(0046): 명단 밖 계정은 현금 줄을 받지 못하고 담당자별 마감 함수는 거절한다. 이 화면의
 * 확인은 그 계정이 아닌 사람에게 빈 리포트 대신 이유를 보여 주려는 것이다.
 */

import Link from "next/link";
import { useEffect, useState } from "react";

import AdminShell from "@/components/admin/AdminShell";
import ReportsView from "@/components/reports/ReportsView";
import { ErrorNote, Panel, SkeletonRows } from "@/components/retail/ui";
import retailApi, { toRetailError } from "@/lib/retail/api";

type Access = { state: "checking" } | { state: "allowed" } | { state: "denied" } | { state: "error"; message: string };

export default function CashReportPage() {
  const [access, setAccess] = useState<Access>({ state: "checking" });

  useEffect(() => {
    let cancelled = false;
    retailApi
      .cashAccess()
      .then((allowed) => {
        if (!cancelled) setAccess({ state: allowed ? "allowed" : "denied" });
      })
      .catch((cause) => {
        if (!cancelled) setAccess({ state: "error", message: toRetailError(cause).message });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <AdminShell title="Cash report">
      {access.state === "allowed" ? (
        <ReportsView
          aside={
            <Link className="text-sm font-semibold text-[#4533ff] hover:underline" href="/admin/reports">
              ← Reports without cash
            </Link>
          }
          cash
        />
      ) : (
        <div className="grid min-w-0 gap-3 p-4 sm:max-w-xl">
          {access.state === "checking" ? (
            <SkeletonRows count={3} />
          ) : access.state === "error" ? (
            <ErrorNote>{access.message}</ErrorNote>
          ) : (
            <Panel title="Cash report">
              <div className="grid gap-2 p-3 text-sm">
                <p>Only the cash report account can open this page.</p>
                <p className="text-[#6b7280]">
                  Sign in with that account to see cash totals, drawer counts and the tip split. Everything else is
                  on{" "}
                  <Link className="font-semibold text-[#4533ff] hover:underline" href="/admin/reports">
                    Reports
                  </Link>
                  .
                </p>
              </div>
            </Panel>
          )}
        </div>
      )}
    </AdminShell>
  );
}
