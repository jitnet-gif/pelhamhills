/**
 * Reports 를 볼 수 있는 계정인가 — Emmeline 만(2026-10-22 클럽 결정).
 *
 * 명단은 현금 리포트와 같다(0046 의 `pelham_cash_viewers`, 지금은 admin@pelhamhills.ca 하나). 평소에는
 * 메뉴에서 Reports 를 숨기고, 그 계정으로 로그인하면 메뉴에 뜬다. 숫자를 막는 것은 서버다(0046) —
 * 여기는 메뉴와 화면을 가리는 첫 번째 울타리다.
 *
 * 화면을 옮길 때마다 묻지 않게 계정별로 기억한다. 로그인·로그아웃하면 페이지를 새로 열므로(AdminShell)
 * 앞 계정의 답이 남지 않는다.
 */

import { useEffect, useState } from "react";

import retailApi from "@/lib/retail/api";

const known = new Map<string, boolean>();

/** null = 아직 모른다(메뉴는 숨긴 채로 둔다). */
export function useReportsAccess(email: string): boolean | null {
  const [allowed, setAllowed] = useState<boolean | null>(() => known.get(email) ?? null);

  useEffect(() => {
    if (known.has(email)) return;
    let cancelled = false;
    retailApi
      .cashAccess()
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
