"use client";

/**
 * 전략 보고서 보관함(0113) — Claude 가 쓴 전략을 모두 모아 둔 곳. AI 마케팅의 "Strategy reports" 탭과
 * 대표님 보고용 페이지(/strategy, 숫자 2222)가 같이 쓴다.
 *
 * - 목록: 언제·기간·언어·누가·첫 줄. 누르면 프레젠테이션(나레이션) 또는 전체 글로 연다.
 * - 지우는 버튼은 없다. DB 도 지우지 못하게 막는다(0113 트리거).
 * - 공유: 보고서마다 추측할 수 없는 링크(/strategy?t=토큰)를 만들고 끌 수 있다. 꺼도 보고서는 남는다.
 * - 처음 열 때 이 브라우저에만 남아 있던 옛 결과(localStorage `pelham-ai-strategy:*`)를 찾아 보관함에 올린다.
 *   같은 결과는 서버가 한 번만 저장한다. 브라우저의 것은 지우지 않는다.
 */

import { useEffect, useState } from "react";

import { Button, Chip, EmptyNote, ErrorNote, SkeletonRows } from "@/components/retail/ui";
import { aiMarketingApi, type ReportRow, type Strategy } from "@/lib/aiMarketing/api";
import { getLang, type Lang, setLang } from "@/lib/i18n/engine";
import { ApiError } from "@/lib/teeSheet/api";

import { StrategyBody, StrategyDeck } from "./StrategyDeck";

function describe(cause: unknown): string {
  if (cause instanceof ApiError) {
    if (/function|schema cache|does not exist/i.test(cause.message)) {
      return "Strategy reports switch on once 0113_ai_marketing_reports.sql is run in the Supabase SQL Editor.";
    }
    return cause.message;
  }
  return cause instanceof Error ? cause.message : "Could not load the strategy reports.";
}

const SOURCE_LABEL: Record<ReportRow["source"], string> = {
  claude: "Claude",
  browser: "Found in this browser",
  example: "Example",
};

/** 공유 링크 주소. 정적 사이트라 경로 대신 ?t= 로 넘긴다. */
export function shareLink(token: string): string {
  return `${window.location.origin}/strategy?t=${token}`;
}

let importedThisTab = false;

/** 이 브라우저에 남은 옛 결과를 보관함에 올린다. 몇 건을 새로 올렸는지 돌려준다. */
async function importBrowserReports(): Promise<number> {
  if (importedThisTab) return 0;
  importedThisTab = true;
  const found: { from: string; to: string; lang: Lang; doc: Strategy }[] = [];
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i) ?? "";
      const match = /^pelham-ai-strategy:(\d{4}-\d{2}-\d{2})\|(\d{4}-\d{2}-\d{2})(?:\|(en|ko))?$/.exec(key);
      if (!match) continue;
      const doc = JSON.parse(localStorage.getItem(key) ?? "null") as Strategy | null;
      if (!doc?.headline || !Array.isArray(doc.strategies)) continue;
      // 언어를 키에 넣기 전(첫 버전)의 것은 첫 줄에 한글이 있는지로 가린다.
      const lang = (match[3] as Lang | undefined) ?? (/[가-힣]/.test(doc.headline) ? "ko" : "en");
      found.push({ from: match[1], to: match[2], lang, doc });
    }
  } catch {
    return 0;
  }
  let saved = 0;
  for (const item of found) {
    try {
      const result = await aiMarketingApi.saveReport(item.from, item.to, item.lang, "", item.doc, "browser");
      if (result.saved) saved += 1;
    } catch {
      // 하나가 안 되면 다음 것. 보관함이 아직 없으면(0113) 전부 여기로 온다 — 다음에 다시 시도한다.
      importedThisTab = false;
    }
  }
  return saved;
}

export function StrategyReports({
  allowShare = true,
  onLaunch,
}: {
  allowShare?: boolean;
  /** 있으면 보고서 화면에 "Launch texts & pop-ups" 버튼(어드민). /strategy 에는 없다. */
  onLaunch?: (reportId: string) => void;
}) {
  const [rows, setRows] = useState<ReportRow[] | null>(null);
  const [error, setError] = useState("");
  const [imported, setImported] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    importBrowserReports()
      .then((count) => {
        if (!cancelled && count > 0) setImported(count);
      })
      .finally(() =>
        aiMarketingApi.reports().then(
          (list) => {
            if (!cancelled) setRows(list);
          },
          (cause) => {
            if (!cancelled) setError(describe(cause));
          },
        ),
      );
    return () => {
      cancelled = true;
    };
  }, [reload]);

  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (!rows) return <SkeletonRows count={5} />;
  const open = rows.find((row) => row.id === openId) ?? null;

  if (open) {
    return (
      <ReportView
        allowShare={allowShare}
        key={open.id}
        onBack={() => setOpenId(null)}
        onLaunch={onLaunch}
        onOpen={setOpenId}
        onShared={() => setReload((n) => n + 1)}
        row={open}
        rows={rows}
      />
    );
  }

  return (
    <div className="grid gap-2">
      {imported > 0 ? (
        <p className="text-xs text-[#1a7f4b]">{`Saved ${imported} earlier report(s) found in this browser.`}</p>
      ) : null}
      {rows.length === 0 ? (
        <EmptyNote>No strategy reports yet. Ask Claude for a strategy on the Customer analysis tab — every result is kept here.</EmptyNote>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="text-left text-xs text-[#6b7280]">
                <th className="font-bold">Made</th>
                <th className="font-bold">Period</th>
                <th className="font-bold">Language</th>
                <th className="font-bold">Report</th>
                <th className="font-bold">From</th>
                <th className="font-bold">Shared</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr className="cursor-pointer border-t border-[#eef0f2] align-top hover:bg-[#f6f8f6]" key={row.id} onClick={() => setOpenId(row.id)}>
                  <td className="py-1.5 pr-2 whitespace-nowrap tabular-nums">{row.created_at.slice(0, 10)}</td>
                  <td className="py-1.5 pr-2 whitespace-nowrap tabular-nums">{`${row.from} → ${row.to}`}</td>
                  <td className="py-1.5 pr-2" translate="no">
                    {row.lang === "ko" ? "한국어" : "English"}
                  </td>
                  <td className="py-1.5 pr-2">
                    <button className="text-left font-semibold underline-offset-2 hover:underline" type="button">
                      {row.headline}
                    </button>
                    <span className="block text-xs text-[#6b7280]">{`${row.strategies} strategies${row.created_by ? ` · ${row.created_by}` : ""}`}</span>
                  </td>
                  <td className="py-1.5 pr-2 text-xs whitespace-nowrap">{SOURCE_LABEL[row.source]}</td>
                  <td className="py-1.5 text-xs">{row.share_token ? "Link on" : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-xs text-[#6b7280]">Reports are kept for good — there is no delete.</p>
    </div>
  );
}

function ReportView({
  row,
  rows,
  allowShare,
  onBack,
  onOpen,
  onShared,
  onLaunch,
}: {
  onLaunch?: (reportId: string) => void;
  row: ReportRow;
  rows: ReportRow[];
  allowShare: boolean;
  onBack: () => void;
  onOpen: (id: string) => void;
  onShared: () => void;
}) {
  const [doc, setDoc] = useState<Strategy | null>(null);
  const [error, setError] = useState("");
  const [view, setView] = useState<"deck" | "text">("deck");
  const [token, setToken] = useState(row.share_token);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  useEffect(() => {
    let cancelled = false;
    aiMarketingApi.report(row.id).then(
      (value) => {
        if (!cancelled) setDoc(value);
      },
      (cause) => {
        if (!cancelled) setError(describe(cause));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [row.id]);

  // 가 / Aa: 같은 기간의 다른 언어 보고서로. 화면 글(라벨)도 그 언어로 바꾼다.
  const switchLang = (lang: Lang) => {
    if (getLang() !== lang) setLang(lang);
    if (lang === row.lang) return;
    const sibling = rows.find((other) => other.lang === lang && other.from === row.from && other.to === row.to);
    if (sibling) onOpen(sibling.id);
    else setNote(lang === "ko" ? "There is no Korean version of this report." : "There is no English version of this report.");
  };

  const toggleShare = async (on: boolean) => {
    setBusy(true);
    setNote("");
    try {
      const result = await aiMarketingApi.share(row.id, on);
      setToken(result.share_token);
      onShared();
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!token) return;
    try {
      await navigator.clipboard.writeText(shareLink(token));
      setNote("Link copied.");
    } catch {
      setNote("Copy the link above by hand.");
    }
  };

  return (
    <div className="grid min-w-0 gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={onBack}>← All reports</Button>
        <Chip active={view === "deck"} onClick={() => setView("deck")}>Presentation</Chip>
        <Chip active={view === "text"} onClick={() => setView("text")}>Full text</Chip>
        <span className="text-xs text-[#6b7280]">{`${row.created_at.slice(0, 10)} · ${row.from} → ${row.to} · ${SOURCE_LABEL[row.source]}`}</span>
        {onLaunch ? (
          <Button onClick={() => onLaunch(row.id)} tone="primary">
            Launch texts &amp; pop-ups →
          </Button>
        ) : null}
      </div>
      {allowShare ? (
        <div className="flex flex-wrap items-center gap-2 border border-[#d4d4d8] bg-[#fafafa] p-2 text-sm">
          {token ? (
            <>
              <span className="font-bold">Share link</span>
              <input
                aria-label="Share link"
                className="min-w-0 flex-1 border border-[#d4d4d8] bg-white px-2 py-1 font-mono text-xs"
                id={`share-${row.id}`}
                onFocus={(event) => event.currentTarget.select()}
                readOnly
                value={shareLink(token)}
              />
              <Button onClick={copy}>Copy</Button>
              <Button disabled={busy} onClick={() => toggleShare(false)}>
                Stop sharing
              </Button>
            </>
          ) : (
            <>
              <span className="text-[#4e5560]">Anyone with a share link can open this report without signing in.</span>
              <Button disabled={busy} onClick={() => toggleShare(true)} tone="primary">
                Make a share link
              </Button>
            </>
          )}
        </div>
      ) : null}
      {note ? <p className="text-xs text-[#7a6320]">{note}</p> : null}
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      {!doc && !error ? <SkeletonRows count={5} /> : null}
      {doc && view === "deck" ? <StrategyDeck lang={row.lang} onLang={switchLang} strategy={doc} /> : null}
      {doc && view === "text" ? <StrategyBody strategy={doc} /> : null}
    </div>
  );
}
