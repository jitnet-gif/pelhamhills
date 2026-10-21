"use client";

/**
 * 레인체크(0011) 발행 창. 티 시트 예약 상세에서 결제한 사람의 카드(한 사람) 또는 머리 줄의
 * Rain checks(아직 없는 사람 전부)로 연다.
 *
 * 사람마다 전표가 한 장씩 나간다 — 크레딧도 사람마다 따로다(누가 무엇을 냈는지가 다르다).
 * 금액의 기본값은 서버가 계산한 "그 사람이 낸 돈"이고 낮출 수만 있다. 만료일·친 홀 수는
 * 일행이 같이 비를 맞았으니 한 번에 적는다.
 *
 * 이미 레인체크가 있는 사람은 다시 발행하지 않고 재인쇄·무효만 한다(코드가 하나여야 한 번만 쓴다).
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { rememberedCashier, rememberCashier } from "@/lib/pos/currentBill";
import {
  announceRainChecksChanged,
  describeRainCheckError,
  isRainCheckMissing,
  onRainChecksChanged,
  rainCheckApi,
  type RainCheck,
  type RainCheckQuote,
} from "@/lib/pos/rainCheck";
import { printRainChecks, rainCheckSheetHtml } from "@/lib/retail/printReceipt";
import { usDate } from "@/lib/retail/receipt";
import { formatMoney, parseMoney } from "@/lib/retail/types";
import type { Player, TeeBooking } from "@/lib/teeSheet/types";

// ===== 예약 하나의 레인체크 목록 ========================================

export type RainCheckList = {
  /** 무효 포함, 발행 순. */
  checks: RainCheck[];
  /** 0011 이 아직 안 돌았다. 버튼을 숨긴다. */
  missing: boolean;
  reload: () => void;
};

/** 사람 하나의 살아 있는(발행·사용) 레인체크. */
export function activeRainCheck(checks: readonly RainCheck[], playerId: string): RainCheck | null {
  return checks.find((check) => check.player_id === playerId && check.status !== "void") ?? null;
}

export function useRainChecks(bookingId: string | null): RainCheckList {
  const [state, setState] = useState<{ bookingId: string | null; checks: RainCheck[]; missing: boolean }>({
    bookingId: null,
    checks: [],
    missing: false,
  });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!bookingId) return;
    let live = true;
    rainCheckApi
      .forBooking(bookingId)
      .then((checks) => {
        if (live) setState({ bookingId, checks, missing: false });
      })
      .catch((error: unknown) => {
        // 목록을 못 읽어도 티 시트는 그대로 쓴다. 발행 창이 열릴 때 같은 오류를 다시 보여 준다.
        if (live) setState({ bookingId, checks: [], missing: isRainCheckMissing(error) });
      });
    return () => {
      live = false;
    };
  }, [bookingId, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  // 다른 탭·다른 컴퓨터에서 같은 예약의 레인체크를 내줬을 수도 있다.
  useEffect(() => onRainChecksChanged(reload), [reload]);
  // 다른 예약의 목록이 잠깐 보이지 않게, 지금 예약 것만 돌려준다.
  const current = state.bookingId === bookingId;
  return { checks: current ? state.checks : [], missing: current && state.missing, reload };
}

/** ☂ 색: 쓸 수 있으면 "live", 썼거나 지났으면 "spent". */
export function rainCheckTone(check: RainCheck): "live" | "spent" {
  return check.status === "issued" && !check.expired ? "live" : "spent";
}

export function rainCheckTitle(check: RainCheck): string {
  const state = check.status === "redeemed" ? "used" : check.expired ? "expired" : `good until ${usDate(check.expires_on)}`;
  return `Rain check ${check.code} · ${formatMoney(check.amount)} · ${state}`;
}

// ===== 티 시트 격자: 보이는 날짜의 레인체크 =================================

/**
 * 격자의 ☂(0064). 키는 `예약id:선수id`, 무효는 서버가 뺀다.
 * 0064 를 아직 안 돌렸거나 못 읽으면 빈 지도 — 격자는 ☂ 없이 그대로 쓴다.
 */
export function useRainChecksBetween(from: string | null, to: string | null): Map<string, RainCheck> {
  const [state, setState] = useState<{ range: string; map: Map<string, RainCheck> }>({ range: "", map: new Map() });
  const [nonce, setNonce] = useState(0);
  const range = from && to ? `${from}..${to}` : "";

  useEffect(() => onRainChecksChanged(() => setNonce((n) => n + 1)), []);

  useEffect(() => {
    if (!from || !to) return;
    let live = true;
    rainCheckApi
      .between(from, to)
      .then((checks) => {
        if (!live) return;
        const map = new Map<string, RainCheck>();
        for (const check of checks) {
          if (check.status === "void") continue;
          const key = `${check.booking_id}:${check.player_id}`;
          // 같은 사람에게 무효 뒤 다시 낸 경우 — 나중 것(살아 있는 것)이 이긴다.
          if (!map.has(key) || check.status === "issued") map.set(key, check);
        }
        setState({ range: `${from}..${to}`, map });
      })
      .catch(() => {
        if (live) setState({ range: `${from}..${to}`, map: new Map() });
      });
    return () => {
      live = false;
    };
  }, [from, to, nonce]);

  return state.range === range ? state.map : EMPTY_RAIN_CHECKS;
}

const EMPTY_RAIN_CHECKS = new Map<string, RainCheck>();

// ===== 문자로 보내기 ====================================================

/**
 * 전표를 손님 휴대폰으로(바코드 MMS). 번호는 예약의 그 사람 번호로 채워 두고 직원이 고칠 수 있다.
 * 종이 대신이 아니라 종이와 함께다 — 다음에 오면 휴대폰 화면의 바코드를 쏘면 된다.
 * `autoSend`: 이 창에서 방금 발행한 전표는 번호가 있으면 바로 보낸다(2026-10-21). 못 가면 버튼으로 다시.
 */
function TextSlip({ check, defaultPhone, autoSend }: { check: RainCheck; defaultPhone: string; autoSend?: boolean }) {
  const [phone, setPhone] = useState(defaultPhone ?? "");
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const autoSent = useRef(false);

  const send = useCallback(async (to: string) => {
    if (!to.trim()) return;
    setSending(true);
    setResult(null);
    try {
      const { to: sentTo } = await rainCheckApi.text(check.code, to.trim());
      setResult({ ok: true, message: `Texted to ${sentTo}.` });
    } catch (error) {
      setResult({ ok: false, message: describeRainCheckError(error) });
    } finally {
      setSending(false);
    }
  }, [check.code]);

  useEffect(() => {
    if (!autoSend || autoSent.current || !(defaultPhone ?? "").trim()) return;
    autoSent.current = true;
    void send(defaultPhone);
  }, [autoSend, defaultPhone, send]);

  return (
    <div className="grid gap-1">
      <div className="flex gap-1">
        <input
          className="min-w-0 flex-1 border border-[#d7d7dc] bg-white px-2 py-1 outline-none focus:border-[#4533ff]"
          inputMode="tel"
          onChange={(event) => {
            setPhone(event.target.value);
            setResult(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !sending) void send(phone);
          }}
          placeholder="Mobile number"
          type="tel"
          value={phone}
        />
        <button
          className="shrink-0 border border-[#c7c7cc] px-2 py-1 font-bold hover:border-[#4533ff] disabled:opacity-40"
          disabled={sending || !phone.trim()}
          onClick={() => void send(phone)}
          type="button"
        >
          {sending ? "Sending…" : result?.ok ? "Text again" : "Text barcode"}
        </button>
      </div>
      {result ? <p className={result.ok ? "text-[#1f7a3a]" : "text-[#8a3f26]"}>{result.message}</p> : null}
    </div>
  );
}

// ===== 창 ==============================================================

type Row = {
  player: Player;
  quote: RainCheckQuote | null;
  /** 직원이 친 금액(달러 문자열). 비우면 기본값. */
  amountInput: string;
  error: string;
};

type Props = {
  booking: TeeBooking;
  players: Player[];
  existing: RainCheck[];
  onClose: () => void;
  /** 발행·무효 뒤. 목록을 다시 읽는다. */
  onChanged: () => void;
};

export default function RainCheckDialog({ booking, players, existing, onClose, onChanged }: Props) {
  const [rows, setRows] = useState<Row[]>(() =>
    players.map((player) => ({ player, quote: null, amountInput: "", error: "" })),
  );
  const [loadError, setLoadError] = useState("");
  const [expiresOn, setExpiresOn] = useState("");
  const [minDate, setMinDate] = useState("");
  const [holesPlayed, setHolesPlayed] = useState("");
  const [cashier, setCashier] = useState(() => rememberedCashier());
  const [note, setNote] = useState("");
  const [working, setWorking] = useState(false);
  const [issued, setIssued] = useState<RainCheck[]>([]);
  const [voiding, setVoiding] = useState<{ code: string; reason: string } | null>(null);

  // 사람마다 서버에 "얼마를 냈나"를 묻는다. 기본 만료일도 같이 온다.
  useEffect(() => {
    let live = true;
    Promise.all(players.map((player) => rainCheckApi.quote(booking.id, player.id)))
      .then((quotes) => {
        if (!live) return;
        setRows((current) => current.map((row, index) => ({ ...row, quote: quotes[index] ?? null })));
        const first = quotes[0];
        if (first) {
          setExpiresOn((value) => value || first.default_expires_on);
          setMinDate(first.issued_on);
        }
      })
      .catch((error: unknown) => {
        if (live) setLoadError(describeRainCheckError(error));
      });
    return () => {
      live = false;
    };
  }, [booking.id, players]);

  const activeFor = (playerId: string) =>
    issued.find((check) => check.player_id === playerId) ?? activeRainCheck(existing, playerId);

  const toIssue = rows.filter((row) => !activeFor(row.player.id) && row.quote && row.quote.paid_value > 0);
  const issuedOrExisting = rows
    .map((row) => activeFor(row.player.id))
    .filter((check): check is RainCheck => Boolean(check));

  const amountOf = (row: Row): number => {
    if (!row.quote) return 0;
    return row.amountInput.trim() ? parseMoney(row.amountInput) : row.quote.paid_value;
  };

  async function issueAll() {
    if (working || toIssue.length === 0) return;
    if (!expiresOn) {
      setLoadError("Pick the expiry date.");
      return;
    }
    // 적요(사유)는 필수다 — 종이에 찍히고 예약 History 에 승인 매니저와 같이 남는다(0056).
    if (!note.trim()) {
      setLoadError("Write the reason for the rain check.");
      return;
    }
    if (holesPlayed !== "" && !(Number(holesPlayed) >= 0 && Number(holesPlayed) <= 18)) {
      setLoadError("Holes played must be between 0 and 18.");
      return;
    }
    setLoadError("");
    setWorking(true);
    if (cashier.trim()) rememberCashier(cashier);
    const made: RainCheck[] = [];
    const errors = new Map<string, string>();
    // 차례로 보낸다. 서버가 예약 행을 잠그고 기록(audit)을 남기므로 동시에 보내면 서로 기다린다.
    for (const row of toIssue) {
      const amount = amountOf(row);
      if (!(amount > 0) || (row.quote && amount > row.quote.paid_value)) {
        errors.set(row.player.id, `Enter an amount between $0.01 and ${formatMoney(row.quote?.paid_value ?? 0)}.`);
        continue;
      }
      try {
        made.push(
          await rainCheckApi.issue({
            booking_id: booking.id,
            player_id: row.player.id,
            amount,
            expires_on: expiresOn,
            holes_played: holesPlayed === "" ? null : Number(holesPlayed),
            ...(cashier.trim() ? { cashier: cashier.trim() } : {}),
            ...(note.trim() ? { note: note.trim() } : {}),
          }),
        );
      } catch (error) {
        errors.set(row.player.id, describeRainCheckError(error));
      }
    }
    setRows((current) => current.map((row) => ({ ...row, error: errors.get(row.player.id) ?? "" })));
    setIssued((current) => [...current, ...made]);
    setWorking(false);
    if (made.length > 0) {
      onChanged();
      announceRainChecksChanged();
      // 인쇄는 다음 틱으로 — 화면이 "발행됨"으로 바뀐 뒤에 인쇄 창이 뜨게.
      window.setTimeout(() => printRainChecks(made), 0);
    }
  }

  async function voidOne() {
    if (!voiding || !voiding.reason.trim()) return;
    setWorking(true);
    try {
      await rainCheckApi.void(voiding.code, voiding.reason.trim());
      setIssued((current) => current.filter((check) => check.code !== voiding.code));
      setVoiding(null);
      onChanged();
      announceRainChecksChanged();
    } catch (error) {
      setLoadError(describeRainCheckError(error));
    } finally {
      setWorking(false);
    }
  }

  const preview = issuedOrExisting[0] ?? null;

  return (
    <div
      aria-label="Rain check"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={(event) => {
        if (event.target === event.currentTarget && !working) onClose();
      }}
      role="dialog"
    >
      <div className="flex max-h-full w-full max-w-md flex-col border border-[#c7c7cc] bg-[#f2f2f4] text-xs text-[#1f2328]">
        <div className="flex items-center gap-2 border-b border-[#c7c7cc] bg-white px-3 py-2">
          <span className="font-bold">Rain check</span>
          <span className="min-w-0 truncate text-[#5c6270]">
            {booking.time} · {usDate(booking.date)} · one slip per player
          </span>
          <button
            className="ml-auto px-1 text-[15px] text-[#4e5560]"
            disabled={working}
            onClick={onClose}
            title="Close"
            type="button"
          >
            <span aria-hidden>&times;</span>
          </button>
        </div>

        <div className="grid min-h-0 flex-1 gap-2 overflow-y-auto p-3">
          {rows.map((row) => {
            const check = activeFor(row.player.id);
            return (
              <div className="grid gap-1 border border-[#c7c7cc] bg-white p-2" key={row.player.id}>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate font-bold">{row.player.name}</span>
                  <span className="shrink-0 text-[#5c6270]">
                    {row.quote
                      ? `Paid ${formatMoney(row.quote.paid_value)}${row.quote.source_receipt ? ` · ${row.quote.source_receipt}` : ""}`
                      : loadError
                        ? ""
                        : "…"}
                  </span>
                </div>
                {check ? (
                  <div className="grid gap-1">
                    <p>
                      <b>{check.code}</b> · {formatMoney(check.amount)} · valid through {usDate(check.expires_on)}
                      {check.status === "redeemed"
                        ? ` · used${check.redeemed_receipt ? ` on ${check.redeemed_receipt}` : ""}`
                        : check.expired
                          ? " · expired"
                          : ""}
                    </p>
                    <div className="flex gap-1">
                      <button
                        className="border border-[#c7c7cc] px-2 py-1 font-bold hover:border-[#4533ff]"
                        onClick={() => printRainChecks([check], { reprint: !issued.includes(check) })}
                        type="button"
                      >
                        {issued.includes(check) ? "Print again" : "Reprint"}
                      </button>
                      {check.status === "issued" ? (
                        <button
                          className="border border-[#c7c7cc] px-2 py-1 font-bold text-[#8a3f26] hover:border-[#8a3f26]"
                          onClick={() => setVoiding({ code: check.code, reason: "" })}
                          type="button"
                        >
                          Void
                        </button>
                      ) : null}
                    </div>
                    {check.status === "issued" && !check.expired && voiding?.code !== check.code ? (
                      <TextSlip
                        autoSend={issued.includes(check)}
                        check={check}
                        defaultPhone={row.player.phone}
                      />
                    ) : null}
                    {voiding?.code === check.code ? (
                      <div className="grid gap-1 border border-[#c47a63] bg-[#fbeae5] p-2">
                        <input
                          autoFocus
                          className="border border-[#d7d7dc] bg-white px-2 py-1 outline-none focus:border-[#8a3f26]"
                          onChange={(event) => setVoiding({ code: check.code, reason: event.target.value })}
                          placeholder="Why void it? (written to the record)"
                          value={voiding.reason}
                        />
                        <div className="flex gap-1">
                          <button
                            className="bg-[#8a3f26] px-3 py-1 font-bold text-white disabled:opacity-40"
                            disabled={working || !voiding.reason.trim()}
                            onClick={() => void voidOne()}
                            type="button"
                          >
                            Void {check.code}
                          </button>
                          <button
                            className="border border-[#c7c7cc] bg-white px-3 py-1 font-bold"
                            onClick={() => setVoiding(null)}
                            type="button"
                          >
                            Back
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </div>
                ) : row.quote && row.quote.paid_value <= 0 ? (
                  <p className="text-[#8a3f26]">Paid nothing for this round (comp or prepaid) — no credit to give.</p>
                ) : row.quote ? (
                  <label className="flex items-center gap-2">
                    <span className="shrink-0 text-[#5c6270]">Credit (HST incl.)</span>
                    <span aria-hidden className="ml-auto text-[#9aa0a6]">
                      $
                    </span>
                    <input
                      className="w-20 border-b border-[#d7d7dc] text-right tabular-nums outline-none focus:border-[#4533ff]"
                      inputMode="decimal"
                      onChange={(event) =>
                        setRows((current) =>
                          current.map((item) =>
                            item.player.id === row.player.id ? { ...item, amountInput: event.target.value } : item,
                          ),
                        )
                      }
                      placeholder={(row.quote.paid_value / 100).toFixed(2)}
                      value={row.amountInput}
                    />
                  </label>
                ) : null}
                {row.error ? <p className="text-[#8a3f26]">{row.error}</p> : null}
              </div>
            );
          })}

          {toIssue.length > 0 ? (
            <div className="grid grid-cols-2 gap-2 border border-[#c7c7cc] bg-white p-2">
              <label className="grid gap-0.5">
                <span className="font-bold text-[#5c6270]">Valid through</span>
                <input
                  className="border-b border-[#d7d7dc] py-1 outline-none focus:border-[#4533ff]"
                  min={minDate || undefined}
                  onChange={(event) => setExpiresOn(event.target.value)}
                  type="date"
                  value={expiresOn}
                />
              </label>
              <label className="grid gap-0.5">
                <span className="font-bold text-[#5c6270]">Holes played</span>
                <select
                  className="border-b border-[#d7d7dc] bg-transparent py-1 outline-none focus:border-[#4533ff]"
                  onChange={(event) => setHolesPlayed(event.target.value)}
                  value={holesPlayed}
                >
                  <option value="">Not recorded</option>
                  {Array.from({ length: 19 }, (_, holes) => (
                    <option key={holes} value={String(holes)}>
                      {holes}
                    </option>
                  ))}
                </select>
              </label>
              <label className="grid gap-0.5">
                <span className="font-bold text-[#5c6270]">Issued by</span>
                <input
                  className="border-b border-[#d7d7dc] py-1 outline-none focus:border-[#4533ff]"
                  onChange={(event) => setCashier(event.target.value)}
                  placeholder="Your name"
                  value={cashier}
                />
              </label>
              <label className="grid gap-0.5">
                <span className="font-bold text-[#5c6270]">Reason (printed · History)</span>
                <input
                  className={`border-b py-1 outline-none focus:border-[#4533ff] ${
                    note.trim() ? "border-[#d7d7dc]" : "border-[#c47a63]"
                  }`}
                  maxLength={200}
                  onChange={(event) => setNote(event.target.value)}
                  placeholder="Rain, lightning, course closed…"
                  value={note}
                />
              </label>
            </div>
          ) : null}

          {loadError ? <p className="border border-[#c47a63] bg-[#fbeae5] p-2 text-[#8a3f26]">{loadError}</p> : null}

          {/* 종이에 나가는 것과 같은 HTML. 발행한(또는 이미 있던) 첫 장을 보여 준다. */}
          {preview ? (
            <div
              className="rc-sheet mx-auto bg-white p-3 shadow"
              // 우리 포맷터가 만든 HTML 이다 — 사람이 입력한 글자는 전부 이스케이프돼 있다.
              dangerouslySetInnerHTML={{ __html: rainCheckSheetHtml(preview) }}
              style={{ width: "72mm" }}
            />
          ) : null}
        </div>

        <div className="flex items-center gap-2 border-t border-[#c7c7cc] bg-white px-3 py-2">
          <button
            className="border border-[#c7c7cc] bg-white px-4 py-2 font-bold"
            disabled={working}
            onClick={onClose}
            type="button"
          >
            {issued.length > 0 ? "Done" : "Cancel"}
          </button>
          <span className="text-[10px] leading-tight text-[#5c6270]">
            One slip per player
            <br />
            barcode = rain check code
          </span>
          <button
            className="ml-auto bg-[#4533ff] px-5 py-2 font-bold text-white disabled:cursor-not-allowed disabled:bg-[#b1a8ff]"
            disabled={working || toIssue.length === 0 || !expiresOn || !note.trim()}
            title={note.trim() ? undefined : "Write the reason first — it is printed on the slip and kept in History"}
            onClick={() => void issueAll()}
            type="button"
          >
            {working ? "Issuing…" : `Issue ${toIssue.length}, print & text`}
          </button>
        </div>
      </div>
    </div>
  );
}
