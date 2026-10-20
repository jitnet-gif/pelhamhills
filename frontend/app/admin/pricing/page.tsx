"use client";

/**
 * Tee Times & Pricing — 티 타임 격자와 그린피가 **실제로** 어떻게 생성되는지 보는 화면.
 *
 * ## 왜 편집 화면이 아닌가
 *
 * 예전 버전은 요일마다 9홀/18홀/카트 요금을 입력받고 `Save` · `Publish Rates` ·
 * `Apply Defaults` 버튼이 달린 편집 화면이었다. 그 값들은 **전부 이 파일 안의 로컬
 * 상태**였고 어디에도 저장되지 않았다. 결과가 나빴던 이유는 버튼이 안 먹는다는 것보다,
 * 화면이 **거짓말을 했다**는 데 있다: 금요일 18홀 $64.00 이라고 적혀 있었지만 티 시트가
 * 실제로 청구하는 금액은 $47.79 였다. 프로 샵이 이 화면을 믿고 손님에게 요금을
 * 말하면 그대로 틀린다.
 *
 * 그래서 지금은 백엔드에서 **진짜 값을 읽어** 보여 주기만 한다. 상수를 이 쪽에
 * 옮겨 적지도 않는다 — 슬롯 조회가 다섯 가지를 전부 말해 준다:
 * 첫 티 / 마지막 티 / 간격 / 요금 / 티 타임당 카트 수.
 *
 * 2026-09-21: 이 화면만 `GET /tee-sheet/slots?date=` 로 Fly 의 FastAPI 를 직접 부르고
 * 있었다. 그 서버는 체험 종료로 꺼졌고 티 시트는 0004 로 Supabase 함수로 옮겨 갔는데
 * 여기만 남아, 화면 전체가 "Failed to fetch" 한 줄로 죽어 있었다. 이제 티 시트와
 * **같은** 클라이언트(`teeSheetApi`)를 쓴다 — 주소를 아는 곳은 `lib/teeSheet` 하나다.
 *
 * ## 편집을 붙이려면
 *
 * 간격이나 첫 티 시각을 바꿀 수 있게 만들면 안 된다. 기존 예약의 시각 라벨
 * (`6:58 AM`, `7:43 AM` …)은 6:40 부터 9분 격자 위에 찍혀 있고, 백엔드의
 * `require_slot()` 이 예약 생성·이동 때 그 라벨을 검사한다. 간격을 15분으로 바꾸는
 * 순간 기존 라벨이 전부 해석 불가가 되어 티 시트의 "no matching tee time" 스트립으로
 * 쏟아지고, 이동은 거부된다.
 *
 * 안전하게 열 수 있는 것은 `RATE_OVERRIDES` (backend/api/routes/tee_sheet.py) 하나다 —
 * 날짜별 요금 강제라서 시각 라벨을 하나도 건드리지 않는다. 공휴일·단체 행사 요금은
 * 그쪽으로 붙이면 된다.
 */

import { useEffect, useMemo, useState } from "react";

import AdminShell from "@/components/admin/AdminShell";
import DayTabs from "@/components/admin/DayTabs";
import { teeSheetApi } from "@/lib/teeSheet/api";
import { RATE_CARDS, RATE_PLAN_RULES } from "@/lib/rateCard";
import { addDays, longDate, minutesToTime, money, toDate, todayIso } from "@/lib/teeSheet/dates";
import type { TeeSlot } from "@/lib/teeSheet/types";

/**
 * 한 티 타임의 플레이어 자리 수. 백엔드 `PLAYERS_PER_TEE_TIME` 과 같은 값이고,
 * 슬롯 응답에는 담겨 오지 않아 여기서 한 번 적는다 (WeekGrid 의 `DAY_SEATS` 와 동일).
 */
const PLAYERS_PER_TEE_TIME = 4;

type Loaded = { slots: TeeSlot[]; weekdayRate: number | null; weekendRate: number | null };
/** 로딩은 상태로 들고 있지 않고 렌더에서 파생한다 (아래 `useSlotConfig` 주석 참고). */
/**
 * `no-api` 분기가 있었다. 주소가 설정되지 않은 배포를 위한 것이었는데, 이제 슬롯을
 * `teeSheetApi` 로 읽으므로 주소가 없는 상태 자체가 없다 — 로그인이 없으면 401,
 * 서버에 못 닿으면 0 으로 `error` 에 실려 온다.
 */
type Settled = { kind: "error"; detail: string } | { kind: "ready"; data: Loaded };
type State = { kind: "loading" } | Settled;

/** 안정적인 빈 배열. 매 렌더 새 `[]` 를 만들면 아래 useMemo 가 헛돈다. */
const NO_SLOTS: TeeSlot[] = [];

async function fetchSlots(iso: string): Promise<TeeSlot[]> {
  const body = await teeSheetApi.getSlots(iso);
  return body.slots ?? [];
}

function isWeekendIso(iso: string): boolean {
  const day = toDate(iso).getDay();
  return day === 0 || day === 6;
}

async function loadConfig(
  focusedDate: string,
  weekdayProbe: string | null,
  weekendProbe: string | null,
): Promise<Settled> {
  const [slots, weekday, weekend] = await Promise.all([
    fetchSlots(focusedDate),
    weekdayProbe ? fetchSlots(weekdayProbe) : Promise.resolve(NO_SLOTS),
    weekendProbe ? fetchSlots(weekendProbe) : Promise.resolve(NO_SLOTS),
  ]);
  return {
    kind: "ready",
    data: { slots, weekdayRate: weekday[0]?.rate ?? null, weekendRate: weekend[0]?.rate ?? null },
  };
}

/**
 * 고른 날짜의 슬롯과, 기준 요금 두 가지(평일 · 주말)를 함께 읽는다.
 *
 * 기준 요금을 상수로 적지 않고 **조회하는** 이유: 백엔드의 `WEEKDAY_RATE` /
 * `WEEKEND_RATE` 가 바뀌었을 때 이 화면만 옛날 숫자를 붙들고 있으면, 고치기 전과
 * 똑같이 거짓말하는 화면이 된다.
 *
 * 조회 날짜는 고른 날 앞뒤 3일(= 연속 7일) 안에서 찾는다 — 어느 7일 창이든 평일과
 * 주말이 반드시 하나씩은 들어 있다. 탭이 보여 주는 배열을 넘겨받지 않는 이유:
 * 그러면 이 화면이 `DayTabs` 의 앵커 규칙(오늘 기준이냐 고른 날 기준이냐)에 묶여
 * 버린다. 요금 조회에 필요한 것은 "평일 하나, 주말 하나" 뿐이고 그건 탭과 무관하다.
 *
 * 결과에 **어느 날짜의 것인지**를 함께 담고 "로딩" 은 렌더에서 파생한다. 두 가지를
 * 동시에 얻는다: (a) effect 본문에서 동기 setState 를 하지 않게 되고, (b) 날짜를 바꾼
 * 순간 이전 날짜의 요금이 새 날짜 제목 아래 잠깐 남아 있는 일이 없다.
 */
function useSlotConfig(focusedDate: string): State {
  const [settled, setSettled] = useState<{ date: string; value: Settled } | null>(null);

  const probeWindow = useMemo(
    () => Array.from({ length: 7 }, (_, index) => addDays(focusedDate, index - 3)),
    [focusedDate],
  );
  const weekdayProbe = useMemo(() => probeWindow.find((iso) => !isWeekendIso(iso)) ?? null, [probeWindow]);
  const weekendProbe = useMemo(() => probeWindow.find((iso) => isWeekendIso(iso)) ?? null, [probeWindow]);

  useEffect(() => {
    const abort = new AbortController();
    // setState 는 오직 then/catch 안에서만 — effect 본문에서 동기로 부르지 않는다.
    // 요청 자체를 끊지는 않는다 — RPC 클라이언트는 signal 을 받지 않는다. 대신 응답이
    // 늦게 와도 아래 `aborted` 가드가 지난 날짜의 값을 화면에 얹는 것을 막는다.
    loadConfig(focusedDate, weekdayProbe, weekendProbe)
      .then((value) => {
        if (!abort.signal.aborted) setSettled({ date: focusedDate, value });
      })
      .catch((error: unknown) => {
        if (abort.signal.aborted) return;
        setSettled({
          date: focusedDate,
          value: { kind: "error", detail: error instanceof Error ? error.message : "network error" },
        });
      });
    return () => abort.abort();
  }, [focusedDate, weekdayProbe, weekendProbe]);

  return settled?.date === focusedDate ? settled.value : { kind: "loading" };
}

// ===== 작은 조각들 =====

const ICON = "h-3.5 w-3.5 shrink-0";

function ClockIcon() {
  return (
    <svg aria-hidden="true" className={ICON} fill="none" stroke="currentColor" strokeWidth="1.6" viewBox="0 0 16 16">
      <circle cx="8" cy="8" r="5.6" />
      <path d="M8 5v3.2l2 1.4" />
    </svg>
  );
}

function PeopleIcon() {
  return (
    <svg aria-hidden="true" className={ICON} fill="none" stroke="currentColor" strokeWidth="1.6" viewBox="0 0 16 16">
      <circle cx="6" cy="5.5" r="2.5" />
      <path d="M1.6 13.4c0-2.4 2-4 4.4-4s4.4 1.6 4.4 4M11 3.4a2.3 2.3 0 0 1 0 4.4M12.2 9.8c1.4.5 2.3 1.8 2.3 3.6" />
    </svg>
  );
}

function CartIcon() {
  return (
    <svg aria-hidden="true" className={ICON} fill="none" stroke="currentColor" strokeWidth="1.6" viewBox="0 0 16 16">
      <path d="M2 4.5h6.5v5H2zM8.5 6.5H12l2 3v0h-5.5z" />
      <circle cx="4.5" cy="12" r="1.4" />
      <circle cx="11.5" cy="12" r="1.4" />
    </svg>
  );
}

/** 두 값짜리 정의 줄. 카드 안에서 "이름 …… 값" 으로 읽힌다. */
function Row({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-[#ececf0] px-3 py-1.5 last:border-b-0">
      <span className="text-[#5c6270]">{label}</span>
      <span className={`font-bold tabular-nums ${muted ? "text-[#9aa0a6]" : ""}`}>{value}</span>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border border-[#d6d6dc] bg-white text-xs">
      <h2 className="border-b border-[#d6d6dc] bg-[#ececf0] px-3 py-1.5 text-[11px] font-bold">{title}</h2>
      {children}
    </section>
  );
}

export default function PricingPage() {
  // 이 화면은 자기 날짜 상태를 갖는다 — 티 시트 컨트롤러(`useTeeSheet`)를 끌어오지
  // 않는다. 요금을 보는 데 예약 목록과 폴링이 전부 따라올 이유가 없다.
  const [focusedDate, setFocusedDate] = useState(todayIso);
  const state = useSlotConfig(focusedDate);

  const data = state.kind === "ready" ? state.data : null;
  const slots = data?.slots ?? NO_SLOTS;
  const rate = slots[0]?.rate ?? null;
  const intervalMinutes =
    slots.length >= 2 && Number.isFinite(slots[0].minutes) && Number.isFinite(slots[1].minutes)
      ? slots[1].minutes - slots[0].minutes
      : null;
  const cartsPerSlot = slots[0]?.cartsTotal ?? null;
  const capacity = slots.length * PLAYERS_PER_TEE_TIME;
  const potential = rate === null ? null : capacity * rate;

  // 미리보기 목록에 시(hour) 밴드를 섞는다 — 티 시트 격자와 같은 모양이라야
  // "이 화면이 저 화면을 만든다" 가 눈에 보인다.
  const lines = useMemo(() => {
    const out: Array<{ kind: "band"; label: string } | { kind: "slot"; slot: TeeSlot }> = [];
    let prevHour: number | null = null;
    for (const slot of slots) {
      const hour = Number.isFinite(slot.minutes) ? Math.floor(slot.minutes / 60) : null;
      if (hour !== null && hour !== prevHour) {
        out.push({ kind: "band", label: minutesToTime(hour * 60) });
        prevHour = hour;
      }
      out.push({ kind: "slot", slot });
    }
    return out;
  }, [slots]);

  return (
    <AdminShell title="Tee Times & Pricing">
      {/* 상태 스트립 — 티 시트와 같은 3열 그리드. 가운데 큰 숫자가 이 화면의 주인공
          (티 간격)이고, 좌우가 같은 `1fr` 이라 화면 기준으로 정확히 가운데에 온다. */}
      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 border-b border-[#d4d4d8] bg-white px-4 py-1.5 text-xs text-[#4e5560]">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <span className="flex shrink-0 items-center gap-1.5 font-semibold text-[#111315]" title="Tee times generated for this day">
            <ClockIcon />
            {slots.length}
          </span>
          <span
            className="flex shrink-0 items-center gap-1.5 font-semibold text-[#111315]"
            title={`Player capacity — ${PLAYERS_PER_TEE_TIME} seats per tee time`}
          >
            <PeopleIcon />
            {capacity}
          </span>
          <span className="flex shrink-0 items-center gap-1.5 font-semibold text-[#111315]" title="Carts available per tee time">
            <CartIcon />
            {cartsPerSlot ?? "—"}
          </span>
          {potential !== null ? (
            <span className="shrink-0" title="Green fee at full occupancy for this day">
              {money(potential)} potential
            </span>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-2 text-[#111315]">
          <span className="text-2xl leading-none font-semibold">{intervalMinutes ?? "—"}</span>
          <span className="text-[11px] leading-tight font-semibold">
            Minute
            <br />
            Tee Interval
          </span>
        </div>

        <span />
      </div>

      <DayTabs onChange={setFocusedDate} value={focusedDate} />

      <div className="grid gap-3 p-3">
        {/* 이 화면이 무엇인지 한 줄로 말한다. 없으면 "왜 아무것도 못 고치지?" 가 된다. */}
        <p className="border border-[#c9d8e8] bg-[#dde7f2] px-3 py-2 text-[11px] leading-5 text-[#2b3a4a]">
          These values come from the booking server and are shown read-only. Changing the tee interval or the first tee
          time would strand every existing reservation — their time labels (<code>6:58 AM</code>, <code>7:43 AM</code>…)
          sit on this exact grid. Per-date rate overrides are the safe place to add editing.
        </p>

        {state.kind === "error" ? (
          <p className="border border-[#e7c3b6] bg-[#fbe9e2] px-3 py-2 text-xs text-[#8a3f26]">
            Could not read tee times for {longDate(focusedDate)} — {state.detail}.
          </p>
        ) : null}

        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <Card title="Tee time generation">
            <Row label="First tee" value={slots[0]?.time ?? "—"} />
            <Row label="Last tee" value={slots[slots.length - 1]?.time ?? "—"} />
            <Row label="Interval" value={intervalMinutes === null ? "—" : `${intervalMinutes} minutes`} />
            <Row label="Tee times per day" value={slots.length ? String(slots.length) : "—"} />
            <Row label="Player seats per tee time" value={String(PLAYERS_PER_TEE_TIME)} />
            <Row label="Carts per tee time" value={cartsPerSlot === null ? "—" : String(cartsPerSlot)} />
          </Card>

          <Card title="Green fee">
            <Row label={longDate(focusedDate)} value={rate === null ? "—" : money(rate)} />
            <Row
              label="Weekday base"
              value={data?.weekdayRate == null ? "—" : money(data.weekdayRate)}
              muted={isWeekendIso(focusedDate)}
            />
            <Row
              label="Weekend base"
              value={data?.weekendRate == null ? "—" : money(data.weekendRate)}
              muted={!isWeekendIso(focusedDate)}
            />
            <Row label="Rate card" value={slots[0]?.rateCard ?? "—"} />
            <Row
              label="9-hole rate"
              value={
                slots[0]?.rate9 == null
                  ? "—"
                  : (slots[0].nineFrom ?? 0) >= 24 * 60
                    ? "no 9 holes"
                    : `${money(slots[0].rate9)} from ${minutesToTime(slots[0].nineFrom ?? 0)}`
              }
            />
            <Row label="Cart fee" value="$19.47 (18) · $11.50 (9) per player" />
          </Card>
        </div>

        {/* 미리보기 — 티 시트 격자와 같은 모양(헤더 줄 없음, 옅은 파란 시 밴드,
            굵은 시각 + 회색 요금). 이 화면이 만드는 것이 저 화면이라는 점이 보여야 한다. */}
        <section className="border border-[#d6d6dc] bg-white">
          <h2 className="border-b border-[#d6d6dc] bg-[#ececf0] px-3 py-1.5 text-[11px] font-bold">
            Generated tee times — {longDate(focusedDate)}
          </h2>
          <div className="max-h-[420px] overflow-y-auto">
            {state.kind === "loading" ? (
              <p className="px-3 py-6 text-center text-xs text-[#6b7280]">Loading tee times…</p>
            ) : lines.length === 0 ? (
              <p className="px-3 py-6 text-center text-xs text-[#6b7280]">No tee times for this day.</p>
            ) : (
              lines.map((line) =>
                line.kind === "band" ? (
                  <div
                    className="border-y border-[#c9d8e8] bg-[#dde7f2] px-3 py-0.5 text-[11px] font-semibold text-[#4e5560]"
                    key={`band-${line.label}`}
                  >
                    {line.label}
                  </div>
                ) : (
                  <div
                    className="grid grid-cols-[96px_88px_1fr] items-center border-b border-[#ececf0] px-3 py-1 text-xs last:border-b-0"
                    key={`slot-${line.slot.time}`}
                  >
                    <span className="font-bold">{line.slot.time}</span>
                    <span className="text-[#9aa0a6] tabular-nums">{money(line.slot.rate)}</span>
                    <span className="text-[#9aa0a6]">
                      {line.slot.cartsTotal} carts · {PLAYERS_PER_TEE_TIME} seats
                    </span>
                  </div>
                ),
              )
            )}
          </div>
        </section>

        <RateCardTables />
      </div>
    </AdminShell>
  );
}

/** 2026 요금표 전체와 요금제 규칙 — DB(0045)가 매기는 값의 사본(`lib/rateCard.ts`). */
function RateCardTables() {
  return (
    <>
      <section className="border border-[#d6d6dc] bg-white text-xs">
        <h2 className="border-b border-[#d6d6dc] bg-[#ececf0] px-3 py-1.5 text-[11px] font-bold">
          2026 rate cards — public green fee per player, before HST
        </h2>
        <div className="grid gap-px bg-[#ececf0] sm:grid-cols-2 xl:grid-cols-4">
          {RATE_CARDS.map((card) => (
            <div className="bg-white p-3" key={card.code}>
              <p className="font-bold text-[#111315]">{card.name}</p>
              <p className="mb-2 text-[11px] text-[#6b7280]">{card.applies}</p>
              {card.bands.map((band) => (
                <div className="flex justify-between py-0.5" key={band.from}>
                  <span>18 holes · {band.from === "Open" ? "open" : `from ${band.from}`}</span>
                  <span className="font-semibold tabular-nums">{money(band.rate)}</span>
                </div>
              ))}
              <div className="flex justify-between border-t border-[#ececf0] py-0.5 text-[#4e5560]">
                <span>9 holes{card.nine ? ` · from ${card.nine.from}` : ""}</span>
                <span className="tabular-nums">{card.nine ? money(card.nine.rate) : "—"}</span>
              </div>
            </div>
          ))}
        </div>
        <p className="border-t border-[#d6d6dc] px-3 py-2 text-[11px] text-[#4e5560]">
          A holiday with its own rate in <code>pelham_tee_holidays.rate</code> charges that rate all day for 18 holes.
        </p>
      </section>

      <section className="border border-[#d6d6dc] bg-white text-xs">
        <h2 className="border-b border-[#d6d6dc] bg-[#ececf0] px-3 py-1.5 text-[11px] font-bold">
          Rate plans — set on each player in the tee sheet
        </h2>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-left">
            <thead className="text-[11px] text-[#6b7280]">
              <tr>
                <th className="px-3 py-1.5 font-semibold">Rate plan</th>
                <th className="px-3 py-1.5 font-semibold">Green fee</th>
                <th className="px-3 py-1.5 font-semibold">Cart</th>
              </tr>
            </thead>
            <tbody>
              {RATE_PLAN_RULES.map((rule) => (
                <tr className="border-t border-[#ececf0]" key={rule.plan}>
                  <td className="px-3 py-1.5 font-semibold">{rule.plan}</td>
                  <td className="px-3 py-1.5">{rule.greenFee}</td>
                  <td className="px-3 py-1.5">{rule.cart}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
