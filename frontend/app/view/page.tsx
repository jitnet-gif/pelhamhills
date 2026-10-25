"use client";

/**
 * Reports 열람 사이트 — 아이디 없이 **비밀번호 숫자만** 넣고 본다(2026-10-24 클럽 요청).
 *
 * 화면은 `/admin/reports` 와 같다(`ReportsView` 를 그대로 쓴다). 다른 점은 들어오는 방법뿐이다:
 * 숫자를 넣으면 뒤에서 열람 전용 계정(`VIEW_EMAIL`)으로 로그인한다. 그 계정의 비밀번호는
 * `VIEW_PREFIX + 숫자` 다 — Supabase 비밀번호는 여섯 자 이상이어야 해서 앞말을 붙인다. 숫자는 코드에
 * 없다(저장소가 공개라서). 숫자를 바꾸려면 0103 을 새 숫자로 다시 실행하면 된다 — 배포는 필요 없다.
 *
 * 그러므로 이 사이트를 지키는 것은 그 숫자 하나다. 계정은 Reports 명단(0046)에 들어가 현금까지 보이고,
 * 데이터 백업(0100)은 못 한다(0103). 세션 칸은 따로다(`lib/teeSheet/session.ts` 의 `VIEW_SITE_PATH`) —
 * 같은 브라우저의 프로 샵 로그인과 섞이지 않는다.
 */

import { useCallback, useEffect, useState, type FormEvent } from "react";

import ReportsView from "@/components/reports/ReportsView";
import { CLUB } from "@/lib/nav";
import retailApi, { toRetailError } from "@/lib/retail/api";
import { ApiError } from "@/lib/teeSheet/api";
import { getSession, signIn, signOut, subscribe } from "@/lib/teeSheet/session";

/** 0103 이 만드는 열람 전용 계정. */
const VIEW_EMAIL = "reports-view@pelhamhills.ca";
const VIEW_PREFIX = "pelham-view-";

type Gate = { state: "checking" } | { state: "out" } | { state: "error"; message: string } | { state: "in" };

export default function ViewSitePage() {
  const [gate, setGate] = useState<Gate>({ state: "checking" });
  const [nonce, setNonce] = useState(0);

  useEffect(() => subscribe(() => setNonce((value) => value + 1)), []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!getSession()) {
        if (!cancelled) setGate({ state: "out" });
        return;
      }
      try {
        const allowed = await retailApi.cashAccess();
        if (cancelled) return;
        if (!getSession()) setGate({ state: "out" });
        else if (allowed) setGate({ state: "in" });
        else setGate({ state: "error", message: "열람 계정이 Reports 명단에 없습니다. 0103 SQL 을 실행해 주세요." });
      } catch (cause) {
        if (cancelled) return;
        if (!getSession()) setGate({ state: "out" });
        else setGate({ state: "error", message: toRetailError(cause).message });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [nonce]);

  // 들어오고 나간 뒤에는 페이지를 새로 연다 — 앞 세션의 숫자가 메모리에 남지 않게(/cash 와 같다).
  const reload = useCallback(() => window.location.reload(), []);
  const lock = useCallback(() => {
    setGate({ state: "checking" });
    void signOut().then(reload, reload);
    window.setTimeout(reload, 1500);
  }, [reload]);

  if (gate.state === "checking") {
    return (
      <main className="grid min-h-[100dvh] place-items-center bg-[#f2f2f4] px-4 text-sm text-[#4e5560]">
        <p>확인 중…</p>
      </main>
    );
  }
  if (gate.state === "out") return <PinSignIn onSignedIn={reload} />;

  return (
    <div className="min-h-[100dvh] bg-[#f2f2f4] text-[#1f2328]">
      <header className="flex items-center justify-between gap-3 bg-[#111315] px-4 py-2.5 text-white">
        <div className="min-w-0">
          <p className="text-[10px] font-bold tracking-[0.12em] text-white/60 uppercase">{CLUB.shortName}</p>
          <h1 className="text-sm font-bold">Reports</h1>
        </div>
        <button
          className="min-h-9 border border-white/30 px-3 text-xs font-bold hover:bg-white/10"
          onClick={lock}
          type="button"
        >
          Lock
        </button>
      </header>

      {gate.state === "in" ? (
        <ReportsView cash />
      ) : (
        <div className="mx-auto grid max-w-md gap-3 p-4">
          <div className="bg-white p-5 text-sm shadow-sm">
            <p className="text-[#8c1d1d]" role="alert">
              {gate.message}
            </p>
            <button className="mt-4 h-11 w-full bg-[#4533ff] text-sm font-bold text-white" onClick={lock} type="button">
              Try again
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function PinSignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || !pin) return;
    setBusy(true);
    setError("");
    try {
      await signIn(VIEW_EMAIL, VIEW_PREFIX + pin);
      onSignedIn(); // 새로 열 때까지 버튼은 잠가 둔다.
    } catch (cause) {
      setBusy(false);
      setPin("");
      setError(
        cause instanceof ApiError && (cause.status === 400 || cause.status === 401)
          ? "비밀번호가 올바르지 않습니다."
          : cause instanceof ApiError
            ? cause.message
            : "로그인에 실패했습니다. 잠시 후 다시 시도해 주세요.",
      );
    }
  };

  return (
    <main className="grid min-h-[100dvh] place-items-center bg-[#111315] px-4 py-10 text-[#1f2328]">
      <div className="w-full max-w-[320px]">
        <p className="mb-4 text-sm font-bold text-white">{CLUB.shortName} · Reports</p>
        <form className="bg-white p-5 shadow-sm" onSubmit={submit}>
          <label className="block text-base font-bold" htmlFor="view-pin">
            비밀번호
          </label>
          <input
            autoComplete="off"
            autoFocus
            className="mt-3 h-12 w-full border border-[#d4d4d8] px-3 text-center text-2xl tracking-[0.4em]"
            id="view-pin"
            inputMode="numeric"
            name="pin"
            onChange={(event) => setPin(event.target.value.trim())}
            required
            type="password"
            value={pin}
          />

          {error ? (
            <p className="mt-3 border border-[#f0b4b4] bg-[#fdf1f1] p-2 text-xs leading-5 text-[#8c1d1d]" role="alert">
              {error}
            </p>
          ) : null}

          <button
            className="mt-4 h-11 w-full bg-[#4533ff] text-sm font-bold text-white disabled:opacity-60"
            disabled={busy}
            type="submit"
          >
            {busy ? "확인 중…" : "열기"}
          </button>
        </form>
      </div>
    </main>
  );
}
