"use client";

/**
 * AI Manager Marketing Strategies — 1단계: 기간을 고르면 고객 분석을 실제 숫자로 보여 준다(0094).
 *
 *   - 맨 위 숫자: 라운드, 골퍼 1인 매출, 재방문, 노쇼, 주중·주말 하루 평균.
 *   - 고객층 × 주중·주말 × 시간대: 하루 평균 라운드(주중과 주말은 날 수가 달라서 그대로 세면 주중이 커 보인다).
 *   - 매출 구성: 그린피·카트·추가품목·프로샵·스낵바, 고객층별 1인 금액과 주중·주말.
 *   - 유입 경로·프로모 코드·회원권·연락 가능한 사람 수.
 *   - 회원별 라운드 수(0097): 기간·시즌 누적·마지막 플레이.
 *   - Claude 의 전략 제안(Fly `/ai-marketing/strategy`): 같은 기간 요약 + 골프장 주변·해밀턴 경계 상권으로
 *     사실·전략·니치 시장·30/60/90일 실행표. 누를 때만 부른다(1–2분, 유료). 결과는 기간 × 언어별로 이 브라우저에 둔다.
 *     받으면 나레이션(ElevenLabs Hope, Fly `/ai-marketing/narrate`) 프레젠테이션으로 보여 준다.
 *
 * 숫자는 모두 서버가 계산한다. 다음 단계(예상 매출, 마케팅 믹스 보드)는 이 화면에 붙는다.
 * 데모 숫자로 내려가지 않는다 — 서버가 안 되면 오류를 보여 준다(옛 Business Intelligence 화면이 고치려던 문제).
 */

import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";

import { Button, Chip, EmptyNote, ErrorNote, Field, Panel, SkeletonCards, SkeletonRows, StatCard, TextArea, TextInput } from "@/components/retail/ui";
import {
  aiMarketingApi,
  askStrategy,
  narrationUrl,
  type Strategy,
  type DayPart,
  type DayType,
  type MarketingSummary,
  type MemberRounds,
  type SalesParts,
  type Segment,
} from "@/lib/aiMarketing/api";
import { getLang, type Lang, onLangChange, setLang } from "@/lib/i18n/engine";
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
        Claude reads the same numbers plus the trade area around the club (Welland, Pelham, Niagara and the Hamilton
        boundary) and writes a marketing strategy. Forecast and the marketing mix board come next on this page.
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
        <>
          <StrategyPanel from={request.from} key={requestKey} to={request.to} />
          <Summary data={data} />
        </>
      ) : null}
      {data && !error ? <MemberRoundsPanel from={request.from} to={request.to} /> : null}
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

/**
 * 회원별 라운드 수(0097). 요약과 따로 부른다 — 0097 을 아직 실행하지 않았어도 위 요약은 그대로 보이게.
 */
function MemberRoundsPanel({ from, to }: { from: string; to: string }) {
  const key = `${from}|${to}`;
  const [result, setResult] = useState<{ key: string; data?: MemberRounds; error?: string } | null>(null);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    let cancelled = false;
    aiMarketingApi.memberRounds(from, to).then(
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
  }, [from, to, key]);

  const loading = result?.key !== key;
  const data = loading ? null : result?.data;
  const members = data?.members ?? [];
  const shown = showAll ? members : members.slice(0, 25);
  const total = members.reduce((sum, row) => sum + row.rounds, 0);
  const idle = members.filter((row) => row.rounds === 0).length;

  return (
    <Panel title={data ? `Rounds by member · ${data.season} members` : "Rounds by member"}>
      {loading ? (
        <SkeletonRows count={4} />
      ) : result?.error ? (
        <ErrorNote>
          {/function|schema cache|does not exist/i.test(result.error)
            ? "Rounds by member switches on once 0097_ai_marketing_member_rounds.sql is run in the Supabase SQL Editor."
            : result.error}
        </ErrorNote>
      ) : members.length === 0 ? (
        <EmptyNote>No active memberships this season.</EmptyNote>
      ) : (
        <div className="grid gap-2">
          <p className="text-xs text-[#6b7280]">
            {`${members.length} members · ${total} rounds in this period · ${idle} did not play`}
          </p>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm tabular-nums">
              <thead>
                <tr className="text-xs text-[#6b7280]">
                  <th className="text-left font-bold">Member</th>
                  <th className="text-left font-bold">Membership</th>
                  <th className="text-right font-bold">Rounds (period)</th>
                  <th className="text-right font-bold">Season total</th>
                  <th className="text-right font-bold">No-shows</th>
                  <th className="text-right font-bold">Last played</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((row, index) => (
                  <tr className="border-t border-[#eef0f2]" key={`${row.name}-${index}`}>
                    <td className="py-1 pr-2" translate="no">
                      {row.name}
                      {row.member_number ? <span className="text-xs text-[#6b7280]"> #{row.member_number}</span> : null}
                    </td>
                    <td className="py-1 pr-2">
                      {MEMBERSHIP_LABEL[row.type] ?? row.type}
                      {row.plan === "spousal" ? " · Spousal" : ""}
                    </td>
                    <td className="py-1 text-right font-semibold">{row.linked ? row.rounds : "—"}</td>
                    <td className="py-1 text-right">{row.linked ? row.season_rounds : "—"}</td>
                    <td className="py-1 text-right">{row.linked && row.no_shows > 0 ? row.no_shows : ""}</td>
                    <td className="py-1 text-right">{row.last_played ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {members.length > 25 ? (
            <div>
              <Button onClick={() => setShowAll(!showAll)}>{showAll ? "Show top 25" : `Show all ${members.length}`}</Button>
            </div>
          ) : null}
          <p className="text-xs text-[#6b7280]">
            Season total runs Jan 1 to today. A round counts for a member when the tee sheet player is linked to the
            member&apos;s customer record; “—” means the membership has no customer record yet.
          </p>
          {data && data.unlinked_rounds > 0 ? (
            <p className="text-xs text-[#7a6320]">
              {`${data.unlinked_rounds} member-rate rounds in this period are not linked to any membership, so they are not in this table.`}
            </p>
          ) : null}
        </div>
      )}
    </Panel>
  );
}

const BUDGET_LABEL: Record<Strategy["strategies"][number]["budget"], string> = { low: "Low budget", medium: "Medium budget", high: "High budget" };

function storedStrategy(key: string): Strategy | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as Strategy) : null;
  } catch {
    return null;
  }
}

/**
 * Claude 의 전략 제안. 누를 때만 서버를 부른다 — 1–2분 걸리고 부를 때마다 API 요금이 든다.
 * 결과는 기간 × 언어별로 이 브라우저(localStorage)에 둔다. 없어져도 다시 누르면 된다.
 * Claude 가 쓴 글은 그 언어로 오므로 사전에 걸리지 않는다. 제목·라벨만 사전(ko.json)으로 바뀐다.
 * EN/한 을 바꾸면 그 언어로 받아 둔 결과를 보여 준다(없으면 그 언어로 다시 요청하게 한다).
 *
 * 결과는 먼저 **프레젠테이션**(장면 넘기기 + Hope 목소리 나레이션)으로 보이고, "Full text" 로 전체 글을 본다.
 */
function StrategyPanel({ from, to }: { from: string; to: string }) {
  const [lang, setLangState] = useState<Lang>(() => getLang());
  useEffect(() => onLangChange(setLangState), []);
  const key = `pelham-ai-strategy:${from}|${to}|${lang}`;
  // 이번에 받은 결과. 없으면 이 브라우저에 둔 것.
  const [fresh, setFresh] = useState<Record<string, { strategy: Strategy; version: number }>>({});
  const stored = useMemo(() => storedStrategy(key), [key]);
  const strategy = fresh[key]?.strategy ?? stored;
  const version = fresh[key]?.version ?? 0;
  const [view, setView] = useState<"deck" | "text">("deck");
  const [focus, setFocus] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const ask = async () => {
    const askedKey = key;
    setBusy(true);
    setError("");
    try {
      const next = await askStrategy(from, to, lang, focus);
      setFresh((all) => ({ ...all, [askedKey]: { strategy: next, version: (all[askedKey]?.version ?? 0) + 1 } }));
      setView("deck");
      try {
        localStorage.setItem(askedKey, JSON.stringify(next));
      } catch {
        // 저장 못 해도 화면에는 보인다.
      }
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel
      actions={
        strategy ? (
          <div className="flex gap-1">
            <Chip active={view === "deck"} onClick={() => setView("deck")}>Presentation</Chip>
            <Chip active={view === "text"} onClick={() => setView("text")}>Full text</Chip>
          </div>
        ) : null
      }
      title="Claude's marketing strategy"
    >
      <div className="grid gap-3">
        <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
          <Field label="Anything to focus on? (optional)">
            <TextArea
              maxLength={500}
              onChange={(event) => setFocus(event.target.value)}
              placeholder="e.g. fill weekday afternoons, bring Hamilton golfers, sell next year's memberships"
              value={focus}
            />
          </Field>
          <Button disabled={busy} onClick={ask} tone="primary">
            {busy ? "Claude is writing… (1–2 min)" : strategy ? "Ask again" : "Ask Claude for a strategy"}
          </Button>
        </div>
        <p className="text-xs text-[#6b7280]">
          Sends this period&apos;s totals (no names, emails or phone numbers) and the trade area to Claude. Written in the
          language the page is set to (EN / 한), then shown as a narrated presentation.
        </p>
        {error ? <ErrorNote>{error}</ErrorNote> : null}
        {busy && !strategy ? <SkeletonRows count={5} /> : null}
        {!strategy && !busy && (fresh[otherKey(key)] || storedStrategy(otherKey(key))) ? (
          <EmptyNote>
            {lang === "ko"
              ? "No Korean version for this period yet. Press Ask Claude for a strategy to get one."
              : "No English version for this period yet. Press Ask Claude for a strategy to get one."}
          </EmptyNote>
        ) : null}
        {strategy && view === "deck" ? <StrategyDeck key={`${key}#${version}`} lang={lang} strategy={strategy} /> : null}
        {strategy && view === "text" ? <StrategyBody strategy={strategy} /> : null}
      </div>
    </Panel>
  );
}

function otherKey(key: string): string {
  return key.endsWith("|ko") ? `${key.slice(0, -3)}|en` : `${key.slice(0, -3)}|ko`;
}

type Scene = { label: string; title: string; say: string; body: ReactNode };

/** 결과 → 장면들. 나레이션이 없는 옛 결과는 글에서 대본을 만든다. */
function strategyScenes(strategy: Strategy): Scene[] {
  const plan = [...strategy.plan].sort((a, b) => Number(a.window) - Number(b.window));
  const facts = strategy.facts.map((fact) => fact.fact);
  const scenes: Scene[] = [
    {
      label: "Summary",
      title: strategy.headline,
      say: strategy.narration?.intro || [strategy.headline, ...facts.slice(0, 3)].join(" "),
      body: (
        <ul className="grid gap-2 text-sm">
          {strategy.facts.map((fact, index) => (
            <li className="grid grid-cols-[22px_minmax(0,1fr)] gap-2" key={index}>
              <span className="font-mono text-xs text-[#1a7f4b]">{index + 1}</span>
              <span>
                {fact.fact} <span className="text-xs text-[#6b7280]">— {fact.evidence}</span>
              </span>
            </li>
          ))}
        </ul>
      ),
    },
  ];
  strategy.strategies.forEach((item, index) => {
    scenes.push({
      label: `Strategy ${index + 1}`,
      title: item.title,
      say: item.narration || [item.title, item.why, item.offer].join(" "),
      body: (
        <div className="grid gap-3 text-sm md:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
          <div className="grid content-start gap-2">
            <p className="flex flex-wrap gap-1 text-xs">
              {[item.target_group, item.time_slot, item.area, BUDGET_LABEL[item.budget] ?? item.budget].map((tag, tagIndex) => (
                <span className="bg-[#eef0f2] px-1.5 py-0.5" key={tagIndex}>
                  {tag}
                </span>
              ))}
            </p>
            <p>{item.why}</p>
            <div className="border border-[#1a7f4b] bg-[#e8f4ec] p-2">
              <b>Offer:</b> {item.offer}
            </div>
            <p>
              <b>Channels:</b> {item.channels.join(" · ")}
            </p>
            <p className="text-[#1a7f4b]">
              <b>Measure:</b> {item.kpi}
            </p>
          </div>
          <ol className="grid list-decimal content-start gap-1 pl-5">
            {item.steps.map((step, stepIndex) => (
              <li key={stepIndex}>{step}</li>
            ))}
          </ol>
        </div>
      ),
    });
  });
  scenes.push({
    label: "Local niches",
    title: "Local niches — Niagara to the Hamilton boundary",
    say: strategy.narration?.niches || strategy.niche_markets.map((row) => `${row.area}: ${row.hook}`).join(" "),
    body: (
      <div className="overflow-x-auto">
        <table className="w-full min-w-[600px] text-sm">
          <thead>
            <tr className="text-left text-xs text-[#6b7280]">
              <th className="font-bold">Area</th>
              <th className="font-bold">People</th>
              <th className="font-bold">Drive</th>
              <th className="font-bold">Hook</th>
            </tr>
          </thead>
          <tbody>
            {strategy.niche_markets.map((row, index) => (
              <tr className="border-t border-[#eef0f2] align-top" key={index}>
                <td className="py-1 pr-2 font-semibold">{row.area}</td>
                <td className="py-1 pr-2 whitespace-nowrap">{row.population}</td>
                <td className="py-1 pr-2 whitespace-nowrap">{row.drive}</td>
                <td className="py-1">{row.hook}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    ),
  });
  scenes.push({
    label: "Rollout",
    title: "Rollout — next 30, 60 and 90 days",
    say: strategy.narration?.plan || plan.map((step) => step.actions[0] ?? "").join(" "),
    body: (
      <div className="grid gap-2 md:grid-cols-3">
        {plan.map((step) => (
          <div className="border border-[#d4d4d8] p-3 text-sm" key={step.window}>
            <h4 className="mb-1 font-bold">{`Next ${step.window} days`}</h4>
            <ul className="grid list-disc gap-1 pl-5">
              {step.actions.map((action, index) => (
                <li key={index}>{action}</li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    ),
  });
  if (strategy.cautions.length > 0 || strategy.narration?.close) {
    scenes.push({
      label: "Watch out",
      title: "Watch out",
      say: strategy.narration?.close || strategy.cautions.join(" "),
      body: (
        <ul className="grid list-disc gap-1 pl-5 text-sm text-[#7a6320]">
          {strategy.cautions.map((caution, index) => (
            <li key={index}>{caution}</li>
          ))}
        </ul>
      ),
    });
  }
  return scenes;
}

const SPEEDS = [0.85, 1, 1.2, 1.4];

/**
 * 전략 프레젠테이션 — 장면 칩, 무대, 어두운 나레이션 띠, 재생 막대. 나레이션 소리는 장면을 틀 때
 * Fly(`/ai-marketing/narrate`, ElevenLabs Hope)가 만든다. 다음 장면은 미리 받아 둔다.
 * 가 / Aa 는 화면 전체 언어(EN/한)를 바꾼다 — 그 언어로 받은 결과로 바뀐다.
 */
function StrategyDeck({ strategy, lang }: { strategy: Strategy; lang: Lang }) {
  const scenes = useMemo(() => strategyScenes(strategy), [strategy]);
  const audio = useRef<HTMLAudioElement | null>(null);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  // 소리가 실제로 나기 시작한 장면. playing 인데 index 와 다르면 아직 준비 중이다.
  const [sounding, setSounding] = useState(-1);
  const [progress, setProgress] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [error, setError] = useState("");
  const scene = scenes[Math.min(index, scenes.length - 1)];
  const preparing = playing && sounding !== index;

  useEffect(() => {
    const player = audio.current;
    if (!player) return;
    if (!playing) {
      player.pause();
      return;
    }
    let cancelled = false;
    narrationUrl(scene.say).then(
      (url) => {
        if (cancelled) return;
        player.src = url;
        player.playbackRate = speed;
        player.play().then(
          () => {
            if (!cancelled) setSounding(index);
          },
          () => {
            if (!cancelled) setPlaying(false);
          },
        );
      },
      (cause) => {
        if (cancelled) return;
        setError(describe(cause));
        setPlaying(false);
      },
    );
    const next = scenes[index + 1];
    if (next) narrationUrl(next.say).catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // speed 는 아래 effect 가 바꾼다 — 속도를 바꿨다고 장면을 처음부터 다시 틀지 않게.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, index, scene.say, scenes]);

  useEffect(() => {
    if (audio.current) audio.current.playbackRate = speed;
  }, [speed]);

  const go = (next: number) => {
    setIndex(Math.max(0, Math.min(scenes.length - 1, next)));
    setProgress(0);
  };
  const onEnded = () => {
    setProgress(1);
    if (index < scenes.length - 1) go(index + 1);
    else setPlaying(false);
  };

  return (
    <div className="grid min-w-0 gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1">
          {scenes.map((item, sceneIndex) => (
            <button
              aria-current={sceneIndex === index}
              className={`border px-2 py-1 text-xs font-semibold ${
                sceneIndex === index ? "border-[#1a7f4b] bg-[#e8f4ec]" : "border-[#d4d4d8] bg-white"
              }`}
              key={sceneIndex}
              onClick={() => go(sceneIndex)}
              type="button"
            >
              <span className="mr-1 font-mono text-[#6b7280]">{sceneIndex + 1}</span>
              {item.label}
            </button>
          ))}
        </div>
        <div aria-label="Language" className="inline-flex border border-[#d4d4d8]" role="group" translate="no">
          {(["ko", "en"] as const).map((code) => (
            <button
              aria-pressed={lang === code}
              className={`inline-flex min-h-9 items-center gap-1 px-2.5 text-xs font-bold ${
                lang === code ? "bg-[#1f2328] text-white" : "bg-white text-[#1f2328]"
              }`}
              key={code}
              onClick={() => setLang(code)}
              type="button"
            >
              <svg aria-hidden="true" className="size-5" viewBox="0 0 24 24">
                <path d="M3 4h18v12H9l-5 4v-4H3z" fill="none" stroke="currentColor" strokeWidth="1.6" />
                <text fill="currentColor" fontFamily="sans-serif" fontSize="8" fontWeight="700" textAnchor="middle" x="12" y="13.5">
                  {code === "ko" ? "가" : "Aa"}
                </text>
              </svg>
              {code === "ko" ? "한국어" : "English"}
            </button>
          ))}
        </div>
      </div>

      <section className="grid min-h-[260px] content-start gap-3 border border-[#d4d4d8] bg-white p-4">
        <p className="text-xs font-bold tracking-wide text-[#6b7280] uppercase">{`${index + 1} / ${scenes.length} · ${scene.label}`}</p>
        <h3 className="text-lg leading-snug font-bold [text-wrap:balance]">{scene.title}</h3>
        {scene.body}
      </section>

      <section aria-live="polite" className="grid gap-1 bg-[#14201a] px-4 py-3 text-[#e9f2ec]">
        <span className="text-[11px] tracking-wide text-[#9fb5a8] uppercase">Narration · Hope</span>
        <p className="text-[15px] leading-relaxed">{scene.say}</p>
      </section>

      <div className="flex flex-wrap items-center gap-2">
        <Button aria-label="Previous scene" disabled={index === 0} onClick={() => go(index - 1)}>
          ◀
        </Button>
        <Button
          className="min-w-[120px]"
          onClick={() => {
            setError("");
            setPlaying(!playing);
          }}
          tone="primary"
        >
          {preparing ? "Preparing voice…" : playing ? "❚❚ Pause" : "▶ Play"}
        </Button>
        <Button aria-label="Next scene" disabled={index === scenes.length - 1} onClick={() => go(index + 1)}>
          ▶
        </Button>
        <div aria-hidden="true" className="relative h-1.5 min-w-[120px] flex-1 bg-[#e5e7eb]">
          <span className="absolute inset-y-0 left-0 bg-[#1a7f4b]" style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
        <label className="flex items-center gap-1 text-xs text-[#6b7280]">
          Speed
          <select
            className="border border-[#d4d4d8] bg-white px-1 py-1 text-xs"
            onChange={(event) => setSpeed(Number(event.target.value))}
            value={speed}
          >
            {SPEEDS.map((value) => (
              <option key={value} value={value}>{`${value}×`}</option>
            ))}
          </select>
        </label>
      </div>
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      <audio
        onEnded={onEnded}
        onTimeUpdate={(event) => {
          const player = event.currentTarget;
          if (player.duration > 0) setProgress(player.currentTime / player.duration);
        }}
        preload="auto"
        ref={audio}
      />
      <p className="text-xs text-[#6b7280]">
        {strategy.period.from} → {strategy.period.to} · {strategy.model} · Narration by ElevenLabs (Hope). Population and drive
        times are approximate (2021 Census).
      </p>
    </div>
  );
}

function StrategyBody({ strategy }: { strategy: Strategy }) {
  const plan = [...strategy.plan].sort((a, b) => Number(a.window) - Number(b.window));
  return (
    <div className="grid min-w-0 gap-3">
      <p className="border-l-4 border-[#6d28d9] bg-[#f5f3ff] px-3 py-2 text-sm font-semibold">{strategy.headline}</p>

      <section className="grid gap-1">
        <h3 className="text-xs font-bold tracking-wide text-[#6b7280] uppercase">What the numbers say</h3>
        <ul className="grid gap-1 text-sm">
          {strategy.facts.map((fact, index) => (
            <li key={index}>
              {fact.fact} <span className="text-xs text-[#6b7280]">— {fact.evidence}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="grid gap-2">
        <h3 className="text-xs font-bold tracking-wide text-[#6b7280] uppercase">Strategies</h3>
        <div className="grid gap-2 lg:grid-cols-2">
          {strategy.strategies.map((item, index) => (
            <article className="grid content-start gap-1.5 border border-[#d4d4d8] p-3 text-sm" key={index}>
              <h4 className="font-bold">
                {index + 1}. {item.title}
              </h4>
              <p className="flex flex-wrap gap-1 text-xs">
                {[item.target_group, item.time_slot, item.area, BUDGET_LABEL[item.budget] ?? item.budget].map((tag, tagIndex) => (
                  <span className="bg-[#eef0f2] px-1.5 py-0.5" key={tagIndex}>
                    {tag}
                  </span>
                ))}
              </p>
              <p>{item.why}</p>
              <p>
                <b>Offer:</b> {item.offer}
              </p>
              <p>
                <b>Channels:</b> {item.channels.join(" · ")}
              </p>
              <ol className="list-decimal pl-5">
                {item.steps.map((step, stepIndex) => (
                  <li key={stepIndex}>{step}</li>
                ))}
              </ol>
              <p className="text-xs text-[#1a7f4b]">
                <b>Measure:</b> {item.kpi}
              </p>
            </article>
          ))}
        </div>
      </section>

      <section className="grid gap-1">
        <h3 className="text-xs font-bold tracking-wide text-[#6b7280] uppercase">Local niches — Niagara to the Hamilton boundary</h3>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="text-left text-xs text-[#6b7280]">
                <th className="font-bold">Area</th>
                <th className="font-bold">People</th>
                <th className="font-bold">Drive</th>
                <th className="font-bold">Why they&apos;d come</th>
                <th className="font-bold">Hook</th>
              </tr>
            </thead>
            <tbody>
              {strategy.niche_markets.map((row, index) => (
                <tr className="border-t border-[#eef0f2] align-top" key={index}>
                  <td className="py-1 pr-2 font-semibold">{row.area}</td>
                  <td className="py-1 pr-2 whitespace-nowrap">{row.population}</td>
                  <td className="py-1 pr-2 whitespace-nowrap">{row.drive}</td>
                  <td className="py-1 pr-2">{row.why}</td>
                  <td className="py-1">{row.hook}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="grid gap-1">
        <h3 className="text-xs font-bold tracking-wide text-[#6b7280] uppercase">Rollout</h3>
        <div className="grid gap-2 md:grid-cols-3">
          {plan.map((step) => (
            <div className="border border-[#d4d4d8] p-3 text-sm" key={step.window}>
              <h4 className="mb-1 font-bold">{`Next ${step.window} days`}</h4>
              <ul className="grid list-disc gap-1 pl-5">
                {step.actions.map((action, index) => (
                  <li key={index}>{action}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>

      {strategy.cautions.length > 0 ? (
        <section className="grid gap-1">
          <h3 className="text-xs font-bold tracking-wide text-[#6b7280] uppercase">Watch out</h3>
          <ul className="grid list-disc gap-1 pl-5 text-sm text-[#7a6320]">
            {strategy.cautions.map((caution, index) => (
              <li key={index}>{caution}</li>
            ))}
          </ul>
        </section>
      ) : null}
      <p className="text-xs text-[#6b7280]">
        {strategy.period.from} → {strategy.period.to} · {strategy.model} · Population and drive times are approximate (2021
        Census).
      </p>
    </div>
  );
}
