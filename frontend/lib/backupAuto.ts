/**
 * 로그인 자동 백업 — 매니저(Reports 명단)와 계정 관리자(Emmeline)가 로그인하면 클럽 데이터를 ZIP 하나로 내려받는다(0100·0101).
 *
 * 언제: 로그인할 때마다 항상. 로그인이 남아 있어 로그인 화면을 거치지 않는 날은 그날 처음 어드민을 열 때 한 번
 * (그 계정의 오늘 login 기록이 서버에 없으면). 브라우저는 클릭 없이 폴더에 쓸 수 없어서 다운로드 폴더에 ZIP 으로 받는다.
 *
 * 백업은 화면이 아니라 이 모듈이 돈다 — 백업 중에 다른 메뉴로 옮겨도(AdminShell 이 다시 그려져도) 끊기지 않게.
 */

import { useEffect, useState } from "react";

import { backupApi, backupFolderName, runBackup, zipSink } from "@/lib/backup";

export type AutoBackupState =
  | { phase: "idle" }
  | { phase: "running"; done: number; total: number }
  | { phase: "done"; where: string; rows: number }
  | { phase: "failed"; message: string };

/** SignInScreen 이 로그인 직후(페이지를 새로 열기 전에) 남긴다. 이 탭에서 다음 한 번만 읽는다. */
const SIGNED_IN_KEY = "pelham.backup.signedIn";
/** 같은 계정·같은 날 두 탭이 동시에 받지 않게. 값 = "<날짜> <시작 ms>". */
const RUNNING_KEY = "pelham.backup.running.";
const RUNNING_STALE_MS = 10 * 60_000;

export function markSignedIn(): void {
  try {
    window.sessionStorage.setItem(SIGNED_IN_KEY, "1");
  } catch {}
}

function takeSignedIn(): boolean {
  try {
    const value = window.sessionStorage.getItem(SIGNED_IN_KEY);
    window.sessionStorage.removeItem(SIGNED_IN_KEY);
    return value === "1";
  } catch {
    return false;
  }
}

function clubDate(at: Date | string = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto" }).format(new Date(at));
}

let state: AutoBackupState = { phase: "idle" };
const listeners = new Set<(next: AutoBackupState) => void>();
const started = new Set<string>();

function set(next: AutoBackupState) {
  state = next;
  for (const listener of listeners) listener(next);
}

function claim(email: string, today: string): boolean {
  try {
    const held = window.localStorage.getItem(RUNNING_KEY + email);
    if (held) {
      const [day, at] = held.split(" ");
      if (day === today && Date.now() - Number(at) < RUNNING_STALE_MS) return false;
    }
    window.localStorage.setItem(RUNNING_KEY + email, `${today} ${Date.now()}`);
  } catch {}
  return true;
}

function release(email: string) {
  try {
    window.localStorage.removeItem(RUNNING_KEY + email);
  } catch {}
}

async function run(email: string, signedIn: boolean) {
  const today = clubDate();
  if (!(await backupApi.access())) return;
  if (!signedIn) {
    const runs = await backupApi.runs();
    const doneToday = runs.some(
      (r) => r.kind === "backup" && r.source === "login" && r.email === email.toLowerCase() && clubDate(r.created_at) === today,
    );
    if (doneToday) return;
  }
  if (!claim(email, today)) return;
  try {
    const sink = zipSink(backupFolderName());
    set({ phase: "running", done: 0, total: 0 });
    const result = await runBackup(sink, email, (p) => set({ phase: "running", done: p.done, total: p.total }), "login");
    set({ phase: "done", where: sink.where, rows: result.rows });
  } finally {
    release(email);
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
    const signedIn = takeSignedIn();
    // 이 문서에서 이 계정은 한 번만 — 메뉴를 옮길 때마다 다시 묻지 않는다.
    if (started.has(email)) return;
    started.add(email);
    run(email, signedIn).catch((cause: unknown) => {
      // 0100 전이거나 권한이 없으면 조용히 넘어간다. 백업을 하다 실패한 것만 알린다.
      if (state.phase === "running") set({ phase: "failed", message: (cause as Error)?.message ?? "Backup failed." });
    });
  }, [email]);

  return current;
}
