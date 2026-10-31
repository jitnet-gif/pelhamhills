"use client";

/**
 * 기프트카드 구매 폼(`/gift-cards`). 제출하면 Stripe Checkout 으로 넘어가고, 돌아오는 곳은 `/gift-cards/paid`.
 * 카드 번호는 Stripe 페이지에서만 입력된다.
 */

import { useState, type FormEvent, type ReactNode } from "react";

import { GIFT_MAX_DOLLARS, GIFT_MIN_DOLLARS, GIFT_PRESETS, startGiftCheckout } from "@/lib/giftShop";

const INPUT =
  "min-h-11 w-full rounded-sm border border-[#d8d1c3] bg-white px-3 text-base text-[#182118] outline-none focus:border-[#214d2f] focus:ring-2 focus:ring-[#214d2f]";

export default function GiftCardForm() {
  const [dollars, setDollars] = useState(100);
  const [custom, setCustom] = useState("");
  const [isCustom, setIsCustom] = useState(false);
  const [buyer, setBuyer] = useState({ name: "", email: "", phone: "" });
  const [gift, setGift] = useState(false);
  const [to, setTo] = useState({ name: "", email: "", phone: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const amount = isCustom ? Number(custom) : dollars;
  const valid = Number.isInteger(amount) && amount >= GIFT_MIN_DOLLARS && amount <= GIFT_MAX_DOLLARS;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!valid) {
      setError(`Gift cards are $${GIFT_MIN_DOLLARS} to $${GIFT_MAX_DOLLARS.toLocaleString("en-CA")}, in whole dollars.`);
      return;
    }
    setBusy(true);
    setError("");
    try {
      await startGiftCheckout({
        amount: amount * 100,
        buyer_name: buyer.name,
        buyer_email: buyer.email,
        buyer_phone: buyer.phone,
        recipient: gift ? to.name : "",
        recipient_email: gift ? to.email : "",
        recipient_phone: gift ? to.phone : "",
      });
    } catch (err) {
      setBusy(false);
      setError((err as Error)?.message || "We couldn't open the card payment page.");
    }
  };

  return (
    <form className="grid gap-8" onSubmit={(event) => void submit(event)}>
      <Group title="1. Amount">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          {GIFT_PRESETS.map((value) => (
            <Choice
              active={!isCustom && dollars === value}
              key={value}
              onClick={() => {
                setDollars(value);
                setIsCustom(false);
              }}
            >
              ${value}
            </Choice>
          ))}
          <Choice active={isCustom} onClick={() => setIsCustom(true)}>
            Other
          </Choice>
        </div>
        {isCustom ? (
          <Field text={`Amount in dollars ($${GIFT_MIN_DOLLARS} to $${GIFT_MAX_DOLLARS.toLocaleString("en-CA")})`}>
            <input
              className={INPUT}
              inputMode="numeric"
              max={GIFT_MAX_DOLLARS}
              min={GIFT_MIN_DOLLARS}
              onChange={(e) => setCustom(e.target.value)}
              required
              step={1}
              type="number"
              value={custom}
            />
          </Field>
        ) : null}
      </Group>

      <Group title="2. Your details">
        <Field text="Your name">
          <input
            autoComplete="name"
            className={INPUT}
            maxLength={120}
            onChange={(e) => setBuyer({ ...buyer, name: e.target.value })}
            required
            value={buyer.name}
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field text="Email (gift certificate and receipt)">
            <input
              autoComplete="email"
              className={INPUT}
              maxLength={254}
              onChange={(e) => setBuyer({ ...buyer, email: e.target.value })}
              required
              type="email"
              value={buyer.email}
            />
          </Field>
          <Field text="Mobile (barcode by text)">
            <input
              autoComplete="tel"
              className={INPUT}
              inputMode="tel"
              maxLength={40}
              onChange={(e) => setBuyer({ ...buyer, phone: e.target.value })}
              required
              type="tel"
              value={buyer.phone}
            />
          </Field>
        </div>
      </Group>

      <Group title="3. Is it a gift?">
        <label className="flex cursor-pointer items-center gap-3 font-semibold">
          <input
            checked={gift}
            className="size-5 accent-[#214d2f]"
            onChange={(e) => setGift(e.target.checked)}
            type="checkbox"
          />
          Send it to someone else too
        </label>
        {gift ? (
          <>
            <Field text="Their name">
              <input
                className={INPUT}
                maxLength={120}
                onChange={(e) => setTo({ ...to, name: e.target.value })}
                required
                value={to.name}
              />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field text="Their email (optional)">
                <input
                  className={INPUT}
                  maxLength={254}
                  onChange={(e) => setTo({ ...to, email: e.target.value })}
                  type="email"
                  value={to.email}
                />
              </Field>
              <Field text="Their mobile (optional)">
                <input
                  className={INPUT}
                  inputMode="tel"
                  maxLength={40}
                  onChange={(e) => setTo({ ...to, phone: e.target.value })}
                  type="tel"
                  value={to.phone}
                />
              </Field>
            </div>
            <p className="text-sm leading-6 text-[#516050]">
              They get it right after you pay, with your name on it. You get a copy too.
            </p>
          </>
        ) : null}
      </Group>

      <div className="grid gap-3">
        {error ? (
          <p className="rounded-sm border border-[#e2a5a5] bg-[#fdf0f0] px-3 py-2 text-sm font-bold text-[#8a1f1f]" role="alert">
            {error}
          </p>
        ) : null}
        <button
          className="min-h-12 rounded-sm bg-[#214d2f] px-6 text-sm font-extrabold tracking-[0.12em] text-white uppercase transition hover:bg-[#163820] disabled:opacity-60"
          disabled={busy}
          type="submit"
        >
          {busy ? "Opening…" : valid ? `Pay $${amount.toLocaleString("en-CA")} by Card` : "Pay by Card"}
        </button>
        <p className="text-sm leading-6 text-[#516050]">Secure card payment by Stripe. No HST until the card is spent.</p>
      </div>
    </form>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="grid gap-4">
      <legend className="mb-3 font-serif text-2xl font-semibold">{title}</legend>
      {children}
    </fieldset>
  );
}

function Field({ text, children }: { text: string; children: ReactNode }) {
  return (
    <label className="grid gap-1 text-sm font-bold">
      {text}
      {children}
    </label>
  );
}

function Choice({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      aria-pressed={active}
      className={`min-h-12 rounded-sm border bg-white font-serif text-lg font-semibold ${
        active ? "border-[#214d2f] ring-2 ring-[#214d2f]" : "border-[#d8d1c3]"
      }`}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
}
