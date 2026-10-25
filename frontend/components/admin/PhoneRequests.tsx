"use client";

/**
 * 전화 비서가 받은 현장 문제·컴플레인(0099) 의 직원 화면 — Calls & SMS 의 Problems · Complaints 탭.
 * 전화 음식 주문은 여기 없다: GPS 앱의 주문(운영 관리 → 주문)으로 들어간다.
 *
 * 누가 언제 바꿨는지는 서버가 적는다. 메모는 상태 버튼을 누를 때 같이 저장된다(Phone callbacks 와 같다).
 */

import { useCallback, useEffect, useState } from "react";

import { callbackTime } from "@/lib/callbacks";
import {
  PROBLEM_LABEL,
  REPORT_STATUS_LABEL,
  phoneRequestsApi,
  type PhoneReport,
  type ReportKind,
  type ReportStatus,
} from "@/lib/phoneRequests";
import { ApiError } from "@/lib/teeSheet/api";

import { Button, Chip, EmptyNote, ErrorNote, SkeletonRows, TextInput } from "@/components/retail/ui";

function describe(cause: unknown): string {
  if (cause instanceof ApiError && cause.status === 0) return "Can't reach the server. Check the connection and try again.";
  if (cause instanceof ApiError && cause.status === 404)
    return "Phone reports aren't set up yet — run 0099_phone_reports.sql in the Supabase SQL editor.";
  return (cause as Error)?.message ?? "Something went wrong.";
}

function useList<T>(read: () => Promise<T[]>) {
  const [rows, setRows] = useState<T[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    read()
      .then((list) => {
        if (cancelled) return;
        setRows(list);
        setError("");
      })
      .catch((cause) => {
        if (cancelled) return;
        setRows((current) => current ?? []);
        setError(describe(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [read]);

  return { rows, setRows, error, setError };
}

function caller(row: { first_name: string; last_name: string }): string {
  return `${row.first_name} ${row.last_name}`.trim() || "—";
}

const REPORT_BADGE: Record<ReportStatus, string> = {
  open: "bg-[#fff1cc] text-[#8a5a00]",
  in_progress: "bg-[#e6efff] text-[#2449b3]",
  resolved: "bg-[#dcfce7] text-[#166534]",
  closed: "bg-[#f3f4f6] text-[#6b7280]",
};

const REPORT_FILTERS = [
  { key: "todo", label: "To do" },
  { key: "resolved", label: "Resolved" },
  { key: "closed", label: "Closed" },
  { key: "all", label: "All" },
] as const;

type ReportFilter = (typeof REPORT_FILTERS)[number]["key"];

function isOpen(row: PhoneReport): boolean {
  return row.status === "open" || row.status === "in_progress";
}

export function PhoneReports({ kind, refreshKey = 0 }: { kind: ReportKind; refreshKey?: number }) {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const read = useCallback(() => phoneRequestsApi.reports(kind), [kind, refreshKey]);
  const { rows, setRows, error, setError } = useList(read);
  const [filter, setFilter] = useState<ReportFilter>("todo");
  const [busy, setBusy] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});

  async function update(row: PhoneReport, status: ReportStatus) {
    setBusy(row.id);
    setError("");
    try {
      const note = notes[row.id];
      const saved = await phoneRequestsApi.updateReport(
        row.id,
        note === undefined ? { status } : { status, staff_notes: note },
      );
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
  const visible =
    filter === "all" ? all : filter === "todo" ? all.filter(isOpen) : all.filter((row) => row.status === filter);
  const problem = kind === "problem";

  return (
    <div className="grid min-w-0 gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {REPORT_FILTERS.map((item) => (
          <Chip active={filter === item.key} key={item.key} onClick={() => setFilter(item.key)}>
            {item.label}
          </Chip>
        ))}
      </div>
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      {rows === null ? (
        <SkeletonRows count={5} />
      ) : visible.length === 0 ? (
        <EmptyNote>
          {filter === "todo" ? (problem ? "No open problems." : "No open complaints.") : "Nothing here."}
        </EmptyNote>
      ) : (
        <div className="min-w-0 overflow-x-auto border border-[#d4d4d8] bg-white">
          <table className="w-full min-w-[900px] text-left text-sm">
            <thead className="bg-[#f3f4f6] text-xs text-[#3f434a] uppercase">
              <tr>
                <th className="px-3 py-2">Reported</th>
                <th className="px-3 py-2">Caller</th>
                <th className="px-3 py-2">{problem ? "Problem" : "Complaint"}</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Notes</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => (
                <tr
                  className={`border-t border-[#ececf0] align-top ${
                    problem && row.category === "injury" && isOpen(row) ? "bg-[#fdf2f2]" : ""
                  }`}
                  key={row.id}
                >
                  <td className="px-3 py-2 whitespace-nowrap">
                    <span className="block tabular-nums">{callbackTime(row.created_at)}</span>
                    <span className="block text-xs text-[#6b7280]">{row.ticket}</span>
                  </td>
                  <td className="px-3 py-2">
                    <span className="block font-bold">{caller(row)}</span>
                    <a className="block text-[#4533ff] tabular-nums underline" href={`tel:${row.phone}`}>
                      {row.phone}
                    </a>
                    {!problem && row.wants_callback ? (
                      <span className="block text-xs font-bold text-[#a4500f]">Wants a call back</span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2">
                    <span className="block font-bold">
                      {problem ? (PROBLEM_LABEL[row.category] ?? row.category) : row.category}
                      {row.location ? ` · ${row.location}` : ""}
                      {row.cart_number ? ` · cart ${row.cart_number}` : ""}
                    </span>
                    <span className="block">{row.details}</span>
                    {problem ? (
                      <span className="block text-xs text-[#6b7280]">
                        {row.staff_alerted_at ? `Staff texted ${callbackTime(row.staff_alerted_at)}` : "No staff text sent"}
                      </span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    <span className={`inline-block px-1.5 py-0.5 text-xs font-bold ${REPORT_BADGE[row.status]}`}>
                      {REPORT_STATUS_LABEL[row.status]}
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
                      placeholder={problem ? "e.g. sent a new cart to hole 7" : "e.g. called back, offered a rain check"}
                      value={notes[row.id] ?? row.staff_notes ?? ""}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex gap-1.5">
                      {row.status === "open" ? (
                        <Button disabled={busy === row.id} onClick={() => update(row, "in_progress")} tone="primary">
                          On it
                        </Button>
                      ) : null}
                      {isOpen(row) ? (
                        <>
                          <Button disabled={busy === row.id} onClick={() => update(row, "resolved")}>
                            Resolved
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
        {problem
          ? "The phone assistant logs cart and course problems here and texts the staff alert numbers if they are set. Press On it when someone is going, then Resolved."
          : "The phone assistant takes complaints down here. It never promises a refund or a discount — that is for a manager to decide."}{" "}
        Notes are saved when you press a status button.
      </p>
    </div>
  );
}
