"use client";

/**
 * 고객용 예약 사이트(`/book/*`)의 껍데기.
 *
 * 어드민 껍데기(`components/admin/AdminShell.tsx`)와 **일부러** 공유하지 않는다.
 * 직원용 사이드바에는 13개 메뉴와 리포트가 걸려 있는데, 휴대폰으로 티타임 하나
 * 잡으러 온 손님에게 그건 남의 집 서랍을 여는 화면이다. 여기 있는 것은 세 개뿐이다 —
 * 티타임 / 실내 골프 / 내 예약 조회.
 *
 * ## 왜 하단 탭 + 상단 탭 양쪽인가
 * 손님은 대부분 휴대폰으로 온다. `hidden lg:block` 짜리 내비게이션만 두면 좁은
 * 화면에서 화면을 옮길 방법이 사라진다(어드민이 실제로 그랬다). 그래서 모바일은
 * 고정 하단 탭, 데스크톱은 헤더 탭이고 **둘 중 하나는 항상 보인다.**
 *
 * ## 왜 전화번호가 껍데기에 박혀 있나
 * 온라인 예약은 막힐 수 있다 — 백엔드가 없는 배포, 네트워크 끊김, 만석.
 * 그때 손님에게 남는 유일한 탈출구가 전화다. 각 화면이 알아서 넣기를 기대하면
 * 반드시 한 화면이 빠지므로 껍데기가 책임진다.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import SiteNoticePopup from "@/components/site/SiteNoticePopup";
import { useMemberSession } from "@/lib/booking/memberSession";
import { BOOK_HOME, BOOK_LOGIN, CLUB, SITE_HOME, bookNav, isActive } from "@/lib/nav";

type Props = {
  /** 헤더에 찍히는 현재 화면 이름. */
  title: string;
  /** 제목 아래 한 줄 설명. 없으면 렌더하지 않는다. */
  subtitle?: string;
  children: ReactNode;
};

export default function BookingShell({ title, subtitle, children }: Props) {
  const pathname = usePathname();
  const onHub = isActive(pathname, BOOK_HOME);
  const member = useMemberSession();

  return (
    <div className="min-h-dvh bg-[#f7f4ed] text-[#182118]">
      {/* 직원이 `/admin/notices` 에 올린 공지(0060). 결제 화면에서는 스스로 쉰다. */}
      <SiteNoticePopup surface="book" />
      <header className="sticky top-0 z-30 border-b border-[#d8d1c3] bg-[#f7f4ed]/95 backdrop-blur">
        <div className="mx-auto flex min-w-0 max-w-5xl items-center gap-3 px-4 py-3 lg:px-8">
          {/* 뒤로 가기: 허브에서는 공개 사이트로, 하위 화면에서는 허브로.
              브라우저 뒤로 가기에 기대지 않는다 — 예약 링크를 문자로 받아 바로
              열면 히스토리가 비어 있어서 뒤로 갈 곳이 없다. */}
          <Link
            aria-label={onHub ? "Back to the main site" : "Back to booking"}
            className="tap-target -ml-2 flex items-center justify-center rounded-sm px-2 text-lg text-[#214d2f] transition hover:bg-[#ece7da]"
            href={onHub ? SITE_HOME : BOOK_HOME}
          >
            <span aria-hidden>←</span>
          </Link>

          <Link
            className="flex min-h-11 min-w-0 items-center truncate font-serif text-lg font-semibold tracking-[0.06em]"
            href={SITE_HOME}
          >
            {CLUB.shortName}
          </Link>

          <nav aria-label="Booking" className="ml-auto hidden lg:block">
            <ul className="flex items-center gap-1">
              {bookNav.map((item) => {
                const active = isActive(pathname, item.href);
                return (
                  <li key={item.href}>
                    <Link
                      aria-current={active ? "page" : undefined}
                      className={`flex items-center gap-2 rounded-sm px-3 py-2 text-sm font-semibold transition ${
                        active
                          ? "bg-[#214d2f] text-white"
                          : "text-[#3d453d] hover:bg-[#ece7da]"
                      }`}
                      href={item.href}
                    >
                      <span aria-hidden>{item.glyph}</span>
                      {item.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>

          {/* 회원 로그인(0111). 탭이 아니라 여기 둔다 — 손님 대부분은 로그인 없이 예약한다. */}
          <Link
            className="tap-target ml-auto flex min-w-0 max-w-[10rem] items-center rounded-sm border border-[#d8d1c3] bg-white px-3 text-sm font-semibold text-[#214d2f] transition hover:bg-[#ece7da] lg:ml-3"
            href={BOOK_LOGIN}
          >
            <span className="truncate">{member ? member.member.name.split(/\s+/)[0] : "Member sign in"}</span>
          </Link>

          <a
            className="tap-target flex items-center rounded-sm bg-[#214d2f] px-3 text-sm font-bold text-white transition hover:bg-[#163820]"
            href={CLUB.phoneHref}
          >
            <span aria-hidden className="mr-1.5">☎</span>
            <span className="hidden sm:inline">Call</span>
            <span className="sm:hidden">Call</span>
          </a>
        </div>
      </header>

      {/* 하단 고정 탭이 마지막 줄을 덮지 않도록 모바일에서만 아래를 비워 둔다. */}
      <main className="mx-auto min-w-0 max-w-5xl px-4 pb-28 pt-6 lg:px-8 lg:pb-12">
        <h1 className="font-serif text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h1>
        {subtitle ? <p className="mt-1 text-sm text-[#5c6459]">{subtitle}</p> : null}
        <div className="mt-6 min-w-0">{children}</div>
      </main>

      {/* 전화 안내는 흐름 안에 둔다. 고정 탭 뒤로 숨으면 없는 것과 같다. */}
      <footer className="mx-auto max-w-5xl px-4 pb-28 text-sm text-[#5c6459] lg:px-8 lg:pb-10">
        <div className="rounded-sm border border-[#d8d1c3] bg-white p-4">
          <p className="font-semibold text-[#182118]">Rather book by phone?</p>
          <p className="mt-1">
            Call the pro shop at{" "}
            <a className="font-semibold text-[#214d2f] underline" href={CLUB.phoneHref}>
              {CLUB.phone}
            </a>
            .
          </p>
          <p className="mt-2 text-[#8a6f30]">{CLUB.address}</p>
        </div>

        {/* 공개 사이트로 나가는 출구. 헤더의 클럽 이름도 같은 곳으로 가지만 제목처럼
            생겨서 링크인 줄 모르는 손님이 있고, 뒤로 가기 화살표는 허브에서만 밖으로
            나간다. 그래서 스크롤 끝 — 하단 탭 바로 위 — 에 이름이 붙은 문을 하나 둔다.
            고정 탭이 아니라 흐름 안에 있으므로 탭이 없는 데스크톱에서도 그대로 남고,
            푸터가 이미 갖고 있는 `pb-28` 여백을 물려받아 탭에 가리지 않는다. */}
        <Link
          className="tap-target mt-4 flex items-center justify-center gap-2 rounded-sm border border-[#d8d1c3] bg-white px-4 text-sm font-semibold text-[#214d2f] transition hover:bg-[#ece7da]"
          href={SITE_HOME}
        >
          <span aria-hidden>←</span>
          Back to {CLUB.shortName}
        </Link>
      </footer>

      <nav
        aria-label="Booking"
        className="pb-safe fixed inset-x-0 bottom-0 z-30 border-t border-[#d8d1c3] bg-[#f7f4ed]/97 backdrop-blur lg:hidden"
      >
        <ul className="grid grid-cols-3">
          {bookNav.map((item) => {
            const active = isActive(pathname, item.href);
            return (
              <li key={item.href} className="min-w-0">
                <Link
                  aria-current={active ? "page" : undefined}
                  className={`tap-target flex h-full flex-col items-center justify-center gap-0.5 px-1 py-2 text-[11px] font-semibold transition ${
                    active ? "text-[#214d2f]" : "text-[#5c6459]"
                  }`}
                  href={item.href}
                >
                  <span aria-hidden className="text-base leading-none">
                    {item.glyph}
                  </span>
                  <span className="truncate">{item.label}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
}
