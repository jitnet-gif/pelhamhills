"use client";

/**
 * "Analysis facts" 탭 — Claude 가 전략을 쓸 때 받는 것을 그대로 보여 주고, 매니저가 팩트를 더한다.
 *
 * - 보기: Fly `/ai-marketing/inputs` 가 전략 요청과 **같은 조립**을 해서 돌려준다(Claude 는 부르지 않아 요금이 없다).
 *   판매·티 시트(0094), 문자·전화(0114), 전화 비서 통화(ElevenLabs), 인건비(pelham-shift), 상권, 매니저 팩트.
 * - 더하기: 매니저 팩트(0117) — 임대료·코스 관리·리스·공과금 같은 고정비, 아는 매출, 목표, 행사, 메모.
 *   켜 둔 것만 Claude 에 간다. 지우지 않는다 — 빼려면 끈다.
 *
 * 손익분기점: 인건비는 pelham-shift 가 주고, 그 밖의 비용은 여기 적은 cost 팩트가 전부다. 비용 팩트가 없으면
 * Claude 도 "인건비만 셌다"고 말한다.
 */

import { useEffect, useState } from "react";

import { Button, Chip, EmptyNote, ErrorNote, Field, Panel, Select, SkeletonRows, TextInput } from "@/components/retail/ui";
import { aiMarketingApi, strategyInputs, type Fact, type StrategyInputs } from "@/lib/aiMarketing/api";
import { localBusinessDate } from "@/lib/retail/api";
import { ApiError } from "@/lib/teeSheet/api";
import { addDays } from "@/lib/teeSheet/dates";

function describe(cause: unknown): string {
  if (cause instanceof ApiError) {
    if (/pelham_staff_ai_marketing_fact/i.test(cause.message) && /function|schema cache/i.test(cause.message)) {
      return "Manager facts switch on once 0117_ai_marketing_facts.sql is run in the Supabase SQL Editor.";
    }
    return cause.message;
  }
  return cause instanceof Error ? cause.message : "Could not load the facts.";
}

const FOUND_LABEL: Record<keyof StrategyInputs["found"], string> = {
  sales_and_tee_sheet: "Sales & tee sheet",
  texts_and_phone: "Texts & phone (Twilio)",
  phone_assistant_calls: "Phone assistant calls (ElevenLabs)",
  labor: "Labor cost (pelham-shift)",
  manager_facts: "Manager facts",
};

const KIND_LABEL: Record<Fact["kind"], string> = {
  cost: "Cost",
  revenue: "Revenue",
  goal: "Goal",
  event: "Event",
  note: "Note",
};
const PER_LABEL: Record<NonNullable<Fact["per"]>, string> = { month: "per month", season: "per season", year: "per year", once: "once" };

const dollars = (value: number) => `$${value.toLocaleString("en-CA", { maximumFractionDigits: 0 })}`;
const cents = (value: number) => dollars(value / 100);

type Period = "30" | "90" | "season";

function range(period: Period, today: string) {
  if (period === "30") return { from: addDays(today, -29), to: today };
  if (period === "90") return { from: addDays(today, -89), to: today };
  return { from: `${today.slice(0, 4)}-04-01`, to: today };
}

export function StrategyFacts() {
  const today = localBusinessDate();
  const [period, setPeriod] = useState<Period>("30");
  const { from, to } = range(period, today);
  const key = `${from}|${to}`;
  const [result, setResult] = useState<{ key: string; data?: StrategyInputs; error?: string } | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    strategyInputs(from, to).then(
      (data) => {
        if (!cancelled) setResult({ key, data });
      },
      (cause) => {
        if (!cancelled) setResult({ key, error: describe(cause) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [from, to, key, reload]);

  const loading = result?.key !== key;
  const data = loading ? null : result?.data;

  return (
    <div className="grid min-w-0 gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Chip active={period === "30"} onClick={() => setPeriod("30")}>Last 30 days</Chip>
        <Chip active={period === "90"} onClick={() => setPeriod("90")}>Last 90 days</Chip>
        <Chip active={period === "season"} onClick={() => setPeriod("season")}>This season (Apr 1 →)</Chip>
        <span className="text-xs text-[#6b7280]">{`${from} → ${to}`}</span>
      </div>

      <FactsEditor onChange={() => setReload((n) => n + 1)} />

      {!loading && result?.error ? <ErrorNote>{result.error}</ErrorNote> : null}
      {loading ? <SkeletonRows count={6} /> : null}
      {data ? <InputsView data={data} /> : null}
    </div>
  );
}

function InputsView({ data }: { data: StrategyInputs }) {
  const d = data.data;
  const labor = d.labor;
  const sales = d.net_sales / 100;
  const channels = d.channels as
    | {
        sms?: { sent: number; received: number; failed: number; stop_replies: number };
        campaigns?: { channel: string; name: string; recipients: number; delivered: number; failed: number }[];
        optouts?: { sms: number; call: number };
        callbacks?: { requests: number; still_open: number; reasons: string[] };
        phone_reports?: { kind: string; category: string; count: number }[];
        bookings_by_source?: { source: string; daytype: string; bookings: number }[];
      }
    | undefined;
  const calls = d.calls as
    | { calls: number; successful: number; average_seconds: number; outcomes: Record<string, number>; topics: string[] }
    | undefined;

  return (
    <div className="grid min-w-0 gap-3">
      <div className="flex flex-wrap gap-1.5">
        {(Object.keys(FOUND_LABEL) as (keyof StrategyInputs["found"])[]).map((name) => (
          <span
            className={`px-2 py-1 text-xs font-bold ${data.found[name] ? "bg-[#e8f4ec] text-[#1a7f4b]" : "bg-[#f3f4f6] text-[#6b7280]"}`}
            key={name}
          >
            {`${data.found[name] ? "✓" : "—"} ${FOUND_LABEL[name]}`}
          </span>
        ))}
      </div>
      <p className="text-xs text-[#6b7280]">
        This is everything Claude receives when you ask for a strategy for this period. Loading this page does not call Claude.
      </p>

      <div className="grid min-w-0 gap-3 lg:grid-cols-2">
        <Panel title="Sales & tee sheet">
          <Rows
            rows={[
              ["Rounds played", d.rounds.toLocaleString()],
              ["Bookings", d.bookings.toLocaleString()],
              ["Net sales (before tax)", dollars(sales)],
              ["Paid bills", d.paid_bills.toLocaleString()],
              ["No-shows", d.no_shows.toLocaleString()],
              ["Rounds linked to a customer", `${d.linked_rounds} of ${d.rounds}`],
              ["Days", `${d.days.weekday} weekdays · ${d.days.weekend} weekend days`],
            ]}
          />
        </Panel>

        <Panel title="Labor cost (pelham-shift)">
          {labor ? (
            <div className="grid gap-2">
              <Rows
                rows={[
                  ["Total labor", dollars(labor.total_labor)],
                  ["Labor as a share of sales", sales > 0 ? `${Math.round((labor.total_labor / sales) * 100)}%` : "—"],
                  ["Sales minus labor", dollars(sales - labor.total_labor)],
                  ["Hourly staff pay", `${dollars(labor.hourly.pay)} · ${labor.hourly.hours} h · ${labor.hourly.staff} people`],
                  ["Overtime / holiday hours", `${labor.hourly.ot_hours} h / ${labor.hourly.holiday_hours} h`],
                  ["Management (prorated)", `${dollars(labor.management.pay)} · ${labor.management.people} people`],
                  [
                    "Weekday labor per day",
                    labor.by_daytype.weekday.days ? dollars(labor.by_daytype.weekday.pay / labor.by_daytype.weekday.days) : "—",
                  ],
                  [
                    "Weekend labor per day",
                    labor.by_daytype.weekend.days ? dollars(labor.by_daytype.weekend.pay / labor.by_daytype.weekend.days) : "—",
                  ],
                ]}
              />
              {labor.by_area.length ? (
                <Rows rows={labor.by_area.map((row) => [row.area, `${dollars(row.pay)} · ${row.hours} h`])} />
              ) : null}
              <p className="text-[11px] text-[#6b7280]">Totals only — no names or wages leave pelham-shift. Area and day figures are hours × wage.</p>
            </div>
          ) : (
            <EmptyNote>
              Labor cost is not connected yet. It switches on when LABOR_API_KEY is set on pelham-shift (Vercel) and the same value
              as PELHAM_SHIFT_LABOR_KEY on the club API (Fly).
            </EmptyNote>
          )}
        </Panel>

        <Panel title="Texts & phone (Twilio)">
          {channels ? (
            <Rows
              rows={[
                ["Texts sent / received", `${channels.sms?.sent ?? 0} / ${channels.sms?.received ?? 0}`],
                ["STOP replies · failed", `${channels.sms?.stop_replies ?? 0} · ${channels.sms?.failed ?? 0}`],
                ["Campaigns", String(channels.campaigns?.length ?? 0)],
                ["New opt-outs (text / call)", `${channels.optouts?.sms ?? 0} / ${channels.optouts?.call ?? 0}`],
                ["Callback requests (open)", `${channels.callbacks?.requests ?? 0} (${channels.callbacks?.still_open ?? 0})`],
                [
                  "Problems & complaints",
                  String((channels.phone_reports ?? []).reduce((n, row) => n + row.count, 0)),
                ],
                ...(channels.bookings_by_source ?? []).map(
                  (row) => [`Bookings · ${row.source} · ${row.daytype}`, String(row.bookings)] as [string, string],
                ),
              ]}
            />
          ) : (
            <EmptyNote>Not connected yet — run 0114_ai_marketing_channels.sql.</EmptyNote>
          )}
        </Panel>

        <Panel title="Phone assistant calls (ElevenLabs)">
          {calls ? (
            <div className="grid gap-2">
              <Rows
                rows={[
                  ["Calls", String(calls.calls)],
                  ["Successful", String(calls.successful)],
                  ["Average length", `${calls.average_seconds} s`],
                  ...Object.entries(calls.outcomes).map(([name, count]) => [`Outcome · ${name}`, String(count)] as [string, string]),
                ]}
              />
              {calls.topics.length ? (
                <details className="text-xs">
                  <summary className="cursor-pointer font-bold">{`Call topics (${calls.topics.length})`}</summary>
                  <ul className="mt-1 grid list-disc gap-0.5 pl-5">
                    {calls.topics.map((topic, index) => (
                      <li key={index}>{topic}</li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </div>
          ) : (
            <EmptyNote>No calls in this period, or the call list could not be read.</EmptyNote>
          )}
        </Panel>
      </div>

      <Panel title="Trade area (sent with every request)">
        <pre className="text-xs leading-relaxed whitespace-pre-wrap">{data.region}</pre>
      </Panel>

      <details className="border border-[#d4d4d8] bg-white p-3 text-xs">
        <summary className="cursor-pointer font-bold">Raw data sent to Claude (JSON)</summary>
        <pre className="mt-2 max-h-[480px] overflow-auto">{JSON.stringify(data.data, null, 2)}</pre>
      </details>
    </div>
  );
}

function Rows({ rows }: { rows: [string, string][] }) {
  return (
    <ul className="grid gap-1 text-sm">
      {rows.map(([label, value], index) => (
        <li className="flex justify-between gap-3" key={`${label}-${index}`}>
          <span className="min-w-0">{label}</span>
          <span className="shrink-0 font-semibold tabular-nums">{value}</span>
        </li>
      ))}
    </ul>
  );
}

const BLANK = { kind: "cost" as Fact["kind"], label: "", detail: "", amount: "", per: "month" as Fact["per"] | "" };

/** 매니저 팩트(0117) — 목록, 더하기, 고치기, 끄기/켜기. */
function FactsEditor({ onChange }: { onChange: () => void }) {
  const [facts, setFacts] = useState<Fact[] | null>(null);
  const [error, setError] = useState("");
  const [form, setForm] = useState(BLANK);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    aiMarketingApi.facts().then(
      (list) => {
        if (!cancelled) setFacts(list);
      },
      (cause) => {
        if (!cancelled) setError(describe(cause));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [reload]);

  const save = async (patch: Partial<Fact>) => {
    setBusy(true);
    setError("");
    try {
      await aiMarketingApi.saveFact(patch);
      setReload((n) => n + 1);
      onChange();
      return true;
    } catch (cause) {
      setError(describe(cause));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    const amount = form.amount.trim() ? Math.round(Number(form.amount.replace(/[$,\s]/g, "")) * 100) : null;
    if (amount !== null && !Number.isFinite(amount)) {
      setError("Write the amount as a number, for example 4500.");
      return;
    }
    const ok = await save({
      ...(editing ? { id: editing } : {}),
      kind: form.kind,
      label: form.label.trim(),
      detail: form.detail.trim(),
      amount_cents: amount,
      per: amount === null ? null : form.per || "month",
    });
    if (ok) {
      setForm(BLANK);
      setEditing(null);
    }
  };

  const edit = (fact: Fact) => {
    setEditing(fact.id);
    setForm({
      kind: fact.kind,
      label: fact.label,
      detail: fact.detail,
      amount: fact.amount_cents === null ? "" : String(fact.amount_cents / 100),
      per: fact.per ?? "month",
    });
  };

  return (
    <Panel title="Manager facts — added to every analysis">
      <div className="grid gap-3">
        <p className="text-xs text-[#6b7280]">
          Add what the systems do not know: fixed costs (rent, course upkeep, equipment leases, utilities, insurance), revenue
          from elsewhere, goals, events and notes. Costs are used for the break-even. Only facts that are on go to Claude.
          Facts are never deleted — turn one off instead.
        </p>
        {error ? <ErrorNote>{error}</ErrorNote> : null}
        {!facts && !error ? <SkeletonRows count={2} /> : null}
        {facts && facts.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[600px] text-sm">
              <thead>
                <tr className="text-left text-xs text-[#6b7280]">
                  <th className="font-bold">Kind</th>
                  <th className="font-bold">Fact</th>
                  <th className="text-right font-bold">Amount</th>
                  <th className="font-bold">Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {facts.map((fact) => (
                  <tr className={`border-t border-[#eef0f2] align-top ${fact.active ? "" : "text-[#9ca3af]"}`} key={fact.id}>
                    <td className="py-1.5 pr-2 whitespace-nowrap">{KIND_LABEL[fact.kind]}</td>
                    <td className="py-1.5 pr-2">
                      <span className="font-semibold">{fact.label}</span>
                      {fact.detail ? <span className="block text-xs">{fact.detail}</span> : null}
                      <span className="block text-[11px] text-[#9ca3af]">{fact.updated_by || fact.created_by}</span>
                    </td>
                    <td className="py-1.5 pr-2 text-right whitespace-nowrap tabular-nums">
                      {fact.amount_cents === null ? "" : `${cents(fact.amount_cents)} ${fact.per ? PER_LABEL[fact.per] : ""}`}
                    </td>
                    <td className="py-1.5 pr-2 text-xs">{fact.active ? "On" : "Off"}</td>
                    <td className="py-1.5 text-right whitespace-nowrap">
                      <Button disabled={busy} onClick={() => edit(fact)}>
                        Edit
                      </Button>{" "}
                      <Button disabled={busy} onClick={() => save({ id: fact.id, active: !fact.active })}>
                        {fact.active ? "Turn off" : "Turn on"}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : facts ? (
          <EmptyNote>No manager facts yet. Start with the monthly fixed costs so the break-even is real.</EmptyNote>
        ) : null}

        <div className="grid gap-2 border border-[#d4d4d8] bg-[#fafafa] p-3 md:grid-cols-[120px_minmax(0,2fr)_120px_130px] md:items-end">
          <Field label="Kind">
            <Select id="fact-kind" onChange={(event) => setForm({ ...form, kind: event.target.value as Fact["kind"] })} value={form.kind}>
              {(Object.keys(KIND_LABEL) as Fact["kind"][]).map((kind) => (
                <option key={kind} value={kind}>
                  {KIND_LABEL[kind]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Fact">
            <TextInput
              id="fact-label"
              maxLength={200}
              onChange={(event) => setForm({ ...form, label: event.target.value })}
              placeholder="e.g. Course maintenance contract"
              value={form.label}
            />
          </Field>
          <Field label="Amount ($, optional)">
            <TextInput
              id="fact-amount"
              inputMode="decimal"
              onChange={(event) => setForm({ ...form, amount: event.target.value })}
              placeholder="4500"
              value={form.amount}
            />
          </Field>
          <Field label="Per">
            <Select id="fact-per" onChange={(event) => setForm({ ...form, per: event.target.value as Fact["per"] })} value={form.per ?? "month"}>
              {(Object.keys(PER_LABEL) as NonNullable<Fact["per"]>[]).map((per) => (
                <option key={per} value={per}>
                  {PER_LABEL[per]}
                </option>
              ))}
            </Select>
          </Field>
          <div className="md:col-span-4">
            <Field label="Detail (optional)">
              <TextInput
                id="fact-detail"
                maxLength={1000}
                onChange={(event) => setForm({ ...form, detail: event.target.value })}
                placeholder="e.g. Paid April to October; includes fertilizer"
                value={form.detail}
              />
            </Field>
          </div>
          <div className="flex gap-2 md:col-span-4">
            <Button disabled={busy || !form.label.trim()} onClick={submit} tone="primary">
              {editing ? "Save changes" : "Add fact"}
            </Button>
            {editing ? (
              <Button
                onClick={() => {
                  setEditing(null);
                  setForm(BLANK);
                }}
              >
                Cancel
              </Button>
            ) : null}
          </div>
        </div>
      </div>
    </Panel>
  );
}
