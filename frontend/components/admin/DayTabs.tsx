"use client";

/**
 * 어드민 화면 위쪽의 파란 요일 탭 스트립 — 한 화면에 **7일**, 마우스 휠·트랙패드로 좌우로 민다.
 *
 * 티 시트(`DateNav`)와 요금 화면(`/admin/pricing`)이 같은 줄을 그린다. 클래스만
 * 베껴 두면 반드시 어긋나므로(한쪽만 색이 바뀌거나 한쪽만 좁은 화면에서 잘린다)
 * 여기 한 곳만 둔다. 무엇보다 아래의 **하이드레이션 처리**가 두 화면에 똑같이
 * 필요한 진짜 로직이다 — 클래스 복사와 달리 이건 베끼면 조용히 깨진다.
 *
 * 월요일에 스냅하지 않는다: 프로 샵이 보는 것은 "이번 주" 가 아니라 "앞으로
 * 일주일" 이다. 다른 주로 점프하면(`value` 가 창 밖으로 나가면) 그 날짜가 첫 칸이
 * 된다 — 고른 날이 탭에서 보이지 않는 상태가 생기면 안 되기 때문이다.
 *
 * 띠에는 그 앞 `STRIP_BEFORE` 일과 뒤로 더 많은 날이 깔려 있고, 처음에는 앵커가 첫 칸에
 * 오도록 스크롤해 둔다. 전체 길이는 요금 조회 한도(`pelham_staff_rate_days`, 62일) 안이다.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";

import { dayTypeLabel, useRateDays } from "@/hooks/useRateDays";
import { addDays, columnLabel, longDate, money, toDate, todayIso } from "@/lib/teeSheet/dates";

/** 한 화면에 보이는 날짜 수. */
export const STRIP_DAYS = 7;
/** 앵커 왼쪽(지난 날)에 깔아 두는 날 수. */
const STRIP_BEFORE = 7;
/** 띠 전체 날 수 — 요금 조회가 62일까지라 그 안에서. */
const STRIP_TOTAL = 61;

const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "Wed 9" — columnLabel()의 "오늘이 아닐 때" 형태. 하이드레이션 전 라벨로만 쓴다. */
function weekdayLabel(iso: string): string {
  const date = toDate(iso);
  return `${WEEKDAY_SHORT[date.getDay()]} ${date.getDate()}`;
}

// 서버 렌더에서는 false, 하이드레이션 이후에는 true — "오늘"을 안전하게 읽기 위한 스위치.
// 정적 export 라 프리렌더된 HTML 은 **빌드 날짜**를 담는다. 그대로 `todayIso()` 를
// 부르면 다음 날 페이지를 열었을 때 서버가 그린 글자와 클라이언트 첫 렌더가 어긋난다.
const subscribeNever = () => () => {};
const getClient = () => true;
const getServer = () => false;

/**
 * `value` 를 기준으로 띠에 깔 날짜(`STRIP_BEFORE` 일 전부터). 하이드레이션 전에는 `today` 를
 * 모르므로 서버가 그린 것과 **같은** 앵커(`value`)를 쓰고, 마운트 후 진짜 앵커로 한 번 다시 그린다.
 */
export function useDayStrip(value: string): { dates: string[]; anchor: string; mounted: boolean } {
  const mounted = useSyncExternalStore(subscribeNever, getClient, getServer);
  const today = mounted ? todayIso() : null;

  // 고른 날이 오늘의 띠 안에 있으면 앵커는 오늘, 밖으로 점프했으면 그 날.
  let anchor = value;
  if (today) {
    const offset = Math.round((toDate(value).getTime() - toDate(today).getTime()) / 86_400_000);
    anchor = offset >= -STRIP_BEFORE && offset < STRIP_TOTAL - STRIP_BEFORE ? today : value;
  }

  const dates = useMemo(
    () => Array.from({ length: STRIP_TOTAL }, (_, index) => addDays(anchor, index - STRIP_BEFORE)),
    [anchor],
  );

  return { dates, anchor, mounted };
}

export type DayTabsProps = {
  /** 지금 고른 날짜 (ISO). */
  value: string;
  onChange: (isoDate: string) => void;
};

export default function DayTabs({ value, onChange }: DayTabsProps) {
  const { dates, anchor, mounted } = useDayStrip(value);
  // 칸마다 그 날 그린피. 공휴일은 주황 글자 — 평일인데 요금이 다른 날을 놓치지 않게.
  const rates = useRateDays(dates);
  const stripRef = useRef<HTMLDivElement>(null);

  // 앵커가 바뀌면(첫 렌더·하이드레이션·먼 날로 점프) 앵커를 첫 칸에 맞춘다.
  useLayoutEffect(() => {
    const strip = stripRef.current;
    if (strip) strip.scrollLeft = (strip.clientWidth / STRIP_DAYS) * STRIP_BEFORE;
  }, [anchor]);

  // 고른 날이 화면 밖이면(띠를 밀어 둔 채 다른 곳에서 날짜를 바꿨을 때) 보이게 민다.
  useEffect(() => {
    const strip = stripRef.current;
    const tab = strip?.querySelector<HTMLElement>(`[data-iso="${value}"]`);
    if (!strip || !tab) return;
    if (tab.offsetLeft < strip.scrollLeft) strip.scrollLeft = tab.offsetLeft;
    else if (tab.offsetLeft + tab.offsetWidth > strip.scrollLeft + strip.clientWidth) {
      strip.scrollLeft = tab.offsetLeft + tab.offsetWidth - strip.clientWidth;
    }
  }, [value]);

  // 세로 휠을 가로로 바꾼다. React 의 onWheel 은 passive 라 preventDefault 가 안 먹어서
  // 직접 붙인다. 띠 끝에 닿으면 페이지가 대신 스크롤되게 놓아 준다.
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const onWheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return; // 트랙패드 가로 밀기는 브라우저에 맡긴다
      const max = strip.scrollWidth - strip.clientWidth;
      if ((event.deltaY < 0 && strip.scrollLeft <= 0) || (event.deltaY > 0 && strip.scrollLeft >= max - 1)) return;
      event.preventDefault();
      strip.scrollLeft += event.deltaY;
    };
    strip.addEventListener("wheel", onWheel, { passive: false });
    return () => strip.removeEventListener("wheel", onWheel);
  }, []);

  return (
    // 칸 폭은 내용이 아니라 띠 폭의 1/7 이라 좁은 화면에서도 7칸이 그대로 좁아지고,
    // 나머지 날은 옆으로 밀어서 본다. 스크롤바는 숨긴다(휠·트랙패드·터치로 민다).
    // 띠 자체가 파란 배경이고 칸 사이는 흰 선으로만 나눈다.
    <div
      className="flex overflow-x-auto overscroll-x-contain border-b border-[#d4d4d8] bg-[#a9c3e0] text-xs [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      ref={stripRef}
    >
      {dates.map((iso) => {
        // columnLabel()은 내부에서 todayIso()를 부른다 → 마운트 전에는 쓸 수 없다.
        const label = mounted ? columnLabel(iso) : weekdayLabel(iso);
        const active = iso === value;
        const day = rates.get(iso);
        const holiday = day?.dayType === "holiday";
        return (
          <button
            aria-pressed={active}
            className={`min-h-11 shrink-0 basis-[calc(100%/7)] truncate border-r border-white/60 px-2 font-bold whitespace-nowrap last:border-r-0 lg:min-h-0 lg:py-1.5 ${
              active ? "bg-[#3a7bc4] text-white" : "text-[#1f2328] hover:bg-white/25"
            }`}
            data-iso={iso}
            key={iso}
            onClick={() => onChange(iso)}
            title={day ? `${longDate(iso)} — ${dayTypeLabel(day)} ${money(day.rate)}` : longDate(iso)}
            type="button"
          >
            {label}
            {day && (
              <span
                className={`block truncate text-[10px] leading-tight font-semibold tabular-nums ${
                  active ? "text-white/85" : holiday ? "text-[#b4530a]" : "text-[#3f4650]"
                }`}
              >
                {holiday ? `★ ${money(day.rate)}` : money(day.rate)}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
