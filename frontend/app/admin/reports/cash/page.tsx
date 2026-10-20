"use client";

/**
 * 옛 주소. 현금 리포트는 따로 로그인하는 사이트 `/cash` 로 옮겼다(2026-10-20) — 즐겨찾기가 끊기지 않게 넘긴다.
 * 일반 이동(replace)이라야 `/cash` 가 자기 로그인 칸을 읽는다.
 */

import { useEffect } from "react";

export default function OldCashReportPage() {
  useEffect(() => {
    window.location.replace("/cash");
  }, []);

  return (
    <main className="grid min-h-[100dvh] place-items-center bg-[#f2f2f4] px-4 text-sm text-[#4e5560]">
      <p>
        The cash report moved to <a className="font-semibold text-[#4533ff] underline" href="/cash">/cash</a>.
      </p>
    </main>
  );
}
