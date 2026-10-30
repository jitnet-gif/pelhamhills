"use client";

/**
 * 기프트카드(0120). 매니저가 여기서 발행하면 서버가 코드(`GIFT-` + 무작위 10자)를 매기고, 이 화면이 카드를
 * 감열 프린터로 찍고, 손님 휴대폰으로 문자(바코드 그림 MMS)를, 이메일로 종이 상품권(Gift Certificate) 양식을 보낸다.
 * 손님은 티 시트·계산대·스낵바 어느 계산서에서든 결제 수단 "Gift card" 로 잔액만큼 쓴다(`BillPanel`).
 *
 * 매니저와 계정 관리자만(proshop@ 제외). 메뉴를 가리는 것은 AdminShell, 막는 것은 서버다.
 */

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

import AdminShell from "@/components/admin/AdminShell";
import { describeGiftCardError, expiryText, giftCardApi, type GiftCard } from "@/lib/pos/giftCard";
import { printGiftCertificate } from "@/lib/pos/giftCertificate";
import { code128ScreenWidth, code128Svg } from "@/lib/retail/barcode";
import { printGiftCard } from "@/lib/retail/printReceipt";
import { formatMoney, parseMoney } from "@/lib/retail/types";

const AMOUNTS = [2500, 5000, 10000, 15000, 20000];

const EMPTY_FORM = {
  amount: "",
  kind: "sold" as GiftCard["kind"],
  recipient: "",
  phone: "",
  email: "",
  note: "",
  expires: "2027-12-31",
};

const INPUT = "border border-[#cfd2d8] px-3 py-2 font-normal outline-none focus:border-[#4533ff]";

function statusOf(card: GiftCard): { label: string; className: string } {
  if (card.status === "void") return { label: "Void", className: "bg-[#ececf0] text-[#4e5560]" };
  if (card.balance <= 0) return { label: "Used up", className: "bg-[#ececf0] text-[#4e5560]" };
  if (card.expired) return { label: "Expired", className: "bg-[#fdf1f1] text-[#8c1d1d]" };
  return { label: "Active", className: "bg-[#dff7e8] text-[#087333]" };
}

export default function GiftCardsPage() {
  const [cards, setCards] = useState<GiftCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [shown, setShown] = useState<number | null>(null);
  const [issued, setIssued] = useState<GiftCard | null>(null);
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState<number | null>(null);

  const [nonce, setNonce] = useState(0);
  const load = useCallback(() => setNonce((value) => value + 1), []);

  useEffect(() => {
    let cancelled = false;
    giftCardApi
      .list()
      .then(
        (list) => {
          if (cancelled) return;
          setCards(list);
          setError("");
        },
        (cause) => {
          if (!cancelled) setError(describeGiftCardError(cause));
        },
      )
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [nonce]);

  const outstanding = useMemo(
    () => cards.filter((card) => card.status === "active").reduce((sum, card) => sum + card.balance, 0),
    [cards],
  );
  const activeCount = cards.filter((card) => card.status === "active" && card.balance > 0).length;

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return cards;
    return cards.filter((card) =>
      [card.code, card.recipient, card.phone, card.email, card.note]
        .some((value) => (value ?? "").toLowerCase().includes(needle)),
    );
  }, [cards, search]);

  /** 성공하면 안내 한 줄, 실패하면 오류 한 줄을 돌려준다 — 발행 때 문자·메일 둘의 결과를 함께 띄우려고. */
  async function sendText(card: GiftCard, phone: string): Promise<{ ok: string } | { failed: string }> {
    try {
      const sent = await giftCardApi.text(card.code, phone);
      return { ok: `Texted the barcode to ${sent.to}.` };
    } catch (cause) {
      return { failed: `The text did not go out: ${describeGiftCardError(cause)}` };
    }
  }

  async function sendEmail(card: GiftCard, email: string): Promise<{ ok: string } | { failed: string }> {
    try {
      const sent = await giftCardApi.email(card.code, email);
      return { ok: `Emailed the certificate to ${sent.to}.` };
    } catch (cause) {
      return { failed: `The email did not go out: ${describeGiftCardError(cause)}` };
    }
  }

  function show(results: ({ ok: string } | { failed: string })[], lead = "") {
    const ok = results.flatMap((result) => ("ok" in result ? [result.ok] : []));
    const failed = results.flatMap((result) => ("failed" in result ? [result.failed] : []));
    setNotice([lead, ...ok].filter(Boolean).join(" "));
    setError(failed.join(" "));
  }

  async function issue(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setNotice("");
    const amount = form.amount.trim() ? parseMoney(form.amount) : 0;
    if (!Number.isFinite(amount) || amount <= 0) {
      setError("Enter the card value in dollars.");
      return;
    }
    setSaving(true);
    try {
      const card = await giftCardApi.issue({
        amount,
        kind: form.kind,
        recipient: form.recipient.trim(),
        phone: form.phone.trim(),
        email: form.email.trim(),
        note: form.note.trim(),
        expires_on: form.expires,
      });
      setForm(EMPTY_FORM);
      setShown(card.id);
      setIssued(card);
      setNotice(`Issued ${card.code} for ${formatMoney(card.amount)}.`);
      printGiftCard(card);
      // 문자에는 바코드, 메일에는 상품권. 카드는 이미 저장됐으니 하나가 실패해도 다시 보내면 된다.
      const sends = await Promise.all([
        card.phone ? sendText(card, card.phone) : null,
        card.email ? sendEmail(card, card.email) : null,
      ]);
      const results = sends.filter((result) => result !== null);
      if (results.length) show(results, `Issued ${card.code} for ${formatMoney(card.amount)}.`);
      load();
    } catch (cause) {
      setError(describeGiftCardError(cause));
    } finally {
      setSaving(false);
    }
  }

  async function textAgain(card: GiftCard) {
    const phone = window.prompt(`Text the ${card.code} barcode to which phone number?`, card.phone ?? "");
    if (!phone?.trim()) return;
    setError("");
    setNotice("");
    setBusy(card.id);
    show([await sendText(card, phone.trim())]);
    setBusy(null);
  }

  async function emailAgain(card: GiftCard) {
    const email = window.prompt(`Email the ${card.code} gift certificate to which address?`, card.email ?? "");
    if (!email?.trim()) return;
    setError("");
    setNotice("");
    setBusy(card.id);
    show([await sendEmail(card, email.trim())]);
    setBusy(null);
  }

  function sendButtons(card: GiftCard) {
    const disabled = busy === card.id || card.status !== "active" || card.balance <= 0 || card.expired;
    return (
      <>
        <button
          className="border border-[#cfd2d8] bg-white px-2 py-1 text-[11px] font-bold disabled:opacity-50"
          disabled={disabled}
          onClick={() => void textAgain(card)}
          title="Text the barcode to the guest's phone"
          type="button"
        >
          Send message
        </button>
        <button
          className="border border-[#cfd2d8] bg-white px-2 py-1 text-[11px] font-bold disabled:opacity-50"
          disabled={disabled}
          onClick={() => void emailAgain(card)}
          title="Email the gift certificate"
          type="button"
        >
          Send email
        </button>
      </>
    );
  }

  /** 클럽 종이 상품권 양식(Letter 가로)으로. */
  function printCertificate(card: GiftCard, reprint: boolean) {
    if (!printGiftCertificate(card, { reprint })) {
      setError("The browser blocked the print window. Allow pop-ups for this site and try again.");
    }
  }

  async function saveExpiry(card: GiftCard, expires: string) {
    setError("");
    setNotice("");
    setBusy(card.id);
    try {
      const saved = await giftCardApi.setExpiry(card.code, expires || null);
      setNotice(`${card.code}: ${expiryText(saved)}.`);
      load();
    } catch (cause) {
      setError(describeGiftCardError(cause));
    } finally {
      setBusy(null);
    }
  }

  async function voidCard(card: GiftCard) {
    const reason = window.prompt(
      `Void ${card.code}? The ${formatMoney(card.balance)} left on it can no longer be spent.\n\nReason:`,
    );
    if (!reason?.trim()) return;
    setError("");
    setNotice("");
    setBusy(card.id);
    try {
      await giftCardApi.void(card.code, reason.trim());
      setNotice(`Voided ${card.code}.`);
      load();
    } catch (cause) {
      setError(describeGiftCardError(cause));
    } finally {
      setBusy(null);
    }
  }

  return (
    <AdminShell title="Gift Cards">
      <div className="grid min-w-0 grid-rows-[auto_1fr]">
        <section className="border-b border-[#d4d4d8] bg-white px-4 py-3">
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <span className="rounded bg-[#111315] px-2 py-1 text-white">{cards.length} Cards</span>
            <span>{activeCount} with a balance</span>
            <span className="font-bold">Outstanding {formatMoney(outstanding)}</span>
            <span className="text-[#5d6673]">
              Guests spend a card at any register: choose Gift card as the payment method, or scan the card barcode.
            </span>
          </div>
        </section>

        <section className="grid min-h-0 gap-4 p-4 xl:grid-cols-[520px_1fr]">
          <form className="self-start border border-[#d4d4d8] bg-white p-4" onSubmit={issue}>
            <div className="mb-4">
              <p className="text-[11px] font-bold uppercase text-[#5d6673]">Issue</p>
              <p className="text-xl font-bold">New Gift Card</p>
            </div>
            <div className="grid gap-3 text-xs">
              <label className="grid gap-1 font-bold">
                Value (dollars)
                <input
                  className={INPUT}
                  inputMode="decimal"
                  onChange={(event) => setForm((current) => ({ ...current, amount: event.target.value }))}
                  placeholder="50.00"
                  required
                  value={form.amount}
                />
                {/* 금액 버튼은 더한다: $50 + $50 + $25 = $125. 잘못 누르면 Clear. */}
                <span className="flex flex-wrap gap-1 font-normal">
                  {AMOUNTS.map((cents) => (
                    <button
                      className="border border-[#cfd2d8] bg-white px-2 py-1 text-[11px] font-bold"
                      key={cents}
                      onClick={() =>
                        setForm((current) => ({
                          ...current,
                          amount: ((Math.max(0, parseMoney(current.amount)) + cents) / 100).toFixed(2),
                        }))
                      }
                      type="button"
                    >
                      +{formatMoney(cents)}
                    </button>
                  ))}
                  {form.amount ? (
                    <button
                      className="border border-[#cfd2d8] bg-white px-2 py-1 text-[11px] font-bold text-[#5d6673]"
                      onClick={() => setForm((current) => ({ ...current, amount: "" }))}
                      type="button"
                    >
                      Clear
                    </button>
                  ) : null}
                </span>
              </label>
              <fieldset className="grid gap-1">
                <legend className="mb-1 font-bold">Type</legend>
                <label className="flex items-center gap-2">
                  <input
                    checked={form.kind === "sold"}
                    onChange={() => setForm((current) => ({ ...current, kind: "sold" }))}
                    type="radio"
                  />
                  Sold — the buyer paid for it
                </label>
                <label className="flex items-center gap-2">
                  <input
                    checked={form.kind === "complimentary"}
                    onChange={() => setForm((current) => ({ ...current, kind: "complimentary" }))}
                    type="radio"
                  />
                  Complimentary — prize, apology, donation
                </label>
              </fieldset>
              <label className="grid gap-1 font-bold">
                For (name on the card, optional)
                <input
                  className={INPUT}
                  onChange={(event) => setForm((current) => ({ ...current, recipient: event.target.value }))}
                  placeholder="Jane Smith"
                  value={form.recipient}
                />
              </label>
              <div className="grid grid-cols-2 gap-2">
                <label className="grid gap-1 font-bold">
                  Text barcode to (optional)
                  <input
                    className={INPUT}
                    inputMode="tel"
                    onChange={(event) => setForm((current) => ({ ...current, phone: event.target.value }))}
                    placeholder="905-555-0101"
                    value={form.phone}
                  />
                </label>
                <label className="grid gap-1 font-bold">
                  Email certificate to (optional)
                  <input
                    className={INPUT}
                    inputMode="email"
                    onChange={(event) => setForm((current) => ({ ...current, email: event.target.value }))}
                    value={form.email}
                  />
                </label>
              </div>
              <label className="grid gap-1 font-bold">
                Expires on
                <input
                  className={INPUT}
                  onChange={(event) => setForm((current) => ({ ...current, expires: event.target.value }))}
                  type="date"
                  value={form.expires}
                />
                <span className="font-normal text-[#5d6673]">Clear the date for No expiry.</span>
              </label>
              <label className="grid gap-1 font-bold">
                Reason
                <input
                  className={INPUT}
                  onChange={(event) => setForm((current) => ({ ...current, note: event.target.value }))}
                  placeholder={form.kind === "sold" ? "Paid $50 cash, receipt PH-20261026-0012" : "Charity golf day prize"}
                  required
                  value={form.note}
                />
                <span className="font-normal text-[#5d6673]">
                  {form.kind === "sold"
                    ? "Who paid, how, and on which receipt. Also use this to move an old paper card in — enter what is left on it."
                    : "What the card is for."}
                </span>
              </label>
              <button
                className="mt-2 bg-[#4533ff] px-4 py-2 text-xs font-bold text-white disabled:opacity-60"
                disabled={saving}
                type="submit"
              >
                {saving
                  ? "Issuing…"
                  : `Issue & print${form.phone.trim() ? " · text" : ""}${form.email.trim() ? " · email" : ""}`}
              </button>
              {notice ? (
                <p className="border border-[#9fd9b4] bg-[#eefaf2] p-2 font-normal text-[#087333]" role="status">
                  {notice}
                </p>
              ) : null}
              {/* 방금 만든 카드의 바코드는 여기에. 목록은 좁은 화면에서 폼 아래로 내려가 안 보인다. */}
              {issued ? (
                <div className="grid justify-items-center gap-1 border border-[#d4d4d8] bg-[#f7f7f8] p-3 font-normal">
                  <span className="text-[11px] font-bold uppercase text-[#5d6673]">Just issued · {formatMoney(issued.amount)}</span>
                  {/* code128Svg 는 막대(rect)만 그린 SVG 다. 사람이 입력한 글자는 들어가지 않는다. */}
                  <span
                    className="block h-20 shrink-0 bg-white [&>svg]:h-full [&>svg]:w-full"
                    dangerouslySetInnerHTML={{ __html: code128Svg(issued.code) }}
                    style={{ width: code128ScreenWidth(issued.code) }}
                  />
                  <span className="font-mono text-[11px]">{issued.code}</span>
                  <span className="flex flex-wrap justify-center gap-1">
                    <button
                      className="border border-[#cfd2d8] bg-white px-2 py-1 text-[11px] font-bold"
                      onClick={() => printGiftCard(issued, { reprint: true })}
                      type="button"
                    >
                      Reprint
                    </button>
                    <button
                      className="border border-[#cfd2d8] bg-white px-2 py-1 text-[11px] font-bold"
                      onClick={() => printCertificate(issued, false)}
                      type="button"
                    >
                      Print certificate
                    </button>
                    {sendButtons(issued)}
                  </span>
                </div>
              ) : null}
              {error ? (
                <p className="border border-[#f0b4b4] bg-[#fdf1f1] p-2 font-normal text-[#8c1d1d]" role="alert">
                  {error}
                </p>
              ) : null}
            </div>
          </form>

          <div className="min-w-0 border border-[#d4d4d8] bg-white">
            <div className="border-b border-[#d4d4d8] p-2">
              <input
                className={`${INPUT} w-full text-xs`}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search by card number, name, phone or reason"
                value={search}
              />
            </div>
            <div className="overflow-x-auto">
              <div className="min-w-[720px]">
                <div className="grid grid-cols-[1.1fr_1.2fr_.7fr_.7fr_.8fr] border-b border-[#d4d4d8] bg-[#f7f7f8] px-3 py-2 text-[11px] font-bold uppercase text-[#5d6673]">
                  <span>Card</span>
                  <span>For · reason</span>
                  <span className="text-right">Value</span>
                  <span className="text-right">Balance</span>
                  <span className="text-right">Issued</span>
                </div>
                {loading ? <p className="p-4 text-xs text-[#5d6673]">Loading…</p> : null}
                {!loading && cards.length === 0 && !error ? (
                  <p className="p-4 text-xs text-[#5d6673]">No gift cards yet. Issue one on the left.</p>
                ) : null}
                <div className="divide-y divide-[#e2e4e8]">
                  {filtered.map((card) => {
                    const status = statusOf(card);
                    const open = shown === card.id;
                    return (
                      <div className="px-3 py-3 text-xs" key={card.id}>
                        <div className="grid grid-cols-[1.1fr_1.2fr_.7fr_.7fr_.8fr] items-start gap-2">
                          <span>
                            <strong className="block font-mono text-sm">{card.code}</strong>
                            <span className={`mt-1 inline-block px-2 py-1 text-[11px] font-bold ${status.className}`}>
                              {status.label}
                            </span>
                            <span className="ml-1 text-[11px] text-[#5d6673]">
                              {card.kind === "sold" ? "Sold" : "Complimentary"}
                            </span>
                          </span>
                          <span>
                            <span className="block font-semibold">{card.recipient ?? "—"}</span>
                            <span className="block text-[#5d6673]">{card.note}</span>
                            {card.status === "void" && card.void_reason ? (
                              <span className="block text-[#8c1d1d]">Voided: {card.void_reason}</span>
                            ) : null}
                          </span>
                          <span className="text-right tabular-nums">{formatMoney(card.amount)}</span>
                          <span className="text-right font-bold tabular-nums">
                            {card.status === "void" ? "—" : formatMoney(card.balance)}
                          </span>
                          <span className="text-right text-[#5d6673]">
                            {card.issued_on}
                            {card.issued_email ? <span className="block">{card.issued_email}</span> : null}
                            <span className="block">Expires: {expiryText(card)}</span>
                          </span>
                        </div>
                        <div className="mt-2 flex flex-wrap justify-end gap-1">
                          <button
                            aria-expanded={open}
                            className="border border-[#cfd2d8] bg-white px-2 py-1 text-[11px] font-bold"
                            onClick={() => setShown(open ? null : card.id)}
                            type="button"
                          >
                            {open ? "Hide" : "Barcode & history"}
                          </button>
                          {card.status === "active" ? (
                            <>
                              <button
                                className="border border-[#cfd2d8] bg-white px-2 py-1 text-[11px] font-bold"
                                onClick={() => printGiftCard(card, { reprint: true })}
                                type="button"
                              >
                                Reprint
                              </button>
                              <button
                                className="border border-[#cfd2d8] bg-white px-2 py-1 text-[11px] font-bold"
                                onClick={() => printCertificate(card, true)}
                                type="button"
                              >
                                Certificate
                              </button>
                              {sendButtons(card)}
                              <button
                                className="border border-[#f0b4b4] bg-white px-2 py-1 text-[11px] font-bold text-[#8c1d1d] disabled:opacity-50"
                                disabled={busy === card.id}
                                onClick={() => void voidCard(card)}
                                type="button"
                              >
                                Void
                              </button>
                            </>
                          ) : null}
                        </div>
                        {open ? (
                          <div className="mt-2 grid gap-3 bg-[#f7f7f8] p-3 md:grid-cols-[auto_1fr]">
                            <div className="text-center">
                              {/* code128Svg 는 막대(rect)만 그린 SVG 다. 사람이 입력한 글자는 들어가지 않는다. */}
                              <span
                                className="block h-20 bg-white [&>svg]:h-full [&>svg]:w-full"
                                dangerouslySetInnerHTML={{ __html: code128Svg(card.code) }}
                                style={{ width: code128ScreenWidth(card.code) }}
                              />
                              <span className="mt-1 block font-mono text-[11px]">{card.code}</span>
                            </div>
                            <div>
                              <p className="mb-1 font-bold">Used on</p>
                              {card.uses.length === 0 ? (
                                <p className="text-[#5d6673]">Not used yet.</p>
                              ) : (
                                <ul className="grid gap-0.5">
                                  {card.uses.map((use, index) => (
                                    <li className="flex justify-between gap-2" key={`${use.receipt_no}-${index}`}>
                                      <span>
                                        {use.receipt_no ?? "—"}
                                        {use.status === "refunded" ? " (refunded — back on the card)" : ""}
                                      </span>
                                      <span className={`tabular-nums ${use.status === "refunded" ? "line-through" : ""}`}>
                                        {formatMoney(use.amount)}
                                      </span>
                                    </li>
                                  ))}
                                </ul>
                              )}
                              {card.phone || card.email ? (
                                <p className="mt-2 text-[#5d6673]">{[card.phone, card.email].filter(Boolean).join(" · ")}</p>
                              ) : null}
                              {card.status === "active" ? (
                                <form
                                  className="mt-2 flex flex-wrap items-center gap-1"
                                  key={card.expires_on ?? ""}
                                  onSubmit={(event) => {
                                    event.preventDefault();
                                    void saveExpiry(card, String(new FormData(event.currentTarget).get("expires") ?? ""));
                                  }}
                                >
                                  <label className="flex items-center gap-1 font-bold">
                                    Expires on
                                    <input
                                      className={`${INPUT} py-1`}
                                      defaultValue={card.expires_on ?? ""}
                                      name="expires"
                                      type="date"
                                    />
                                  </label>
                                  <button
                                    className="border border-[#cfd2d8] bg-white px-2 py-1 text-[11px] font-bold disabled:opacity-50"
                                    disabled={busy === card.id}
                                    type="submit"
                                  >
                                    Save
                                  </button>
                                </form>
                              ) : null}
                            </div>
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        </section>
      </div>
    </AdminShell>
  );
}
