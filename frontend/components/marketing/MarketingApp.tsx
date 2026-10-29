"use client";

/**
 * 고객 마케팅 화면 다섯 칸: 새 캠페인 · 날씨 알림(그날 티 시트 손님, WeatherAlert.tsx) · 캠페인 기록 · 동의 · 수신거부.
 *
 * 누구에게 보낼 수 있는지는 서버(0047)가 정한다 — 이 화면은 그 결과를 보여 주고 고를 뿐이다.
 *   문자: 동의 표시가 있거나, 표시가 없으면 회원·라운드 기록이 있는 손님. 끝에 "Reply STOP to opt out."
 *   AI 전화: 전화 동의(call_ok)를 받은 손님만. 자동 전화라 명시적 동의가 있어야 한다(CRTC).
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import { code128Svg } from "@/lib/retail/barcode";
import {
  type Audience,
  type AudienceCustomer,
  type AudienceFilter,
  type Campaign,
  type CampaignCost,
  type CampaignSend,
  type Channel,
  type MarketingStatus,
  type OptOut,
  type Segment,
  type SendView,
  OPTOUT_SOURCE_LABEL,
  REASON_LABEL,
  REPLY_LABEL,
  SEGMENT_LABEL,
  SEND_STATUS_LABEL,
  campaignAudienceFacts,
  describeCampaignAudience,
  describeMarketingError,
  formatPhone,
  marketingApi,
  sendInView,
  sendMatches,
  summarizeRecipients,
} from "@/lib/marketing/api";

import { AiCampaignPicker } from "./AiCampaignPicker";
import WeatherAlert from "./WeatherAlert";

type Tab = "compose" | "weather" | "campaigns" | "consent" | "optouts";

const TABS: { key: Tab; label: string }[] = [
  { key: "compose", label: "New campaign" },
  { key: "weather", label: "Weather alert" },
  { key: "campaigns", label: "Campaigns" },
  { key: "consent", label: "Consent" },
  { key: "optouts", label: "Opt-outs" },
];

const CHANNEL_LABEL: Record<Channel, string> = { sms: "Text message", call: "AI phone call" };

export default function MarketingApp() {
  const [tab, setTab] = useState<Tab>("compose");
  const [status, setStatus] = useState<MarketingStatus | null>(null);
  const [statusError, setStatusError] = useState("");
  const [openCampaign, setOpenCampaign] = useState<number | null>(null);

  useEffect(() => {
    marketingApi.status().then(setStatus, (cause) => setStatusError(describeMarketingError(cause)));
  }, []);

  const onCreated = useCallback((id: number) => {
    setOpenCampaign(id);
    setTab("campaigns");
  }, []);

  return (
    <div className="mx-auto max-w-6xl px-4 py-4">
      <nav className="mb-4 flex gap-1 overflow-x-auto border-b border-[#d4d4d8]" aria-label="Marketing">
        {TABS.map((item) => (
          <button
            className={`min-h-10 shrink-0 px-4 text-sm font-bold ${
              tab === item.key ? "border-b-2 border-[#4533ff] text-[#4533ff]" : "text-[#4e5560]"
            }`}
            key={item.key}
            onClick={() => setTab(item.key)}
            type="button"
          >
            {item.label}
          </button>
        ))}
      </nav>

      <ServerBanner status={status} error={statusError} />

      {tab === "compose" ? <Compose status={status} onCreated={onCreated} /> : null}
      {tab === "weather" ? <WeatherAlert status={status} onCreated={onCreated} /> : null}
      {tab === "campaigns" ? <Campaigns initial={openCampaign} status={status} /> : null}
      {tab === "consent" ? <Consent /> : null}
      {tab === "optouts" ? <OptOuts /> : null}
    </div>
  );
}

function ServerBanner({ status, error }: { status: MarketingStatus | null; error: string }) {
  if (error) {
    return (
      <p className="mb-4 border border-[#f0d58a] bg-[#fff8e1] p-3 text-xs text-[#6b4e00]">
        The sending server did not answer ({error}). You can still build campaigns and manage consent.
      </p>
    );
  }
  if (!status) return null;
  return (
    <div className="mb-4 flex flex-wrap gap-2 text-xs">
      <Pill ok={status.sms} label={status.sms ? "Texts ready (Twilio)" : "Texts not set up (Twilio)"} />
      <Pill ok={status.call} label={status.call ? "AI calls ready (ElevenLabs)" : "AI calls not set up (ElevenLabs)"} />
      <Pill
        ok={status.window_open}
        label={status.window_open ? "Sending hours: open now" : `Outside sending hours · ${status.window}`}
      />
    </div>
  );
}

function Pill({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={`px-2.5 py-1 font-bold ${ok ? "bg-[#e3f5e8] text-[#16723a]" : "bg-[#f0f1f3] text-[#4e5560]"}`}>
      {ok ? "● " : "○ "}
      {label}
    </span>
  );
}

// ===== 새 캠페인 ==========================================================

function useAudience(channel: Channel, filter: AudienceFilter) {
  const [audience, setAudience] = useState<Audience | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [nonce, setNonce] = useState(0);
  // 배열(city·area_code)이 든 객체라 글자로 바꿔 비교한다 — 그려질 때마다 다시 부르지 않게.
  const key = JSON.stringify(filter);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setLoading(true);
      marketingApi
        .audience(channel, JSON.parse(key) as AudienceFilter)
        .then(
          (value) => {
            if (!cancelled) {
              setAudience(value);
              setError("");
            }
          },
          (cause) => {
            if (!cancelled) setError(describeMarketingError(cause));
          },
        )
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [channel, key, nonce]);

  return { audience, error, loading, reload: () => setNonce((value) => value + 1) };
}

// 프로모션 화면의 "Text it" 이 ?channel=sms&name=…&message=…&barcode=PROMO-… 로 연다. 읽은 뒤 주소에서
// 지운다(아래 effect). barcode 는 캠페인 audience 에 담겨 문자마다 바코드 그림(MMS)으로 붙는다.
function readDraft() {
  if (typeof window === "undefined") return null;
  const query = new URLSearchParams(window.location.search);
  if (!query.has("name") && !query.has("message")) return null;
  return {
    channel: (query.get("channel") === "call" ? "call" : "sms") as Channel,
    name: query.get("name") ?? "",
    message: query.get("message") ?? "",
    segment: (["all", "members", "non_members", "regulars", "new"].includes(query.get("segment") ?? "")
      ? query.get("segment")
      : "all") as Segment,
    barcode: /^PROMO-[A-Z0-9]{3,16}$/i.test(query.get("barcode") ?? "") ? query.get("barcode")!.toUpperCase() : "",
  };
}

function Compose({ status, onCreated }: { status: MarketingStatus | null; onCreated: (id: number) => void }) {
  const [draft] = useState(readDraft);
  const [channel, setChannel] = useState<Channel>(draft?.channel ?? "sms");
  const [name, setName] = useState(draft?.name ?? "");
  const [message, setMessage] = useState(draft?.message ?? "");
  const [barcode, setBarcode] = useState(draft?.barcode ?? "");

  useEffect(() => {
    if (draft) window.history.replaceState(null, "", window.location.pathname);
  }, [draft]);
  const [segment, setSegment] = useState<Segment>(draft?.segment ?? "all");
  const [minRounds, setMinRounds] = useState(0);
  const [maxRounds, setMaxRounds] = useState(0);
  const [search, setSearch] = useState("");
  const [cities, setCities] = useState<string[]>([]);
  const [areaCodes, setAreaCodes] = useState<string[]>([]);
  // 손으로 친 번호(문자만, 0132). phonesOnly 면 그룹·필터는 빼고 이 번호에만 보낸다.
  const [typed, setTyped] = useState("");
  const [phonesOnly, setPhonesOnly] = useState(true);
  // null = 그룹 전체(모두 체크). 한 명이라도 체크를 풀면 고른 사람 목록(Set)으로 바뀐다.
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState(false);
  // "AI Manager" 단추 — AI 매니저 캠페인을 받아 폼을 채운다(AiCampaignPicker).
  const [aiOpen, setAiOpen] = useState(false);

  const filter: AudienceFilter = {
    segment,
    min_rounds: minRounds,
    ...(maxRounds > 0 ? { max_rounds: maxRounds } : {}),
    search: search.trim(),
    ...(cities.length ? { city: cities } : {}),
    ...(areaCodes.length ? { area_code: areaCodes } : {}),
  };
  const { audience, error: audienceError, loading } = useAudience(channel, filter);
  const eligible = useMemo(() => (audience?.customers ?? []).filter((c) => c.ok), [audience]);

  const pickMode = picked !== null;
  const pickedRefs = useMemo(
    () => (picked ? eligible.filter((c) => picked.has(c.customer_ref)).map((c) => c.customer_ref) : []),
    [eligible, picked],
  );
  const typedPhones = useMemo(() => parseTypedPhones(typed), [typed]);
  const useTyped = channel === "sms" && typedPhones.valid.length > 0;
  const typedOnly = useTyped && phonesOnly;
  const recipients = useMemo(() => {
    if (typedOnly) return typedPhones.valid.length;
    const phones = new Set(eligible.filter((c) => !picked || picked.has(c.customer_ref)).map((c) => c.phone));
    if (!useTyped) return picked ? phones.size : (audience?.phones ?? 0);
    for (const phone of typedPhones.valid) phones.add(phone);
    return phones.size;
  }, [audience, eligible, picked, typedOnly, typedPhones, useTyped]);

  const sender = status?.sms_sender ?? "Pelham Hills Golf";
  const footer = status?.sms_footer ?? "Reply STOP to opt out.";
  const smsPreview = message.trim()
    ? `${message.trim().toLowerCase().startsWith("pelham hills") ? "" : `${sender}: `}${message.trim()} ${footer}`
    : "";
  const smsParts = smsPreview ? Math.ceil(smsPreview.length / 153) : 0;
  const limit = channel === "sms" ? 320 : 1000;
  const ready = name.trim() && message.trim() && message.length <= limit && recipients > 0;

  const togglePick = (ref: string) =>
    setPicked((current) => {
      const next = new Set(current ?? eligible.map((c) => c.customer_ref));
      if (next.has(ref)) next.delete(ref);
      else next.add(ref);
      return next;
    });

  const create = async (sendNow: boolean) => {
    setBusy(true);
    setError("");
    try {
      const campaign = await marketingApi.createCampaign({
        channel,
        name: name.trim(),
        message: message.trim(),
        audience: {
          ...filter,
          ...(channel === "sms" && barcode ? { barcode } : {}),
        },
        // 친 번호만일 때 없는 고객 번호 하나를 보낸다 — 0132 전 DB 는 그룹 전체가 아니라 "아무도 없음"으로 막는다.
        customer_refs: typedOnly ? ["typed-only"] : pickMode ? pickedRefs : undefined,
        ...(useTyped ? { phones: typedPhones.valid, phones_only: phonesOnly } : {}),
      });
      if (sendNow) {
        try {
          await marketingApi.send(campaign.id);
        } catch (cause) {
          // 캠페인은 만들어졌다. 기록 칸에서 나중에 보낼 수 있다.
          window.alert(`Campaign saved, but it did not start: ${describeMarketingError(cause)}`);
        }
      }
      onCreated(campaign.id);
    } catch (cause) {
      setError(describeMarketingError(cause));
      setBusy(false);
      setConfirming(false);
    }
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <section className="bg-white p-4 shadow-sm">
        <div className="flex items-center gap-2">
          <h2 className="flex-1 text-sm font-bold">1. Channel and message</h2>
          <button
            aria-expanded={aiOpen}
            className={`inline-flex min-h-9 items-center gap-1.5 border px-3 text-xs font-bold ${
              aiOpen ? "border-[#4533ff] bg-[#4533ff] text-white" : "border-[#4533ff] text-[#4533ff] hover:bg-[#f0eeff]"
            }`}
            onClick={() => setAiOpen((open) => !open)}
            title="Get a campaign from the AI Manager"
            type="button"
          >
            <svg aria-hidden="true" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
              <path d="M12 3l1.8 4.2L18 9l-4.2 1.8L12 15l-1.8-4.2L6 9l4.2-1.8z" />
              <path d="M18.5 14l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z" />
              <path d="M5 16l.6 1.4L7 18l-1.4.6L5 20l-.6-1.4L3 18l1.4-.6z" />
            </svg>
            AI Manager
          </button>
        </div>
        {aiOpen ? (
          <AiCampaignPicker
            channel={channel}
            onClose={() => setAiOpen(false)}
            onUse={(campaign) => {
              setName(`AI · ${campaign.title}`.slice(0, 80));
              setMessage((channel === "call" ? campaign.call : campaign.sms).slice(0, limit));
              setSegment(campaign.segment);
              setBarcode("");
              setPicked(null);
              setAiOpen(false);
            }}
          />
        ) : null}
        <div className="mt-3 grid grid-cols-2 gap-2">
          {(["sms", "call"] as Channel[]).map((value) => (
            <button
              className={`min-h-14 border p-2 text-left text-sm ${
                channel === value ? "border-[#4533ff] bg-[#f0eeff]" : "border-[#d4d4d8]"
              }`}
              key={value}
              onClick={() => {
                setChannel(value);
                setPicked(null);
              }}
              type="button"
            >
              <span className="block font-bold">{CHANNEL_LABEL[value]}</span>
              <span className="block text-xs text-[#6b7280]">{value === "sms" ? "via Twilio" : "via ElevenLabs agent"}</span>
            </button>
          ))}
        </div>

        <label className="mt-4 block text-xs font-bold" htmlFor="campaign-name">
          Campaign name (staff only)
        </label>
        <input
          className="mt-1 h-11 w-full border border-[#d4d4d8] px-3 text-base"
          id="campaign-name"
          onChange={(event) => setName(event.target.value)}
          placeholder="e.g. Fall weekday twilight"
          value={name}
        />

        <label className="mt-3 block text-xs font-bold" htmlFor="campaign-message">
          {channel === "sms" ? "Text message" : "Offer the AI agent will explain on the call"}
        </label>
        <textarea
          className="mt-1 min-h-32 w-full border border-[#d4d4d8] p-3 text-base"
          id="campaign-message"
          onChange={(event) => setMessage(event.target.value)}
          placeholder={
            channel === "sms"
              ? "Weekday twilight is $34.52 after 5 PM this week. Book at pelhamhills.ca/book or call 416-822-7609."
              : "This week only, weekday 18 holes after 2 PM are $38.94. The agent can book a tee time on the call."
          }
          value={message}
        />
        <p className={`mt-1 text-right text-xs ${message.length > limit ? "text-[#a12a2a]" : "text-[#6b7280]"}`}>
          {message.length}/{limit}
        </p>

        {channel === "sms" && smsPreview ? (
          <div className="mt-2">
            <p className="text-xs font-bold">What the customer sees</p>
            <p className="mt-1 max-w-sm rounded-2xl bg-[#e9e9eb] px-3 py-2 text-sm whitespace-pre-wrap">{smsPreview}</p>
            <p className="mt-1 text-xs text-[#6b7280]">
              {smsPreview.length} characters · about {smsParts} text{smsParts === 1 ? "" : "s"} per person. The sender
              name and opt-out line are added automatically (required by CASL).
            </p>
          </div>
        ) : null}
        {channel === "sms" && barcode ? (
          <div className="mt-2 flex flex-wrap items-center gap-3 border border-[#d9d4ff] bg-[#f6f5ff] p-3 text-xs">
            {/* code128Svg 는 막대(rect)만 그린 SVG 다. */}
            <span
              className="block h-12 w-48 bg-white [&>svg]:h-full [&>svg]:w-full"
              dangerouslySetInnerHTML={{ __html: code128Svg(barcode) }}
            />
            <span className="min-w-0 flex-1">
              <b>Barcode {barcode} is attached as a picture.</b> Customers show it at the pro shop; staff scan it on the
              tee sheet after adding the green fee. A picture text (MMS) costs a little more than a plain text.
            </span>
            <button className="border border-[#d4d4d8] bg-white px-2 py-1 font-bold" onClick={() => setBarcode("")} type="button">
              Don&apos;t attach
            </button>
          </div>
        ) : null}
        {channel === "call" ? (
          <p className="mt-2 border border-[#d9e3ff] bg-[#f3f6ff] p-3 text-xs leading-5 text-[#2449b3]">
            The ElevenLabs agent calls each person, greets them by first name, says it is calling from Pelham Hills,
            explains this offer, and can book a tee time. If they say not to call again, they are added to the
            opt-out list. Only customers who agreed to calls (Consent tab) are called, during legal calling hours.
          </p>
        ) : null}
      </section>

      <section className="bg-white p-4 shadow-sm">
        <h2 className="text-sm font-bold">2. Who gets it</h2>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <label className="text-xs font-bold">
            Group
            <select
              className="mt-1 h-11 w-full border border-[#d4d4d8] px-2 text-sm font-normal"
              onChange={(event) => setSegment(event.target.value as Segment)}
              value={segment}
            >
              {(Object.keys(SEGMENT_LABEL) as Segment[]).map((value) => (
                <option key={value} value={value}>
                  {SEGMENT_LABEL[value]}
                </option>
              ))}
            </select>
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="text-xs font-bold">
              At least this many rounds
              <input
                className="mt-1 h-11 w-full border border-[#d4d4d8] px-2 text-sm font-normal"
                min={0}
                onChange={(event) => setMinRounds(Math.max(0, Number(event.target.value) || 0))}
                type="number"
                value={minRounds}
              />
            </label>
            <label className="text-xs font-bold">
              At most (blank = any)
              <input
                className="mt-1 h-11 w-full border border-[#d4d4d8] px-2 text-sm font-normal"
                min={0}
                onChange={(event) => setMaxRounds(Math.max(0, Number(event.target.value) || 0))}
                placeholder="Any"
                type="number"
                value={maxRounds || ""}
              />
            </label>
          </div>
          <RegionPicker
            label="Region (city)"
            onChange={setCities}
            options={(audience?.cities ?? []).map((item) => ({ value: item.name, count: item.count }))}
            placeholder="Any city"
            value={cities}
          />
          <RegionPicker
            label="Phone area code"
            onChange={setAreaCodes}
            options={(audience?.area_codes ?? []).map((item) => ({ value: item.code, count: item.count }))}
            placeholder="Any area code"
            value={areaCodes}
          />
        </div>
        <input
          className="mt-2 h-10 w-full border border-[#d4d4d8] px-3 text-sm"
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search name or phone"
          value={search}
        />
        {cities.length || areaCodes.length || maxRounds > 0 || search.trim() ? (
          <p className="mt-1 text-xs text-[#6b7280]">
            Only people matching every filter above get it.{" "}
            <button
              className="font-bold text-[#4533ff] underline"
              onClick={() => {
                setCities([]);
                setAreaCodes([]);
                setMaxRounds(0);
                setSearch("");
                setPicked(null);
              }}
              type="button"
            >
              Clear filters
            </button>
          </p>
        ) : null}

        {channel === "sms" ? (
          <div className="mt-3 border border-[#ececf0] bg-[#fafafa] p-3">
            <label className="block text-xs font-bold" htmlFor="campaign-phones">
              Or type phone numbers
            </label>
            <textarea
              className="mt-1 min-h-16 w-full border border-[#d4d4d8] bg-white p-2 text-sm"
              id="campaign-phones"
              onChange={(event) => setTyped(event.target.value)}
              placeholder={"647-618-4410\n905-555-1234"}
              value={typed}
            />
            <p className="mt-1 text-xs text-[#6b7280]">
              One per line or separated by commas. 10-digit numbers only; numbers on the opt-out list are skipped.
            </p>
            {typedPhones.valid.length || typedPhones.bad.length ? (
              <p className="mt-1 text-xs">
                <b>{typedPhones.valid.length}</b> number{typedPhones.valid.length === 1 ? "" : "s"} ready
                {typedPhones.bad.length ? (
                  <span className="text-[#a12a2a]"> · not a phone number: {typedPhones.bad.join(", ")}</span>
                ) : null}
              </p>
            ) : null}
            {useTyped ? (
              <div className="mt-2 grid gap-1 text-xs">
                <label className="flex items-center gap-2">
                  <input checked={phonesOnly} name="typed-mode" onChange={() => setPhonesOnly(true)} type="radio" />
                  Only these numbers (ignore the group and filters above)
                </label>
                <label className="flex items-center gap-2">
                  <input checked={!phonesOnly} name="typed-mode" onChange={() => setPhonesOnly(false)} type="radio" />
                  These numbers plus the group above
                </label>
              </div>
            ) : null}
          </div>
        ) : null}

        {audienceError ? (
          <p className="mt-3 text-xs text-[#8c1d1d]" role="alert">
            {audienceError}
          </p>
        ) : null}
        {audience ? (
          <div className={`mt-3 grid grid-cols-4 gap-2 text-center ${loading ? "opacity-60" : ""}`}>
            <Stat label="Will receive" value={pickMode || useTyped ? recipients : audience.phones} strong />
            <Stat label="No consent" value={audience.no_consent} />
            <Stat label="Opted out" value={audience.opted_out} />
            <Stat label="No phone" value={audience.no_phone} />
          </div>
        ) : null}
        {audience && audience.eligible !== audience.phones && !pickMode ? (
          <p className="mt-1 text-xs text-[#6b7280]">
            {audience.eligible} customers share {audience.phones} phone numbers — each number gets it once.
          </p>
        ) : null}

        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
          <span className="mr-auto text-xs text-[#6b7280]">
            {pickMode ? `${pickedRefs.length} of ${eligible.length} selected` : "Whole group selected — untick anyone to leave them out"}
          </span>
          <button
            className="border border-[#d4d4d8] px-3 py-1 text-xs font-bold disabled:opacity-50"
            disabled={!pickMode}
            onClick={() => setPicked(null)}
            type="button"
          >
            Select all
          </button>
          <button
            className="border border-[#d4d4d8] px-3 py-1 text-xs font-bold disabled:opacity-50"
            disabled={pickMode && pickedRefs.length === 0}
            onClick={() => setPicked(new Set())}
            type="button"
          >
            Deselect all
          </button>
        </div>

        <div className="mt-2 max-h-80 overflow-y-auto border border-[#ececf0]">
          <table className="w-full text-left text-xs">
            <tbody>
              {(audience?.customers ?? []).slice(0, 300).map((customer) => (
                <AudienceRow
                  customer={customer}
                  key={customer.customer_ref}
                  onToggle={() => togglePick(customer.customer_ref)}
                  picked={customer.ok && (!picked || picked.has(customer.customer_ref))}
                />
              ))}
            </tbody>
          </table>
          {audience && audience.customers.length > 300 ? (
            <p className="p-2 text-center text-xs text-[#6b7280]">
              Showing 300 of {audience.customers.length}. Search to narrow.
            </p>
          ) : null}
        </div>
      </section>

      <section className="bg-white p-4 shadow-sm lg:col-span-2">
        {error ? (
          <p className="mb-3 border border-[#f0b4b4] bg-[#fdf1f1] p-2 text-xs text-[#8c1d1d]" role="alert">
            {error}
          </p>
        ) : null}
        {confirming ? (
          <div className="grid gap-3 sm:flex sm:items-center sm:justify-between">
            <p className="text-sm">
              Send <b>{CHANNEL_LABEL[channel].toLowerCase()}</b> &ldquo;{name.trim()}&rdquo; to{" "}
              <b>{recipients}</b> phone number{recipients === 1 ? "" : "s"} now? Sent texts and calls cannot be taken
              back.
            </p>
            <div className="flex gap-2">
              <button className="h-11 border border-[#d4d4d8] px-4 text-sm font-bold" disabled={busy} onClick={() => setConfirming(false)} type="button">
                Back
              </button>
              <button
                className="h-11 bg-[#4533ff] px-5 text-sm font-bold text-white disabled:opacity-60"
                disabled={busy}
                onClick={() => void create(true)}
                type="button"
              >
                {busy ? "Starting…" : "Yes, send now"}
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap justify-end gap-2">
            <button
              className="h-11 border border-[#d4d4d8] px-4 text-sm font-bold disabled:opacity-50"
              disabled={!ready || busy}
              onClick={() => void create(false)}
              type="button"
            >
              Save without sending
            </button>
            <button
              className="h-11 bg-[#4533ff] px-5 text-sm font-bold text-white disabled:opacity-50"
              disabled={!ready || busy}
              onClick={() => setConfirming(true)}
              type="button"
            >
              Send to {recipients} number{recipients === 1 ? "" : "s"}…
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

// 손으로 친 번호 → 10자리. 줄바꿈·쉼표·세미콜론으로 나눈다. 앞의 1 은 뗀다(0047 pelham_marketing_phone 과 같다).
function parseTypedPhones(text: string): { valid: string[]; bad: string[] } {
  const valid = new Set<string>();
  const bad: string[] = [];
  for (const raw of text.split(/[\n,;]+/)) {
    const item = raw.trim();
    if (!item) continue;
    const digits = item.replace(/\D/g, "");
    if (/^\d{10}$/.test(digits)) valid.add(digits);
    else if (/^1\d{10}$/.test(digits)) valid.add(digits.slice(1));
    else bad.push(item);
  }
  return { valid: [...valid], bad };
}

function Stat({ label, value, strong }: { label: string; value: number; strong?: boolean }) {
  return (
    <div className={`p-2 ${strong ? "bg-[#f0eeff] text-[#4533ff]" : "bg-[#f6f6f8]"}`}>
      <p className="text-lg font-bold">{value}</p>
      <p className="text-[10px] leading-tight">{label}</p>
    </div>
  );
}

// 고른 값은 칩으로, 더할 값은 드롭다운으로. 숫자는 보낼 수 있는 사람 수(0129). 0129 전이면 목록이 비어 있다.
function RegionPicker({
  label,
  placeholder,
  options,
  value,
  onChange,
}: {
  label: string;
  placeholder: string;
  options: { value: string; count: number }[];
  value: string[];
  onChange: (next: string[]) => void;
}) {
  const left = options.filter((option) => !value.includes(option.value));
  return (
    <div className="text-xs font-bold">
      {label}
      <select
        className="mt-1 h-11 w-full border border-[#d4d4d8] px-2 text-sm font-normal disabled:opacity-60"
        disabled={!left.length}
        onChange={(event) => {
          if (event.target.value) onChange([...value, event.target.value]);
        }}
        value=""
      >
        <option value="">{value.length ? "Add another…" : options.length ? placeholder : "No data yet"}</option>
        {left.map((option) => (
          <option key={option.value} value={option.value}>
            {option.value} ({option.count})
          </option>
        ))}
      </select>
      {value.length ? (
        <div className="mt-1 flex flex-wrap gap-1">
          {value.map((item) => (
            <button
              className="bg-[#f0eeff] px-2 py-0.5 text-xs font-bold text-[#4533ff]"
              key={item}
              onClick={() => onChange(value.filter((other) => other !== item))}
              type="button"
            >
              {item} ×
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function AudienceRow({
  customer,
  picked,
  onToggle,
}: {
  customer: AudienceCustomer;
  picked: boolean;
  onToggle: () => void;
}) {
  return (
    <tr className={`border-b border-[#f0f0f2] ${customer.ok ? "" : "text-[#9ca3af]"}`}>
      <td className="w-8 px-2">
        <input checked={picked} disabled={!customer.ok} onChange={onToggle} type="checkbox" aria-label={customer.name} />
      </td>
      <td className="px-2 py-1.5 font-bold">
        {customer.name}
        {customer.is_member ? <span className="ml-1 bg-[#fff4dc] px-1 text-[10px] text-[#8a5a00]">Member</span> : null}
      </td>
      <td className="px-2 py-1.5 whitespace-nowrap">{formatPhone(customer.phone)}</td>
      <td className="hidden px-2 py-1.5 whitespace-nowrap text-[#6b7280] sm:table-cell">{customer.city ?? ""}</td>
      <td className="px-2 py-1.5 text-right whitespace-nowrap">{customer.rounds} rds</td>
      <td className="px-2 py-1.5 text-right whitespace-nowrap">{customer.reason ? REASON_LABEL[customer.reason] : "✓"}</td>
    </tr>
  );
}

// ===== 캠페인 기록 =========================================================

const STATUS_TONE: Record<Campaign["status"], string> = {
  ready: "bg-[#fff4dc] text-[#8a5a00]",
  sending: "bg-[#e6efff] text-[#2449b3]",
  sent: "bg-[#e3f5e8] text-[#16723a]",
  cancelled: "bg-[#f0f1f3] text-[#4e5560]",
};

function clubTime(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString("en-CA", {
    timeZone: "America/Toronto",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function Campaigns({ initial, status }: { initial: number | null; status: MarketingStatus | null }) {
  const [list, setList] = useState<Campaign[] | null>(null);
  const [selected, setSelected] = useState<number | null>(initial);
  const [detail, setDetail] = useState<Campaign | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const loadList = useCallback(() => {
    marketingApi.campaigns().then(
      (value) => {
        setList(value);
        setSelected((current) => current ?? value[0]?.id ?? null);
      },
      (cause) => setError(describeMarketingError(cause)),
    );
  }, []);

  const loadDetail = useCallback((id: number) => {
    marketingApi.campaign(id).then(setDetail, (cause) => setError(describeMarketingError(cause)));
  }, []);

  useEffect(loadList, [loadList]);
  useEffect(() => {
    if (selected !== null) loadDetail(selected);
  }, [selected, loadDetail]);

  // 보내는 중이면 5초마다 새로.
  useEffect(() => {
    if (detail?.status !== "sending" || selected === null) return;
    const timer = window.setInterval(() => {
      loadDetail(selected);
      loadList();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [detail?.status, selected, loadDetail, loadList]);

  const act = async (what: "send" | "cancel" | "retry", sendIds?: number[]) => {
    if (!detail) return;
    if (what === "cancel" && !window.confirm("Stop this campaign? People not reached yet will not get it.")) return;
    if (
      what === "retry" &&
      !sendIds &&
      !window.confirm(`Send again to the ${detail.counts.failed ?? 0} people it failed for? Others will not get it again.`)
    )
      return;
    setBusy(true);
    setError("");
    try {
      if (what === "send") await marketingApi.send(detail.id);
      else if (what === "retry") await marketingApi.retry(detail.id, sendIds);
      else await marketingApi.cancel(detail.id);
      loadDetail(detail.id);
      loadList();
    } catch (cause) {
      setError(describeMarketingError(cause));
    } finally {
      setBusy(false);
    }
  };

  const waiting = (detail?.counts.queued ?? 0) + (detail?.counts.sending ?? 0);

  return (
    <div className="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
      <section className="bg-white shadow-sm">
        {list === null ? <p className="p-4 text-sm text-[#6b7280]">Loading…</p> : null}
        {list?.length === 0 ? <p className="p-4 text-sm text-[#6b7280]">No campaigns yet.</p> : null}
        <ul>
          {(list ?? []).map((campaign) => {
            const total = Object.values(campaign.counts).reduce((sum, n) => sum + (n ?? 0), 0);
            return (
              <li key={campaign.id}>
                <button
                  className={`w-full border-b border-[#f0f0f2] p-3 text-left ${selected === campaign.id ? "bg-[#f0eeff]" : ""}`}
                  onClick={() => setSelected(campaign.id)}
                  type="button"
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-bold">{campaign.name}</span>
                    <span className={`shrink-0 px-1.5 py-0.5 text-[10px] font-bold ${STATUS_TONE[campaign.status]}`}>
                      {campaign.status}
                    </span>
                  </span>
                  <span className="mt-0.5 block text-xs text-[#6b7280]">
                    {campaign.audience?.kind === "weather" ? "Weather alert" : CHANNEL_LABEL[campaign.channel]} · {total}{" "}
                    people · {clubTime(campaign.created_at)}
                  </span>
                  {campaign.audience?.kind !== "weather" && describeCampaignAudience(campaign.audience) ? (
                    <span className="mt-0.5 block truncate text-xs font-bold text-[#4533ff]">
                      {describeCampaignAudience(campaign.audience)}
                    </span>
                  ) : null}
                  {campaign.opted_out_after ? (
                    <span className="mt-0.5 block text-xs font-bold text-[#8c1d1d]">
                      <span>Opted out after</span>: {campaign.opted_out_after}
                    </span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="min-w-0 bg-white p-4 shadow-sm">
        {error ? (
          <p className="mb-3 border border-[#f0b4b4] bg-[#fdf1f1] p-2 text-xs text-[#8c1d1d]" role="alert">
            {error}
          </p>
        ) : null}
        {!detail ? (
          <p className="text-sm text-[#6b7280]">Pick a campaign.</p>
        ) : (
          <>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="text-base font-bold">{detail.name}</h2>
                <p className="text-xs text-[#6b7280]">
                  {detail.audience?.kind === "weather"
                    ? `Weather alert to the ${detail.audience.date ?? ""} tee sheet`
                    : CHANNEL_LABEL[detail.channel]}{" "}
                  · created {clubTime(detail.created_at)}
                  {detail.created_by ? ` by ${detail.created_by}` : ""}
                </p>
                {campaignAudienceFacts(detail.audience).length ? (
                  <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
                    <span className="font-bold">Sent to</span>
                    {campaignAudienceFacts(detail.audience).map((fact) => (
                      <span className="bg-[#f0eeff] px-2 py-1 text-[#4533ff]" key={fact.label} title={fact.hint}>
                        <span className="text-[#6b7280]">{fact.label}</span>:{" "}
                        <span className="font-bold">{fact.value}</span>
                      </span>
                    ))}
                    {campaignAudienceFacts(detail.audience)[0]?.hint ? (
                      <span className="text-[#6b7280]">{campaignAudienceFacts(detail.audience)[0].hint}</span>
                    ) : null}
                  </div>
                ) : null}
              </div>
              <div className="flex gap-2">
                {detail.status === "ready" || (detail.status === "sending" && waiting > 0) ? (
                  <button
                    className="h-10 bg-[#4533ff] px-4 text-sm font-bold text-white disabled:opacity-60"
                    disabled={busy}
                    onClick={() => void act("send")}
                    type="button"
                  >
                    {detail.status === "ready" ? `Send to ${waiting}` : `Resume (${waiting} left)`}
                  </button>
                ) : null}
                {detail.status === "ready" || detail.status === "sending" ? (
                  <button
                    className="h-10 border border-[#d4d4d8] px-4 text-sm font-bold disabled:opacity-60"
                    disabled={busy}
                    onClick={() => void act("cancel")}
                    type="button"
                  >
                    Stop
                  </button>
                ) : null}
                {(detail.counts.failed ?? 0) > 0 && detail.status !== "cancelled" ? (
                  <button
                    className="h-10 border border-[#8c1d1d] px-4 text-sm font-bold text-[#8c1d1d] disabled:opacity-60"
                    disabled={busy}
                    onClick={() => void act("retry")}
                    title="Send again only to the people it failed for"
                    type="button"
                  >
                    {`Resend failed (${detail.counts.failed})`}
                  </button>
                ) : null}
              </div>
            </div>

            <p className="mt-3 border-l-4 border-[#4533ff] bg-[#f6f6f8] p-3 text-sm whitespace-pre-wrap">{detail.message}</p>

            <div className="mt-3 flex flex-wrap gap-2 text-xs">
              {Object.entries(detail.counts).map(([key, value]) => (
                <span className="bg-[#f0f1f3] px-2 py-1 font-bold" key={key}>
                  {SEND_STATUS_LABEL[key as keyof typeof SEND_STATUS_LABEL] ?? key}: {value}
                </span>
              ))}
              {detail.opted_out_after !== undefined ? (
                <span
                  className={`px-2 py-1 font-bold ${detail.opted_out_after ? "bg-[#fdf1f1] text-[#8c1d1d]" : "bg-[#f0f1f3]"}`}
                  title="People who got this campaign and then replied STOP, said no more calls, or were removed by staff"
                >
                  <span>Opted out after</span>: {detail.opted_out_after}
                </span>
              ) : null}
            </div>
            <CostLine campaign={detail} key={detail.id} />
            <RecipientMix sends={detail.sends ?? []} />
            {detail.replies && detail.replies.reached > 0 ? (
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                <span
                  className="bg-[#eaf6ee] px-2 py-1 font-bold text-[#1d6b3a]"
                  title={`People who got this and then booked or applied on the website, called, or texted back within ${detail.replies.days} days`}
                >
                  <span>Contacted us</span>: {detail.replies.responded} / {detail.replies.reached} (
                  {Math.round((detail.replies.responded / detail.replies.reached) * 100)}%)
                </span>
                {(["web", "call", "text"] as const).map((key) => (
                  <span className="bg-[#f0f1f3] px-2 py-1 font-bold" key={key}>
                    <span>{REPLY_LABEL[key]}</span>: {detail.replies?.[key] ?? 0}
                  </span>
                ))}
                <span className="text-[#6b7280]">
                  <span>Counted for {detail.replies.days} days after sending</span>
                  {detail.replies.until ? ` · until ${clubTime(detail.replies.until)}` : ""}
                </span>
              </div>
            ) : null}
            {detail.status === "sending" && waiting > 0 && status &&
            !(detail.audience?.kind === "weather" ? status.alert_window_open : status.window_open) ? (
              <p className="mt-2 text-xs text-[#8a5a00]">
                Paused outside sending hours (
                {detail.audience?.kind === "weather" ? status.alert_window : status.window}). Press Resume when the
                window opens.
              </p>
            ) : null}

            <Recipients
              busy={busy}
              campaign={detail}
              key={detail.id}
              onRetry={detail.status === "cancelled" ? undefined : (id) => void act("retry", [id])}
            />
            {detail.channel === "call" ? (
              <p className="mt-2 text-xs text-[#6b7280]">
                Call recordings and transcripts are in the admin Calls &amp; SMS page.
              </p>
            ) : null}
          </>
        )}
      </section>
    </div>
  );
}

/**
 * 받은 사람 표 — 번호(또는 이름) 찾기와 보기 필터. 필터 목록은 그 캠페인에 해당하는 사람이 있는 것만,
 * 연락 옴(0133)·고객 구분은 그 값이 있을 때만 보인다.
 */
function Recipients({
  busy,
  campaign,
  onRetry,
}: {
  busy: boolean;
  campaign: Campaign;
  /** 실패한 줄 하나만 다시 보내기(0136). 멈춘 캠페인이면 없다. */
  onRetry?: (sendId: number) => void;
}) {
  const [query, setQuery] = useState("");
  const [view, setView] = useState<SendView>("all");
  const sends = useMemo(() => campaign.sends ?? [], [campaign.sends]);
  const views = useMemo(() => {
    const options: [SendView, string][] = [
      ["all", "Everyone"],
      ["reached", "Sent / delivered"],
      ["not_reached", "Failed / skipped"],
      ["waiting", "Waiting"],
    ];
    if (campaign.replies) options.push(["contacted", "Contacted us"], ["no_contact", "No contact yet"]);
    options.push(["opted_out", "Opted out"]);
    if (sends.some((s) => s.customer)) {
      options.push(["member", "Members"], ["public", "Public"], ["not_in_list", "Not in customer list"]);
    }
    return options
      .map(([id, label]) => ({ id, label, count: sends.filter((s) => sendInView(s, id)).length }))
      .filter((o) => o.id === "all" || o.id === view || o.count > 0);
  }, [campaign.replies, sends, view]);
  const shown = useMemo(
    () => sends.filter((s) => sendInView(s, view) && sendMatches(s, query)),
    [sends, view, query],
  );
  const filtered = view !== "all" || query.trim() !== "";

  return (
    <>
      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
        <input
          aria-label="Find a number or name"
          className="h-9 w-full max-w-xs border border-[#d4d4d8] px-3 text-sm"
          inputMode="search"
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Find a number or name"
          type="search"
          value={query}
        />
        <label className="flex items-center gap-1">
          <span className="font-bold">Show</span>
          <select
            className="h-9 border border-[#d4d4d8] bg-white px-2 text-sm"
            onChange={(event) => setView(event.target.value as SendView)}
            value={view}
          >
            {views.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label} ({o.count})
              </option>
            ))}
          </select>
        </label>
        {filtered ? (
          <>
            <span className="text-[#6b7280]">{`Showing ${shown.length} of ${sends.length}`}</span>
            <button
              className="border border-[#cfd2d8] bg-white px-2 py-1 font-bold"
              onClick={() => {
                setQuery("");
                setView("all");
              }}
              type="button"
            >
              Clear
            </button>
          </>
        ) : null}
      </div>
      <div className="mt-3 max-h-[60vh] overflow-auto">
        <table className="w-full text-left text-xs">
          <thead className="sticky top-0 bg-white">
            <tr className="border-b border-[#d4d4d8]">
              <th className="px-2 py-1.5">Name</th>
              <th className="px-2 py-1.5">Phone</th>
              <th className="px-2 py-1.5">Type</th>
              <th className="px-2 py-1.5 text-right">Rounds</th>
              <th className="px-2 py-1.5">City</th>
              {campaign.audience?.kind === "weather" ? <th className="px-2 py-1.5">Tee time</th> : null}
              <th className="px-2 py-1.5">Status</th>
              {campaign.replies ? <th className="px-2 py-1.5">Contacted us</th> : null}
              <th className="px-2 py-1.5">Note</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((send) => (
              <tr className="border-b border-[#f0f0f2]" key={send.id}>
                <td className="px-2 py-1.5 font-bold">{send.name}</td>
                <td className="px-2 py-1.5 whitespace-nowrap">{formatPhone(send.phone)}</td>
                <td className="px-2 py-1.5 whitespace-nowrap">
                  {send.customer ? (
                    <>
                      <span className={send.customer.is_member ? "font-bold text-[#4533ff]" : ""}>
                        {send.customer.is_member ? "Member" : "Public"}
                      </span>
                      {send.customer.rounds >= 5 ? (
                        <span className="ml-1 bg-[#f0f1f3] px-1 text-[10px] font-bold">Regular</span>
                      ) : null}
                      {send.customer.new ? (
                        <span className="ml-1 bg-[#eaf6ee] px-1 text-[10px] font-bold text-[#1d6b3a]">New</span>
                      ) : null}
                    </>
                  ) : campaign.sends?.some((x) => x.customer) ? (
                    <span className="text-[#6b7280]">Not in customer list</span>
                  ) : null}
                </td>
                <td className="px-2 py-1.5 text-right">{send.customer?.rounds ?? ""}</td>
                <td className="px-2 py-1.5 whitespace-nowrap">{send.customer?.city ?? ""}</td>
                {campaign.audience?.kind === "weather" ? (
                  <td className="px-2 py-1.5 whitespace-nowrap">{send.tee_time ?? ""}</td>
                ) : null}
                <td className="px-2 py-1.5 whitespace-nowrap">
                {SEND_STATUS_LABEL[send.status]}
                {send.status === "failed" && onRetry ? (
                  <button
                    className="ml-2 border border-[#d4d4d8] px-1.5 py-0.5 text-[10px] font-bold disabled:opacity-60"
                    disabled={busy}
                    onClick={() => onRetry(send.id)}
                    type="button"
                  >
                    Resend
                  </button>
                ) : null}
              </td>
                {campaign.replies ? (
                  <td className="px-2 py-1.5 font-bold whitespace-nowrap text-[#1d6b3a]">
                    {(send.replied ?? []).map((key) => REPLY_LABEL[key]).join(" · ")}
                  </td>
                ) : null}
                <td className="max-w-[16rem] truncate px-2 py-1.5 text-[#6b7280]" title={send.error ?? ""}>
                  {send.optout ? (
                    <span className={`mr-1 font-bold ${send.optout.after_send ? "text-[#8c1d1d]" : ""}`}>
                      <span>{send.optout.after_send ? "Opted out after this" : "Opted out"}</span>
                      {" · "}
                      <span>{OPTOUT_SOURCE_LABEL[send.optout.source] ?? send.optout.source}</span>
                      {` · ${clubTime(send.optout.created_at)}`}
                    </span>
                  ) : null}
                  {send.error && !(send.optout && send.error === "opted out") ? send.error : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {filtered && !shown.length ? (
        <p className="px-2 py-4 text-center text-xs text-[#6b7280]">No one matches.</p>
      ) : null}
    </>
  );
}

/** 받은 사람들 구성 한 줄 — 0133 전 DB 에는 customer 가 없어서 아무것도 안 그린다. */
/**
 * 이 캠페인이 실제로 얼마 들었나 — 문자는 Twilio 가 한 통마다 매긴 요금 합, 전화는 ElevenLabs 크레딧 합.
 * 요금은 나가고 조금 뒤에 붙어서, 보내는 중이거나 아직 안 붙은 통이 있으면 30초마다 다시 묻는다.
 */
function CostLine({ campaign }: { campaign: Campaign }) {
  const [cost, setCost] = useState<CampaignCost | null>(null);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);
  const reached = (campaign.counts.sent ?? 0) + (campaign.counts.delivered ?? 0) + (campaign.counts.failed ?? 0);

  useEffect(() => {
    if (reached === 0) return;
    let live = true;
    marketingApi
      .cost(campaign.id)
      .then((c) => live && setCost(c))
      .catch((cause) => live && setError(describeMarketingError(cause)));
    return () => {
      live = false;
    };
  }, [campaign.id, reached, tick]);

  const waiting = campaign.status === "sending" || (cost?.pending ?? 0) > 0;
  useEffect(() => {
    if (!waiting || reached === 0) return;
    const timer = window.setTimeout(() => setTick((n) => n + 1), 30000);
    return () => window.clearTimeout(timer);
  }, [waiting, reached, tick]);

  if (reached === 0) return null;
  const sms = campaign.channel === "sms";
  const total = cost ? (sms ? money(cost.total, cost.unit, 2, 4) : credits(cost.total)) : "…";
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
      <span
        className="bg-[#fff4dc] px-2 py-1 font-bold text-[#8a5a00]"
        title={sms ? "What Twilio charged for these texts" : "ElevenLabs credits these calls used"}
      >
        <span>Cost</span>: {total}
        {sms && cost?.unit ? ` ${cost.unit}` : ""}
      </span>
      {cost && cost.priced > 0 ? (
        <span className="bg-[#f0f1f3] px-2 py-1 font-bold">
          <span>Per person</span>:{" "}
          {sms ? money(cost.total / cost.priced, cost.unit, 4, 4) : credits(cost.total / cost.priced)}
        </span>
      ) : null}
      {sms && cost?.segments ? (
        <span className="bg-[#f0f1f3] px-2 py-1 font-bold" title="Long texts are charged as several parts">
          <span>Text parts</span>: {cost.segments}
        </span>
      ) : null}
      {cost && cost.pending > 0 ? (
        <span className="text-[#6b7280]">
          {`${cost.pending} not priced yet — the bill updates in a minute`}
        </span>
      ) : null}
      {error ? <span className="text-[#8c1d1d]">{error}</span> : null}
    </div>
  );
}

function money(amount: number, currency: string, min: number, max: number): string {
  return new Intl.NumberFormat("en-CA", {
    style: "currency",
    currency: currency || "USD",
    currencyDisplay: "narrowSymbol",
    minimumFractionDigits: min,
    maximumFractionDigits: max,
  }).format(amount);
}

function credits(amount: number): string {
  return `${Math.round(amount).toLocaleString("en-CA")} credits`;
}

function RecipientMix({ sends }: { sends: CampaignSend[] }) {
  const mix = summarizeRecipients(sends);
  if (mix.known === 0) return null;
  const chips: [string, number][] = [
    ["Members", mix.members],
    ["Public", mix.publicGolfers],
    ["Regulars (5+ rounds)", mix.regulars],
    ["New this year", mix.newCustomers],
    ["Not in customer list", mix.notInList],
  ];
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
      <span className="font-bold">Who got it</span>
      {chips
        .filter(([, n]) => n > 0)
        .map(([label, n]) => (
          <span className="bg-[#f0eeff] px-2 py-1 font-bold text-[#4533ff]" key={label}>
            <span>{label}</span>: {n}
          </span>
        ))}
      {mix.cities.length ? (
        <span className="text-[#6b7280]">
          {mix.cities
            .slice(0, 5)
            .map(([city, n]) => `${city} ${n}`)
            .join(" · ")}
          {mix.cities.length > 5 ? ` · +${mix.cities.length - 5}` : ""}
        </span>
      ) : null}
    </div>
  );
}

// ===== 동의 ==============================================================

function Consent() {
  const [search, setSearch] = useState("");
  const { audience, error, loading, reload } = useAudience("sms", { segment: "all", min_rounds: 0, search });
  const [saving, setSaving] = useState<string | null>(null);
  const [saveError, setSaveError] = useState("");

  const save = async (customer: AudienceCustomer, prefs: { sms_ok?: boolean | null; call_ok?: boolean | null }) => {
    setSaving(customer.customer_ref);
    setSaveError("");
    try {
      await marketingApi.setPrefs(customer.customer_ref, prefs);
      reload();
    } catch (cause) {
      setSaveError(describeMarketingError(cause));
    } finally {
      setSaving(null);
    }
  };

  return (
    <section className="bg-white p-4 shadow-sm">
      <h2 className="text-sm font-bold">Marketing consent</h2>
      <p className="mt-1 text-xs leading-5 text-[#6b7280]">
        <b>Texts:</b> &ldquo;Auto&rdquo; texts members and anyone who has played here (existing customer). Set
        &ldquo;No&rdquo; to never text them, &ldquo;Yes&rdquo; when they signed up for promotions.{" "}
        <b>AI calls:</b> only customers marked &ldquo;Yes&rdquo; are called — mark it only when the customer said they
        want promotional calls.
      </p>
      <input
        className="mt-3 h-10 w-full max-w-md border border-[#d4d4d8] px-3 text-sm"
        onChange={(event) => setSearch(event.target.value)}
        placeholder="Search name or phone"
        value={search}
      />
      {error || saveError ? (
        <p className="mt-2 text-xs text-[#8c1d1d]" role="alert">
          {error || saveError}
        </p>
      ) : null}
      <div className={`mt-3 overflow-x-auto ${loading ? "opacity-60" : ""}`}>
        <table className="w-full min-w-[560px] text-left text-xs">
          <thead>
            <tr className="border-b border-[#d4d4d8]">
              <th className="px-2 py-1.5">Name</th>
              <th className="px-2 py-1.5">Phone</th>
              <th className="px-2 py-1.5">Texts</th>
              <th className="px-2 py-1.5">AI calls</th>
            </tr>
          </thead>
          <tbody>
            {(audience?.customers ?? []).slice(0, 100).map((customer) => (
              <tr className="border-b border-[#f0f0f2]" key={customer.customer_ref}>
                <td className="px-2 py-1.5 font-bold">
                  {customer.name}
                  {customer.is_member ? <span className="ml-1 bg-[#fff4dc] px-1 text-[10px] text-[#8a5a00]">Member</span> : null}
                </td>
                <td className="px-2 py-1.5 whitespace-nowrap">{formatPhone(customer.phone) || "—"}</td>
                <td className="px-2 py-1.5">
                  <select
                    className="h-8 border border-[#d4d4d8] px-1"
                    disabled={saving === customer.customer_ref}
                    onChange={(event) =>
                      void save(customer, { sms_ok: event.target.value === "auto" ? null : event.target.value === "yes" })
                    }
                    value={customer.sms_ok === null ? "auto" : customer.sms_ok ? "yes" : "no"}
                  >
                    <option value="auto">Auto</option>
                    <option value="yes">Yes</option>
                    <option value="no">No</option>
                  </select>
                </td>
                <td className="px-2 py-1.5">
                  <select
                    className="h-8 border border-[#d4d4d8] px-1"
                    disabled={saving === customer.customer_ref}
                    onChange={(event) => void save(customer, { call_ok: event.target.value === "yes" })}
                    value={customer.call_ok ? "yes" : "no"}
                  >
                    <option value="no">No</option>
                    <option value="yes">Yes</option>
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {audience && audience.customers.length > 100 ? (
          <p className="p-2 text-center text-xs text-[#6b7280]">
            Showing 100 of {audience.customers.length}. Search to find someone.
          </p>
        ) : null}
      </div>
    </section>
  );
}

// ===== 수신거부 ===========================================================

function OptOuts() {
  const [list, setList] = useState<OptOut[] | null>(null);
  const [phone, setPhone] = useState("");
  const [channel, setChannel] = useState<Channel>("sms");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    marketingApi.optOuts().then(setList, (cause) => setError(describeMarketingError(cause)));
  }, []);
  useEffect(load, [load]);

  const change = async (number: string, which: Channel, optedOut: boolean) => {
    setBusy(true);
    setError("");
    try {
      await marketingApi.setOptOut(number, which, optedOut);
      if (optedOut) setPhone("");
      load();
    } catch (cause) {
      setError(describeMarketingError(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="bg-white p-4 shadow-sm">
      <h2 className="text-sm font-bold">Opt-outs</h2>
      <p className="mt-1 text-xs leading-5 text-[#6b7280]">
        People who replied STOP, told the AI agent not to call again, or asked the pro shop. They are skipped in every
        campaign. Add someone here when they ask in person or by email.
      </p>
      <form
        className="mt-3 flex flex-wrap gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void change(phone, channel, true);
        }}
      >
        <input
          className="h-10 w-48 border border-[#d4d4d8] px-3 text-sm"
          inputMode="tel"
          onChange={(event) => setPhone(event.target.value)}
          placeholder="Phone number"
          value={phone}
        />
        <select
          className="h-10 border border-[#d4d4d8] px-2 text-sm"
          onChange={(event) => setChannel(event.target.value as Channel)}
          value={channel}
        >
          <option value="sms">No texts</option>
          <option value="call">No calls</option>
        </select>
        <button className="h-10 bg-[#111315] px-4 text-sm font-bold text-white disabled:opacity-60" disabled={busy || !phone.trim()} type="submit">
          Add
        </button>
      </form>
      {error ? (
        <p className="mt-2 text-xs text-[#8c1d1d]" role="alert">
          {error}
        </p>
      ) : null}
      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[520px] text-left text-xs">
          <thead>
            <tr className="border-b border-[#d4d4d8]">
              <th className="px-2 py-1.5">Phone</th>
              <th className="px-2 py-1.5">Customer</th>
              <th className="px-2 py-1.5">Blocks</th>
              <th className="px-2 py-1.5">How</th>
              <th className="px-2 py-1.5">When</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list?.length === 0 ? (
              <tr>
                <td className="px-2 py-3 text-[#6b7280]" colSpan={6}>
                  Nobody has opted out.
                </td>
              </tr>
            ) : null}
            {(list ?? []).map((row) => (
              <tr className="border-b border-[#f0f0f2]" key={`${row.phone}-${row.channel}`}>
                <td className="px-2 py-1.5 whitespace-nowrap">{formatPhone(row.phone)}</td>
                <td className="px-2 py-1.5">{row.name ?? "—"}</td>
                <td className="px-2 py-1.5">{row.channel === "sms" ? "Texts" : "Calls"}</td>
                <td className="px-2 py-1.5">{row.source === "reply" ? "Replied STOP" : row.source === "call" ? "On a call" : "Staff"}</td>
                <td className="px-2 py-1.5 whitespace-nowrap">{clubTime(row.created_at)}</td>
                <td className="px-2 py-1.5 text-right">
                  <button
                    className="text-[#4533ff] underline disabled:opacity-60"
                    disabled={busy}
                    onClick={() => {
                      if (window.confirm("Remove this opt-out? Only do this if the customer asked to receive promotions again.")) {
                        void change(row.phone, row.channel, false);
                      }
                    }}
                    type="button"
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
