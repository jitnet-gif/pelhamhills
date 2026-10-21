/**
 * 웹사이트 팝업 공지·프로모션(0060).
 * 함수 이름과 인자는 `supabase/migrations/0060_site_notices.sql` 와 글자 그대로 같다.
 *
 * 손님 화면(`components/site/SiteNoticePopup.tsx`)은 공개 키로 `pelham_site_notices_now` 만 부르고,
 * 직원 화면(`/admin/notices`)은 로그인 토큰으로 `pelham_staff_site_notice*` 를 부른다.
 * 닫은 기록은 손님 브라우저에만 남긴다 — 서버는 누가 무엇을 닫았는지 모른다.
 */

import { bookingRpc } from "@/lib/booking/rpc";
import { ApiError } from "@/lib/teeSheet/api";
import { staffRpc } from "@/lib/teeSheet/staffRpc";

export type NoticeKind = "notice" | "alert" | "promotion";
export type NoticeSurface = "all" | "site" | "book";
export type NoticeRepeat = "once" | "daily" | "every_visit";

/** 손님에게 가는 모양. 직원 정보는 빠져 있다. */
export type PublicNotice = {
  id: string;
  kind: NoticeKind;
  title: string;
  body: string;
  image_url: string | null;
  link_url: string | null;
  link_label: string | null;
  repeat: NoticeRepeat;
  /** updated_at 의 epoch 초. 글이 고쳐지면 바뀌어서, 닫았던 손님에게도 다시 뜬다. */
  version: number;
};

export type SiteNotice = Omit<PublicNotice, "version"> & {
  surfaces: NoticeSurface;
  starts_at: string | null;
  ends_at: string | null;
  active: boolean;
  sort: number;
  created_at: string;
  updated_at: string;
  updated_by: string | null;
};

export type SiteNoticeInput = Partial<Omit<SiteNotice, "created_at" | "updated_at" | "updated_by">>;

export const siteNoticesApi = {
  /** 손님용. 실패해도 사이트는 그대로 보여야 하므로 부르는 쪽이 오류를 삼킨다. */
  now: (surface: Exclude<NoticeSurface, "all">) =>
    bookingRpc<PublicNotice[]>("pelham_site_notices_now", { p_surface: surface }),
  list: () => staffRpc<SiteNotice[]>("pelham_staff_site_notices"),
  save: (input: SiteNoticeInput) => staffRpc<SiteNotice>("pelham_staff_site_notice_save", { p: input }),
  remove: (id: string) => staffRpc<void>("pelham_staff_site_notice_delete", { p_id: id }),
};

export const KIND_LABEL: Record<NoticeKind, string> = {
  notice: "Notice",
  alert: "Course update",
  promotion: "Special offer",
};

export const SURFACE_LABEL: Record<NoticeSurface, string> = {
  all: "Website + booking",
  site: "Website only",
  book: "Booking pages only",
};

export const REPEAT_LABEL: Record<NoticeRepeat, string> = {
  once: "Once (until the pop-up is edited)",
  daily: "Once a day",
  every_visit: "Every visit",
};

export type NoticeState = "live" | "scheduled" | "ended" | "off";

/** 직원 목록의 상태 배지. 손님 화면이 실제로 띄우는지와 같은 규칙(서버의 `pelham_site_notices_now`). */
export function noticeState(row: SiteNotice, now = Date.now()): NoticeState {
  if (!row.active) return "off";
  if (row.ends_at && Date.parse(row.ends_at) <= now) return "ended";
  if (row.starts_at && Date.parse(row.starts_at) > now) return "scheduled";
  return "live";
}

// ===== 닫은 기록 (손님 브라우저) ===========================================

const DISMISS_PREFIX = "pelham-notice:";

function today(): string {
  return new Date().toLocaleDateString("en-CA");
}

/** 이 손님이 이 공지를 이미 닫았는가. 저장소가 막힌 브라우저(사생활 모드 등)에서는 늘 "아니오". */
export function wasDismissed(notice: PublicNotice): boolean {
  if (notice.repeat === "every_visit") {
    try {
      return sessionStorage.getItem(DISMISS_PREFIX + notice.id) === String(notice.version);
    } catch {
      return false;
    }
  }
  try {
    const saved = localStorage.getItem(DISMISS_PREFIX + notice.id);
    if (!saved) return false;
    const [version, day] = saved.split("|");
    if (version !== String(notice.version)) return false;
    return notice.repeat === "once" || day === today();
  } catch {
    return false;
  }
}

export function rememberDismissed(notice: PublicNotice): void {
  try {
    if (notice.repeat === "every_visit") {
      // 창(탭)을 새로 열 때까지만 — 같은 방문 안에서 장을 넘길 때마다 뜨면 쓸 수가 없다.
      sessionStorage.setItem(DISMISS_PREFIX + notice.id, String(notice.version));
    } else {
      localStorage.setItem(DISMISS_PREFIX + notice.id, `${notice.version}|${today()}`);
    }
  } catch {
    // 저장소가 막혀 있으면 다음 장에서 다시 뜬다. 막을 방법이 없다.
  }
}

// ===== 시각 입력 ==========================================================
// `<input type="datetime-local">` 은 시간대 없는 "2026-10-21T09:30" 을 주고받는다. 직원 기기는
// 클럽(온타리오)에 있으므로 기기의 현지 시각으로 읽고 쓴다.

export function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromLocalInput(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** 오늘 hh:mm (기기 현지)을 입력칸 값으로. 서리 지연 템플릿의 기본 종료 시각 등. */
export function todayAt(hours: number, minutes = 0): string {
  const d = new Date();
  d.setHours(hours, minutes, 0, 0);
  return toLocalInput(d.toISOString());
}

export function describeNoticeError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 0) return "Can't reach the server. Check the connection and try again.";
    if (error.status === 404 && /function|PGRST202|schema cache/i.test(error.message)) {
      return "Pop-up database functions are missing — run migration 0060 in the Supabase SQL Editor.";
    }
    return error.message;
  }
  return (error as Error)?.message ?? "Something went wrong.";
}
