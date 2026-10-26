"use client";

/**
 * 마케팅 Weather alert 탭 — 서리 지연·비·번개·휴장 같은 날씨 돌발상황을 **그날 티 시트 손님**에게 문자로.
 *
 * 받는 사람은 서버(0118)가 정한다: 그날(오늘·내일) 예약 중 취소·노쇼·막음이 아닌 티 타임의 플레이어 중
 * 전화번호가 있고 문자 수신거부(STOP)가 아닌 사람. 같은 번호는 한 번만. 예약 안내라 CASL 거래 메시지 —
 * 동의 표시가 없어도 가고, 수신거부 문구도 붙지 않는다. 문자 안 {name}·{time} 은 백엔드가 사람마다 바꾼다.
 * 기록은 보통 캠페인과 같이 Campaigns 탭에 남는다(멈추기·이어 보내기도 거기서).
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  type MarketingStatus,
  type WeatherAudience,
  type WeatherTeeTime,
  describeMarketingError,
  formatPhone,
  isMarketingMissing,
  marketingApi,
} from "@/lib/marketing/api";

const PRESETS: { key: string; label: string; message: string }[] = [
  {
    key: "frost",
    label: "Frost delay",
    message:
      "Hi {name}, frost delay this morning. Your {time} tee time will start about 30 minutes late. We'll text you when the course opens. Questions: 416-822-7609.",
  },
  {
    key: "rain_delay",
    label: "Rain delay",
    message:
      "Hi {name}, heavy rain right now. Play is on hold — please check in with the pro shop before your {time} tee time. We'll text you when play resumes. 416-822-7609.",
  },
  {
    key: "lightning",
    label: "Lightning — play stopped",
    message:
      "Hi {name}, lightning near the course: play is suspended for your safety. Please don't head out for your {time} tee time yet. We'll text you when it's safe.",
  },
  {
    key: "closed",
    label: "Course closed",
    message:
      "Hi {name}, because of the weather the course is closed today. Your {time} tee time is cancelled, no charge. Call 416-822-7609 or book online to pick a new time.",
  },
  {
    key: "cart_path",
    label: "Cart path only",
    message:
      "Hi {name}, wet course today: carts are cart-path only. Your {time} tee time is still on — please allow a little extra time. See you soon!",
  },
  {
    key: "resumed",
    label: "All clear",
    message: "Hi {name}, good news — the course is open and play has resumed. Your {time} tee time is on. See you soon!",
  },
];

const REASON: Record<string, string> = { no_phone: "No phone", opted_out: "Opted out" };

function clubDate(offsetDays: number): string {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Toronto" });
  const [y, m, d] = today.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + offsetDays)).toISOString().slice(0, 10);
}

function dayLabel(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-CA", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

/** 보낼 수 있는 번호 — 고른 티 타임 안에서 번호마다 한 번(서버와 같다: 가장 이른 티 타임). */
function recipientsOf(teeTimes: WeatherTeeTime[], picked: Set<string>) {
  const byPhone = new Map<string, { name: string; time: string }>();
  for (const tee of teeTimes) {
    if (!picked.has(tee.booking_id)) continue;
    for (const player of tee.players) {
      if (player.ok && player.phone && !byPhone.has(player.phone)) {
        byPhone.set(player.phone, { name: player.name, time: tee.time });
      }
    }
  }
  return [...byPhone.values()];
}

function fill(message: string, name: string, time: string): string {
  const first = name.split(/\s+/)[0] || "there";
  return message
    .trim()
    .replaceAll("{name}", first.toLowerCase() === "guest" ? "there" : first)
    .replaceAll("{time}", time)
    .replace(/\s+/g, " ");
}

export default function WeatherAlert({
  status,
  onCreated,
}: {
  status: MarketingStatus | null;
  onCreated: (id: number) => void;
}) {
  const [date, setDate] = useState(() => clubDate(0));
  const [audience, setAudience] = useState<WeatherAudience | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [preset, setPreset] = useState(PRESETS[0].key);
  const [message, setMessage] = useState(PRESETS[0].message);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback((day: string) => {
    setLoading(true);
    setLoadError("");
    marketingApi
      .weatherAudience(day)
      .then(
        (value) => {
          setAudience(value);
          // 오늘은 지금부터의 티 타임(이미 나간 팀은 빼고), 내일은 전부.
          const from = value.date === value.today ? value.now_minutes - 15 : -1;
          setPicked(new Set(value.tee_times.filter((t) => t.minutes >= from).map((t) => t.booking_id)));
        },
        (cause) =>
          setLoadError(
            isMarketingMissing(cause)
              ? "Weather alerts are not switched on yet. Run supabase/migrations/0118_marketing_weather_alert.sql in the Supabase SQL editor."
              : describeMarketingError(cause),
          ),
      )
      .finally(() => setLoading(false));
  }, []);

  // useAudience 처럼 타이머 뒤에서 — effect 안에서 바로 setState 하지 않는다.
  useEffect(() => {
    const timer = window.setTimeout(() => load(date), 0);
    return () => window.clearTimeout(timer);
  }, [date, load]);

  const teeTimes = useMemo(() => audience?.tee_times ?? [], [audience]);
  const recipients = useMemo(() => recipientsOf(teeTimes, picked), [teeTimes, picked]);
  const sample = recipients[0] ?? { name: "Ann Lee", time: teeTimes[0]?.time ?? "9:20 AM" };
  const sender = status?.sms_sender ?? "Pelham Hills Golf";
  const filled = fill(message, sample.name, sample.time);
  const preview = message.trim() ? `${filled.toLowerCase().startsWith("pelham hills") ? "" : `${sender}: `}${filled}` : "";
  const parts = preview ? Math.ceil(preview.length / 153) : 0;
  const presetLabel = PRESETS.find((p) => p.key === preset)?.label ?? "Weather alert";
  const isToday = audience ? audience.date === audience.today : true;
  const ready = message.trim() && message.length <= 320 && recipients.length > 0;

  const toggle = (id: string) =>
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const send = async () => {
    setBusy(true);
    setError("");
    try {
      const campaign = await marketingApi.createWeatherAlert({
        date,
        name: `Weather · ${presetLabel} · ${dayLabel(date)}`,
        message: message.trim(),
        booking_ids: teeTimes.filter((t) => picked.has(t.booking_id)).map((t) => t.booking_id),
      });
      try {
        await marketingApi.send(campaign.id);
      } catch (cause) {
        window.alert(`Alert saved, but it did not start: ${describeMarketingError(cause)}`);
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
        <h2 className="text-sm font-bold">1. Day and situation</h2>
        <div className="mt-3 grid grid-cols-2 gap-2">
          {[0, 1].map((offset) => {
            const day = clubDate(offset);
            return (
              <button
                className={`min-h-12 border p-2 text-left text-sm ${date === day ? "border-[#4533ff] bg-[#f0eeff]" : "border-[#d4d4d8]"}`}
                key={day}
                onClick={() => setDate(day)}
                type="button"
              >
                <span className="block font-bold">{offset === 0 ? "Today" : "Tomorrow"}</span>
                <span className="block text-xs text-[#6b7280]">{dayLabel(day)}</span>
              </button>
            );
          })}
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
          {PRESETS.map((item) => (
            <button
              className={`min-h-10 border px-2 text-left text-xs font-bold ${
                preset === item.key ? "border-[#4533ff] bg-[#f0eeff] text-[#4533ff]" : "border-[#d4d4d8]"
              }`}
              key={item.key}
              onClick={() => {
                setPreset(item.key);
                setMessage(item.message);
              }}
              type="button"
            >
              {item.label}
            </button>
          ))}
        </div>

        <label className="mt-4 block text-xs font-bold" htmlFor="weather-message">
          Text message
        </label>
        <textarea
          className="mt-1 min-h-32 w-full border border-[#d4d4d8] p-3 text-base"
          id="weather-message"
          onChange={(event) => setMessage(event.target.value)}
          value={message}
        />
        <p className="mt-1 flex justify-between gap-2 text-xs text-[#6b7280]">
          <span>
            <b>{"{name}"}</b> = first name, <b>{"{time}"}</b> = their tee time
          </span>
          <span className={message.length > 320 ? "text-[#a12a2a]" : ""}>{message.length}/320</span>
        </p>

        {preview ? (
          <div className="mt-2">
            <p className="text-xs font-bold">What {sample.name.split(/\s+/)[0] || "the customer"} sees</p>
            <p className="mt-1 max-w-sm rounded-2xl bg-[#e9e9eb] px-3 py-2 text-sm whitespace-pre-wrap">{preview}</p>
            <p className="mt-1 text-xs text-[#6b7280]">
              {preview.length} characters · about {parts} text{parts === 1 ? "" : "s"} per person. This is a notice about
              their booking, so no opt-out line is added. Numbers that replied STOP are still left out.
            </p>
          </div>
        ) : null}
        {status && status.alert_window_open === false ? (
          <p className="mt-2 border border-[#f0d58a] bg-[#fff8e1] p-2 text-xs text-[#6b4e00]">
            Weather alerts go out {status.alert_window ?? "6:00 AM–10:00 PM"} (club time). You can save it now and it
            waits in Campaigns.
          </p>
        ) : null}
      </section>

      <section className="bg-white p-4 shadow-sm">
        <h2 className="text-sm font-bold">2. Tee times on {dayLabel(date)}</h2>
        {loadError ? (
          <p className="mt-3 text-xs text-[#8c1d1d]" role="alert">
            {loadError}
          </p>
        ) : null}
        {audience ? (
          <div className={`mt-3 grid grid-cols-4 gap-2 text-center ${loading ? "opacity-60" : ""}`}>
            <Stat label="Will receive" value={recipients.length} strong />
            <Stat label="Tee times picked" value={picked.size} />
            <Stat label="No phone" value={audience.no_phone} />
            <Stat label="Opted out" value={audience.opted_out} />
          </div>
        ) : null}

        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
          <span className="mr-auto text-[#6b7280]">
            {picked.size} of {teeTimes.length} tee times
          </span>
          {isToday && audience ? (
            <button
              className="border border-[#d4d4d8] px-3 py-1 font-bold"
              onClick={() =>
                setPicked(new Set(teeTimes.filter((t) => t.minutes >= audience.now_minutes - 15).map((t) => t.booking_id)))
              }
              type="button"
            >
              From now on
            </button>
          ) : null}
          <button className="border border-[#d4d4d8] px-3 py-1 font-bold" onClick={() => setPicked(new Set(teeTimes.map((t) => t.booking_id)))} type="button">
            All
          </button>
          <button className="border border-[#d4d4d8] px-3 py-1 font-bold" onClick={() => setPicked(new Set())} type="button">
            None
          </button>
          <button className="border border-[#d4d4d8] px-3 py-1 font-bold" onClick={() => load(date)} type="button">
            Refresh
          </button>
        </div>

        <div className="mt-2 max-h-[28rem] overflow-y-auto border border-[#ececf0]">
          {audience && teeTimes.length === 0 ? (
            <p className="p-4 text-center text-sm text-[#6b7280]">No bookings on the tee sheet for this day.</p>
          ) : null}
          {teeTimes.map((tee) => {
            const past = isToday && audience ? tee.minutes < audience.now_minutes - 15 : false;
            return (
              <label
                className={`flex cursor-pointer gap-2 border-b border-[#f0f0f2] p-2 text-xs ${past ? "bg-[#fafafa]" : ""}`}
                key={tee.booking_id}
              >
                <input checked={picked.has(tee.booking_id)} onChange={() => toggle(tee.booking_id)} type="checkbox" />
                <span className="w-16 shrink-0 font-bold">{tee.time}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-bold">
                    {tee.title}
                    {past ? <span className="ml-1 font-normal text-[#9ca3af]">(already started)</span> : null}
                  </span>
                  {tee.players.map((player, index) => (
                    <span className={`block truncate ${player.ok ? "" : "text-[#9ca3af]"}`} key={`${tee.booking_id}-${index}`}>
                      {player.name} · {player.phone ? formatPhone(player.phone) : "—"}
                      {player.reason ? ` · ${REASON[player.reason] ?? player.reason}` : ""}
                    </span>
                  ))}
                </span>
              </label>
            );
          })}
        </div>
        <p className="mt-1 text-xs text-[#6b7280]">
          A phone number on several tee times gets one text, with its earliest tee time.
        </p>
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
              Text <b>{presetLabel}</b> to <b>{recipients.length}</b> golfer{recipients.length === 1 ? "" : "s"} booked{" "}
              {dayLabel(date)} now? Sent texts cannot be taken back.
            </p>
            <div className="flex gap-2">
              <button className="h-11 border border-[#d4d4d8] px-4 text-sm font-bold" disabled={busy} onClick={() => setConfirming(false)} type="button">
                Back
              </button>
              <button
                className="h-11 bg-[#4533ff] px-5 text-sm font-bold text-white disabled:opacity-60"
                disabled={busy}
                onClick={() => void send()}
                type="button"
              >
                {busy ? "Starting…" : "Yes, send now"}
              </button>
            </div>
          </div>
        ) : (
          <div className="flex justify-end">
            <button
              className="h-11 bg-[#4533ff] px-5 text-sm font-bold text-white disabled:opacity-50"
              disabled={!ready || busy || status?.sms === false}
              onClick={() => setConfirming(true)}
              type="button"
            >
              Text {recipients.length} golfer{recipients.length === 1 ? "" : "s"}…
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

function Stat({ label, value, strong }: { label: string; value: number; strong?: boolean }) {
  return (
    <div className={`p-2 ${strong ? "bg-[#f0eeff] text-[#4533ff]" : "bg-[#f6f6f8]"}`}>
      <p className="text-lg font-bold">{value}</p>
      <p className="text-[10px] leading-tight">{label}</p>
    </div>
  );
}
