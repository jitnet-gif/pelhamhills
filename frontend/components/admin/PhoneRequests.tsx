"use client";

/**
 * 전화 비서가 받은 음식 주문·현장 문제·컴플레인(0099) 의 직원 화면.
 *
 *   PhoneFoodOrders compact — 스낵바 계산대 위. 처리 안 된 주문(New·Ready)만, 30초마다 다시 읽는다.
 *                             주문이 없으면 아무것도 그리지 않는다(계산대를 가리지 않게).
 *   PhoneFoodOrders         — Calls & SMS 의 Food orders 탭. 지난 주문까지.
 *   PhoneReports kind=…     — Calls & SMS 의 Problems · Complaints 탭.
 *
 * 누가 언제 바꿨는지는 서버가 적는다. 메모는 상태 버튼을 누를 때 같이 저장된다(Phone callbacks 와 같다).
 */

import { useCallback, useEffect, useState } from "react";

import { callbackTime } from "@/lib/callbacks";
import {
  FOOD_STATUS_LABEL,
  PROBLEM_LABEL,
  REPORT_STATUS_LABEL,
  phoneRequestsApi,
  type FoodOrder,
  type FoodOrderStatus,
  type PhoneReport,
  type ReportKind,
  type ReportStatus,
} from "@/lib/phoneRequests";
import { formatMoney } from "@/lib/retail/types";
import { ApiError } from "@/lib/teeSheet/api";

import { Button, Chip, EmptyNote, ErrorNote, SkeletonRows, TextInput } from "@/components/retail/ui";

/** 스낵바 화면이 다시 읽는 간격. 주문이 전화로 들어오고 나서 직원 눈에 닿기까지의 최대 지연. */
const POLL_MS = 30_000;

function describe(cause: unknown): string {
  if (cause instanceof ApiError && cause.status === 0) return "Can't reach the server. Check the connection and try again.";
  if (cause instanceof ApiError && cause.status === 404)
    return "Phone orders aren't set up yet — run 0099_phone_orders_reports.sql in the Supabase SQL editor.";
  return (cause as Error)?.message ?? "Something went wrong.";
}

function useList<T>(read: () => Promise<T[]>, poll = false) {
  const [rows, setRows] = useState<T[] | null>(null);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const refresh = useCallback(() => setReload((count) => count + 1), []);

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
  }, [read, reload]);

  useEffect(() => {
    if (!poll) return;
    const timer = window.setInterval(refresh, POLL_MS);
    return () => window.clearInterval(timer);
  }, [poll, refresh]);

  return { rows, setRows, error, setError, refresh };
}

function caller(row: { first_name: string; last_name: string }): string {
  return `${row.first_name} ${row.last_name}`.trim() || "—";
}

const FOOD_BADGE: Record<FoodOrderStatus, string> = {
  new: "bg-[#fff1cc] text-[#8a5a00]",
  ready: "bg-[#e6efff] text-[#2449b3]",
  picked_up: "bg-[#dcfce7] text-[#166534]",
  cancelled: "bg-[#f3f4f6] text-[#6b7280]",
};

const FOOD_FILTERS = [
  { key: "active", label: "To do" },
  { key: "picked_up", label: "Picked up" },
  { key: "cancelled", label: "Cancelled" },
  { key: "all", label: "All" },
] as const;

type FoodFilter = (typeof FOOD_FILTERS)[number]["key"];

function isActive(row: FoodOrder): boolean {
  return row.status === "new" || row.status === "ready";
}

export function PhoneFoodOrders({ compact = false, refreshKey = 0 }: { compact?: boolean; refreshKey?: number }) {
  // compact 는 처리 안 된 것만 읽는다. 탭은 전부 읽고 칩으로 거른다.
  const read = useCallback(
    () => phoneRequestsApi.foodOrders(compact ? "active" : undefined),
    // refreshKey 가 바뀌면 다시 읽는다(Calls & SMS 의 Refresh).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [compact, refreshKey],
  );
  const { rows, setRows, error, setError } = useList(read, compact);
  const [filter, setFilter] = useState<FoodFilter>("active");
  const [busy, setBusy] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});

  async function update(row: FoodOrder, status: FoodOrderStatus) {
    setBusy(row.id);
    setError("");
    try {
      const note = notes[row.id];
      const saved = await phoneRequestsApi.updateFoodOrder(
        row.id,
        note === undefined ? { status } : { status, staff_notes: note },
      );
      setRows((current) =>
        (current ?? [])
          .map((item) => (item.id === saved.id ? saved : item))
          .filter((item) => !compact || isActive(item)),
      );
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setBusy(null);
    }
  }

  const all = rows ?? [];
  const visible = compact
    ? all.filter(isActive)
    : filter === "all"
      ? all
      : filter === "active"
        ? all.filter(isActive)
        : all.filter((row) => row.status === filter);

  // 스낵바 계산대: 주문이 없으면(또는 0099 전이면) 자리를 차지하지 않는다.
  if (compact && visible.length === 0) return null;

  const cards = (
    <div className={compact ? "grid gap-2 md:grid-cols-2 xl:grid-cols-3" : "grid gap-2 lg:grid-cols-2"}>
      {visible.map((row) => (
        <article className="grid gap-2 border border-[#d4d4d8] bg-white p-3" key={row.id}>
          <header className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="text-base font-bold">
              {row.ticket} · {caller(row)}
            </span>
            <span className={`px-1.5 py-0.5 text-xs font-bold ${FOOD_BADGE[row.status]}`}>
              {FOOD_STATUS_LABEL[row.status]}
            </span>
          </header>
          <ul className="grid gap-0.5 text-sm">
            {row.items.map((line, index) => (
              <li className="flex justify-between gap-3" key={`${line.product_id}-${index}`}>
                <span>
                  <b>{line.quantity}×</b> {line.name}
                  {line.note ? <span className="text-[#a4500f]"> — {line.note}</span> : null}
                </span>
                <span className="tabular-nums text-[#6b7280]">{formatMoney(line.unit_price * line.quantity)}</span>
              </li>
            ))}
          </ul>
          {row.notes ? <p className="bg-[#fff4dc] px-2 py-1 text-sm text-[#8a5a00]">Note: {row.notes}</p> : null}
          <p className="flex flex-wrap justify-between gap-2 text-xs text-[#4e5560]">
            <span>
              Ordered {callbackTime(row.created_at)}
              {row.pickup_time ? ` · pickup ${row.pickup_time}` : ""}
            </span>
            <span className="font-bold text-[#1f2328] tabular-nums">
              {formatMoney(row.total)} incl. HST · pay at pickup
            </span>
          </p>
          <a className="text-xs text-[#4533ff] tabular-nums underline" href={`tel:${row.phone}`}>
            {row.phone}
          </a>
          {!compact ? (
            <TextInput
              aria-label={`Notes for ${row.ticket}`}
              onChange={(event) => setNotes((current) => ({ ...current, [row.id]: event.target.value }))}
              placeholder="e.g. paid cash, swapped fries for salad"
              value={notes[row.id] ?? row.staff_notes ?? ""}
            />
          ) : null}
          <div className="flex flex-wrap gap-1.5">
            {row.status === "new" ? (
              <Button disabled={busy === row.id} onClick={() => update(row, "ready")} tone="primary">
                Ready
              </Button>
            ) : null}
            {isActive(row) ? (
              <>
                <Button disabled={busy === row.id} onClick={() => update(row, "picked_up")}>
                  Picked up
                </Button>
                <Button disabled={busy === row.id} onClick={() => update(row, "cancelled")} tone="danger">
                  Cancel
                </Button>
              </>
            ) : (
              <Button disabled={busy === row.id} onClick={() => update(row, "new")}>
                Reopen
              </Button>
            )}
          </div>
        </article>
      ))}
    </div>
  );

  if (compact) {
    return (
      <section className="grid gap-2 border-2 border-[#f0b429] bg-[#fffbeb] p-3" aria-label="Phone orders">
        <h2 className="text-sm font-bold text-[#8a5a00]">
          Phone orders · {visible.length} to make — the guest pays here at pickup
        </h2>
        {error ? <ErrorNote>{error}</ErrorNote> : null}
        {cards}
      </section>
    );
  }

  return (
    <div className="grid min-w-0 gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {FOOD_FILTERS.map((item) => (
          <Chip active={filter === item.key} key={item.key} onClick={() => setFilter(item.key)}>
            {item.label}
          </Chip>
        ))}
      </div>
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      {rows === null ? (
        <SkeletonRows count={4} />
      ) : visible.length === 0 ? (
        <EmptyNote>{filter === "active" ? "No phone orders waiting." : "No phone orders here."}</EmptyNote>
      ) : (
        cards
      )}
      <p className="text-xs text-[#6b7280]">
        The phone assistant takes snack bar orders from the Food &amp; Beverage products on the register. New orders
        also show above the Snack Bar register. Ring the order up at the register when the guest picks it up.
      </p>
    </div>
  );
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
