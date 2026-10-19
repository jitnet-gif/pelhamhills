"use client";

/**
 * 온라인 회원권 신청서. 종이 신청서(요금표 PDF 2쪽)의 칸 그대로 — 회원권 종류, 이름(들), 주소,
 * 우편번호, 결제 방법, 휴대폰, 이메일 — 에 카트 패키지·연습장 이용권을 더했다.
 *
 * 내면 0041 `pelham_membership_apply` 가 `/admin/memberships` 명부에 Pending 으로 넣는다. 결제는
 * 여기서 받지 않는다: 수표·현금·e-Transfer 가 섞여 있고, 카드도 클럽이 3% 를 더해 직접 받는다.
 * 합계는 요금표로 계산한 견적이며 직원이 결제 전에 다시 본다.
 */

import { useState, type FormEvent, type ReactNode } from "react";

import { ApiError } from "@/lib/teeSheet/api";
import {
  CART_PACKAGES,
  CREDIT_CARD_SURCHARGE,
  EARLY_BIRD_DEADLINE,
  MEMBERSHIP_SEASON,
  MEMBERSHIP_TYPES,
  PAYMENT_METHODS,
  RANGE_PASS_PRICE,
  applyForMembership,
  listPrice,
  money,
  typeInfo,
  type ApplicationReceipt,
  type CartPackage,
  type MembershipApplication,
  type MembershipType,
} from "@/lib/memberships";

const INPUT =
  "min-h-12 w-full rounded-sm border border-[#d8d1c3] bg-white px-3 text-base text-[#182118] focus:border-[#214d2f] focus:outline-none";

/** 결제 방법마다 신청 뒤에 할 일. 신청서 2쪽 문구 그대로. */
const PAY_NEXT: Record<string, string> = {
  Cheque: "Make your cheque payable to “Pelham Hills Golf” only and drop it off at the pro shop.",
  "Credit card": "The pro shop will call to take your card payment (a 3% card charge applies).",
  "E-transfer": "Send an Interac e-Transfer to pelhamhillsgolf@gmail.com.",
  Cash: "Pay in cash at the pro shop.",
};

export default function MembershipApplicationForm() {
  const [form, setForm] = useState<MembershipApplication>({
    season: MEMBERSHIP_SEASON,
    membership_type: "full",
    plan: "single",
    cart_package: null,
    range_pass: false,
    payment_method: "E-transfer",
    agreed: false,
  });
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<ApplicationReceipt | null>(null);

  const type = typeInfo(form.membership_type ?? "full");
  const total = listPrice({
    membership_type: form.membership_type ?? "full",
    plan: form.plan ?? "single",
    cart_package: form.cart_package ?? null,
    range_pass: !!form.range_pass,
    payment_method: form.payment_method,
  });

  const set = <K extends keyof MembershipApplication>(key: K, value: MembershipApplication[K]) =>
    setForm((current) => {
      const next = { ...current, [key]: value };
      if (key === "membership_type") {
        const t = typeInfo(value as MembershipType);
        if (!t.spousal) next.plan = "single";
        if (t.rangeIncluded) next.range_pass = false;
      }
      return next;
    });
  const text = (key: keyof MembershipApplication) => (event: { target: { value: string } }) =>
    set(key, event.target.value as never);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!form.agreed) {
      setError("Please confirm you have read the membership policies.");
      return;
    }
    setSending(true);
    setError(null);
    try {
      setReceipt(await applyForMembership({ ...form, amount_due: total }));
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 0
          ? "We couldn't reach the server. Check your connection and try again."
          : err instanceof ApiError && err.status === 404
            ? "Online applications aren't open yet. Please call the pro shop."
            : ((err as Error)?.message ?? "Something went wrong."),
      );
    } finally {
      setSending(false);
    }
  };

  if (receipt) {
    return (
      <div className="rounded-sm border border-[#214d2f] bg-white p-6 sm:p-8">
        <p className="text-sm font-bold tracking-[0.2em] text-[#8a6f30] uppercase">Application received</p>
        <h2 className="mt-3 font-serif text-3xl font-semibold">Thank you, {receipt.member_name}.</h2>
        <dl className="mt-6 grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-2">
          <dt className="text-[#516050]">Reference</dt>
          <dd className="font-bold tabular-nums">{receipt.reference}</dd>
          <dt className="text-[#516050]">Membership</dt>
          <dd className="font-bold">
            {receipt.season} {type.label} · {form.plan === "spousal" ? "Spousal" : "Single"}
          </dd>
          <dt className="text-[#516050]">Estimated total</dt>
          <dd className="font-bold tabular-nums">{money(receipt.amount_due)} (HST incl.)</dd>
        </dl>
        <p className="mt-6 leading-7 text-[#516050]">
          {PAY_NEXT[form.payment_method ?? ""] ?? "The pro shop will contact you about payment."} Payment in
          full is due by <strong className="text-[#182118]">November 15, 2026</strong>. Your simulator coupons
          are sent once you&rsquo;re paid in full.
        </p>
      </div>
    );
  }

  return (
    <form className="grid gap-8" onSubmit={(event) => void submit(event)}>
      <Group title="1. Membership">
        <div className="grid gap-3 sm:grid-cols-2">
          {MEMBERSHIP_TYPES.map((t) => (
            <label
              className={`flex cursor-pointer gap-3 rounded-sm border bg-white p-4 ${
                form.membership_type === t.key ? "border-[#214d2f] ring-2 ring-[#214d2f]" : "border-[#d8d1c3]"
              }`}
              key={t.key}
            >
              <input
                checked={form.membership_type === t.key}
                className="mt-1 accent-[#214d2f]"
                name="membership_type"
                onChange={() => set("membership_type", t.key)}
                type="radio"
              />
              <span className="min-w-0">
                <span className="block font-serif text-lg font-semibold">{t.label}</span>
                <span className="block text-sm text-[#516050]">{t.access}</span>
                <span className="mt-1 block text-sm font-bold tabular-nums">
                  {money(t.single)}
                  {t.spousal ? ` · Spousal ${money(t.spousal)}` : ""}
                </span>
              </span>
            </label>
          ))}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Label text="Single or spousal">
            <select className={INPUT} onChange={(e) => set("plan", e.target.value as "single" | "spousal")} value={form.plan}>
              <option value="single">Single</option>
              <option disabled={!type.spousal} value="spousal">
                Spousal{type.spousal ? "" : " (not offered)"}
              </option>
            </select>
          </Label>
          {form.plan === "spousal" ? (
            <Label text="Spouse's name">
              <input autoComplete="off" className={INPUT} onChange={text("spouse_name")} required value={form.spouse_name ?? ""} />
            </Label>
          ) : null}
        </div>
      </Group>

      <Group title="2. Add-ons" hint="Power cart packages are for members only.">
        <div className="grid gap-3 sm:grid-cols-2">
          <Label text="Power cart package">
            <select
              className={INPUT}
              onChange={(e) => set("cart_package", (e.target.value || null) as CartPackage | null)}
              value={form.cart_package ?? ""}
            >
              <option value="">No cart package</option>
              {CART_PACKAGES.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.label} (1/2 cart) — {money(c.price)}
                </option>
              ))}
            </select>
          </Label>
          <Label text="Driving range membership">
            {type.rangeIncluded ? (
              <select className={INPUT} disabled value="included">
                <option value="included">Included with Full</option>
              </select>
            ) : (
              <select className={INPUT} onChange={(e) => set("range_pass", e.target.value === "yes")} value={form.range_pass ? "yes" : "no"}>
                <option value="no">No range pass</option>
                <option value="yes">2 large buckets a day — {money(RANGE_PASS_PRICE)}</option>
              </select>
            )}
          </Label>
        </div>
      </Group>

      <Group title="3. Your details">
        <Label text="Name">
          <input autoComplete="name" className={INPUT} onChange={text("member_name")} required value={form.member_name ?? ""} />
        </Label>
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem]">
          <Label text="Address">
            <input autoComplete="street-address" className={INPUT} onChange={text("address")} value={form.address ?? ""} />
          </Label>
          <Label text="Postal code">
            <input autoComplete="postal-code" className={`${INPUT} uppercase`} onChange={text("postal_code")} value={form.postal_code ?? ""} />
          </Label>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Label text="Cellphone">
            <input autoComplete="tel" className={INPUT} inputMode="tel" onChange={text("phone")} required type="tel" value={form.phone ?? ""} />
          </Label>
          <Label text="Email">
            <input autoComplete="email" className={INPUT} onChange={text("email")} required type="email" value={form.email ?? ""} />
          </Label>
        </div>
      </Group>

      <Group title="4. Payment">
        <div className="grid gap-3 sm:grid-cols-4">
          {PAYMENT_METHODS.map((m) => (
            <label
              className={`flex cursor-pointer items-center gap-2 rounded-sm border bg-white p-3 font-bold ${
                form.payment_method === m ? "border-[#214d2f] ring-2 ring-[#214d2f]" : "border-[#d8d1c3]"
              }`}
              key={m}
            >
              <input
                checked={form.payment_method === m}
                className="accent-[#214d2f]"
                name="payment_method"
                onChange={() => set("payment_method", m)}
                type="radio"
              />
              {m === "E-transfer" ? "Interac e-Transfer" : m}
            </label>
          ))}
        </div>
        <p className="text-sm leading-6 text-[#516050]">
          {PAY_NEXT[form.payment_method ?? ""]} We don&rsquo;t take payment on this page.
        </p>
        <Label text="Anything we should know? (optional)">
          <textarea className={`${INPUT} min-h-24 py-2`} onChange={text("notes")} value={form.notes ?? ""} />
        </Label>
      </Group>

      <div className="grid gap-4 rounded-sm border border-[#d8d1c3] bg-white p-5 sm:p-6">
        <div className="flex items-baseline justify-between gap-4">
          <span className="font-serif text-xl font-semibold">Estimated total</span>
          <span className="font-serif text-3xl font-semibold tabular-nums text-[#214d2f]">{money(total)}</span>
        </div>
        <p className="-mt-2 text-sm text-[#516050]">
          {MEMBERSHIP_SEASON} Early Bird rates, HST included
          {form.payment_method === "Credit card" ? `, plus ${CREDIT_CARD_SURCHARGE * 100}% credit card charge` : ""}.
          Due in full by {formatDeadline()}.
        </p>
        <label className="flex cursor-pointer items-start gap-3 text-sm leading-6">
          <input
            checked={form.agreed}
            className="mt-1 size-4 accent-[#214d2f]"
            onChange={(e) => set("agreed", e.target.checked)}
            type="checkbox"
          />
          <span>
            I understand memberships are non-refundable and non-transferable except for medical reasons (with a
            doctor&rsquo;s note), and that golf is limited to 36 holes a day.
          </span>
        </label>
        {error ? (
          <p className="rounded-sm border border-[#e2a5a5] bg-[#fdf0f0] px-3 py-2 text-sm font-bold text-[#8a1f1f]" role="alert">
            {error}
          </p>
        ) : null}
        <button
          className="min-h-12 rounded-sm bg-[#214d2f] px-6 text-sm font-extrabold tracking-[0.12em] text-white uppercase transition hover:bg-[#163820] disabled:opacity-60"
          disabled={sending}
          type="submit"
        >
          {sending ? "Sending…" : "Submit Application"}
        </button>
      </div>
    </form>
  );
}

function formatDeadline(): string {
  return new Date(`${EARLY_BIRD_DEADLINE}T12:00:00`).toLocaleDateString("en-CA", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function Group({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <fieldset className="grid gap-4">
      <legend className="font-serif text-2xl font-semibold">{title}</legend>
      {hint ? <p className="-mt-2 text-sm text-[#516050]">{hint}</p> : null}
      {children}
    </fieldset>
  );
}

function Label({ text, children }: { text: string; children: ReactNode }) {
  return (
    <label className="grid min-w-0 gap-1.5">
      <span className="text-sm font-bold text-[#182118]">{text}</span>
      {children}
    </label>
  );
}
