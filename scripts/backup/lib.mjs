// 데이터 백업·복원 공용 — 매니저 계정으로 로그인해 0100 의 함수들을 부른다.
//
// CSV·manifest 모양은 어드민 화면(frontend/lib/backup.ts)과 같다. 한쪽을 바꾸면 다른 쪽도 바꾼다 —
// 매일 밤 받은 폴더를 화면에서 복원하고, 화면에서 받은 폴더를 여기서 복원한다.
//
// 설정은 ~/.pelham-backup.env (chmod 600). install_daily_backup.sh 가 틀을 만든다.
//   PELHAM_BACKUP_EMAIL     매니저(Reports) 또는 계정 관리자 계정
//   PELHAM_BACKUP_PASSWORD
//   PELHAM_BACKUP_DIR       기본 ~/PelhamBackups
//   PELHAM_BACKUP_KEEP_DAYS 기본 30
//   SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY  기본은 사이트와 같은 프로젝트

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_URL = "https://yxpiwwgquyaxjubovzmi.supabase.co";
const DEFAULT_KEY = "sb_publishable_oMJG_-xpWr6AI5o3KnrU_A_kJENaKSY";
const EXPORT_PAGE = 1000;
const RESTORE_CHUNK = 500;
const BOM = "﻿";

export const ENV_FILE = path.join(os.homedir(), ".pelham-backup.env");

export function loadConfig() {
  const env = { ...process.env };
  if (fs.existsSync(ENV_FILE)) {
    for (const line of fs.readFileSync(ENV_FILE, "utf8").split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (!match || line.trimStart().startsWith("#")) continue;
      let value = match[2];
      if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
      if (env[match[1]] === undefined) env[match[1]] = value;
    }
  }
  const home = (value) => value.replace(/^~(?=$|\/)/, os.homedir());
  const config = {
    url: (env.SUPABASE_URL || DEFAULT_URL).replace(/\/+$/, ""),
    key: env.SUPABASE_PUBLISHABLE_KEY || DEFAULT_KEY,
    email: env.PELHAM_BACKUP_EMAIL || "",
    password: env.PELHAM_BACKUP_PASSWORD || "",
    dir: home(env.PELHAM_BACKUP_DIR || "~/PelhamBackups"),
    keepDays: Number(env.PELHAM_BACKUP_KEEP_DAYS || 30),
  };
  if (!config.email || !config.password) {
    throw new Error(`Set PELHAM_BACKUP_EMAIL and PELHAM_BACKUP_PASSWORD in ${ENV_FILE}.`);
  }
  return config;
}

// ===== Supabase =========================================================

export async function signIn(config) {
  const res = await fetch(`${config.url}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: config.key, "Content-Type": "application/json" },
    body: JSON.stringify({ email: config.email, password: config.password }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw new Error(`Sign-in failed for ${config.email}: ${body.error_description || body.msg || res.status}`);
  }
  return { ...config, token: body.access_token };
}

export async function rpc(session, fn, args = {}) {
  const res = await fetch(`${session.url}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      apikey: session.key,
      Authorization: `Bearer ${session.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      message = JSON.parse(text).message || message;
    } catch {}
    const error = new Error(`${fn}: ${message}`);
    error.status = res.status;
    throw error;
  }
  return text ? JSON.parse(text) : undefined;
}

// ===== CSV ==============================================================

const quote = (value) => `"${value.replace(/"/g, '""')}"`;

export function toCsv(columns, rows) {
  const lines = [columns.map(quote).join(",")];
  for (const row of rows) lines.push(row.map((value) => (value === null ? "" : quote(value))).join(","));
  return `${BOM}${lines.join("\r\n")}\r\n`;
}

/** 따옴표 없는 빈칸은 NULL. */
export function parseCsv(text) {
  const src = text.startsWith(BOM) ? text.slice(1) : text;
  const records = [];
  let record = [];
  let field = "";
  let quoted = false;
  let inQuotes = false;
  const endField = () => {
    record.push(quoted ? field : field === "" ? null : field);
    field = "";
    quoted = false;
  };
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 1;
        } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
      quoted = true;
    } else if (ch === ",") endField();
    else if (ch === "\r" || ch === "\n") {
      endField();
      records.push(record);
      record = [];
      if (ch === "\r" && src[i + 1] === "\n") i += 1;
    } else field += ch;
  }
  if (field !== "" || quoted || record.length > 0) {
    endField();
    records.push(record);
  }
  const [header = [], ...rows] = records;
  return { columns: header.map((name) => name ?? ""), rows };
}

// ===== 백업 =============================================================

export function folderName(now = new Date()) {
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

export async function backup(session, outDir, log = console.log) {
  // 다 받은 뒤에 이름을 바꾼다 — 도중에 끊긴 폴더가 온전한 백업처럼 보이지 않게.
  const partial = `${outDir}.partial`;
  fs.rmSync(partial, { recursive: true, force: true });
  fs.mkdirSync(partial, { recursive: true });

  const tables = await rpc(session, "pelham_backup_tables");
  const manifest = { app: "pelhamhills", version: 1, created_at: new Date().toISOString(), by: session.email, tables: [] };
  let total = 0;
  for (const table of tables) {
    const rows = [];
    let columns = table.columns.map((column) => column.name);
    for (let offset = 0; ; offset += EXPORT_PAGE) {
      const page = await rpc(session, "pelham_backup_export", { p_table: table.table, p_offset: offset, p_limit: EXPORT_PAGE });
      columns = page.columns;
      rows.push(...page.rows);
      if (page.rows.length < EXPORT_PAGE) break;
    }
    const file = `${table.table}.csv`;
    fs.writeFileSync(path.join(partial, file), toCsv(columns, rows));
    manifest.tables.push({ ...table, rows: rows.length, file });
    total += rows.length;
    log(`  ${table.table}: ${rows.length}`);
  }
  fs.writeFileSync(path.join(partial, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.renameSync(partial, outDir);
  return { tables: tables.length, rows: total };
}

/** keepDays 보다 오래된 백업 폴더를 지운다. 이름이 pelhamhills-backup-YYYY-MM-DD 로 시작하는 것만. */
export function pruneOld(dir, keepDays, log = console.log) {
  if (!(keepDays > 0) || !fs.existsSync(dir)) return;
  const cutoff = Date.now() - keepDays * 86_400_000;
  for (const name of fs.readdirSync(dir)) {
    const match = name.match(/^pelhamhills-backup-(\d{4}-\d{2}-\d{2})_\d{4}(\.partial)?$/);
    if (!match || Date.parse(`${match[1]}T23:59:59Z`) >= cutoff) continue;
    fs.rmSync(path.join(dir, name), { recursive: true, force: true });
    log(`  removed old ${name}`);
  }
}

// ===== 복원 =============================================================

export function loadFolder(folder) {
  const manifestPath = path.join(folder, "manifest.json");
  const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, "utf8")) : null;
  if (manifest && manifest.app !== "pelhamhills") throw new Error("This folder isn't a Pelham Hills backup.");
  const tables = [];
  for (const name of fs.readdirSync(folder).sort()) {
    const match = name.match(/^(?:.*__)?(pelham_[a-z0-9_]+)\.csv$/);
    if (!match) continue;
    const parsed = parseCsv(fs.readFileSync(path.join(folder, name), "utf8"));
    tables.push({ table: match[1], columns: parsed.columns, rows: parsed.rows });
  }
  if (tables.length === 0) throw new Error(`No pelham_*.csv files in ${folder}.`);
  return { createdAt: manifest?.created_at ?? null, tables };
}

/** 화면의 runRestore 와 같은 순서: 부모부터 넣고, replace 면 자식부터 백업에 없는 줄을 지운다. */
export async function restore(session, loaded, chosen, replace, log = console.log) {
  const live = await rpc(session, "pelham_backup_tables");
  const liveOf = new Map(live.map((table) => [table.table, table]));
  const picked = loaded.tables
    .filter((table) => chosen.includes(table.table))
    .sort((a, b) => (liveOf.get(a.table)?.order ?? 99) - (liveOf.get(b.table)?.order ?? 99) || a.table.localeCompare(b.table));
  const results = new Map();

  for (const table of picked) {
    const result = { table: table.table, restored: 0, removed: 0, error: null };
    results.set(table.table, result);
    const current = liveOf.get(table.table);
    if (!current) {
      result.error = "not in the database any more — skipped";
      continue;
    }
    try {
      if (current.key.length === 0) {
        if (!replace) {
          result.error = "no primary key — only --replace can restore this table";
          continue;
        }
        result.removed = await rpc(session, "pelham_backup_prune", { p_table: table.table, p_keys: [] });
      }
      for (let start = 0; start < table.rows.length; start += RESTORE_CHUNK) {
        result.restored += await rpc(session, "pelham_backup_restore", {
          p_table: table.table,
          p_columns: table.columns,
          p_rows: table.rows.slice(start, start + RESTORE_CHUNK),
        });
      }
    } catch (error) {
      result.error = error.message;
    }
    log(`  ${table.table}: ${result.restored} restored${result.error ? ` — ${result.error}` : ""}`);
  }

  if (replace) {
    for (const table of [...picked].reverse()) {
      const result = results.get(table.table);
      const current = liveOf.get(table.table);
      if (result.error || !current || current.key.length === 0) continue;
      const positions = current.key.map((name) => table.columns.indexOf(name));
      if (positions.some((index) => index < 0)) {
        result.error = "backup is missing a key column — rows were not removed";
        continue;
      }
      try {
        result.removed = await rpc(session, "pelham_backup_prune", {
          p_table: table.table,
          p_keys: table.rows.map((row) => positions.map((index) => row[index] ?? null)),
        });
        if (result.removed) log(`  ${table.table}: ${result.removed} removed`);
      } catch (error) {
        result.error = error.message;
        log(`  ${table.table}: ${error.message}`);
      }
    }
  }
  return [...results.values()];
}
