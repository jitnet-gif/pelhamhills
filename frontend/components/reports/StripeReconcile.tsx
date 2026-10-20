"use client";

/**
 * Stripe check — Stripe 가 실제로 받은·돌려준 카드 돈과 우리 전산 기록을 PaymentIntent 하나씩 맞춰 본다.
 *
 * 하루 마감(Daily close)은 우리 장부 안에서만 더한다. 그래서 "단말기에서는 승인됐는데 계산서에 안 붙음",
 * "전산에서는 환불했는데 카드는 그대로", "Stripe 대시보드에서 직접 환불" 같은 어긋남은 거기서 보이지 않는다.
 * 이 화면이 그것을 찾는다. 대조는 서버가 한다(`lib/reports/stripeReconcile.ts`). 여기는 읽기만 한다 —
 * 고치는 일은 영수증(Daily close)이나 Stripe 대시보드에서 한다.
 *
 * Problem = 돈이 어긋났다. Check = 돈은 맞지만 기록이 덜 끝났다. Matched = 둘이 같다.
 */

import { useEffect, useMemo, useState } from "react";

import { localBusinessDate } from "@/lib/retail/api";
import { formatMoney } from "@/lib/retail/types";
import { downloadBlob, workbookToXlsx } from "@/lib/reports/exportXlsx";
import {
  buildReconcileWorkbook,
  cardText,
  clubTime,
  fetchReconcile,
  LEVEL_LABEL,
  MAX_DAYS,
  rowDifference,
  SOURCE_LABEL,
  stripeUrl,
  type Level,
  type ReconcileReport,
  type ReconcileRow,
} from "@/lib/reports/stripeReconcile";

import { Button, Chip, EmptyNote, ErrorNote, Field, Panel, SkeletonRows, StatCard, TextInput } from "@/components/retail/ui";

const BADGE: Record<Level, string> = {
  error: "bg-[#fdecec] text-[#8a1f1f] border-[#e2a5a5]",
  warn: "bg-[#fff6e0] text-[#7a5200] border-[#e8c873]",
  ok: "bg-[#ecf7ef] text-[#1d6b34] border-[#a8d5b5]",
};

const FILTERS = [
  { key: "issues", label: "Problems & checks" },
  { key: "all", label: "All payments" },
] as const;

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

export default function StripeReconcile() {
  const [from, setFrom] = useState(() => localBusinessDate());
  const [to, setTo] = useState(() => localBusinessDate());
  // 마지막으로 받은 결과와 그 요청(key). 지금 key 와 다르면 읽는 중이다.
  const [loaded, setLoaded] = useState<{ key: string; report: ReconcileReport | null; error: string }>({
    key: "",
    report: null,
    error: "",
  });
  const [exportError, setExportError] = useState("");
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["key"]>("issues");
  const [exporting, setExporting] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const rangeError = useMemo(() => {
    if (!from || !to) return "Pick both dates.";
    if (to < from) return "'To' is before 'From'.";
    if (daysBetween(from, to) > MAX_DAYS) return `Pick ${MAX_DAYS} days or fewer.`;
    return "";
  }, [from, to]);

  const requestKey = `${from}|${to}|${reloadKey}`;
  const loading = !rangeError && loaded.key !== requestKey;
  const report = loaded.key === requestKey ? loaded.report : null;
  const error = (loaded.key === requestKey ? loaded.error : "") || exportError;

  useEffect(() => {
    if (rangeError) return;
    let cancelled = false;
    fetchReconcile(from, to)
      .then((result) => {
        if (cancelled) return;
        setLoaded({ key: requestKey, report: result, error: "" });
        // 문제가 없으면 "전부" 를 보여 준다. 빈 표만 보면 실제로 대조가 됐는지 알 수 없다.
        setFilter(result.summary.errors + result.summary.warnings > 0 ? "issues" : "all");
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        const message = cause instanceof Error ? cause.message : "Could not load the Stripe check.";
        setLoaded({ key: requestKey, report: null, error: message });
      });
    return () => {
      cancelled = true;
    };
  }, [from, to, rangeError, requestKey]);

  const rows = useMemo(
    () => (report ? report.rows.filter((row) => filter === "all" || row.level !== "ok") : []),
    [report, filter],
  );

  async function exportXlsx() {
    if (!report) return;
    setExporting(true);
    setExportError("");
    try {
      const blob = await workbookToXlsx(buildReconcileWorkbook(report));
      downloadBlob(blob, `PelhamHills_StripeCheck_${report.from}_to_${report.to}.xlsx`);
    } catch (cause) {
      setExportError(cause instanceof Error ? cause.message : "Could not build the Excel file.");
    } finally {
      setExporting(false);
    }
  }

  const s = report?.summary;

  return (
    <div className="grid min-w-0 gap-3">
      <div className="flex flex-wrap items-end gap-2">
        <Field label="From">
          <TextInput max={to} onChange={(event) => setFrom(event.target.value)} type="date" value={from} />
        </Field>
        <Field label="To">
          <TextInput min={from} onChange={(event) => setTo(event.target.value)} type="date" value={to} />
        </Field>
        <Button disabled={loading || !!rangeError} onClick={() => setReloadKey((key) => key + 1)}>
          Check again
        </Button>
        <Button disabled={!report || loading || exporting} onClick={exportXlsx} tone="primary">
          {exporting ? "Building…" : "Download Excel (.xlsx)"}
        </Button>
      </div>

      {rangeError ? <ErrorNote>{rangeError}</ErrorNote> : null}
      {error ? <ErrorNote>{error}</ErrorNote> : null}

      {report?.environment === "test" ? (
        <p className="border border-[#e8c873] bg-[#fff6e0] px-3 py-2 text-sm text-[#7a5200]">
          Stripe is in <b>test mode</b>. These are test payments, not real money.
        </p>
      ) : null}
      {report?.truncated ? (
        <p className="border border-[#e8c873] bg-[#fff6e0] px-3 py-2 text-sm text-[#7a5200]">
          Too many payments to check them all in one go
          {report.unchecked ? ` (${report.unchecked} not looked up in Stripe)` : ""}. Pick a shorter range.
        </p>
      ) : null}

      {loading && !rangeError ? (
        <SkeletonRows count={6} />
      ) : s && report ? (
        <>
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-3 xl:grid-cols-6">
            <StatCard
              hint={`${formatMoney(s.stripe_charged)} in − ${formatMoney(s.stripe_refunded)} refunded`}
              label="Stripe net"
              value={formatMoney(s.stripe_net)}
            />
            <StatCard
              hint={`${formatMoney(s.ours_charged)} in − ${formatMoney(s.ours_refunded)} refunded`}
              label="Our records net"
              value={formatMoney(s.ours_net)}
            />
            <StatCard
              hint={s.difference === 0 ? "Stripe and our records agree" : "Stripe − our records"}
              label="Difference"
              value={formatMoney(s.difference)}
            />
            <StatCard
              hint="money does not match"
              label="Problems"
              onClick={() => setFilter("issues")}
              value={String(s.errors)}
            />
            <StatCard
              hint="money matches, records unfinished"
              label="To check"
              onClick={() => setFilter("issues")}
              value={String(s.warnings)}
            />
            <StatCard
              hint="Stripe = our records"
              label="Matched"
              onClick={() => setFilter("all")}
              value={String(s.matched)}
            />
          </div>

          <Verdict report={report} />

          <Panel
            actions={
              <div className="flex gap-2">
                {FILTERS.map((item) => (
                  <Chip active={filter === item.key} key={item.key} onClick={() => setFilter(item.key)}>
                    {item.label}
                  </Chip>
                ))}
              </div>
            }
            title="Card payments"
          >
            {rows.length === 0 ? (
              <EmptyNote>
                {report.rows.length === 0
                  ? "No card payments through Stripe in this range."
                  : "Nothing to fix — every Stripe payment matches our records."}
              </EmptyNote>
            ) : (
              <ReconcileTable environment={report.environment} rows={rows} />
            )}
          </Panel>

          <p className="text-xs text-[#6b7280]">
            {s.outside_window > 0
              ? `${s.outside_window} payment(s) were made before this range but refunded or changed in it, so they are included. `
              : ""}
            {report.keyed.count > 0
              ? `${report.keyed.count} card payment(s) totalling ${formatMoney(report.keyed.amount)} were keyed in by hand ` +
                "(not through Stripe), so they cannot be checked here. "
              : ""}
            Checked {clubTime(report.generated_at)}. Amounts include tips.
          </p>
        </>
      ) : null}
    </div>
  );
}

function Verdict({ report }: { report: ReconcileReport }) {
  const s = report.summary;
  if (s.rows === 0) return null;
  const ok = s.errors === 0 && s.difference === 0;
  return (
    <p
      className={`border px-3 py-2 text-sm font-bold ${
        ok ? (s.warnings ? BADGE.warn : BADGE.ok) : BADGE.error
      }`}
    >
      {ok
        ? s.warnings
          ? `Money matches Stripe. ${s.warnings} payment(s) need a look to finish the records.`
          : `All ${s.matched} card payment(s) match Stripe.`
        : `${s.errors} payment(s) do not match Stripe` +
          (s.difference !== 0 ? ` — Stripe is ${formatMoney(Math.abs(s.difference))} ${s.difference > 0 ? "higher" : "lower"} than our records.` : ".")}
    </p>
  );
}

type SortKey = "level" | "at" | "payment" | "stripe" | "record" | "ours" | "diff" | "check";
type Sort = { key: SortKey; dir: "asc" | "desc" };

const LEVEL_RANK: Record<Level, number> = { ok: 0, warn: 1, error: 2 };

const COLUMNS: { key: SortKey; label: string; right?: boolean }[] = [
  { key: "level", label: "Status" },
  { key: "at", label: "Time" },
  { key: "payment", label: "Payment" },
  { key: "stripe", label: "Stripe", right: true },
  { key: "record", label: "Our record" },
  { key: "ours", label: "Ours", right: true },
  { key: "diff", label: "Diff", right: true },
  { key: "check", label: "What to check" },
];

// 정렬 값. null 은 방향과 상관없이 맨 아래로 보낸다(값 없는 줄이 위를 차지하지 않게).
function sortValue(row: ReconcileRow, key: SortKey): number | string | null {
  switch (key) {
    case "level":
      return LEVEL_RANK[row.level];
    case "at":
      return row.at ? Date.parse(row.at) : null;
    case "payment":
      return `${SOURCE_LABEL[row.source]} ${cardText(row)}`.toLowerCase();
    case "stripe":
      return row.stripe ? row.stripe.amount - row.stripe.refunded : null;
    case "record":
      return row.ours ? `${row.ours.label} ${row.ours.receipt_no ?? ""}`.toLowerCase() : null;
    case "ours":
      return row.ours ? row.ours.amount - row.ours.refunded : null;
    case "diff":
      return rowDifference(row);
    case "check":
      return row.issues.length ? row.issues.map((issue) => issue.message).join(" ").toLowerCase() : null;
  }
}

function sortRows(rows: ReconcileRow[], sort: Sort): ReconcileRow[] {
  const sign = sort.dir === "asc" ? 1 : -1;
  return rows
    .map((row, index) => ({ row, index, value: sortValue(row, sort.key) }))
    .sort((a, b) => {
      if (a.value === null || b.value === null) {
        if (a.value === b.value) return a.index - b.index;
        return a.value === null ? 1 : -1;
      }
      const order =
        typeof a.value === "number" && typeof b.value === "number"
          ? a.value - b.value
          : String(a.value).localeCompare(String(b.value), undefined, { numeric: true });
      // 같은 값이면 시간 순, 그것도 같으면 원래 순서.
      return order * sign || (Date.parse(a.row.at ?? "") || 0) - (Date.parse(b.row.at ?? "") || 0) || a.index - b.index;
    })
    .map((item) => item.row);
}

function ReconcileTable({ rows, environment }: { rows: ReconcileRow[]; environment: "test" | "live" }) {
  const [sort, setSort] = useState<Sort>({ key: "at", dir: "asc" });
  const sorted = useMemo(() => sortRows(rows, sort), [rows, sort]);

  function toggle(key: SortKey) {
    setSort((current) =>
      current.key === key ? { key, dir: current.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" },
    );
  }

  return (
    <div className="-mx-3 overflow-x-auto">
      <table className="w-full min-w-[900px] text-sm">
        <thead>
          <tr className="border-b border-[#d4d4d8] text-left text-[11px] font-bold tracking-wide text-[#6b7280] uppercase">
            {COLUMNS.map((column) => {
              const active = sort.key === column.key;
              return (
                <th
                  aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
                  className={`px-3 py-2 ${column.right ? "text-right" : ""}`}
                  key={column.key}
                >
                  <button
                    className={`inline-flex items-center gap-1 uppercase hover:text-[#111827] ${
                      active ? "text-[#111827]" : ""
                    }`}
                    onClick={() => toggle(column.key)}
                    title={`Sort by ${column.label}`}
                    type="button"
                  >
                    {column.label}
                    <span aria-hidden className={active ? "" : "opacity-30"}>
                      {active ? (sort.dir === "asc" ? "▲" : "▼") : "↕"}
                    </span>
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => (
            <ReconcileLine environment={environment} key={row.key} row={row} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Amounts({ amount, refunded }: { amount: number; refunded: number }) {
  return (
    <>
      <span className="font-bold">{formatMoney(amount)}</span>
      {refunded ? <span className="block text-xs text-[#8a1f1f]">−{formatMoney(refunded)} refunded</span> : null}
    </>
  );
}

function ReconcileLine({ row, environment }: { row: ReconcileRow; environment: "test" | "live" }) {
  const diff = rowDifference(row);
  const ours = row.ours;
  return (
    <tr className="border-b border-[#ececef] align-top">
      <td className="px-3 py-2">
        <span className={`inline-block border px-1.5 py-0.5 text-xs font-bold ${BADGE[row.level]}`}>
          {LEVEL_LABEL[row.level]}
        </span>
      </td>
      <td className="px-3 py-2 whitespace-nowrap tabular-nums">{clubTime(row.at)}</td>
      <td className="px-3 py-2">
        <span className="block">{SOURCE_LABEL[row.source]}</span>
        <span className="block text-xs text-[#6b7280]">{cardText(row)}</span>
        {row.stripe ? (
          <a
            className="block text-xs break-all text-[#4533ff] underline"
            href={stripeUrl(environment, row.stripe.payment_intent)}
            rel="noreferrer"
            target="_blank"
          >
            {row.stripe.payment_intent}
          </a>
        ) : (
          <span className="block text-xs text-[#8a1f1f]">Not in Stripe</span>
        )}
      </td>
      <td className="px-3 py-2 text-right tabular-nums">
        {row.stripe ? <Amounts amount={row.stripe.amount} refunded={row.stripe.refunded} /> : "—"}
      </td>
      <td className="px-3 py-2">
        {ours ? (
          <>
            <span className="block">{ours.label}</span>
            {ours.customer_name ? <span className="block text-xs text-[#6b7280]">{ours.customer_name}</span> : null}
            {ours.receipt_no ? (
              <a
                className="block text-xs text-[#4533ff] underline"
                href={`/admin/reports?date=${ours.business_date ?? ""}`}
              >
                {ours.receipt_no}
                {ours.bill_status ? ` · ${ours.bill_status}` : ""}
              </a>
            ) : (
              <span className="block text-xs text-[#6b7280]">
                {ours.bill_status ? `Bill ${ours.bill_status}` : `Status: ${ours.status}`}
              </span>
            )}
          </>
        ) : (
          <span className="text-[#8a1f1f]">No record</span>
        )}
      </td>
      <td className="px-3 py-2 text-right tabular-nums">
        {ours ? <Amounts amount={ours.amount} refunded={ours.refunded} /> : "—"}
      </td>
      <td className={`px-3 py-2 text-right font-bold tabular-nums ${diff ? "text-[#8a1f1f]" : "text-[#6b7280]"}`}>
        {diff ? formatMoney(diff) : "—"}
      </td>
      <td className="px-3 py-2">
        {row.issues.length ? (
          <ul className="grid gap-1">
            {row.issues.map((issue) => (
              <li className={issue.level === "error" ? "text-[#8a1f1f]" : "text-[#7a5200]"} key={issue.code}>
                {issue.message}
              </li>
            ))}
          </ul>
        ) : (
          <span className="text-[#6b7280]">Matches</span>
        )}
      </td>
    </tr>
  );
}
