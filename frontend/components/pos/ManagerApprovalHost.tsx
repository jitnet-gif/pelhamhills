"use client";

/**
 * 매니저 PIN 창(0024). 루트 레이아웃에 하나만 달려 있다가, 직원 함수가 매니저 승인으로 막히면
 * (`lib/teeSheet/managerApproval`) 뜬다. 매니저가 PIN 을 치면 서버가 확인하고 10분짜리 승인을 남긴다 —
 * 그 뒤 원래 요청이 다시 나간다. 취소하면 원래 요청은 "Cancelled." 로 끝난다.
 *
 * 숫자 패드는 터치 계산대용이다. 키보드 숫자·Backspace·Enter·Esc 도 받는다.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { setApprovalPrompt, type ApprovalRequest } from "@/lib/teeSheet/managerApproval";
import { approveAsManager } from "@/lib/teeSheet/staffRpc";

const MAX_PIN = 8;

type Open = { request: ApprovalRequest; resolve: (approved: boolean) => void };

export default function ManagerApprovalHost() {
  const [open, setOpen] = useState<Open | null>(null);
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const openRef = useRef<Open | null>(null);

  useEffect(
    () =>
      setApprovalPrompt(
        (request) =>
          new Promise<boolean>((resolve) => {
            // 앞 창이 아직 떠 있으면 그것은 취소로 끝낸다(한 번에 한 가지만 묻는다).
            openRef.current?.resolve(false);
            const next = { request, resolve };
            openRef.current = next;
            setOpen(next);
            setPin("");
            setError(null);
            setChecking(false);
          }),
      ),
    [],
  );

  const finish = useCallback((approved: boolean) => {
    openRef.current?.resolve(approved);
    openRef.current = null;
    setOpen(null);
    setPin("");
    setError(null);
  }, []);

  const submit = useCallback(async () => {
    const current = openRef.current;
    if (!current || checking || pin.length < 4) return;
    setChecking(true);
    setError(null);
    try {
      const result = await approveAsManager(pin, current.request.action, current.request.ref);
      if (openRef.current !== current) return;
      if (result?.approved) {
        finish(true);
        return;
      }
      setError(result?.message || "That PIN is not a manager PIN.");
      setPin("");
    } catch (cause) {
      if (openRef.current !== current) return;
      setError(cause instanceof Error ? cause.message : "Could not check the PIN.");
      setPin("");
    } finally {
      setChecking(false);
    }
  }, [checking, finish, pin]);

  const press = useCallback(
    (key: string) => {
      if (checking) return;
      setError(null);
      if (key === "back") setPin((value) => value.slice(0, -1));
      else if (key === "clear") setPin("");
      else setPin((value) => (value.length < MAX_PIN ? value + key : value));
    },
    [checking],
  );

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (/^[0-9]$/.test(event.key)) press(event.key);
      else if (event.key === "Backspace") press("back");
      else if (event.key === "Enter") void submit();
      else if (event.key === "Escape" && !checking) finish(false);
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [checking, finish, open, press, submit]);

  if (!open) return null;

  return (
    <div
      aria-labelledby="manager-approval-title"
      aria-modal="true"
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 p-4"
      role="dialog"
    >
      <div className="w-full max-w-[300px] border border-[#c7c7cc] bg-[#f2f2f4] text-xs text-[#1f2328] shadow-xl">
        <div className="border-b border-[#c7c7cc] bg-white px-4 py-3">
          <h2 className="text-sm font-bold" id="manager-approval-title">
            Manager approval
          </h2>
          <p className="mt-1 text-[#4e5560]">{open.request.message}</p>
        </div>

        <div className="p-4">
          <div
            aria-label={`${pin.length} digits entered`}
            className={`flex h-10 items-center justify-center gap-2 border bg-white ${
              error ? "border-[#c0262d]" : "border-[#c7c7cc]"
            }`}
          >
            {pin.length === 0 ? (
              <span className="text-[#9aa0a6]">Manager PIN</span>
            ) : (
              Array.from({ length: pin.length }, (_, index) => (
                <span className="h-2.5 w-2.5 rounded-full bg-[#1f2328]" key={index} />
              ))
            )}
          </div>
          <p className="mt-1 min-h-[16px] text-[11px] text-[#c0262d]" role="alert">
            {checking ? <span className="text-[#4e5560]">Checking…</span> : error}
          </p>

          <div className="mt-1 grid grid-cols-3 gap-1.5">
            {["1", "2", "3", "4", "5", "6", "7", "8", "9", "clear", "0", "back"].map((key) => (
              <button
                className="h-11 border border-[#c7c7cc] bg-white text-base font-bold hover:bg-[#ececf0] disabled:opacity-40"
                disabled={checking}
                key={key}
                onClick={() => press(key)}
                type="button"
              >
                {key === "back" ? "⌫" : key === "clear" ? <span className="text-xs">Clear</span> : key}
              </button>
            ))}
          </div>

          <div className="mt-3 grid grid-cols-2 gap-1.5">
            <button
              className="border border-[#c7c7cc] bg-white px-2 py-2 font-bold disabled:opacity-40"
              disabled={checking}
              onClick={() => finish(false)}
              type="button"
            >
              Cancel
            </button>
            <button
              className="border border-[#4533ff] bg-[#4533ff] px-2 py-2 font-bold text-white disabled:opacity-40"
              disabled={checking || pin.length < 4}
              onClick={() => void submit()}
              type="button"
            >
              Approve
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
