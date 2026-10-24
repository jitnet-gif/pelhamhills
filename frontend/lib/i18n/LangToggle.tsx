"use client";

/** 한/영 전환 버튼. 누를 때마다 English ↔ 한국어. 고른 언어는 이 브라우저에 남는다. */

import { useSyncExternalStore } from "react";

import { getLang, onLangChange, toggleLang } from "./engine";

export default function LangToggle({ className = "" }: { className?: string }) {
  const lang = useSyncExternalStore(onLangChange, getLang, () => "en" as const);
  return (
    <button
      aria-label={lang === "ko" ? "Switch to English" : "한국어로 보기"}
      className={`shrink-0 font-bold ${className}`}
      onClick={toggleLang}
      title={lang === "ko" ? "English" : "한국어"}
      translate="no"
      type="button"
    >
      <span className={lang === "en" ? "" : "opacity-50"}>EN</span>
      <span className="opacity-40"> / </span>
      <span className={lang === "ko" ? "" : "opacity-50"}>한</span>
    </button>
  );
}
