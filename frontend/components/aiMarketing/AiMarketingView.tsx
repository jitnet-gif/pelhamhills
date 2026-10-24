"use client";

/**
 * AI Manager Marketing Strategies — 1단계: 기간을 고르면 고객 분석을 실제 숫자로 보여 준다(0094).
 *
 *   - 맨 위 숫자: 라운드, 골퍼 1인 매출, 재방문, 노쇼, 주중·주말 하루 평균.
 *   - 고객층 × 주중·주말 × 시간대: 하루 평균 라운드(주중과 주말은 날 수가 달라서 그대로 세면 주중이 커 보인다).
 *   - 매출 구성: 그린피·카트·추가품목·프로샵·스낵바, 고객층별 1인 금액과 주중·주말.
 *   - 유입 경로·프로모 코드·회원권·연락 가능한 사람 수.
 *
 * 숫자는 모두 서버가 계산한다. 다음 단계(예상 매출, Claude 의 사실·제안, 마케팅 믹스 보드)는 이 화면에 붙는다.
 * 데모 숫자로 내려가지 않는다 — 서버가 안 되면 오류를 보여 준다(옛 Business Intelligence 화면이 고치려던 문제).
 */

import { useEffect, useMemo, useState } from "react";

import { Button, Chip, EmptyNote, ErrorNote, Field, Panel, SkeletonCards, SkeletonRows, StatCard, TextInput } from "@/components/retail/ui";
import {
  aiMarketingApi,
  type DayPart,
  type DayType,
  type MarketingSummary,
  type SalesParts,
  type Segment,
} from "@/lib/aiMarketing/api";
import { localBusinessDate } from "@/lib/retail/api";
import { ApiError } from "@/lib/teeSheet/api";
import { addDays } from "@/lib/teeSheet/dates";

const SEG_LABEL: Record<Segment | "no_golfer", string> = {
  member: "Members",
  public: "Public",
  golfnow: "GolfNow",
  junior_senior: "Junior / Senior",
  league: "League",
  tour: "Tour operator",
  staff: "Staff",
  no_golfer: "No golfer on bill",
};
const SEG_ORDER: (Segment | "no_golfer")[] = ["member", "public", "golfnow", "junior_senior", "league", "tour", "staff", "no_golfer"];

/** 0040 의 membership_type. */
const MEMBERSHIP_LABEL: Record<string, string> = {
  full: "Full",
  weekday: "Weekday",
  intermediate: "Intermediate",
  nine_hole: "9 hole",
  twilight: "Twilight",
  junior: "Junior",
};

const PARTS: { key: keyof SalesParts; label: string; color: string }[] = [
  { key: "green", label: "Green fee", color: "#1a7f4b" },
  { key: "cart", label: "Cart", color: "#7fb89a" },
  { key: "extras", label: "Tee extras", color: "#b7c4bd" },
  { key: "shop", label: "Pro shop", color: "#2d5e8c" },
  { key: "snack", label: "Snack bar", color: "#d08a2e" },
];

const COLUMNS: { daytype: DayType; daypart: DayPart; label: string }[] = [
  { daytype: "weekday", daypart: "am", label: "Weekday AM" },
  { daytype: "weekday", daypart: "pm", label: "Weekday 12–3" },
  { daytype: "weekday", daypart: "twilight", label: "Weekday 3 PM+" },
  { daytype: "weekend", daypart: "am", label: "Weekend AM" },
  { daytype: "weekend", daypart: "pm", label: "Weekend 12–3" },
  { daytype: "weekend", daypart: "twilight", label: "Weekend 3 PM+" },
];

type Period = "30" | "90" | "season" | "custom";

function periodRange(period: Period, today: string): { from: string; to: string } {
  if (period === "30") return { from: addDays(today, -29), to: today };
  if (period === "90") return { from: addDays(today, -89), to: today };
  return { from: `${today.slice(0, 4)}-04-01`, to: today };
}

const money = (cents: number) =>
  `$${(cents / 100).toLocaleString("en-CA", { maximumFractionDigits: 0 })}`;
const money2 = (cents: number) =>
  `$${(cents / 100).toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : "—");
const sumParts = (parts: SalesParts) => parts.green + parts.cart + parts.extras + parts.shop + parts.snack;

function describe(cause: unknown): string {
  if (cause instanceof ApiError) return cause.message;
  return cause instanceof Error ? cause.message : "Could not load the numbers.";
}

export default function AiMarketingView() {
  const today = localBusinessDate();
  const [period, setPeriod] = useState<Period>("30");
  const [custom, setCustom] = useState(() => periodRange("30", today));
  // 읽을 기간. custom 은 Show 를 눌러야 바뀐다 — 날짜를 고치는 중에 매번 부르지 않게.
  const [request, setRequest] = useState(() => periodRange("30", today));
  const requestKey = `${request.from}|${request.to}`;
  const [result, setResult] = useState<{ key: string; data?: MarketingSummary; error?: string } | null>(null);
  const loading = result?.key !== requestKey;
  const [data, setData] = useState<MarketingSummary | null>(null);

  useEffect(() => {
    let cancelled = false;
    aiMarketingApi.summary(request.from, request.to).then(
      (summary) => {
        if (cancelled) return;
        setData(summary);
        setResult({ key: requestKey, data: summary });
      },
      (cause) => {
        if (!cancelled) setResult({ key: requestKey, error: describe(cause) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [request, requestKey]);

  const pick = (next: Period) => {
    setPeriod(next);
    if (next !== "custom") setRequest(periodRange(next, today));
  };
  const error = loading ? "" : (result?.error ?? "");

  return (
    <div className="grid min-w-0 gap-3 p-4">
      <p className="text-sm text-[#4e5560]">
        Who plays when, what they spend, and where they come from — real numbers from tee sheet bookings and paid bills.
        Forecast, Claude&apos;s facts &amp; ideas and the marketing mix board come next on this page.
      </p>

      <div className="flex flex-wrap items-end gap-2">
        <Chip active={period === "30"} onClick={() => pick("30")}>Last 30 days</Chip>
        <Chip active={period === "90"} onClick={() => pick("90")}>Last 90 days</Chip>
        <Chip active={period === "season"} onClick={() => pick("season")}>This season (Apr 1 →)</Chip>
        <Chip active={period === "custom"} onClick={() => pick("custom")}>Custom</Chip>
        {period === "custom" ? (
          <>
            <Field label="From">
              <TextInput onChange={(event) => setCustom({ ...custom, from: event.target.value })} type="date" value={custom.from} />
            </Field>
            <Field label="To">
              <TextInput onChange={(event) => setCustom({ ...custom, to: event.target.value })} type="date" value={custom.to} />
            </Field>
            <Button onClick={() => setRequest({ ...custom })} tone="primary">Show</Button>
          </>
        ) : null}
        {loading && data ? <span className="text-xs text-[#6b7280]">Loading…</span> : null}
      </div>

      {error ? <ErrorNote>{error}</ErrorNote> : null}
      {loading && !data ? (
        <>
          <SkeletonCards count={6} />
          <SkeletonRows count={6} />
        </>
      ) : data && !error ? (
        <Summary data={data} />
      ) : null}
    </div>
  );
}

function Summary({ data }: { data: MarketingSummary }) {
  const golferSales = data.sales_by_seg.filter((row) => row.seg !== "no_golfer");
  const paidGolfers = golferSales.reduce((total, row) => total + row.players, 0);
  const golferTotal = golferSales.reduce((total, row) => total + sumParts(row), 0);
  const weekdayRounds = data.grid.filter((cell) => cell.daytype === "weekday").reduce((t, c) => t + c.rounds, 0);
  const weekendRounds = data.rounds - weekdayRounds;
  const perDay = (rounds: number, days: number) => (days > 0 ? (rounds / days).toFixed(1) : "—");

  return (
    <div className="grid min-w-0 gap-3">
      <p className="text-xs text-[#6b7280]">
        {data.from} → {data.to} · {data.days.weekday} weekdays, {data.days.weekend} weekend days &amp; holidays
      </p>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-2">
        <StatCard hint={`${data.bookings} bookings`} label="Rounds played" strong value={data.rounds.toLocaleString()} />
        <StatCard
          hint={`${paidGolfers} paid golfers · green fee to snack bar`}
          label="Sales per golfer"
          strong
          value={paidGolfers > 0 ? money2(golferTotal / paidGolfers) : "—"}
        />
        <StatCard
          hint={`${data.repeat_golfers} of ${data.linked_golfers} named golfers came 2+ days`}
          label="Repeat rate"
          value={pct(data.repeat_golfers, data.linked_golfers)}
        />
        <StatCard hint={`${data.no_shows} no-shows`} label="No-show rate" value={pct(data.no_shows, data.rounds + data.no_shows)} />
        <StatCard hint="rounds per weekday" label="Weekday / day" value={perDay(weekdayRounds, data.days.weekday)} />
        <StatCard hint="rounds per weekend day" label="Weekend / day" value={perDay(weekendRounds, data.days.weekend)} />
      </div>
      {data.rounds > 0 && data.linked_rounds / data.rounds < 0.5 ? (
        <p className="text-xs text-[#7a6320]">
          Only {pct(data.linked_rounds, data.rounds)} of rounds are linked to a customer record, so the repeat rate covers
          those golfers only.
        </p>
      ) : null}

      <Panel title="Rounds per day — group × weekday / weekend × time">
        <Heatmap data={data} />
      </Panel>

      <div className="grid min-w-0 gap-3 lg:grid-cols-2">
        <Panel title="Spend per paid golfer, by group">
          <SegmentSales data={data} />
        </Panel>
        <Panel title="Sales — weekday vs weekend">
          <DaySales data={data} />
        </Panel>
      </div>

      <div className="grid min-w-0 gap-3 md:grid-cols-2 xl:grid-cols-4">
        <Panel title="Website bookings came from">
          <SimpleList empty="No website bookings in this period." rows={data.web_sources.map((row) => [row.label, String(row.bookings)])} />
        </Panel>
        <Panel title="Promo codes used">
          <SimpleList
            empty="No promo codes used in this period."
            rows={data.promo.map((row) => [`${row.code} · ${row.name}`, `${row.uses} · ${money2(row.amount)}`])}
          />
        </Panel>
        <Panel title={`Active members · ${data.to.slice(0, 4)}`}>
          <SimpleList empty="No active memberships." rows={data.members.map((row) => [MEMBERSHIP_LABEL[row.type] ?? row.type, String(row.count)])} />
        </Panel>
        <Panel title="Who we can reach">
          <SimpleList
            empty=""
            rows={[
              ["Customers", data.reach.customers.toLocaleString()],
              ["With email", data.reach.with_email.toLocaleString()],
              ["With phone", data.reach.with_phone.toLocaleString()],
              ["Texts OK (marked)", data.reach.sms_ok.toLocaleString()],
              ["AI calls OK (marked)", data.reach.call_ok.toLocaleString()],
              ["Opted out", data.reach.opted_out.toLocaleString()],
            ]}
          />
        </Panel>
      </div>
    </div>
  );
}

function Heatmap({ data }: { data: MarketingSummary }) {
  const rows = useMemo(() => {
    const segs = SEG_ORDER.filter((seg) => data.grid.some((cell) => cell.seg === seg));
    return segs.map((seg) => ({
      seg,
      cells: COLUMNS.map((column) => {
        const rounds = data.grid
          .filter((cell) => cell.seg === seg && cell.daytype === column.daytype && cell.daypart === column.daypart)
          .reduce((total, cell) => total + cell.rounds, 0);
        const days = data.days[column.daytype];
        return { rounds, perDay: days > 0 ? rounds / days : 0 };
      }),
    }));
  }, [data]);
  const max = Math.max(0.0001, ...rows.flatMap((row) => row.cells.map((cell) => cell.perDay)));

  if (rows.length === 0) return <EmptyNote>No rounds in this period.</EmptyNote>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[560px] border-separate border-spacing-1 text-sm">
        <thead>
          <tr>
            <th />
            {COLUMNS.map((column) => (
              <th className="text-xs font-bold text-[#6b7280]" key={column.label}>
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.seg}>
              <th className="pr-2 text-left font-bold whitespace-nowrap">{SEG_LABEL[row.seg]}</th>
              {row.cells.map((cell, index) => {
                const strength = cell.perDay / max;
                return (
                  <td
                    className="px-2 py-1.5 text-center font-semibold tabular-nums"
                    key={COLUMNS[index].label}
                    style={{
                      background: `rgba(26,127,75,${(0.06 + strength * 0.8).toFixed(2)})`,
                      color: strength > 0.55 ? "#fff" : "#1f2328",
                    }}
                    title={`${cell.rounds} rounds`}
                  >
                    {cell.rounds === 0 ? "·" : cell.perDay.toFixed(1)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-1 text-xs text-[#6b7280]">
        Average rounds per weekday or per weekend day (holidays count as weekend). Hover a cell for the total. Times are tee
        times; 3 PM+ is twilight.
      </p>
    </div>
  );
}

function Legend() {
  return (
    <div className="flex flex-wrap gap-3 text-xs text-[#4e5560]">
      {PARTS.map((part) => (
        <span className="inline-flex items-center gap-1" key={part.key}>
          <i className="inline-block size-2.5" style={{ background: part.color }} />
          {part.label}
        </span>
      ))}
    </div>
  );
}

function StackBar({ parts, max }: { parts: SalesParts; max: number }) {
  return (
    <div className="flex h-4 min-w-0 overflow-hidden bg-[#eef0f2]">
      {PARTS.map((part) => (
        <span
          key={part.key}
          style={{ background: part.color, width: `${max > 0 ? (parts[part.key] / max) * 100 : 0}%` }}
          title={`${part.label} ${money2(parts[part.key])}`}
        />
      ))}
    </div>
  );
}

function SegmentSales({ data }: { data: MarketingSummary }) {
  const rows = SEG_ORDER.flatMap((seg) => {
    const row = data.sales_by_seg.find((item) => item.seg === seg);
    if (!row || row.seg === "no_golfer" || row.players === 0) return [];
    const each = Object.fromEntries(PARTS.map((part) => [part.key, row[part.key] / row.players])) as SalesParts;
    return [{ seg, players: row.players, each }];
  });
  const loose = data.sales_by_seg.find((row) => row.seg === "no_golfer");
  const max = Math.max(1, ...rows.map((row) => sumParts(row.each)));

  if (rows.length === 0) return <EmptyNote>No paid tee times in this period.</EmptyNote>;
  return (
    <div className="grid gap-2">
      <Legend />
      {rows.map((row) => (
        <div className="grid grid-cols-[110px_minmax(0,1fr)_64px] items-center gap-2 text-sm" key={row.seg}>
          <span className="truncate font-bold" title={`${row.players} paid golfers`}>
            {SEG_LABEL[row.seg]}
          </span>
          <StackBar max={max} parts={row.each} />
          <span className="text-right font-mono text-xs">{money2(sumParts(row.each))}</span>
        </div>
      ))}
      {loose && loose.shop + loose.snack > 0 ? (
        <p className="text-xs text-[#6b7280]">
          Plus {money(loose.shop)} pro shop and {money(loose.snack)} snack bar on bills with no golfer on them.
        </p>
      ) : null}
      <p className="text-xs text-[#6b7280]">
        Before tax, per paid golfer. Pro shop and snack bar items count toward the golfers on the same bill.
      </p>
    </div>
  );
}

function DaySales({ data }: { data: MarketingSummary }) {
  const rows = (["weekday", "weekend"] as const).map((daytype) => {
    const row = data.sales_by_daytype.find((item) => item.daytype === daytype);
    const parts: SalesParts = row ?? { green: 0, cart: 0, extras: 0, shop: 0, snack: 0 };
    return { daytype, parts, perDay: data.days[daytype] > 0 ? sumParts(parts) / data.days[daytype] : 0 };
  });
  const max = Math.max(1, ...rows.map((row) => row.perDay));

  return (
    <div className="grid gap-2">
      <Legend />
      {rows.map((row) => {
        const days = data.days[row.daytype] || 1;
        const daily = Object.fromEntries(PARTS.map((part) => [part.key, row.parts[part.key] / days])) as SalesParts;
        return (
          <div className="grid grid-cols-[110px_minmax(0,1fr)_64px] items-center gap-2 text-sm" key={row.daytype}>
            <span className="font-bold">{row.daytype === "weekday" ? "Weekday" : "Weekend"}</span>
            <StackBar max={max} parts={daily} />
            <span className="text-right font-mono text-xs">{money(row.perDay)}</span>
          </div>
        );
      })}
      <div className="overflow-x-auto">
      <table className="mt-1 w-full min-w-[420px] text-xs tabular-nums">
        <thead>
          <tr className="text-[#6b7280]">
            <th className="text-left font-bold">Period total</th>
            {PARTS.map((part) => (
              <th className="text-right font-bold" key={part.key}>
                {part.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.daytype}>
              <td>{row.daytype === "weekday" ? "Weekday" : "Weekend"}</td>
              {PARTS.map((part) => (
                <td className="text-right" key={part.key}>
                  {money(row.parts[part.key])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      </div>
      <p className="text-xs text-[#6b7280]">
        Bar = average sales per day, before tax. Bill discounts (promo codes etc.) {money(data.bill_discount)} are not taken
        off the parts.
      </p>
    </div>
  );
}

function SimpleList({ rows, empty }: { rows: string[][]; empty: string }) {
  if (rows.length === 0) return <p className="text-sm text-[#6b7280]">{empty}</p>;
  return (
    <ul className="grid gap-1 text-sm">
      {rows.map(([label, value]) => (
        <li className="flex justify-between gap-2" key={label}>
          <span className="min-w-0 truncate">{label}</span>
          <span className="shrink-0 font-semibold tabular-nums">{value}</span>
        </li>
      ))}
    </ul>
  );
}
