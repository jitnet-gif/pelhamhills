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
 *     Claude 는 문자(Twilio)·전화 비서(ElevenLabs) 숫자도 본다(0114 + Fly). 결과는 보관함(0113)에 저장된다.
 *   - "Strategy reports" 탭: 보관함(0113) — 지금까지의 전략 보고서 모두, 공유 링크. 주소 끝 #reports 로 바로 연다.
 *   - "Texts & website" 탭: 기획안 → 실행 타일(0115) — 전략마다 문자·AI 전화 캠페인과 웹사이트 팝업. #launch.
 *
 * 숫자는 모두 서버가 계산한다. 다음 단계(예상 매출, 마케팅 믹스 보드)는 이 화면에 붙는다.
 * 데모 숫자로 내려가지 않는다 — 서버가 안 되면 오류를 보여 준다(옛 Business Intelligence 화면이 고치려던 문제).
 */

import { useEffect, useMemo, useState } from "react";

import { Button, Chip, EmptyNote, ErrorNote, Field, Panel, SkeletonCards, SkeletonRows, StatCard, TextArea, TextInput } from "@/components/retail/ui";
import {
  aiMarketingApi,
  askStrategy,
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

import { StrategyBody, StrategyDeck } from "./StrategyDeck";
import { StrategyLaunch } from "./StrategyLaunch";
import { StrategyReports } from "./StrategyReports";

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
  const [tab, setTab] = useState<Tab>(() => {
    const hash = typeof window !== "undefined" ? window.location.hash.slice(1) : "";
    return hash === "reports" || hash === "launch" ? hash : "analysis";
  });
  // 실행 타일에서 처음 고를 보고서(전략 패널·보관함의 "Launch" 버튼이 정한다).
  const [launchReport, setLaunchReport] = useState<string | null>(null);
  const pickTab = (next: Tab) => {
    setTab(next);
    try {
      history.replaceState(null, "", next === "analysis" ? window.location.pathname : `#${next}`);
    } catch {
      // 주소를 못 바꿔도 탭은 바뀐다.
    }
  };
  const openLaunch = (reportId: string) => {
    setLaunchReport(reportId);
    pickTab("launch");
  };
  return (
    <div className="grid min-w-0 gap-0">
      <div className="flex gap-2 px-4 pt-4">
        <Chip active={tab === "analysis"} onClick={() => pickTab("analysis")}>Customer analysis</Chip>
        <Chip active={tab === "reports"} onClick={() => pickTab("reports")}>Strategy reports</Chip>
        <Chip active={tab === "launch"} onClick={() => pickTab("launch")}>Texts &amp; website</Chip>
      </div>
      {tab === "analysis" ? (
        <AnalysisTab onLaunch={openLaunch} />
      ) : tab === "launch" ? (
        <div className="grid min-w-0 gap-3 p-4">
          <p className="text-sm text-[#4e5560]">
            Turn a strategy into real campaigns: a text (Twilio), an AI phone call (ElevenLabs) and a website pop-up for each
            strategy, filled in from Claude&apos;s plan.
          </p>
          <StrategyLaunch initialReportId={launchReport} key={launchReport ?? "latest"} />
        </div>
      ) : (
        <div className="grid min-w-0 gap-3 p-4">
          <p className="text-sm text-[#4e5560]">
            Every strategy Claude has written, kept for good. Open one as a narrated presentation or as full text, or make
            a share link for someone outside the admin.
          </p>
          <StrategyReports onLaunch={openLaunch} />
        </div>
      )}
    </div>
  );
}

type Tab = "analysis" | "reports" | "launch";

function AnalysisTab({ onLaunch }: { onLaunch: (reportId: string) => void }) {
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
          <StrategyPanel from={request.from} key={requestKey} onLaunch={onLaunch} to={request.to} />
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
function StrategyPanel({ from, to, onLaunch }: { from: string; to: string; onLaunch: (reportId: string) => void }) {
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
          Sends this period&apos;s totals, text and phone assistant numbers (counts and short call topics, phone numbers and
          emails removed) and the trade area to Claude. Written in the language the page is set to (EN / 한), shown as a
          narrated presentation and kept in Strategy reports.
        </p>
        {error ? <ErrorNote>{error}</ErrorNote> : null}
        {fresh[key] ? (
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-xs text-[#1a7f4b]">
              {fresh[key].strategy.report_id
                ? "Saved to Strategy reports."
                : "Not saved to Strategy reports yet — 0113_ai_marketing_reports.sql has to be run first."}
            </p>
            {fresh[key].strategy.report_id ? (
              <Button onClick={() => onLaunch(fresh[key].strategy.report_id as string)} tone="primary">
                Launch texts &amp; pop-ups →
              </Button>
            ) : null}
          </div>
        ) : null}
        {busy && !strategy ? <SkeletonRows count={5} /> : null}
        {!strategy && !busy && (fresh[otherKey(key)] || storedStrategy(otherKey(key))) ? (
          <EmptyNote>
            {lang === "ko"
              ? "No Korean version for this period yet. Press Ask Claude for a strategy to get one."
              : "No English version for this period yet. Press Ask Claude for a strategy to get one."}
          </EmptyNote>
        ) : null}
        {strategy && view === "deck" ? (
          <StrategyDeck key={`${key}#${version}`} lang={lang} onLang={setLang} strategy={strategy} />
        ) : null}
        {strategy && view === "text" ? <StrategyBody strategy={strategy} /> : null}
      </div>
    </Panel>
  );
}

function otherKey(key: string): string {
  return key.endsWith("|ko") ? `${key.slice(0, -3)}|en` : `${key.slice(0, -3)}|ko`;
}

