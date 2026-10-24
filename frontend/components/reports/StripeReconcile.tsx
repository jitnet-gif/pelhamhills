"use client";

/**
 * Stripe check — Stripe 가 실제로 받은·돌려준 카드 돈과 우리 전산 기록을 PaymentIntent 하나씩 맞춰 본다.
 *
 * 하루 마감(Daily close)은 우리 장부 안에서만 더한다. 그래서 "단말기에서는 승인됐는데 계산서에 안 붙음",
 * "전산에서는 환불했는데 카드는 그대로", "Stripe 대시보드에서 직접 환불" 같은 어긋남은 거기서 보이지 않는다.
 * 이 화면이 그것을 찾는다. 대조는 서버가 한다(`lib/reports/stripeReconcile.ts`).
 * 줄을 누르면 상세 창(`ReconcileDetail.tsx`)이 열리고, 거기서 매출로 반영·카드 환불·그대로 둠을 정한다(0089).
 * `?view=stripe&date=…&pi=pi_…` 로 그 줄을 바로 연다.
 *
 * Problem = 돈이 어긋났다. Check = 돈은 맞지만 기록이 덜 끝났다. Matched = 둘이 같다.
 * Reviewed = 어긋났지만 그대로 두기로 정했다(이유가 남아 있다).
 *
 * 위 숫자 칸은 먼저 요약(금액 칸은 받은 곳별, Problems·To check 는 무엇이 어긋났는지별), 줄을 누르면 그 결제,
 * 결제를 누르면 상세 창(2026-10-24, `ReportDrill`).
 */

import { useEffect, useMemo, useRef, useState } from "react";

import { localBusinessDate } from "@/lib/retail/api";
import { formatMoney } from "@/lib/retail/types";
import { downloadBlob, workbookToXlsx } from "@/lib/reports/exportXlsx";
import {
  buildReconcileWorkbook,
  cardText,
  clubTime,
  DECISION_LABEL,
  fetchReconcile,
  LEVEL_LABEL,
  MAX_DAYS,
  rowDifference,
  SOURCE_LABEL,
  stripeUrl,
  type Level,
  type ReconcileReport,
  type ReconcileRow,
  type StripeAttempt,
} from "@/lib/reports/stripeReconcile";

import ReconcileDetail from "@/components/reports/ReconcileDetail";
import ReportDrill, { type DrillGroup } from "@/components/reports/ReportDrill";
import { Button, Chip, EmptyNote, ErrorNote, Field, Panel, SkeletonRows, StatCard, TextInput } from "@/components/retail/ui";

const BADGE: Record<Level, string> = {
  error: "bg-[#fdecec] text-[#8a1f1f] border-[#e2a5a5]",
  warn: "bg-[#fff6e0] text-[#7a5200] border-[#e8c873]",
  ok: "bg-[#ecf7ef] text-[#1d6b34] border-[#a8d5b5]",
};
const REVIEWED_BADGE = "bg-[#f3f2ff] text-[#2e2499] border-[#c7c2ff]";

const FILTERS = [
  { key: "issues", label: "Problems & checks" },
  { key: "all", label: "All payments" },
] as const;

/** 서버(`stripe_reconcile.py` 의 `_issue`) 코드 → 요약 줄 이름. 모르는 코드는 서버 문장 그대로. */
const ISSUE_LABEL: Record<string, string> = {
  stripe_only: "Charged in Stripe, no record here",
  not_recorded: "Charged in Stripe, not paid here",
  ours_only: "Paid here, not charged in Stripe",
  amount: "Amounts differ",
  refund_stripe_only: "Refunded in Stripe only",
  refund_ours_only: "Refunded here only",
  disputed: "Disputed (chargeback)",
  refund_pending: "Refund still pending on the reader",
  bill_open: "Charged, bill still open",
  not_on_bill: "Charged, not on any bill",
  bill_line: "Bill line differs from the card charge",
  orphaned: "Paid online, could not be booked",
  bill_refunded_card_not: "Bill refunded, card not refunded",
  card_refunded_bill_paid: "Card refunded, bill still paid",
};

type StatDrill = "stripe" | "ours" | "difference" | "errors" | "warnings" | "matched";

const STAT_TITLES: Record<StatDrill, string> = {
  stripe: "Stripe net",
  ours: "Our records net",
  difference: "Difference — Stripe − our records",
  errors: "Problems — money does not match",
  warnings: "To check — records unfinished",
  matched: "Matched",
};

const bySource = (row: ReconcileRow): DrillGroup => ({ key: row.source, label: SOURCE_LABEL[row.source] });

function byIssue(level: "error" | "warn") {
  return (row: ReconcileRow): DrillGroup => {
    const issue = row.issues.find((item) => item.level === level) ?? row.issues[0];
    return issue ? { key: issue.code, label: ISSUE_LABEL[issue.code] ?? issue.message } : { key: "", label: "Other" };
  };
}

const stripeNet = (row: ReconcileRow) => (row.stripe ? row.stripe.amount - row.stripe.refunded : 0);
const oursNet = (row: ReconcileRow) => (row.ours ? row.ours.amount - row.ours.refunded : 0);

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

function linkedParam(name: string): string {
  return typeof window === "undefined" ? "" : (new URLSearchParams(window.location.search).get(name) ?? "");
}

/** 열린 상세 창의 PaymentIntent 를 주소에 남긴다(새로고침·공유해도 같은 줄이 열린다). */
function writePiParam(key: string | null) {
  const params = new URLSearchParams(window.location.search);
  if (key) params.set("pi", key);
  else params.delete("pi");
  const rest = params.toString();
  window.history.replaceState(null, "", `${window.location.pathname}${rest ? `?${rest}` : ""}`);
}

function linkedDate(): string {
  const wanted = typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("date");
  return wanted && /^\d{4}-\d{2}-\d{2}$/.test(wanted) ? wanted : localBusinessDate();
}

export default function StripeReconcile() {
  // Daily close 의 카드 매출 칸에서 `?view=stripe&date=YYYY-MM-DD` 로 오면 그 날을 연다.
  const [from, setFrom] = useState(linkedDate);
  const [to, setTo] = useState(linkedDate);
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
  // 상세 창. 다시 읽는 동안(report 가 비는 동안)은 연 때의 줄을 그대로 보여 준다.
  const [opened, setOpened] = useState<ReconcileRow | null>(null);
  // 숫자 칸을 눌러 연 요약.
  const [drill, setDrill] = useState<StatDrill | null>(null);
  const wantedPi = useRef(linkedParam("pi"));

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
        if (wantedPi.current) {
          const found = result.rows.find((row) => row.key === wantedPi.current);
          wantedPi.current = "";
          if (found) setOpened(found);
        }
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
  const openRow = (opened && report?.rows.find((row) => row.key === opened.key)) || opened;

  function openDetail(row: ReconcileRow | null) {
    setOpened(row);
    writePiParam(row?.key ?? null);
  }

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
              onClick={() => setDrill("stripe")}
              value={formatMoney(s.stripe_net)}
            />
            <StatCard
              hint={`${formatMoney(s.ours_charged)} in − ${formatMoney(s.ours_refunded)} refunded`}
              label="Our records net"
              onClick={() => setDrill("ours")}
              value={formatMoney(s.ours_net)}
            />
            <StatCard
              hint={s.difference === 0 ? "Stripe and our records agree" : "Stripe − our records"}
              label="Difference"
              onClick={() => setDrill("difference")}
              value={formatMoney(s.difference)}
            />
            <StatCard
              hint="money does not match"
              label="Problems"
              onClick={() => setDrill("errors")}
              value={String(s.errors)}
            />
            <StatCard
              hint="money matches, records unfinished"
              label="To check"
              onClick={() => setDrill("warnings")}
              value={String(s.warnings)}
            />
            <StatCard
              hint={s.reviewed ? `Stripe = our records · ${s.reviewed} reviewed` : "Stripe = our records"}
              label="Matched"
              onClick={() => setDrill("matched")}
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
              <ReconcileTable environment={report.environment} onOpen={openDetail} rows={rows} />
            )}
          </Panel>

          {report.attempts && report.attempts.length > 0 ? (
            <Attempts attempts={report.attempts} environment={report.environment} />
          ) : null}

          <p className="text-xs text-[#6b7280]">
            {s.outside_window > 0
              ? `${s.outside_window} payment(s) were made before this range but refunded or changed in it, so they are included. `
              : ""}
            {report.keyed.count > 0
              ? `${report.keyed.count} card payment(s) totalling ${formatMoney(report.keyed.amount)} were keyed in by hand ` +
                "(not through Stripe), so they cannot be checked here. "
              : ""}
            Checked {clubTime(report.generated_at)}. Amounts include tips. Click a row to see it in full and decide
            whether it counts as a sale.
          </p>
        </>
      ) : null}

      {drill && report ? (
        <StatDrillModal
          drill={drill}
          onClose={() => setDrill(null)}
          onOpen={(row) => {
            setDrill(null);
            openDetail(row);
          }}
          rows={report.rows}
        />
      ) : null}

      {openRow && report ? (
        <ReconcileDetail
          environment={report.environment}
          onChanged={() => setReloadKey((key) => key + 1)}
          onClose={() => openDetail(null)}
          row={openRow}
        />
      ) : null}
    </div>
  );
}

function StatDrillModal({
  drill,
  rows,
  onOpen,
  onClose,
}: {
  drill: StatDrill;
  rows: ReconcileRow[];
  onOpen: (row: ReconcileRow) => void;
  onClose: () => void;
}) {
  const amountOf =
    drill === "stripe" ? stripeNet : drill === "ours" ? oursNet : drill === "difference" ? rowDifference : undefined;
  const picked = rows.filter((row) =>
    drill === "stripe"
      ? row.stripe
      : drill === "ours"
        ? row.ours
        : drill === "difference"
          ? rowDifference(row) !== 0
          : drill === "errors"
            ? row.level === "error"
            : drill === "warnings"
              ? row.level === "warn"
              : row.level === "ok",
  );
  const groupOf =
    drill === "errors"
      ? byIssue("error")
      : drill === "warnings"
        ? byIssue("warn")
        : drill === "matched"
          ? (row: ReconcileRow): DrillGroup =>
              row.reviewed ? { key: "reviewed", label: "Reviewed — left as is" } : bySource(row)
          : bySource;
  return (
    <ReportDrill
      amountOf={amountOf}
      groupName={drill === "errors" || drill === "warnings" ? "problems" : "sources"}
      groupOf={groupOf}
      itemOf={(row) => ({
        key: row.key,
        primary: row.ours?.label || cardText(row) || row.key,
        secondary: [
          clubTime(row.at),
          SOURCE_LABEL[row.source],
          cardText(row),
          row.ours?.receipt_no ?? "",
          ...row.issues.map((issue) => issue.message),
        ]
          .filter(Boolean)
          .join(" · "),
        amount: amountOf ? amountOf(row) : (row.stripe?.amount ?? row.ours?.amount ?? 0),
        onOpen: () => onOpen(row),
      })}
      lastGroup="reviewed"
      note={drill === "matched" ? "Reviewed payments do not match but were left as is, so they are not counted as Matched." : null}
      onClose={onClose}
      rows={picked}
      title={STAT_TITLES[drill]}
      unit="payment"
      wide
    />
  );
}

/**
 * Stripe 대시보드에 Canceled·Incomplete 로 보이는 시도 — 단말기에서 취소, 카드 거절, 끝내지 않은 온라인 결제.
 * 카드에서 돈이 빠지지 않았으므로 위 대조와 합계에는 넣지 않는다. 대시보드 목록과 맞춰 볼 수 있게만 보인다.
 */
function Attempts({ attempts, environment }: { attempts: StripeAttempt[]; environment: "test" | "live" }) {
  const total = attempts.reduce((sum, attempt) => sum + attempt.amount, 0);
  return (
    <Panel title={`Canceled & declined in Stripe ×${attempts.length} · ${formatMoney(total)} · no money moved`}>
      <ul className="grid gap-1 text-sm">
        {attempts.map((attempt) => (
          <li className="flex items-baseline justify-between gap-2 py-0.5" key={attempt.payment_intent}>
            <span className="min-w-0">
              <span className="block">
                <span className="font-semibold">{attempt.status_label}</span>{" "}
                <span className="text-xs text-[#6b7280]">
                  {[clubTime(attempt.at), SOURCE_LABEL[attempt.source], attempt.label].filter(Boolean).join(" · ")}
                </span>
              </span>
              <span className="block text-xs text-[#6b7280]">
                {[attempt.reason.replace(/_/g, " "), attempt.message].filter(Boolean).join(" — ")}{" "}
                <a
                  className="text-[#4533ff] underline"
                  href={stripeUrl(environment, attempt.payment_intent)}
                  rel="noreferrer"
                  target="_blank"
                >
                  {attempt.payment_intent}
                </a>
              </span>
            </span>
            <span className="shrink-0 tabular-nums text-[#6b7280]">{formatMoney(attempt.amount)}</span>
          </li>
        ))}
      </ul>
    </Panel>
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
          : `All ${s.matched} card payment(s) match Stripe.` + (s.reviewed ? ` ${s.reviewed} left as is on purpose.` : "")
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

function ReconcileTable({
  rows,
  environment,
  onOpen,
}: {
  rows: ReconcileRow[];
  environment: "test" | "live";
  onOpen: (row: ReconcileRow) => void;
}) {
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
            <ReconcileLine environment={environment} key={row.key} onOpen={onOpen} row={row} />
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

// 줄 안의 링크(Stripe·영수증)는 그 링크로 가고, 나머지를 누르면 상세 창이 열린다.
const stop = (event: React.MouseEvent) => event.stopPropagation();

function ReconcileLine({
  row,
  environment,
  onOpen,
}: {
  row: ReconcileRow;
  environment: "test" | "live";
  onOpen: (row: ReconcileRow) => void;
}) {
  const diff = rowDifference(row);
  const ours = row.ours;
  return (
    <tr className="cursor-pointer border-b border-[#ececef] align-top hover:bg-[#f9fafb]" onClick={() => onOpen(row)}>
      <td className="px-3 py-2">
        {/* 키보드로도 열 수 있게 상태 표시가 버튼이다. */}
        <button
          className={`inline-block border px-1.5 py-0.5 text-xs font-bold ${row.reviewed ? REVIEWED_BADGE : BADGE[row.level]}`}
          onClick={(event) => {
            event.stopPropagation();
            onOpen(row);
          }}
          title="Open this payment"
          type="button"
        >
          {row.reviewed ? "Reviewed" : LEVEL_LABEL[row.level]}
        </button>
      </td>
      <td className="px-3 py-2 whitespace-nowrap tabular-nums">{clubTime(row.at)}</td>
      <td className="px-3 py-2">
        <span className="block">{SOURCE_LABEL[row.source]}</span>
        <span className="block text-xs text-[#6b7280]">{cardText(row)}</span>
        {row.stripe ? (
          <a
            className="block text-xs break-all text-[#4533ff] underline"
            href={stripeUrl(environment, row.stripe.payment_intent)}
            onClick={stop}
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
                onClick={stop}
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
        {row.decision ? (
          <span className="mt-1 block text-xs text-[#2e2499]">
            {DECISION_LABEL[row.decision.decision]}
            {row.decision.staff_name ? ` by ${row.decision.staff_name}` : ""}
            {row.decision.note ? ` — ${row.decision.note}` : ""}
          </span>
        ) : null}
      </td>
    </tr>
  );
}
