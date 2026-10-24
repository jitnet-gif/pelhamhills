"use client";

/**
 * 옛 주소. Business Intelligence 는 AI Manager Marketing Strategies(`/admin/ai-marketing`)로 바뀌었다(2026-10-24) —
 * 즐겨찾기가 끊기지 않게 넘긴다.
 */

import { useEffect } from "react";

import { ADMIN_AI_MARKETING } from "@/lib/nav";

export default function OldBusinessIntelligencePage() {
  useEffect(() => {
    window.location.replace(ADMIN_AI_MARKETING);
  }, []);

  return (
    <main className="grid min-h-[100dvh] place-items-center bg-[#f2f2f4] px-4 text-sm text-[#4e5560]">
      <p>
        Business Intelligence is now{" "}
        <a className="font-semibold text-[#4533ff] underline" href={ADMIN_AI_MARKETING}>
          AI Manager Marketing Strategies
        </a>
        .
      </p>
    </main>
  );
}
