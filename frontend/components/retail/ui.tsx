"use client";

/**
 * 리테일 세 탭이 함께 쓰는 작은 조각들. 여기 모아 두는 이유는 순전히
 * **일관성** 때문이다 — 입력 필드 글자 크기(16px 미만이면 iOS 가 포커스 시
 * 화면을 확대해 버린다)나 최소 44px 과녁 같은 규칙을 탭마다 다시 적으면
 * 반드시 한 곳이 어긋난다.
 */

import { useEffect, useRef } from "react";
import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";

// ===== 겹쳐 뜨는 것들의 공통 동작 ========================================

/**
 * 모달·하단 시트가 열려 있는 동안의 공통 처리. `AdminShell` 의 모바일 서랍이
 * 이미 같은 일을 하고 있어서, 리테일 화면만 다르게 굴면 "어떤 창은 Esc 로
 * 닫히고 어떤 창은 안 닫힌다" 가 된다.
 *
 * - Esc 로 닫기: 겹쳐 뜬 것은 모달이므로 키보드만 쓰는 사용자에게도 탈출구가 필요하다.
 * - body 스크롤 잠금: iOS 의 scroll chaining 때문에 뒤쪽 본문이 같이 스크롤되면,
 *   창을 닫았을 때 상품 격자가 엉뚱한 위치에 가 있다.
 */
export function useOverlayDismiss(onClose: () => void) {
  // 콜백을 ref 로 받는 이유: 호출부는 보통 `onClose={() => setOpen(false)}` 처럼
  // 매 렌더 새 함수를 넘긴다. 그걸 의존성에 넣으면 effect 가 렌더마다 재실행되고,
  // 두 번째 실행이 `previous` 로 **첫 실행이 넣어 둔 "hidden"** 을 붙잡는다.
  // 그러면 창을 닫아도 body 가 "hidden" 으로 복원되어 페이지가 영영 스크롤되지
  // 않는다. 아래처럼 두면 effect 는 마운트/언마운트 때만 돈다.
  const latest = useRef(onClose);
  latest.current = onClose;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") latest.current();
    };
    window.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, []);
}

// ===== 배너 ============================================================

/**
 * 서버에 닿지 못했을 때 화면 맨 위에 붙는 줄. 주소는 절대 넣지 않는다
 * (`lib/apiHost.ts` docstring — 방문자 화면에 개발 머신 주소가 찍힌 사고가 있었다).
 *
 * "예시입니다" 를 같은 배너에 붙이는 이유: 데모 데이터를 진짜 재고로 착각한
 * 직원이 "Pro V1 18개 있네" 하고 손님에게 말하는 것이 최악의 결과다.
 */
export function OfflineBanner({ detail, demo }: { detail?: string; demo: boolean }) {
  return (
    <div
      className="flex flex-wrap items-baseline gap-x-2 gap-y-1 border border-[#f0c36d] bg-[#fff8e1] px-3 py-2.5 text-sm text-[#5b4708]"
      role="status"
    >
      <span className="font-bold">리테일 서버에 연결할 수 없습니다.</span>
      {demo ? <span>표시된 값은 예시입니다 — 저장되지 않습니다.</span> : null}
      {detail ? <span className="text-[#7a6320]">{detail}</span> : null}
    </div>
  );
}

/** 요청 하나가 실패했을 때(서버는 살아 있는데 거절한 경우) 쓰는 붉은 줄. */
export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <p
      // wrap-anywhere: 서버가 준 문장에 긴 URL(Stripe 거절 안내 등)이 있으면 그 폭만큼 칸을 밀어 낸다.
      className="border border-[#f0b4b4] bg-[#fdf0f0] px-3 py-2 text-sm wrap-anywhere text-[#8a1f1f]"
      role="alert"
    >
      {children}
    </p>
  );
}

// ===== 스켈레톤 =========================================================
//
// 스피너 하나로 화면 전체를 비우지 않는다. 로딩 중에도 화면의 뼈대가 보이면
// 사용자는 "뭐가 올 것인지" 를 알고 기다린다.

export function SkeletonBar({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse bg-[#e4e4e8] ${className}`} />;
}

export function SkeletonCards({ count = 8 }: { count?: number }) {
  return (
    // minmax(0,1fr): auto 트랙은 max-content 로 부풀어 좁은 화면을 가로로 민다.
    <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-2">
      {Array.from({ length: count }, (_, index) => (
        <SkeletonBar className="h-24 min-w-0" key={index} />
      ))}
    </div>
  );
}

export function SkeletonRows({ count = 6 }: { count?: number }) {
  return (
    <div className="grid gap-2">
      {Array.from({ length: count }, (_, index) => (
        <SkeletonBar className="h-14 w-full" key={index} />
      ))}
    </div>
  );
}

// ===== 껍데기 ===========================================================

export function Panel({
  title,
  actions,
  children,
}: {
  title?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="min-w-0 border border-[#d4d4d8] bg-white">
      {title || actions ? (
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-[#d4d4d8] px-3 py-2">
          {title ? <h2 className="text-sm font-bold">{title}</h2> : <span />}
          {actions}
        </header>
      ) : null}
      <div className="min-w-0 p-3">{children}</div>
    </section>
  );
}

export function StatCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="min-w-0 border border-[#d4d4d8] bg-white px-3 py-2.5">
      <p className="truncate text-[11px] font-bold tracking-wide text-[#6b7280] uppercase">
        {label}
      </p>
      <p className="mt-0.5 text-lg font-bold tabular-nums">{value}</p>
      {hint ? <p className="mt-0.5 truncate text-xs text-[#6b7280]">{hint}</p> : null}
    </div>
  );
}

export function EmptyNote({ children }: { children: ReactNode }) {
  return <p className="px-1 py-6 text-center text-sm text-[#6b7280]">{children}</p>;
}

// ===== 버튼 =============================================================

type ButtonTone = "primary" | "plain" | "danger";

const TONES: Record<ButtonTone, string> = {
  primary: "bg-[#4533ff] text-white hover:bg-[#3626d6] disabled:bg-[#b9b2ff]",
  plain:
    "border border-[#d4d4d8] bg-white text-[#1f2328] hover:bg-[#f2f2f4] disabled:text-[#9ca3af]",
  danger: "border border-[#e2a5a5] bg-white text-[#8a1f1f] hover:bg-[#fdf0f0] disabled:text-[#c99]",
};

export function Button({
  tone = "plain",
  full = false,
  className = "",
  children,
  ...rest
}: {
  tone?: ButtonTone;
  full?: boolean;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      // min-h-11: 손가락으로 눌러서 빗나가지 않는 최소 과녁(44px).
      className={`inline-flex min-h-11 items-center justify-center gap-1.5 px-3 text-sm font-bold disabled:cursor-not-allowed ${
        TONES[tone]
      } ${full ? "w-full" : ""} ${className}`}
      type="button"
      {...rest}
    >
      {children}
    </button>
  );
}

/** 카테고리 필터처럼 켜고 끄는 칩. */
export function Chip({
  active,
  children,
  ...rest
}: { active: boolean } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      aria-pressed={active}
      className={`inline-flex min-h-11 shrink-0 items-center px-3 text-sm font-bold whitespace-nowrap ${
        active
          ? "bg-[#111315] text-white"
          : "border border-[#d4d4d8] bg-white text-[#3f434a] hover:bg-[#f2f2f4]"
      }`}
      type="button"
      {...rest}
    >
      {children}
    </button>
  );
}

// ===== 입력 =============================================================
//
// `text-base`(16px) 를 못박는다. 그 아래면 iOS 사파리가 포커스 순간 화면을
// 확대하고, 확대된 채로 남아서 계산대 화면이 가로로 잘린다. select/textarea 도
// 같은 규칙을 받는다 — input 만 고쳐 두면 결제수단 드롭다운에서 그대로 당한다.

const FIELD_CLASS =
  "min-h-11 w-full border border-[#d4d4d8] bg-white px-2.5 text-base text-[#1f2328] focus:border-[#4533ff] focus:outline-none";

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="grid min-w-0 gap-1 text-sm">
      <span className="font-bold text-[#3f434a]">{label}</span>
      {children}
      {hint ? <span className="text-xs text-[#6b7280]">{hint}</span> : null}
    </label>
  );
}

export function TextInput({
  className = "",
  ...rest
}: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`${FIELD_CLASS} ${className}`} {...rest} />;
}

export function Select({
  className = "",
  children,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={`${FIELD_CLASS} ${className}`} {...rest}>
      {children}
    </select>
  );
}

export function TextArea({
  className = "",
  ...rest
}: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea className={`${FIELD_CLASS} min-h-[72px] py-2 ${className}`} rows={2} {...rest} />
  );
}

// ===== 모달 =============================================================

/**
 * 다이얼로그. 어드민 껍데기의 모바일 서랍이 `z-50` 이라 그보다 위(`z-[60]`)에
 * 둔다 — 상품 편집 중에 서랍이 열리면 편집 폼이 그 아래로 숨어 버린다.
 */
export function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  useOverlayDismiss(onClose);
  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center sm:items-center">
      <button
        aria-label="Close"
        className="absolute inset-0 bg-black/60"
        onClick={onClose}
        type="button"
      />
      {/* max-h + overflow-y: 키보드가 올라온 모바일에서 폼 아래쪽 버튼이
          화면 밖으로 밀려 눌리지 않는 것을 막는다. */}
      <div className="relative flex max-h-[92dvh] w-full max-w-md flex-col overflow-hidden bg-white shadow-2xl sm:max-h-[88dvh]">
        <header className="flex items-center justify-between border-b border-[#d4d4d8] px-3 py-2.5">
          <h2 className="text-sm font-bold">{title}</h2>
          <button
            aria-label="Close"
            className="tap-target -mr-2 flex items-center justify-center text-xl leading-none"
            onClick={onClose}
            type="button"
          >
            <span aria-hidden>×</span>
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-3 pb-safe">{children}</div>
      </div>
    </div>
  );
}
