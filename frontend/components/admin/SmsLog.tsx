"use client";

/**
 * Calls & SMS 의 "문자" 와 "수신 거부" 탭. 원본은 Supabase `pelham_sms_messages`(0058)·`pelham_marketing_optouts`(0047),
 * FastAPI 가 직원 확인 뒤 대신 읽는다(`lib/calls/api.ts`).
 *
 * 문자 탭: 최근 문자(보낸 것·받은 것) 새것부터. 번호를 누르면 그 번호와 주고받은 문자만 — 대화처럼 읽힌다.
 */

import { useCallback, useEffect, useState } from "react";

import {
  type SmsRow,
  fetchSms,
  fetchSmsOptOuts,
  isoClubDateTime,
  prettyPhone,
  smsTemplateLabel,
} from "@/lib/calls/api";

const STATUS_TONE: Record<string, string> = {
  delivered: "bg-[#e3f5e8] text-[#16723a]",
  received: "bg-[#e6efff] text-[#2449b3]",
  sent: "bg-[#f0f1f3] text-[#4e5560]",
  queued: "bg-[#f0f1f3] text-[#4e5560]",
  accepted: "bg-[#f0f1f3] text-[#4e5560]",
  sending: "bg-[#f0f1f3] text-[#4e5560]",
  skipped: "bg-[#fff4dc] text-[#8a5a00]",
  failed: "bg-[#fdeaea] text-[#a12a2a]",
  undelivered: "bg-[#fdeaea] text-[#a12a2a]",
};

const STATUS_LABEL: Record<string, string> = {
  delivered: "전달됨",
  received: "받음",
  sent: "보냄",
  queued: "보내는 중",
  accepted: "보내는 중",
  sending: "보내는 중",
  skipped: "안 보냄",
  failed: "실패",
  undelivered: "전달 실패",
};

function MemoryNote({ source }: { source: "db" | "memory" | null }) {
  if (source !== "memory") return null;
  return (
    <p className="border border-[#f3dfa8] bg-[#fffaf0] px-3 py-2 text-sm text-[#8a5a00]">
      DB 에서 읽지 못해 서버가 기억하는 최근 기록만 보입니다. Supabase 에 0058 을 실행했는지 확인하세요.
    </p>
  );
}

export function SmsLog({ refreshKey }: { refreshKey: number }) {
  const [rows, setRows] = useState<SmsRow[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [source, setSource] = useState<"db" | "memory" | null>(null);
  const [phone, setPhone] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const fetchPage = useCallback(
    (before?: string | null) =>
      fetchSms({ phone, before })
        .then((page) => {
          setError("");
          setRows((current) => (before ? [...current, ...page.messages] : page.messages));
          setHasMore(page.has_more);
          setSource(page.source);
        })
        .catch((err) => setError(err instanceof Error ? err.message : "Could not load texts."))
        .finally(() => setLoading(false)),
    [phone],
  );

  // 번호를 고르거나 Refresh 를 누르면 첫 쪽부터 다시.
  useEffect(() => {
    void fetchPage();
  }, [fetchPage, refreshKey]);

  function pickPhone(next: string | null) {
    setLoading(true);
    setRows([]);
    setPhone(next);
  }

  function more() {
    setLoading(true);
    void fetchPage(rows[rows.length - 1]?.created_at);
  }

  return (
    <>
      <MemoryNote source={source} />
      {phone ? (
        <div className="flex items-center gap-3 text-sm">
          <span>
            <strong>{prettyPhone(phone)}</strong> 와 주고받은 문자
          </span>
          <button
            className="border border-[#cfd2d8] bg-white px-3 py-1 text-xs font-bold"
            onClick={() => pickPhone(null)}
            type="button"
          >
            전체 보기
          </button>
        </div>
      ) : null}

      {error ? (
        <p className="border border-[#f0c4c4] bg-[#fdf2f2] px-3 py-2 text-sm text-[#a12a2a]" role="alert">
          {error}
        </p>
      ) : null}

      <div className="min-w-0 overflow-x-auto border border-[#d6d6dc] bg-white">
        <section className="min-w-[760px]">
          <div className="grid grid-cols-[130px_150px_120px_1fr_90px] border-b border-[#d6d6dc] bg-[#d7d5da] px-3 py-2 text-xs font-bold">
            <span>Time</span>
            <span>Phone</span>
            <span>Kind</span>
            <span>Message</span>
            <span>Status</span>
          </div>
          {rows.map((row) => {
            const status = row.status ?? "";
            return (
              <div
                className={`grid grid-cols-[130px_150px_120px_1fr_90px] items-start gap-2 border-b border-[#ececf0] px-3 py-3 text-xs last:border-b-0 ${
                  row.direction === "in" ? "bg-[#f7f9ff]" : ""
                }`}
                key={row.id}
              >
                <span className="font-bold">{isoClubDateTime(row.created_at)}</span>
                <span>
                  {phone ? (
                    <span>{prettyPhone(row.phone)}</span>
                  ) : (
                    <button
                      className="font-bold text-[#4533ff] hover:underline"
                      onClick={() => pickPhone(row.phone)}
                      title="이 번호와 주고받은 문자만 보기"
                      type="button"
                    >
                      {prettyPhone(row.phone)}
                    </button>
                  )}
                  <span className="block text-[#6b7280]">{row.direction === "in" ? "← 받음" : "→ 보냄"}</span>
                </span>
                <span>
                  {smsTemplateLabel(row)}
                  {row.booking_ref ? <span className="block text-[#6b7280]">#{row.booking_ref}</span> : null}
                </span>
                <span className="min-w-0 whitespace-pre-wrap break-words text-[#30353d]">
                  {row.body}
                  {row.media_url ? <span className="block text-[#6b7280]">+ 바코드 이미지</span> : null}
                </span>
                <span>
                  <span
                    className={`inline-block px-2 py-0.5 font-bold ${STATUS_TONE[status] ?? "bg-[#f0f1f3] text-[#4e5560]"}`}
                    title={row.error ?? undefined}
                  >
                    {STATUS_LABEL[status] ?? status}
                  </span>
                  {row.error ? <span className="mt-1 block break-words text-[#a12a2a]">{row.error}</span> : null}
                </span>
              </div>
            );
          })}
          {!loading && !rows.length && !error ? (
            <p className="px-3 py-6 text-center text-sm text-[#6b7280]">아직 문자 기록이 없습니다.</p>
          ) : null}
          {loading && !rows.length ? <p className="px-3 py-6 text-center text-sm text-[#6b7280]">Loading…</p> : null}
        </section>
      </div>

      {hasMore ? (
        <button
          className="justify-self-center border border-[#cfd2d8] bg-white px-4 py-2 text-xs font-bold disabled:opacity-50"
          disabled={loading}
          onClick={more}
          type="button"
        >
          {loading ? "Loading…" : "더 보기"}
        </button>
      ) : null}
    </>
  );
}

export function SmsOptOuts({ refreshKey }: { refreshKey: number }) {
  const [rows, setRows] = useState<{ phone: string; created_at: string | null }[]>([]);
  const [source, setSource] = useState<"db" | "memory" | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    fetchSmsOptOuts()
      .then((page) => {
        setError("");
        setRows(page.opt_outs);
        setSource(page.source);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Could not load opt-outs."))
      .finally(() => setLoading(false));
  }, [refreshKey]);

  return (
    <>
      <p className="text-sm leading-6 text-[#4e5560]">
        STOP 으로 답한 번호입니다. 이 번호에는 예약 확정·리마인더·프로모션을 포함해 어떤 문자도 나가지 않습니다.
        손님이 START 로 답하면 목록에서 빠집니다.
      </p>
      <MemoryNote source={source} />
      {error ? (
        <p className="border border-[#f0c4c4] bg-[#fdf2f2] px-3 py-2 text-sm text-[#a12a2a]" role="alert">
          {error}
        </p>
      ) : null}
      <div className="border border-[#d6d6dc] bg-white">
        <div className="grid grid-cols-[1fr_1fr] border-b border-[#d6d6dc] bg-[#d7d5da] px-3 py-2 text-xs font-bold">
          <span>Phone</span>
          <span>Since</span>
        </div>
        {rows.map((row) => (
          <div className="grid grid-cols-[1fr_1fr] border-b border-[#ececf0] px-3 py-3 text-xs last:border-b-0" key={row.phone}>
            <strong>{prettyPhone(row.phone)}</strong>
            <span>{isoClubDateTime(row.created_at)}</span>
          </div>
        ))}
        {!loading && !rows.length && !error ? (
          <p className="px-3 py-6 text-center text-sm text-[#6b7280]">수신 거부한 번호가 없습니다.</p>
        ) : null}
      </div>
    </>
  );
}
