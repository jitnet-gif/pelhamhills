/**
 * 고객 마케팅(/marketing)을 열 수 있는 계정인가 — 0047 의 `pelham_marketing_viewers` 명단(지금은
 * admin@pelhamhills.ca). 그 계정으로 로그인했을 때만 어드민 메뉴에 Marketing 이 뜬다. 막는 것은 서버다
 * (0047 이 명단 밖 계정에 PT403) — 여기는 메뉴를 가리는 첫 번째 울타리다.
 *
 * `lib/reports/access.ts` 와 같은 꼴: 계정별로 기억하고, 로그인·로그아웃하면 페이지를 새로 연다.
 */

import { useEffect, useState } from "react";

import { marketingApi } from "./api";

const known = new Map<string, boolean>();

/** null = 아직 모른다(메뉴는 숨긴 채로 둔다). */
export function useMarketingAccess(email: string): boolean | null {
  const [allowed, setAllowed] = useState<boolean | null>(() => known.get(email) ?? null);

  useEffect(() => {
    if (known.has(email)) return;
    let cancelled = false;
    marketingApi
      .access()
      .then((value) => {
        known.set(email, value);
        if (!cancelled) setAllowed(value);
      })
      .catch(() => {
        if (!cancelled) setAllowed(false);
      });
    return () => {
      cancelled = true;
    };
  }, [email]);

  return allowed;
}
