// Date helpers for the tee sheet. All wire dates are ISO `YYYY-MM-DD` strings and
// are treated as calendar dates in the club's local timezone — never as UTC
// instants, so we build Date objects with the local constructor, not Date.parse.

const DAY_MS = 24 * 60 * 60 * 1000;

const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function toDate(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

export function toIso(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function todayIso(): string {
  return toIso(new Date());
}

// 24시간을 더하지 않고 달력으로 센다 — 서머타임이 끝나는 날은 25시간이라 같은 날짜가 두 번 나온다.
export function addDays(iso: string, days: number): string {
  const date = toDate(iso);
  date.setDate(date.getDate() + days);
  return toIso(date);
}

/** Monday of the week containing `iso`. */
export function startOfWeek(iso: string): string {
  const date = toDate(iso);
  const offset = (date.getDay() + 6) % 7; // Mon=0 .. Sun=6
  return addDays(iso, -offset);
}

/** The 7 ISO dates Monday..Sunday for the week containing `iso`. */
export function weekDates(iso: string): string[] {
  const monday = startOfWeek(iso);
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}

/** 0..6 index of `iso` within the week starting at `weekStart`, or -1 if outside. */
export function dayIndexIn(weekStart: string, iso: string): number {
  const diff = Math.round((toDate(iso).getTime() - toDate(weekStart).getTime()) / DAY_MS);
  return diff >= 0 && diff <= 6 ? diff : -1;
}

/** Column header label, e.g. "Mon 7" — or "Today" when it is the current date. */
export function columnLabel(iso: string): string {
  if (iso === todayIso()) return "Today";
  const date = toDate(iso);
  return `${WEEKDAY_SHORT[date.getDay()]} ${date.getDate()}`;
}

/** "September 11, 2026" — the human-readable form shown in the detail panel. */
export function longDate(iso: string): string {
  const date = toDate(iso);
  return `${MONTH_LONG[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
}

/** "Friday · Sep 2026" — the sub-label under the big day number. */
export function headerCaption(iso: string): string {
  const date = toDate(iso);
  const weekday = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][date.getDay()];
  return `${weekday} · ${MONTH_SHORT[date.getMonth()]} ${date.getFullYear()}`;
}

export function dayNumber(iso: string): number {
  return toDate(iso).getDate();
}

export function isWeekend(iso: string): boolean {
  const day = toDate(iso).getDay();
  return day === 0 || day === 6;
}

// ===== Slot time helpers =====

/** "6:58 AM" -> 418 (minutes from midnight). Returns NaN for unparseable input. */
export function timeToMinutes(label: string): number {
  const match = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(label.trim());
  if (!match) return Number.NaN;
  let hour = Number(match[1]) % 12;
  if (match[3].toUpperCase() === "PM") hour += 12;
  return hour * 60 + Number(match[2]);
}

/** 418 -> "6:58 AM" */
export function minutesToTime(minutes: number): string {
  const normalized = ((minutes % 1440) + 1440) % 1440;
  const hour24 = Math.floor(normalized / 60);
  const minute = normalized % 60;
  const suffix = hour24 < 12 ? "AM" : "PM";
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${hour12}:${String(minute).padStart(2, "0")} ${suffix}`;
}

/**
 * `$1,234.56`. 천 단위 구분을 직접 넣는 이유: `toLocaleString` 은 서버(노드)와
 * 브라우저의 로케일이 다르면 다른 문자열을 내서 하이드레이션을 깬다. 이 앱은
 * 정적 export 라 그 위험이 실재한다.
 */
export function money(value: number): string {
  const amount = Number.isFinite(value) ? value : 0;
  const [whole, cents] = Math.abs(amount).toFixed(2).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${amount < 0 ? "-" : ""}$${grouped}.${cents}`;
}
