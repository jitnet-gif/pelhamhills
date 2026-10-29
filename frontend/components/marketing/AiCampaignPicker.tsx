"use client";

/**
 * 새 캠페인 폼의 "AI Manager" 단추 → AI 매니저가 만든 캠페인을 받아 폼을 채운다.
 *
 *   - 열면 최근 전략 보고서(0113)의 전략마다 캠페인 문구(`launch`: 문자·AI 전화·그룹)를 바로 보여 준다(Claude 요금 없음).
 *   - "Ask Hope for new campaigns" → Hope(`/ai-marketing/chat`, 질문 유형 Texts & website)가 최신 전략으로 캠페인을
 *     새로 만든다(몇십 초, 유료). Hope 가 낸 캠페인 카드가 목록 맨 위에 붙는다.
 *   - "Use" 를 누르면 지금 고른 채널(문자 / AI 전화)의 문구, 이름, 그룹이 폼에 들어간다. 보내기는 폼에서 그대로 한다.
 *
 * AI 마케팅 명단(0094) 밖의 계정이면 서버가 거절하고, 그 말을 그대로 보여 준다.
 */

import { useEffect, useState } from "react";

import { aiMarketingApi, askHope, type Strategy } from "@/lib/aiMarketing/api";
import { getLang } from "@/lib/i18n/engine";
import { type Channel, type Segment, SEGMENT_LABEL } from "@/lib/marketing/api";
import { ApiError } from "@/lib/teeSheet/api";

export type AiCampaign = { key: string; title: string; segment: Segment; sms: string; call: string; source: string };

function describe(cause: unknown): string {
  if (cause instanceof ApiError) {
    if (/function|schema cache|does not exist/i.test(cause.message)) {
      return "Strategy reports switch on once 0113_ai_marketing_reports.sql is run in the Supabase SQL Editor.";
    }
    return cause.message;
  }
  return cause instanceof Error ? cause.message : "Something went wrong.";
}

/** 전략 하나 → 캠페인 문구. launch 가 없는 옛 결과는 전략의 offer 로 채운다(실행 타일과 같다). */
function fromStrategy(item: Strategy["strategies"][number], index: number, reportId: string): AiCampaign {
  const copy = item.launch;
  return {
    key: `${reportId}-${index}`,
    title: item.title,
    segment: copy?.segment ?? "all",
    sms: copy?.sms ?? `Pelham Hills: ${item.offer}. Book at pelhamhills.com`.slice(0, 280),
    call: copy?.call ?? item.offer,
    source: `Strategy ${index + 1}`,
  };
}

export function AiCampaignPicker({
  channel,
  onUse,
  onClose,
}: {
  channel: Channel;
  onUse: (campaign: AiCampaign) => void;
  onClose: () => void;
}) {
  const [saved, setSaved] = useState<AiCampaign[] | null>(null);
  const [headline, setHeadline] = useState("");
  const [fresh, setFresh] = useState<AiCampaign[]>([]);
  const [asking, setAsking] = useState(false);
  const [reply, setReply] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    aiMarketingApi
      .reports()
      .then(async (rows) => {
        const latest = rows[0];
        if (!latest) return { list: [], headline: "" };
        const doc = await aiMarketingApi.report(latest.id);
        return {
          list: (doc.strategies ?? []).map((item, index) => fromStrategy(item, index, latest.id)),
          headline: `${doc.headline} (${latest.from} → ${latest.to})`,
        };
      })
      .then(
        (result) => {
          if (cancelled) return;
          setSaved(result.list);
          setHeadline(result.headline);
        },
        (cause) => {
          if (cancelled) return;
          setSaved([]);
          setError(describe(cause));
        },
      );
    return () => {
      cancelled = true;
    };
  }, []);

  const askForCampaigns = async () => {
    setAsking(true);
    setError("");
    try {
      const answer = await askHope(
        [{ role: "user", text: "Make campaigns from the latest strategy — one per strategy, each with a text and an AI call script." }],
        getLang(),
        "launch",
      );
      setReply(answer.reply);
      const stamp = Date.now();
      setFresh((list) => [
        ...answer.actions.flatMap((action, index) =>
          action.type === "launch"
            ? [{
                key: `hope-${stamp}-${index}`,
                title: action.title,
                segment: action.segment,
                sms: action.sms,
                call: action.call ?? "",
                source: "Hope · new",
              }]
            : [],
        ),
        ...list,
      ]);
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setAsking(false);
    }
  };

  const list = [...fresh, ...(saved ?? [])];

  return (
    <div className="mt-3 grid gap-2 border-2 border-[#4533ff] bg-[#f7f6ff] p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="flex-1 font-bold">Campaigns from AI Manager</h3>
        <button
          className="min-h-9 bg-[#4533ff] px-3 text-xs font-bold text-white disabled:opacity-50"
          disabled={asking}
          onClick={() => void askForCampaigns()}
          type="button"
        >
          {asking ? "Hope is making campaigns…" : "Ask Hope for new campaigns"}
        </button>
        <a className="text-xs font-bold text-[#4533ff] underline" href="/admin/ai-marketing#launch" rel="noopener" target="_blank">
          Open AI Manager
        </a>
        <button className="px-2 text-xs font-bold text-[#6b7280]" onClick={onClose} type="button">
          Close
        </button>
      </div>
      {headline ? (
        <p className="text-xs text-[#6b7280]" translate="no">
          {`Latest strategy: ${headline}`}
        </p>
      ) : null}
      {reply ? (
        <p className="bg-white px-2 py-1 text-xs text-[#4e5560]" translate="no">
          {reply}
        </p>
      ) : null}
      {error ? <p className="text-xs text-[#b42318]">{error}</p> : null}
      {saved === null ? <p className="text-xs text-[#6b7280]">Loading…</p> : null}
      {saved !== null && list.length === 0 && !error ? (
        <p className="text-xs text-[#6b7280]">No strategy yet — ask Hope, or make a strategy in AI Manager first.</p>
      ) : null}
      <ol className="grid max-h-96 gap-2 overflow-y-auto">
        {list.map((item) => {
          const text = channel === "call" ? item.call : item.sms;
          return (
            <li className="grid gap-1 border border-[#d4d4d8] bg-white p-2" key={item.key}>
              <div className="flex items-start gap-2">
                <span className="grid flex-1 gap-0.5">
                  <span className="font-bold" translate="no">
                    {item.title}
                  </span>
                  <span className="text-[11px] text-[#6b7280]">{`${item.source} · ${SEGMENT_LABEL[item.segment]}`}</span>
                </span>
                <button
                  className="min-h-9 border border-[#4533ff] px-3 text-xs font-bold text-[#4533ff] hover:bg-[#f0eeff] disabled:opacity-40"
                  disabled={!text}
                  onClick={() => onUse(item)}
                  type="button"
                >
                  Use
                </button>
              </div>
              <p className="text-xs text-[#1f2328]" translate="no">
                {text || (channel === "call" ? "No AI call script for this one." : "No text for this one.")}
              </p>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
