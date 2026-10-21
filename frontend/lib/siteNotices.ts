/**
 * 웹사이트 팝업 공지·프로모션(0060).
 * 함수 이름과 인자는 `supabase/migrations/0060_site_notices.sql` 와 글자 그대로 같다.
 *
 * 손님 화면(`components/site/SiteNoticePopup.tsx`)은 공개 키로 `pelham_site_notices_now` 만 부르고,
 * 직원 화면(`/admin/notices`)은 로그인 토큰으로 `pelham_staff_site_notice*` 를 부른다.
 * 닫은 기록은 손님 브라우저에만 남긴다 — 서버는 누가 무엇을 닫았는지 모른다.
 *
 * ## 언제 다시 뜨는가(2026-10-21 클럽 결정)
 * 그냥 닫으면(× · Close) **다음 장을 열 때 또 뜬다.** 손님이 창 안의 "Don't show …" 칸에 체크하고
 * 닫았을 때만 기억한다. 무엇을 기억할지는 공지의 `repeat` 가 정한다:
 *   once        — "Don't show this again": 그 공지가 고쳐질 때까지 안 뜬다.
 *   daily       — "Don't show again today": 오늘만 안 뜬다.
 *   every_visit — 체크 칸이 없다. 늘 뜬다(휴장 같은 꼭 봐야 하는 안내).
 */

import { bookingRpc } from "@/lib/booking/rpc";
import { ApiError } from "@/lib/teeSheet/api";
import { PUBLISHABLE_KEY, SUPABASE_URL, accessToken } from "@/lib/teeSheet/session";
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

/** 직원 편집기의 "Don't show again" 선택지. */
export const REPEAT_LABEL: Record<NoticeRepeat, string> = {
  once: "Box: “Don't show this again”",
  daily: "Box: “Don't show again today”",
  every_visit: "No box — always shows",
};

/** 손님 창의 체크 칸 문구. 없으면 칸을 그리지 않는다. */
export const DONT_SHOW_LABEL: Record<NoticeRepeat, string | null> = {
  once: "Don't show this again",
  daily: "Don't show again today",
  every_visit: null,
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

/** 이 손님이 "다시 보지 않기" 를 체크하고 닫았는가. 저장소가 막힌 브라우저(사생활 모드 등)에서는 늘 "아니오". */
export function wasDismissed(notice: PublicNotice): boolean {
  if (!DONT_SHOW_LABEL[notice.repeat]) return false;
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

/** 체크 칸을 누르고 닫았을 때만 부른다. */
export function rememberDismissed(notice: PublicNotice): void {
  if (!DONT_SHOW_LABEL[notice.repeat]) return;
  try {
    localStorage.setItem(DISMISS_PREFIX + notice.id, `${notice.version}|${today()}`);
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

// ===== 이미지 올리기(0061) ================================================

const IMAGE_BUCKET = "site-images";
/** 팝업 폭은 최대 448px 이라 레티나에서도 이 정도면 충분하다. 휴대폰 원본(4000px·5MB)을 그대로 올리면 손님이 기다린다. */
const IMAGE_MAX_PX = 1600;
const IMAGE_MAX_BYTES = 5 * 1024 * 1024;

/** 큰 사진을 줄인다. GIF 는 움직임이 사라지므로 그대로 둔다. */
async function shrink(file: File): Promise<Blob> {
  if (file.type === "image/gif") return file;
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, IMAGE_MAX_PX / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && file.size <= 1.5 * 1024 * 1024) {
    bitmap.close();
    return file;
  }
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", 0.85));
  return blob ?? file;
}

/** 직원이 고른 그림을 올리고 손님이 읽을 공개 주소를 돌려준다. */
export async function uploadSiteImage(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) throw new ApiError(422, "Choose a picture file (JPG, PNG, WebP or GIF).");
  const token = await accessToken();
  if (!token) throw new ApiError(401, "Sign in again to upload pictures.");

  const blob = await shrink(file);
  if (blob.size > IMAGE_MAX_BYTES) throw new ApiError(413, "That picture is over 5 MB. Choose a smaller one.");
  const ext = blob.type === "image/webp" ? "webp" : (file.name.split(".").pop() || "jpg").toLowerCase();
  const path = `notices/${new Date().toISOString().slice(0, 10)}-${crypto.randomUUID()}.${ext}`;

  let response: Response;
  try {
    response = await fetch(`${SUPABASE_URL}/storage/v1/object/${IMAGE_BUCKET}/${path}`, {
      method: "POST",
      headers: {
        apikey: PUBLISHABLE_KEY,
        Authorization: `Bearer ${token}`,
        "Content-Type": blob.type || file.type,
      },
      body: blob,
    });
  } catch {
    throw new ApiError(0, "Network error");
  }
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`.trim();
    try {
      const body = (await response.json()) as { message?: unknown; error?: unknown };
      if (typeof body?.message === "string" && body.message) message = body.message;
    } catch {
      // 본문이 JSON 이 아니면 상태 줄 그대로.
    }
    if (/bucket not found/i.test(message)) {
      message = "The picture store is missing — run migration 0061 in the Supabase SQL Editor.";
    } else if (/row-level security|unauthorized|403/i.test(message)) {
      message = "This account can't upload pictures. Sign in with a pro shop account (and check migration 0061).";
    }
    throw new ApiError(response.status, message);
  }
  return `${SUPABASE_URL}/storage/v1/object/public/${IMAGE_BUCKET}/${path}`;
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
