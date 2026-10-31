"use client";

// 티 시트 운영 패널: 리포트 + 병렬 오케스트레이션 작업.
// 접근 가능한 유일한 API 클라이언트는 lib/teeSheet/api.ts 의 teeSheetApi 뿐이다.

import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";

import ReportDrilldown, { type ReportDrill, type ReportMetric } from "@/components/teesheet/ReportDrilldown";
import { ApiError, teeSheetApi } from "@/lib/teeSheet/api";
import { columnLabel, longDate, money } from "@/lib/teeSheet/dates";
import type {
  DailyReport,
  OrchestrationStatus,
  OrchestrationTask,
  TaskState,
  TeeSheetController,
  WeekReport,
} from "@/lib/teeSheet/types";

export type OrchestrationPanelProps = { controller: TeeSheetController };

// ===== 상수 =====

const STORAGE_KEY = "pelham.teesheet.operations.open";
const POLL_INTERVAL_MS = 1500;
const MAX_POLL_FAILURES = 3;
/** 서버가 작업을 잊어버려도 폴링이 영원히 돌지 않도록 하는 상한. */
const MAX_POLL_WINDOW_MS = 120_000;

const TABS = [
  { key: "reports", label: "Reports" },
  { key: "tasks", label: "Tasks" },
] as const;

type TabKey = (typeof TABS)[number]["key"];
type ActionKey = "daily_batch" | "send_reminders" | "cleanup" | "worker";

// ===== 순수 헬퍼 =====

function readStoredOpen(): boolean | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === "open") return true;
    if (raw === "closed") return false;
    return null;
  } catch {
    return null; // 프라이빗 모드/차단된 스토리지 — 기본값으로 렌더링한다.
  }
}

function writeStoredOpen(open: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, open ? "open" : "closed");
  } catch {
    // 저장 실패는 무시한다. 패널 동작에는 영향이 없다.
  }
}

function isTerminal(state: TaskState | string): boolean {
  return state === "success" || state === "failed";
}

function safeNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

function occupancyPercent(report: DailyReport | null | undefined): number {
  if (!report) return 0;
  const total = safeNumber(report.total_slots);
  const booked = safeNumber(report.booked_slots);
  if (total > 0) return clampPercent((booked / total) * 100);
  return clampPercent(safeNumber(report.occupancy_rate));
}

/** ISO 날짜가 확실할 때만 columnLabel 을 태운다 (깨진 값이 "undefined NaN" 으로 새지 않도록). */
function dayLabel(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return typeof value === "string" && value.trim().length ? value : "—";
  }
  return columnLabel(value);
}

function formatDuration(value: unknown): string {
  const ms = safeNumber(value, Number.NaN);
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatClock(value: string | number | Date | null | undefined, withSeconds = false): string {
  if (value === null || value === undefined || value === "") return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  try {
    return date.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      ...(withSeconds ? { second: "2-digit" } : {}),
    });
  } catch {
    return "";
  }
}

/** "daily_batch" -> "Daily batch". 알 수 없는 값도 절대 [object Object] 로 새지 않는다. */
function titleize(raw: unknown): string {
  const text = typeof raw === "string" ? raw : raw === null || raw === undefined ? "" : String(raw);
  const spaced = text.replace(/[_\-.]+/g, " ").trim();
  if (!spaced) return "Task";
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** 스칼라면 문자열, 중첩 구조면 null (호출부가 JSON 블록으로 렌더). */
function formatScalar(value: unknown): string | null {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value.trim().length ? value : "—";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "—";
  if (typeof value === "boolean") return value ? "yes" : "no";
  return null;
}

function formatJson(value: unknown): string {
  try {
    const text = JSON.stringify(value, null, 2);
    return typeof text === "string" ? text : String(value);
  } catch {
    return "[unserializable value]";
  }
}

function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    return error.status === 0
      ? `Operations service unreachable — ${error.message || "network error"}`
      : `${error.status} · ${error.message}`;
  }
  if (error instanceof Error) return error.message || "Unexpected error";
  return "Unexpected error";
}

// ===== 병렬 팬아웃 추출 =====

type SubtaskTiming = {
  name: string;
  durationMs: number | null;
  startMs: number;
  state: string | null;
};

type FanOut = {
  subtasks: SubtaskTiming[];
  wallMs: number | null;
  serialMs: number;
  hasTimings: boolean;
};

const SUBTASK_KEYS = ["subtasks", "subtask_timings", "parallel_tasks", "steps", "timings", "tasks"];
const DURATION_KEYS = ["duration_ms", "elapsed_ms", "took_ms", "ms", "runtime_ms"];
const START_KEYS = ["start_ms", "offset_ms", "started_offset_ms", "start_offset_ms"];
const WALL_KEYS = ["wall_clock_ms", "wall_ms", "parallel_ms", "total_ms", "duration_ms", "elapsed_ms"];
const SERIAL_KEYS = ["serial_ms", "sequential_ms", "serial_total_ms"];
const NAME_KEYS = ["name", "task", "label", "step", "key"];

function pickNumber(record: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

function pickString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length) return value;
  }
  return null;
}

/** 배열이거나 {name: {...}} 맵이어도 동일한 배열 형태로 정규화한다. */
function collectSubtaskEntries(record: Record<string, unknown>): Array<[string | null, unknown]> {
  for (const key of SUBTASK_KEYS) {
    const value = record[key];
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      return value.map((entry) => [null, entry] as [string | null, unknown]);
    }
    if (value && typeof value === "object") {
      const entries = Object.entries(value as Record<string, unknown>);
      if (entries.length) return entries.map(([name, entry]) => [name, entry] as [string | null, unknown]);
    }
  }
  return [];
}

function extractFanOut(task: OrchestrationTask): FanOut | null {
  const result = task?.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const record = result as Record<string, unknown>;

  const raw = collectSubtaskEntries(record);
  if (raw.length === 0) return null;

  const subtasks: SubtaskTiming[] = [];
  for (const [mapKey, entry] of raw) {
    if (typeof entry === "string") {
      // ["send_reminders", "generate_report"] 처럼 이름만 있는 경우.
      subtasks.push({ name: entry, durationMs: null, startMs: 0, state: null });
      continue;
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const item = entry as Record<string, unknown>;
    const name = mapKey ?? pickString(item, NAME_KEYS) ?? `Subtask ${subtasks.length + 1}`;
    subtasks.push({
      name,
      durationMs: pickNumber(item, DURATION_KEYS),
      startMs: Math.max(0, pickNumber(item, START_KEYS) ?? 0),
      state: pickString(item, ["state", "status"]),
    });
  }
  if (subtasks.length === 0) return null;

  const measured = subtasks.filter((item) => item.durationMs !== null);
  const serialFromResult = pickNumber(record, SERIAL_KEYS);
  const serialMs =
    serialFromResult ?? measured.reduce((sum, item) => sum + safeNumber(item.durationMs), 0);
  const wallMs = pickNumber(record, WALL_KEYS) ?? (task.duration_ms ?? null);

  return {
    subtasks,
    wallMs: typeof wallMs === "number" && Number.isFinite(wallMs) ? wallMs : null,
    serialMs,
    hasTimings: measured.length > 0,
  };
}

// ===== 작은 프레젠테이션 컴포넌트 =====

const BADGE_STYLES: Record<string, string> = {
  queued: "bg-[#ececf0] text-[#4e5560]",
  running: "bg-[#e6ebff] text-[#0034c9]",
  success: "bg-[#e6f4eb] text-[#168a3c]",
  failed: "bg-[#f7ebe6] text-[#8a3f26]",
};

function StateBadge({ state }: { state: TaskState | string }) {
  const style = BADGE_STYLES[state] ?? BADGE_STYLES.queued;
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-px text-[10px] font-bold tracking-wide uppercase ${style}`}
    >
      {state === "running" ? (
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" aria-hidden="true" />
      ) : null}
      {titleize(state)}
    </span>
  );
}

function Stat({ label, value, onClick }: { label: string; value: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded border border-[#ececf0] px-2 py-1.5 text-left hover:border-[#4533ff]"
    >
      <div className="text-[10px] tracking-wide text-[#4e5560] uppercase">{label}</div>
      <div className="mt-0.5 font-bold tabular-nums">{value}</div>
    </button>
  );
}

function OccupancyBar({ percent, label }: { percent: number; label: string }) {
  return (
    <div
      className="h-2 w-full overflow-hidden rounded-full bg-[#ececf0]"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(percent)}
      aria-label={label}
    >
      <div className="h-full rounded-full bg-[#4533ff]" style={{ width: `${percent}%` }} />
    </div>
  );
}

function ErrorRow({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded border border-[#e2c7bb] bg-[#fbf1ed] px-2 py-1.5 text-[#8a3f26]"
    >
      <span className="min-w-0 flex-1 break-words">{message}</span>
      <button
        type="button"
        onClick={onRetry}
        className="shrink-0 rounded border border-[#8a3f26] px-1.5 py-px font-bold hover:bg-[#8a3f26] hover:text-white"
      >
        Retry
      </button>
    </div>
  );
}

function ResultView({ result }: { result: Record<string, unknown> }) {
  const entries = Object.entries(result);
  if (entries.length === 0) {
    return <p className="text-[#4e5560]">No result payload.</p>;
  }
  return (
    <dl className="grid grid-cols-[minmax(0,8rem)_minmax(0,1fr)] gap-x-3 gap-y-1">
      {entries.map(([key, value]) => {
        const scalar = formatScalar(value);
        return (
          <Fragment key={key}>
            <dt className="truncate text-[#4e5560]">{titleize(key)}</dt>
            <dd className="min-w-0">
              {scalar !== null ? (
                <span className="break-words">{scalar}</span>
              ) : (
                <pre className="overflow-x-auto rounded bg-[#f6f6f8] p-1.5 text-[11px] leading-snug">
                  {formatJson(value)}
                </pre>
              )}
            </dd>
          </Fragment>
        );
      })}
    </dl>
  );
}

/** 데일리 배치의 서브태스크 동시 실행을 눈에 보이게 만든다. */
function FanOutView({ fanOut }: { fanOut: FanOut }) {
  const maxEnd = fanOut.subtasks.reduce(
    (max, item) => Math.max(max, item.startMs + safeNumber(item.durationMs)),
    0,
  );
  const scale = Math.max(fanOut.wallMs ?? 0, maxEnd, 1);
  const speedup =
    fanOut.hasTimings && fanOut.wallMs && fanOut.wallMs > 0 && fanOut.serialMs > 0
      ? fanOut.serialMs / fanOut.wallMs
      : null;

  const summary: string[] = [`${fanOut.subtasks.length} subtasks`];
  if (fanOut.hasTimings) {
    if (fanOut.wallMs !== null) summary.push(`${formatDuration(fanOut.wallMs)} wall clock`);
    if (fanOut.serialMs > 0) summary.push(`${formatDuration(fanOut.serialMs)} if run serially`);
    if (speedup && speedup > 1.05) summary.push(`${speedup.toFixed(1)}× faster in parallel`);
  }

  return (
    <div className="rounded border border-[#ececf0] bg-[#fbfbfc] p-2">
      <div className="font-bold">Parallel fan-out</div>
      <div className="mt-0.5 text-[#4e5560]">{summary.join(" · ")}</div>
      <ul className="mt-1.5 space-y-1">
        {fanOut.subtasks.map((item, index) => {
          const duration = safeNumber(item.durationMs);
          const widthPercent = fanOut.hasTimings ? clampPercent((duration / scale) * 100) : 0;
          const offsetPercent = fanOut.hasTimings ? clampPercent((item.startMs / scale) * 100) : 0;
          return (
            <li key={`${item.name}-${index}`} className="flex items-center gap-2">
              <span className="w-28 shrink-0 truncate text-[#4e5560]" title={titleize(item.name)}>
                {titleize(item.name)}
              </span>
              {fanOut.hasTimings ? (
                <span className="h-1.5 min-w-0 flex-1 rounded-full bg-[#ececf0]" aria-hidden="true">
                  <span
                    className="block h-full rounded-full bg-[#4533ff]"
                    style={{
                      width: `${Math.max(widthPercent, item.durationMs === null ? 0 : 2)}%`,
                      marginLeft: `${offsetPercent}%`,
                    }}
                  />
                </span>
              ) : (
                <span className="min-w-0 flex-1" />
              )}
              <span className="w-16 shrink-0 text-right tabular-nums text-[#4e5560]">
                {item.durationMs === null ? (item.state ? titleize(item.state) : "—") : formatDuration(item.durationMs)}
              </span>
            </li>
          );
        })}
      </ul>
      {fanOut.hasTimings ? (
        <p className="mt-1 text-[10px] text-[#4e5560]">
          Bars share one timeline — overlapping bars ran concurrently on the server.
        </p>
      ) : null}
    </div>
  );
}

// ===== 메인 패널 =====

export default function OrchestrationPanel({ controller }: OrchestrationPanelProps) {
  const uid = useId();
  const bodyId = `${uid}-body`;

  const offline = controller.connection === "offline";
  const focusedDate = controller.focusedDate;
  const weekList = controller.weekDates ?? [];
  const weekFrom = weekList[0] ?? controller.weekStart ?? focusedDate;
  const weekTo = weekList[6] ?? weekList[weekList.length - 1] ?? weekFrom;

  // 컨트롤러는 매 렌더 새 객체일 수 있으므로 effect 의존성에서 빼고 ref 로 읽는다.
  const controllerRef = useRef(controller);
  controllerRef.current = controller;

  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<TabKey>("reports");
  const [documentHidden, setDocumentHidden] = useState(false);

  // --- 리포트 상태 ---
  const [dailyReport, setDailyReport] = useState<DailyReport | null>(null);
  const [weekReport, setWeekReport] = useState<WeekReport | null>(null);
  const [reportsLoading, setReportsLoading] = useState(false);
  const [reportsError, setReportsError] = useState<string | null>(null);
  const [reportsUpdatedAt, setReportsUpdatedAt] = useState<Date | null>(null);
  const [reportsNonce, setReportsNonce] = useState(0);
  const [drill, setDrill] = useState<ReportDrill | null>(null);

  // --- 작업 상태 ---
  const [tasks, setTasks] = useState<OrchestrationTask[]>([]);
  const [meta, setMeta] = useState<Pick<OrchestrationStatus, "status" | "total_bookings" | "timestamp"> | null>(null);
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<ActionKey | null>(null);
  const [actionError, setActionError] = useState<{ key: ActionKey; message: string } | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [pollNonce, setPollNonce] = useState(0);
  const [confirmCleanup, setConfirmCleanup] = useState(false);

  const orderRef = useRef<{ next: number; seen: Map<string, number> }>({ next: 0, seen: new Map() });
  const refreshedRef = useRef<Set<string>>(new Set());
  const seededRef = useRef(false);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // ===== 열림/닫힘 persist =====

  useEffect(() => {
    const stored = readStoredOpen();
    if (stored !== null) setOpen(stored);
  }, []);

  const toggleOpen = useCallback(() => {
    setOpen((previous) => {
      const next = !previous;
      writeStoredOpen(next);
      return next;
    });
  }, []);

  // ===== 문서 가시성 =====

  useEffect(() => {
    if (typeof document === "undefined") return;
    const sync = () => setDocumentHidden(document.hidden);
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, []);

  // ===== 리포트 로드 (날짜/주가 바뀌면 재요청, 이전 요청은 폐기) =====

  useEffect(() => {
    if (offline) {
      setReportsLoading(false);
      return;
    }
    // teeSheetApi 는 signal 을 받지 않으므로 응답을 "폐기"하는 방식으로 중단한다.
    // 늦게 도착한 응답이 새 데이터를 덮어쓰는 일은 절대 없다.
    const aborter = new AbortController();
    const { signal } = aborter;

    setReportsLoading(true);
    setReportsError(null);

    void (async () => {
      try {
        const [daily, week] = await Promise.all([
          teeSheetApi.getDailyReport(focusedDate),
          teeSheetApi.getWeekReport(weekFrom, weekTo),
        ]);
        if (signal.aborted) return;
        setDailyReport(daily ?? null);
        setWeekReport(week ?? null);
        setReportsUpdatedAt(new Date());
      } catch (error) {
        if (signal.aborted) return;
        setReportsError(describeError(error));
      } finally {
        if (!signal.aborted) setReportsLoading(false);
      }
    })();

    return () => aborter.abort();
  }, [focusedDate, weekFrom, weekTo, offline, reportsNonce]);

  // ===== 작업 병합 =====

  const mergeTasks = useCallback((incoming: OrchestrationTask[] | null | undefined) => {
    const list = Array.isArray(incoming) ? incoming : [];
    const order = orderRef.current;
    for (const task of list) {
      if (task && typeof task.id === "string" && !order.seen.has(task.id)) {
        order.seen.set(task.id, order.next++);
      }
    }
    setTasks((previous) => {
      const byId = new Map<string, OrchestrationTask>();
      for (const task of previous) byId.set(task.id, task);
      for (const task of list) {
        if (!task || typeof task.id !== "string") continue;
        const existing = byId.get(task.id);
        byId.set(task.id, existing ? { ...existing, ...task } : task);
      }
      return [...byId.values()].sort((a, b) => {
        const at = Date.parse(a.created_at ?? "");
        const bt = Date.parse(b.created_at ?? "");
        if (Number.isFinite(at) && Number.isFinite(bt) && at !== bt) return bt - at;
        return (order.seen.get(b.id) ?? 0) - (order.seen.get(a.id) ?? 0);
      });
    });
  }, []);

  // ===== 최초 1회 상태 시딩 (패널을 처음 열 때) =====

  useEffect(() => {
    if (!open || seededRef.current || offline) return;
    seededRef.current = true;
    let discarded = false;
    void (async () => {
      try {
        const status = await teeSheetApi.getOrchestrationStatus();
        if (discarded) return;
        setMeta({
          status: status?.status ?? "",
          total_bookings: safeNumber(status?.total_bookings),
          timestamp: status?.timestamp ?? "",
        });
        // 패널이 열리기 전에 이미 끝난 작업으로 grid refresh 를 트리거하지 않는다.
        for (const task of status?.tasks ?? []) {
          if (task && typeof task.id === "string" && isTerminal(task.state)) {
            refreshedRef.current.add(task.id);
          }
        }
        mergeTasks(status?.tasks);
      } catch {
        // 시딩 실패는 조용히 넘긴다. 작업을 실행하면 다시 시도된다.
        seededRef.current = false;
      }
    })();
    return () => {
      discarded = true;
    };
  }, [open, offline, mergeTasks]);

  // ===== 폴링: 비종료 작업이 있을 때만 =====

  const activeTasks = useMemo(() => tasks.filter((task) => !isTerminal(task.state)), [tasks]);
  const hasActive = activeTasks.length > 0;
  const shouldPoll = hasActive && !documentHidden && !offline && pollError === null;

  useEffect(() => {
    if (!shouldPoll) return;

    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let failures = 0;
    const deadline = Date.now() + MAX_POLL_WINDOW_MS;

    const tick = async () => {
      if (stopped) return;
      if (Date.now() > deadline) {
        setPollError("Stopped watching after 2 minutes — tasks may have expired on the server.");
        return;
      }
      try {
        const status = await teeSheetApi.getOrchestrationStatus();
        if (stopped) return;
        failures = 0;
        setMeta({
          status: status?.status ?? "",
          total_bookings: safeNumber(status?.total_bookings),
          timestamp: status?.timestamp ?? "",
        });
        mergeTasks(status?.tasks);
      } catch (error) {
        if (stopped) return;
        failures += 1;
        if (failures >= MAX_POLL_FAILURES) {
          setPollError(describeError(error));
          return; // 재예약하지 않는다 — 루프 종료.
        }
      }
      if (!stopped) timer = setTimeout(tick, POLL_INTERVAL_MS * Math.max(1, failures));
    };

    timer = setTimeout(tick, POLL_INTERVAL_MS);

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [shouldPoll, pollNonce, mergeTasks]);

  // ===== 종료된 작업의 후처리 (그리드/리포트 갱신) =====

  useEffect(() => {
    let refreshGrid = false;
    let refreshReports = false;

    for (const task of tasks) {
      if (task.state !== "success") continue;
      if (refreshedRef.current.has(task.id)) continue;
      refreshedRef.current.add(task.id);
      const name = String(task.name ?? "").toLowerCase();
      if (name.includes("cleanup") || name.includes("worker")) refreshGrid = true;
      if (name.includes("batch") || name.includes("report")) refreshReports = true;
    }

    if (refreshGrid) void controllerRef.current.refresh();
    if (refreshReports) setReportsNonce((value) => value + 1);
  }, [tasks]);

  // ===== 액션 =====

  const runAction = useCallback(
    async (key: ActionKey) => {
      if (offline) return;
      setPendingAction(key);
      setActionError(null);
      try {
        const ack =
          key === "daily_batch"
            ? await teeSheetApi.runDailyBatch(focusedDate)
            : key === "send_reminders"
              ? await teeSheetApi.sendReminders(focusedDate)
              : key === "cleanup"
                ? await teeSheetApi.runCleanup()
                : await teeSheetApi.runWorker(focusedDate);

        mergeTasks(ack?.tasks);
        // 새 작업이 생겼으니 죽어 있던 폴링 루프를 되살린다.
        setPollError(null);
        setPollNonce((value) => value + 1);
        if (ack && ack.accepted === false) {
          setActionError({ key, message: ack.message || "The operations service rejected the request." });
        }
      } catch (error) {
        setActionError({ key, message: describeError(error) });
      } finally {
        setPendingAction(null);
      }
    },
    [focusedDate, mergeTasks, offline],
  );

  const retryAction = useCallback(() => {
    if (!actionError) return;
    void runAction(actionError.key);
  }, [actionError, runAction]);

  const resumePolling = useCallback(() => {
    setPollError(null);
    setPollNonce((value) => value + 1);
  }, []);

  // ===== 탭 키보드 내비게이션 =====

  const onTabKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>) => {
      const current = TABS.findIndex((entry) => entry.key === tab);
      let next = current;
      if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (current + 1) % TABS.length;
      else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (current - 1 + TABS.length) % TABS.length;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = TABS.length - 1;
      else return;
      event.preventDefault();
      setTab(TABS[next].key);
      tabRefs.current[next]?.focus();
    },
    [tab],
  );

  // ===== 파생 값 =====

  const failedCount = useMemo(() => tasks.filter((task) => task.state === "failed").length, [tasks]);
  const lastReportClock = formatClock(reportsUpdatedAt);

  const liveMessage = useMemo(() => {
    if (tasks.length === 0) return "";
    return tasks
      .slice(0, 4)
      .map((task) => `${titleize(task.name)} ${task.state}`)
      .join(". ");
  }, [tasks]);

  const summaryParts: string[] = [];
  if (hasActive) summaryParts.push(`${activeTasks.length} running`);
  else if (failedCount > 0) summaryParts.push(`${failedCount} failed`);
  else if (tasks.length > 0) summaryParts.push("all tasks idle");
  else summaryParts.push("idle");
  summaryParts.push(lastReportClock ? `last report ${lastReportClock}` : "no report yet");

  const actions: Array<{ key: ActionKey; label: string; description: string; danger?: boolean }> = [
    {
      key: "daily_batch",
      label: "Daily Batch",
      description: `Fans several jobs out concurrently for ${longDate(focusedDate)} — report generation, confirmation emails and availability updates.`,
    },
    {
      key: "send_reminders",
      label: "Send Reminders",
      description: `Batch-sends reminder emails to every player booked on ${longDate(focusedDate)}.`,
    },
    {
      key: "cleanup",
      label: "Cleanup",
      description: "Permanently deletes past reservations from the server. This cannot be undone.",
      danger: true,
    },
    {
      key: "worker",
      label: "Worker Sync",
      description: `Runs the background worker for ${longDate(focusedDate)} to re-sync derived booking state.`,
    },
  ];

  const openDay = (metric: ReportMetric, expected: number) =>
    setDrill({ metric, dates: [focusedDate], expected });

  // ===== 렌더 =====

  return (
    <section
      aria-label="Operations"
      className="rounded-md border border-[#d4d4d8] bg-white text-xs text-[#1f2328]"
    >
      <h2 className="sr-only">Operations</h2>

      <button
        type="button"
        onClick={toggleOpen}
        aria-expanded={open}
        aria-controls={open ? bodyId : undefined}
        className="flex min-h-11 w-full items-center gap-2 px-3 text-left hover:bg-[#f7f7f9] lg:min-h-0 lg:py-2"
      >
        <span aria-hidden="true" className="text-[#4e5560]">
          {open ? "▾" : "▸"}
        </span>
        <span className="font-bold">Operations</span>
        <span className="min-w-0 truncate text-[#4e5560]">· {summaryParts.join(" · ")}</span>
        {hasActive ? (
          <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-[#0034c9]" aria-hidden="true" />
        ) : null}
        {offline ? (
          <span className="shrink-0 rounded-full bg-[#f7ebe6] px-1.5 py-px text-[10px] font-bold text-[#8a3f26]">
            Offline
          </span>
        ) : null}
        <span className="ml-auto shrink-0 font-bold text-[#4533ff]">{open ? "Hide" : "Show"}</span>
      </button>

      {open ? (
        <div id={bodyId} className="border-t border-[#ececf0]">
          <div
            role="tablist"
            aria-label="Operations sections"
            className="flex items-center gap-1 border-b border-[#ececf0] px-3 pt-2"
          >
            {TABS.map((entry, index) => {
              const selected = entry.key === tab;
              return (
                <button
                  key={entry.key}
                  ref={(node) => {
                    tabRefs.current[index] = node;
                  }}
                  type="button"
                  role="tab"
                  id={`${uid}-tab-${entry.key}`}
                  aria-selected={selected}
                  aria-controls={`${uid}-panel-${entry.key}`}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => setTab(entry.key)}
                  onKeyDown={onTabKeyDown}
                  className={`-mb-px border-b-2 px-2 py-1.5 font-bold ${
                    selected
                      ? "border-[#4533ff] text-[#4533ff]"
                      : "border-transparent text-[#4e5560] hover:text-[#1f2328]"
                  }`}
                >
                  {entry.label}
                </button>
              );
            })}
          </div>

          {tab === "reports" ? (
            <div
              role="tabpanel"
              id={`${uid}-panel-reports`}
              aria-labelledby={`${uid}-tab-reports`}
              className="space-y-3 p-3"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-bold">{longDate(focusedDate)}</span>
                <span className="text-[#4e5560]">
                  {reportsLoading
                    ? "Loading…"
                    : reportsUpdatedAt
                      ? `Updated ${formatClock(reportsUpdatedAt, true)}`
                      : "Not loaded yet"}
                </span>
                <button
                  type="button"
                  onClick={() => setReportsNonce((value) => value + 1)}
                  disabled={offline || reportsLoading}
                  className="ml-auto rounded border border-[#d4d4d8] px-2 py-1 font-bold text-[#4533ff] hover:bg-[#f2f2f4] disabled:cursor-not-allowed disabled:text-[#9a9aa4]"
                >
                  Refresh
                </button>
              </div>

              {offline ? (
                <p className="rounded border border-[#e2c7bb] bg-[#fbf1ed] px-2 py-1.5 text-[#8a3f26]">
                  The operations service is unreachable — reports will reload once the connection is back.
                </p>
              ) : null}

              {reportsError ? (
                <ErrorRow message={reportsError} onRetry={() => setReportsNonce((value) => value + 1)} />
              ) : null}

              {dailyReport ? (
                <div className="space-y-2">
                  <div className="flex items-baseline justify-between">
                    <span className="font-bold">Occupancy</span>
                    <button
                      type="button"
                      onClick={() => openDay("booked", safeNumber(dailyReport.booked_slots))}
                      className="tabular-nums text-[#4e5560] hover:text-[#4533ff] hover:underline"
                    >
                      {occupancyPercent(dailyReport).toFixed(0)}% ·{" "}
                      {safeNumber(dailyReport.booked_slots)} booked ·{" "}
                      {safeNumber(dailyReport.available_slots)} available
                    </button>
                  </div>
                  <OccupancyBar
                    percent={occupancyPercent(dailyReport)}
                    label={`Occupancy ${occupancyPercent(dailyReport).toFixed(0)} percent — ${safeNumber(
                      dailyReport.booked_slots,
                    )} of ${safeNumber(dailyReport.total_slots)} slots booked`}
                  />

                  <div className="grid grid-cols-3 gap-1.5">
                    <Stat
                      label="Total"
                      value={money(safeNumber(dailyReport.total_revenue))}
                      onClick={() => openDay("total", safeNumber(dailyReport.total_revenue))}
                    />
                    <Stat
                      label="Collected"
                      value={money(safeNumber(dailyReport.collected_revenue))}
                      onClick={() => openDay("collected", safeNumber(dailyReport.collected_revenue))}
                    />
                    <Stat
                      label="Outstanding"
                      value={money(safeNumber(dailyReport.outstanding_revenue))}
                      onClick={() => openDay("outstanding", safeNumber(dailyReport.outstanding_revenue))}
                    />
                  </div>

                  <div className="grid grid-cols-4 gap-1.5">
                    <Stat
                      label="Checked in"
                      value={String(safeNumber(dailyReport.checked_in))}
                      onClick={() => openDay("checked_in", safeNumber(dailyReport.checked_in))}
                    />
                    <Stat
                      label="Cancelled"
                      value={String(safeNumber(dailyReport.cancelled))}
                      onClick={() => openDay("cancelled", safeNumber(dailyReport.cancelled))}
                    />
                    <Stat
                      label="No show"
                      value={String(safeNumber(dailyReport.no_show))}
                      onClick={() => openDay("no_show", safeNumber(dailyReport.no_show))}
                    />
                    <Stat
                      label="Carts"
                      value={String(safeNumber(dailyReport.carts))}
                      onClick={() => openDay("carts", safeNumber(dailyReport.carts))}
                    />
                  </div>
                </div>
              ) : !reportsLoading && !reportsError ? (
                <p className="text-[#4e5560]">No daily report available for this date.</p>
              ) : null}

              {weekReport ? (
                <div className="space-y-1.5">
                  <div className="flex items-baseline justify-between">
                    <span className="font-bold">
                      Week {weekReport.from || weekFrom} → {weekReport.to || weekTo}
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        setDrill({
                          metric: "total",
                          dates: (weekReport.days ?? []).map((day) => day.date),
                          expected: safeNumber(weekReport.summary?.total_revenue),
                        })
                      }
                      className="tabular-nums text-[#4e5560] hover:text-[#4533ff] hover:underline"
                    >
                      {money(safeNumber(weekReport.summary?.total_revenue))} ·{" "}
                      {clampPercent(safeNumber(weekReport.summary?.average_occupancy)).toFixed(0)}% avg
                    </button>
                  </div>
                  <ul className="space-y-1">
                    {(weekReport.days ?? []).map((day, index) => {
                      const percent = occupancyPercent(day);
                      return (
                        <li key={day?.date ?? `day-${index}`}>
                          <button
                            type="button"
                            disabled={!day?.date}
                            onClick={() =>
                              setDrill({
                                metric: "total",
                                dates: [day.date],
                                expected: safeNumber(day.total_revenue),
                              })
                            }
                            className="flex w-full items-center gap-2 text-left hover:text-[#4533ff]"
                          >
                            <span className="w-12 shrink-0 text-[#4e5560]">
                              {dayLabel(day?.date)}
                            </span>
                            <span className="h-1.5 min-w-0 flex-1 rounded-full bg-[#ececf0]" aria-hidden="true">
                              <span
                                className="block h-full rounded-full bg-[#4533ff]"
                                style={{ width: `${percent}%` }}
                              />
                            </span>
                            <span className="w-10 shrink-0 text-right tabular-nums">{percent.toFixed(0)}%</span>
                            <span className="w-16 shrink-0 text-right tabular-nums">
                              {money(safeNumber(day?.total_revenue))}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : (
            <div
              role="tabpanel"
              id={`${uid}-panel-tasks`}
              aria-labelledby={`${uid}-tab-tasks`}
              className="space-y-2 p-3"
            >
              <p className="sr-only" role="status" aria-live="polite">
                {liveMessage}
              </p>

              {offline ? (
                <p className="rounded border border-[#e2c7bb] bg-[#fbf1ed] px-2 py-1.5 text-[#8a3f26]">
                  The operations service is unreachable. Actions are disabled until the tee sheet reconnects.
                </p>
              ) : null}

              <div className="grid gap-1.5 sm:grid-cols-2">
                {actions.map((action) => {
                  const isCleanup = action.key === "cleanup";
                  const pending = pendingAction === action.key;
                  return (
                    <div
                      key={action.key}
                      className="flex flex-col gap-1.5 rounded border border-[#ececf0] p-2"
                    >
                      <div className="font-bold">{action.label}</div>
                      <p className="text-[#4e5560]">{action.description}</p>
                      {isCleanup && confirmCleanup ? (
                        <div className="rounded border border-[#e2c7bb] bg-[#fbf1ed] p-1.5 text-[#8a3f26]">
                          <p className="font-bold">Delete past reservations?</p>
                          <p className="mt-0.5">
                            Every reservation whose date has already passed will be removed from the server,
                            together with its players and audit trail. This cannot be undone.
                          </p>
                          <div className="mt-1.5 flex gap-1.5">
                            <button
                              type="button"
                              disabled={offline || pending}
                              onClick={() => {
                                setConfirmCleanup(false);
                                void runAction("cleanup");
                              }}
                              className="rounded bg-[#8a3f26] px-2 py-1 font-bold text-white hover:bg-[#733120] disabled:cursor-not-allowed disabled:opacity-60"
                            >
                              Yes, delete them
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmCleanup(false)}
                              className="rounded border border-[#d4d4d8] px-2 py-1 font-bold text-[#4e5560] hover:bg-white"
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        <button
                          type="button"
                          disabled={offline || pending}
                          onClick={() => (isCleanup ? setConfirmCleanup(true) : void runAction(action.key))}
                          className={`mt-auto self-start rounded px-2 py-1 font-bold disabled:cursor-not-allowed disabled:opacity-60 ${
                            action.danger
                              ? "border border-[#8a3f26] text-[#8a3f26] hover:bg-[#fbf1ed]"
                              : "bg-[#4533ff] text-white hover:bg-[#3527d6]"
                          }`}
                        >
                          {pending ? "Starting…" : action.label}
                        </button>
                      )}
                      {actionError && actionError.key === action.key ? (
                        <ErrorRow message={actionError.message} onRetry={retryAction} />
                      ) : null}
                    </div>
                  );
                })}
              </div>

              {pollError ? <ErrorRow message={pollError} onRetry={resumePolling} /> : null}

              <div className="flex flex-wrap items-center gap-2 text-[#4e5560]">
                {shouldPoll ? (
                  <span className="inline-flex items-center gap-1">
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#0034c9]" aria-hidden="true" />
                    Watching {activeTasks.length} task{activeTasks.length === 1 ? "" : "s"} · refreshing every 1.5s
                  </span>
                ) : hasActive && documentHidden ? (
                  <span>Polling paused while this tab is in the background.</span>
                ) : (
                  <span>Not polling — no task is running.</span>
                )}
                {meta ? (
                  <span className="ml-auto">
                    Service {meta.status || "unknown"} · {safeNumber(meta.total_bookings)} bookings
                    {formatClock(meta.timestamp, true) ? ` · ${formatClock(meta.timestamp, true)}` : ""}
                  </span>
                ) : null}
              </div>

              {tasks.length === 0 ? (
                <p className="rounded border border-dashed border-[#d4d4d8] px-2 py-3 text-center text-[#4e5560]">
                  No tasks yet — run one of the operations above to see it here.
                </p>
              ) : (
                <ul className="rounded border border-[#ececf0]">
                  {tasks.map((task) => {
                    const expanded = expandedTaskId === task.id;
                    const rowId = `${uid}-task-${task.id}`;
                    const duration = isTerminal(task.state) ? formatDuration(task.duration_ms) : "";
                    const fanOut = extractFanOut(task);
                    return (
                      <li key={task.id} className="border-t border-[#ececf0] first:border-t-0">
                        <button
                          type="button"
                          onClick={() => setExpandedTaskId(expanded ? null : task.id)}
                          aria-expanded={expanded}
                          aria-controls={expanded ? rowId : undefined}
                          className="flex w-full items-start gap-2 px-2 py-1.5 text-left hover:bg-[#f7f7f9]"
                        >
                          <span aria-hidden="true" className="mt-px text-[#4e5560]">
                            {expanded ? "▾" : "▸"}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="flex flex-wrap items-center gap-2">
                              <span className="font-bold">{titleize(task.name)}</span>
                              <StateBadge state={task.state} />
                              {duration ? (
                                <span className="tabular-nums text-[#4e5560]">{duration}</span>
                              ) : null}
                            </span>
                            {task.detail ? (
                              <span className="mt-0.5 block truncate text-[#4e5560]">{task.detail}</span>
                            ) : null}
                          </span>
                        </button>

                        {expanded ? (
                          <div id={rowId} className="space-y-2 border-t border-[#f2f2f4] px-2 py-2">
                            <div className="flex flex-wrap gap-x-4 gap-y-1 text-[#4e5560]">
                              <span>Created {formatClock(task.created_at, true) || "—"}</span>
                              <span>Started {formatClock(task.started_at, true) || "—"}</span>
                              <span>Finished {formatClock(task.finished_at, true) || "—"}</span>
                            </div>

                            {fanOut ? <FanOutView fanOut={fanOut} /> : null}

                            {task.error ? (
                              <p className="rounded border border-[#e2c7bb] bg-[#fbf1ed] px-2 py-1.5 text-[#8a3f26]">
                                {task.error}
                              </p>
                            ) : null}

                            {task.result && typeof task.result === "object" ? (
                              <ResultView result={task.result as Record<string, unknown>} />
                            ) : !task.error ? (
                              <p className="text-[#4e5560]">
                                {isTerminal(task.state) ? "No result payload." : "Still running…"}
                              </p>
                            ) : null}
                          </div>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}
        </div>
      ) : null}

      {drill ? (
        <ReportDrilldown drill={drill} bookings={controller.bookings} onClose={() => setDrill(null)} />
      ) : null}
    </section>
  );
}
