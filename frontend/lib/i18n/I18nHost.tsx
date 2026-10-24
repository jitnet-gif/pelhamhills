"use client";

/**
 * 한/영 전환을 켜는 자리(루트 레이아웃). 화면에는 아무것도 그리지 않는다 — 엔진은 `engine.ts`.
 * 한국어 사전은 크니까 한국어를 고른 사람만 내려받는다.
 */

import { useEffect } from "react";

import en from "./en.json";
import { startI18n } from "./engine";

export default function I18nHost() {
  useEffect(() => {
    startI18n({ en, ko: () => import("./ko.json").then((m) => m.default) });
  }, []);
  return null;
}
