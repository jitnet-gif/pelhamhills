"use client";

/**
 * 대사표(0061) — 매출 리포트 · 계산대 마감을 같은 영업일로 나란히 놓고 차이를 보여 준다.
 * `/cash` 의 매출 리포트 아래에 붙는다(현금 리포트 계정만).
 *
 * 세 장표는 같은 계산서 장부를 읽지만 숫자가 그대로 같지 않다 — 매출 리포트는 팁을 따로 두고, 계산대 마감
 * 현금에는 시작 잔돈이 있고, 온라인 결제는 마감할 계산대가 없다. 그 식(리포트 + 팁 = 센 돈 − 잔돈 + 온라인)
 * 과 차이는 **서버가** 계산한다. 여기서는 그리기만 한다.
 *
 * 아직 닫지 않은 계산대·사람이 있거나 닫은 뒤 숫자가 바뀌었으면 차이를 확정하지 않고 "Not final" 로 둔다.
 * 계산대 마감은 다른 화면(계산대 홈)에서 하므로 Refresh 로 다시 읽는다.
 *
 * 수단마다 Sales report 줄을 누르면 그날 그 수단의 결제를 담당자별 요약 → 거래로 본다(2026-10-24, `CashShiftModal`).
 */

import { useEffect, useState } from "react";

import retailApi, { toRetailError } from "@/lib/retail/api";
import { stationLabel } from "@/lib/retail/receipt";
import { formatMoney, type CashReconcile as Report, type CashReconcileLine, type Cents } from "@/lib/retail/types";

import { CashShiftModal, SHIFT_LABELS } from "@/components/reports/CashTransactions";
import { Button, ErrorNote, Panel, SkeletonRows } from "@/components/retail/ui";

const METHOD_LABELS: Record<CashReconcileLine["method"], string> = { cash: "Cash", card: "Card", debit: "Debit" };

/** 서랍 이름 + 근무(0092, 하루 두 번 마감). */
function registerName(row: Report["registers"][number]): string {
  return row.shift ? `${stationLabel(row.station)} · ${SHIFT_LABELS[row.shift]}` : stationLabel(row.station);
}

export default function CashReconcile({ date, refreshKey = 0 }: { date: string; refreshKey?: number }) {
  const [nonce, setNonce] = useState(0);
  const [opened, setOpened] = useState<CashReconcileLine["method"] | null>(null);
  const requestKey = `${date}#${refreshKey}#${nonce}`;
  const [loaded, setLoaded] = useState<{ key: string; report: Report | null; error: string } | null>(null);
  const loading = loaded?.key !== requestKey;
  const report = loading ? null : loaded.report;
  const error = loading ? "" : loaded.error;

  useEffect(() => {
    let cancelled = false;
    retailApi
      .getCashReconcile(date)
      .then((value) => {
        if (!cancelled) setLoaded({ key: requestKey, report: value, error: "" });
      })
      .catch((cause) => {
        if (!cancelled) setLoaded({ key: requestKey, report: null, error: toRetailError(cause).message });
      });
    return () => {
      cancelled = true;
    };
  }, [date, requestKey]);

  const refresh = (
    <Button disabled={loading} onClick={() => setNonce((value) => value + 1)}>
      Refresh
    </Button>
  );

  if (loading) {
    return (
      <Panel title="Reconcile — sales vs. close-outs">
        <SkeletonRows count={3} />
      </Panel>
    );
  }
  if (!report) {
    return (
      <Panel actions={refresh} title="Reconcile — sales vs. close-outs">
        <ErrorNote>{error || "Could not load the reconciliation."}</ErrorNote>
      </Panel>
    );
  }

  const lines = report.lines.filter(
    (line) => line.method !== "debit" || line.report.total !== 0 || line.registers.counted !== 0,
  );
  const todo = openItems(report);

  return (
    <Panel actions={refresh} title={`Reconcile — ${report.business_date}`}>
      <div className="grid gap-3">
        <p className="text-xs text-[#6b7280]">
          The sales report keeps tips on their own line; close-outs count them in the drawer. Register cash is counted
          without the $200 float, and online payments have no register, so they are added to the register side.
        </p>

        {todo.length > 0 ? (
          <ul className="grid gap-1 bg-[#fff8e1] px-3 py-2 text-xs text-[#5b4708]">
            {todo.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        ) : null}

        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {lines.map((line) => (
            <LineCard
              key={line.method}
              line={line}
              onOpen={() => setOpened(line.method)}
              uncounted={uncountedSlips(report, line.method).length > 0}
            />
          ))}
        </div>
        {opened ? (
          <CashShiftModal
            date={date}
            method={opened}
            note={`${METHOD_LABELS[opened]} payments on paid bills this day, tips and online payments included — the same total as the Sales report line.`}
            onClose={() => setOpened(null)}
            title={`${METHOD_LABELS[opened]} payments — ${report.business_date}`}
            window={null}
          />
        ) : null}

        <RegisterTable report={report} />
      </div>
    </Panel>
  );
}

function LineCard({ line, uncounted, onOpen }: { line: CashReconcileLine; uncounted: boolean; onOpen: () => void }) {
  const cash = line.method === "cash";
  return (
    <section className="min-w-0 border border-[#e4e4e8]">
      <h3 className="border-b border-[#e4e4e8] bg-[#f7f7f9] px-3 py-1.5 text-sm font-bold">{METHOD_LABELS[line.method]}</h3>
      <dl className="grid gap-2 p-3 text-sm">
        <Row
          detail={`${formatMoney(line.report.amount)} + ${formatMoney(line.report.tip)} tips`}
          label="Sales report"
          onOpen={onOpen}
          value={line.report.total}
        />
        <Row
          detail={
            line.online
              ? `${formatMoney(line.registers.counted)} counted + ${formatMoney(line.online)} online`
              : cash
                ? "counted, without the float"
                : "counted at the registers"
          }
          label="Registers"
          // 서버는 안 센 전표를 0 으로 더한다 — 그대로 두면 카드 매출 전액이 short 로 보인다.
          status={<Diff complete={line.registers.complete && !uncounted} diff={line.registers.diff} />}
          value={line.registers.counted + line.online}
        />
        {/* 담당자별 마감(0010) 줄은 뺐다(2026-10-24) — 현금은 Shift 1·2 서랍 마감으로만 맞춘다. */}
      </dl>
    </section>
  );
}

function Row({
  label,
  detail,
  value,
  status,
  onOpen,
}: {
  label: string;
  detail: string;
  value: Cents;
  status?: React.ReactNode;
  /** 줄 이름을 눌러 그 숫자의 결제를 연다. */
  onOpen?: () => void;
}) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-[#f2f2f4] pb-2 last:border-b-0 last:pb-0">
      <div className="min-w-0">
        <dt className="font-semibold">
          {onOpen ? (
            <button className="text-left text-[#4533ff] hover:underline" onClick={onOpen} type="button">
              {label} ›
            </button>
          ) : (
            label
          )}
        </dt>
        <dd className="text-xs text-[#6b7280]">{detail}</dd>
      </div>
      <div className="grid shrink-0 justify-items-end gap-1">
        <span className="font-bold tabular-nums">{formatMoney(value)}</span>
        {status}
      </div>
    </div>
  );
}

function Diff({ diff, complete }: { diff: Cents; complete: boolean }) {
  if (!complete) {
    return <span className="bg-[#fff1cc] px-1.5 py-0.5 text-[11px] font-bold text-[#8a5a00]">Not final</span>;
  }
  if (diff === 0) {
    return <span className="bg-[#e3f4e8] px-1.5 py-0.5 text-[11px] font-bold text-[#1f6b3a]">Matches</span>;
  }
  return (
    <span className="bg-[#fde2e2] px-1.5 py-0.5 text-[11px] font-bold text-[#8a1f1f] tabular-nums">
      {diff > 0 ? `Over ${formatMoney(diff)}` : `Short ${formatMoney(-diff)}`}
    </span>
  );
}

function RegisterTable({ report }: { report: Report }) {
  const rows = report.registers.filter((row) => row.has_sales || row.closed);
  if (rows.length === 0) return null;
  const cell = (part: { expected: Cents; counted: Cents | null }) =>
    part.counted === null ? `${formatMoney(part.expected)} / —` : `${formatMoney(part.expected)} / ${formatMoney(part.counted)}`;
  return (
    <div className="min-w-0 overflow-x-auto">
      <table className="w-full min-w-[480px] text-left text-xs">
        <thead className="text-[11px] text-[#6b7280] uppercase">
          <tr>
            <th className="py-1 pr-2">Register</th>
            <th className="py-1 pr-2">Cash expected / counted</th>
            <th className="py-1 pr-2">Card</th>
            <th className="py-1 pr-2">Debit</th>
            <th className="py-1">Status</th>
          </tr>
        </thead>
        <tbody className="tabular-nums">
          {rows.map((row) => (
            <tr className="border-t border-[#f2f2f4]" key={`${row.station}-${row.shift ?? "day"}`}>
              <td className="py-1.5 pr-2 font-semibold">{registerName(row)}</td>
              <td className="py-1.5 pr-2">{cell(row.cash)}</td>
              <td className="py-1.5 pr-2">{cell(row.card)}</td>
              <td className="py-1.5 pr-2">{cell(row.debit)}</td>
              <td className="py-1.5">{!row.closed ? "Not closed" : row.stale ? "Close again" : "Closed"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-1 text-[11px] text-[#6b7280]">
        Cash is shown without the $200 float each shift keeps. Morning (Shift 1) and Evening (Shift 2) are counted separately.
      </p>
    </div>
  );
}

/**
 * 마감은 됐는데 카드·체크카드 전표를 아무도 안 센 서랍. 캐셔는 현금만 센다(0090) — 전표는 현금 리포트 계정이
 * Close Register 에서 센다. 그 수단에 결제가 없으면 셀 것도 없다.
 */
function uncountedSlips(report: Report, method: CashReconcileLine["method"]): string[] {
  if (method === "cash") return [];
  return report.registers
    .filter((row) => row.closed && row[method].counted === null && row[method].expected !== 0)
    .map(registerName);
}

/** 차이를 확정하지 못하게 하는 것들. 서버의 `complete` 와 같은 조건을 사람이 읽는 문장으로. */
function openItems(report: Report): string[] {
  const items: string[] = [];
  for (const row of report.registers) {
    if (row.has_sales && !row.closed) items.push(`${registerName(row)} register is not closed yet.`);
    else if (row.stale) items.push(`${registerName(row)} changed after it was closed — close it again.`);
  }
  for (const method of ["card", "debit"] as const) {
    for (const name of uncountedSlips(report, method)) {
      items.push(
        `${name}: the ${METHOD_LABELS[method].toLowerCase()} slip is not counted yet — enter it on Close Register.`,
      );
    }
  }
  return items;
}
