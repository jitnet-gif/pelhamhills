/**
 * AI Manager Marketing Strategies 를 열 수 있는 계정인가 — 매니저(Reports 명단, 0046)와 0094 의
 * `pelham_ai_marketing_viewers`(admin@ · proshop@ · analysis@). 그 계정에만 어드민 메뉴에 뜬다. 막는 것은
 * 서버다(0094 가 명단 밖 계정에 PT403) — 여기는 메뉴를 가리는 첫 번째 울타리다.
 *
 * `lib/marketing/access.ts` 와 같은 꼴: 계정별로 기억하고, 로그인·로그아웃하면 페이지를 새로 연다.
 */

import { useEffect, useState } from "react";

import { aiMarketingApi } from "./api";

const known = new Map<string, boolean>();

/** null = 아직 모른다(메뉴는 숨긴 채로 둔다). */
export function useAiMarketingAccess(email: string): boolean | null {
  const [allowed, setAllowed] = useState<boolean | null>(() => known.get(email) ?? null);

  useEffect(() => {
    if (known.has(email)) return;
    let cancelled = false;
    aiMarketingApi
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
