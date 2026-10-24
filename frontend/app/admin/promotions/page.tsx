"use client";

/**
 * 프로모션 코드(0078). 여기서 만든 코드는 서버에 남고, 바코드(`PROMO-` + 코드)를 티 시트나 계산대에서
 * 찍으면 계산서의 그린피에서 할인된다. 손님이 코드만 말하면 계산서의 Promo code 칸에 친다.
 *
 * Text it 은 마케팅 사이트(/marketing)를 새 탭으로 열어 이 코드로 문자 캠페인 초안을 채운다.
 * 그 문자에는 바코드 그림이 MMS 로 붙는다(백엔드 marketing.py).
 */

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

import AdminShell from "@/components/admin/AdminShell";
import { ADMIN_HOME } from "@/lib/nav";
import { describePosError } from "@/lib/pos/api";
import {
  PROMO_STATE_LABEL,
  promoApi,
  promoDiscountLabel,
  type Promotion,
  type PromotionInput,
} from "@/lib/pos/promo";
import { code128Svg } from "@/lib/retail/barcode";

type DiscountKind = "per_player" | "per_bill" | "percent";

const CONDITIONS = [
  "18 holes · public rate",
  "Mon-Thu · 18 holes · public rate",
  "9 holes · twilight only",
  "Member guest · max 2 guests",
  "Weekday morning · cart required",
];

const EMPTY_FORM = {
  code: "",
  name: "",
  kind: "per_player" as DiscountKind,
  value: "",
  conditions: CONDITIONS[0],
  expires: "",
  limit: "100",
};

function stateClass(state: Promotion["state"]) {
  if (state === "active") return "bg-[#dff7e8] text-[#087333]";
  if (state === "scheduled") return "bg-[#ffd400] text-[#1d232b]";
  return "bg-[#ececf0] text-[#4e5560]";
}

// 마케팅 사이트(/marketing)의 새 문자 캠페인을 이 코드로 채워 연다. 마케팅은 따로 로그인하므로 새 탭.
function textCampaignHref(promotion: Promotion) {
  // "·" 같은 글자가 하나라도 있으면 문자가 70자씩 쪼개진다(UCS-2). 쉼표로 바꾼다.
  const condition = (promotion.conditions ?? "").replace(/\s*·\s*/g, ", ");
  const expires = promotion.expires_on ? ` Valid until ${promotion.expires_on}.` : "";
  const message =
    `${promotion.name}: ${promoDiscountLabel(promotion)} with code ${promotion.code}` +
    `${condition ? ` (${condition})` : ""}.${expires} Show this barcode at the pro shop. ` +
    `Book at pelhamhills.ca/book or call 416-822-7609.`;
  const query = new URLSearchParams({
    channel: "sms",
    name: `${promotion.code} · ${promotion.name}`,
    message,
    barcode: promotion.barcode,
  });
  return `/marketing?${query.toString()}`;
}

/** 바코드 한 장을 인쇄한다. 프로 샵 카운터에 붙여 두거나 손님에게 건넬 때. */
function printBarcode(promotion: Promotion) {
  const win = window.open("", "_blank", "width=480,height=360");
  if (!win) return;
  const escape = (text: string) => text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
  win.document.write(
    `<!doctype html><title>${escape(promotion.code)}</title>` +
      `<style>body{font-family:system-ui,sans-serif;text-align:center;padding:24px}svg{width:320px;height:90px}h1{font-size:18px;margin:0 0 4px}p{margin:4px 0}</style>` +
      `<h1>${escape(promotion.name)}</h1><p>${escape(promoDiscountLabel(promotion))}</p>` +
      `${code128Svg(promotion.barcode)}<p><b>${escape(promotion.barcode)}</b></p>` +
      `${promotion.expires_on ? `<p>Valid until ${escape(promotion.expires_on)}</p>` : ""}`,
  );
  win.document.close();
  win.focus();
  win.print();
}

export default function PromotionsPage() {
  const [promotions, setPromotions] = useState<Promotion[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [shown, setShown] = useState<number | null>(null);

  const [nonce, setNonce] = useState(0);
  const load = useCallback(() => setNonce((value) => value + 1), []);

  useEffect(() => {
    let cancelled = false;
    promoApi
      .list()
      .then(
        (list) => {
          if (cancelled) return;
          setPromotions(list);
          setError("");
        },
        (cause) => {
          if (!cancelled) setError(describePosError(cause));
        },
      )
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [nonce]);

  const activeCount = useMemo(() => promotions.filter((p) => p.state === "active").length, [promotions]);
  const totalUses = promotions.reduce((sum, p) => sum + p.used, 0);

  async function createPromotion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const amount = Number(form.value);
    if (!Number.isFinite(amount) || amount <= 0) {
      setError("Enter the discount: dollars off, or a percent.");
      return;
    }
    const input: PromotionInput = {
      code: form.code.trim().toUpperCase(),
      name: form.name.trim(),
      kind: form.kind === "percent" ? "percent" : "amount",
      value: form.kind === "percent" ? Math.round(amount) : Math.round(amount * 100),
      per_player: form.kind !== "per_bill",
      conditions: form.conditions,
      expires_on: form.expires || null,
      usage_limit: Number(form.limit) > 0 ? Math.round(Number(form.limit)) : null,
    };
    setSaving(true);
    try {
      const saved = await promoApi.save(input);
      setForm(EMPTY_FORM);
      setShown(saved.id);
      setError("");
      load();
    } catch (cause) {
      setError(describePosError(cause));
    } finally {
      setSaving(false);
    }
  }

  async function setActive(promotion: Promotion, active: boolean) {
    try {
      await promoApi.save({ id: promotion.id, name: promotion.name, kind: promotion.kind, value: promotion.value, active });
      load();
    } catch (cause) {
      setError(describePosError(cause));
    }
  }

  return (
    <AdminShell
      actions={
        <Link className="tap-target bg-[#4533ff] px-4 py-1.5 text-xs font-bold text-white" href={ADMIN_HOME}>
          Tee Sheet
        </Link>
      }
      screen="promotions"
      title="Promotions"
    >
      <div className="grid min-w-0 grid-rows-[auto_1fr]">
        <section className="border-b border-[#d4d4d8] bg-white px-4 py-3">
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <span className="rounded bg-[#111315] px-2 py-1 text-white">{promotions.length} Codes</span>
            <span>{activeCount} Active</span>
            <span>{totalUses} Uses</span>
            <span className="text-[#5d6673]">
              Scan the barcode on the tee sheet after adding the green fee, or type the code in the bill&apos;s Promo
              code box.
            </span>
          </div>
        </section>

        <section className="grid min-h-0 gap-4 p-4 xl:grid-cols-[360px_1fr]">
          <form className="border border-[#d4d4d8] bg-white p-4" onSubmit={createPromotion}>
            <div className="mb-4">
              <p className="text-[11px] font-bold uppercase text-[#5d6673]">Create Coupon</p>
              <p className="text-xl font-bold">Discount Code</p>
            </div>
            <div className="grid gap-3 text-xs">
              <label className="grid gap-1 font-bold">
                Code
                <input
                  className="border border-[#cfd2d8] px-3 py-2 font-normal uppercase outline-none focus:border-[#4533ff]"
                  maxLength={16}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, code: event.target.value.replace(/[^a-z0-9]/gi, "") }))
                  }
                  placeholder="FALL18"
                  required
                  value={form.code}
                />
                <span className="font-normal text-[#5d6673]">
                  3–16 letters or numbers. The barcode reads PROMO-{form.code.toUpperCase() || "CODE"}.
                </span>
              </label>
              <label className="grid gap-1 font-bold">
                Name
                <input
                  className="border border-[#cfd2d8] px-3 py-2 font-normal outline-none focus:border-[#4533ff]"
                  onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
                  placeholder="Fall weekday 18"
                  required
                  value={form.name}
                />
              </label>
              <div className="grid grid-cols-[1fr_96px] gap-2">
                <label className="grid gap-1 font-bold">
                  Discount
                  <select
                    className="border border-[#cfd2d8] bg-white px-3 py-2 font-normal outline-none focus:border-[#4533ff]"
                    onChange={(event) => setForm((current) => ({ ...current, kind: event.target.value as DiscountKind }))}
                    value={form.kind}
                  >
                    <option value="per_player">$ off per player</option>
                    <option value="per_bill">$ off the bill</option>
                    <option value="percent">% off green fees</option>
                  </select>
                </label>
                <label className="grid gap-1 font-bold">
                  {form.kind === "percent" ? "Percent" : "Dollars"}
                  <input
                    className="border border-[#cfd2d8] px-3 py-2 font-normal outline-none focus:border-[#4533ff]"
                    inputMode="decimal"
                    onChange={(event) => setForm((current) => ({ ...current, value: event.target.value }))}
                    placeholder={form.kind === "percent" ? "15" : "10"}
                    required
                    value={form.value}
                  />
                </label>
              </div>
              <label className="grid gap-1 font-bold">
                Conditions (staff check these)
                <select
                  className="border border-[#cfd2d8] bg-white px-3 py-2 font-normal outline-none focus:border-[#4533ff]"
                  onChange={(event) => setForm((current) => ({ ...current, conditions: event.target.value }))}
                  value={form.conditions}
                >
                  {CONDITIONS.map((condition) => (
                    <option key={condition}>{condition}</option>
                  ))}
                </select>
              </label>
              <div className="grid grid-cols-2 gap-2">
                <label className="grid gap-1 font-bold">
                  Expires
                  <input
                    className="border border-[#cfd2d8] px-3 py-2 font-normal outline-none focus:border-[#4533ff]"
                    onChange={(event) => setForm((current) => ({ ...current, expires: event.target.value }))}
                    type="date"
                    value={form.expires}
                  />
                </label>
                <label className="grid gap-1 font-bold">
                  Usage Limit
                  <input
                    className="border border-[#cfd2d8] px-3 py-2 font-normal outline-none focus:border-[#4533ff]"
                    min="1"
                    onChange={(event) => setForm((current) => ({ ...current, limit: event.target.value }))}
                    type="number"
                    value={form.limit}
                  />
                </label>
              </div>
              <button
                className="mt-2 bg-[#4533ff] px-4 py-2 text-xs font-bold text-white disabled:opacity-60"
                disabled={saving}
                type="submit"
              >
                {saving ? "Saving…" : "Add Promotion"}
              </button>
              {error ? (
                <p className="border border-[#f0b4b4] bg-[#fdf1f1] p-2 font-normal text-[#8c1d1d]" role="alert">
                  {error}
                </p>
              ) : null}
            </div>
          </form>

          <div className="min-w-0 overflow-x-auto border border-[#d4d4d8] bg-white">
            <div className="min-w-[760px]">
              <div className="grid grid-cols-[.9fr_1.1fr_.8fr_1.1fr_.6fr_.9fr] border-b border-[#d4d4d8] bg-[#f7f7f8] px-3 py-2 text-[11px] font-bold uppercase text-[#5d6673]">
                <span>Code</span>
                <span>Promotion</span>
                <span>Discount</span>
                <span>Conditions</span>
                <span>Expires</span>
                <span className="text-right">Usage</span>
              </div>
              {loading ? <p className="p-4 text-xs text-[#5d6673]">Loading…</p> : null}
              {!loading && promotions.length === 0 && !error ? (
                <p className="p-4 text-xs text-[#5d6673]">No promotions yet. Create one on the left.</p>
              ) : null}
              <div className="divide-y divide-[#e2e4e8]">
                {promotions.map((promotion) => {
                  const percent = promotion.usage_limit
                    ? Math.min(100, Math.round((promotion.used / promotion.usage_limit) * 100))
                    : 0;
                  const open = shown === promotion.id;
                  return (
                    <div className="px-3 py-3 text-xs" key={promotion.id}>
                      <div className="grid grid-cols-[.9fr_1.1fr_.8fr_1.1fr_.6fr_.9fr] items-center gap-2">
                        <span>
                          <strong className="block text-sm">{promotion.code}</strong>
                          <span className={`mt-1 inline-block px-2 py-1 text-[11px] font-bold ${stateClass(promotion.state)}`}>
                            {PROMO_STATE_LABEL[promotion.state]}
                          </span>
                        </span>
                        <span className="font-semibold">{promotion.name}</span>
                        <span>{promoDiscountLabel(promotion)}</span>
                        <span className="text-[#5d6673]">{promotion.conditions}</span>
                        <span>{promotion.expires_on ?? "—"}</span>
                        <span className="text-right">
                          <strong>
                            {promotion.used}
                            {promotion.usage_limit ? `/${promotion.usage_limit}` : ""}
                          </strong>
                          {promotion.held > 0 ? (
                            <span className="block text-[11px] text-[#5d6673]">+{promotion.held} on open bills</span>
                          ) : null}
                          {promotion.usage_limit ? (
                            <span className="mt-1 block h-2 bg-[#ececf0]">
                              <span className="block h-2 bg-[#4533ff]" style={{ width: `${percent}%` }} />
                            </span>
                          ) : null}
                        </span>
                      </div>
                      <div className="mt-2 flex flex-wrap justify-end gap-1">
                        <button
                          aria-expanded={open}
                          className="border border-[#cfd2d8] bg-white px-2 py-1 text-[11px] font-bold"
                          onClick={() => setShown(open ? null : promotion.id)}
                          type="button"
                        >
                          {open ? "Hide barcode" : "Barcode"}
                        </button>
                        <button
                          className="border border-[#cfd2d8] bg-white px-2 py-1 text-[11px] font-bold"
                          onClick={() => void setActive(promotion, !promotion.active)}
                          type="button"
                        >
                          {promotion.active ? "Pause" : "Resume"}
                        </button>
                        <a
                          className="inline-block bg-[#4533ff] px-2 py-1 text-[11px] font-bold text-white"
                          href={textCampaignHref(promotion)}
                          rel="noopener"
                          target="_blank"
                          title="Open customer marketing with this code and its barcode in a new text campaign"
                        >
                          Text it
                        </a>
                      </div>
                      {open ? (
                        <div className="mt-2 flex flex-wrap items-center justify-end gap-3 bg-[#f7f7f8] p-3">
                          <div className="text-center">
                            {/* code128Svg 는 막대(rect)만 그린 SVG 다. 사람이 입력한 글자는 들어가지 않는다. */}
                            <span
                              className="block h-16 w-64 bg-white [&>svg]:h-full [&>svg]:w-full"
                              dangerouslySetInnerHTML={{ __html: code128Svg(promotion.barcode) }}
                            />
                            <span className="mt-1 block font-mono text-[11px]">{promotion.barcode}</span>
                          </div>
                          <button
                            className="border border-[#cfd2d8] bg-white px-3 py-1.5 text-[11px] font-bold"
                            onClick={() => printBarcode(promotion)}
                            type="button"
                          >
                            Print
                          </button>
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </section>
      </div>
    </AdminShell>
  );
}
