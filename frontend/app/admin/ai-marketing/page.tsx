"use client";

/**
 * AI Manager Marketing Strategies — 옛 Business Intelligence 자리(2026-10-24). 예전 화면은 코드에 적어 둔
 * 예시 숫자뿐이었다. 지금은 1단계: 고객 분석(0094). 다음: 예상 매출, Claude 의 사실·제안, 마케팅 믹스 보드.
 *
 * 매니저(Reports 명단)와 admin@ · proshop@ · analysis@ 만 본다. 메뉴는 그 계정에만 뜨고(`lib/aiMarketing/access.ts`),
 * 주소로 들어와도 다른 계정에는 이유만 보여 준다. 숫자를 막는 것은 서버다(0094).
 */

import AdminShell from "@/components/admin/AdminShell";
import AiMarketingView from "@/components/aiMarketing/AiMarketingView";
import { useAiMarketingAccess } from "@/lib/aiMarketing/access";
import { getSession } from "@/lib/teeSheet/session";

export default function AiMarketingPage() {
  return (
    <AdminShell title="AI Manager Marketing Strategies">
      <AiMarketingGate />
    </AdminShell>
  );
}

/** AdminShell 이 로그인을 확인한 뒤에야 그려진다 — 그래서 세션의 이메일을 바로 읽어도 된다. */
function AiMarketingGate() {
  const allowed = useAiMarketingAccess(getSession()?.email ?? "");

  if (allowed === null) return <p className="p-4 text-sm text-[#4e5560]">확인 중…</p>;
  if (!allowed) {
    return (
      <div className="mx-auto grid max-w-md gap-3 p-4">
        <div className="bg-white p-5 text-sm shadow-sm">
          <p className="font-bold">AI Manager is for managers and the marketing accounts only.</p>
          <p className="mt-2 text-[#6b7280]">
            Sign in with a manager account, admin@, proshop@ or analysis@pelhamhills.ca to open it.
          </p>
        </div>
      </div>
    );
  }
  return <AiMarketingView />;
}
