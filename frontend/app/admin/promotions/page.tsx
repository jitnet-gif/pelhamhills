"use client";

import Link from "next/link";
import { FormEvent, useMemo, useState } from "react";

import AdminShell from "@/components/admin/AdminShell";
import { ADMIN_HOME } from "@/lib/nav";

type Promotion = {
  id: string;
  code: string;
  name: string;
  discount: string;
  condition: string;
  expires: string;
  usage: number;
  limit: number;
  status: "active" | "scheduled" | "expired";
};

const initialPromotions: Promotion[] = [
  {
    id: "p-lsonline",
    code: "LSONLINEDEAL",
    name: "Online booking weekday deal",
    discount: "$10 off",
    condition: "Mon-Thu · 18 holes · public rate",
    expires: "2026-10-31",
    usage: 42,
    limit: 120,
    status: "active",
  },
  {
    id: "p-twilight",
    code: "TWILIGHT9",
    name: "Twilight 9-hole rate",
    discount: "15%",
    condition: "After 4:00 PM · 9 holes",
    expires: "2026-09-30",
    usage: 18,
    limit: 80,
    status: "active",
  },
  {
    id: "p-member",
    code: "MEMBERGUEST",
    name: "Member guest pass",
    discount: "$5 off",
    condition: "Member tag required · max 2 guests",
    expires: "2026-12-15",
    usage: 7,
    limit: 60,
    status: "scheduled",
  },
];

// 마케팅 사이트(/marketing)의 새 문자 캠페인을 이 코드로 채워 연다. 마케팅은 따로 로그인하므로 새 탭.
function textCampaignHref(promotion: Promotion) {
  // "·" 같은 글자가 하나라도 있으면 문자가 70자씩 쪼개진다(UCS-2). 쉼표로 바꾼다.
  const condition = promotion.condition.replace(/\s*·\s*/g, ", ");
  const message =
    `${promotion.name}: ${promotion.discount} with code ${promotion.code} (${condition}). ` +
    `Valid until ${promotion.expires}. Book at pelhamhills.ca/book or call 416-822-7609.`;
  const query = new URLSearchParams({ channel: "sms", name: `${promotion.code} · ${promotion.name}`, message });
  return `/marketing?${query.toString()}`;
}

function statusClass(status: Promotion["status"]) {
  if (status === "expired") return "bg-[#ececf0] text-[#4e5560]";
  if (status === "scheduled") return "bg-[#ffd400] text-[#1d232b]";
  return "bg-[#dff7e8] text-[#087333]";
}

export default function PromotionsPage() {
  const [promotions, setPromotions] = useState(initialPromotions);
  const [form, setForm] = useState({
    code: "",
    name: "",
    discount: "",
    condition: "18 holes · public rate",
    expires: "",
    limit: "100",
  });

  const activePromotions = useMemo(
    () => promotions.filter((promotion) => promotion.status === "active").length,
    [promotions],
  );
  const totalUsage = promotions.reduce((sum, promotion) => sum + promotion.usage, 0);

  function createPromotion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const next: Promotion = {
      id: `p-${Date.now()}`,
      code: form.code.trim().toUpperCase() || "NEWCODE",
      name: form.name.trim() || "New promotion",
      discount: form.discount.trim() || "$5 off",
      condition: form.condition.trim() || "Public rate",
      expires: form.expires || "2026-12-31",
      usage: 0,
      limit: Number(form.limit) || 100,
      status: "scheduled",
    };
    setPromotions((current) => [next, ...current]);
    setForm({ code: "", name: "", discount: "", condition: "18 holes · public rate", expires: "", limit: "100" });
  }

  function incrementUsage(id: string) {
    setPromotions((current) =>
      current.map((promotion) =>
        promotion.id === id
          ? { ...promotion, usage: Math.min(promotion.usage + 1, promotion.limit), status: "active" }
          : promotion,
      ),
    );
  }

  return (
    <AdminShell
      actions={
        <Link
          className="tap-target bg-[#4533ff] px-4 py-1.5 text-xs font-bold text-white"
          href={ADMIN_HOME}
        >
          Tee Sheet
        </Link>
      }
      title="Promotions"
    >
      <div className="grid min-w-0 grid-rows-[auto_1fr]">
        <section className="border-b border-[#d4d4d8] bg-white px-4 py-3">
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <span className="rounded bg-[#111315] px-2 py-1 text-white">{promotions.length} Codes</span>
            <span>{activePromotions} Active</span>
            <span>{totalUsage} Uses</span>
            <span>Pelham Hills Golf Club</span>
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
                  onChange={(event) => setForm((current) => ({ ...current, code: event.target.value }))}
                  placeholder="SPRING18"
                  value={form.code}
                />
              </label>
              <label className="grid gap-1 font-bold">
                Name
                <input
                  className="border border-[#cfd2d8] px-3 py-2 font-normal outline-none focus:border-[#4533ff]"
                  onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
                  placeholder="Spring public rate"
                  value={form.name}
                />
              </label>
              <label className="grid gap-1 font-bold">
                Discount
                <input
                  className="border border-[#cfd2d8] px-3 py-2 font-normal outline-none focus:border-[#4533ff]"
                  onChange={(event) => setForm((current) => ({ ...current, discount: event.target.value }))}
                  placeholder="$10 off or 15%"
                  value={form.discount}
                />
              </label>
              <label className="grid gap-1 font-bold">
                Conditions
                <select
                  className="border border-[#cfd2d8] bg-white px-3 py-2 font-normal outline-none focus:border-[#4533ff]"
                  onChange={(event) => setForm((current) => ({ ...current, condition: event.target.value }))}
                  value={form.condition}
                >
                  <option>18 holes · public rate</option>
                  <option>9 holes · twilight only</option>
                  <option>Member guest · max 2 guests</option>
                  <option>Weekday morning · cart required</option>
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
              <button className="mt-2 bg-[#4533ff] px-4 py-2 text-xs font-bold text-white" type="submit">
                Add Promotion
              </button>
            </div>
          </form>

          <div className="min-w-0 overflow-x-auto border border-[#d4d4d8] bg-white">
            <div className="min-w-[720px]">
            <div className="grid grid-cols-[.8fr_1.1fr_.7fr_1.1fr_.7fr_.7fr] border-b border-[#d4d4d8] bg-[#f7f7f8] px-3 py-2 text-[11px] font-bold uppercase text-[#5d6673]">
              <span>Code</span>
              <span>Promotion</span>
              <span>Discount</span>
              <span>Conditions</span>
              <span>Expires</span>
              <span className="text-right">Usage</span>
            </div>
            <div className="divide-y divide-[#e2e4e8]">
              {promotions.map((promotion) => {
                const percent = Math.round((promotion.usage / promotion.limit) * 100);
                return (
                  <div
                    className="grid grid-cols-[.8fr_1.1fr_.7fr_1.1fr_.7fr_.7fr] items-center gap-2 px-3 py-3 text-xs"
                    key={promotion.id}
                  >
                    <span>
                      <strong className="block text-sm">{promotion.code}</strong>
                      <span className={`mt-1 inline-block px-2 py-1 text-[11px] font-bold capitalize ${statusClass(promotion.status)}`}>
                        {promotion.status}
                      </span>
                    </span>
                    <span className="font-semibold">{promotion.name}</span>
                    <span>{promotion.discount}</span>
                    <span className="text-[#5d6673]">{promotion.condition}</span>
                    <span>{promotion.expires}</span>
                    <span className="text-right">
                      <strong>
                        {promotion.usage}/{promotion.limit}
                      </strong>
                      <span className="mt-1 block h-2 bg-[#ececf0]">
                        <span className="block h-2 bg-[#4533ff]" style={{ width: `${percent}%` }} />
                      </span>
                      <button
                        className="mt-2 border border-[#cfd2d8] bg-white px-2 py-1 text-[11px] font-bold"
                        onClick={() => incrementUsage(promotion.id)}
                        type="button"
                      >
                        Apply
                      </button>
                      <a
                        className="mt-2 ml-1 inline-block bg-[#4533ff] px-2 py-1 text-[11px] font-bold text-white"
                        href={textCampaignHref(promotion)}
                        rel="noopener"
                        target="_blank"
                        title="Open customer marketing with this code in a new text campaign"
                      >
                        Text it
                      </a>
                    </span>
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
