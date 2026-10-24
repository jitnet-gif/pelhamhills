"use client";

/**
 * 누가 처리했나 — 담당자 이름 + "ID ✓"(그날 그 이름이 Pelham Shift ID 로 확인됨, 0095). 2026-10-24 클럽 요청.
 *
 * Shift ID 는 로그인 비밀번호이기도 해서 번호는 어디에도 보이지 않는다. ✓ 가 없으면 이름을 손으로 친 것이다.
 * 이름이 없으면 빨갛게 "No cashier" — 누가 했는지 모르는 거래가 바로 보이게.
 *
 * 영업일마다 확인 목록을 한 번 읽어 화면 전체가 같이 쓴다(1분 지나면 다시 읽는다 — 오늘은 계속 늘어난다).
 */

import { useEffect, useState } from "react";

import retailApi from "@/lib/retail/api";
import { cashierKey } from "@/lib/reports/shiftReport";

const FRESH_MS = 60_000;
const cache = new Map<string, { at: number; keys: Promise<Set<string>> }>();

function load(date: string): Promise<Set<string>> {
  const hit = cache.get(date);
  if (hit && Date.now() - hit.at < FRESH_MS) return hit.keys;
  const keys = retailApi
    .listVerifiedCashiers(date)
    .then((rows) => new Set(rows.map((row) => cashierKey(row.name))));
  cache.set(date, { at: Date.now(), keys });
  return keys;
}

/** 그날 ID 로 확인된 이름들(`cashierKey`). 읽는 중이면 null. */
export function useVerifiedCashiers(date: string | null | undefined): Set<string> | null {
  const [state, setState] = useState<{ date: string; keys: Set<string> } | null>(null);
  useEffect(() => {
    if (!date) return;
    let cancelled = false;
    void load(date).then((keys) => {
      if (!cancelled) setState({ date, keys });
    });
    return () => {
      cancelled = true;
    };
  }, [date]);
  return date && state?.date === date ? state.keys : null;
}

/** ISO 시각 → 매장 현지 날짜(`YYYY-MM-DD`). */
export function localDateOf(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const value = new Date(iso);
  if (Number.isNaN(value.getTime())) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
}

export default function StaffName({
  name,
  date,
  empty = "No cashier",
}: {
  name: string | null | undefined;
  /** 영업일(`YYYY-MM-DD`). 없으면 ✓ 를 보지 않는다. */
  date?: string | null;
  /** 이름이 없을 때 문구. */
  empty?: string;
}) {
  const keys = useVerifiedCashiers(name ? date : null);
  const text = (name ?? "").trim();
  if (!text) return <span className="text-[#b42318]">{empty}</span>;
  const verified = keys?.has(cashierKey(text)) ?? false;
  return (
    <span className="whitespace-nowrap">
      {text}
      {verified ? (
        <span
          className="ml-1 bg-[#e7f6ec] px-1 py-px text-[10px] font-bold text-[#17663a]"
          title="Confirmed with a Pelham Shift ID that day"
        >
          ID ✓
        </span>
      ) : null}
    </span>
  );
}
