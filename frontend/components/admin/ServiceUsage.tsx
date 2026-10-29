"use client";

/**
 * Calls & SMS 의 "Usage" 탭 — 전화·문자·서버가 쓰는 바깥 서비스 세 곳의 사용량과 잔액.
 *   ElevenLabs: 구독 등급, 이번 주기 크레딧 사용/한도, 리셋 날짜, 다음 청구.
 *   Twilio: 계정 잔액, 이번 달 항목별 사용(문자·MMS·번호 …)과 합계.
 *   Fly: 결제 상태·크레딧, 앱별 머신 상태·크기. 달러 사용액은 Fly 가 API 로 주지 않아 대시보드 링크.
 * 서버(`backend/api/routes/usage.py`)가 키를 들고 대신 읽는다. 매니저·마케팅 명단 계정만.
 */

import { useCallback, useEffect, useState } from "react";

import {
  type ElevenLabsUsage,
  type FlyUsage,
  type ServiceUsage as Usage,
  type TwilioUsage,
  fetchUsage,
  money,
} from "@/lib/calls/api";

function day(unix: number | null | undefined): string {
  if (!unix) return "–";
  return new Date(unix * 1000).toLocaleDateString("en-CA", { month: "short", day: "numeric", year: "numeric" });
}

export function ServiceUsage({ refreshKey }: { refreshKey: number }) {
  const [usage, setUsage] = useState<Usage | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(
    (fresh: boolean) =>
      fetchUsage(fresh)
        .then((next) => {
          setError("");
          setUsage(next);
        })
        .catch((err) => setError(err instanceof Error ? err.message : "Could not load usage."))
        .finally(() => setLoading(false)),
    [],
  );

  // 첫 열기는 서버가 1분 담아 둔 값, Refresh 는 새로 읽는다.
  useEffect(() => {
    void load(refreshKey > 0);
  }, [load, refreshKey]);

  if (error) {
    return (
      <p className="border border-[#f0c4c4] bg-[#fdf2f2] px-3 py-2 text-sm text-[#a12a2a]" role="alert">
        {error}
      </p>
    );
  }
  if (!usage) return <p className="text-sm text-[#6b7280]">{loading ? "Loading…" : ""}</p>;
  return (
    <div className="grid gap-4">
      <div className="grid gap-4 lg:grid-cols-3">
        <ElevenLabsCard data={usage.elevenlabs} />
        <TwilioCard data={usage.twilio} />
        <FlyCard data={usage.fly} />
      </div>
      <p className="text-xs text-[#6b7280]">
        <span>Checked</span> {new Date(usage.checked_at * 1000).toLocaleString("en-CA")}
        {loading ? " · …" : ""}
      </p>
    </div>
  );
}

function Card({
  title,
  subtitle,
  console,
  children,
}: {
  title: string;
  subtitle: string;
  console?: string;
  children: React.ReactNode;
}) {
  return (
    <article className="flex flex-col border border-[#d6d6dc] bg-white p-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-bold">{title}</h3>
          <p className="text-xs text-[#6b7280]">{subtitle}</p>
        </div>
        {console ? (
          <a className="shrink-0 text-xs font-bold text-[#4533ff]" href={console} rel="noreferrer" target="_blank">
            Open billing ↗
          </a>
        ) : null}
      </div>
      <div className="mt-3 grid gap-3 text-sm">{children}</div>
    </article>
  );
}

function Problem({ error }: { error: string }) {
  return <p className="border border-[#f3dca5] bg-[#fff8e6] px-3 py-2 text-xs text-[#8a5a00]">{error}</p>;
}

function Fact({ label, value, tone }: { label: string; value: string; tone?: "bad" | "good" }) {
  const color = tone === "bad" ? "text-[#a12a2a]" : tone === "good" ? "text-[#16723a]" : "";
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-[#f0f0f2] pb-1.5 last:border-b-0">
      <span className="text-xs text-[#6b7280]">{label}</span>
      <strong className={`text-right ${color}`}>{value}</strong>
    </div>
  );
}

function ElevenLabsCard({ data }: { data: ElevenLabsUsage }) {
  if (!data.ok) {
    return (
      <Card console="https://elevenlabs.io/app/subscription" subtitle="AI phone assistant & calls" title="ElevenLabs">
        <Problem error={data.error} />
      </Card>
    );
  }
  const left = Math.max(data.limit - data.used, 0);
  const share = data.limit ? Math.min(data.used / data.limit, 1) : 0;
  return (
    <Card console={data.console} subtitle="AI phone assistant & calls" title="ElevenLabs">
      <div>
        <div className="flex items-baseline justify-between">
          <span className="text-2xl font-semibold">{left.toLocaleString("en-CA")}</span>
          <span className="text-xs text-[#6b7280]">
            <span>credits left of</span> {data.limit.toLocaleString("en-CA")}
          </span>
        </div>
        <div className="mt-2 h-2 bg-[#ececf0]">
          <div
            className={`h-2 ${share > 0.9 ? "bg-[#c43b3b]" : share > 0.7 ? "bg-[#d99a1c]" : "bg-[#4533ff]"}`}
            style={{ width: `${share * 100}%` }}
          />
        </div>
      </div>
      <Fact label="Plan" value={`${data.tier ?? "–"}${data.status ? ` · ${data.status}` : ""}`} />
      <Fact label="Used this period" value={`${data.used.toLocaleString("en-CA")} (${Math.round(share * 100)}%)`}
        tone={share > 0.9 ? "bad" : undefined} />
      <Fact label="Credits reset" value={day(data.resets_at)} />
      {data.next_invoice_cents !== null ? (
        <Fact label="Next bill" value={`${money(data.next_invoice_cents / 100, data.currency)} · ${day(data.next_invoice_at)}`} />
      ) : null}
      {left === 0 ? <Problem error="No credits left — the phone assistant and website chat stop answering." /> : null}
    </Card>
  );
}

function TwilioCard({ data }: { data: TwilioUsage }) {
  if (!data.ok) {
    return (
      <Card subtitle="Texts and phone numbers" title="Twilio">
        <Problem error={data.error} />
      </Card>
    );
  }
  return (
    <Card console={data.console} subtitle="Texts and phone numbers" title="Twilio">
      <div className="flex items-baseline justify-between">
        <span className={`text-2xl font-semibold ${data.balance !== null && data.balance < 0 ? "text-[#a12a2a]" : ""}`}>
          {money(data.balance, data.currency)}
        </span>
        <span className="text-xs text-[#6b7280]">
          <span>account balance</span> ({data.currency})
        </span>
      </div>
      <Fact label="This month so far" value={`${money(data.month_total, data.month_unit)} ${data.month_unit}`} />
      {data.rows.map((row) => (
        <Fact
          key={row.category}
          label={row.label}
          value={`${row.count.toLocaleString("en-CA")} · ${money(row.price, data.month_unit)}`}
        />
      ))}
      {data.month_start ? (
        <p className="text-xs text-[#6b7280]">
          <span>Since</span> {data.month_start}
        </p>
      ) : null}
    </Card>
  );
}

function FlyCard({ data }: { data: FlyUsage }) {
  if (!data.ok) {
    return (
      <Card console="https://fly.io/dashboard" subtitle="Server (bookings API, phone tools, uptime)" title="Fly.io">
        <Problem error={data.error} />
      </Card>
    );
  }
  const current = data.billing_status === "CURRENT";
  return (
    <Card console={data.console} subtitle="Server (bookings API, phone tools, uptime)" title="Fly.io">
      <Fact label="Billing" tone={current ? "good" : "bad"} value={current ? "Paid up" : (data.billing_status ?? "–")} />
      <Fact label="Card on file" tone={data.card_saved ? undefined : "bad"} value={data.card_saved ? "Yes" : "No"} />
      <Fact label="Credit" value={money(data.credit, "USD")} />
      {data.apps.map((app) => (
        <div className="border border-[#ececf0] p-2" key={app.name}>
          <p className="text-xs font-bold">{app.name}</p>
          {app.machines.length ? (
            app.machines.map((m) => (
              <p className="mt-1 flex justify-between gap-2 text-xs" key={m.id}>
                <span className={m.state === "started" ? "text-[#16723a]" : "text-[#a12a2a]"}>● {m.state}</span>
                <span className="text-[#6b7280]">
                  {m.region} · {m.cpus ?? "?"} {m.cpu_kind ?? ""} CPU · {m.memory_mb ?? "?"} MB
                </span>
              </p>
            ))
          ) : (
            <p className="mt-1 text-xs text-[#6b7280]">{app.status ?? "No machines"}</p>
          )}
        </div>
      ))}
      <p className="text-xs text-[#6b7280]">Monthly dollar usage is only on the Fly dashboard (Open billing).</p>
    </Card>
  );
}
