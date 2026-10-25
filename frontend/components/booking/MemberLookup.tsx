"use client";

// 손님 예약 화면의 이름 칸 아래에 뜨는 회원 찾기(0109 `pelham_tee_member_lookup`).
// 직원용(`components/teesheet/MemberSearch.tsx`)과 달리 공개 화면이라 이름·회원권 종류만 온다.
// 고르면 예약이 `pelham_tee_book_member` 로 가고, 이메일·전화가 회원 기록과 맞아야 회원으로 잡힌다.

import { useEffect, useState } from "react";

import { bookingRpc } from "@/lib/booking/rpc";

/** `pelham_tee_member_lookup` 한 줄. `ref` 는 회원권 id. */
export type PublicMember = {
  ref: string;
  name: string;
  membershipType: string;
  season: number;
};

const DEBOUNCE_MS = 300;

const TYPE_LABEL: Record<string, string> = {
  full: "Full",
  weekday: "Weekday",
  intermediate: "Intermediate",
  nine_hole: "9 Hole",
  twilight: "Twilight",
  junior: "Junior",
};

/** "Full Member 2026". */
export function memberLabel(member: Pick<PublicMember, "membershipType" | "season">): string {
  return `${TYPE_LABEL[member.membershipType] ?? member.membershipType} Member ${member.season}`;
}

/** 3글자 미만이거나 꺼져 있으면 비운다. 늦게 온 옛 응답은 버린다(직원용 `useMemberSearch` 와 같다). */
export function usePublicMemberSearch(query: string, enabled: boolean) {
  const [result, setResult] = useState<{ q: string; hits: PublicMember[] }>({ q: "", hits: [] });
  const q = query.trim();
  const wanted = enabled && q.length >= 3;

  useEffect(() => {
    if (!wanted) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      bookingRpc<PublicMember[]>("pelham_tee_member_lookup", { p_query: q })
        .then((rows) => {
          if (!cancelled) setResult({ q, hits: Array.isArray(rows) ? rows : [] });
        })
        .catch(() => {
          // 0109 가 아직 안 돌았거나 연결이 끊겼다 — 찾기는 거들 뿐, 일반 예약은 그대로 된다.
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

/** 이름 칸 바로 아래 목록. 키보드(↑↓ Enter Esc)는 이름 칸이 맡는다. 아무것도 없으면 그리지 않는다. */
export function MemberLookupList({
  active,
  hits,
  id,
  onHover,
  onPick,
}: {
  active: number;
  hits: PublicMember[];
  id: string;
  onHover: (index: number) => void;
  onPick: (member: PublicMember) => void;
}) {
  if (hits.length === 0) return null;
  return (
    <ul
      className="absolute left-0 right-0 top-full z-10 mt-1 max-h-72 overflow-y-auto rounded-sm border border-[#d8d1c3] bg-white shadow-lg"
      id={id}
      role="listbox"
    >
      <li className="px-4 py-2 text-xs font-semibold uppercase tracking-wide text-[#5c6459]">Members</li>
      {hits.map((member, index) => (
        <li
          aria-selected={index === active}
          className={`flex cursor-pointer items-baseline justify-between gap-3 px-4 py-3 text-base ${
            index === active ? "bg-[#eef5ef]" : "hover:bg-[#f7f4ed]"
          }`}
          id={`${id}-${index}`}
          key={member.ref}
          // 누르는 순간 이름 칸이 blur 되며 목록이 닫히지 않게.
          onMouseDown={(event) => {
            event.preventDefault();
            onPick(member);
          }}
          onMouseEnter={() => onHover(index)}
          role="option"
        >
          <span className="min-w-0 truncate font-semibold">{member.name}</span>
          <span className="shrink-0 text-sm font-semibold text-[#2f7d4f]">{memberLabel(member)}</span>
        </li>
      ))}
    </ul>
  );
}
