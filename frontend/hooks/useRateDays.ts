"use client";

/**
 * 날짜별 그린피(주중·주말·공휴일) — 요일 탭과 주간 격자의 열 머리가 쓴다.
 *
 * 요금은 서버(`pelham_tee_rate`, 0025)만 안다. 공휴일 표가 DB 에 있으므로 화면이 요일로
 * 추측하지 않는다. 실패하면 조용히 빈 맵이다 — 요금 글자가 빠질 뿐 탭·격자는 그대로 동작한다.
 * 같은 기간은 한 번만 묻는다(요금은 하루 안에 거의 바뀌지 않는다).
 */

import { useEffect, useState } from "react";

import { staffRateDays } from "@/lib/teeSheet/staffRpc";
import type { RateDay } from "@/lib/teeSheet/types";

const cache = new Map<string, Promise<RateDay[]>>();

function load(from: string, to: string): Promise<RateDay[]> {
  const key = `${from}|${to}`;
  let pending = cache.get(key);
  if (!pending) {
    pending = staffRateDays(from, to).catch((error: unknown) => {
      cache.delete(key);
      throw error;
    });
    cache.set(key, pending);
  }
  return pending;
}

const EMPTY: ReadonlyMap<string, RateDay> = new Map();

/** `dates` 는 정렬된 ISO 날짜. 첫째~마지막 날 사이를 한 번에 묻는다. */
export function useRateDays(dates: readonly string[]): ReadonlyMap<string, RateDay> {
  const from = dates[0];
  const to = dates[dates.length - 1];
  const [state, setState] = useState<{ key: string; map: ReadonlyMap<string, RateDay> } | null>(null);
  const key = from && to ? `${from}|${to}` : "";

  useEffect(() => {
    if (!from || !to) return;
    let alive = true;
    load(from, to)
      .then((rows) => {
        if (alive) setState({ key: `${from}|${to}`, map: new Map(rows.map((row) => [row.date, row])) });
      })
      .catch(() => {
        // 로그인 전·오프라인 — 요금 없이 그린다.
      });
    return () => {
      alive = false;
    };
  }, [from, to]);

  return state && state.key === key ? state.map : EMPTY;
}

/** "Holiday · Thanksgiving" / "Weekend" / "Weekday". */
export function dayTypeLabel(day: Pick<RateDay, "dayType" | "holiday">): string {
  if (day.dayType === "holiday") return day.holiday ? `Holiday · ${day.holiday}` : "Holiday";
  return day.dayType === "weekend" ? "Weekend" : "Weekday";
}
