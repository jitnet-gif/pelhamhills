"use client";

/**
 * 현금 리포트 사이트 — 프로 샵 어드민과 **따로 로그인**한다(2026-10-20 클럽 요청).
 *
 * 왜 따로인가: 프로 샵 태블릿은 늘 프로 샵 계정으로 로그인돼 있다. 현금 리포트를 그 안의 한 화면으로
 * 두면 현금 리포트 계정으로 보려면 프로 샵 계정을 로그아웃해야 했다. 이 주소는 세션 칸이 따로라
 * (`lib/teeSheet/session.ts` 의 `storageKey`) 같은 브라우저에서 티 시트는 프로 샵 계정으로 쓰면서
 * 현금 리포트는 자기 계정으로 들어오고 나간다. 어드민 메뉴도 없다 — 이 사이트에서 갈 곳은 리포트뿐이다.
 *
 * 막는 것은 서버다(0046): 명단(`pelham_cash_viewers`) 밖 계정은 현금 줄을 받지 못하고 담당자별 마감
 * 함수는 거절한다. 이 화면의 확인은 그 계정이 아닌 사람에게 빈 리포트 대신 이유를 보여 주려는 것이다.
 */

import { useCallback, useEffect, useState, type FormEvent } from "react";

import ReportsView from "@/components/reports/ReportsView";
import { CLUB } from "@/lib/nav";
import retailApi, { toRetailError } from "@/lib/retail/api";
import { ApiError } from "@/lib/teeSheet/api";
import { getSession, signIn, signOut, subscribe } from "@/lib/teeSheet/session";

type Gate =
  | { state: "checking" }
  | { state: "out" }
  | { state: "denied"; email: string }
  | { state: "error"; email: string; message: string }
  | { state: "in"; email: string };

export default function CashSitePage() {
  const [gate, setGate] = useState<Gate>({ state: "checking" });
  const [nonce, setNonce] = useState(0);

  useEffect(() => subscribe(() => setNonce((value) => value + 1)), []);

  useEffect(() => {
    let cancelled = false;
    // 판정은 전부 비동기 안에서 — localStorage 는 브라우저에서만 읽힌다(AdminShell 의 useStaffGate 와 같다).
    void (async () => {
      const session = getSession();
      if (!session) {
        if (!cancelled) setGate({ state: "out" });
        return;
      }
      try {
        const allowed = await retailApi.cashAccess();
        if (cancelled) return;
        if (!getSession()) setGate({ state: "out" });
        else setGate(allowed ? { state: "in", email: session.email } : { state: "denied", email: session.email });
      } catch (cause) {
        if (cancelled) return;
        if (!getSession()) {
          setGate({ state: "out" });
          return;
        }
        const error = toRetailError(cause);
        if (error.status === 401 || error.status === 403) setGate({ state: "denied", email: session.email });
        else setGate({ state: "error", email: session.email, message: error.message });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [nonce]);

  // 로그인·로그아웃 뒤에는 페이지를 새로 연다 — 앞 계정의 숫자가 메모리에 남지 않게(AdminShell 과 같다).
  const reload = useCallback(() => window.location.reload(), []);
  const doSignOut = useCallback(() => {
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
  if (gate.state === "out") return <CashSignIn onSignedIn={reload} />;

  return (
    <div className="min-h-[100dvh] bg-[#f2f2f4] text-[#1f2328]">
      <header className="flex items-center justify-between gap-3 bg-[#111315] px-4 py-2.5 text-white">
        <div className="min-w-0">
          <p className="text-[10px] font-bold tracking-[0.12em] text-white/60 uppercase">{CLUB.shortName}</p>
          <h1 className="text-sm font-bold">Cash report</h1>
        </div>
        <div className="flex min-w-0 items-center gap-3 text-xs">
          <span className="hidden truncate text-white/70 sm:inline">{gate.email}</span>
          <button
            className="min-h-9 border border-white/30 px-3 font-bold hover:bg-white/10"
            onClick={doSignOut}
            type="button"
          >
            Sign out
          </button>
        </div>
      </header>

      {gate.state === "in" ? (
        <ReportsView cash />
      ) : (
        <div className="mx-auto grid max-w-md gap-3 p-4">
          <div className="bg-white p-5 text-sm shadow-sm">
            {gate.state === "error" ? (
              <p className="text-[#8c1d1d]" role="alert">
                {gate.message}
              </p>
            ) : (
              <>
                <p className="font-bold">This account can&apos;t open the cash report.</p>
                <p className="mt-2 text-[#6b7280]">
                  {gate.email ? `${gate.email} is not` : "You are not"} on the cash report list. Sign out and sign in
                  with the cash report account.
                </p>
              </>
            )}
            <button
              className="mt-4 h-11 w-full bg-[#4533ff] text-sm font-bold text-white"
              onClick={doSignOut}
              type="button"
            >
              Sign in with another account
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** 이 사이트만의 로그인. 프로 샵 로그인과 칸이 달라서 여기서 들어와도 티 시트 쪽 로그인은 그대로다. */
function CashSignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await signIn(login, password);
      onSignedIn(); // 새로 열 때까지 버튼은 잠가 둔다.
    } catch (cause) {
      setBusy(false);
      setError(cause instanceof ApiError ? cause.message : "로그인에 실패했습니다. 잠시 후 다시 시도해 주세요.");
    }
  };

  return (
    <main className="grid min-h-[100dvh] place-items-center bg-[#111315] px-4 py-10 text-[#1f2328]">
      <div className="w-full max-w-[360px]">
        <p className="mb-4 text-sm font-bold text-white">{CLUB.shortName} · Cash report</p>
        <form className="bg-white p-5 shadow-sm" onSubmit={submit}>
          <h1 className="text-base font-bold">현금 리포트 로그인</h1>
          <p className="mt-1 text-xs leading-5 text-[#6b7280]">
            프로 샵 로그인과 따로입니다. 여기서 로그인·로그아웃해도 티 시트 쪽 계정은 그대로예요.
          </p>

          <label className="mt-4 block text-xs font-bold" htmlFor="cash-login">
            아이디
          </label>
          <input
            autoCapitalize="none"
            autoComplete="username"
            autoCorrect="off"
            className="mt-1 h-11 w-full border border-[#d4d4d8] px-3 text-base"
            id="cash-login"
            name="username"
            onChange={(event) => setLogin(event.target.value)}
            required
            spellCheck={false}
            type="text"
            value={login}
          />

          <label className="mt-3 block text-xs font-bold" htmlFor="cash-password">
            비밀번호
          </label>
          <input
            autoComplete="current-password"
            className="mt-1 h-11 w-full border border-[#d4d4d8] px-3 text-base"
            id="cash-password"
            name="password"
            onChange={(event) => setPassword(event.target.value)}
            required
            type="password"
            value={password}
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
            {busy ? "로그인 중…" : "로그인"}
          </button>
        </form>
      </div>
    </main>
  );
}
