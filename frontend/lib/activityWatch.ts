/**
 * 지켜보는 계정 알림 — proshop@ 이 어드민·계산대 화면을 열거나 파일을 내려받으면 서버가 analysis@ 와
 * jitnet57@gmail.com 에 메일을 보낸다(`backend/api/routes/activity_alert.py`, 2026-10-24).
 *
 * 누구를 지켜볼지는 서버가 토큰의 이메일로 다시 정한다. 여기의 명단은 다른 계정이 쓸데없이 서버를 부르지 않게 할 뿐이다.
 * 같은 화면을 새로 고치거나 오가며 여러 번 열어도 5분에 한 통만 — 메일함이 넘치지 않게. 내려받기는 매번 보낸다.
 * 알림이 실패해도 화면은 그대로 쓴다.
 */

import { paymentsApiBase } from "@/lib/booking/payments";
import { accessToken, getSession } from "@/lib/teeSheet/session";

const WATCHED = new Set(["proshop@pelhamhills.ca"]);
const VIEW_GAP_MS = 5 * 60_000;
const SEEN_KEY = "pelham.activity.seen.";

export function isWatched(email: string | null | undefined): boolean {
  return !!email && WATCHED.has(email.trim().toLowerCase());
}

async function post(kind: "view" | "download", path: string, title: string, detail: string): Promise<void> {
  try {
    const token = await accessToken();
    if (!token) return;
    await fetch(`${paymentsApiBase()}/staff/activity`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ kind, path: path.slice(0, 300), title: title.slice(0, 200), detail: detail.slice(0, 300) }),
      keepalive: true,
    });
  } catch {}
}

function recentlySeen(path: string): boolean {
  try {
    const at = Number(window.sessionStorage.getItem(SEEN_KEY + path) || 0);
    if (Date.now() - at < VIEW_GAP_MS) return true;
    window.sessionStorage.setItem(SEEN_KEY + path, String(Date.now()));
  } catch {}
  return false;
}

/** AdminShell 이 화면이 바뀔 때마다 부른다. */
export function reportView(email: string, path: string, title: string): void {
  if (!isWatched(email) || recentlySeen(path)) return;
  void post("view", path, title, "");
}

/** 파일을 내려받을 때 부른다(`downloadBlob`, 백업 ZIP). 로그인한 계정을 스스로 본다. */
export function reportDownload(filename: string): void {
  try {
    if (!isWatched(getSession()?.email)) return;
  } catch {
    return;
  }
  void post("download", window.location.pathname, document.title, filename);
}
