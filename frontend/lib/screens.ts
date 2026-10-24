/**
 * 화면 권한(0098) — Account Setup 의 체크로 계정마다 준다: Dynamic Pricing, Events, Promotions, Calls & SMS.
 * Marketing 체크도 같은 화면에 있지만 메뉴는 0047 명단을 그대로 읽는다(`lib/marketing/access.ts`).
 *
 * 메뉴를 가리는 것은 여기, 주소로 들어온 계정을 막는 것은 `components/admin/ScreenGate.tsx` 다.
 * 0098 을 아직 안 돌렸으면 "legacy" — 예전처럼 Events · Promotions · Calls 는 직원 모두, Dynamic Pricing 은 Reports.
 *
 * `lib/reports/access.ts` 와 같은 꼴: 계정별로 기억하고, 로그인·로그아웃하면 페이지를 새로 연다.
 */

import { useEffect, useState } from "react";

import { ApiError } from "@/lib/teeSheet/api";
import { staffRpc } from "@/lib/teeSheet/staffRpc";

export type Screen = "dynamic_pricing" | "events" | "promotions" | "calls" | "marketing";

/** Account Setup 체크 순서 = 메뉴 순서. */
export const SCREENS: { key: Screen; label: string; hint: string }[] = [
  { key: "dynamic_pricing", label: "Dynamic Pricing", hint: "green fee rules by day, time and demand" },
  { key: "events", label: "Events", hint: "leagues, tournaments and tee sheet blocks" },
  { key: "promotions", label: "Promotions", hint: "makes promo codes (any cashier can still scan one)" },
  { key: "calls", label: "Calls & SMS", hint: "phone assistant calls, texts and STOP numbers" },
  { key: "marketing", label: "Marketing", hint: "the customer text campaign site" },
];

export type ScreenAccess = Screen[] | "legacy";

export async function fetchScreenAccess(): Promise<ScreenAccess> {
  try {
    return await staffRpc<Screen[]>("pelham_staff_screen_access");
  } catch (cause) {
    if (cause instanceof ApiError && cause.status === 404 && /function|PGRST202|schema cache/i.test(cause.message)) {
      return "legacy";
    }
    throw cause;
  }
}

/** 0098 전이면 legacy 규칙. reportsAllowed 는 Dynamic Pricing 의 예전 규칙에만 쓴다. */
export function canOpen(access: ScreenAccess | null, screen: Screen, reportsAllowed: boolean): boolean | null {
  if (access === null) return null;
  if (access === "legacy") return screen === "dynamic_pricing" ? reportsAllowed : screen !== "marketing";
  return access.includes(screen);
}

const known = new Map<string, ScreenAccess>();

/** null = 아직 모른다(메뉴는 숨긴 채로 둔다). 실패하면 아무 화면도 없는 것으로 본다. */
export function useScreenAccess(email: string): ScreenAccess | null {
  const [access, setAccess] = useState<ScreenAccess | null>(() => known.get(email) ?? null);

  useEffect(() => {
    if (known.has(email)) return;
    let cancelled = false;
    fetchScreenAccess()
      .then((value) => {
        known.set(email, value);
        if (!cancelled) setAccess(value);
      })
      .catch(() => {
        if (!cancelled) setAccess([]);
      });
    return () => {
      cancelled = true;
    };
  }, [email]);

  return access;
}
