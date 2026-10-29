"use client";

/**
 * 직원 ID 숫자판 — 어드민 첫 화면과 잠금 화면이 같이 쓴다(`lib/staffPin.ts`).
 *
 * 네 자리를 누르면 바로 확인한다. 그 번호가 아무도 아니면 조용히 기다린다 — Shift ID 는 4~8자리라서
 * 다섯 자리 이상인 직원은 이어서 누르고 OK 를 누른다. OK 로 보낸 번호가 틀리면 그때 문장을 띄운다.
 *
 * 키보드(숫자·Backspace·Enter)도 받는다. `captureKeys` 면 창 전체의 키를 먼저 가로챈다 — 잠금 화면 뒤의
 * 티 시트 바코드 스캐너가 숫자를 받아 가지 않게.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { ApiError } from "@/lib/teeSheet/api";

const MIN = 4;
const MAX = 8;

type Props = {
  /** 번호를 확인한다. 틀리면 ApiError 를 던진다. */
  onSubmit: (code: string) => Promise<void>;
  captureKeys?: boolean;
};

export default function PinPad({ onSubmit, captureKeys = false }: Props) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const busyRef = useRef(false);
  // 키를 빠르게 연달아 눌러도 렌더를 기다리지 않게 지금 숫자를 ref 에도 둔다.
  const codeRef = useRef("");
  const put = useCallback((next: string) => {
    codeRef.current = next;
    setCode(next);
  }, []);

  const submit = useCallback(
    async (value: string, auto: boolean) => {
      if (busyRef.current || value.length < MIN) return;
      busyRef.current = true;
      setBusy(true);
      setError("");
      try {
        await onSubmit(value);
        // 성공하면 부르는 쪽이 화면을 바꾼다. 숫자는 지워 둔다.
        put("");
      } catch (cause) {
        const status = cause instanceof ApiError ? cause.status : 0;
        if (auto && status === 404) return; // 더 긴 번호일 수 있다.
        put("");
        setError(
          status === 404
            ? "That staff ID is not right."
            : cause instanceof ApiError
              ? cause.message
              : "Couldn't check the ID. Try again.",
        );
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [onSubmit, put],
  );

  const press = useCallback(
    (digit: string) => {
      if (busyRef.current || codeRef.current.length >= MAX) return;
      setError("");
      const next = codeRef.current + digit;
      put(next);
      if (next.length === MIN) void submit(next, true);
    },
    [put, submit],
  );

  const back = useCallback(() => {
    if (busyRef.current) return;
    put(codeRef.current.slice(0, -1));
  }, [put]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (/^\d$/.test(event.key)) press(event.key);
      else if (event.key === "Backspace") back();
      else if (event.key === "Enter") void submit(codeRef.current, false);
      else if (!captureKeys) return;
      event.preventDefault();
      if (captureKeys) event.stopPropagation();
    };
    window.addEventListener("keydown", onKey, { capture: captureKeys });
    return () => window.removeEventListener("keydown", onKey, { capture: captureKeys });
  }, [press, back, submit, captureKeys]);

  const key = "h-14 bg-[#f2f2f4] text-xl font-bold text-[#1f2328] active:bg-[#e4e4e7] disabled:opacity-50";

  return (
    <div>
      <div aria-label="Staff ID" className="flex h-12 items-center justify-center gap-3" role="status">
        {Array.from({ length: Math.max(MIN, code.length) }, (_, index) => (
          <span
            aria-hidden
            className={`h-3.5 w-3.5 rounded-full ${index < code.length ? "bg-[#4533ff]" : "border-2 border-[#c4c4cc]"}`}
            key={index}
          />
        ))}
      </div>

      {error ? (
        <p className="mt-2 border border-[#f0b4b4] bg-[#fdf1f1] p-2 text-center text-xs leading-5 text-[#8c1d1d]" role="alert">
          {error}
        </p>
      ) : (
        <p className="mt-2 h-5 text-center text-xs text-[#6b7280]">{busy ? "Checking…" : ""}</p>
      )}

      <div className="mt-3 grid grid-cols-3 gap-2">
        {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((digit) => (
          <button className={key} disabled={busy} key={digit} onClick={() => press(digit)} type="button">
            {digit}
          </button>
        ))}
        <button aria-label="Delete" className={key} disabled={busy} onClick={back} type="button">
          ⌫
        </button>
        <button className={key} disabled={busy} onClick={() => press("0")} type="button">
          0
        </button>
        <button
          className="h-14 bg-[#4533ff] text-base font-bold text-white disabled:opacity-50"
          disabled={busy || code.length < MIN}
          onClick={() => void submit(code, false)}
          type="button"
        >
          OK
        </button>
      </div>
    </div>
  );
}
