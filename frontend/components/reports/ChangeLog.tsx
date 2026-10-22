"use client";

/**
 * Change log — 무엇이 언제, 누구 계정으로, 어떻게 바뀌었는지 전·후로(0057). Reports 의 자물쇠 탭.
 *
 * 예약·선수·계산서를 지워도 "지우기 전" 이 남는다. Reports 명단 계정만 본다 — 따로 비밀번호는 없다(0075).
 * 막는 것은 서버다: 명단에 없는 계정이 부르면 장부를 한 줄도 주지 않는다.
 */

import { useCallback, useEffect, useState } from "react";

import {
  diffRows,
  fetchChangeLog,
  newHistoryLines,
  TABLE_LABEL,
  tableLabel,
  type ChangeRow,
} from "@/lib/reports/changeLog";

import { Button, EmptyNote, ErrorNote, Field, Panel, Select, SkeletonRows, TextInput } from "@/components/retail/ui";

const OP_STYLE: Record<ChangeRow["op"], { label: string; className: string }> = {
  insert: { label: "Created", className: "bg-[#e3f4e8] text-[#1f6b3a]" },
  update: { label: "Changed", className: "bg-[#fff1cc] text-[#8a5a00]" },
  delete: { label: "Deleted", className: "bg-[#fde2e2] text-[#8a1f1f]" },
};

function isoDay(offset = 0): string {
  const at = new Date(Date.now() + offset * 86_400_000);
  return at.toLocaleDateString("en-CA", { timeZone: "America/Toronto" });
}

function clock(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime())
    ? iso
    : at.toLocaleString("en-CA", { timeZone: "America/Toronto", dateStyle: "medium", timeStyle: "medium" });
}

function errorText(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

export default function ChangeLog() {
  const [from, setFrom] = useState(() => isoDay(-6));
  const [to, setTo] = useState(() => isoDay());
  const [table, setTable] = useState("");
  const [search, setSearch] = useState("");
  const [rows, setRows] = useState<ChangeRow[] | null>(null);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(
    async (append?: { beforeId: number }) => {
      setBusy(true);
      setError("");
      try {
        const result = await fetchChangeLog({ from, to, table, search, beforeId: append?.beforeId });
        setRows((current) => (append && current ? [...current, ...result.rows] : result.rows));
        setMore(result.more);
      } catch (cause) {
        setError(errorText(cause, "Could not load the change log."));
      } finally {
        setBusy(false);
      }
    },
    [from, to, table, search],
  );

  // 열면 바로 지난 7일을 보여 준다. 필터를 바꾼 뒤에는 Show 로 다시 읽는다.
  useEffect(() => {
    let cancelled = false;
    fetchChangeLog({ from: isoDay(-6), to: isoDay() })
      .then((result) => {
        if (cancelled) return;
        setRows(result.rows);
        setMore(result.more);
      })
      .catch((cause) => {
        if (!cancelled) setError(errorText(cause, "Could not load the change log."));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="grid min-w-0 gap-3">
      <Panel title="Change log — before and after"
      >
        <form
          className="grid grid-cols-2 gap-2 sm:grid-cols-[repeat(4,minmax(0,1fr))_auto]"
          onSubmit={(event) => {
            event.preventDefault();
            void load();
          }}
        >
          <Field label="From">
            <TextInput onChange={(event) => setFrom(event.target.value)} type="date" value={from} />
          </Field>
          <Field label="To">
            <TextInput onChange={(event) => setTo(event.target.value)} type="date" value={to} />
          </Field>
          <Field label="What">
            <Select onChange={(event) => setTable(event.target.value)} value={table}>
              <option value="">Everything</option>
              {Object.keys(TABLE_LABEL).map((key) => (
                <option key={key} value={key}>
                  {tableLabel(key)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Search">
            <TextInput
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Name, receipt, email…"
              value={search}
            />
          </Field>
          <div className="col-span-2 flex items-end sm:col-span-1">
            <Button disabled={busy} full tone="primary" type="submit">
              Show
            </Button>
          </div>
        </form>
      </Panel>

      {error ? <ErrorNote>{error}</ErrorNote> : null}

      {rows === null ? (
        error ? null : <SkeletonRows count={4} />
      ) : rows.length === 0 ? (
        <EmptyNote>No changes in these days.</EmptyNote>
      ) : (
        <div className="grid gap-2">
          {rows.map((row) => (
            <ChangeCard key={row.id} row={row} />
          ))}
          {more ? (
            <Button disabled={busy} onClick={() => void load({ beforeId: rows[rows.length - 1].id })}>
              {busy ? "Loading…" : "Show older changes"}
            </Button>
          ) : null}
        </div>
      )}
    </div>
  );
}

const FIRST_FIELDS = 8;

function ChangeCard({ row }: { row: ChangeRow }) {
  const [all, setAll] = useState(false);
  const op = OP_STYLE[row.op];
  const fields = diffRows(row.before, row.after);
  const history = newHistoryLines(row.before, row.after);
  const shown = all ? fields : fields.slice(0, FIRST_FIELDS);

  return (
    <article className="min-w-0 border border-[#d4d4d8] bg-white">
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-[#ececf0] px-3 py-2 text-xs">
        <span className={`px-1.5 py-0.5 text-[11px] font-bold ${op.className}`}>{op.label}</span>
        <span className="font-bold">{tableLabel(row.table)}</span>
        <span className="min-w-0 truncate text-[#3f434a]">{row.label || row.rowKey || ""}</span>
        <span className="ml-auto text-[#6b7280] tabular-nums">{clock(row.at)}</span>
        <span className="w-full text-[11px] text-[#6b7280] sm:w-auto">by {row.actor}</span>
      </header>
      <div className="grid min-w-0 gap-2 px-3 py-2">
        {history.length > 0 ? (
          <ul className="grid gap-0.5 text-xs text-[#1f2328]">
            {history.map((line, index) => (
              <li key={index}>• {line}</li>
            ))}
          </ul>
        ) : null}
        {fields.length === 0 ? (
          <p className="text-xs text-[#6b7280]">Only the booking history changed.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-left text-xs">
              <thead className="text-[11px] tracking-wide text-[#6b7280] uppercase">
                <tr className="border-b border-[#ececf0]">
                  <th className="w-[34%] px-2 py-1 font-semibold">Field</th>
                  <th className="w-[33%] px-2 py-1 font-semibold">Before</th>
                  <th className="w-[33%] px-2 py-1 font-semibold">After</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((field) => (
                  <tr className="border-b border-[#f2f2f4] align-top" key={field.path}>
                    <td className="px-2 py-1 font-mono text-[11px] break-all text-[#3f434a]">{field.path}</td>
                    <td className="px-2 py-1 break-all text-[#8a1f1f]">
                      {field.before === null ? <span className="text-[#9aa0a6]">—</span> : <s>{field.before}</s>}
                    </td>
                    <td className="px-2 py-1 break-all text-[#1f6b3a]">
                      {field.after === null ? <span className="text-[#9aa0a6]">—</span> : field.after}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {fields.length > FIRST_FIELDS ? (
          <button
            className="justify-self-start text-xs font-semibold text-[#4533ff] hover:underline"
            onClick={() => setAll((value) => !value)}
            type="button"
          >
            {all ? "Show fewer" : `Show all ${fields.length} fields`}
          </button>
        ) : null}
      </div>
    </article>
  );
}
