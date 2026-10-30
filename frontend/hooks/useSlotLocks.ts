"use client";

/**
 * 티시트 칸의 수동 블록·릴리스(0051)와 날짜마다 첫 티·마지막 티(0131) — 주간·일간 격자, 예약 창,
 * 상세 패널, 날짜 줄이 함께 본다.
 *
 * 둘 다 없으면 일출·일몰 2시간 전으로 `lib/teeSheet/sun.ts` 가 날짜마다 계산하고, 여기는 직원이
 * 손으로 바꾼 값만 들고 있다. 한 화면의 여러 컴포넌트가 같은 값을 봐야 하므로 모듈 하나에 모아 두고
 * `useSyncExternalStore` 로 나눠 준다 — 블록을 누르면 격자와 예약 창이 같이 바뀐다.
 * 읽기에 실패하면(로그인 전·0051/0131 전) 그 설정 없이 자동 판정만 쓴다. 쓰기는 서버 트리거가 다시 본다.
 */

import { useCallback, useEffect, useSyncExternalStore } from "react";

import { staffSlotLocks, staffSlotLockSet, staffTeeHours, staffTeeHoursSet } from "@/lib/teeSheet/staffRpc";
import { isAutoLocked, slotLockKey, type DayHours, type SlotLocks } from "@/lib/teeSheet/sun";

let snapshot: SlotLocks = { slots: new Map(), hours: new Map() };
const listeners = new Set<() => void>();
const loaded = new Map<string, Promise<void>>();

function publish(next: SlotLocks) {
  snapshot = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const getSnapshot = () => snapshot;

/** from~to 의 칸 설정을 서버 값으로 바꿔 끼운다. */
function replaceSlots(from: string, to: string, rows: { date: string; minutes: number; locked: boolean }[]) {
  const slots = new Map(snapshot.slots);
  for (const [k] of slots) {
    const date = k.slice(0, 10);
    if (date >= from && date <= to) slots.delete(k);
  }
  for (const row of rows) slots.set(slotLockKey(row.date, row.minutes), row.locked);
  publish({ ...snapshot, slots });
}

function load(from: string, to: string): Promise<void> {
  const key = `${from}|${to}`;
  let pending = loaded.get(key);
  if (!pending) {
    const slots = staffSlotLocks(from, to).then((rows) => replaceSlots(from, to, rows));
    // 0131 전이면 함수가 없다 — 칸 설정만으로 계속 간다.
    const hours = staffTeeHours(from, to)
      .then((rows) => {
        const next = new Map(snapshot.hours);
        for (const [date] of next) if (date >= from && date <= to) next.delete(date);
        for (const row of rows) next.set(row.date, { first: row.first, last: row.last });
        publish({ ...snapshot, hours: next });
      })
      .catch(() => undefined);
    pending = Promise.all([slots, hours])
      .then(() => undefined)
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
  /** 라벨 또는 null(자동). 돌려주는 값 = 새 시간 밖에 남은 예약 수. */
  setHours: (date: string, first: string | null, last: string | null) => Promise<number>;
} {
  const from = dates[0];
  const to = dates[dates.length - 1];
  const locks = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    if (from && to) void load(from, to);
  }, [from, to]);

  const setLock = useCallback(async (date: string, time: string, minutes: number, locked: boolean) => {
    const row = await staffSlotLockSet(date, time, locked);
    const slots = new Map(snapshot.slots);
    const key = slotLockKey(row.date, row.minutes ?? minutes);
    // 서버와 같은 규칙: 자동 판정과 같으면 수동 설정이 없다.
    if (row.locked === isAutoLocked(row.date, row.minutes ?? minutes, snapshot)) slots.delete(key);
    else slots.set(key, row.locked);
    publish({ ...snapshot, slots });
  }, []);

  const setHours = useCallback(async (date: string, first: string | null, last: string | null) => {
    const row = await staffTeeHoursSet(date, first, last);
    const hours = new Map(snapshot.hours);
    const set: DayHours = { first: row.first, last: row.last };
    if (set.first == null && set.last == null) hours.delete(date);
    else hours.set(date, set);
    publish({ ...snapshot, hours });
    // 서버가 새 시간 밖의 칸 설정을 지웠다 — 그날 것을 다시 읽는다.
    replaceSlots(date, date, await staffSlotLocks(date, date));
    return row.outside ?? 0;
  }, []);

  return { locks, setLock, setHours };
}
