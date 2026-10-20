"use client";

/**
 * 고객 마케팅 사이트 — 프로모션 문자(Twilio)와 AI 전화(ElevenLabs). 매니저와 Emmeline 만(0047 명단).
 *
 * 현금 리포트(`/cash`)처럼 **따로 로그인**한다. 프로 샵 태블릿은 늘 프로 샵 계정으로 로그인돼 있어서,
 * 이 주소는 세션 칸이 따로다(`lib/teeSheet/session.ts` 의 `storageKey`). 어드민 메뉴도 없다.
 *
 * 막는 것은 서버다: 0047 의 함수는 명단 밖 계정에 PT403 을, 발송 서버도 같은 함수로 확인한다.
 * 이 화면의 확인은 그 계정이 아닌 사람에게 빈 화면 대신 이유를 보여 주려는 것이다.
 */

import { useCallback, useEffect, useState, type FormEvent } from "react";

import MarketingApp from "@/components/marketing/MarketingApp";
import { CLUB } from "@/lib/nav";
import { describeMarketingError, marketingApi } from "@/lib/marketing/api";
import { ApiError } from "@/lib/teeSheet/api";
import { getSession, signIn, signOut, subscribe } from "@/lib/teeSheet/session";

type Gate =
  | { state: "checking" }
  | { state: "out" }
  | { state: "denied"; email: string }
  | { state: "error"; email: string; message: string }
  | { state: "in"; email: string };

export default function MarketingSitePage() {
  const [gate, setGate] = useState<Gate>({ state: "checking" });
  const [nonce, setNonce] = useState(0);

  useEffect(() => subscribe(() => setNonce((value) => value + 1)), []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const session = getSession();
      if (!session) {
        if (!cancelled) setGate({ state: "out" });
        return;
      }
      try {
        const allowed = await marketingApi.access();
        if (cancelled) return;
        if (!getSession()) setGate({ state: "out" });
        else setGate(allowed ? { state: "in", email: session.email } : { state: "denied", email: session.email });
      } catch (cause) {
        if (cancelled) return;
        if (!getSession()) {
          setGate({ state: "out" });
          return;
        }
        if (cause instanceof ApiError && (cause.status === 401 || cause.status === 403)) {
          setGate({ state: "denied", email: session.email });
        } else {
          setGate({ state: "error", email: session.email, message: describeMarketingError(cause) });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [nonce]);

  // 로그인·로그아웃 뒤에는 페이지를 새로 연다 — 앞 계정의 손님 명단이 메모리에 남지 않게.
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
  if (gate.state === "out") return <MarketingSignIn onSignedIn={reload} />;

  return (
    <div className="min-h-[100dvh] bg-[#f2f2f4] text-[#1f2328]">
      <header className="flex items-center justify-between gap-3 bg-[#111315] px-4 py-2.5 text-white">
        <div className="min-w-0">
          <p className="text-[10px] font-bold tracking-[0.12em] text-white/60 uppercase">{CLUB.shortName}</p>
          <h1 className="text-sm font-bold">Customer marketing</h1>
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
        <MarketingApp />
      ) : (
        <div className="mx-auto grid max-w-md gap-3 p-4">
          <div className="bg-white p-5 text-sm shadow-sm">
            {gate.state === "error" ? (
              <p className="text-[#8c1d1d]" role="alert">
                {gate.message}
              </p>
            ) : (
              <>
                <p className="font-bold">This account can&apos;t open customer marketing.</p>
                <p className="mt-2 text-[#6b7280]">
                  {gate.email ? `${gate.email} is not` : "You are not"} on the marketing list. Only the manager and
                  Emmeline can send promotions. Sign out and sign in with one of those accounts.
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
function MarketingSignIn({ onSignedIn }: { onSignedIn: () => void }) {
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
      onSignedIn();
    } catch (cause) {
      setBusy(false);
      setError(cause instanceof ApiError ? cause.message : "로그인에 실패했습니다. 잠시 후 다시 시도해 주세요.");
    }
  };

  return (
    <main className="grid min-h-[100dvh] place-items-center bg-[#111315] px-4 py-10 text-[#1f2328]">
      <div className="w-full max-w-[360px]">
        <p className="mb-4 text-sm font-bold text-white">{CLUB.shortName} · Customer marketing</p>
        <form className="bg-white p-5 shadow-sm" onSubmit={submit}>
          <h1 className="text-base font-bold">마케팅 로그인</h1>
          <p className="mt-1 text-xs leading-5 text-[#6b7280]">
            매니저와 Emmeline 계정만 들어옵니다. 프로 샵 로그인과 따로라 티 시트 쪽 계정은 그대로예요.
          </p>

          <label className="mt-4 block text-xs font-bold" htmlFor="marketing-login">
            아이디
          </label>
          <input
            autoCapitalize="none"
            autoComplete="username"
            autoCorrect="off"
            className="mt-1 h-11 w-full border border-[#d4d4d8] px-3 text-base"
            id="marketing-login"
            name="username"
            onChange={(event) => setLogin(event.target.value)}
            required
            spellCheck={false}
            type="text"
            value={login}
          />

          <label className="mt-3 block text-xs font-bold" htmlFor="marketing-password">
            비밀번호
          </label>
          <input
            autoComplete="current-password"
            className="mt-1 h-11 w-full border border-[#d4d4d8] px-3 text-base"
            id="marketing-password"
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
