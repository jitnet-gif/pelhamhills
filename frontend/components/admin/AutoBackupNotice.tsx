"use client";

/** 로그인 자동 백업(`lib/backupAuto.ts`)이 도는 동안과 끝난 뒤 화면 구석에 한 줄. 닫으면 사라진다. */

import Link from "next/link";
import { useState } from "react";

import { useAutoBackup } from "@/lib/backupAuto";
import { ADMIN_BACKUP } from "@/lib/nav";

export default function AutoBackupNotice({ email }: { email: string }) {
  const state = useAutoBackup(email);
  const [closed, setClosed] = useState<string | null>(null);

  if (state.phase === "idle" || closed === state.phase) return null;

  const tone = state.phase === "failed" ? "border-[#e2a5a5] text-[#8a1f1f]" : "border-[#d4d4d8] text-[#1f2328]";
  return (
    <div
      className={`fixed bottom-20 left-4 z-[55] flex max-w-[calc(100vw-2rem)] items-center gap-3 border bg-white px-3 py-2 text-sm shadow-lg lg:bottom-4 ${tone}`}
      role="status"
    >
      <span>
        {state.phase === "running" ? (
          <>
            Backing up club data… {state.total ? `${state.done}/${state.total}` : ""}
          </>
        ) : state.phase === "done" ? (
          <>
            Backup saved: <b>{state.where}</b> ({state.rows.toLocaleString()} rows)
          </>
        ) : (
          <>
            Automatic backup failed: {state.message}{" "}
            <Link className="font-bold underline" href={ADMIN_BACKUP}>
              Data Backup
            </Link>
          </>
        )}
      </span>
      {state.phase === "running" ? null : (
        <button aria-label="Close" className="font-bold text-[#6b7280]" onClick={() => setClosed(state.phase)} type="button">
          ×
        </button>
      )}
    </div>
  );
}
