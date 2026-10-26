/**
 * 회원 본인의 티타임 요금(0122 `pelham_tee_member_prices`). 로그인 토큰이 먼저, 없으면 이름으로 고른 회원권.
 *
 * 값은 예약 때 서버가 매기는 함수와 같은 것으로 온다 — 트와일라잇 회원이 오후 3시 전이면 퍼블릭가처럼
 * 요금제가 안 맞는 시각은 그 값 그대로다. 0122 전 서버거나 회원권이 없으면 `null` 이고, 화면은 퍼블릭가를 쓴다.
 */

import { useEffect, useState } from "react";

import { bookingRpc } from "@/lib/booking/rpc";

export type MemberSlotPrice = { rate: number; rate9: number; cart: number; cart9: number };
export type MemberPrices = { plan: string; label: string; byTime: Map<string, MemberSlotPrice> };

type Response = { plan?: string; label?: string; times?: (MemberSlotPrice & { time: string })[] };

export function useMemberPrices(date: string, token: string | null, membershipRef: string | null): MemberPrices | null {
  const key = token ? `t:${token}` : membershipRef ? `m:${membershipRef}` : "";
  const [result, setResult] = useState<{ for: string; prices: MemberPrices | null }>({ for: "", prices: null });

  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    const wanted = `${date}|${key}`;
    bookingRpc<Response>("pelham_tee_member_prices", {
      p_date: date,
      p_token: token ?? "",
      p_member: token ? null : membershipRef,
    })
      .then((doc) => {
        if (cancelled) return;
        const prices =
          doc?.plan && Array.isArray(doc.times)
            ? { plan: doc.plan, label: doc.label ?? doc.plan, byTime: new Map(doc.times.map((t) => [t.time, t])) }
            : null;
        setResult({ for: wanted, prices });
      })
      .catch(() => {
        // 0122 가 아직 안 돌았다 — 퍼블릭가로 보이고, 예약 때 서버가 회원 요금을 매긴다.
        if (!cancelled) setResult({ for: wanted, prices: null });
      });
    return () => {
      cancelled = true;
    };
  }, [date, key, token, membershipRef]);

  return key && result.for === `${date}|${key}` ? result.prices : null;
}

/** 이 회원의 그 시각·홀 수 그린피와 카트 1인 요금. 그 시각이 목록에 없으면 null. */
export function memberPriceAt(prices: MemberPrices | null, time: string, holes: 9 | 18) {
  const slot = prices?.byTime.get(time);
  if (!slot) return null;
  return holes === 9 ? { green: slot.rate9, cart: slot.cart9 } : { green: slot.rate, cart: slot.cart };
}
