"use client";

/**
 * 전화 상담 콜백 명단 — Reports(`/admin/reports?view=callbacks`)의 한 탭.
 *
 * 업무시간 밖에 걸려 온 전화에서 손님이 사람과 얘기해야 하면 전화 비서가 "업무시간에 직원이 전화드리겠습니다"
 * 라고 말하고 여기에 적는다(0059, `request_callback`). 직원은 위에서부터 전화하고 "Called" 로 바꾼다.
 * 누가 언제 바꿨는지는 서버가 적는다.
 *
 * 위 두 칸은 먼저 요청한 날짜별 요약, 날짜를 누르면 그 날 기다리는 손님들(2026-10-24, `ReportDrill`).
 */

import { useCallback, useEffect, useState } from "react";

import {
  CALLBACK_STATUS_LABEL,
  callbackTime,
  callbacksApi,
  type CallbackRequest,
  type CallbackStatus,
} from "@/lib/callbacks";
import { ApiError } from "@/lib/teeSheet/api";

import ReportDrill from "@/components/reports/ReportDrill";
import { Button, Chip, EmptyNote, ErrorNote, SkeletonRows, StatCard, TextInput } from "@/components/retail/ui";

const FILTERS = [
  { key: "open", label: "To call" },
  { key: "called", label: "Called" },
  { key: "closed", label: "Closed" },
  { key: "all", label: "All" },
] as const;

type Filter = (typeof FILTERS)[number]["key"];

function describe(cause: unknown): string {
  if (cause instanceof ApiError && cause.status === 0) return "Can't reach the server. Check the connection and try again.";
  if (cause instanceof ApiError && cause.status === 404)
    return "The callback list isn't set up yet — run 0059_callback_requests.sql in the Supabase SQL editor.";
  return (cause as Error)?.message ?? "Something went wrong.";
}

/** 요청한 날(브라우저 시간대) — 요약의 묶음. */
function requestedDay(iso: string): { key: string; label: string } {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return { key: "", label: "Unknown date" };
  return {
    key: at.toLocaleDateString("en-CA"),
    label: at.toLocaleDateString("en-CA", { weekday: "short", month: "short", day: "numeric" }),
  };
}

const BADGE: Record<CallbackStatus, string> = {
  open: "bg-[#fff1cc] text-[#8a5a00]",
  called: "bg-[#dcfce7] text-[#166534]",
  closed: "bg-[#f3f4f6] text-[#6b7280]",
};

export default function PhoneCallbacks() {
  const [filter, setFilter] = useState<Filter>("open");
  const [rows, setRows] = useState<CallbackRequest[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [drill, setDrill] = useState(false);

  const [reload, setReload] = useState(0);
  const load = useCallback(() => setReload((count) => count + 1), []);

  useEffect(() => {
    let cancelled = false;
    callbacksApi
      .list()
      .then((list) => {
        if (cancelled) return;
        setRows(list);
        setError("");
      })
      .catch((cause) => {
        if (cancelled) return;
        setRows([]);
        setError(describe(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [reload]);

  async function update(row: CallbackRequest, status: CallbackStatus) {
    setBusy(row.id);
    setError("");
    try {
      const note = notes[row.id];
      const saved = await callbacksApi.update(row.id, note === undefined ? { status } : { status, notes: note });
      setRows((current) => (current ?? []).map((item) => (item.id === saved.id ? saved : item)));
      setNotes((current) => {
        const next = { ...current };
        delete next[row.id];
        return next;
      });
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setBusy(null);
    }
  }

  const all = rows ?? [];
  const open = all.filter((row) => row.status === "open");
  const visible = filter === "all" ? all : all.filter((row) => row.status === filter);

  return (
    <div className="grid min-w-0 gap-3">
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <StatCard
          hint="waiting for a call from staff"
          label="To call"
          onClick={rows ? () => setDrill(true) : undefined}
          strong
          value={rows ? String(open.length) : "—"}
        />
        <StatCard
          hint="call this one first"
          label="Oldest waiting"
          onClick={open.length ? () => setDrill(true) : undefined}
          value={open.length ? callbackTime(open[open.length - 1].created_at) : "—"}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map((item) => (
          <Chip active={filter === item.key} key={item.key} onClick={() => setFilter(item.key)}>
            {item.label}
          </Chip>
        ))}
        <Button className="ml-auto" onClick={load}>
          Refresh
        </Button>
      </div>

      {error ? <ErrorNote>{error}</ErrorNote> : null}

      {rows === null ? (
        <SkeletonRows count={5} />
      ) : visible.length === 0 ? (
        <EmptyNote>{filter === "open" ? "Nobody is waiting for a call." : "No callback requests here."}</EmptyNote>
      ) : (
        <div className="min-w-0 overflow-x-auto border border-[#d4d4d8] bg-white">
          <table className="w-full min-w-[900px] text-left text-sm">
            <thead className="bg-[#f3f4f6] text-xs text-[#3f434a] uppercase">
              <tr>
                <th className="px-3 py-2">Requested</th>
                <th className="px-3 py-2">Caller</th>
                <th className="px-3 py-2">What they need</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Notes</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => (
                <tr className="border-t border-[#ececf0] align-top" key={row.id}>
                  <td className="px-3 py-2 whitespace-nowrap">
                    <span className="block tabular-nums">{callbackTime(row.created_at)}</span>
                    <span className="block text-xs text-[#6b7280]">{row.ticket}</span>
                  </td>
                  <td className="px-3 py-2">
                    <span className="block font-bold">{`${row.first_name} ${row.last_name}`.trim() || "—"}</span>
                    <a className="block text-[#4533ff] tabular-nums underline" href={`tel:${row.phone}`}>
                      {row.phone}
                    </a>
                    {row.caller_number && row.caller_number !== row.phone ? (
                      <span className="block text-xs text-[#6b7280]">called from {row.caller_number}</span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2">
                    <span className="block">{row.reason}</span>
                    {row.preferred_time ? (
                      <span className="block text-xs text-[#6b7280]">Best time: {row.preferred_time}</span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    <span className={`inline-block px-1.5 py-0.5 text-xs font-bold ${BADGE[row.status]}`}>
                      {CALLBACK_STATUS_LABEL[row.status]}
                    </span>
                    {row.handled_at ? (
                      <span className="block text-xs text-[#6b7280]">
                        {callbackTime(row.handled_at)}
                        {row.handled_by ? ` · ${row.handled_by}` : ""}
                      </span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2">
                    <TextInput
                      aria-label={`Notes for ${row.ticket}`}
                      onChange={(event) => setNotes((current) => ({ ...current, [row.id]: event.target.value }))}
                      placeholder="e.g. booked 2 groups, left voicemail"
                      value={notes[row.id] ?? row.notes ?? ""}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex gap-1.5">
                      {row.status === "open" ? (
                        <>
                          <Button disabled={busy === row.id} onClick={() => update(row, "called")} tone="primary">
                            Called
                          </Button>
                          <Button disabled={busy === row.id} onClick={() => update(row, "closed")}>
                            Close
                          </Button>
                        </>
                      ) : (
                        <Button disabled={busy === row.id} onClick={() => update(row, "open")}>
                          Reopen
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-xs text-[#6b7280]">
        The phone assistant adds a request here when someone calls outside staff hours and needs a person. Call them
        back during business hours, then press Called. Notes are saved when you press Called, Close or Reopen.
      </p>
      {drill ? (
        <ReportDrill
          groupName="days"
          groupOf={(row) => requestedDay(row.created_at)}
          itemOf={(row) => ({
            key: row.id,
            primary: `${`${row.first_name} ${row.last_name}`.trim() || "—"} · ${row.phone}`,
            secondary: [row.ticket,row.reason, row.preferred_time ? `best time ${row.preferred_time}` : ""]
              .filter(Boolean)
              .join(" · "),
            value: callbackTime(row.created_at),
          })}
          onClose={() => setDrill(false)}
          rows={[...open].reverse()}
          title="To call — oldest first"
          unit="caller"
        />
      ) : null}
    </div>
  );
}
