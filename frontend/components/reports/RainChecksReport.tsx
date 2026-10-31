"use client";

/**
 * 레인체크 — Reports(`/admin/reports?view=rainchecks`)의 한 탭. 발행일이 기간 안인 전표 전부(무효 포함).
 *
 * 각 줄: 누구에게(예약 날짜·시간), 얼마를, 언제까지, 지금 상태(발행됨·사용됨·무효·만료), 바코드 문자가
 * 나갔는지(0058 문자 기록). 위의 "Outstanding" 은 기간과 상관없이 지금 쓸 수 있는 크레딧 전체다.
 * 서버 함수는 0062 `pelham_staff_rain_check_report`.
 *
 * Issued·Used·Expired·Void 칸은 먼저 요약(Issued 는 상태별, Void 는 사유별, 나머지는 발행한 담당자별), 줄을 누르면
 * 그 전표들(2026-10-24, `ReportDrill`). Outstanding 은 기간 밖 전표까지라 이 화면의 목록으로는 펼칠 수 없다.
 *
 * Sample(2026-10-31): 손님이 받는 전표가 어떻게 생겼는지 보고 찍어 본다. 서버 기록은 없다.
 */

import { useEffect, useMemo, useState } from "react";

import {
  describeRainCheckError,
  onRainChecksChanged,
  rainCheckApi,
  sampleRainCheck,
  type RainCheckReport,
  type RainCheckReportRow,
} from "@/lib/pos/rainCheck";
import { printRainChecks, rainCheckSheetHtml } from "@/lib/retail/printReceipt";
import { usDate } from "@/lib/retail/receipt";
import { localBusinessDate } from "@/lib/retail/api";
import { formatMoney } from "@/lib/retail/types";
import { ApiError } from "@/lib/teeSheet/api";
import { addDays } from "@/lib/teeSheet/dates";

import StaffName from "@/components/reports/StaffName";
import ReportDrill, { type DrillGroup } from "@/components/reports/ReportDrill";
import { Button, Chip, EmptyNote, ErrorNote, Field, Modal, SkeletonRows, StatCard, TextInput } from "@/components/retail/ui";

type State = "live" | "redeemed" | "expired" | "void";

const FILTERS = [
  { key: "all", label: "All" },
  { key: "live", label: "Unused" },
  { key: "redeemed", label: "Used" },
  { key: "expired", label: "Expired" },
  { key: "void", label: "Void" },
] as const;

const BADGE: Record<State, { label: string; className: string }> = {
  live: { label: "Unused", className: "bg-[#e0e7ff] text-[#3730a3]" },
  redeemed: { label: "Used", className: "bg-[#dcfce7] text-[#166534]" },
  expired: { label: "Expired", className: "bg-[#fff1cc] text-[#8a5a00]" },
  void: { label: "Void", className: "bg-[#f3f4f6] text-[#6b7280]" },
};

function stateOf(row: RainCheckReportRow): State {
  if (row.status === "void") return "void";
  if (row.status === "redeemed") return "redeemed";
  return row.expired ? "expired" : "live";
}

function describe(cause: unknown): string {
  if (cause instanceof ApiError && cause.status === 404 && /could not find the function|PGRST202|schema cache/i.test(cause.message))
    return "The rain check report isn't set up yet — run 0062_rain_check_report.sql in the Supabase SQL editor.";
  return describeRainCheckError(cause);
}

function when(iso: string | null): string {
  if (!iso) return "";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  return at.toLocaleString("en-CA", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

type DrillBy = "status" | "cashier" | "reason";

function groupOf(by: DrillBy) {
  return (row: RainCheckReportRow): DrillGroup => {
    if (by === "status") return { key: stateOf(row), label: BADGE[stateOf(row)].label };
    const text = ((by === "reason" ? row.void_reason : row.cashier) ?? "").trim();
    return { key: text.toLowerCase(), label: text || (by === "reason" ? "No reason given" : "No cashier name") };
  };
}

function sum(rows: RainCheckReportRow[]): { count: number; amount: number } {
  return { count: rows.length, amount: rows.reduce((total, row) => total + row.amount, 0) };
}

/** 전표 견본. 미리보기와 종이가 같은 HTML 이다. */
function SampleSlip({ today, onClose }: { today: string; onClose: () => void }) {
  const sample = useMemo(() => sampleRainCheck(today), [today]);
  return (
    <Modal onClose={onClose} title="Rain check slip — sample">
      <div className="grid gap-3">
        <p className="text-xs text-[#6b7280]">
          What a guest receives, with made-up details. Its barcode can&apos;t be redeemed and nothing is recorded.
        </p>
        <div
          className="rc-sheet mx-auto bg-white p-3 shadow"
          // 우리 포맷터가 만든 HTML 이다 — 견본 글자도 전부 이스케이프돼 있다.
          dangerouslySetInnerHTML={{ __html: rainCheckSheetHtml(sample, { sample: true }) }}
          style={{ width: "72mm" }}
        />
        <Button full onClick={() => printRainChecks([sample], { sample: true })} tone="primary">
          Print sample
        </Button>
      </div>
    </Modal>
  );
}

export default function RainChecksReport() {
  const today = localBusinessDate();
  const [from, setFrom] = useState(() => addDays(today, -29));
  const [to, setTo] = useState(today);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["key"]>("all");
  const [drill, setDrill] = useState<{ title: string; rows: RainCheckReportRow[]; by: DrillBy } | null>(null);
  const [showSample, setShowSample] = useState(false);
  const [loaded, setLoaded] = useState<{ range: string; report: RainCheckReport | null; error: string } | null>(null);

  const range = `${from}..${to}`;
  const rangeError = from && to && from > to ? "From must be on or before To." : "";
  const loading = loaded?.range !== range;
  // 티 시트에서 발행·무효하면(같은 브라우저의 다른 탭 포함) 또는 이 탭으로 돌아오면 다시 읽는다.
  // 범위가 같으니 "불러오는 중"으로 비우지 않고 숫자만 바꾼다.
  const [nonce, setNonce] = useState(0);
  useEffect(() => onRainChecksChanged(() => setNonce((n) => n + 1)), []);

  useEffect(() => {
    if (rangeError || !from || !to) return;
    let cancelled = false;
    rainCheckApi
      .report(from, to)
      .then((report) => {
        if (!cancelled) setLoaded({ range, report, error: "" });
      })
      .catch((cause) => {
        if (!cancelled) setLoaded({ range, report: null, error: describe(cause) });
      });
    return () => {
      cancelled = true;
    };
  }, [from, to, range, rangeError, nonce]);

  const report = loaded && !loading ? loaded.report : null;
  const rows = useMemo(() => report?.rows ?? [], [report]);
  const issued = sum(rows.filter((row) => row.status !== "void"));
  const used = sum(rows.filter((row) => stateOf(row) === "redeemed"));
  const expired = sum(rows.filter((row) => stateOf(row) === "expired"));
  const voided = sum(rows.filter((row) => stateOf(row) === "void"));
  const live = rows.filter((row) => stateOf(row) === "live");
  const notTexted = live.filter((row) => !row.texted_at).length;
  const visible = filter === "all" ? rows : rows.filter((row) => stateOf(row) === filter);

  return (
    <div className="grid min-w-0 gap-3">
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Issued from">
          <TextInput max={to} onChange={(event) => setFrom(event.target.value)} type="date" value={from} />
        </Field>
        <Field label="To">
          <TextInput min={from} onChange={(event) => setTo(event.target.value)} type="date" value={to} />
        </Field>
        <Button className="ml-auto" onClick={() => setShowSample(true)} title="See and print a sample rain check slip">
          <span aria-hidden>☂</span>
          Sample
        </Button>
      </div>

      {rangeError ? <ErrorNote>{rangeError}</ErrorNote> : null}
      {loaded && !loading && loaded.error ? <ErrorNote>{loaded.error}</ErrorNote> : null}

      {loading && !rangeError ? (
        <SkeletonRows count={6} />
      ) : !report ? null : (
        <>
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-5">
            <StatCard
              hint={`${issued.count} slip(s) issued in these dates`}
              label="Issued"
              onClick={() => setDrill({ title: "Issued", rows: rows.filter((row) => row.status !== "void"), by: "status" })}
              strong
              value={formatMoney(issued.amount)}
            />
            <StatCard
              hint={`${used.count} slip(s)`}
              label="Used"
              onClick={() => setDrill({ title: "Used", rows: rows.filter((row) => stateOf(row) === "redeemed"), by: "cashier" })}
              value={formatMoney(used.amount)}
            />
            <StatCard
              hint={`${expired.count} slip(s) never used`}
              label="Expired"
              onClick={() => setDrill({ title: "Expired", rows: rows.filter((row) => stateOf(row) === "expired"), by: "cashier" })}
              value={formatMoney(expired.amount)}
            />
            <StatCard
              hint={`${voided.count} slip(s)`}
              label="Void"
              onClick={() => setDrill({ title: "Void", rows: rows.filter((row) => stateOf(row) === "void"), by: "reason" })}
              value={formatMoney(voided.amount)}
            />
            <StatCard
              hint={`${report.outstanding.count} slip(s) still usable · all dates`}
              label="Outstanding"
              strong
              value={formatMoney(report.outstanding.amount)}
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {FILTERS.map((item) => (
              <Chip active={filter === item.key} key={item.key} onClick={() => setFilter(item.key)}>
                {item.label}
              </Chip>
            ))}
            {notTexted > 0 ? (
              <span className="ml-auto text-xs text-[#8a5a00]">{notTexted} unused slip(s) never texted to the guest</span>
            ) : null}
          </div>

          {visible.length === 0 ? (
            <EmptyNote>No rain checks for these dates.</EmptyNote>
          ) : (
            <div className="min-w-0 overflow-x-auto border border-[#d4d4d8] bg-white">
              <table className="w-full min-w-[980px] text-left text-sm">
                <thead className="bg-[#f3f4f6] text-xs text-[#3f434a] uppercase">
                  <tr>
                    <th className="px-3 py-2">Issued</th>
                    <th className="px-3 py-2">Code</th>
                    <th className="px-3 py-2">Player · round</th>
                    <th className="px-3 py-2 text-right">Credit</th>
                    <th className="px-3 py-2">Valid through</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2">Text</th>
                    <th className="px-3 py-2">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((row) => {
                    const state = stateOf(row);
                    return (
                      <tr className="border-t border-[#ececf0] align-top" key={row.id}>
                        <td className="px-3 py-2 whitespace-nowrap">
                          <span className="block tabular-nums">{usDate(row.issued_on)}</span>
                          <span className="block text-xs text-[#6b7280]">
                            <StaffName date={row.issued_on} name={row.cashier} />
                          </span>
                        </td>
                        <td className="px-3 py-2 font-mono text-xs whitespace-nowrap">{row.code}</td>
                        <td className="px-3 py-2">
                          <span className="block font-bold">{row.player_name}</span>
                          <span className="block text-xs text-[#6b7280]">
                            {[
                              row.tee_date ? usDate(row.tee_date) : null,
                              row.tee_time,
                              row.holes_played != null
                                ? `${row.holes_played} of ${row.holes ?? "?"} holes`
                                : row.holes
                                  ? `${row.holes} holes`
                                  : null,
                              row.source_receipt ? `paid on ${row.source_receipt}` : null,
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          <span className="block font-bold">{formatMoney(row.amount)}</span>
                          {row.amount !== row.paid_value ? (
                            <span className="block text-xs text-[#6b7280]">paid {formatMoney(row.paid_value)}</span>
                          ) : null}
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap tabular-nums">{usDate(row.expires_on)}</td>
                        <td className="px-3 py-2 whitespace-nowrap">
                          <span className={`inline-block px-1.5 py-0.5 text-xs font-bold ${BADGE[state].className}`}>
                            {BADGE[state].label}
                          </span>
                          {state === "redeemed" ? (
                            <span className="block text-xs text-[#6b7280]">
                              {[row.redeemed_receipt, when(row.redeemed_at)].filter(Boolean).join(" · ")}
                            </span>
                          ) : state === "void" ? (
                            <span className="block text-xs text-[#6b7280]">{row.void_reason}</span>
                          ) : null}
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap">
                          {row.texted_at ? (
                            <>
                              <span className="block tabular-nums">{row.texted_to}</span>
                              <span className="block text-xs text-[#6b7280]">
                                {when(row.texted_at)}
                                {row.text_status ? ` · ${row.text_status}` : ""}
                                {row.text_count > 1 ? ` · ${row.text_count}×` : ""}
                              </span>
                            </>
                          ) : (
                            <span className="text-xs text-[#9ca3af]">Not texted</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-xs">{row.note}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="text-xs text-[#6b7280]">
            Dates are issue dates. Rain checks are good for 180 days. Outstanding counts every unused, unexpired slip
            no matter when it was issued — credit the club still owes. Tap Issued, Used, Expired or Void for a summary,
            then the slips (Used and Expired are grouped by the cashier who issued them).
          </p>
          {drill ? (
            <ReportDrill
              amountOf={(row) => row.amount}
              groupName={drill.by === "status" ? "statuses" : drill.by === "reason" ? "reasons" : "cashiers"}
              groupOf={groupOf(drill.by)}
              itemOf={(row) => ({
                key: String(row.id),
                primary: `${row.code} · ${row.player_name}`,
                secondary: [
                  `issued ${usDate(row.issued_on)}`,
                  row.tee_date ? `round ${usDate(row.tee_date)}${row.tee_time ? ` ${row.tee_time}` : ""}` : "",
                  BADGE[stateOf(row)].label,
                  stateOf(row) === "redeemed" ? [row.redeemed_receipt, when(row.redeemed_at)].filter(Boolean).join(" ") : "",
                  stateOf(row) === "void" ? row.void_reason : `valid through ${usDate(row.expires_on)}`,
                  row.cashier,
                ]
                  .filter(Boolean)
                  .join(" · "),
                amount: row.amount,
              })}
              key={drill.title}
              onClose={() => setDrill(null)}
              rows={drill.rows}
              title={`Rain checks — ${drill.title}`}
              unit="slip"
            />
          ) : null}
        </>
      )}
      {showSample ? <SampleSlip onClose={() => setShowSample(false)} today={today} /> : null}
    </div>
  );
}
