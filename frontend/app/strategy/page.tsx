"use client";

/**
 * 전략 보고서 페이지 — 대표님 보고와 바깥 공유용(2026-10-25 클럽 요청).
 *
 * - `/strategy` : 비밀번호 숫자(/view 와 같은 2222)만 넣으면 열람 계정(reports-view@, 0103)으로 로그인해
 *   전략 보고서 보관함(0113)을 연다 — 목록, 나레이션 프레젠테이션, 전체 글, 공유 링크. 어드민 메뉴는 거치지 않는다.
 *   이미 AI 마케팅을 볼 수 있는 계정으로 로그인돼 있으면 숫자 없이 바로 열린다.
 * - `/strategy?t=토큰` : 공유 링크. 로그인 없이 그 보고서 한 건만(`pelham_ai_marketing_shared_report`).
 *   나레이션도 그 보고서의 대본만 읽힌다(Fly 가 확인한다).
 *
 * 정적 export 라 경로(/strategy/토큰)가 아니라 ?t= 로 받는다. `useSearchParams` 는 Suspense 안에서만 쓴다
 * (없으면 `next build` 가 실패한다 — /book/lookup 과 같다).
 */

import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState, type FormEvent, type ReactNode } from "react";

import { StrategyBody, StrategyDeck } from "@/components/aiMarketing/StrategyDeck";
import { StrategyReports } from "@/components/aiMarketing/StrategyReports";
import { Button, Chip, ErrorNote, SkeletonRows } from "@/components/retail/ui";
import { aiMarketingApi, type SharedReport } from "@/lib/aiMarketing/api";
import { getLang, setLang } from "@/lib/i18n/engine";
import { CLUB } from "@/lib/nav";
import { ApiError } from "@/lib/teeSheet/api";
import { getSession, signIn, signOut } from "@/lib/teeSheet/session";

/** 0103 이 만드는 열람 계정 — /view 와 같다. 숫자는 코드에 없다(0103 이 정한다). */
const VIEW_EMAIL = "reports-view@pelhamhills.ca";
const VIEW_PREFIX = "pelham-view-";

export default function StrategyPage() {
  return (
    <main className="min-h-[100dvh] bg-[#f3f5f1] text-[#1f2328]">
      <Suspense fallback={null}>
        <StrategyRoute />
      </Suspense>
    </main>
  );
}

function StrategyRoute() {
  const token = (useSearchParams().get("t") ?? "").trim();
  return token ? <SharedView token={token} /> : <ArchiveGate />;
}

function Header({ right }: { right?: ReactNode }) {
  return (
    <header className="flex flex-wrap items-center justify-between gap-2 bg-[#14201a] px-4 py-3 text-white">
      <div>
        <p className="text-[11px] font-bold tracking-wide text-[#9fb5a8] uppercase">AI Manager Marketing Strategies</p>
        <h1 className="text-lg font-bold">{`${CLUB.shortName} · Strategy reports`}</h1>
      </div>
      {right}
    </header>
  );
}

// ===== 숫자로 여는 보관함 =================================================

function ArchiveGate() {
  // null = 확인 중, false = 숫자가 필요하다, true = 열린다.
  const [allowed, setAllowed] = useState<boolean | null>(() => (getSession() ? null : false));
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (allowed !== null) return;
    let cancelled = false;
    aiMarketingApi.access().then(
      (value) => {
        if (!cancelled) setAllowed(value);
      },
      () => {
        if (!cancelled) setAllowed(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [allowed]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || !pin) return;
    setBusy(true);
    setError("");
    try {
      await signIn(VIEW_EMAIL, VIEW_PREFIX + pin);
      setAllowed(null);
    } catch (cause) {
      setPin("");
      setError(
        cause instanceof ApiError && (cause.status === 400 || cause.status === 401)
          ? "비밀번호가 올바르지 않습니다."
          : cause instanceof ApiError
            ? cause.message
            : "로그인에 실패했습니다. 잠시 후 다시 시도해 주세요.",
      );
    } finally {
      setBusy(false);
    }
  };

  if (allowed === null) {
    return (
      <>
        <Header />
        <div className="p-4">
          <SkeletonRows count={4} />
        </div>
      </>
    );
  }

  if (!allowed) {
    return (
      <div className="grid min-h-[100dvh] place-items-center bg-[#111315] px-4 py-10">
        <div className="w-full max-w-[320px]">
          <p className="mb-4 text-sm font-bold text-white">{`${CLUB.shortName} · Strategy reports`}</p>
          <form className="bg-white p-5 shadow-sm" onSubmit={submit}>
            <label className="block text-base font-bold" htmlFor="strategy-pin">
              비밀번호
            </label>
            <input
              autoComplete="off"
              autoFocus
              className="mt-3 h-12 w-full border border-[#d4d4d8] px-3 text-center text-2xl tracking-[0.4em]"
              id="strategy-pin"
              inputMode="numeric"
              name="pin"
              onChange={(event) => setPin(event.target.value.trim())}
              required
              type="password"
              value={pin}
            />
            {error ? (
              <p className="mt-3 border border-[#f0b4b4] bg-[#fdf1f1] p-2 text-xs leading-5 text-[#8c1d1d]" role="alert">
                {error}
              </p>
            ) : null}
            <button
              className="mt-4 h-11 w-full bg-[#1a7f4b] text-sm font-bold text-white disabled:opacity-60"
              disabled={busy}
              type="submit"
            >
              {busy ? "확인 중…" : "열기"}
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <>
      <Header
        right={
          <Button
            onClick={() => {
              void signOut().finally(() => setAllowed(false));
            }}
          >
            Sign out
          </Button>
        }
      />
      <div className="mx-auto grid max-w-[1120px] gap-3 p-4">
        <StrategyReports />
      </div>
    </>
  );
}

// ===== 공유 링크 ==========================================================

function SharedView({ token }: { token: string }) {
  const [report, setReport] = useState<SharedReport | null>(null);
  const [error, setError] = useState("");
  const [view, setView] = useState<"deck" | "text">("deck");
  const [note, setNote] = useState("");

  useEffect(() => {
    let cancelled = false;
    aiMarketingApi.shared(token).then(
      (value) => {
        if (cancelled) return;
        setReport(value);
        // 화면 글(라벨)을 보고서 언어에 맞춘다.
        if (getLang() !== value.lang) setLang(value.lang);
      },
      (cause) => {
        if (!cancelled) setError(cause instanceof ApiError ? cause.message : "Could not open this strategy.");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [token]);

  return (
    <>
      <Header />
      <div className="mx-auto grid max-w-[1120px] gap-3 p-4">
        {error ? <ErrorNote>{error}</ErrorNote> : null}
        {!report && !error ? <SkeletonRows count={5} /> : null}
        {report ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Chip active={view === "deck"} onClick={() => setView("deck")}>Presentation</Chip>
              <Chip active={view === "text"} onClick={() => setView("text")}>Full text</Chip>
              <span className="text-xs text-[#6b7280]">{`${report.from} → ${report.to} · made ${report.created_at.slice(0, 10)}`}</span>
            </div>
            {note ? <p className="text-xs text-[#7a6320]">{note}</p> : null}
            {view === "deck" ? (
              <StrategyDeck
                lang={report.lang}
                onLang={(code) => {
                  setLang(code);
                  setNote(code === report.lang ? "" : "This shared report is in one language only.");
                }}
                share={token}
                strategy={report.doc}
              />
            ) : (
              <StrategyBody strategy={report.doc} />
            )}
          </>
        ) : null}
      </div>
    </>
  );
}
