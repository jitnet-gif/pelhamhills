"use client";

/**
 * 숫자로 여는 어드민 — 아이디 없이 **비밀번호 숫자만** 넣으면 어드민 메뉴 전체로 들어간다(2026-10-24 클럽 요청).
 * 처음(0103)에는 Reports 만 보여 줬는데, 같은 날 메뉴 전체로 넓혔다(0104).
 *
 * 숫자를 넣으면 열람 계정(`VIEW_EMAIL`)으로 **프로 샵 로그인 칸**에 로그인하고 `/admin` 으로 간다. 그래서 같은
 * 브라우저에 프로 샵 계정이 로그인돼 있었으면 이 계정으로 바뀐다. 비밀번호는 `VIEW_PREFIX + 숫자` 다 — Supabase
 * 비밀번호는 여섯 자 이상이어야 해서 앞말을 붙인다. 숫자는 코드에 없다(저장소가 공개라서). 숫자를 바꾸려면
 * 0103 을 새 숫자로 다시 실행하면 된다 — 배포는 필요 없다.
 *
 * 그러므로 이 계정을 지키는 것은 그 숫자 하나다. 메뉴 권한은 0103·0104 가 준다 — Account Setup 과 Data Backup 은
 * 주지 않는다. 나가기는 어드민의 Sign out.
 */

import { useState, type FormEvent } from "react";

import { CLUB } from "@/lib/nav";
import { ApiError } from "@/lib/teeSheet/api";
import { signIn } from "@/lib/teeSheet/session";

/** 0103 이 만드는 열람 계정. */
const VIEW_EMAIL = "reports-view@pelhamhills.ca";
const VIEW_PREFIX = "pelham-view-";

export default function ViewSitePage() {
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
      // 페이지째 옮긴다 — 어드민이 새 세션으로 처음부터 판정하게(AdminShell 의 로그인과 같다).
      window.location.assign("/admin");
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
        <p className="mb-4 text-sm font-bold text-white">{CLUB.shortName} · Admin</p>
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
