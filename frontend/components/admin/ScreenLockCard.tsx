"use client";

/**
 * Settings 의 화면 잠금 시간 — 매니저와 계정 관리자에게만 보인다(0143). 막는 것은 서버다.
 * 고를 수 있는 시간은 아래 목록이고, SQL 로 넣은 다른 값이면 그 값도 목록에 더해 보여 준다.
 */

import { useEffect, useState } from "react";

import { useBackupAccess } from "@/lib/backup";
import { idleLockMs, saveIdleLockSeconds } from "@/lib/staffPin";
import { getSession } from "@/lib/teeSheet/session";

const CHOICES = [60, 120, 180, 300, 600, 900, 1800, 3600];

function choiceLabel(seconds: number): string {
  if (seconds === 0) return "Don't lock";
  if (seconds % 60 !== 0) return `${seconds} seconds`;
  return seconds === 60 ? "1 minute" : `${seconds / 60} minutes`;
}

export default function ScreenLockCard() {
  const allowed = useBackupAccess(getSession()?.email ?? "");
  const [saved, setSaved] = useState<number | null>(null);
  const [seconds, setSeconds] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    if (allowed !== true) return;
    let cancelled = false;
    void idleLockMs().then((ms) => {
      if (cancelled) return;
      const value = Math.round(ms / 1000);
      setSaved(value);
      setSeconds(value);
    });
    return () => {
      cancelled = true;
    };
  }, [allowed]);

  if (allowed !== true || seconds === null) return null;

  const save = async () => {
    setSaving(true);
    setNotice("");
    try {
      const value = await saveIdleLockSeconds(seconds);
      setSaved(value);
      setSeconds(value);
      setNotice("Saved. Other screens follow the next time they open.");
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : "Could not save. Try again.");
    } finally {
      setSaving(false);
    }
  };

  const choices = [...new Set([0, ...CHOICES, seconds, ...(saved === null ? [] : [saved])])].sort(
    (a, b) => a - b,
  );

  return (
    <section className="border border-[#d6d6dc] bg-white xl:col-span-2">
      <div className="border-b border-[#d6d6dc] bg-[#d7d5da] px-3 py-2 text-xs font-bold">Screen Lock</div>
      <div className="grid gap-3 p-4 text-xs">
        <p className="leading-5 text-[#6b7280]">
          Admin screens lock when nobody touches them for this long. Staff open them again with their staff ID.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <label className="font-bold">
            Lock after
            <select
              className="mt-1 block border border-[#d6d6dc] bg-white px-3 py-2 font-normal"
              onChange={(event) => {
                setSeconds(Number(event.target.value));
                setNotice("");
              }}
              value={seconds}
            >
              {choices.map((value) => (
                <option key={value} value={value}>
                  {choiceLabel(value)}
                </option>
              ))}
            </select>
          </label>
          <button
            className="tap-target bg-[#4533ff] px-5 py-2 text-xs font-bold text-white disabled:opacity-50"
            disabled={saving || seconds === saved}
            onClick={() => void save()}
            type="button"
          >
            {saving ? "Saving…" : "Save lock time"}
          </button>
        </div>
        {seconds === 0 ? <p className="font-bold text-[#b42318]">Admin screens will stay open with nobody at them.</p> : null}
        {notice ? <p aria-live="polite" className="font-bold text-[#4e5560]">{notice}</p> : null}
      </div>
    </section>
  );
}
