/**
 * 데이터 백업·복원(0100) — 클럽 표(public.pelham_*)를 CSV 폴더로 받고, 그 폴더로 되살린다.
 *
 * 매니저(Reports 명단, 0046)와 계정 관리자(0074)만 쓴다. 메뉴를 가리는 것은 여기(`useBackupAccess`), 막는 것은 서버다.
 * 매일 밤 자동 백업은 사무실 맥의 `scripts/backup/pelham_backup.mjs`(launchd)가 한다 — 같은 CSV·manifest 모양이라
 * 그 폴더도 이 화면에서 복원할 수 있다. **CSV 모양을 바꾸면 `scripts/backup/lib.mjs` 도 같이 바꾼다.**
 *
 * CSV: UTF-8(BOM), CRLF, 머리줄 = 열 이름. 값이 있으면 언제나 따옴표로 감싸고, NULL 은 따옴표 없는 빈칸이다 —
 * 그래서 빈 글자("")와 NULL 이 섞이지 않는다. 값은 Postgres 의 글자 모양 그대로다(jsonb·배열·시간).
 */

import { useEffect, useState } from "react";

import { ApiError } from "@/lib/teeSheet/api";
import { makeZip, readZip } from "@/lib/zip";
import { staffRpc } from "@/lib/teeSheet/staffRpc";

export type BackupColumn = { name: string; type: string; generated: boolean };

export type BackupTable = {
  table: string;
  /** 외래 키 깊이. 낮은 것(부모)부터 넣는다. */
  order: number;
  key: string[];
  columns: BackupColumn[];
  rows: number;
  /** 권한 명단 등 — 계정 관리자만 복원한다. */
  protected: boolean;
};

export type BackupRun = {
  id: number;
  kind: "backup" | "restore";
  /** login = 계정 관리자가 로그인할 때 하루 한 번 자동으로(0101). */
  source: "web" | "daily" | "script" | "login";
  email: string;
  tables: number;
  rows: number;
  note: string | null;
  created_at: string;
};

export type Manifest = {
  app: "pelhamhills";
  version: 1;
  created_at: string;
  by: string;
  tables: (BackupTable & { file: string })[];
};

type ExportPage = { columns: string[]; rows: (string | null)[][] };

const EXPORT_PAGE = 1000;
const RESTORE_CHUNK = 500;

export const backupApi = {
  access: async (): Promise<boolean> => {
    try {
      return await staffRpc<boolean>("pelham_backup_access");
    } catch (cause) {
      if (isMissingFunction(cause)) return false;
      throw cause;
    }
  },
  tables: () => staffRpc<BackupTable[]>("pelham_backup_tables"),
  runs: () => staffRpc<BackupRun[]>("pelham_backup_runs_list"),
  log: (kind: BackupRun["kind"], tables: number, rows: number, note: string, source: BackupRun["source"] = "web") =>
    staffRpc<void>("pelham_backup_log", { p_kind: kind, p_source: source, p_tables: tables, p_rows: rows, p_note: note }),
  exportPage: (table: string, offset: number) =>
    staffRpc<ExportPage>("pelham_backup_export", { p_table: table, p_offset: offset, p_limit: EXPORT_PAGE }),
  restore: (table: string, columns: string[], rows: (string | null)[][]) =>
    staffRpc<number>("pelham_backup_restore", { p_table: table, p_columns: columns, p_rows: rows }),
  prune: (table: string, keys: (string | null)[][]) =>
    staffRpc<number>("pelham_backup_prune", { p_table: table, p_keys: keys }),
};

function isMissingFunction(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404 && /function|PGRST202|schema cache/i.test(error.message);
}

export function describeBackupError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 0) return "Can't reach the server. Check the connection and try again.";
    if (isMissingFunction(error)) return "Backup functions are missing — run migration 0100 in the Supabase SQL Editor.";
    return error.message;
  }
  return (error as Error)?.message ?? "Something went wrong.";
}

const known = new Map<string, boolean>();

/** 메뉴에 Data Backup 을 띄울지. null = 아직 모른다(숨긴 채로 둔다). `lib/accounts.ts` 와 같은 방식. */
export function useBackupAccess(email: string): boolean | null {
  const [allowed, setAllowed] = useState<boolean | null>(() => known.get(email) ?? null);

  useEffect(() => {
    if (known.has(email)) return;
    let cancelled = false;
    backupApi
      .access()
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

// ===== CSV ===============================================================

const BOM = "﻿";

function quote(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

export function toCsv(columns: string[], rows: (string | null)[][]): string {
  const lines = [columns.map(quote).join(",")];
  for (const row of rows) lines.push(row.map((value) => (value === null ? "" : quote(value))).join(","));
  return `${BOM}${lines.join("\r\n")}\r\n`;
}

/** toCsv 의 반대. 따옴표 없는 빈칸은 NULL. 머리줄과 줄들을 돌려준다. */
export function parseCsv(text: string): { columns: string[]; rows: (string | null)[][] } {
  const src = text.startsWith(BOM) ? text.slice(1) : text;
  const records: (string | null)[][] = [];
  let record: (string | null)[] = [];
  let field = "";
  let quoted = false;
  let inQuotes = false;
  let i = 0;

  const endField = () => {
    record.push(quoted ? field : field === "" ? null : field);
    field = "";
    quoted = false;
  };

  while (i < src.length) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
      } else {
        field += ch;
      }
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      quoted = true;
    } else if (ch === ",") {
      endField();
    } else if (ch === "\r" || ch === "\n") {
      endField();
      records.push(record);
      record = [];
      if (ch === "\r" && src[i + 1] === "\n") i += 1;
    } else {
      field += ch;
    }
    i += 1;
  }
  if (field !== "" || quoted || record.length > 0) {
    endField();
    records.push(record);
  }

  const [header, ...rows] = records;
  return { columns: (header ?? []).map((name) => name ?? ""), rows };
}

// ===== 백업 ==============================================================

export type Progress = { done: number; total: number; label: string };

/** 폴더 이름. 예: pelhamhills-backup-2026-10-24_2330 (클럽 시간). */
export function backupFolderName(now = new Date()): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Toronto",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(now)
      .map((part) => [part.type, part.value]),
  );
  return `pelhamhills-backup-${parts.year}-${parts.month}-${parts.day}_${parts.hour}${parts.minute}`;
}

/** 파일을 쓰는 곳. 폴더를 고를 수 있는 브라우저(크롬·엣지)는 폴더에, 아니면 파일마다 내려받기. */
export type BackupSink = {
  write: (name: string, text: string) => Promise<void>;
  /** 다 쓴 뒤 한 번(ZIP 은 여기서 내려받는다). */
  finish?: () => Promise<void>;
  where: string;
};

type DirHandle = {
  name: string;
  getDirectoryHandle: (name: string, options: { create: boolean }) => Promise<DirHandle>;
  getFileHandle: (
    name: string,
    options: { create: boolean },
  ) => Promise<{ createWritable: () => Promise<{ write: (data: string) => Promise<void>; close: () => Promise<void> }> }>;
};

export function canPickFolder(): boolean {
  return typeof window !== "undefined" && "showDirectoryPicker" in window;
}

export async function pickFolderSink(folder: string): Promise<BackupSink> {
  const picker = (window as unknown as { showDirectoryPicker: (o: { mode: string }) => Promise<DirHandle> })
    .showDirectoryPicker;
  const parent = await picker({ mode: "readwrite" });
  const dir = await parent.getDirectoryHandle(folder, { create: true });
  return {
    where: `${parent.name}/${folder}`,
    write: async (name, text) => {
      const file = await dir.getFileHandle(name, { create: true });
      const out = await file.createWritable();
      await out.write(text);
      await out.close();
    },
  };
}

export function downloadSink(folder: string): BackupSink {
  return {
    where: "Downloads",
    write: async (name, text) => {
      const url = URL.createObjectURL(new Blob([text], { type: name.endsWith(".json") ? "application/json" : "text/csv" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `${folder}__${name}`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      // 한꺼번에 누르면 브라우저가 몇 개를 버린다.
      await new Promise((resolve) => setTimeout(resolve, 250));
    },
  };
}

/** 파일을 모아 ZIP 하나로 내려받는다. 로그인 자동 백업이 쓴다 — 클릭 없이 폴더를 고를 수는 없어서. */
export function zipSink(folder: string): BackupSink {
  const files: { name: string; text: string }[] = [];
  return {
    where: `Downloads/${folder}.zip`,
    write: async (name, text) => {
      files.push({ name: `${folder}/${name}`, text });
    },
    finish: async () => {
      const url = URL.createObjectURL(makeZip(files));
      const link = document.createElement("a");
      link.href = url;
      link.download = `${folder}.zip`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    },
  };
}

export async function runBackup(
  sink: BackupSink,
  email: string,
  onProgress: (p: Progress) => void,
  source: BackupRun["source"] = "web",
): Promise<{ tables: number; rows: number }> {
  const tables = await backupApi.tables();
  const manifest: Manifest = { app: "pelhamhills", version: 1, created_at: new Date().toISOString(), by: email, tables: [] };
  let total = 0;

  for (const [index, table] of tables.entries()) {
    onProgress({ done: index, total: tables.length, label: table.table });
    const rows: (string | null)[][] = [];
    let columns = table.columns.map((column) => column.name);
    for (let offset = 0; ; offset += EXPORT_PAGE) {
      const page = await backupApi.exportPage(table.table, offset);
      columns = page.columns;
      rows.push(...page.rows);
      if (page.rows.length < EXPORT_PAGE) break;
    }
    const file = `${table.table}.csv`;
    await sink.write(file, toCsv(columns, rows));
    manifest.tables.push({ ...table, rows: rows.length, file });
    total += rows.length;
  }

  await sink.write("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
  await sink.finish?.();
  onProgress({ done: tables.length, total: tables.length, label: "manifest.json" });
  await backupApi.log("backup", tables.length, total, sink.where, source).catch(() => undefined);
  return { tables: tables.length, rows: total };
}

// ===== 복원 ==============================================================

export type LoadedTable = {
  table: string;
  columns: string[];
  rows: (string | null)[][];
};

export type LoadedBackup = { createdAt: string | null; by: string | null; tables: LoadedTable[] };

type BackupEntry = { name: string; dir: string; text: () => Promise<string> };

/** 고른 파일들(폴더 통째로, CSV 몇 개, 또는 로그인 자동 백업 ZIP)을 읽는다. 다운로드 대체 방식의 `<폴더>__표.csv` 이름도 알아본다. */
export async function loadBackupFiles(files: File[]): Promise<LoadedBackup> {
  const entries: BackupEntry[] = [];
  for (const file of files) {
    if (file.name.toLowerCase().endsWith(".zip")) {
      for (const item of await readZip(file)) {
        const parts = item.path.split("/");
        if (parts[0] === "__MACOSX") continue;
        entries.push({ name: parts.pop() ?? "", dir: `${file.name}/${parts.join("/")}`, text: async () => item.text });
      }
    } else {
      const dir = file.webkitRelativePath.split("/").slice(0, -1).join("/");
      entries.push({ name: file.name, dir, text: () => file.text() });
    }
  }
  const named = entries.map((entry) => ({ entry, name: (entry.name.split("__").pop() ?? entry.name).toLowerCase() }));
  // PelhamBackups 를 통째로 고르면 날짜 폴더들의 같은 표가 겹친다. 날짜 폴더(또는 ZIP) 하나만 받는다.
  const folders = new Set(named.filter((item) => /\.(csv|json)$/.test(item.name)).map((item) => item.entry.dir));
  if (folders.size > 1) throw new Error("Pick one dated backup folder or ZIP (pelhamhills-backup-…), not several.");
  const manifestEntry = named.find((item) => item.name === "manifest.json")?.entry;
  const manifest = manifestEntry ? (JSON.parse(await manifestEntry.text()) as Manifest) : null;
  if (manifest && manifest.app !== "pelhamhills") throw new Error("This folder isn't a Pelham Hills backup.");

  const tables: LoadedTable[] = [];
  for (const { entry, name } of named) {
    if (!name.endsWith(".csv")) continue;
    const table = name.slice(0, -4);
    if (!/^pelham_[a-z0-9_]+$/.test(table)) continue;
    const parsed = parseCsv(await entry.text());
    tables.push({ table, columns: parsed.columns, rows: parsed.rows });
  }
  if (tables.length === 0) throw new Error("No pelham_*.csv files found. Pick the backup folder or ZIP.");
  return { createdAt: manifest?.created_at ?? null, by: manifest?.by ?? null, tables };
}

export type RestoreResult = { table: string; restored: number; removed: number; error: string | null };

/**
 * 부모 표부터 넣고(merge), replace 면 자식 표부터 백업에 없는 줄을 지운다. 한 표가 실패해도 나머지는 계속한다.
 * 기본 키가 없는 표는 merge 로는 같은 줄을 알아볼 수 없어 건너뛰고, replace 일 때만 비운 뒤 넣는다.
 */
export async function runRestore(
  backup: LoadedBackup,
  chosen: string[],
  replace: boolean,
  onProgress: (p: Progress) => void,
): Promise<RestoreResult[]> {
  const live = await backupApi.tables();
  const liveOf = new Map(live.map((table) => [table.table, table]));
  const picked = backup.tables
    .filter((table) => chosen.includes(table.table))
    .sort((a, b) => (liveOf.get(a.table)?.order ?? 99) - (liveOf.get(b.table)?.order ?? 99) || a.table.localeCompare(b.table));

  const results = new Map<string, RestoreResult>();
  const steps = picked.length * (replace ? 2 : 1);
  let step = 0;

  for (const table of picked) {
    onProgress({ done: step++, total: steps, label: `${table.table} — restoring` });
    const result: RestoreResult = { table: table.table, restored: 0, removed: 0, error: null };
    results.set(table.table, result);
    const current = liveOf.get(table.table);
    if (!current) {
      result.error = "Not in the database any more — skipped.";
      continue;
    }
    try {
      if (current.key.length === 0) {
        if (!replace) {
          result.error = "No primary key — only Replace can restore this table.";
          continue;
        }
        result.removed = await backupApi.prune(table.table, []);
      }
      for (let start = 0; start < table.rows.length; start += RESTORE_CHUNK) {
        result.restored += await backupApi.restore(table.table, table.columns, table.rows.slice(start, start + RESTORE_CHUNK));
      }
    } catch (cause) {
      result.error = describeBackupError(cause);
    }
  }

  if (replace) {
    for (const table of [...picked].reverse()) {
      onProgress({ done: step++, total: steps, label: `${table.table} — removing rows not in the backup` });
      const result = results.get(table.table)!;
      const current = liveOf.get(table.table);
      if (result.error || !current || current.key.length === 0) continue;
      const positions = current.key.map((name) => table.columns.indexOf(name));
      if (positions.some((index) => index < 0)) {
        result.error = "The backup is missing a key column — rows were not removed.";
        continue;
      }
      try {
        result.removed = await backupApi.prune(
          table.table,
          table.rows.map((row) => positions.map((index) => row[index] ?? null)),
        );
      } catch (cause) {
        result.error = describeBackupError(cause);
      }
    }
  }

  onProgress({ done: steps, total: steps, label: "Done" });
  const all = [...results.values()];
  const rows = all.reduce((sum, item) => sum + item.restored, 0);
  const failed = all.filter((item) => item.error).length;
  await backupApi
    .log("restore", all.length, rows, `${replace ? "replace" : "merge"} · from ${backup.createdAt ?? "CSV files"}${failed ? ` · ${failed} failed` : ""}`)
    .catch(() => undefined);
  return all;
}
