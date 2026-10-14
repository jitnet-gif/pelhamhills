"use client";

/**
 * 어드민 화면 위쪽의 파란 요일 탭 스트립 — **오늘부터 7일**.
 *
 * 티 시트(`DateNav`)와 요금 화면(`/admin/pricing`)이 같은 줄을 그린다. 클래스만
 * 베껴 두면 반드시 어긋나므로(한쪽만 색이 바뀌거나 한쪽만 좁은 화면에서 잘린다)
 * 여기 한 곳만 둔다. 무엇보다 아래의 **하이드레이션 처리**가 두 화면에 똑같이
 * 필요한 진짜 로직이다 — 클래스 복사와 달리 이건 베끼면 조용히 깨진다.
 *
 * 월요일에 스냅하지 않는다: 프로 샵이 보는 것은 "이번 주" 가 아니라 "앞으로
 * 일주일" 이다. 다른 주로 점프하면(`value` 가 창 밖으로 나가면) 그 날짜가 첫 칸이
 * 된다 — 고른 날이 탭에서 보이지 않는 상태가 생기면 안 되기 때문이다.
 */

import { useMemo, useSyncExternalStore } from "react";

import { dayTypeLabel, useRateDays } from "@/hooks/useRateDays";
import { addDays, columnLabel, longDate, money, toDate, todayIso } from "@/lib/teeSheet/dates";

/** 탭에 보이는 날짜 수. */
export const STRIP_DAYS = 7;

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
 * `value` 를 기준으로 보여 줄 7일. 하이드레이션 전에는 `today` 를 모르므로 서버가
 * 그린 것과 **같은** 앵커(`value`)를 쓰고, 마운트 후 진짜 앵커로 한 번 다시 그린다.
 */
export function useDayStrip(value: string): { dates: string[]; mounted: boolean } {
  const mounted = useSyncExternalStore(subscribeNever, getClient, getServer);
  const today = mounted ? todayIso() : null;

  const dates = useMemo(() => {
    let anchor = value;
    if (today) {
      const offset = Math.round((toDate(value).getTime() - toDate(today).getTime()) / 86_400_000);
      anchor = offset >= 0 && offset < STRIP_DAYS ? today : value;
    }
    return Array.from({ length: STRIP_DAYS }, (_, index) => addDays(anchor, index));
  }, [value, today]);

  return { dates, mounted };
}

export type DayTabsProps = {
  /** 지금 고른 날짜 (ISO). */
  value: string;
  onChange: (isoDate: string) => void;
};

export default function DayTabs({ value, onChange }: DayTabsProps) {
  const { dates, mounted } = useDayStrip(value);
  // 칸마다 그 날 그린피. 공휴일은 주황 글자 — 평일인데 요금이 다른 날을 놓치지 않게.
  const rates = useRateDays(dates);

  return (
    // `grid-cols-7` 이라 칸 폭이 내용이 아니라 화면 폭으로 정해진다: 좁은 화면에서도
    // 가로 스크롤이나 잘림 없이 그대로 좁아진다.
    // 띠 자체가 파란 배경이고 칸 사이는 흰 선으로만 나눈다.
    <div className="grid grid-cols-7 border-b border-[#d4d4d8] bg-[#a9c3e0] text-xs">
      {dates.map((iso) => {
        // columnLabel()은 내부에서 todayIso()를 부른다 → 마운트 전에는 쓸 수 없다.
        const label = mounted ? columnLabel(iso) : weekdayLabel(iso);
        const active = iso === value;
        const day = rates.get(iso);
        const holiday = day?.dayType === "holiday";
        return (
          <button
            aria-pressed={active}
            className={`min-h-11 truncate border-r border-white/60 px-2 font-bold whitespace-nowrap last:border-r-0 lg:min-h-0 lg:py-1.5 ${
              active ? "bg-[#3a7bc4] text-white" : "text-[#1f2328] hover:bg-white/25"
            }`}
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
