"use client";

// 티시트 상태 스트립 + 요일 탭 + 토스트 스택.
// 이 파일은 토스트를 렌더링하는 유일한 곳이다 (다른 컴포넌트가 여기에 의존한다).
//
// 레이아웃은 pelhamhills 관리자 티시트를 그대로 따른다:
//   (a) 얇은 상태 스트립 — 왼쪽 기온/일출·일몰/카운터, **가운데** 큰 날짜, 오른쪽 노트 글리프
//   (b) 요일 탭 스트립  — 오늘부터 7일, 폭을 꽉 채운 파란 띠
//
// 화면 제목("Tee Sheet")과 Add 버튼은 여기 있었지만 `AdminShell` 의 상단바로 옮겼다.
// 레퍼런스 화면에는 상단바가 하나뿐인데 우리는 두 줄이었다 — 클럽 이름 줄과
// 티시트 자체 헤더 줄이 겹쳐서 세로로 40px 을 헛되이 먹고 있었다.

import { useEffect, useMemo, useRef, useState } from "react";

import DayTabs from "@/components/admin/DayTabs";
import { useSlotLocks } from "@/hooks/useSlotLocks";
import { dayNumber, longDate, minutesToTime, toDate, todayIso } from "@/lib/teeSheet/dates";
import { CLUB_LAT, CLUB_LON, CLUB_TZ, gridMinutes, sunMinutes, teeWindow } from "@/lib/teeSheet/sun";
import type { TeeSheetController, Toast } from "@/lib/teeSheet/types";

export type DateNavProps = { controller: TeeSheetController };

const WEEKDAY_FULL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * 큰 날짜 블록의 아랫줄. dates.ts 의 `headerCaption` 은 "Tuesday · Sep 2026" 한 줄이라
 * 레퍼런스의 2행 배치(요일 / 월·연도)에 그대로 쓸 수 없다.
 */
function monthYear(iso: string): string {
  const date = toDate(iso);
  return `${MONTH_SHORT[date.getMonth()]} ${date.getFullYear()}`;
}

// ===== 일출 / 일몰 =====
// 계산은 `lib/teeSheet/sun.ts` — 시트의 자물쇠 칸·DB 트리거(0048)와 같은 값이어야 한다.

function clockOrDash(minutes: number): string {
  return Number.isFinite(minutes) ? minutesToTime(minutes) : "—";
}

// ===== 기온 · 시간별 예보 =====
//
// 예전에는 이 자리를 비워 뒀다 — "실제 피드가 없으니 가짜 숫자를 띄우지 않는다".
// 그 원칙은 그대로 두고, 대신 **진짜 값**을 가져온다. Open-Meteo 는 키가 필요 없는
// 공개 API 라서 정적 export 인 이 앱에서도 브라우저에서 바로 부를 수 있다.
//
// 기온·일출·일몰 묶음을 누르면 레퍼런스(Chronogolf)처럼 그날의 시간별 예보
// (시각 / 하늘 / 강수 확률 / 바람 / 기온) 가 펼쳐진다. 예보는 **보고 있는 날짜**
// 기준이고, 스트립의 기온은 언제나 "지금" 이다.
//
// 실패하면 아무것도 그리지 않는다. 프로 샵 화면이 날씨 API 때문에
// 깨지거나 "—" 같은 잔해를 남기면 안 된다. Open-Meteo 예보는 16일까지라 그보다
// 먼 날짜는 표 대신 한 줄 안내가 나온다.
const WEATHER_BASE =
  `https://api.open-meteo.com/v1/forecast?latitude=${CLUB_LAT}&longitude=${CLUB_LON}` +
  `&timezone=${encodeURIComponent(CLUB_TZ)}`;

type Sky = "clear" | "partly" | "cloudy" | "fog" | "drizzle" | "rain" | "snow" | "storm";

type HourForecast = {
  hour: number;
  sky: Sky;
  night: boolean;
  precipPct: number | null;
  windKmh: number | null;
  celsius: number | null;
};

/** WMO weather interpretation code → 아이콘 하나. 세분류는 표에서 읽을 수 없으니 8개로 접는다. */
function skyFromWmo(code: number): Sky {
  if (code <= 1) return "clear";
  if (code === 2) return "partly";
  if (code === 3) return "cloudy";
  if (code === 45 || code === 48) return "fog";
  if (code >= 51 && code <= 57) return "drizzle";
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return "rain";
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "snow";
  if (code >= 95) return "storm";
  return "cloudy";
}

const SKY_LABEL: Record<Sky, string> = {
  clear: "Clear",
  partly: "Partly cloudy",
  cloudy: "Cloudy",
  fog: "Fog",
  drizzle: "Drizzle",
  rain: "Rain",
  snow: "Snow",
  storm: "Thunderstorm",
};

function finiteOrNull(value: unknown, round = true): number | null {
  return typeof value === "number" && Number.isFinite(value) ? (round ? Math.round(value) : value) : null;
}

function useClubNow(): { celsius: number; sky: Sky; night: boolean } | null {
  const [now, setNow] = useState<{ celsius: number; sky: Sky; night: boolean } | null>(null);

  useEffect(() => {
    // 마운트 후에만 부른다 — 서버 렌더 HTML 에 기온이 박히면 정적 export 된 페이지가
    // 빌드 시점의 날씨를 보여 주고, 하이드레이션도 어긋난다.
    const abort = new AbortController();
    fetch(`${WEATHER_BASE}&current=temperature_2m,weather_code,is_day`, { signal: abort.signal })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        const celsius = finiteOrNull(data?.current?.temperature_2m);
        const code = finiteOrNull(data?.current?.weather_code);
        if (celsius === null) return;
        setNow({ celsius, sky: code === null ? "clear" : skyFromWmo(code), night: data?.current?.is_day === 0 });
      })
      .catch(() => {
        // 오프라인 · 차단 · rate limit — 전부 "기온을 안 그린다" 로 수렴한다.
      });
    return () => abort.abort();
  }, []);

  return now;
}

/**
 * 보고 있는 날짜의 시간별 예보. 펼칠 때만 부르고(`enabled`), 날짜별로 한 번만 받는다.
 * `undefined` = 아직 모름(불러오는 중), `null` = 이 날짜는 예보가 없다(범위 밖 · 실패).
 */
function useHourlyForecast(iso: string, enabled: boolean): HourForecast[] | null | undefined {
  const [cache, setCache] = useState<Record<string, HourForecast[] | null>>({});
  const known = iso in cache;

  useEffect(() => {
    if (!enabled || known) return;
    const abort = new AbortController();
    const fields = "temperature_2m,precipitation_probability,wind_speed_10m,weather_code,is_day";
    fetch(`${WEATHER_BASE}&hourly=${fields}&start_date=${iso}&end_date=${iso}`, { signal: abort.signal })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        const hourly = data?.hourly;
        const times: unknown = hourly?.time;
        if (!Array.isArray(times) || times.length === 0) {
          setCache((prev) => ({ ...prev, [iso]: null }));
          return;
        }
        const rows = times.map((time: string, i: number): HourForecast => {
          const code = finiteOrNull(hourly.weather_code?.[i]);
          return {
            hour: Number(String(time).slice(11, 13)),
            sky: code === null ? "cloudy" : skyFromWmo(code),
            night: hourly.is_day?.[i] === 0,
            precipPct: finiteOrNull(hourly.precipitation_probability?.[i]),
            windKmh: finiteOrNull(hourly.wind_speed_10m?.[i]),
            celsius: finiteOrNull(hourly.temperature_2m?.[i]),
          };
        });
        setCache((prev) => ({ ...prev, [iso]: rows }));
      })
      .catch((error: unknown) => {
        // 날짜를 빨리 넘기면 abort 가 난다 — 그건 "예보 없음" 이 아니다.
        if ((error as { name?: string })?.name === "AbortError") return;
        setCache((prev) => ({ ...prev, [iso]: null }));
      });
    return () => abort.abort();
  }, [iso, enabled, known]);

  return known ? cache[iso] : undefined;
}

const TOAST_STYLE: Record<Toast["kind"], string> = {
  info: "border-[#d4d4d8] bg-white text-[#1f2328]",
  success: "border-[#bde5ca] bg-[#dbf5e3] text-[#126c31]",
  error: "border-[#e7c3b6] bg-[#fbe9e2] text-[#8a3f26]",
};

// 상태 스트립 글리프 — 순수 장식이라 aria-hidden, 의미는 감싸는 요소의 title이 전달한다.
const ICON = "h-3.5 w-3.5 shrink-0";

/** 하늘 상태 글리프. 해/달은 `night` 로 바꾸고, 구름 위에 비·눈·번개를 얹는다. */
function SkyIcon({ sky, night, className = ICON }: { sky: Sky; night: boolean; className?: string }) {
  const cloud = <path d="M4.6 11.2a2.6 2.6 0 0 1-.2-5.2 3.4 3.4 0 0 1 6.5-.6 2.4 2.4 0 0 1 .7 4.7z" />;
  const body = night ? (
    <path d="M10.8 2.6a4.6 4.6 0 1 0 2.6 6.9A3.8 3.8 0 0 1 10.8 2.6z" />
  ) : (
    <>
      <circle cx="8" cy="8" r="2.8" />
      <path d="M8 1.6v1.4M8 13v1.4M1.6 8h1.4M13 8h1.4M3.5 3.5l1 1M11.5 11.5l1 1M3.5 12.5l1-1M11.5 4.5l1-1" />
    </>
  );
  return (
    <svg aria-hidden="true" className={className} fill="none" stroke="currentColor" strokeWidth="1.3" viewBox="0 0 16 16">
      {sky === "clear" ? body : null}
      {sky === "partly" ? (
        <>
          <path d="M5.2 5.4a2.6 2.6 0 0 1 4.6-1.6M5.2 2.2v.8M2.6 4.6h.8M3.2 2.8l.6.6" />
          <path d="M5.4 13a2.2 2.2 0 0 1-.1-4.4 2.9 2.9 0 0 1 5.5-.5 2 2 0 0 1 .6 4.9z" />
        </>
      ) : null}
      {sky === "cloudy" ? cloud : null}
      {sky === "fog" ? <path d="M2.5 5.5h11M1.5 8h13M2.5 10.5h11M4 13h8" /> : null}
      {sky === "drizzle" || sky === "rain" || sky === "snow" || sky === "storm" ? cloud : null}
      {sky === "drizzle" ? <path d="M6 13.2v.6M9.5 13.2v.6" /> : null}
      {sky === "rain" ? <path d="M5.5 12.6 5 14.4M8.2 12.6l-.5 1.8M10.9 12.6l-.5 1.8" /> : null}
      {sky === "snow" ? <path d="M5.5 13.4h.01M8 14.2h.01M10.5 13.4h.01" strokeLinecap="round" strokeWidth="1.8" /> : null}
      {sky === "storm" ? <path d="M8.6 11.6 7.2 13.6h1.6l-1 1.8" /> : null}
    </svg>
  );
}

function SunIcon({ up }: { up: boolean }) {
  return (
    <svg aria-hidden="true" className={ICON} fill="none" stroke="currentColor" strokeWidth="1.6" viewBox="0 0 16 16">
      <circle cx="8" cy="9.5" r="2.6" />
      <path d="M1 13.5h14" />
      {up ? <path d="M8 1.5v2.4M4 3l1.2 1.6M12 3l-1.2 1.6" /> : <path d="M8 4.5v-2.4M6.2 3.6 8 5.4l1.8-1.8" />}
    </svg>
  );
}

function CircleIcon() {
  return (
    <svg aria-hidden="true" className={ICON} fill="none" stroke="currentColor" strokeWidth="1.6" viewBox="0 0 16 16">
      <circle cx="8" cy="8" r="5.5" />
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

function NoteIcon() {
  return (
    <svg aria-hidden="true" className={ICON} fill="none" stroke="currentColor" strokeWidth="1.6" viewBox="0 0 16 16">
      <path d="M3.5 1.8h9v12.4h-9zM5.8 5h4.4M5.8 8h4.4M5.8 11h2.6" />
    </svg>
  );
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/**
 * 시간별 예보 표. 레퍼런스처럼 00시부터 23시까지 한 열이고, 높이를 제한해 스크롤한다.
 * 오늘이면 지금 시각 줄을 강조하고 그 줄이 보이게 처음 위치를 잡는다 — 오후에 펼쳤는데
 * 새벽 날씨부터 보이면 매번 스크롤해야 한다.
 */
function HourlyForecastPanel({ iso, rows }: { iso: string; rows: HourForecast[] | null | undefined }) {
  const isToday = iso === todayIso();
  const nowHour = new Date().getHours();
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isToday || !rows || !listRef.current) return;
    const row = listRef.current.querySelector<HTMLElement>(`[data-hour="${nowHour}"]`);
    if (row) listRef.current.scrollTop = Math.max(0, row.offsetTop - 28);
  }, [isToday, nowHour, rows]);

  return (
    <div className="absolute left-0 top-full z-40 mt-1 w-[19rem] border border-[#d4d4d8] bg-white text-[#1f2328] shadow-lg">
      <div className="grid grid-cols-[2.5rem_3rem_1fr_1fr_3rem] border-b border-[#e4e4e7] px-3 py-1.5 text-[10px] font-semibold tracking-wide text-[#4e5560]">
        <span>TIME</span>
        <span className="text-center">COND</span>
        <span className="text-center">PRECIP</span>
        <span className="text-center">WIND</span>
        <span className="text-right">TEMP</span>
      </div>
      {rows === undefined ? (
        <p className="px-3 py-4 text-center text-[#4e5560]">Loading forecast…</p>
      ) : rows === null ? (
        <p className="px-3 py-4 text-center text-[#4e5560]">No forecast available for this date.</p>
      ) : (
        <div className="relative max-h-64 overflow-y-auto" ref={listRef}>
          {rows.map((row) => (
            <div
              className={`grid grid-cols-[2.5rem_3rem_1fr_1fr_3rem] items-center border-b border-[#f0f0f2] px-3 py-1.5 ${
                isToday && row.hour === nowHour ? "bg-[#eef4ff]" : ""
              }`}
              data-hour={row.hour}
              key={row.hour}
            >
              <span>{pad2(row.hour)}</span>
              <span className="flex justify-center text-[#4e5560]" title={SKY_LABEL[row.sky]}>
                <SkyIcon className="h-4 w-4" night={row.night} sky={row.sky} />
              </span>
              <span className="text-center">{row.precipPct === null ? "—" : `${row.precipPct}%`}</span>
              <span className="text-center">{row.windKmh === null ? "—" : `${row.windKmh} km/h`}</span>
              <span className="text-right text-sm font-semibold">{row.celsius === null ? "—" : `${row.celsius}°`}</span>
            </div>
          ))}
        </div>
      )}
      <p className="px-3 py-1 text-right text-[9px] text-[#8a9099]">Forecast: Open-Meteo</p>
    </div>
  );
}

// ===== 첫 티 · 마지막 티 (0131) =====
// 그날 언제부터 언제까지 티타임을 여나. 정하지 않으면 일출 ~ 일몰 2시간 전. 그 밖의 칸은 시트에서 🔒 로
// 잠기고 웹·전화 손님에게도 닫힌다. 칸 하나씩은 여전히 자물쇠로 블록·릴리스한다(0051).

function TeeHoursButton({ controller }: DateNavProps) {
  const { focusedDate, pushToast } = controller;
  const { locks, setHours } = useSlotLocks([focusedDate]);
  const win = teeWindow(focusedDate, locks);
  const auto = teeWindow(focusedDate);
  const set = locks.hours.get(focusedDate);
  const custom = set != null && (set.first != null || set.last != null);

  const [open, setOpen] = useState(false);
  const [first, setFirst] = useState(0);
  const [last, setLast] = useState(0);
  const [saving, setSaving] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // 고를 수 있는 시각 = 그날 격자. 자동 첫 티(일출)가 격자 사이면 그 다음 칸부터 보인다.
  const grid = useMemo(() => gridMinutes(focusedDate), [focusedDate]);
  const snap = (minutes: number, up: boolean) =>
    up ? (grid.find((m) => m >= minutes) ?? grid[grid.length - 1]) : ([...grid].reverse().find((m) => m <= minutes) ?? grid[0]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!Number.isFinite(win.first) || !Number.isFinite(win.last)) return null;

  const start = () => {
    setFirst(snap(win.first, true));
    setLast(snap(win.last, false));
    setOpen(true);
  };

  const save = async (nextFirst: number | null, nextLast: number | null) => {
    setSaving(true);
    try {
      const outside = await setHours(
        focusedDate,
        nextFirst == null ? null : minutesToTime(nextFirst),
        nextLast == null ? null : minutesToTime(nextLast),
      );
      const shown = teeWindow(focusedDate, {
        ...locks,
        hours: new Map([[focusedDate, { first: nextFirst, last: nextLast }]]),
      });
      pushToast(
        "success",
        `Tee times ${minutesToTime(shown.first)} – ${minutesToTime(shown.last)}` +
          (outside > 0 ? ` · ${outside} reservation(s) outside these hours stay booked.` : "."),
      );
      setOpen(false);
    } catch (error) {
      pushToast("error", error instanceof Error ? error.message : "Could not change the tee times.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="relative shrink-0" ref={ref}>
      <button
        aria-expanded={open}
        aria-haspopup="dialog"
        className={`flex items-center gap-1.5 rounded border px-2 py-0.5 font-semibold hover:bg-[#f2f2f4] ${
          open ? "border-[#c4c4cc] bg-[#f2f2f4]" : custom ? "border-[#d6c28f] bg-[#f3ead2] text-[#5c4a1c]" : "border-transparent"
        }`}
        onClick={() => (open ? setOpen(false) : start())}
        title={custom ? "First and last tee time set by staff — click to change" : "First and last tee time (sunrise / 2 hours before sunset) — click to change"}
        type="button"
      >
        <span aria-hidden>{custom ? "🔒" : "⛳"}</span>
        {minutesToTime(win.first)} – {minutesToTime(win.last)}
      </button>
      {open ? (
        <div
          className="absolute left-0 top-full z-40 mt-1 w-72 rounded border border-[#d4d4d8] bg-white p-3 text-xs text-[#1f2328] shadow-lg"
          role="dialog"
          aria-label="Tee times for this day"
        >
          <p className="mb-2 font-bold">Tee times on {longDate(focusedDate)}</p>
          <label className="mb-2 flex items-center justify-between gap-2">
            <span>First tee (open)</span>
            <select
              className="rounded border border-[#d4d4d8] px-1 py-0.5"
              onChange={(event) => setFirst(Number(event.target.value))}
              value={first}
            >
              {grid.map((m) => (
                <option key={m} value={m}>
                  {minutesToTime(m)}
                </option>
              ))}
            </select>
          </label>
          <label className="mb-2 flex items-center justify-between gap-2">
            <span>Last tee (close)</span>
            <select
              className="rounded border border-[#d4d4d8] px-1 py-0.5"
              onChange={(event) => setLast(Number(event.target.value))}
              value={last}
            >
              {grid.map((m) => (
                <option key={m} value={m}>
                  {minutesToTime(m)}
                </option>
              ))}
            </select>
          </label>
          <p className="mb-2 text-[11px] text-[#6b7280]">
            Times outside these hours are locked 🔒 for staff, web and phone. Booked reservations are not moved.
            Default: {minutesToTime(auto.first)} – {minutesToTime(auto.last)} (sunrise / 2 hours before sunset).
          </p>
          {first > last ? <p className="mb-2 font-semibold text-[#c62828]">The first tee must be before the last tee.</p> : null}
          <div className="flex items-center justify-between gap-2">
            <button
              className="rounded border border-[#d7d7dc] px-2 py-1 hover:bg-[#f2f2f4] disabled:opacity-50"
              disabled={saving || !custom}
              onClick={() => void save(null, null)}
              type="button"
            >
              Reset to sunrise/sunset
            </button>
            <button
              className="rounded bg-[#4533ff] px-3 py-1 font-bold text-white hover:bg-[#3726e0] disabled:opacity-50"
              disabled={saving || first > last}
              onClick={() => void save(first, last)}
              type="button"
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default function DateNav({ controller }: DateNavProps) {
  const { connection, focusedDate, stats, toasts, visibleBookings } = controller;

  // stats.reservations는 "예약 수"라서 한 티타임에 두 예약이 붙으면 2로 센다.
  // 상태 스트립의 첫 카운터는 "예약이 하나라도 있는 티타임 수"라 날짜+시각으로 중복을 제거한다.
  const teeTimeCount = useMemo(
    () => new Set(visibleBookings.map((booking) => `${booking.date} ${booking.time}`)).size,
    [visibleBookings],
  );

  const sun = useMemo(() => sunMinutes(focusedDate), [focusedDate]);
  const now = useClubNow();

  // 시간별 예보 펼침. 바깥을 누르거나 Esc 로 닫는다.
  const [forecastOpen, setForecastOpen] = useState(false);
  const weatherRef = useRef<HTMLDivElement>(null);
  // 캐시가 닫았다 열어도 남도록 패널이 아니라 여기서 부른다.
  const forecast = useHourlyForecast(focusedDate, forecastOpen);
  useEffect(() => {
    if (!forecastOpen) return;
    const onPointer = (event: PointerEvent) => {
      if (!weatherRef.current?.contains(event.target as Node)) setForecastOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setForecastOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [forecastOpen]);

  return (
    <>
      {/* (a) 상태 스트립 — 왼쪽 기온·일출·일몰·카운터 / 가운데 큰 날짜 / 오른쪽 노트 글리프.
          3열 그리드다: 가운데 칸이 **화면 기준으로** 가운데여야 하므로 좌우를 같은
          `1fr` 로 잡는다. flex + ml-auto 로는 왼쪽 카운터 자릿수에 따라 날짜가 흔들린다.

          예전에 여기 붙어 있던 집계 칩(Reservations · Arrived · Paid · Revenue ·
          Outstanding)과 연결 상태 배지는 레퍼런스에 없어서 뺐다. 같은 정보를
          Reports 화면과 토스트가 이미 말해 준다. */}
      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 border-b border-[#d4d4d8] bg-white px-4 py-1.5 text-xs text-[#4e5560]">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          {/* 기온·일출·일몰 묶음 = 시간별 예보를 여는 버튼 (레퍼런스와 같다).
              기온은 도착하면 그때 나타난다 (실패하면 영영 안 나온다). */}
          <div className="relative shrink-0" ref={weatherRef}>
            <button
              aria-expanded={forecastOpen}
              aria-haspopup="dialog"
              className={`flex items-center gap-3 rounded border px-2 py-0.5 hover:bg-[#f2f2f4] ${
                forecastOpen ? "border-[#c4c4cc] bg-[#f2f2f4]" : "border-transparent"
              }`}
              onClick={() => setForecastOpen((open) => !open)}
              title="Hourly forecast for this date"
              type="button"
            >
              {now !== null ? (
                <span className="flex items-center gap-1.5" title={`${SKY_LABEL[now.sky]} · now at the club`}>
                  <SkyIcon night={now.night} sky={now.sky} />
                  {now.celsius}°
                </span>
              ) : null}
              <span className="flex items-center gap-1.5" title="Sunrise at the club">
                <SunIcon up />
                {clockOrDash(sun.sunrise)}
              </span>
              <span className="flex items-center gap-1.5" title="Sunset at the club">
                <SunIcon up={false} />
                {clockOrDash(sun.sunset)}
              </span>
            </button>
            {forecastOpen ? <HourlyForecastPanel iso={focusedDate} rows={forecast} /> : null}
          </div>

          <TeeHoursButton controller={controller} />

          <span
            className="flex shrink-0 items-center gap-1.5 font-semibold text-[#111315]"
            title="Tee times with at least one reservation"
          >
            <CircleIcon />
            {teeTimeCount}
          </span>
          <span className="flex shrink-0 items-center gap-1.5 font-semibold text-[#111315]" title="Players booked">
            <PeopleIcon />
            {stats.players}
          </span>
          <span
            className="flex shrink-0 items-center gap-1.5 font-semibold text-[#111315]"
            title={`Carts booked · ${stats.cartsOut} out on the course (checked in)`}
          >
            <CartIcon />
            {stats.carts}
            {stats.cartsOut > 0 ? <span className="text-[#c62828]">({stats.cartsOut})</span> : null}
          </span>

          {/* 오프라인 복구 버튼은 레퍼런스에 없지만 남긴다 — 스크린샷은 정상 상태이고
              오류 상태에 대해서는 아무 말도 하지 않는다. 이걸 빼면 연결이 끊겼을 때
              다시 시도할 방법이 (날짜를 바꿔 보는 것 말고는) 사라진다. */}
          {connection === "offline" ? (
            <button
              className="shrink-0 border border-[#d7d7dc] bg-white px-2 py-0.5 font-bold hover:bg-[#f2f2f4] disabled:opacity-50"
              disabled={controller.busy}
              onClick={() => {
                void controller.refresh();
              }}
              type="button"
            >
              Retry
            </button>
          ) : null}
        </div>

        {/* 가운데: 큰 날짜. 블록 전체가 날짜 선택기다 — Week/Day 토글과 별도의 date
            입력칸을 없앴으므로(레퍼런스에 없다) 임의의 날짜로 가는 길이 여기 하나뿐이다.
            네이티브 <input type="date"> 를 투명하게 겹쳐 두고, 그 위를 누르면
            `showPicker()` 를 부른다. **투명하게 겹쳐 두는 것만으로는 부족하다** —
            크롬에서 날짜 입력칸의 글자 부분을 누르면 세그먼트에 포커스만 갈 뿐이고,
            달력은 오른쪽 끝 달력 아이콘에서만 열린다. 그 아이콘이 투명하니
            사용자에게는 "눌러도 아무 일이 없는 날짜" 가 된다.
            `showPicker()` 가 없는 브라우저에서는 입력칸이 그냥 포커스를 받고,
            키보드(숫자 입력 · 화살표)로 여전히 날짜를 바꿀 수 있다. */}
        <div className="relative flex shrink-0 items-center gap-2 text-[#111315]">
          <span className="text-2xl leading-none font-semibold">{dayNumber(focusedDate)}</span>
          <span className="text-[11px] leading-tight font-semibold">
            {WEEKDAY_FULL[toDate(focusedDate).getDay()]}
            <br />
            {monthYear(focusedDate)}
          </span>
          <span aria-hidden="true" className="text-[10px] leading-none text-[#4e5560]">
            ▾
          </span>
          <input
            aria-label="Jump to date"
            className="absolute inset-0 cursor-pointer opacity-0"
            onChange={(event) => {
              if (event.target.value) controller.setFocusedDate(event.target.value);
            }}
            onClick={(event) => {
              // 자기 click 핸들러 안이라 사용자 제스처로 인정된다.
              event.currentTarget.showPicker?.();
            }}
            title={longDate(focusedDate)}
            type="date"
            value={focusedDate}
          />
        </div>

        {/* 하루 단위 노트 API 가 아직 없어서 동작하지 않는 버튼을 만들지 않았다 — 표시로만 둔다. */}
        <span aria-hidden="true" className="flex justify-end text-[#4e5560]">
          <NoteIcon />
        </span>
      </div>

      {/* (b) 요일 탭 스트립 — 오늘부터 7일. 요금 화면과 **같은 컴포넌트**를 쓴다
          (components/admin/DayTabs.tsx). 클래스를 베껴 두면 한쪽만 색이 바뀐다. */}
      <DayTabs
        onChange={controller.setFocusedDate}
        onToday={() => {
          // 날짜가 바뀌면 컨트롤러가 다시 불러온다. 이미 오늘이면 직접 새로 고친다.
          const today = todayIso();
          if (focusedDate === today) void controller.refresh();
          else controller.setFocusedDate(today);
        }}
        value={focusedDate}
      />

      {/* 토스트 스택 — BookingDialog(z-50) 위에 떠야 하므로 z-[60]. */}
      <div aria-live="polite" className="pointer-events-none fixed right-4 top-4 z-[60] flex w-72 flex-col gap-2">
        {toasts.map((toast) => (
          <div
            className={`pointer-events-auto flex items-start gap-2 rounded border px-3 py-2 text-xs shadow-sm ${TOAST_STYLE[toast.kind]}`}
            key={toast.id}
            role={toast.kind === "error" ? "alert" : "status"}
          >
            <span className="flex-1 leading-4">{toast.text}</span>
            <button
              aria-label="Dismiss notification"
              className="shrink-0 font-bold opacity-60 hover:opacity-100"
              onClick={() => controller.dismissToast(toast.id)}
              type="button"
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </>
  );
}
