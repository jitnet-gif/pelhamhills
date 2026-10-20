"use client";

// 새 예약 창의 이름 칸 아래에 뜨는 회원 자동검색(0053 `pelham_staff_customer_search`).
// 이름을 치면 고객 명부·회원권 명부에서 찾고, 고르면 이름·연락처·요금제가 채워진다.

import { useEffect, useState } from "react";

import { staffRpc } from "@/lib/teeSheet/staffRpc";

/** `pelham_staff_customer_search` 한 줄. */
export type MemberHit = {
  customerRef: string | null;
  name: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  memberNumber: string;
  isMember: boolean;
  season: number | null;
  membershipType: string | null;
  membershipStatus: string | null;
  /** 티시트 요금제 이름. 회원이 아니면 빈 문자열. */
  ratePlan: string;
  rounds: number;
};

/** 칠 때마다 부르지 않도록 이만큼 멈추면 찾는다. */
const DEBOUNCE_MS = 250;

/**
 * 검색어로 회원을 찾는다. 2글자 미만이거나 `enabled` 가 꺼져 있으면 비운다.
 * 늦게 온 옛 응답이 새 결과를 덮지 않도록 effect 마다 취소 플래그를 둔다.
 * 응답이 오기 전에는 옛 결과를 보이지 않는다(다른 검색어의 결과라서).
 */
export function useMemberSearch(query: string, enabled: boolean) {
  // 마지막으로 받은 응답과 그 검색어. 결과·로딩은 지금 검색어와 비교해 파생한다.
  const [result, setResult] = useState<{ q: string; hits: MemberHit[] }>({ q: "", hits: [] });
  const q = query.trim();
  const wanted = enabled && q.length >= 2;

  useEffect(() => {
    if (!wanted) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      staffRpc<MemberHit[]>("pelham_staff_customer_search", { p_query: q })
        .then((rows) => {
          if (!cancelled) setResult({ q, hits: Array.isArray(rows) ? rows : [] });
        })
        .catch(() => {
          // 검색은 거들 뿐이다 — 실패해도 손으로 치면 예약은 된다.
          if (!cancelled) setResult({ q, hits: [] });
        });
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [q, wanted]);

  const fresh = wanted && result.q === q;
  return { hits: fresh ? result.hits : [], loading: wanted && !fresh };
}

const TYPE_LABEL: Record<string, string> = {
  full: "Full",
  weekday: "Weekday",
  intermediate: "Intermediate",
  nine_hole: "9 Hole",
  twilight: "Twilight",
  junior: "Junior",
};

/** 회원 한 줄 옆에 붙는 짧은 설명: "Full 2026 · #1234". */
export function memberSummary(hit: Pick<MemberHit, "membershipType" | "season" | "memberNumber" | "isMember">): string {
  const parts: string[] = [];
  if (hit.membershipType) {
    parts.push([TYPE_LABEL[hit.membershipType] ?? hit.membershipType, hit.season].filter(Boolean).join(" "));
  } else if (hit.isMember) {
    parts.push("Member");
  }
  if (hit.memberNumber) parts.push(`#${hit.memberNumber}`);
  return parts.join(" · ");
}

type MemberSuggestionsProps = {
  id: string;
  hits: MemberHit[];
  loading: boolean;
  active: number;
  onPick: (hit: MemberHit) => void;
  onHover: (index: number) => void;
};

/** 이름 칸 바로 아래의 결과 목록. 키보드 이동(↑↓ Enter Esc)은 이름 칸이 맡는다. */
export function MemberSuggestions({ id, hits, loading, active, onPick, onHover }: MemberSuggestionsProps) {
  if (!loading && hits.length === 0) return null;
  return (
    <ul
      className="absolute left-0 right-0 top-full z-10 mt-0.5 max-h-64 overflow-y-auto border border-[#d4d4d8] bg-white text-xs shadow-lg"
      id={id}
      role="listbox"
    >
      {hits.length === 0 ? (
        <li className="px-2 py-1.5 text-[#6b7280]">Searching…</li>
      ) : (
        hits.map((hit, index) => {
          const summary = memberSummary(hit);
          return (
            <li
              aria-selected={index === active}
              className={`flex cursor-pointer items-baseline justify-between gap-3 px-2 py-1.5 ${
                index === active ? "bg-[#eeecff]" : "hover:bg-[#f2f2f4]"
              }`}
              key={`${hit.customerRef ?? "m"}-${index}`}
              // 마우스를 누르는 순간 이름 칸이 blur 되며 목록이 닫히지 않도록 기본 동작을 막는다.
              onMouseDown={(event) => {
                event.preventDefault();
                onPick(hit);
              }}
              onMouseEnter={() => onHover(index)}
              role="option"
            >
              <span className="min-w-0 truncate">
                <span className="font-bold">{hit.name || `${hit.firstName} ${hit.lastName}`.trim()}</span>
                {hit.phone ? <span className="ml-2 text-[#6b7280]">{hit.phone}</span> : null}
              </span>
              {summary ? (
                <span
                  className={`shrink-0 font-semibold ${hit.isMember ? "text-[#2f7d4f]" : "text-[#6b7280]"}`}
                >
                  {summary}
                </span>
              ) : null}
            </li>
          );
        })
      )}
    </ul>
  );
}
