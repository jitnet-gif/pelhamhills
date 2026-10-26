"use client";

/**
 * 기획안 → 실행 타일("Texts & website" 탭). 전략 보고서(0113)의 전략마다 세 타일:
 *
 *   - 문자(Twilio)      → Marketing 캠페인(0047, channel sms). 만들면 "ready" — 보내기는 여기서 한 번 더 확인하고
 *                          Fly `/marketing/campaigns/{id}/send` (동의·수신거부·발송 시간 규칙은 그쪽 그대로).
 *   - AI 전화(ElevenLabs) → 같은 캠페인, channel call. 한 번에 300명까지(0047).
 *   - 웹사이트 팝업       → Website Pop-ups(0060). 숨긴 초안으로 만들거나, 확인 후 바로 켜면 공개 사이트와
 *                          예약 사이트에 뜬다("웹사이트 광고 발행").
 *
 * 문구는 Claude 가 전략과 함께 쓴 `launch`(손님용, 영어)로 채워 두고, 직원이 고친 뒤 만든다. 무엇을 어느 전략에서
 * 만들었는지는 0115 가 남긴다(지우지 않는다). 캠페인 취소·팝업 삭제는 각 화면(Marketing, Website Pop-ups)에서 한다.
 */

import { type ReactNode, useEffect, useState } from "react";

import { Button, EmptyNote, ErrorNote, Field, Select, SkeletonRows, TextArea, TextInput } from "@/components/retail/ui";
import { aiMarketingApi, type LaunchRow, type ReportRow, type Strategy, type StrategyLaunchCopy } from "@/lib/aiMarketing/api";
import { marketingApi, SEGMENT_LABEL, type Channel, type Segment } from "@/lib/marketing/api";
import { siteNoticesApi } from "@/lib/siteNotices";
import { ApiError } from "@/lib/teeSheet/api";

function describe(cause: unknown): string {
  if (cause instanceof ApiError) {
    if (/pelham_staff_ai_marketing_launch|launches/i.test(cause.message) && /function|schema cache/i.test(cause.message)) {
      return "Launch tiles switch on once 0115_ai_marketing_launches.sql is run in the Supabase SQL Editor.";
    }
    if (/function|schema cache|does not exist/i.test(cause.message)) {
      return "Strategy reports switch on once 0113_ai_marketing_reports.sql is run in the Supabase SQL Editor.";
    }
    return cause.message;
  }
  return cause instanceof Error ? cause.message : "Something went wrong.";
}

type Item = Strategy["strategies"][number];

const LINKS: { value: StrategyLaunchCopy["popup_link"]; label: string }[] = [
  { value: "/book/tee-time", label: "Book a tee time" },
  { value: "/book/indoor", label: "Indoor golf" },
  { value: "/book/login", label: "Sign up / sign in" },
  { value: "/", label: "Home page" },
];

/** 이 기능 전에 받은 결과(launch 없음)는 전략 글로 채운다. */
function copyOf(item: Item): StrategyLaunchCopy {
  if (item.launch) return item.launch;
  return {
    sms: `Pelham Hills: ${item.offer}. Book at pelhamhills.com`.slice(0, 280),
    call: item.offer,
    segment: "all",
    popup_title: item.title.slice(0, 60),
    popup_body: item.offer.slice(0, 240),
    popup_link_label: "Book a tee time",
    popup_link: "/book/tee-time",
    days: 14,
  };
}

export function StrategyLaunch({ initialReportId }: { initialReportId?: string | null }) {
  const [rows, setRows] = useState<ReportRow[] | null>(null);
  const [reportId, setReportId] = useState<string | null>(initialReportId ?? null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    aiMarketingApi.reports().then(
      (list) => {
        if (cancelled) return;
        setRows(list);
        setReportId((current) => current ?? list[0]?.id ?? null);
      },
      (cause) => {
        if (!cancelled) setError(describe(cause));
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (!rows) return <SkeletonRows count={4} />;
  if (rows.length === 0) {
    return <EmptyNote>No strategy reports yet. Ask Claude for a strategy on the Customer analysis tab first.</EmptyNote>;
  }
  return (
    <div className="grid min-w-0 gap-3">
      <Field label="Strategy report">
        <Select id="launch-report" onChange={(event) => setReportId(event.target.value)} value={reportId ?? ""}>
          {rows.map((row) => (
            <option key={row.id} value={row.id}>
              {`${row.created_at.slice(0, 10)} · ${row.from} → ${row.to} · ${row.lang.toUpperCase()} · ${row.headline.slice(0, 70)}`}
            </option>
          ))}
        </Select>
      </Field>
      {reportId ? <ReportLaunch key={reportId} reportId={reportId} /> : null}
    </div>
  );
}

function ReportLaunch({ reportId }: { reportId: string }) {
  const [doc, setDoc] = useState<Strategy | null>(null);
  const [launches, setLaunches] = useState<LaunchRow[]>([]);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    aiMarketingApi.report(reportId).then(
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
  }, [reportId]);

  useEffect(() => {
    let cancelled = false;
    aiMarketingApi.launches(reportId).then(
      (value) => {
        if (!cancelled) setLaunches(value);
      },
      (cause) => {
        if (!cancelled) setError(describe(cause));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [reportId, reload]);

  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (!doc) return <SkeletonRows count={4} />;
  const refresh = () => setReload((n) => n + 1);

  return (
    <div className="grid min-w-0 gap-3">
      <p className="text-xs text-[#6b7280]">
        Texts and AI calls are created as campaigns in Marketing and only go out when you press Send and confirm. Pop-ups
        are saved in Website Pop-ups — hidden as a draft, or published to the website after you confirm. Customer copy is in
        English.
      </p>
      {doc.strategies.map((item, index) => {
        const copy = copyOf(item);
        const mine = launches.filter((row) => row.strategy === index);
        return (
          <section className="grid min-w-0 gap-2 border border-[#d4d4d8] bg-white p-3" key={index}>
            <header className="grid gap-0.5">
              <h3 className="font-bold">{`${index + 1}. ${item.title}`}</h3>
              <p className="text-xs text-[#6b7280]">{`${item.target_group} · ${item.time_slot} · ${item.area}`}</p>
              <p className="text-sm">{item.offer}</p>
            </header>
            <div className="grid min-w-0 gap-2 lg:grid-cols-3">
              <CampaignTile
                channel="sms"
                copy={copy}
                index={index}
                launches={mine.filter((row) => row.channel === "sms")}
                onChange={refresh}
                reportId={reportId}
                title={item.title}
              />
              <CampaignTile
                channel="call"
                copy={copy}
                index={index}
                launches={mine.filter((row) => row.channel === "call")}
                onChange={refresh}
                reportId={reportId}
                title={item.title}
              />
              <PopupTile
                copy={copy}
                index={index}
                launches={mine.filter((row) => row.channel === "popup")}
                onChange={refresh}
                reportId={reportId}
              />
            </div>
          </section>
        );
      })}
    </div>
  );
}

const CAMPAIGN_STATUS: Record<string, string> = {
  ready: "Ready — not sent",
  sending: "Sending",
  sent: "Sent",
  cancelled: "Cancelled",
};

function Tile({ title, tag, children }: { title: string; tag: string; children: ReactNode }) {
  return (
    <div className="grid min-w-0 content-start gap-2 border border-[#e5e7eb] bg-[#fafafa] p-2.5">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-sm font-bold">{title}</h4>
        <span className="text-[11px] text-[#6b7280]">{tag}</span>
      </div>
      {children}
    </div>
  );
}

function CampaignTile({
  channel,
  copy,
  index,
  title,
  reportId,
  launches,
  onChange,
}: {
  channel: Channel;
  copy: StrategyLaunchCopy;
  index: number;
  title: string;
  reportId: string;
  launches: LaunchRow[];
  onChange: () => void;
}) {
  const [message, setMessage] = useState(channel === "sms" ? copy.sms : copy.call);
  const [segment, setSegment] = useState<Segment>(copy.segment);
  const [reach, setReach] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const limit = channel === "sms" ? 320 : 1000;

  useEffect(() => {
    let cancelled = false;
    marketingApi.audience(channel, { segment }).then(
      (audience) => {
        if (!cancelled) setReach(audience.phones);
      },
      () => {
        if (!cancelled) setReach(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [channel, segment]);

  const create = async () => {
    setBusy(true);
    setError("");
    try {
      const campaign = await marketingApi.createCampaign({
        channel,
        name: `AI · ${title}`.slice(0, 80),
        message: message.trim(),
        audience: { segment },
      });
      await aiMarketingApi.recordLaunch(reportId, index, channel, String(campaign.id));
      setNote(`Campaign #${campaign.id} is ready. Nothing has been sent yet.`);
      onChange();
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setBusy(false);
    }
  };

  const send = async (ref: string) => {
    setBusy(true);
    setError("");
    setConfirm(null);
    try {
      await marketingApi.send(Number(ref));
      setNote(channel === "sms" ? "Sending the texts now." : "Starting the AI calls now.");
      onChange();
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setBusy(false);
    }
  };

  const label = channel === "sms" ? "Text message" : "AI phone call";
  const tag = channel === "sms" ? "Twilio" : "ElevenLabs";
  const empty = !copy[channel === "sms" ? "sms" : "call"];

  return (
    <Tile tag={tag} title={label}>
      {launches.map((row) => (
        <div className="grid gap-1 border border-[#d4d4d8] bg-white p-2 text-xs" key={row.ref}>
          <span className="font-bold">{`Campaign #${row.ref} · ${CAMPAIGN_STATUS[row.campaign?.status ?? ""] ?? "Not found"}`}</span>
          {row.campaign ? <span>{`${row.campaign.sent} of ${row.campaign.recipients} sent${row.campaign.failed ? ` · ${row.campaign.failed} failed` : ""}`}</span> : null}
          <div className="flex flex-wrap gap-1">
            {row.campaign?.status === "ready" ? (
              confirm === row.ref ? (
                <>
                  <Button disabled={busy} onClick={() => send(row.ref)} tone="primary">
                    {`Yes, send to ${row.campaign.recipients}`}
                  </Button>
                  <Button onClick={() => setConfirm(null)}>Not now</Button>
                </>
              ) : (
                <Button disabled={busy} onClick={() => setConfirm(row.ref)}>
                  Send…
                </Button>
              )
            ) : null}
            <a className="inline-flex min-h-11 items-center px-2 text-xs font-bold text-[#2d5e8c] underline" href="/marketing">
              Open in Marketing
            </a>
          </div>
        </div>
      ))}
      {empty && launches.length === 0 ? (
        <p className="text-xs text-[#6b7280]">Claude did not suggest this channel for this strategy. You can still write one.</p>
      ) : null}
      <Field label="Who">
        <Select id={`seg-${channel}-${index}`} onChange={(event) => setSegment(event.target.value as Segment)} value={segment}>
          {(Object.keys(SEGMENT_LABEL) as Segment[]).map((value) => (
            <option key={value} value={value}>
              {SEGMENT_LABEL[value]}
            </option>
          ))}
        </Select>
      </Field>
      <p className="text-xs text-[#6b7280]">
        {reach === null ? "Reach: open Marketing to check consent lists." : `${reach} people can receive this (consent and opt-outs checked).`}
      </p>
      <Field label={channel === "sms" ? `Text (${message.length}/${limit})` : "What the AI caller offers"}>
        <TextArea id={`msg-${channel}-${index}`} maxLength={limit} onChange={(event) => setMessage(event.target.value)} rows={4} value={message} />
      </Field>
      {channel === "sms" ? <p className="text-[11px] text-[#6b7280]">The sender name and the opt-out line are added automatically.</p> : null}
      <Button disabled={busy || !message.trim()} onClick={create}>
        {launches.length > 0 ? "Create another campaign" : "Create campaign (not sent)"}
      </Button>
      {note ? <p className="text-xs text-[#1a7f4b]">{note}</p> : null}
      {error ? <ErrorNote>{error}</ErrorNote> : null}
    </Tile>
  );
}

function PopupTile({
  copy,
  index,
  reportId,
  launches,
  onChange,
}: {
  copy: StrategyLaunchCopy;
  index: number;
  reportId: string;
  launches: LaunchRow[];
  onChange: () => void;
}) {
  const [title, setTitle] = useState(copy.popup_title);
  const [body, setBody] = useState(copy.popup_body);
  const [linkLabel, setLinkLabel] = useState(copy.popup_link_label);
  const [link, setLink] = useState<StrategyLaunchCopy["popup_link"]>(copy.popup_link);
  const [days, setDays] = useState(String(Math.min(90, Math.max(1, copy.days || 14))));
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");

  const create = async (publish: boolean) => {
    setBusy(true);
    setError("");
    setConfirm(null);
    try {
      const start = new Date();
      const end = new Date(start.getTime() + Math.max(1, Number(days) || 14) * 86_400_000);
      const notice = await siteNoticesApi.save({
        kind: "promotion",
        title: title.trim(),
        body: body.trim(),
        link_url: link,
        link_label: linkLabel.trim() || null,
        surfaces: "all",
        repeat: "daily",
        starts_at: start.toISOString(),
        ends_at: end.toISOString(),
        active: publish,
      });
      await aiMarketingApi.recordLaunch(reportId, index, "popup", notice.id);
      setNote(publish ? "Published — the pop-up is now on the website." : "Saved as a hidden draft.");
      onChange();
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setBusy(false);
    }
  };

  const setActive = async (id: string, active: boolean) => {
    setBusy(true);
    setError("");
    setConfirm(null);
    try {
      await siteNoticesApi.save({ id, active });
      setNote(active ? "Published — the pop-up is now on the website." : "Taken down from the website.");
      onChange();
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Tile tag="Website" title="Website pop-up">
      {launches.map((row) => (
        <div className="grid gap-1 border border-[#d4d4d8] bg-white p-2 text-xs" key={row.ref}>
          <span className="font-bold">
            {row.popup ? `${row.popup.title} · ${row.popup.live ? "Live on the website" : row.popup.active ? "Scheduled" : "Hidden draft"}` : "Pop-up not found"}
          </span>
          {row.popup?.ends_at ? <span>{`Runs until ${row.popup.ends_at.slice(0, 10)}`}</span> : null}
          <div className="flex flex-wrap gap-1">
            {row.popup && !row.popup.active ? (
              confirm === row.ref ? (
                <>
                  <Button disabled={busy} onClick={() => setActive(row.ref, true)} tone="primary">
                    Yes, publish
                  </Button>
                  <Button onClick={() => setConfirm(null)}>Not now</Button>
                </>
              ) : (
                <Button disabled={busy} onClick={() => setConfirm(row.ref)}>
                  Publish…
                </Button>
              )
            ) : null}
            {row.popup?.active ? (
              <Button disabled={busy} onClick={() => setActive(row.ref, false)}>
                Take down
              </Button>
            ) : null}
            <a className="inline-flex min-h-11 items-center px-2 text-xs font-bold text-[#2d5e8c] underline" href="/admin/notices">
              Open in Website Pop-ups
            </a>
          </div>
        </div>
      ))}
      <Field label="Title">
        <TextInput id={`pt-${index}`} maxLength={80} onChange={(event) => setTitle(event.target.value)} value={title} />
      </Field>
      <Field label={`Message (${body.length}/240)`}>
        <TextArea id={`pb-${index}`} maxLength={240} onChange={(event) => setBody(event.target.value)} rows={3} value={body} />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Button">
          <TextInput id={`pl-${index}`} maxLength={30} onChange={(event) => setLinkLabel(event.target.value)} value={linkLabel} />
        </Field>
        <Field label="Goes to">
          <Select id={`pg-${index}`} onChange={(event) => setLink(event.target.value as StrategyLaunchCopy["popup_link"])} value={link}>
            {LINKS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Field label="Days to run">
        <TextInput id={`pd-${index}`} inputMode="numeric" max={90} min={1} onChange={(event) => setDays(event.target.value)} type="number" value={days} />
      </Field>
      <div className="flex flex-wrap gap-1">
        <Button disabled={busy || !title.trim()} onClick={() => create(false)}>
          Save hidden draft
        </Button>
        {confirm === "new" ? (
          <>
            <Button disabled={busy} onClick={() => create(true)} tone="primary">
              Yes, publish now
            </Button>
            <Button onClick={() => setConfirm(null)}>Not now</Button>
          </>
        ) : (
          <Button disabled={busy || !title.trim()} onClick={() => setConfirm("new")} tone="primary">
            Publish to website…
          </Button>
        )}
      </div>
      {note ? <p className="text-xs text-[#1a7f4b]">{note}</p> : null}
      {error ? <ErrorNote>{error}</ErrorNote> : null}
    </Tile>
  );
}
