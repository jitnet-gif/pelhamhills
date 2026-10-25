#!/usr/bin/env node
// 클럽 데이터(public.pelham_*)를 CSV 폴더로 받는다. launchd 가 매일 밤 부른다(install_daily_backup.sh).
//
//   node scripts/backup/pelham_backup.mjs            ~/PelhamBackups/pelhamhills-backup-<날짜_시각>/ (기록: daily)
//   node scripts/backup/pelham_backup.mjs --manual   손으로 돌릴 때 (기록: script)
//
// 끝나면 PELHAM_BACKUP_KEEP_DAYS(기본 30)보다 오래된 폴더를 지우고, 어드민 Data Backup 화면의 기록에 한 줄 남긴다.

import os from "node:os";
import path from "node:path";

import { backup, folderName, loadConfig, pruneOld, rpc, signIn } from "./lib.mjs";

const manual = process.argv.includes("--manual");

async function main() {
  const started = Date.now();
  const config = loadConfig();
  const session = await signIn(config);
  const out = path.join(config.dir, folderName());
  console.log(`${new Date().toISOString()} backup → ${out}`);
  const done = await backup(session, out);
  pruneOld(config.dir, config.keepDays);
  await rpc(session, "pelham_backup_log", {
    p_kind: "backup",
    p_source: manual ? "script" : "daily",
    p_tables: done.tables,
    p_rows: done.rows,
    p_note: `${path.basename(out)} on ${os.hostname()}`,
  }).catch((error) => console.warn(`  could not record the run: ${error.message}`));
  console.log(`done: ${done.tables} tables, ${done.rows} rows in ${Math.round((Date.now() - started) / 1000)}s`);
}

main().catch((error) => {
  console.error(`${new Date().toISOString()} backup FAILED: ${error.message}`);
  process.exit(1);
});
