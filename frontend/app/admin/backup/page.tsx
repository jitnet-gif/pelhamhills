"use client";

/**
 * 데이터 백업(Data Backup) — 클럽 데이터를 CSV 폴더로 받고, 그 폴더로 되살린다(0100, `lib/backup.ts`).
 *
 * 매니저(Reports 명단)와 계정 관리자에게만 메뉴가 뜨고, 주소로 들어와도 다른 계정에는 이유만 보인다. 막는 것은 서버다.
 * 복원은 analysis@pelhamhills.ca 한 계정만 한다(0110) — 다른 계정에는 복원 칸 대신 안내만 보인다.
 * 매일 밤 자동 백업은 사무실 맥이 한다(`scripts/backup/`). 여기 "Recent backups" 에 daily 로 남는다.
 */

import { useEffect, useMemo, useRef, useState, type InputHTMLAttributes } from "react";

import AdminShell from "@/components/admin/AdminShell";
import { Button, EmptyNote, ErrorNote, SkeletonRows, TextInput } from "@/components/retail/ui";
import {
  backupApi,
  backupFolderName,
  canPickFolder,
  describeBackupError,
  downloadSink,
  loadBackupFiles,
  pickFolderSink,
  runBackup,
  runRestore,
  useBackupAccess,
  type BackupRun,
  type BackupTable,
  type LoadedBackup,
  type Progress,
  type RestoreResult,
} from "@/lib/backup";
import { clubDateTime } from "@/lib/lostItems";
import { getSession } from "@/lib/teeSheet/session";

/** 자동 백업이 이보다 오래 없으면 경고한다(하루 + 여유). */
const DAILY_STALE_HOURS = 30;

export default function BackupPage() {
  return (
    <AdminShell title="Data Backup">
      <BackupGate />
    </AdminShell>
  );
}

function BackupGate() {
  const allowed = useBackupAccess(getSession()?.email ?? "");
  const [reason, setReason] = useState<string | null>(null);

  useEffect(() => {
    if (allowed !== false) return;
    let cancelled = false;
    backupApi
      .tables()
      .then(() => {
        if (!cancelled) setReason(null);
      })
      .catch((err) => {
        if (!cancelled) setReason(describeBackupError(err));
      });
    return () => {
      cancelled = true;
    };
  }, [allowed]);

  if (allowed === null) return <p className="p-4 text-sm text-[#4e5560]">확인 중…</p>;
  if (!allowed) {
    return (
      <div className="mx-auto grid max-w-md gap-3 p-4">
        <div className="bg-white p-5 text-sm shadow-sm">
          <p className="font-bold">Data Backup is for managers only.</p>
          <p className="mt-2 text-[#6b7280]">Sign in with a manager account (Reports) or Emmeline&apos;s ID.</p>
          {reason ? <p className="mt-3 text-[#8a1f1f]">{reason}</p> : null}
        </div>
      </div>
    );
  }
  return <BackupManager />;
}

function BackupManager() {
  const [tables, setTables] = useState<BackupTable[] | null>(null);
  const [runs, setRuns] = useState<BackupRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  // 기록을 읽은 시각 — 자동 백업이 늦었는지 여기에 견준다(그리는 중에 Date.now() 를 부르지 않게).
  const [loadedAt, setLoadedAt] = useState(0);
  const [canRestore, setCanRestore] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([backupApi.tables(), backupApi.runs()])
      .then(([nextTables, nextRuns]) => {
        if (cancelled) return;
        setTables(nextTables);
        setRuns(nextRuns);
        setLoadedAt(Date.now());
        setError(null);
      })
      .catch((err) => {
        if (!cancelled) setError(describeBackupError(err));
      });
    return () => {
      cancelled = true;
    };
  }, [version]);

  useEffect(() => {
    let cancelled = false;
    backupApi
      .canRestore()
      .then((value) => {
        if (!cancelled) setCanRestore(value);
      })
      .catch(() => {
        if (!cancelled) setCanRestore(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const refresh = () => setVersion((value) => value + 1);
  const lastDaily = runs?.find((run) => run.kind === "backup" && run.source === "daily") ?? null;
  const dailyStale = !lastDaily || loadedAt - Date.parse(lastDaily.created_at) > DAILY_STALE_HOURS * 3600_000;

  return (
    <div className="grid min-w-0 gap-3 p-4">
      <section className="grid gap-2 border border-[#d4d4d8] bg-white p-3 text-sm text-[#3f434a]">
        <p>
          Saves every club table (tee sheet, bills, payments, customers, memberships, retail, simulator …) as one CSV
          file per table, plus <b>manifest.json</b>. Sign-in passwords are not included.
        </p>
        <p>
          <b>At sign-in</b>: every time a manager or Emmeline signs in, the club data is saved as one ZIP in that
          computer&apos;s Downloads folder (and once a day if they stay signed in).
        </p>
        <p>
          <b>Daily backup</b> runs every night on the office Mac and keeps 30 days in <b>PelhamBackups</b>.{" "}
          {lastDaily ? (
            <>
              Last one: <b>{clubDateTime(lastDaily.created_at)}</b> · {lastDaily.tables} tables ·{" "}
              {lastDaily.rows.toLocaleString()} rows.
            </>
          ) : runs ? (
            <>No daily backup has run yet.</>
          ) : null}
        </p>
        {runs && dailyStale ? (
          <p className="font-bold text-[#8a1f1f]">
            The daily backup hasn&apos;t run in the last day. Check that the office Mac is on (see scripts/backup/README.md).
          </p>
        ) : null}
      </section>

      {error ? <ErrorNote>{error}</ErrorNote> : null}

      <BackupNow onDone={refresh} tables={tables} />
      {canRestore ? (
        <RestorePanel onDone={refresh} tables={tables} />
      ) : canRestore === false ? (
        <section className="grid gap-1 border border-[#d4d4d8] bg-white p-3 text-sm">
          <h2 className="text-base font-bold">Restore from a backup</h2>
          <p className="text-[#3f434a]">Only analysis@pelhamhills.ca can restore a backup.</p>
        </section>
      ) : null}

      <section className="grid gap-2 border border-[#d4d4d8] bg-white p-3">
        <h2 className="font-bold">Recent backups and restores</h2>
        {runs === null ? (
          error ? null : <SkeletonRows count={3} />
        ) : runs.length === 0 ? (
          <EmptyNote>Nothing yet.</EmptyNote>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-[#6b7280]">
                <tr>
                  <th className="py-1 pr-3">When</th>
                  <th className="py-1 pr-3">What</th>
                  <th className="py-1 pr-3">Account</th>
                  <th className="py-1 pr-3 text-right">Tables</th>
                  <th className="py-1 pr-3 text-right">Rows</th>
                  <th className="py-1">Note</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr className="border-t border-[#ececef]" key={run.id}>
                    <td className="py-1 pr-3 whitespace-nowrap">{clubDateTime(run.created_at)}</td>
                    <td className="py-1 pr-3 whitespace-nowrap">
                      {run.kind === "backup" ? "Backup" : "Restore"} · {run.source === "daily" ? "Nightly" : run.source === "login" ? "At sign-in" : run.source === "web" ? "This site" : "Script"}
                    </td>
                    <td className="py-1 pr-3 break-all">{run.email}</td>
                    <td className="py-1 pr-3 text-right tabular-nums">{run.tables}</td>
                    <td className="py-1 pr-3 text-right tabular-nums">{run.rows.toLocaleString()}</td>
                    <td className="py-1 break-all text-[#6b7280]">{run.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function ProgressBar({ progress }: { progress: Progress }) {
  const pct = progress.total ? Math.round((progress.done / progress.total) * 100) : 0;
  return (
    <div className="grid gap-1 text-sm">
      <div className="h-2 bg-[#ececef]">
        <div className="h-2 bg-[#4533ff]" style={{ width: `${pct}%` }} />
      </div>
      <p className="text-[#6b7280]">
        {progress.done}/{progress.total} · {progress.label}
      </p>
    </div>
  );
}

function BackupNow({ tables, onDone }: { tables: BackupTable[] | null; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const folderOk = canPickFolder();
  const totalRows = tables?.reduce((sum, table) => sum + table.rows, 0) ?? 0;

  const start = async () => {
    setBusy(true);
    setError(null);
    setMessage(null);
    const folder = backupFolderName();
    try {
      const sink = folderOk ? await pickFolderSink(folder) : downloadSink(folder);
      const done = await runBackup(sink, getSession()?.email ?? "", setProgress);
      setMessage(`Saved ${done.tables} tables · ${done.rows.toLocaleString()} rows to ${sink.where}.`);
      onDone();
    } catch (cause) {
      // 폴더 고르기를 취소하면 AbortError — 오류가 아니다.
      if ((cause as Error)?.name !== "AbortError") setError(describeBackupError(cause));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  return (
    <section className="grid gap-2 border border-[#d4d4d8] bg-white p-3 text-sm">
      <h2 className="text-base font-bold">Back up now</h2>
      <p className="text-[#3f434a]">
        {tables ? (
          <>
            {tables.length} tables · {totalRows.toLocaleString()} rows.{" "}
          </>
        ) : null}
        {folderOk
          ? "Choose a folder on this computer — a new dated folder is made inside it."
          : "This browser can't choose a folder, so each CSV is downloaded to Downloads. Chrome or Edge can save into a folder."}
      </p>
      <div>
        <Button disabled={busy || !tables} onClick={() => void start()} tone="primary">
          {busy ? "Backing up…" : "Back up now"}
        </Button>
      </div>
      {progress ? <ProgressBar progress={progress} /> : null}
      {message ? <p className="font-bold text-[#1f6b3a]">{message}</p> : null}
      {error ? <ErrorNote>{error}</ErrorNote> : null}
    </section>
  );
}

/** React 의 input 속성 타입에 webkitdirectory 가 없다. */
const FOLDER_INPUT = { webkitdirectory: "", directory: "" } as unknown as InputHTMLAttributes<HTMLInputElement>;

function RestorePanel({ tables, onDone }: { tables: BackupTable[] | null; onDone: () => void }) {
  const folderInput = useRef<HTMLInputElement>(null);
  const filesInput = useRef<HTMLInputElement>(null);
  const [backup, setBackup] = useState<LoadedBackup | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const [replace, setReplace] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [results, setResults] = useState<RestoreResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const liveOf = useMemo(() => new Map((tables ?? []).map((table) => [table.table, table])), [tables]);
  // 권한 명단은 처음에는 꺼 둔다 — 고른 사람만 되살린다.
  const restorable = (name: string) => liveOf.has(name) && name !== "pelham_backup_runs";

  const load = async (list: FileList | null) => {
    if (!list || list.length === 0) return;
    setError(null);
    setResults(null);
    setConfirm("");
    try {
      const loaded = await loadBackupFiles([...list]);
      loaded.tables.sort((a, b) => a.table.localeCompare(b.table));
      setBackup(loaded);
      setChosen(loaded.tables.filter((t) => restorable(t.table) && !liveOf.get(t.table)?.protected).map((t) => t.table));
    } catch (cause) {
      setBackup(null);
      setError((cause as Error).message);
    }
  };

  const start = async () => {
    if (!backup) return;
    setBusy(true);
    setError(null);
    try {
      setResults(await runRestore(backup, chosen, replace, setProgress));
      setConfirm("");
      onDone();
    } catch (cause) {
      setError(describeBackupError(cause));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const toggle = (name: string) =>
    setChosen((current) => (current.includes(name) ? current.filter((item) => item !== name) : [...current, name]));

  return (
    <section className="grid gap-2 border border-[#d4d4d8] bg-white p-3 text-sm">
      <h2 className="text-base font-bold">Restore from a backup</h2>
      <p className="text-[#3f434a]">
        Pick a backup folder (a daily one from PelhamBackups, or one saved here) or a sign-in backup ZIP from Downloads. Nothing changes until you press Restore.
        Back up now first so you can undo a restore.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy} onClick={() => folderInput.current?.click()}>
          Choose backup folder
        </Button>
        <Button disabled={busy} onClick={() => filesInput.current?.click()}>
          Choose ZIP or CSV files
        </Button>
        <input
          {...FOLDER_INPUT}
          className="hidden"
          multiple
          onChange={(event) => {
            void load(event.target.files);
            event.target.value = "";
          }}
          ref={folderInput}
          type="file"
        />
        <input
          accept=".csv,.json,.zip"
          className="hidden"
          multiple
          onChange={(event) => {
            void load(event.target.files);
            event.target.value = "";
          }}
          ref={filesInput}
          type="file"
        />
      </div>

      {error ? <ErrorNote>{error}</ErrorNote> : null}

      {backup ? (
        <div className="grid gap-3">
          <p>
            Backup from <b>{backup.createdAt ? clubDateTime(backup.createdAt) : "CSV files (no manifest)"}</b>
            {backup.by ? <> by {backup.by}</> : null} · {backup.tables.length} tables.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() =>
                setChosen(backup.tables.filter((t) => restorable(t.table) && !liveOf.get(t.table)?.protected).map((t) => t.table))
              }
            >
              Select all
            </Button>
            <Button onClick={() => setChosen([])}>Select none</Button>
          </div>
          <div className="max-h-80 overflow-auto border border-[#ececef]">
            <table className="w-full text-left text-sm">
              <thead className="sticky top-0 bg-white text-[#6b7280]">
                <tr>
                  <th className="px-2 py-1" />
                  <th className="px-2 py-1">Table</th>
                  <th className="px-2 py-1 text-right">In backup</th>
                  <th className="px-2 py-1 text-right">Now</th>
                </tr>
              </thead>
              <tbody>
                {backup.tables.map((table) => {
                  const live = liveOf.get(table.table);
                  const ok = restorable(table.table);
                  return (
                    <tr className="border-t border-[#ececef]" key={table.table}>
                      <td className="px-2 py-1">
                        <input
                          aria-label={`Restore ${table.table}`}
                          checked={chosen.includes(table.table)}
                          className="size-4"
                          disabled={!ok || busy}
                          onChange={() => toggle(table.table)}
                          type="checkbox"
                        />
                      </td>
                      <td className="px-2 py-1 break-all">
                        {table.table}
                        {live?.protected ? <span className="ml-2 text-xs text-[#8a5a00]">permission list</span> : null}
                        {!live ? <span className="ml-2 text-xs text-[#8a1f1f]">not in database</span> : null}
                      </td>
                      <td className="px-2 py-1 text-right tabular-nums">{table.rows.length.toLocaleString()}</td>
                      <td className="px-2 py-1 text-right tabular-nums">{live ? live.rows.toLocaleString() : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <fieldset className="grid gap-1">
            <label className="flex items-start gap-2">
              <input checked={!replace} className="mt-1 size-4" onChange={() => setReplace(false)} type="radio" />
              <span>
                <b>Merge</b> — put back the rows from the backup (rows with the same ID get the backup values). Rows added
                after the backup stay.
              </span>
            </label>
            <label className="flex items-start gap-2">
              <input checked={replace} className="mt-1 size-4" onChange={() => setReplace(true)} type="radio" />
              <span>
                <b>Replace</b> — also delete rows that aren&apos;t in the backup, so the chosen tables match the backup
                exactly. Sales and bookings made after the backup are lost.
              </span>
            </label>
          </fieldset>

          <label className="grid max-w-xs gap-1">
            <span className="font-bold text-[#3f434a]">Type RESTORE to confirm</span>
            <TextInput onChange={(event) => setConfirm(event.target.value)} value={confirm} />
          </label>
          <div>
            <Button
              disabled={busy || chosen.length === 0 || confirm.trim().toUpperCase() !== "RESTORE"}
              onClick={() => void start()}
              tone="danger"
            >
              {busy ? "Restoring…" : `Restore ${chosen.length} table${chosen.length === 1 ? "" : "s"}`}
            </Button>
          </div>
          {progress ? <ProgressBar progress={progress} /> : null}
        </div>
      ) : null}

      {results ? (
        <div className="grid gap-1">
          <p className="font-bold">
            {results.some((item) => item.error) ? "Restore finished with problems:" : "Restore finished."}
          </p>
          <ul className="grid gap-0.5">
            {results.map((item) => (
              <li className={item.error ? "text-[#8a1f1f]" : ""} key={item.table}>
                {item.table}: {item.restored.toLocaleString()} restored
                {item.removed ? ` · ${item.removed.toLocaleString()} removed` : ""}
                {item.error ? ` — ${item.error}` : ""}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
