"use client";

/**
 * 티시트 칸의 수동 블록·릴리스(0051) — 주간·일간 격자, 예약 창, 상세 패널이 함께 본다.
 *
 * 자동 잠금(일출 전, 일몰 2시간 전 이후)은 `lib/teeSheet/sun.ts` 가 날짜마다 계산하고, 여기는 직원이
 * 손으로 바꾼 칸만 들고 있다. 한 화면의 여러 컴포넌트가 같은 값을 봐야 하므로 모듈 하나에 모아 두고
 * `useSyncExternalStore` 로 나눠 준다 — 블록을 누르면 격자와 예약 창이 같이 바뀐다.
 * 읽기에 실패하면(로그인 전·0051 전) 수동 설정 없이 자동 판정만 쓴다. 쓰기는 서버 트리거가 다시 본다.
 */

import { useCallback, useEffect, useSyncExternalStore } from "react";

import { staffSlotLocks, staffSlotLockSet } from "@/lib/teeSheet/staffRpc";
import { isAutoLocked, slotLockKey, type SlotLocks } from "@/lib/teeSheet/sun";

let snapshot: SlotLocks = new Map();
const listeners = new Set<() => void>();
const loaded = new Map<string, Promise<void>>();

function publish(next: Map<string, boolean>) {
  snapshot = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const getSnapshot = () => snapshot;

function load(from: string, to: string): Promise<void> {
  const key = `${from}|${to}`;
  let pending = loaded.get(key);
  if (!pending) {
    pending = staffSlotLocks(from, to)
      .then((rows) => {
        const next = new Map(snapshot);
        for (const [k] of next) {
          const date = k.slice(0, 10);
          if (date >= from && date <= to) next.delete(k);
        }
        for (const row of rows) next.set(slotLockKey(row.date, row.minutes), row.locked);
        publish(next);
      })
      .catch(() => {
        loaded.delete(key);
      });
    loaded.set(key, pending);
  }
  return pending;
}

/** `dates` 는 정렬된 ISO 날짜. 첫째~마지막 날 사이의 수동 설정을 읽어 둔다. */
export function useSlotLocks(dates: readonly string[]): {
  locks: SlotLocks;
  setLock: (date: string, time: string, minutes: number, locked: boolean) => Promise<void>;
} {
  const from = dates[0];
  const to = dates[dates.length - 1];
  const locks = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    if (from && to) void load(from, to);
  }, [from, to]);

  const setLock = useCallback(async (date: string, time: string, minutes: number, locked: boolean) => {
    const row = await staffSlotLockSet(date, time, locked);
    const next = new Map(snapshot);
    const key = slotLockKey(row.date, row.minutes ?? minutes);
    // 서버와 같은 규칙: 자동 판정과 같으면 수동 설정이 없다.
    if (row.locked === isAutoLocked(row.date, row.minutes ?? minutes)) next.delete(key);
    else next.set(key, row.locked);
    publish(next);
  }, []);

  return { locks, setLock };
}
