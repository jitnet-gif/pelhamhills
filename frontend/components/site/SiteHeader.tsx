"use client";

/**
 * 공개 사이트(pelhamhills.com 형태)의 상단 헤더.
 *
 * ## 왜 클라이언트 컴포넌트인가
 *
 * 홈(`app/page.tsx`)은 문구와 이미지뿐이라 서버 컴포넌트로 두는 편이 낫다.
 * 상태가 필요한 곳은 햄버거 메뉴 하나뿐이므로, 페이지 전체에 `"use client"` 를
 * 붙이는 대신 이 껍데기만 클라이언트로 떼어 낸다.
 *
 * ## 왜 모바일 메뉴가 필요한가
 *
 * 예전 헤더의 메뉴는 `hidden md:flex` 였다. 즉 **폭 768px 미만에서는 Golf/Pub/
 * Indoor/Visit 이 통째로 사라지고** "Book Now" 버튼만 남았다. 휴대폰으로 온
 * 방문자에게는 클럽 소개를 볼 방법이 없는 사이트였던 셈이다. 이 컴포넌트가
 * 그 구멍을 메운다. (같은 문제를 어드민에서 먼저 겪었다 — `AdminShell` 의 서랍)
 *
 * ## 높이를 못박은 이유
 *
 * 헤더는 `h-14 sm:h-[72px]` 로 높이가 고정이다. 히어로가
 * `calc(100dvh - 헤더높이)` 로 첫 화면을 정확히 채우기 때문에, 헤더가 내용에
 * 따라 늘었다 줄었다 하면 히어로 아래에 정체불명의 여백이 생기거나 스크롤이
 * 생긴다. 예전 코드는 `calc(100vh-73px)` 를 썼는데 73px 은 데스크톱 기준이라
 * 모바일에서는 어긋나 있었다. 값을 바꾸려면 `app/page.tsx` 의 히어로도 같이 고쳐라.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type MouseEvent } from "react";

import { BOOK_INDOOR, BOOK_TEE_TIME, CLUB, SITE_HOME, siteNav } from "@/lib/nav";

/** 헤더의 "Book Now" 는 티타임 예약으로 보낸다. 실내 골프는 히어로 아래 CTA 밴드와 푸터에 있다. */

export default function SiteHeader() {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);

  // 다른 화면(예: /book)으로 넘어가면 메뉴는 닫힌다. 닫지 않으면 새 화면 위에
  // 이전 메뉴가 그대로 덮여 있어서 방금 고른 화면을 볼 수 없다.
  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  // 패널이 열려 있는 동안 뒤쪽 본문이 스크롤되면(iOS 의 scroll chaining) 닫았을 때
  // 엉뚱한 위치에 가 있게 된다. 열려 있는 동안만 body 를 묶는다.
  useEffect(() => {
    if (!menuOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [menuOpen]);

  // Esc 로 닫기. 전체화면 패널은 모달이므로 키보드만 쓰는 사용자에게도 탈출구가 있어야 한다.
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  /**
   * 패널 안의 앵커(`/#golf`)를 눌렀을 때.
   *
   * 그냥 링크에 맡기면 안 되는 이유: React 의 passive effect 정리(= body 의
   * overflow 잠금 해제)는 클릭 핸들러 안에서 동기적으로 실행되지 않는다.
   * 그래서 브라우저가 앵커로 점프하는 시점에 body 가 아직 잠겨 있고, 그 이동이
   * 그대로 버려진다 — 패널만 닫히고 화면은 제자리인 것처럼 보인다.
   * 잠금을 여기서 먼저 풀고 직접 스크롤한다(정리 함수가 나중에 쓰는 값과 같다).
   */
  const handleAnchorClick = (event: MouseEvent<HTMLAnchorElement>, href: string) => {
    setMenuOpen(false);
    if (!href.startsWith("/#")) return; // 진짜 페이지 이동은 라우터에 맡긴다
    // 홈이 아닌 장(`/memberships`, `/golf/rates` …)에는 그 섹션이 없다. 여기서 막으면
    // 아무 일도 안 일어나므로, 브라우저가 홈으로 넘어가 앵커로 점프하게 둔다.
    const target = document.querySelector(href.slice(1));
    if (!target) return;
    event.preventDefault();
    document.body.style.overflow = "";
    // 섹션마다 `scroll-mt-*` 가 걸려 있어서 sticky 헤더에 제목이 가리지 않는다.
    target.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    // 패널은 `<header>` **밖**에 있어야 한다. `backdrop-blur`(backdrop-filter)가
    // 걸린 요소는 fixed 자손의 containing block 이 되어 버려서, 헤더 안에 두면
    // `fixed inset-0` 이 뷰포트가 아니라 56px 짜리 헤더 상자에 갇힌다.
    <>
      <header className="sticky top-0 z-30 border-b border-[#d8d1c3] bg-[#f7f4ed]/92 backdrop-blur">
        <nav
          aria-label="Main"
          className="mx-auto flex h-14 max-w-7xl items-center justify-between gap-3 px-4 sm:h-[72px] sm:px-5 lg:px-8"
        >
          <Link
            className="flex min-h-11 shrink-0 items-center font-serif text-lg font-semibold tracking-[0.08em] sm:text-xl"
            href={SITE_HOME}
          >
            {CLUB.shortName}
          </Link>

          <div className="hidden items-center gap-7 text-sm font-semibold tracking-[0.14em] text-[#465444] uppercase md:flex">
            {/* 데스크톱 메뉴도 모바일 패널과 **같은** 핸들러를 쓴다. 같은 문서
                안의 프래그먼트로 가는 App Router 의 `<Link>` 이동은 두 번째
                클릭부터 맨 위로 튀는 등 동작이 일정하지 않다. 앵커 점프는 한
                가지 방식으로만 처리한다(핸들러는 앵커가 아니면 그냥 빠진다). */}
            {siteNav.map((item) => (
              <a
                className="transition hover:text-[#214d2f]"
                href={item.href}
                key={item.href}
                onClick={(event) => handleAnchorClick(event, item.href)}
              >
                {item.label}
              </a>
            ))}
          </div>

          <div className="flex shrink-0 items-center gap-1 sm:gap-2">
            <Link
              className="flex min-h-11 items-center rounded-sm bg-[#214d2f] px-3 text-xs font-bold whitespace-nowrap text-white shadow-sm transition hover:bg-[#163820] sm:px-4 sm:text-sm"
              href={BOOK_TEE_TIME}
            >
              Book Now
            </Link>

            {/* 44×44 는 손가락으로 눌러서 빗나가지 않는 최소 과녁이다. */}
            <button
              aria-controls="site-mobile-menu"
              aria-expanded={menuOpen}
              aria-label="Open menu"
              className="-mr-2 flex h-11 w-11 items-center justify-center text-2xl leading-none text-[#214d2f] md:hidden"
              onClick={() => setMenuOpen(true)}
              type="button"
            >
              <span aria-hidden>☰</span>
            </button>
          </div>
        </nav>
      </header>

      {menuOpen ? (
        <MobileMenu
          onAnchorClick={handleAnchorClick}
          onClose={() => setMenuOpen(false)}
        />
      ) : null}
    </>
  );
}

// ===== 모바일 전체화면 메뉴 =============================================

function MobileMenu({
  onClose,
  onAnchorClick,
}: {
  onClose: () => void;
  onAnchorClick: (event: MouseEvent<HTMLAnchorElement>, href: string) => void;
}) {
  return (
    // 서랍이 아니라 전체화면인 이유: 공개 사이트의 메뉴는 4개뿐이라 서랍으로
    // 좁히면 화면의 절반이 의미 없는 어두운 뒷배경이 된다. 크게 눌러 크게 이동한다.
    // pt-safe/pb-safe: layout 이 viewport-fit=cover + black-translucent 상태
    // 표시줄을 쓰기 때문에 fixed 요소는 노치와 홈 인디케이터 **밑까지** 그려진다.
    // 그대로 두면 닫기 버튼이 시계에 가려 패널에서 빠져나갈 수 없고, 맨 아래
    // 전화번호가 홈 인디케이터에 가려 눌리지 않는다.
    <div
      className="pt-safe pb-safe fixed inset-0 z-50 flex flex-col overflow-y-auto bg-[#f7f4ed] text-[#182118] md:hidden"
      id="site-mobile-menu"
    >
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-[#d8d1c3] px-4">
        <span className="font-serif text-lg font-semibold tracking-[0.08em]">{CLUB.shortName}</span>
        <button
          aria-label="Close menu"
          className="-mr-2 flex h-11 w-11 items-center justify-center text-2xl leading-none text-[#214d2f]"
          onClick={onClose}
          type="button"
        >
          <span aria-hidden>×</span>
        </button>
      </div>

      <nav aria-label="Site sections" className="grid content-start px-4">
        {siteNav.map((item) => (
          <a
            className="flex items-center gap-4 border-b border-[#d8d1c3] py-5 font-serif text-2xl font-semibold active:bg-[#ebe5d7]"
            href={item.href}
            key={item.href}
            onClick={(event) => onAnchorClick(event, item.href)}
          >
            <span aria-hidden className="w-6 text-center text-xl text-[#8a6f30]">
              {item.glyph}
            </span>
            {item.label}
          </a>
        ))}
      </nav>

      <div className="grid gap-3 px-4 py-6">
        <Link
          className="rounded-sm bg-[#214d2f] px-5 py-4 text-center text-sm font-extrabold tracking-[0.12em] text-white uppercase"
          href={BOOK_TEE_TIME}
          onClick={onClose}
        >
          Book a Tee-Time
        </Link>
        <Link
          className="rounded-sm border border-[#214d2f] px-5 py-4 text-center text-sm font-extrabold tracking-[0.12em] text-[#214d2f] uppercase"
          href={BOOK_INDOOR}
          onClick={onClose}
        >
          Reserve Indoor Golf
        </Link>
      </div>

      {/* 메뉴를 열었는데 원하는 항목이 없을 때의 마지막 착지점. 골프장에 오는
          사람의 절반은 결국 전화를 건다. */}
      <div className="mt-auto border-t border-[#d8d1c3] px-4 py-5 text-sm leading-7 text-[#516050]">
        <p>{CLUB.address}</p>
        <a className="font-bold text-[#214d2f]" href={CLUB.phoneHref}>
          {CLUB.phone}
        </a>
      </div>
    </div>
  );
}
