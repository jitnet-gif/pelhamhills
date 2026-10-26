"use client";

/**
 * 공개 사이트·예약 화면 어디서든 오른쪽 아래에 뜨는 **Hope** 버튼(2026-10-26).
 *
 * 누르면 바로 마이크를 열고 전화와 같은 ElevenLabs 에이전트에 붙는다 — 예약은
 * `VoiceBooking` 이 쓰는 도구 그대로 `backend/api/routes/voice.py` 에서 만들어진다.
 * `/book/tee-time` 에는 같은 위젯이 화면 안에 있으므로 거기서는 띄우지 않는다.
 */

import { usePathname } from "next/navigation";
import { useState } from "react";

import VoiceBooking from "@/components/booking/VoiceBooking";
import { BOOK_TEE_TIME } from "@/lib/nav";

export default function HopeBot() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  if (pathname?.replace(/\/$/, "") === BOOK_TEE_TIME) return null;

  return (
    <div className="fixed bottom-[calc(1rem+env(safe-area-inset-bottom))] right-4 z-40 flex max-w-[calc(100vw-2rem)] flex-col items-end gap-2">
      {open && (
        <div className="w-[22rem] max-w-full shadow-lg">
          {/* 닫으면 VoiceBooking 이 언마운트되며 마이크·세션을 놓는다. */}
          <VoiceBooking autoStart />
        </div>
      )}
      <button
        aria-expanded={open}
        className="tap-target rounded-full bg-[#214d2f] px-5 text-sm font-bold text-white shadow-lg transition hover:bg-[#163820]"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        {open ? "Close Hope" : "🎙 Book with Hope"}
      </button>
    </div>
  );
}
