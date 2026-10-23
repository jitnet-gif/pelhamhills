"use client";

/**
 * 신분증 체크인(0084). 티 시트에서 면허증 뒷면을 스캔하면 뜬다.
 *
 * 1. 읽은 이름·생년월일로 손님 기록을 찾는다(`pelham_staff_id_find`). 같은 이름이면서 생년월일이 다르게
 *    적힌 손님은 다른 사람이라 고를 수 없다.
 * 2. 고른 손님에 생년월일을 넣거나, 없으면 새 손님으로 만든다(새 손님은 Shift ID 승인 — 손님 추가와 같다).
 * 3. 바로 오늘 예약에서 그 손님을 체크인하고, 개인 QR 을 보여 준다. 다음부터는 그 QR 을 찍으면 체크인된다.
 *
 * 면허 번호·주소는 `parseIdCard` 가 읽지 않으므로 여기까지 오지도 않는다.
 */

import { useEffect, useRef, useState } from "react";

import {
  checkInById,
  checkinMessage,
  customerQrUrl,
  findIdMatches,
  registerFromId,
  textCustomerQr,
  type CheckinResult,
  type CustomerCard,
  type IdMatch,
} from "@/lib/pos/customerQr";
import type { IdCard } from "@/lib/pos/idCard";

import { Button, ErrorNote, Field, Modal, TextInput } from "@/components/retail/ui";

const QR_SIZE = 200;
const NEW = "new";

function errorText(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

export default function IdCheckinDialog({
  card,
  onClose,
  onCheckedIn,
}: {
  card: IdCard;
  onClose: () => void;
  /** 체크인된 예약을 격자에서 연다. */
  onCheckedIn: (result: CheckinResult) => void;
}) {
  const [matches, setMatches] = useState<IdMatch[] | null>(null);
  const [pick, setPick] = useState<string>("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState<CustomerCard | null>(null);
  const [result, setResult] = useState<CheckinResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    findIdMatches(card.firstName, card.lastName, card.dateOfBirth)
      .then((rows) => {
        if (cancelled) return;
        setMatches(rows);
        // 생년월일까지 같은 손님이 하나면 그 사람이다.
        const sure = rows.filter((row) => row.dobMatch);
        const open = rows.filter((row) => !row.dobConflict);
        setPick(sure.length === 1 ? sure[0].customerRef : open.length === 0 ? NEW : "");
      })
      .catch((cause) => {
        if (cancelled) return;
        setMatches([]);
        setPick(NEW);
        setError(errorText(cause, "Couldn't look up customers."));
      });
    return () => {
      cancelled = true;
    };
  }, [card]);

  async function save() {
    if (!pick || busy) return;
    setBusy(true);
    setError("");
    try {
      const customer = await registerFromId(pick === NEW ? null : pick, {
        ...card,
        email: pick === NEW ? email : undefined,
        phone: pick === NEW ? phone : undefined,
      });
      setSaved(customer);
      const checkin = await checkInById(customer.customerRef);
      setResult(checkin);
      if (checkin.status !== "none") onCheckedIn(checkin);
    } catch (cause) {
      setError(errorText(cause, "Couldn't save the customer."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal onClose={onClose} title="ID check-in">
      <div className="grid gap-3 text-sm">
        <div className="flex items-baseline justify-between gap-2 border border-[#d4d4d8] bg-[#f7f7f8] px-3 py-2">
          <b className="text-base">
            {card.firstName} {card.lastName}
          </b>
          <span className="tabular-nums text-[#3f434a]">Born {card.dateOfBirth}</span>
        </div>

        {saved ? (
          <Saved customer={saved} result={result} />
        ) : matches === null ? (
          <p className="text-[#6b7280]">Looking up customers…</p>
        ) : (
          <fieldset className="grid gap-1.5">
            <legend className="mb-1 font-bold text-[#3f434a]">
              {matches.length ? "Is this one of these customers?" : "No customer with this name yet."}
            </legend>
            {matches.map((row) => (
              <label
                className={`flex items-start gap-2 border px-3 py-2 ${
                  pick === row.customerRef ? "border-[#4533ff] bg-[#eef0ff]" : "border-[#d4d4d8]"
                } ${row.dobConflict ? "opacity-50" : ""}`}
                key={row.customerRef}
              >
                <input
                  checked={pick === row.customerRef}
                  className="mt-1"
                  disabled={row.dobConflict}
                  name="id-customer"
                  onChange={() => setPick(row.customerRef)}
                  type="radio"
                />
                <span className="grid min-w-0 gap-0.5">
                  <b>
                    {row.name}
                    {row.memberNumber ? <span className="ml-1 font-normal text-[#6b7280]">#{row.memberNumber}</span> : null}
                  </b>
                  <span className="text-xs text-[#6b7280]">
                    {row.dobConflict
                      ? `Different date of birth on file (${row.dateOfBirth}) — another person`
                      : row.dobMatch
                        ? "Same date of birth"
                        : "No date of birth on file — it will be added"}
                    {row.phone ? ` · ${row.phone}` : ""}
                    {row.email ? ` · ${row.email}` : ""}
                  </span>
                </span>
              </label>
            ))}
            <label
              className={`flex items-start gap-2 border px-3 py-2 ${
                pick === NEW ? "border-[#4533ff] bg-[#eef0ff]" : "border-[#d4d4d8]"
              }`}
            >
              <input checked={pick === NEW} className="mt-1" name="id-customer" onChange={() => setPick(NEW)} type="radio" />
              <span className="grid gap-0.5">
                <b>New customer</b>
                <span className="text-xs text-[#6b7280]">Needs a Pelham Shift ID to approve.</span>
              </span>
            </label>
            {pick === NEW ? (
              <div className="grid grid-cols-2 gap-2">
                <Field hint="To text the QR code" label="Mobile">
                  <TextInput autoComplete="off" inputMode="tel" onChange={(e) => setPhone(e.target.value)} value={phone} />
                </Field>
                <Field hint="Optional" label="Email">
                  <TextInput autoComplete="off" inputMode="email" onChange={(e) => setEmail(e.target.value)} value={email} />
                </Field>
              </div>
            ) : null}
          </fieldset>
        )}

        {error ? <ErrorNote>{error}</ErrorNote> : null}

        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>{saved ? "Done" : "Cancel"}</Button>
          {saved ? null : (
            <Button disabled={!pick || busy || matches === null} onClick={() => void save()} tone="primary">
              {busy ? "Saving…" : "Save and check in"}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}

function Saved({ customer, result }: { customer: CustomerCard; result: CheckinResult | null }) {
  const qrBox = useRef<HTMLDivElement>(null);
  const [texting, setTexting] = useState(false);
  const [texted, setTexted] = useState("");
  const [problem, setProblem] = useState("");
  const link = customer.qrCode ? customerQrUrl(customer.qrCode) : "";

  useEffect(() => {
    const box = qrBox.current;
    if (!box || !link) return;
    let cancelled = false;
    void import("@zxing/browser").then(({ BrowserQRCodeSvgWriter }) => {
      if (cancelled) return;
      const svg = new BrowserQRCodeSvgWriter().write(link, QR_SIZE, QR_SIZE);
      svg.setAttribute("aria-label", `QR code ${customer.qrCode}`);
      box.replaceChildren(svg);
    });
    return () => {
      cancelled = true;
    };
  }, [customer.qrCode, link]);

  async function text() {
    setTexting(true);
    setProblem("");
    try {
      const last4 = await textCustomerQr(customer.customerRef);
      setTexted(last4 ? `Texted to the number ending ${last4}.` : "Texted.");
    } catch (cause) {
      setProblem(errorText(cause, "Couldn't text the QR code."));
    } finally {
      setTexting(false);
    }
  }

  return (
    <div className="grid gap-3">
      {result ? (
        <p
          className={`border px-3 py-2 font-bold ${
            result.status === "none" ? "border-[#e2c06a] bg-[#fff8e1] text-[#6b4e00]" : "border-[#9fd3b0] bg-[#e9f7ee] text-[#16723a]"
          }`}
          role="status"
        >
          {checkinMessage(result)}
        </p>
      ) : null}
      <div className="flex flex-col items-center gap-1">
        <div className="flex size-[200px] items-center justify-center bg-white" ref={qrBox} />
        <code className="font-mono text-xs text-[#3f434a]">{customer.qrCode}</code>
        <p className="text-center text-xs text-[#6b7280]">
          Next time, scan this code to check in. The customer can open it with their phone camera to add it to the
          Pelham Hills GPS app.
        </p>
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-[#6b7280]">{texted || (customer.phone ? `Mobile ${customer.phone}` : "No mobile on file")}</span>
        <Button disabled={!customer.phone || texting} onClick={() => void text()}>
          {texting ? "Texting…" : "Text QR code"}
        </Button>
      </div>
      {problem ? <ErrorNote>{problem}</ErrorNote> : null}
    </div>
  );
}
