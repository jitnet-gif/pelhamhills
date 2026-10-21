"use client";

/**
 * 손님 화면의 팝업 공지(0060). 공개 사이트는 `SiteHeader`, 예약 화면은 `BookingShell` 이 띄운다 —
 * 두 껍데기가 모든 장에 붙어 있어서 장마다 따로 넣을 필요가 없다.
 *
 * 공지가 여럿이면 한 창에서 넘겨 본다(코스 상황이 먼저 — 서버가 정렬한다). 닫으면 그 창에 뜬
 * 공지를 전부 "봤다" 로 적는다. 다시 뜨는 규칙은 공지마다 직원이 정한다(`lib/siteNotices.ts`).
 *
 * 서버가 안 되면 **조용히 아무것도 띄우지 않는다.** 팝업 때문에 예약 화면이 깨지면 안 된다.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import {
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
    notices.forEach(rememberDismissed);
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
    // close 는 notices 를 읽는다 — 공지가 바뀌면 다시 건다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, notices]);

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
        <NoticeCard notice={notice} onClose={close} onLink={close} titleId="site-notice-title">
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
  titleId,
  children,
}: {
  notice: Pick<PublicNotice, "kind" | "title" | "body" | "image_url" | "link_url" | "link_label">;
  onClose?: () => void;
  onLink?: () => void;
  titleId?: string;
  children?: React.ReactNode;
}) {
  const accent = ACCENT[notice.kind];
  const internal = notice.link_url?.startsWith("/");

  return (
    <div className="max-h-[90dvh] overflow-y-auto bg-[#fbf9f4] text-[#182118] shadow-2xl sm:rounded-sm">
      <div className={`h-1.5 ${accent.band}`} />
      {notice.image_url ? (
        // 직원이 붙인 임의 주소라 next/image 의 도메인 목록에 넣을 수 없다.
        // eslint-disable-next-line @next/next/no-img-element
        <img alt="" className="max-h-56 w-full object-cover" src={notice.image_url} />
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
              Got it
            </button>
          ) : null}
        </div>
      </div>
      {children}
    </div>
  );
}
