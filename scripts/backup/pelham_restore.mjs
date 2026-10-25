#!/usr/bin/env node
// 백업 폴더(매일 밤 것이든 어드민 화면에서 받은 것이든)로 클럽 표를 되살린다.
//
//   node scripts/backup/pelham_restore.mjs <폴더>                          무엇을 할지 보여 주기만 한다
//   node scripts/backup/pelham_restore.mjs <폴더> --yes                    merge: 백업의 줄을 되살린다
//   node scripts/backup/pelham_restore.mjs <폴더> --replace --yes          replace: 백업에 없는 줄도 지운다
//   node scripts/backup/pelham_restore.mjs <폴더> --tables pelham_customers,pelham_memberships --yes
//
// 권한 명단(*_viewers 등)은 기본으로 빼고, --tables 로 이름을 주면 넣는다(계정 관리자 계정만 된다).
// 되돌릴 수 있게 먼저 pelham_backup.mjs --manual 로 지금 상태를 받아 둔다.

import { loadConfig, loadFolder, rpc, signIn, restore } from "./lib.mjs";

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  const folder = process.argv[2];
  if (!folder || folder.startsWith("--")) {
    console.error("usage: node scripts/backup/pelham_restore.mjs <backup folder> [--tables a,b] [--replace] [--yes]");
    process.exit(2);
  }
  const replace = process.argv.includes("--replace");
  const yes = process.argv.includes("--yes");
  const only = arg("--tables")?.split(",").map((name) => name.trim()).filter(Boolean);

  const loaded = loadFolder(folder);
  const session = await signIn(loadConfig());
  const live = await rpc(session, "pelham_backup_tables");
  const liveOf = new Map(live.map((table) => [table.table, table]));

  const chosen = loaded.tables
    .map((table) => table.table)
    .filter((name) => name !== "pelham_backup_runs" && liveOf.has(name))
    .filter((name) => (only ? only.includes(name) : !liveOf.get(name).protected));

  console.log(`backup from ${loaded.createdAt ?? "(no manifest)"} · mode ${replace ? "REPLACE" : "merge"}`);
  for (const table of loaded.tables) {
    const now = liveOf.get(table.table);
    const mark = chosen.includes(table.table) ? "*" : " ";
    console.log(` ${mark} ${table.table.padEnd(36)} backup ${String(table.rows.length).padStart(7)}  now ${now ? String(now.rows).padStart(7) : "  (none)"}`);
  }
  if (!yes) {
    console.log("\nNothing changed. Add --yes to restore the * tables.");
    return;
  }

  const results = await restore(session, loaded, chosen, replace);
  const rows = results.reduce((sum, item) => sum + item.restored, 0);
  const failed = results.filter((item) => item.error);
  await rpc(session, "pelham_backup_log", {
    p_kind: "restore",
    p_source: "script",
    p_tables: results.length,
    p_rows: rows,
    p_note: `${replace ? "replace" : "merge"} · from ${loaded.createdAt ?? folder}${failed.length ? ` · ${failed.length} failed` : ""}`,
  }).catch(() => undefined);
  console.log(`\ndone: ${rows} rows restored${failed.length ? `, ${failed.length} table(s) failed` : ""}`);
  if (failed.length) process.exit(1);
}

main().catch((error) => {
  console.error(`restore FAILED: ${error.message}`);
  process.exit(1);
});
