"use client";

/**
 * 담당자별 마감 + 팁 나누기(0010). Reports 의 매출 아래에 같은 영업일로 붙는다.
 *
 * - 담당자는 계산서의 Cashier 칸이다(공용 로그인이라 로그인으로는 사람을 가를 수 없다).
 * - 마감은 **본인의 Pelham Shift ID(4자리)** 로 한다(2026-10-22). 이름을 누르기만 해서는 남의 마감을 닫을 수 있었다.
 *   번호를 이름으로 바꿔(`cashierCode.ts`) 그 카드의 이름과 같아야 닫힌다. 번호는 로그인 비밀번호이기도 해서 저장하지 않는다.
 * - 각자 근무시간과 센 현금을 적고 닫는다. 기대 현금·매출은 **서버가** 계산서에서 센다 —
 *   화면에서 더하지 않는다(`SalesReport` 와 같은 이유).
 * - 팁은 그날 팁 전부를 한 통에 모아 근무시간 비율로 나눈다. 몫과 반올림도 서버가 정한다
 *   (몫의 합 = 통, 센트까지). 매출이 있는데 아직 안 닫은 사람이 있으면 "임시" 로 보인다.
 *
 * 이 패널만 따로 읽는다. 0010 이 아직 안 돌았어도 위의 매출 리포트는 그대로 보여야 한다.
 */

import { useEffect, useState } from "react";

import { cashierForCode, isShiftCode } from "@/lib/pos/cashierCode";
import retailApi, { toRetailError } from "@/lib/retail/api";
import { ApiError } from "@/lib/teeSheet/api";
import { PAYMENT_LABELS } from "@/lib/retail/receipt";
import {
  formatMinutes,
  formatMoney,
  parseHours,
  parseMoney,
  type CloseoutReport,
  type StaffCloseout as StaffRow,
} from "@/lib/retail/types";

import { Button, EmptyNote, ErrorNote, Field, Panel, SkeletonRows, TextInput } from "@/components/retail/ui";

export default function StaffCloseout({
  date,
  refreshKey = 0,
  onSaved,
}: {
  date: string;
  refreshKey?: number;
  /** 마감·다시 열기 뒤에 부른다 — 대사표(`CashReconcile`)가 다시 읽는다. */
  onSaved?: () => void;
}) {
  const requestKey = `${date}#${refreshKey}`;
  const [loaded, setLoaded] = useState<{ key: string; report: CloseoutReport | null; error: string } | null>(null);
  // 날짜가 바뀌었거나 다시 읽으라는 신호가 오면, 응답이 올 때까지 이전 값은 보여 주지 않는다.
  const loading = loaded?.key !== requestKey;
  const report = loading ? null : loaded.report;
  const error = loading ? "" : loaded.error;
  const setReport = (value: CloseoutReport) => {
    setLoaded({ key: requestKey, report: value, error: "" });
    onSaved?.();
  };

  useEffect(() => {
    let cancelled = false;
    retailApi
      .getCloseouts(date)
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

  if (loading) {
    return (
      <Panel title="Close out by staff">
        <SkeletonRows count={3} />
      </Panel>
    );
  }
  if (!report) {
    return (
      <Panel title="Close out by staff">
        <ErrorNote>{error || "Could not load close-outs."}</ErrorNote>
      </Panel>
    );
  }

  const shared = report.staff.filter((row) => row.tip_share !== null);

  return (
    <div className="grid min-w-0 gap-3">
      <Panel title={`Close out by staff — ${report.business_date}`}>
        <div className="grid gap-3 p-3">
          <p className="text-xs text-[#6b7280]">
            Each person counts their own cash and enters the hours they worked. Sales are grouped by the Cashier name
            on the bill.
          </p>

          {report.unassigned ? (
            <p className="bg-[#fff8e1] px-2 py-2 text-xs text-[#5b4708]">
              {report.unassigned.sale_count} sale(s) for {formatMoney(report.unassigned.net)} have no cashier name
              {report.unassigned.expected_cash > 0
                ? ` — ${formatMoney(report.unassigned.expected_cash)} cash is on nobody's close-out`
                : ""}
              . Their tips ({formatMoney(report.unassigned.tips_taken)}) are still in the pool.
            </p>
          ) : null}

          {report.staff.length === 0 ? (
            <EmptyNote>No sales with a cashier name yet. Add someone below to record their hours.</EmptyNote>
          ) : (
            <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
              {report.staff.map((row) => (
                <StaffCard date={date} key={row.staff_key} onChange={setReport} row={row} />
              ))}
            </div>
          )}

          <AddStaff date={date} known={report.staff.map((row) => row.staff_key)} onChange={setReport} />
        </div>
      </Panel>

      <Panel title="Tip split — by hours worked">
        <div className="grid gap-2 p-3 text-sm">
          <p className="flex items-baseline justify-between gap-2">
            <span className="text-[#6b7280]">Tip pool (all tips that day)</span>
            <span className="text-lg font-bold tabular-nums">{formatMoney(report.tip_pool)}</span>
          </p>
          {report.provisional ? (
            <p className="bg-[#fff8e1] px-2 py-2 text-xs text-[#5b4708]">
              Not everyone with sales has closed out yet. Shares will change when they add their hours.
            </p>
          ) : null}
          {shared.length === 0 ? (
            <EmptyNote>No hours entered yet. Shares appear when people close out with their hours.</EmptyNote>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] tracking-wide text-[#6b7280] uppercase">
                  <th className="py-1 font-bold">Staff</th>
                  <th className="py-1 text-right font-bold">Hours</th>
                  <th className="py-1 text-right font-bold">Share</th>
                </tr>
              </thead>
              <tbody>
                {shared.map((row) => (
                  <tr className="border-t border-[#ececf0]" key={row.staff_key}>
                    <td className="py-1">{row.name}</td>
                    <td className="py-1 text-right tabular-nums">
                      {formatMinutes(row.closeout?.minutes_worked ?? 0)}
                    </td>
                    <td className="py-1 text-right font-bold tabular-nums">{formatMoney(row.tip_share ?? 0)}</td>
                  </tr>
                ))}
                <tr className="border-t border-[#d4d4d8] font-bold">
                  <td className="py-1">Total</td>
                  <td className="py-1 text-right tabular-nums">{formatMinutes(report.total_minutes)}</td>
                  <td className="py-1 text-right tabular-nums">
                    {formatMoney(shared.reduce((sum, row) => sum + (row.tip_share ?? 0), 0))}
                  </td>
                </tr>
              </tbody>
            </table>
          )}
        </div>
      </Panel>
    </div>
  );
}

// ===== 한 사람 ==========================================================

function StaffCard({
  row,
  date,
  onChange,
}: {
  row: StaffRow;
  date: string;
  onChange: (report: CloseoutReport) => void;
}) {
  const closed = row.closeout;
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function reopen() {
    if (!window.confirm(`Reopen ${row.name}'s close-out? Their hours come out of the tip split.`)) return;
    setBusy(true);
    setError("");
    try {
      onChange(await retailApi.reopenCloseout(date, row.staff_key));
    } catch (cause) {
      setError(toRetailError(cause).message);
    } finally {
      setBusy(false);
    }
  }

  const overShort = closed && closed.counted_cash !== null ? closed.counted_cash - closed.expected_cash : null;

  return (
    <section className="grid min-w-0 gap-2 border border-[#d4d4d8] p-3">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="min-w-0 truncate text-sm font-bold">{row.name}</h3>
        {closed ? (
          closed.stale ? (
            <span className="shrink-0 bg-[#fdf0f0] px-1.5 py-0.5 text-[10px] font-bold text-[#8a1f1f]">
              CHANGED SINCE CLOSE
            </span>
          ) : (
            <span className="shrink-0 bg-[#e8f5ec] px-1.5 py-0.5 text-[10px] font-bold text-[#1f6b3a]">CLOSED</span>
          )
        ) : (
          <span className="shrink-0 bg-[#f0f0f3] px-1.5 py-0.5 text-[10px] font-bold text-[#3f434a]">OPEN</span>
        )}
      </div>

      <dl className="grid gap-0.5 text-xs">
        <Line label={`Sales ×${row.sale_count} (tax incl.)`} value={formatMoney(row.net)} />
        {row.by_payment.map((pay) => (
          <Line
            key={pay.method}
            label={`  ${PAYMENT_LABELS[pay.method]} ×${pay.count}${pay.tip ? ` + tip ${formatMoney(pay.tip)}` : ""}`}
            muted
            value={formatMoney(pay.total)}
          />
        ))}
        <Line label="Tips taken (go to the pool)" value={formatMoney(row.tips_taken)} />
        <Line bold label="Cash expected in drawer" value={formatMoney(row.expected_cash)} />
      </dl>

      {row.open_bills > 0 ? (
        <p className="bg-[#fff8e1] px-2 py-1.5 text-xs text-[#5b4708]">
          {row.open_bills} bill(s) under this name are still open. Charge or void them before closing.
        </p>
      ) : null}

      {closed ? (
        <dl className="grid gap-0.5 border-t border-[#ececf0] pt-2 text-xs">
          <Line label="Hours worked" value={formatMinutes(closed.minutes_worked)} />
          <Line
            label="Counted cash"
            value={closed.counted_cash === null ? "—" : formatMoney(closed.counted_cash)}
          />
          {overShort !== null ? (
            <Line
              bold
              label={overShort === 0 ? "Drawer balances" : overShort > 0 ? "Over" : "Short"}
              tone={overShort === 0 ? "good" : "bad"}
              value={formatMoney(Math.abs(overShort))}
            />
          ) : null}
          <Line bold label="Tip share" value={row.tip_share === null ? "—" : formatMoney(row.tip_share)} />
          {closed.note ? <p className="text-[#6b7280]">{closed.note}</p> : null}
          <p className="text-[11px] text-[#6b7280]">
            Closed {new Date(closed.closed_at).toLocaleString("en-CA")}
            {closed.stale ? " — sales under this name changed after closing. Close again." : ""}
          </p>
        </dl>
      ) : null}

      {error ? <ErrorNote>{error}</ErrorNote> : null}

      {editing || !closed ? (
        <CloseForm
          date={date}
          expectedCash={row.expected_cash}
          initial={closed}
          name={row.name}
          onCancel={closed ? () => setEditing(false) : undefined}
          onSaved={(report) => {
            setEditing(false);
            onChange(report);
          }}
        />
      ) : (
        <div className="flex gap-2">
          <Button className="flex-1" disabled={busy} onClick={() => setEditing(true)}>
            {closed?.stale ? "Close again" : "Edit"}
          </Button>
          <Button className="flex-1" disabled={busy} onClick={() => void reopen()} tone="danger">
            Reopen
          </Button>
        </div>
      )}
    </section>
  );
}

function CloseForm({
  date,
  name,
  expectedCash,
  initial,
  onSaved,
  onCancel,
}: {
  date: string;
  name: string;
  expectedCash: number;
  initial: StaffRow["closeout"];
  onSaved: (report: CloseoutReport) => void;
  onCancel?: () => void;
}) {
  const [hours, setHours] = useState(initial ? String(+(initial.minutes_worked / 60).toFixed(2)) : "");
  const [cash, setCash] = useState(
    initial?.counted_cash != null ? (initial.counted_cash / 100).toFixed(2) : "",
  );
  const [note, setNote] = useState(initial?.note ?? "");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const minutes = parseHours(hours);
  const counted = cash.trim() ? parseMoney(cash) : null;
  const diff = counted === null ? null : counted - expectedCash;

  async function save() {
    setError("");
    if (minutes === null) {
      setError("Enter hours worked, e.g. 7.5 or 7:30.");
      return;
    }
    if (expectedCash > 0 && counted === null) {
      setError(`Count the cash first — ${formatMoney(expectedCash)} is expected.`);
      return;
    }
    if (!isShiftCode(code)) {
      setError(`${name}: enter your 4-digit Pelham Shift ID to close out.`);
      return;
    }
    setBusy(true);
    try {
      const owner = await cashierForCode(code);
      if (sameName(owner, name) === false) {
        setError(`That ID belongs to ${owner}, not ${name}.`);
        setCode("");
        return;
      }
      onSaved(
        await retailApi.saveCloseout(date, { name, minutes_worked: minutes, counted_cash: counted, note: note.trim() || null }),
      );
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : toRetailError(cause).message);
      setCode("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-2 border-t border-[#ececf0] pt-2">
      <div className="grid grid-cols-2 gap-2">
        <Field hint="7.5 or 7:30" label="Hours worked">
          <TextInput inputMode="decimal" onChange={(event) => setHours(event.target.value)} value={hours} />
        </Field>
        <Field hint="without the float" label="Counted cash">
          <TextInput
            inputMode="decimal"
            onChange={(event) => setCash(event.target.value)}
            placeholder={(expectedCash / 100).toFixed(2)}
            value={cash}
          />
        </Field>
      </div>
      {diff !== null ? (
        <p className={`text-xs font-bold ${diff === 0 ? "text-[#1f6b3a]" : "text-[#8a1f1f]"}`}>
          {diff === 0 ? "Drawer balances." : `${diff > 0 ? "Over" : "Short"} ${formatMoney(Math.abs(diff))}`}
        </p>
      ) : null}
      <Field label="Note (optional)">
        <TextInput onChange={(event) => setNote(event.target.value)} placeholder="Why it's over/short…" value={note} />
      </Field>
      <ShiftIdInput onChange={setCode} onEnter={() => void save()} value={code} />
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      <div className="flex gap-2">
        <Button className="flex-1" disabled={busy || !isShiftCode(code)} onClick={() => void save()} tone="primary">
          {busy ? "Checking…" : `Close out ${name}`}
        </Button>
        {onCancel ? (
          <Button disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/** 매출이 없는 사람(주방·카트 담당 등)도 시간을 적어야 팁을 나눠 받는다. */
function AddStaff({
  date,
  known,
  onChange,
}: {
  date: string;
  known: string[];
  onChange: (report: CloseoutReport) => void;
}) {
  const [code, setCode] = useState("");
  const [hours, setHours] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function add() {
    setError("");
    const minutes = parseHours(hours);
    if (!isShiftCode(code)) {
      setError("Enter the 4-digit Pelham Shift ID.");
      return;
    }
    if (minutes === null) {
      setError("Enter hours worked, e.g. 7.5 or 7:30.");
      return;
    }
    setBusy(true);
    try {
      // 이름은 번호가 정한다 — 오타로 한 사람이 두 줄로 갈라지지 않는다.
      const name = await cashierForCode(code);
      if (known.includes(name.trim().replace(/\s+/g, " ").toLowerCase())) {
        setError(`${name} is already listed above — close out on their card.`);
        return;
      }
      onChange(await retailApi.saveCloseout(date, { name, minutes_worked: minutes, counted_cash: null }));
      setCode("");
      setHours("");
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : toRetailError(cause).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-2 border-t border-[#d4d4d8] pt-3">
      <h3 className="text-xs font-bold tracking-wide text-[#6b7280] uppercase">Add someone with no sales</h3>
      <div className="grid grid-cols-[1fr_7rem] gap-2 sm:grid-cols-[1fr_8rem_auto] sm:items-end">
        <ShiftIdInput onChange={setCode} value={code} />
        <Field label="Hours">
          <TextInput inputMode="decimal" onChange={(event) => setHours(event.target.value)} value={hours} />
        </Field>
        <div className="col-span-2 sm:col-span-1">
          <Button disabled={busy} full onClick={() => void add()}>
            {busy ? "Saving…" : "Add hours"}
          </Button>
        </div>
      </div>
      {error ? <ErrorNote>{error}</ErrorNote> : null}
    </div>
  );
}

/** 같은 사람인가 — 대소문자·공백 무시(담당자 묶음 staff_key 와 같은 규칙). */
function sameName(a: string, b: string): boolean {
  const key = (value: string) => value.trim().replace(/\s+/g, " ").toLowerCase();
  return key(a) === key(b);
}

/** Pelham Shift ID 칸. 로그인 비밀번호이기도 해서 가려 보이고, 어디에도 저장하지 않는다. */
function ShiftIdInput({
  value,
  onChange,
  onEnter,
}: {
  value: string;
  onChange: (value: string) => void;
  onEnter?: () => void;
}) {
  return (
    <Field hint="Your Pelham Shift ID — not saved" label="Staff ID (4 digits)">
      <TextInput
        autoComplete="off"
        inputMode="numeric"
        maxLength={8}
        onChange={(event) => onChange(event.target.value.replace(/[^0-9]/g, ""))}
        onKeyDown={(event) => {
          if (event.key === "Enter") onEnter?.();
        }}
        type="password"
        value={value}
      />
    </Field>
  );
}

function Line({
  label,
  value,
  bold = false,
  muted = false,
  tone,
}: {
  label: string;
  value: string;
  bold?: boolean;
  muted?: boolean;
  tone?: "good" | "bad";
}) {
  const color = tone === "good" ? "text-[#1f6b3a]" : tone === "bad" ? "text-[#8a1f1f]" : muted ? "text-[#6b7280]" : "";
  return (
    <div className={`flex items-baseline justify-between gap-2 ${bold ? "font-bold" : ""} ${color}`}>
      <dt className="min-w-0 truncate whitespace-pre">{label}</dt>
      <dd className="shrink-0 tabular-nums">{value}</dd>
    </div>
  );
}
