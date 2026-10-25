/**
 * 날짜별 자동 백업 — 매니저(Reports 명단)와 계정 관리자(Emmeline)가 쓰는 기계마다 하루 한 번, 클럽 데이터를
 * ZIP 하나(pelhamhills-backup-<날짜>.zip)로 다운로드 폴더에 받는다(0100·0101).
 *
 * 언제: 그 기계에서 그날(클럽 시간) 처음 어드민을 열 때. 어드민을 켜 둔 채 날이 바뀌면 다음 날 것도 받는다.
 * "그날 받았나" 는 이 기계(브라우저)에 적는다 — 매니저 기계마다 따로 받게. 로그인을 몇 번 해도 하루 한 번.
 * 브라우저는 클릭 없이 폴더에 쓸 수 없어서 다운로드 폴더에 ZIP 으로 받는다.
 *
 * 백업은 화면이 아니라 이 모듈이 돈다 — 백업 중에 다른 메뉴로 옮겨도(AdminShell 이 다시 그려져도) 끊기지 않게.
 * (2026-10-25: 로그인마다 받던 것을 기계마다 하루 한 번으로 바꿨다.)
 */

import { useEffect, useState } from "react";

import { backupApi, runBackup, zipSink } from "@/lib/backup";

export type AutoBackupState =
  | { phase: "idle" }
  | { phase: "running"; done: number; total: number }
  | { phase: "done"; where: string; rows: number }
  | { phase: "failed"; message: string };

/** 이 기계에서 마지막으로 자동 백업을 받은 날. 값 = "YYYY-MM-DD". */
const DONE_KEY = "pelham.backup.day";
/** 같은 기계의 두 탭이 동시에 받지 않게. 값 = "<날짜> <시작 ms>". */
const RUNNING_KEY = "pelham.backup.running";
const RUNNING_STALE_MS = 10 * 60_000;
/** 켜 둔 채 날이 바뀌었는지 이만큼마다 본다. */
const CHECK_EVERY_MS = 15 * 60_000;

function doneOn(): string {
  try {
    return window.localStorage.getItem(DONE_KEY) ?? "";
  } catch {
    return "";
  }
}

function markDone(day: string) {
  try {
    window.localStorage.setItem(DONE_KEY, day);
  } catch {}
}

function clubDate(at: Date | string = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto" }).format(new Date(at));
}

let state: AutoBackupState = { phase: "idle" };
const listeners = new Set<(next: AutoBackupState) => void>();
let busy = false;

function set(next: AutoBackupState) {
  state = next;
  for (const listener of listeners) listener(next);
}

function claim(today: string): boolean {
  try {
    const held = window.localStorage.getItem(RUNNING_KEY);
    if (held) {
      const [day, at] = held.split(" ");
      if (day === today && Date.now() - Number(at) < RUNNING_STALE_MS) return false;
    }
    window.localStorage.setItem(RUNNING_KEY, `${today} ${Date.now()}`);
  } catch {}
  return true;
}

function release() {
  try {
    window.localStorage.removeItem(RUNNING_KEY);
  } catch {}
}

async function run(email: string) {
  const today = clubDate();
  if (busy || doneOn() === today) return;
  busy = true;
  try {
    if (!(await backupApi.access())) return;
    if (doneOn() === today || !claim(today)) return;
    try {
      const folder = `pelhamhills-backup-${today}`;
      const sink = zipSink(folder);
      set({ phase: "running", done: 0, total: 0 });
      const result = await runBackup(sink, email, (p) => set({ phase: "running", done: p.done, total: p.total }), "login");
      markDone(today);
      set({ phase: "done", where: sink.where, rows: result.rows });
    } finally {
      release();
    }
  } finally {
    busy = false;
  }
}

/** AdminShell 이 로그인한 뒤 부른다. 매니저가 아니면(또는 0100 전이면) 아무것도 하지 않는다. */
export function useAutoBackup(email: string): AutoBackupState {
  const [current, setCurrent] = useState<AutoBackupState>(state);

  useEffect(() => {
    listeners.add(setCurrent);
    return () => {
      listeners.delete(setCurrent);
    };
  }, []);

  useEffect(() => {
    if (!email) return;
    const attempt = () =>
      run(email).catch((cause: unknown) => {
        // 0100 전이거나 권한이 없으면 조용히 넘어간다. 백업을 하다 실패한 것만 알린다.
        if (state.phase === "running") set({ phase: "failed", message: (cause as Error)?.message ?? "Backup failed." });
      });
    attempt();
    // 켜 둔 채 자정을 넘기면 다음 날 것을 받는다.
    const timer = window.setInterval(attempt, CHECK_EVERY_MS);
    return () => window.clearInterval(timer);
  }, [email]);

  return current;
}
