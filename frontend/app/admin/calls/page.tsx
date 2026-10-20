"use client";

/**
 * Calls & SMS — 탭 셋: AI 전화 예약 통화 기록(ElevenLabs), 문자 기록(0058), 수신 거부(STOP) 번호.
 * 통화 원본은 ElevenLabs(`lib/calls/api.ts`), 문자 탭은 `components/admin/SmsLog.tsx`.
 *
 * 줄을 누르면:
 *   - 티타임을 잡거나 바꾼 통화 → 티 시트에서 그 예약을 연다 (`/teesheet?date=…&booking=…`).
 *   - 나머지 → 오른쪽 패널에 ElevenLabs 의 요약·녹취·녹음을 띄운다.
 * 예약 통화의 녹취도 볼 수 있게 줄 끝에 "통화 내용" 버튼을 따로 둔다.
 */

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

import AdminShell from "@/components/admin/AdminShell";
import { SmsLog, SmsOptOuts } from "@/components/admin/SmsLog";
import {
  type CallDetail,
  type CallRow,
  OUTCOME_LABEL,
  clubDateTime,
  clubDay,
  duration,
  fetchCall,
  fetchCallAudioUrl,
  fetchCalls,
  teeBookingOf,
  teeSheetHref,
} from "@/lib/calls/api";

const OUTCOME_TONE: Record<CallRow["outcome"], string> = {
  booked: "bg-[#e3f5e8] text-[#16723a]",
  modified: "bg-[#e6efff] text-[#2449b3]",
  cancelled: "bg-[#fdeaea] text-[#a12a2a]",
  waitlist: "bg-[#fff4dc] text-[#8a5a00]",
  lost_item: "bg-[#f1ecff] text-[#5b3cc4]",
  transferred: "bg-[#fff0e6] text-[#a4500f]",
  info: "bg-[#f0f1f3] text-[#4e5560]",
};

type Tab = "calls" | "sms" | "optouts";

const TABS: { id: Tab; label: string }[] = [
  { id: "calls", label: "통화" },
  { id: "sms", label: "문자" },
  { id: "optouts", label: "수신 거부" },
];

/** 줄을 누르면 티 시트로 가는 결과. */
const GOES_TO_TEE_SHEET = new Set<CallRow["outcome"]>(["booked", "modified"]);

const TOOL_LABEL: Record<string, string> = {
  identify_caller: "발신자 확인",
  find_tee_times: "빈 시간 찾기",
  hold_tee_time: "자리 잡기",
  release_hold: "자리 반납",
  confirm_booking: "예약 확정",
  lookup_booking: "예약 조회",
  cancel_booking: "예약 취소",
  modify_booking: "예약 변경",
  get_rates: "요금 조회",
  send_info_sms: "안내 문자",
  report_lost_item: "분실물 접수",
  join_waitlist: "대기 등록",
  find_sim_times: "시뮬레이터 빈 시간",
  book_sim_bay: "시뮬레이터 예약",
  lookup_sim_booking: "시뮬레이터 조회",
  cancel_sim_booking: "시뮬레이터 취소",
  transfer_to_number: "직원 연결",
  end_call: "통화 종료",
};

function toolLabel(name: string): string {
  return TOOL_LABEL[name] ?? name;
}

export default function CallsPage() {
  const router = useRouter();
  const [calls, setCalls] = useState<CallRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("calls");
  // 문자·수신 거부 탭은 각자 읽는다. Refresh 를 누르면 이 숫자가 바뀌어 다시 읽는다.
  const [smsRefresh, setSmsRefresh] = useState(0);

  // 오늘(클럽 시간). 지표는 오늘 걸려 온 통화만 센다. 새로고침할 때 다시 구한다.
  const [today, setToday] = useState(() => clubDay(Date.now() / 1000));

  const apply = useCallback((page: Awaited<ReturnType<typeof fetchCalls>>, append: boolean) => {
    setCalls((current) => (append ? [...current, ...page.calls] : page.calls));
    setCursor(page.next_cursor);
    setHasMore(page.has_more);
  }, []);

  const fail = useCallback((err: unknown) => {
    setError(err instanceof Error ? err.message : "Could not load calls.");
  }, []);

  function load(next?: string | null) {
    setLoading(true);
    setError("");
    if (!next) setToday(clubDay(Date.now() / 1000));
    fetchCalls(next)
      .then((page) => apply(page, Boolean(next)))
      .catch(fail)
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    fetchCalls()
      .then((page) => apply(page, false))
      .catch(fail)
      .finally(() => setLoading(false));
  }, [apply, fail]);

  const metrics = useMemo(() => {
    const todays = calls.filter((c) => clubDay(c.started_at) === today);
    const count = (outcome: CallRow["outcome"]) => todays.filter((c) => c.outcome === outcome).length;
    return [
      { label: "오늘 AI 통화", value: todays.length },
      { label: "예약 성사", value: count("booked") },
      { label: "직원 연결", value: count("transferred") },
      { label: "안내 문자", value: todays.filter((c) => c.tools.includes("send_info_sms")).length },
    ];
  }, [calls, today]);

  async function openRow(call: CallRow) {
    if (!GOES_TO_TEE_SHEET.has(call.outcome)) {
      setOpenId(call.id);
      return;
    }
    // 예약 번호와 날짜는 녹취 속 도구 결과에만 있다. 상세를 한 번 읽고 넘어간다.
    setOpening(call.id);
    try {
      const booking = teeBookingOf(await fetchCall(call.id));
      if (booking) {
        router.push(teeSheetHref(booking));
        return;
      }
    } catch {
      // 못 읽으면 패널에서 이유를 보여 준다.
    } finally {
      setOpening(null);
    }
    setOpenId(call.id);
  }

  return (
    <AdminShell
      actions={
        <button
          className="tap-target bg-[#4533ff] px-4 py-1.5 text-xs font-bold text-white disabled:opacity-50"
          disabled={tab === "calls" && loading}
          onClick={() => (tab === "calls" ? load() : setSmsRefresh((n) => n + 1))}
          type="button"
        >
          {tab === "calls" && loading ? "Loading…" : "Refresh"}
        </button>
      }
      title="Calls & SMS"
    >
      <section className="border-b border-[#d4d4d8] bg-white px-4 py-4">
        <p className="max-w-4xl text-sm leading-6 text-[#4e5560]">
          AI 전화 예약 통화 기록입니다 (ElevenLabs). 예약이 잡힌 통화를 누르면 티 시트에서 그 예약이 열리고,
          나머지 통화는 요약·녹취·녹음을 볼 수 있습니다. 문자 탭에는 손님에게 보낸 문자와 받은 문자가 모두 남습니다.
        </p>
        <div className="mt-3 flex gap-1" role="tablist">
          {TABS.map((t) => (
            <button
              aria-selected={tab === t.id}
              className={`px-4 py-1.5 text-xs font-bold ${
                tab === t.id ? "bg-[#1f2329] text-white" : "border border-[#cfd2d8] bg-white text-[#30353d]"
              }`}
              key={t.id}
              onClick={() => setTab(t.id)}
              role="tab"
              type="button"
            >
              {t.label}
            </button>
          ))}
        </div>
      </section>

      {tab === "sms" ? (
        <section className="grid gap-4 p-4">
          <SmsLog refreshKey={smsRefresh} />
        </section>
      ) : null}
      {tab === "optouts" ? (
        <section className="grid gap-4 p-4">
          <SmsOptOuts refreshKey={smsRefresh} />
        </section>
      ) : null}

      <section className={`grid gap-4 p-4 ${tab === "calls" ? "" : "hidden"}`}>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {metrics.map((metric) => (
            <article className="border border-[#d6d6dc] bg-white p-3" key={metric.label}>
              <p className="text-xs font-bold text-[#6b7280] uppercase">{metric.label}</p>
              <p className="mt-2 text-2xl font-semibold">{loading && !calls.length ? "–" : metric.value}</p>
            </article>
          ))}
        </div>

        {error ? (
          <p className="border border-[#f0c4c4] bg-[#fdf2f2] px-3 py-2 text-sm text-[#a12a2a]" role="alert">
            {error}
          </p>
        ) : null}

        <div className="min-w-0 overflow-x-auto border border-[#d6d6dc] bg-white">
          <section className="min-w-[720px]">
            <div className="grid grid-cols-[150px_1fr_110px_120px] border-b border-[#d6d6dc] bg-[#d7d5da] px-3 py-2 text-xs font-bold">
              <span>Time</span>
              <span>Call</span>
              <span>Result</span>
              <span className="text-right">Details</span>
            </div>
            {calls.map((call) => (
              <div
                className="grid cursor-pointer grid-cols-[150px_1fr_110px_120px] items-center gap-2 border-b border-[#ececf0] px-3 py-3 text-xs last:border-b-0 hover:bg-[#f7f7fb]"
                key={call.id}
                onClick={() => void openRow(call)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    void openRow(call);
                  }
                }}
                role="button"
                tabIndex={0}
              >
                <span>
                  <strong className="block">{clubDateTime(call.started_at)}</strong>
                  <span className="text-[#6b7280]">{duration(call.duration)}</span>
                </span>
                <span className="min-w-0">
                  <strong className="block truncate">{call.title || "Call"}</strong>
                  <span className="line-clamp-2 text-[#5d6673]">{call.summary}</span>
                </span>
                <span>
                  <span className={`inline-block px-2 py-0.5 font-bold ${OUTCOME_TONE[call.outcome]}`}>
                    {OUTCOME_LABEL[call.outcome]}
                  </span>
                </span>
                <span className="flex justify-end">
                  {GOES_TO_TEE_SHEET.has(call.outcome) ? (
                    <button
                      className="border border-[#cfd2d8] bg-white px-3 py-1.5 font-bold"
                      onClick={(event) => {
                        event.stopPropagation();
                        setOpenId(call.id);
                      }}
                      type="button"
                    >
                      {opening === call.id ? "Opening…" : "통화 내용"}
                    </button>
                  ) : (
                    <span className="font-bold text-[#4533ff]">보기 →</span>
                  )}
                </span>
              </div>
            ))}
            {!loading && !calls.length && !error ? (
              <p className="px-3 py-6 text-center text-sm text-[#6b7280]">아직 통화 기록이 없습니다.</p>
            ) : null}
          </section>
        </div>

        {hasMore ? (
          <button
            className="justify-self-center border border-[#cfd2d8] bg-white px-4 py-2 text-xs font-bold disabled:opacity-50"
            disabled={loading}
            onClick={() => load(cursor)}
            type="button"
          >
            {loading ? "Loading…" : "더 보기"}
          </button>
        ) : null}
      </section>

      {openId ? <CallPanel id={openId} onClose={() => setOpenId(null)} /> : null}
    </AdminShell>
  );
}

function CallPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const [detail, setDetail] = useState<CallDetail | null>(null);
  const [error, setError] = useState("");
  const [audioUrl, setAudioUrl] = useState("");
  const [audioState, setAudioState] = useState<"idle" | "loading" | "error">("idle");

  useEffect(() => {
    let live = true;
    fetchCall(id)
      .then((d) => live && setDetail(d))
      .catch((err) => live && setError(err instanceof Error ? err.message : "Could not load the call."));
    return () => {
      live = false;
    };
  }, [id]);

  useEffect(() => {
    return () => {
      if (audioUrl) URL.revokeObjectURL(audioUrl);
    };
  }, [audioUrl]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function loadAudio() {
    setAudioState("loading");
    try {
      setAudioUrl(await fetchCallAudioUrl(id));
      setAudioState("idle");
    } catch {
      setAudioState("error");
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30" onClick={onClose}>
      <aside
        aria-label="Call details"
        className="flex h-full w-full max-w-[560px] flex-col bg-white shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-3 border-b border-[#d6d6dc] px-4 py-3">
          <div className="min-w-0">
            <p className="text-xs font-bold text-[#6b7280] uppercase">Call</p>
            <h2 className="truncate text-base font-semibold">{detail?.title || (error ? "Error" : "Loading…")}</h2>
          </div>
          <button className="tap-target border border-[#cfd2d8] px-3 py-1.5 text-xs font-bold" onClick={onClose} type="button">
            Close
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 text-sm">
          {error ? <p className="text-[#a12a2a]">{error}</p> : null}
          {detail ? (
            <div className="grid gap-4">
              <dl className="grid grid-cols-[90px_1fr] gap-x-3 gap-y-1 text-xs">
                <dt className="font-bold text-[#6b7280]">시각</dt>
                <dd>{clubDateTime(detail.started_at)} · {duration(detail.duration)}</dd>
                <dt className="font-bold text-[#6b7280]">발신번호</dt>
                <dd>{detail.caller || "—"}</dd>
                <dt className="font-bold text-[#6b7280]">결과</dt>
                <dd>
                  <span className={`inline-block px-2 py-0.5 font-bold ${OUTCOME_TONE[detail.outcome]}`}>
                    {OUTCOME_LABEL[detail.outcome]}
                  </span>
                  {detail.termination_reason ? (
                    <span className="ml-2 text-[#6b7280]">{detail.termination_reason}</span>
                  ) : null}
                </dd>
              </dl>

              {detail.bookings.length ? (
                <section className="grid gap-2">
                  <h3 className="text-xs font-bold text-[#6b7280] uppercase">이 통화의 예약</h3>
                  {detail.bookings.map((b, index) => (
                    <div className="flex items-center justify-between gap-3 border border-[#d6d6dc] px-3 py-2 text-xs" key={`${b.booking_id}-${index}`}>
                      <span>
                        <strong>{b.kind === "sim" ? "시뮬레이터" : "티타임"} · {OUTCOME_LABEL[b.action]}</strong>
                        <span className="block text-[#5d6673]">
                          {[b.date, b.time, b.name, b.party_size ? `${b.party_size}인` : "", b.confirmation_code]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      </span>
                      {b.kind === "tee" ? (
                        <a className="shrink-0 bg-[#4533ff] px-3 py-1.5 font-bold text-white" href={teeSheetHref(b)}>
                          티 시트에서 열기
                        </a>
                      ) : null}
                    </div>
                  ))}
                </section>
              ) : null}

              {detail.summary ? (
                <section>
                  <h3 className="mb-1 text-xs font-bold text-[#6b7280] uppercase">요약</h3>
                  <p className="leading-6 text-[#2b2f36]">{detail.summary}</p>
                </section>
              ) : null}

              {detail.has_audio ? (
                <section>
                  <h3 className="mb-1 text-xs font-bold text-[#6b7280] uppercase">녹음</h3>
                  {audioUrl ? (
                    <audio autoPlay className="w-full" controls src={audioUrl} />
                  ) : (
                    <button
                      className="border border-[#cfd2d8] px-3 py-1.5 text-xs font-bold disabled:opacity-50"
                      disabled={audioState === "loading"}
                      onClick={() => void loadAudio()}
                      type="button"
                    >
                      {audioState === "loading" ? "불러오는 중…" : audioState === "error" ? "다시 시도" : "▶ 녹음 듣기"}
                    </button>
                  )}
                </section>
              ) : null}

              <section className="grid gap-2">
                <h3 className="text-xs font-bold text-[#6b7280] uppercase">녹취</h3>
                {detail.transcript.map((turn, index) => (
                  <Turn key={index} turn={turn} />
                ))}
              </section>
            </div>
          ) : null}
        </div>
      </aside>
    </div>
  );
}

function Turn({ turn }: { turn: CallDetail["transcript"][number] }) {
  const agent = turn.role === "agent";
  const at = turn.at != null ? `${Math.floor(turn.at / 60)}:${String(Math.floor(turn.at % 60)).padStart(2, "0")}` : "";
  return (
    <div className={`flex flex-col ${agent ? "items-start" : "items-end"}`}>
      {turn.message ? (
        <div className={`max-w-[85%] px-3 py-2 text-sm leading-5 ${agent ? "bg-[#f0f1f3]" : "bg-[#e6e3ff]"}`}>
          <span className="mb-0.5 block text-[10px] font-bold text-[#6b7280] uppercase">
            {agent ? "AI" : "Caller"} {at}
          </span>
          {turn.message}
        </div>
      ) : null}
      {turn.tool_results.map((result, index) => (
        <details className="mt-1 max-w-[85%] text-xs" key={`r${index}`}>
          <summary className={`cursor-pointer font-bold ${result.error ? "text-[#a12a2a]" : "text-[#4533ff]"}`}>
            ⚙ {toolLabel(result.name)}
            {result.error ? " (실패)" : ""}
          </summary>
          <pre className="mt-1 overflow-x-auto bg-[#f7f7fb] p-2 text-[11px] whitespace-pre-wrap">{result.result}</pre>
        </details>
      ))}
      {!turn.tool_results.length
        ? turn.tool_calls.map((call, index) => (
            <span className="mt-1 text-xs font-bold text-[#4533ff]" key={`c${index}`}>
              ⚙ {toolLabel(call.name)}
            </span>
          ))
        : null}
    </div>
  );
}
