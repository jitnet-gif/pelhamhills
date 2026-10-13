/**
 * 직원용 사용 안내 모음(`/guide`). 로그인 없이 열린다.
 *
 * 안내 하나하나는 claude.ai 아티팩트로 만든 페이지를 `public/guides/<slug>/index.html` 로
 * 그대로 옮겨 둔 정적 HTML 이다. 이 화면은 그 목록일 뿐이라, 안내를 추가할 때는 폴더를
 * 넣고 아래 `guides` 에 한 줄을 더하면 된다.
 *
 * 개발 진행 보고·설계 설명용 아티팩트는 직원이 앱을 쓰는 데 필요 없으므로 넣지 않는다.
 *
 * 서버 컴포넌트다. `"use client"` 를 붙이지 마라.
 */

import type { Metadata } from "next";
import Link from "next/link";

import { ADMIN_HOME, ADMIN_RETAIL, ADMIN_SCAN, REGISTER_GUIDE } from "@/lib/nav";

export const metadata: Metadata = {
  title: "Staff Guides",
  robots: { index: false, follow: false },
};

type Guide = {
  href: string;
  title: string;
  summary: string;
  /** 안내가 다루는 어드민 화면. 안내를 읽고 바로 열어 볼 수 있게 둔다. */
  screen?: { label: string; href: string };
  tag: string;
};

const sections: { heading: string; guides: Guide[] }[] = [
  {
    heading: "계산대 (Pro Shop · Snack Bar)",
    guides: [
      {
        href: REGISTER_GUIDE,
        title: "Register 첫 화면",
        summary:
          "Continue Sale · Refund · New Sale · Close Register 와 최근 판매 목록을 장면별 나레이션(한국어/English)으로 따라가며 익힌다.",
        screen: { label: "Pro Shop 계산대", href: ADMIN_RETAIL },
        tag: "나레이션",
      },
      {
        href: "/guides/camera-scan/index.html",
        title: "카메라 스캔",
        summary:
          "휴대폰·아이패드 카메라를 계산대 스캐너처럼 쓰는 법. 한 손님 계산 흐름, 중복 방지 규칙, 소리·색 신호, 홈 화면 바로가기 설치.",
        screen: { label: "Camera Scan", href: ADMIN_SCAN },
        tag: "사용법",
      },
    ],
  },
  {
    heading: "상품 · 바코드",
    guides: [
      {
        href: "/guides/barcode-register/index.html",
        title: "바코드 등록법 (게토레이 예시)",
        summary:
          "맛·용량이 다른 상품을 하나씩 따로 등록하는 순서 — Products 탭에서 추가, Barcode 칸에 스캔, SKU 규칙, Register 탭에서 확인.",
        screen: { label: "Pro Shop 계산대", href: ADMIN_RETAIL },
        tag: "사용법",
      },
      {
        href: "/guides/barcode-read/index.html",
        title: "프로샵 바코드 읽는 법",
        summary:
          "제조사 UPC 에는 상품군이 들어 있지 않다는 점, 상품군은 category 칸에서 온다는 점, 자체 라벨을 만드는 규칙.",
        tag: "참고",
      },
    ],
  },
];

export default function GuidePage() {
  return (
    <main className="min-h-screen bg-[#f4f4f6] px-4 py-8 text-[#16171b]">
      <div className="mx-auto grid max-w-3xl gap-8">
        <header className="grid gap-2">
          <p className="text-xs font-semibold tracking-widest text-[#4533ff] uppercase">
            Pelham Hills · Staff
          </p>
          <h1 className="text-3xl font-bold">웹앱 사용 안내</h1>
          <p className="text-[15px] text-[#62666f]">
            화면별 사용법을 모아 둔 곳입니다. 안내는 새 탭으로 열리므로 작업 중인 화면은 그대로
            둔 채 볼 수 있습니다.
          </p>
        </header>

        {sections.map((section) => (
          <section className="grid gap-3" key={section.heading}>
            <h2 className="text-lg font-bold">{section.heading}</h2>
            <ul className="grid gap-3">
              {section.guides.map((guide) => (
                <li
                  className="grid min-w-0 gap-2 border border-[#d4d4d8] bg-white p-4"
                  key={guide.href}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <a
                      className="text-base font-bold text-[#4533ff] underline underline-offset-4"
                      href={guide.href}
                      rel="noopener"
                      target="_blank"
                    >
                      {guide.title}
                    </a>
                    <span className="bg-[#ecebff] px-2 py-0.5 text-xs font-bold text-[#4533ff]">
                      {guide.tag}
                    </span>
                  </div>
                  <p className="text-sm text-[#62666f]">{guide.summary}</p>
                  {guide.screen ? (
                    <Link
                      className="justify-self-start text-sm font-semibold text-[#16171b] underline underline-offset-4"
                      href={guide.screen.href}
                    >
                      화면 열기: {guide.screen.label} →
                    </Link>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ))}

        <footer className="text-sm text-[#62666f]">
          <Link className="underline underline-offset-4" href={ADMIN_HOME}>
            ← 어드민으로
          </Link>
        </footer>
      </div>
    </main>
  );
}
