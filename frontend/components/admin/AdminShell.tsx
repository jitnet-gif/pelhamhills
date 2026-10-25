"use client";

/**
 * 어드민 콘솔의 껍데기 — 데스크톱 사이드바 + 모바일 서랍/하단 탭.
 *
 * 예전에는 이 사이드바 마크업이 `AdminFeaturePage.tsx` 와 `app/teesheet/page.tsx`
 * 에 각각 복사되어 있었고, 둘 다 `hidden lg:block` 이었다. 즉 **폭 1024px 미만에서는
 * 어드민에 메뉴가 아예 없었다.** 티 시트를 열면 다른 화면으로 갈 방법이 없었고
 * 뒤로 가기가 유일한 탈출구였다. 휴대폰으로 프로 샵을 보는 사람에게는 메뉴 없는
 * 앱이었던 셈이다. 이 컴포넌트가 그 구멍을 메운다.
 *
 * ## 두 가지 높이 모드
 *
 * 어드민에는 성격이 다른 두 종류의 화면이 있다.
 *
 * - `fill`  — 티 시트처럼 **페이지가 스크롤되지 않고** 내부 격자만 스크롤하는 화면.
 * - 기본값 — 지표 카드와 표가 아래로 이어지는 보통의 문서형 화면.
 *
 * 하나로 합치려 하면 둘 중 하나가 깨진다. `fill` 에 문서형을 넣으면 내용이 잘리고,
 * 문서형에 `fill` 을 넣으면 티 시트가 내용 높이만큼 부풀어 페이지가 두 번 스크롤된다.
 * 그래서 호출부가 명시적으로 고른다.
 *
 * ## 로그인 문(2026-09-19)
 *
 * 프로 샵 화면은 전부 이 컴포넌트를 거친다. 예전에는 Fly.io 의 FastAPI 가 자기
 * 나름대로 막고 있었지만 그 서버는 꺼졌고, 지금 데이터는 Supabase 함수 뒤에 있다.
 * 그래서 문을 여기 둔다: **로그인 전에는 자식(`children`)을 아예 마운트하지 않는다.**
 * 숨기기만 하면 `useTeeSheet` 가 그대로 돌면서 예약을 불러오려 하고, 실패하면
 * 오프라인 샘플 데이터(손님 이름이 들어 있다)를 로그인도 하지 않은 화면에 깔아 버린다.
 *
 * 세션은 브라우저에만 있다 — 정적 export 라 쿠키를 심어 줄 서버가 없다.
 * 자세한 내용은 `lib/teeSheet/session.ts`.
 */

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";

import {
  ADMIN_ACCOUNTS,
  ADMIN_BACKUP,
  ADMIN_AI_MARKETING,
  ADMIN_CALLS,
  ADMIN_DYNAMIC_PRICING,
  ADMIN_EVENTS,
  ADMIN_HOME,
  ADMIN_MARKETING,
  ADMIN_PRICING,
  ADMIN_PROMOTIONS,
  ADMIN_REPORTS,
  CLUB,
  SITE_HOME,
  adminDivisions,
  adminQuickNav,
  divisionFor,
  isActive,
  type AdminDivision,
} from "@/lib/nav";
import InstallAppHint from "@/components/admin/InstallAppHint";
import LangToggle from "@/lib/i18n/LangToggle";
import { useAccountsAccess } from "@/lib/accounts";
import { useBackupAccess } from "@/lib/backup";
import { useAiMarketingAccess } from "@/lib/aiMarketing/access";
import { useMarketingAccess } from "@/lib/marketing/access";
import { useReportsAccess } from "@/lib/reports/access";
import { SCREENS, canOpen, useScreenAccess, type Screen } from "@/lib/screens";
import { ApiError } from "@/lib/teeSheet/api";
import { todayIso } from "@/lib/teeSheet/dates";
import { accessToken, getSession, signIn, signOut, subscribe } from "@/lib/teeSheet/session";
import { isStaffDenied, staffSlots } from "@/lib/teeSheet/staffRpc";

type Props = {
  /** 헤더에 굵게 찍히는 현재 화면 이름. */
  title: string;
  /** 제목 옆(모바일에서는 아래)에 놓을 버튼 등. */
  actions?: ReactNode;
  /**
   * true 면 본문이 남는 높이를 정확히 채우고 페이지 자체는 스크롤하지 않는다.
   * 티 시트처럼 내부에서만 스크롤하는 화면 전용. 위의 "두 가지 높이 모드" 참고.
   */
  fill?: boolean;
  /**
   * "pos" 면 관리자 메뉴 없이 계산대 머리 한 줄만 그린다. 설치형 계산대 앱(`/pos`) 전용 —
   * 그 앱의 범위(scope)는 `/pos` 라서, 어드민 메뉴로 나가면 앱 창에 주소 표시줄이 뜬다.
   */
  variant?: "admin" | "pos" | "starter";
  /**
   * Account Setup 의 화면 권한(0098)으로 여는 화면이면 그 이름. 권한이 없는 계정에는 본문 대신 이유만 보인다.
   * 주소로 바로 들어와도 같다 — 메뉴만 가리면 북마크로 열린다.
   */
  screen?: Screen;
  children: ReactNode;
};

/** 메뉴 항목 → 화면 권한. */
const SCREEN_OF_HREF: Record<string, Screen> = {
  [ADMIN_DYNAMIC_PRICING]: "dynamic_pricing",
  [ADMIN_EVENTS]: "events",
  [ADMIN_PROMOTIONS]: "promotions",
  [ADMIN_CALLS]: "calls",
};

/**
 * 문지기. 상태가 정해지기 전에는 아무것도 보여주지 않는다 — `localStorage` 는
 * 브라우저에서만 읽을 수 있고, 정적 export 의 프리렌더 HTML 과 첫 렌더가 어긋나면
 * hydration 이 깨지기 때문에 판단은 전부 effect 안에서 한다.
 */
export default function AdminShell(props: Props) {
  const gate = useStaffGate();

  if (gate.state === "checking") return <GateSplash />;
  if (gate.state === "out") return <SignInScreen onSignedIn={gate.recheck} />;
  if (gate.state === "denied") return <NotStaffScreen email={gate.email} onSignOut={gate.signOut} />;
  if (props.variant === "pos") return <PosFrame {...props} email={gate.email} onSignOut={gate.signOut} />;
  if (props.variant === "starter") return <StarterFrame {...props} onSignOut={gate.signOut} />;
  return <AdminFrame {...props} email={gate.email} onSignOut={gate.signOut} />;
}

/**
 * 1번 티 스타터 폰(`/teesheet/mobile`)의 껍데기. 한 손으로 쓰는 폰 화면이라 메뉴가 없다 — 제목, 한영 전환,
 * 로그아웃만. 햇빛 아래에서 보이도록 진한 초록 바탕에 흰 글자.
 */
function StarterFrame({ title, actions, children, onSignOut }: Props & { onSignOut: () => void }) {
  return (
    <div className="min-h-[100dvh] bg-[#f4f6f3] text-[#1f2328]">
      <header className="pt-safe bg-[#1e5a3f] text-white">
        <div className="flex items-center gap-2 px-3 py-2">
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-lg leading-tight font-bold">{title}</h1>
            <p className="text-[11px] text-white/75">{CLUB.shortName} · 1st tee</p>
          </div>
          <LangToggle className="flex min-h-11 items-center rounded-full border border-white/50 px-3 text-xs font-bold text-white" />
          <SignOutButton className="flex min-h-11 items-center px-2 text-xs font-bold text-white/80" onSignOut={onSignOut} />
        </div>
        {actions}
      </header>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** 계산대 앱에서 오갈 수 있는 곳. 이 둘 말고는 링크를 두지 않는다. */
const POS_STATIONS = [
  { href: "/pos/snack-bar", label: "Snack Bar" },
  { href: "/pos/pro-shop", label: "Pro Shop" },
] as const;

/**
 * 설치형 계산대 앱의 껍데기. 사이드바·하단 탭이 없다 — 카운터 태블릿에서 한 화면만
 * 띄워 두는 앱이라, 다른 화면으로 가는 길은 계산대 전환 두 개뿐이다.
 */
function PosFrame({
  title,
  actions,
  children,
  email,
  onSignOut,
}: Props & { email: string; onSignOut: () => void }) {
  const pathname = usePathname();
  return (
    <div className="min-h-[100dvh] bg-[#f2f2f4] text-[#1f2328]">
      <header className="pt-safe border-b border-[#d4d4d8] bg-[#111315] text-white">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2">
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-bold tracking-wide text-white/50 uppercase">{CLUB.shortName} POS</p>
            <h1 className="truncate text-sm font-bold">{title}</h1>
          </div>
          <nav aria-label="Register" className="flex shrink-0 gap-1">
            {POS_STATIONS.map((station) => {
              const active = isActive(pathname, station.href);
              return (
                <Link
                  aria-current={active ? "page" : undefined}
                  className={`inline-flex min-h-11 items-center px-3 text-sm font-bold ${
                    active ? "bg-[#4533ff] text-white" : "text-white/75 hover:bg-white/10"
                  }`}
                  href={station.href}
                  key={station.href}
                >
                  {station.label}
                </Link>
              );
            })}
          </nav>
          <LangToggle className="flex min-h-11 items-center px-2 text-[11px] text-white" />
          <span className="hidden max-w-[180px] shrink-0 truncate text-[11px] text-white/60 md:inline" title={email}>
            {email}
          </span>
          <SignOutButton
            className="flex min-h-11 shrink-0 items-center px-2 text-[11px] font-bold text-white/80"
            onSignOut={onSignOut}
          />
        </div>
        {actions ? (
          <div className="flex flex-wrap items-center gap-2 border-t border-white/10 bg-white px-3 py-2 text-[#1f2328]">
            {actions}
          </div>
        ) : null}
      </header>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function AdminFrame({
  title,
  actions,
  fill = false,
  screen,
  children,
  email,
  onSignOut,
}: Props & { email: string; onSignOut: () => void }) {
  const pathname = usePathname();
  const router = useRouter();
  const [drawerOpen, setDrawerOpen] = useState(false);
  // 데스크톱 사이드바 접기. 레퍼런스 상단바의 햄버거가 하는 일이 이것이다 —
  // 티 시트는 가로가 늘 모자란 화면이라 188px 을 회수할 수 있어야 한다.
  // 장식으로 두지 않는 이유: 눌러도 아무 일이 없는 버튼이 상단바 맨 왼쪽에 있으면
  // 사용자는 앱이 멈춘 줄 안다.
  const [railOpen, setRailOpen] = useState(true);
  // 사이드바에 펼쳐 둘 사업부. 기본은 지금 화면이 속한 곳이다. 드롭다운으로 사업부를
  // 고르면 그 사업부의 첫 화면(Golf → 티 시트, Snack Bar → 스낵바 메뉴, Indoor → Bay Sheet)
  // 으로 바로 간다 — 메뉴만 바뀌고 본문은 이전 사업부 화면으로 남아 있으면 헷갈린다.
  const [division, setDivision] = useState<AdminDivision>(() => divisionFor(pathname));
  const changeDivision = useCallback(
    (next: AdminDivision) => {
      setDivision(next);
      if (!isActive(pathname, next.home)) router.push(next.home);
    },
    [pathname, router],
  );
  // Reports 는 Emmeline 계정에만 보인다(`lib/reports/access.ts`). 다른 계정에는 메뉴에서 뺀다.
  const reportsAllowed = useReportsAccess(email) === true;
  // Tee Times & Pricing 도 매니저 = Reports 명단 계정에게만 보인다. Account Setup 의 Reports 체크로 켜고 끈다.
  // Account Setup 도 계정 관리자(0074)에게만 보인다(`lib/accounts.ts`).
  const accountsAllowed = useAccountsAccess(email) === true;
  // Data Backup 은 매니저와 계정 관리자에게만(0100, `lib/backup.ts`).
  const backupAllowed = useBackupAccess(email) === true;
  // Marketing 도 마케팅 명단(0047) 계정에만 보인다(`lib/marketing/access.ts`).
  const marketingAllowed = useMarketingAccess(email) === true;
  // AI Manager Marketing Strategies 는 매니저와 admin@ · proshop@ · analysis@ 에게만(0094, `lib/aiMarketing/access.ts`).
  const aiMarketingAllowed = useAiMarketingAccess(email) === true;
  // Dynamic Pricing · Events · Promotions · Calls & SMS 는 Account Setup 의 화면 체크(0098, `lib/screens.ts`).
  const screenAccess = useScreenAccess(email);
  const showHref = useCallback(
    (href: string) => {
      if (href === ADMIN_REPORTS || href === ADMIN_PRICING) return reportsAllowed;
      if (href === ADMIN_ACCOUNTS) return accountsAllowed;
      if (href === ADMIN_BACKUP) return backupAllowed;
      if (href === ADMIN_MARKETING) return marketingAllowed;
      if (href === ADMIN_AI_MARKETING) return aiMarketingAllowed;
      const needs = SCREEN_OF_HREF[href];
      return needs ? canOpen(screenAccess, needs, reportsAllowed) === true : true;
    },
    [reportsAllowed, accountsAllowed, backupAllowed, marketingAllowed, aiMarketingAllowed, screenAccess],
  );
  const shownDivision = useMemo(
    () => ({ ...division, links: division.links.filter((item) => showHref(item.href)) }),
    [division, showHref],
  );
  const screenOpen = screen ? canOpen(screenAccess, screen, reportsAllowed) : true;

  // 화면을 옮기면 서랍은 닫힌다. 닫지 않으면 새 화면 위에 이전 메뉴가 그대로
  // 덮여 있어서, 사용자가 방금 고른 화면을 볼 수 없다.
  useEffect(() => {
    setDrawerOpen(false);
    setDivision(divisionFor(pathname));
  }, [pathname]);

  // 서랍이 열려 있는 동안 뒤쪽 본문이 스크롤되면(iOS 의 scroll chaining) 서랍을
  // 닫았을 때 엉뚱한 위치에 가 있게 된다. 열려 있는 동안만 body 를 묶는다.
  useEffect(() => {
    if (!drawerOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [drawerOpen]);

  // Esc 로 닫기. 서랍은 모달이므로 키보드만 쓰는 사용자에게도 탈출구가 있어야 한다.
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDrawerOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawerOpen]);

  return (
    // `fill` 일 때만 h-screen/overflow-hidden 을 건다. 문서형 화면에 걸면 표가 잘린다.
    <div
      className={`bg-[#f2f2f4] text-[#1f2328] ${
        fill ? "h-[100dvh] overflow-hidden" : "min-h-[100dvh]"
      }`}
    >
      {/* 100dvh 를 쓰는 이유: 모바일 사파리·크롬의 주소창이 접히고 펴질 때 100vh 는
          실제로 보이는 높이보다 커서, 화면 아래쪽(하단 탭)이 주소창에 가려진다. */}

      {/* 트랙을 minmax(0,1fr) 로 못박는다. auto 트랙은 max-content 로 부풀어서
          안쪽 overflow-x-auto 컨테이너의 내용 폭이 좁은 화면에서 페이지 전체를
          가로로 밀어낸다 — 티 시트 격자에서 실제로 겪은 문제다. */}
      <div
        className={`grid grid-cols-[minmax(0,1fr)] ${
          railOpen ? "lg:grid-cols-[188px_minmax(0,1fr)]" : "lg:grid-cols-[minmax(0,1fr)]"
        } ${fill ? "h-full" : "min-h-[100dvh]"}`}
      >
        {railOpen ? (
          <DesktopSidebar division={shownDivision} onDivisionChange={changeDivision} pathname={pathname} />
        ) : null}

        <section
          className={`grid min-h-0 min-w-0 grid-cols-[minmax(0,1fr)] ${
            fill ? "grid-rows-[auto_minmax(0,1fr)_auto]" : "grid-rows-[auto_1fr_auto]"
          }`}
        >
          {/* 머리 부분 3종은 **반드시 하나의 grid 아이템으로 묶는다.**
              풀어 놓으면 아이템 개수가 화면 폭에 따라 달라진다: 데스크톱 헤더는
              모바일에서 `display:none` 이라 아이템에서 빠지고, 그 빈자리로 모바일
              액션 바가 2번째 행 — 즉 `1fr` 트랙 — 으로 밀려 들어가 세로로 부풀고
              본문을 아래로 밀어낸다. 실측(390px, /admin/radar):
              `65px 221px 508px 50px` ← 내용 61px 짜리 액션 바가 221px 을 차지했다.
              데스크톱은 액션 바가 `lg:hidden` 이라 우연히 멀쩡했을 뿐이다.
              묶어 두면 폭과 무관하게 언제나 3개 아이템(머리/본문/탭)이 된다. */}
          <div className="min-w-0">
            <MobileTopBar onOpen={() => setDrawerOpen(true)} onSignOut={onSignOut} title={title} />
            <DesktopHeader
              actions={screenOpen ? actions : null}
              email={email}
              onSignOut={onSignOut}
              onToggleRail={() => setRailOpen((open) => !open)}
              railOpen={railOpen}
              title={title}
            />

            {/* 모바일에서는 헤더의 액션이 좁아 잘리므로 제목 줄 아래로 내려 준다. */}
            {actions && screenOpen ? (
              <div className="flex flex-wrap items-center gap-2 border-b border-[#d4d4d8] bg-white px-4 py-2 lg:hidden">
                {actions}
              </div>
            ) : null}
          </div>

          <div className={fill ? "min-h-0 min-w-0 overflow-hidden" : "min-w-0"}>
            {screen && screenOpen !== true ? <ScreenDenied checking={screenOpen === null} screen={screen} /> : children}
          </div>

          <MobileTabBar pathname={pathname} showHref={showHref} />
        </section>
      </div>

      <MobileDrawer
        division={shownDivision}
        onClose={() => setDrawerOpen(false)}
        onDivisionChange={changeDivision}
        open={drawerOpen}
        pathname={pathname}
      />
    </div>
  );
}

// ===== 데스크톱 사이드바 ================================================

type DivisionProps = {
  division: AdminDivision;
  onDivisionChange: (division: AdminDivision) => void;
};

/**
 * 사업부 드롭다운 (Golf / Snack Bar & Retail / Indoor Golf Simulator).
 *
 * 네이티브 <select> 를 쓴다. 직접 만든 목록 팝업은 키보드·스크린리더·모바일 휠 피커를
 * 전부 다시 구현해야 하는데, 세 항목짜리 선택에 그만한 값어치가 없다.
 */
function DivisionPicker({ division, onDivisionChange, className }: DivisionProps & { className: string }) {
  return (
    <label className={`flex shrink-0 items-center ${className}`}>
      <span className="sr-only">Division</span>
      <select
        className="w-full cursor-pointer bg-transparent font-semibold text-inherit outline-none"
        onChange={(event) => {
          const next = adminDivisions.find((entry) => entry.key === event.target.value);
          if (next) onDivisionChange(next);
        }}
        value={division.key}
      >
        {adminDivisions.map((entry) => (
          <option className="bg-[#1c1f22] text-white" key={entry.key} value={entry.key}>
            {entry.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function DesktopSidebar({ pathname, division, onDivisionChange }: DivisionProps & { pathname: string | null }) {
  return (
    // Chronogolf 사이드바 순서: 워드마크 / 제품군 / 클럽 / 로그인 사용자 / 메뉴.
    // 클럽·사용자 줄은 메뉴가 아니라 "지금 어느 클럽에 누구로 들어와 있는가" 를
    // 말해 주는 문맥이라 nav 밖에 둔다 — 스크린리더에서 메뉴 항목으로 읽히면 안 된다.
    // 세로는 flex 컬럼이다. 메뉴가 `flex-1` 로 남는 높이를 먹고, 노트·도움말 묶음이
    // 아래에 눌러앉는다 — 레퍼런스와 같은 배치. 전체를 그냥 `overflow-y-auto` 로
    // 두면 메뉴 12개 바로 밑에 노트가 붙어서 화면 중간에 뜬다.
    <aside className="hidden min-h-0 flex-col bg-[#111315] text-white lg:flex">
      <div className="flex shrink-0 items-center gap-2 border-b border-white/10 px-4 py-4 text-sm font-bold">
        {/* 워드마크 앞의 마름모는 pelhamhills 로고 자리. */}
        <span aria-hidden className="text-base leading-none">
          &#9670;
        </span>
        pelhamhills
      </div>

      <DivisionPicker
        className="border-b border-white/10 bg-[#1c1f22] px-4 py-2.5 text-xs text-white/70"
        division={division}
        onDivisionChange={onDivisionChange}
      />
      <Link
        className="flex shrink-0 items-center gap-2 border-b border-white/10 bg-[#1c1f22] px-4 py-2.5 text-xs font-bold hover:bg-white/10"
        href={SITE_HOME}
      >
        <span aria-hidden>&#8962;</span>
        <span className="truncate">{CLUB.name}</span>
      </Link>

      <div className="flex shrink-0 items-baseline justify-between border-b border-white/10 px-4 py-2.5 text-[11px]">
        <span className="font-semibold">Pro Shop</span>
        <span className="flex items-baseline gap-1 text-white/50">
          Owner
          <span aria-hidden className="text-[9px] leading-none">
            &#9662;
          </span>
        </span>
      </div>

      <nav
        aria-label="Club administration"
        className="grid min-h-0 flex-1 content-start overflow-y-auto px-2 py-2 text-xs"
      >
        {division.links.map((item) => (
          <NavLink item={item} key={item.href} pathname={pathname} />
        ))}
      </nav>

      <SidebarNote />
      <InstallAppHint className="mx-3 mb-3 shrink-0" />

      {/* 레퍼런스의 마지막 두 줄. 도움말 센터는 진짜 링크이고, Share 는 붙일 대상이
          아직 없어서 표시로만 둔다. */}
      <div className="flex shrink-0 items-center justify-between border-t border-white/10 px-4 py-2 text-[10px] text-white/50">
        <span>Help Center</span>
        <span>Share</span>
        <span aria-hidden>&#128274;</span>
      </div>
      <div className="flex shrink-0 items-center gap-2 border-t border-white/10 px-4 py-2.5 text-[11px] font-semibold">
        <span aria-hidden>&#9432;</span>
        Help
      </div>
    </aside>
  );
}

/**
 * 사이드바 아래의 노란 메모. 레퍼런스에는 Note / News 두 탭이 붙어 있다.
 *
 * 실제 화면의 메모에는 로그인 비밀번호가 적혀 있지만 그것은 **옮겨 적지 않는다** —
 * 자격증명이 저장소에 들어가면 그 순간부터 되돌릴 수 없다. 여기 남는 것은
 * 프런트 데스크가 실제로 매일 쓰는 연락처와 코스 이름뿐이다.
 */
function SidebarNote() {
  const [tab, setTab] = useState<"note" | "news">("note");
  const tabClass = (active: boolean) =>
    `flex-1 px-2 py-1 text-[10px] font-bold ${active ? "bg-[#fffbd5] text-[#2f2f21]" : "bg-[#2a2d31] text-white/60"}`;

  return (
    <div className="mx-3 mb-3 shrink-0">
      <div className="flex" role="tablist">
        <button
          aria-selected={tab === "note"}
          className={tabClass(tab === "note")}
          onClick={() => setTab("note")}
          role="tab"
          type="button"
        >
          Note
        </button>
        <button
          aria-selected={tab === "news"}
          className={tabClass(tab === "news")}
          onClick={() => setTab("news")}
          role="tab"
          type="button"
        >
          News
        </button>
      </div>
      <div className="bg-[#fffbd5] p-3 text-[11px] leading-5 text-[#2f2f21]" role="tabpanel">
        {tab === "note" ? (
          <>
            <p>Francis&apos; Mobile #: 1-416-822-7609</p>
            <p>Course: Pelham Hills</p>
          </>
        ) : (
          <p className="text-[#6a6a52]">No club news posted.</p>
        )}
      </div>
    </div>
  );
}

function NavLink({
  item,
  pathname,
  onClick,
}: {
  item: { label: string; href: string; glyph: string };
  pathname: string | null;
  onClick?: () => void;
}) {
  const current = isActive(pathname, item.href);
  const body = (
    <>
      <span aria-hidden className="w-3.5 shrink-0 text-center opacity-80">
        {item.glyph}
      </span>
      <span className="truncate">{item.label}</span>
    </>
  );
  // `public/` 의 정적 페이지(사용법 프레젠테이션)는 앱 라우트가 아니다. Link 로 두면
  // 클라이언트 이동을 시도하다 실패하므로 평범한 링크로 연다.
  // 마케팅 사이트는 로그인이 따로라(같은 계정으로 한 번 더 로그인) 어드민을 두고 새 탭으로 연다.
  if (item.href === ADMIN_MARKETING) {
    return (
      <a
        className="flex items-center gap-2 px-3 py-2 font-semibold hover:bg-white/10"
        href={item.href}
        onClick={onClick}
        rel="noopener"
        target="_blank"
      >
        {body}
      </a>
    );
  }
  if (item.href.endsWith(".html")) {
    return (
      <a className="flex items-center gap-2 px-3 py-2 font-semibold hover:bg-white/10" href={item.href} onClick={onClick}>
        {body}
      </a>
    );
  }
  return (
    <Link
      aria-current={current ? "page" : undefined}
      className={`flex items-center gap-2 px-3 py-2 font-semibold ${
        current ? "bg-[#4533ff]" : "hover:bg-white/10"
      }`}
      href={item.href}
      onClick={onClick}
    >
      {body}
    </Link>
  );
}

// ===== 헤더 =============================================================

/**
 * 레퍼런스의 상단바 글리프 묶음 (?, 메일, 알림, 인쇄 …).
 *
 * 버튼이 아니라 **표시**다. 뒤에 붙일 기능이 아직 하나도 없는데 <button> 으로 두면
 * 일곱 개짜리 죽은 과녁이 상단바에 생긴다.
 * 하나라도 실제 기능이 생기면 그 글리프만 버튼으로 승격시키면 된다.
 */
const HEADER_GLYPHS = ["?", "✉︎", "⊝", "⚑︎", "▤", "⧉", "⋮"];

function DesktopHeader({
  title,
  actions,
  railOpen,
  onToggleRail,
  email,
  onSignOut,
}: {
  title: string;
  actions?: ReactNode;
  railOpen: boolean;
  onToggleRail: () => void;
  email: string;
  onSignOut: () => void;
}) {
  return (
    // 레퍼런스는 상단바가 **한 줄**이다. 예전에는 클럽 이름 줄 + 화면 제목 줄이었고,
    // 티 시트에는 그 아래에 자기 헤더가 하나 더 있어서 머리가 세 겹이었다.
    // 클럽 이름은 사이드바가 이미 말하고 있으므로 여기서는 뺀다.
    <header className="hidden items-center gap-3 border-b border-[#d4d4d8] bg-white px-3 py-2 lg:flex">
      <button
        aria-expanded={railOpen}
        aria-label={railOpen ? "Hide the admin menu" : "Show the admin menu"}
        className="shrink-0 px-1 text-lg leading-none text-[#4e5560] hover:text-[#111315]"
        onClick={onToggleRail}
        title={railOpen ? "Hide the admin menu" : "Show the admin menu"}
        type="button"
      >
        <span aria-hidden>&#9776;</span>
      </button>

      <h1 className="flex min-w-0 items-center gap-2 truncate text-sm font-bold">
        <span aria-hidden className="text-[#4533ff]">
          &#9638;
        </span>
        {title}
      </h1>

      <span aria-hidden className="ml-auto flex shrink-0 items-center gap-3 text-sm text-[#8b93a1]">
        {HEADER_GLYPHS.map((glyph) => (
          <span key={glyph}>{glyph}</span>
        ))}
      </span>

      <LangToggle className="border border-[#d4d4d8] px-2 py-1 text-[11px] text-[#1f2328] hover:bg-[#f2f2f4]" />
      {/* 누구로 들어와 있는지 한 번은 보여야 한다 — 프로 샵 컴퓨터는 여러 사람이 쓴다. */}
      <span className="max-w-[180px] shrink-0 truncate text-[11px] text-[#4e5560]" title={email}>
        {email}
      </span>
      <SignOutButton
        className="shrink-0 border border-[#d4d4d8] px-2 py-1 text-[11px] font-bold text-[#4e5560] hover:bg-[#f2f2f4]"
        onSignOut={onSignOut}
      />

      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  );
}

function MobileTopBar({
  title,
  onOpen,
  onSignOut,
}: {
  title: string;
  onOpen: () => void;
  onSignOut: () => void;
}) {
  return (
    <header className="flex items-center gap-3 border-b border-[#d4d4d8] bg-[#111315] px-3 py-2.5 text-white lg:hidden">
      <button
        // 44px 은 손가락으로 눌러서 빗나가지 않는 최소 크기다. 아이콘만 두면
        // 8px 짜리 과녁이 되어 첫 번째 탭이 자주 빗나간다.
        aria-label="Open admin menu"
        className="-ml-1 flex h-11 w-11 shrink-0 items-center justify-center text-xl"
        onClick={onOpen}
        type="button"
      >
        <span aria-hidden>☰</span>
      </button>
      <div className="min-w-0 flex-1">
        <p className="text-[10px] font-bold tracking-wide text-white/50 uppercase">
          {CLUB.shortName}
        </p>
        <h1 className="truncate text-sm font-bold">{title}</h1>
      </div>
      <LangToggle className="flex h-11 items-center px-2 text-[11px] text-white" />
      {/* 휴대폰에서도 나갈 길은 늘 보여야 한다. 서랍을 열어야만 로그아웃할 수 있으면
          공용 태블릿에 세션이 그대로 남는다. */}
      <SignOutButton
        className="-mr-1 flex h-11 shrink-0 items-center px-2 text-[11px] font-bold text-white/80"
        onSignOut={onSignOut}
      />
    </header>
  );
}

/** 로그아웃 버튼. 누르는 순간 잠기고, 이중 클릭으로 두 번 나가지 않는다. */
function SignOutButton({ className, onSignOut }: { className: string; onSignOut: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      className={className}
      disabled={busy}
      onClick={() => {
        setBusy(true);
        onSignOut();
      }}
      type="button"
    >
      로그아웃
    </button>
  );
}

// ===== 모바일 서랍 ======================================================

function MobileDrawer({
  open,
  onClose,
  pathname,
  division,
  onDivisionChange,
}: DivisionProps & {
  open: boolean;
  onClose: () => void;
  pathname: string | null;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 lg:hidden">
      {/* 뒷배경. 바깥을 눌러 닫는 것은 모바일에서 가장 자연스러운 취소 동작이다. */}
      <button
        aria-label="Close admin menu"
        className="absolute inset-0 bg-black/60"
        onClick={onClose}
        type="button"
      />
      <div className="absolute inset-y-0 left-0 flex w-[82vw] max-w-[300px] flex-col bg-[#111315] text-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
          <span className="text-sm font-bold">pelhamhills</span>
          <button
            aria-label="Close admin menu"
            className="-mr-2 flex h-10 w-10 items-center justify-center text-xl"
            onClick={onClose}
            type="button"
          >
            <span aria-hidden>×</span>
          </button>
        </div>

        <Link
          className="flex items-center gap-2 border-b border-white/10 bg-[#1c1f22] px-4 py-3 text-xs font-bold"
          href={SITE_HOME}
          onClick={onClose}
        >
          <span aria-hidden>&#8962;</span>
          <span className="truncate">{CLUB.name}</span>
        </Link>

        <DivisionPicker
          className="border-b border-white/10 px-4 py-3 text-sm text-white/80"
          division={division}
          onDivisionChange={onDivisionChange}
        />

        <nav
          aria-label="Club administration"
          className="grid flex-1 content-start gap-1 overflow-y-auto px-2 py-3 text-sm"
        >
          {division.links.map((item) => (
            <NavLink item={item} key={item.href} onClick={onClose} pathname={pathname} />
          ))}
        </nav>

        <InstallAppHint className="mx-4 mb-3" />

        <div className="border-t border-white/10 px-4 py-3 text-[11px] text-white/60">
          Pro Shop · Owner
        </div>
      </div>
    </div>
  );
}

// ===== 모바일 하단 탭 ===================================================

/** 화면 권한(0098)이 없는 계정이 주소로 들어왔을 때. */
function ScreenDenied({ screen, checking }: { screen: Screen; checking: boolean }) {
  if (checking) return <p className="p-4 text-sm text-[#4e5560]">확인 중…</p>;
  const label = SCREENS.find((item) => item.key === screen)?.label ?? screen;
  return (
    <div className="mx-auto grid max-w-md gap-3 p-4">
      <div className="bg-white p-5 text-sm shadow-sm">
        <p className="font-bold">This account can&apos;t open {label}.</p>
        <p className="mt-2 text-[#6b7280]">Ask Emmeline to turn on {label} for this account in Account Setup.</p>
      </div>
    </div>
  );
}

const TAB_COLS: Record<number, string> = { 1: "grid-cols-1", 2: "grid-cols-2", 3: "grid-cols-3", 4: "grid-cols-4" };

function MobileTabBar({ pathname, showHref }: { pathname: string | null; showHref: (href: string) => boolean }) {
  const items = adminQuickNav.filter((item) => showHref(item.href));
  return (
    // pb-[env(safe-area-inset-bottom)]: 홈 인디케이터가 있는 아이폰에서 마지막
    // 탭 줄이 인디케이터에 가려 눌리지 않는 것을 막는다.
    <nav
      aria-label="Quick admin sections"
      className={`grid ${TAB_COLS[items.length] ?? "grid-cols-4"} border-t border-[#d4d4d8] bg-white pb-[env(safe-area-inset-bottom)] lg:hidden`}
    >
      {items.map((item) => {
        const current = isActive(pathname, item.href);
        return (
          <Link
            aria-current={current ? "page" : undefined}
            className={`flex flex-col items-center gap-0.5 px-1 py-2 text-[10px] font-bold ${
              current ? "text-[#4533ff]" : "text-[#6b7280]"
            }`}
            href={item.href}
            key={item.href}
          >
            <span aria-hidden className="text-base leading-none">
              {item.glyph}
            </span>
            <span className="w-full truncate text-center">{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

// ===== 로그인 문 =========================================================

type GateState =
  /** 아직 모른다 — 저장된 세션을 읽고 직원인지 확인하는 중. */
  | "checking"
  /** 로그인하지 않았다. */
  | "out"
  /** 로그인은 됐지만 프로 샵 직원이 아니다. */
  | "denied"
  /** 직원 화면을 열어도 된다. */
  | "in";

function useStaffGate() {
  const [state, setState] = useState<GateState>("checking");
  const [email, setEmail] = useState("");
  // 세션이 바뀌면(로그인·로그아웃·다른 탭에서의 변화·토큰 갱신) 다시 판정한다.
  const [nonce, setNonce] = useState(0);

  useEffect(() => subscribe(() => setNonce((value) => value + 1)), []);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const current = getSession();
      if (!current) {
        if (!cancelled) {
          setEmail("");
          setState("out");
        }
        return;
      }
      if (!cancelled) setEmail(current.email);

      // 확인 요청보다 **먼저** 토큰을 손본다. 만료된 토큰으로 부르면 PostgREST 가
      // 401 을 주는데, 그것은 "직원이 아니다" 와 구분이 안 된다.
      const token = await accessToken();
      if (cancelled) return;
      if (!token) {
        setState("out"); // 갱신이 거부됐다 = 세션이 버려졌다.
        return;
      }

      try {
        // 가장 가벼운 직원 전용 호출로 문을 두드려 본다. 결과는 쓰지 않는다 —
        // 화면은 자기 데이터를 스스로 불러온다.
        await staffSlots(todayIso());
        if (!cancelled) setState("in");
      } catch (error) {
        if (cancelled) return;
        // 토큰이 거부돼 세션이 지워졌으면 로그인 화면으로.
        if (!getSession()) {
          setState("out");
          return;
        }
        // 401/403 만 "직원 아님" 이다. `0004` 마이그레이션을 아직 적용하지 않은
        // 프로젝트에서는 PostgREST 가 404(함수 없음)를 주는데, 그것까지 막아 버리면
        // 진짜 직원이 전부 잠긴다. 그 밖의 오류는 통과시키고 티 시트 자신의
        // 오류 표시에 맡긴다.
        setState(isStaffDenied(error) ? "denied" : "in");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [nonce]);

  /**
   * 로그인·로그아웃 뒤에는 **페이지를 새로 연다.**
   *
   * 얼핏 과해 보이지만 이유가 있다. `app/teesheet/page.tsx` 는 `useTeeSheet()` 를
   * 이 문(門)보다 **위에서** 부른다 — 로그인하지 않은 채로도 그 훅은 이미 돌아서
   * 예약·슬롯 요청을 401 로 실패해 둔 상태다. 문이 열려 자식이 렌더돼도 그 훅은
   * 다시 마운트되지 않고, 로더 effect 의 의존성(주·날짜·nonce)은 로그인으로 바뀌지
   * 않는다. 즉 **로그인해도 티 시트가 빈 채로, 낡은 오류 문구를 단 채 남는다.**
   * 페이지 소유는 이번 작업 범위 밖이라 훅을 옮기는 대신 여기서 새로 연다.
   * 세션은 `signIn`/`signOut` 이 끝나기 전에 이미 localStorage 에 쓰였으므로
   * 새로 열린 페이지는 토큰을 들고 시작한다.
   *
   * 로그아웃에서도 같은 이유 + 하나 더: 공용 태블릿에서 앞사람의 예약 목록이
   * 메모리에 남아 있지 않게 한다.
   */
  const reloadPage = useCallback(() => {
    if (typeof window !== "undefined") window.location.reload();
  }, []);

  const recheck = useCallback(() => {
    setState("checking");
    setNonce((value) => value + 1);
    reloadPage();
  }, [reloadPage]);

  const doSignOut = useCallback(() => {
    setState("checking");
    // 세션 삭제는 signOut() 안에서 즉시 끝난다. 서버 통보(로그아웃 엔드포인트)는
    // 기다려 주되, 네트워크가 느려도 화면이 붙잡히지 않도록 상한을 둔다.
    void signOut().then(reloadPage, reloadPage);
    window.setTimeout(reloadPage, 1500);
  }, [reloadPage]);

  return { state, email, recheck, signOut: doSignOut };
}

/** 판정 중 화면. 깜빡임을 줄이려고 글자 한 줄만 둔다. */
function GateSplash() {
  return (
    <main className="grid min-h-[100dvh] place-items-center bg-[#f2f2f4] px-4 text-sm text-[#4e5560]">
      <p>확인 중…</p>
    </main>
  );
}

/**
 * 로그인 화면. 휴대폰 기준(390×844)으로 짠다 — 프런트 데스크는 태블릿, 사장님은
 * 휴대폰으로 연다. 입력 글자 크기를 16px(text-base) 아래로 내리지 않는 이유:
 * iOS 사파리가 그보다 작은 입력에 초점이 가면 화면을 확대해 버린다.
 */
function SignInScreen({ onSignedIn }: { onSignedIn: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await signIn(email, password);
      // 문을 다시 판정하고 페이지를 새로 연다 — 이유는 `useStaffGate` 의 `reloadPage`.
      // busy 는 풀지 않는다. 새 문서가 뜰 때까지 버튼이 잠겨 있어야 두 번 눌리지 않는다.
      onSignedIn();
    } catch (cause) {
      setBusy(false);
      setError(
        cause instanceof ApiError
          ? cause.message
          : "로그인에 실패했습니다. 잠시 후 다시 시도해 주세요.",
      );
    }
  };

  return (
    <main className="grid min-h-[100dvh] place-items-center bg-[#f2f2f4] px-4 py-10 text-[#1f2328]">
      <div className="w-full max-w-[360px]">
        <div className="mb-4 flex items-center gap-2 text-sm font-bold">
          <span aria-hidden className="text-base leading-none text-[#4533ff]">
            &#9670;
          </span>
          {CLUB.shortName} 프로 샵
          <LangToggle className="ml-auto border border-[#d4d4d8] bg-white px-2 py-1 text-[11px]" />
        </div>

        <form className="bg-white p-5 shadow-sm" onSubmit={submit}>
          <h1 className="text-base font-bold">직원 로그인</h1>
          <p className="mt-1 text-xs leading-5 text-[#6b7280]">
            직원 아이디와 비밀번호로 들어옵니다. 예약 화면을 찾으시나요?{" "}
            <Link className="font-semibold text-[#4533ff] underline" href={SITE_HOME}>
              클럽 홈
            </Link>
          </p>

          <label className="mt-4 block text-xs font-bold" htmlFor="staff-email">
            아이디
          </label>
          <input
            autoCapitalize="none"
            autoComplete="username"
            autoCorrect="off"
            className="mt-1 h-11 w-full border border-[#d4d4d8] px-3 text-base"
            id="staff-email"
            name="username"
            onChange={(event) => setEmail(event.target.value)}
            required
            spellCheck={false}
            type="text"
            value={email}
          />

          <label className="mt-3 block text-xs font-bold" htmlFor="staff-password">
            비밀번호
          </label>
          <input
            autoComplete="current-password"
            className="mt-1 h-11 w-full border border-[#d4d4d8] px-3 text-base"
            id="staff-password"
            name="password"
            onChange={(event) => setPassword(event.target.value)}
            required
            type="password"
            value={password}
          />

          {error ? (
            // 실패 문구는 읽어 주기도 해야 한다 — 스크린리더 사용자는 붉은 글씨를 못 본다.
            <p className="mt-3 border border-[#f0b4b4] bg-[#fdf1f1] p-2 text-xs leading-5 text-[#8c1d1d]" role="alert">
              {error}
            </p>
          ) : null}

          <button
            className="mt-4 h-11 w-full bg-[#4533ff] text-sm font-bold text-white disabled:opacity-60"
            disabled={busy}
            type="submit"
          >
            {busy ? "로그인 중…" : "로그인"}
          </button>
        </form>

        <p className="mt-3 text-[11px] leading-5 text-[#6b7280]">
          계정이 없거나 비밀번호를 잊으셨으면 프로 샵(249-805-0556)으로 연락해 주세요.
        </p>
      </div>
    </main>
  );
}

/**
 * 로그인은 됐는데 직원이 아닌 경우. 손님 계정으로 어드민 주소를 연 상황이다.
 * 빈 티 시트를 보여 주면 "고장났다" 로 읽히므로 이유를 적고 나갈 길을 준다.
 */
function NotStaffScreen({ email, onSignOut }: { email: string; onSignOut: () => void }) {
  return (
    <main className="grid min-h-[100dvh] place-items-center bg-[#f2f2f4] px-4 py-10 text-[#1f2328]">
      <div className="w-full max-w-[360px] bg-white p-5 shadow-sm">
        <h1 className="text-base font-bold">직원 계정이 아닙니다</h1>
        <p className="mt-2 text-xs leading-5 text-[#6b7280]">
          {email ? `${email} 계정에는 ` : "이 계정에는 "}
          프로 샵 권한이 없습니다. 다른 계정으로 로그인하거나, 프로 샵(249-805-0556)에
          권한을 요청해 주세요.
        </p>
        <button
          className="mt-4 h-11 w-full bg-[#4533ff] text-sm font-bold text-white"
          onClick={onSignOut}
          type="button"
        >
          다른 계정으로 로그인
        </button>
        <Link
          className="mt-3 flex h-11 w-full items-center justify-center border border-[#d4d4d8] text-sm font-bold"
          href={SITE_HOME}
        >
          클럽 홈으로
        </Link>
      </div>
    </main>
  );
}

/** 어드민 링크가 서랍/사이드바 밖에서도 필요할 때 쓰는 재수출. */
export { ADMIN_HOME };
