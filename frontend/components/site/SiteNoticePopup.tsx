"use client";

/**
 * 손님 화면의 팝업 공지(0060). 공개 사이트는 `SiteHeader`, 예약 화면은 `BookingShell` 이 띄운다 —
 * 두 껍데기가 모든 장에 붙어 있어서 장마다 따로 넣을 필요가 없다.
 *
 * 공지가 여럿이면 한 창에서 넘겨 본다(코스 상황이 먼저 — 서버가 정렬한다). 그냥 닫으면 다음 장에서
 * 또 뜬다. 공지마다 있는 "Don't show …" 칸에 체크한 것만 기억한다(`lib/siteNotices.ts` 머리 주석).
 *
 * 서버가 안 되면 **조용히 아무것도 띄우지 않는다.** 팝업 때문에 예약 화면이 깨지면 안 된다.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import {
  DONT_SHOW_LABEL,
  KIND_LABEL,
  rememberDismissed,
  siteNoticesApi,
  wasDismissed,
  type NoticeKind,
  type PublicNotice,
} from "@/lib/siteNotices";

/** 결제 중에는 띄우지 않는다 — 카드 입력 위에 창이 덮이면 결제를 포기한다. */
const QUIET_PATHS = ["/book/pay"];

export default function SiteNoticePopup({ surface }: { surface: "site" | "book" }) {
  const pathname = usePathname();
  const [notices, setNotices] = useState<PublicNotice[]>([]);
  const [index, setIndex] = useState(0);
  /** "다시 보지 않기" 에 체크한 공지 id. 닫을 때 이것만 기억한다. */
  const [checked, setChecked] = useState<Set<string>>(() => new Set());

  const quiet = QUIET_PATHS.some((path) => pathname?.startsWith(path));

  useEffect(() => {
    if (quiet) return;
    let cancelled = false;
    siteNoticesApi
      .now(surface)
      .then((rows) => {
        if (cancelled || !Array.isArray(rows)) return;
        setNotices(rows.filter((row) => !wasDismissed(row)));
        setIndex(0);
      })
      .catch(() => {
        // 위 머리 주석 — 팝업은 없어도 되는 것이다.
      });
    return () => {
      cancelled = true;
    };
  }, [surface, quiet]);

  const open = notices.length > 0 && !quiet;

  const close = () => {
    notices.filter((row) => checked.has(row.id)).forEach(rememberDismissed);
    setNotices([]);
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
    // close 는 notices·checked 를 읽는다 — 바뀌면 다시 건다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, notices, checked]);

  if (!open) return null;
  const notice = notices[Math.min(index, notices.length - 1)];

  return (
    <div
      aria-labelledby="site-notice-title"
      aria-modal="true"
      className="fixed inset-0 z-[70] flex items-end justify-center p-0 sm:items-center sm:p-4"
      role="dialog"
    >
      <button aria-label="Close" className="absolute inset-0 bg-[#10170f]/60" onClick={close} type="button" />
      <div className="relative w-full max-w-md">
        <NoticeCard
          dontShow={{
            checked: checked.has(notice.id),
            onChange: (on) =>
              setChecked((current) => {
                const next = new Set(current);
                if (on) next.add(notice.id);
                else next.delete(notice.id);
                return next;
              }),
          }}
          notice={notice}
          onClose={close}
          onLink={close}
          titleId="site-notice-title"
        >
          {notices.length > 1 ? (
            <div className="flex items-center justify-between border-t border-[#e6e0d2] px-5 py-3 text-sm">
              <button
                className="min-h-11 px-2 font-bold text-[#214d2f] disabled:text-[#b8b2a4]"
                disabled={index === 0}
                onClick={() => setIndex((i) => i - 1)}
                type="button"
              >
                ‹ Prev
              </button>
              <span className="tabular-nums text-[#5c6459]">
                {index + 1} / {notices.length}
              </span>
              <button
                className="min-h-11 px-2 font-bold text-[#214d2f] disabled:text-[#b8b2a4]"
                disabled={index >= notices.length - 1}
                onClick={() => setIndex((i) => i + 1)}
                type="button"
              >
                Next ›
              </button>
            </div>
          ) : null}
        </NoticeCard>
      </div>
    </div>
  );
}

const ACCENT: Record<NoticeKind, { band: string; badge: string }> = {
  alert: { band: "bg-[#b45309]", badge: "bg-[#fff1dc] text-[#8a3f06]" },
  promotion: { band: "bg-[#b8892b]", badge: "bg-[#f8efd9] text-[#6d4f12]" },
  notice: { band: "bg-[#214d2f]", badge: "bg-[#e4eee5] text-[#214d2f]" },
};

/**
 * 공지 한 장. 손님 창과 직원 편집기의 미리 보기가 **같은 컴포넌트**를 쓴다 — 미리 보기와
 * 실제 창이 달라 보이면 미리 보기를 믿을 수 없다.
 */
export function NoticeCard({
  notice,
  onClose,
  onLink,
  dontShow,
  titleId,
  children,
}: {
  notice: Pick<PublicNotice, "kind" | "title" | "body" | "image_url" | "link_url" | "link_label" | "repeat">;
  onClose?: () => void;
  /** 체크 칸. 공지의 repeat 가 every_visit 면 문구가 없어서 그리지 않는다. */
  dontShow?: { checked: boolean; onChange: (checked: boolean) => void };
  onLink?: () => void;
  titleId?: string;
  children?: React.ReactNode;
}) {
  const accent = ACCENT[notice.kind];
  const internal = notice.link_url?.startsWith("/");
  const dontShowLabel = DONT_SHOW_LABEL[notice.repeat];

  return (
    <div className="max-h-[90dvh] overflow-y-auto bg-[#fbf9f4] text-[#182118] shadow-2xl sm:rounded-sm">
      <div className={`h-1.5 ${accent.band}`} />
      {notice.image_url ? (
        // 직원이 붙인 임의 주소라 next/image 의 도메인 목록에 넣을 수 없다.
        // 포스터는 글자가 잘리면 안 되므로 자르지 않고(contain) 화면 높이의 절반까지.
        // eslint-disable-next-line @next/next/no-img-element
        <img alt="" className="max-h-[45dvh] w-full bg-[#efeadf] object-contain" src={notice.image_url} />
      ) : null}
      <div className="relative px-5 pb-5 pt-4">
        {onClose ? (
          <button
            aria-label="Close"
            className="absolute right-2 top-2 flex h-11 w-11 items-center justify-center text-2xl leading-none text-[#5c6459] hover:text-[#182118]"
            onClick={onClose}
            type="button"
          >
            <span aria-hidden>×</span>
          </button>
        ) : null}
        <span className={`inline-block px-2 py-0.5 text-[11px] font-extrabold uppercase tracking-[0.12em] ${accent.badge}`}>
          {KIND_LABEL[notice.kind]}
        </span>
        <h2 className="mt-2 pr-8 font-serif text-2xl font-semibold leading-tight" id={titleId}>
          {notice.title || "Untitled"}
        </h2>
        {notice.body ? (
          <p className="mt-3 whitespace-pre-line break-words text-[15px] leading-6 text-[#3c463b]">{notice.body}</p>
        ) : null}
        <div className="mt-5 grid gap-2">
          {notice.link_url ? (
            internal ? (
              <Link
                className="rounded-sm bg-[#214d2f] px-5 py-3 text-center text-sm font-extrabold uppercase tracking-[0.12em] text-white"
                href={notice.link_url}
                onClick={onLink}
              >
                {notice.link_label || "Learn more"}
              </Link>
            ) : (
              <a
                className="rounded-sm bg-[#214d2f] px-5 py-3 text-center text-sm font-extrabold uppercase tracking-[0.12em] text-white"
                href={notice.link_url}
                onClick={onLink}
                rel="noopener noreferrer"
                target="_blank"
              >
                {notice.link_label || "Learn more"}
              </a>
            )
          ) : null}
          {onClose ? (
            <button
              className="min-h-11 rounded-sm border border-[#d8d1c3] px-5 text-sm font-bold text-[#3c463b] hover:bg-[#f1ede3]"
              onClick={onClose}
              type="button"
            >
              Close
            </button>
          ) : null}
        </div>
        {dontShow && dontShowLabel ? (
          <label className="mt-3 flex min-h-11 cursor-pointer items-center gap-2.5 text-sm text-[#3c463b]">
            <input
              checked={dontShow.checked}
              className="h-5 w-5 accent-[#214d2f]"
              onChange={(event) => dontShow.onChange(event.target.checked)}
              type="checkbox"
            />
            {dontShowLabel}
          </label>
        ) : null}
      </div>
      {children}
    </div>
  );
}
