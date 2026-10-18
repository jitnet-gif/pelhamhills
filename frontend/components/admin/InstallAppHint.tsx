"use client";

import { useInstallPrompt } from "@/hooks/useInstallPrompt";

/**
 * 어드민 사이드바·서랍 아래의 "앱으로 설치". 맥 Chrome 이면 버튼 하나로 설치 창이 뜨고,
 * 아이패드면 공유 메뉴 안내를 보인다. 이미 앱 창이면 아무것도 그리지 않는다.
 */
export default function InstallAppHint({ className = "" }: { className?: string }) {
  const { ready, standalone, ios, install } = useInstallPrompt();
  if (!ready || standalone) return null;

  if (install) {
    return (
      <button
        className={`min-h-10 bg-[#4533ff] px-3 text-[11px] font-bold text-white hover:bg-[#3a2ae0] ${className}`}
        onClick={install}
        type="button"
      >
        Install Pelham Staff app
      </button>
    );
  }

  return (
    <p className={`border border-white/15 px-3 py-2 text-[10px] leading-relaxed text-white/60 ${className}`}>
      {ios
        ? "Install as an app: tap Share (⬆), then Add to Home Screen."
        : "Install as an app: Chrome menu ⋮ → Cast, save, and share → Install page as app."}
    </p>
  );
}
