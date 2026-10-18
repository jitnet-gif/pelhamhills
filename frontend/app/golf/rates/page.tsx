/**
 * 그린피 안내. 홈의 "See Rates" 가 옛 WordPress 주소(`/golf/rates/`)를 가리켰는데, 도메인이
 * 이 사이트로 넘어온 뒤로 그 주소는 404 였다(2026-10-18). 같은 주소에 이 장을 둔다.
 *
 * 요금은 **DB 가 실제로 매기는 값**을 옮겨 적은 것이다 — 손으로 정한 숫자가 아니다:
 *   - 그린피: `pelham_tee_rate(date)` (0025) — 평일 47.79, 주말·공휴일 58.41 (세전)
 *   - 세금: `pelham_pos_tax` (0005) — HST 13%. 온라인 결제도 세전 요금에 이것을 더한다.
 *   - 추가 품목: `pelham_tee_extras` (0026) 의 기본값
 * 정적 export 라서 여기서 함수를 부를 수 없고(anon 에게 실행 권한도 없다), 그래서 문자열로 둔다.
 * DB 에서 요금을 바꾸면 이 파일도 같이 고쳐라. 공휴일별 요금(`pelham_tee_holidays.rate`)은
 * 날마다 달라질 수 있어 여기에는 기본값만 적는다.
 *
 * 서버 컴포넌트다. 홈(`app/page.tsx`)과 같은 이유로 `"use client"` 를 붙이지 마라.
 */

import type { Metadata } from "next";
import Link from "next/link";

import SiteFooter from "@/components/site/SiteFooter";
import SiteHeader from "@/components/site/SiteHeader";
import { BOOK_TEE_TIME, CLUB, SITE_MEMBERSHIPS } from "@/lib/nav";

export const metadata: Metadata = {
  title: `Golf Rates | ${CLUB.name}`,
  description:
    "Public green fees at Pelham Hills Golf Club — weekday and weekend/holiday rates, pull carts and driving range baskets.",
};

const greenFees = [
  { name: "Weekday", when: "Monday – Friday", base: "$47.79", total: "$54.00" },
  { name: "Weekend & Holiday", when: "Saturday, Sunday & statutory holidays", base: "$58.41", total: "$66.00" },
];

const extras = [
  { name: "Pull Cart (18 Holes)", price: "$8.00" },
  { name: "Pull Cart (9 Holes)", price: "$5.00" },
  { name: "Small Range Basket", price: "$8.00" },
  { name: "Large Range Basket", price: "$12.00" },
  { name: "Driving Range (Non-Members)", price: "$15.00" },
];

export default function GolfRatesPage() {
  return (
    <div className="min-h-dvh bg-[#f7f4ed] text-[#182118]">
      <SiteHeader />

      <main>
        <section className="bg-[#214d2f] px-5 py-14 text-white sm:py-20 lg:px-8">
          <div className="mx-auto max-w-7xl">
            <p className="text-sm font-bold tracking-[0.2em] text-[#d6c28f] uppercase">Golf Rates</p>
            <h1 className="mt-3 max-w-3xl font-serif text-4xl leading-tight font-semibold sm:text-5xl">
              Public green fees.
            </h1>
            <p className="mt-5 max-w-2xl text-lg leading-8 text-[#edf4ec]">
              The same rates you pay when you book online.
            </p>
            <Link
              className="mt-8 inline-block rounded-sm bg-[#d6c28f] px-6 py-3 text-center text-sm font-extrabold tracking-[0.12em] text-[#182118] uppercase transition hover:bg-[#ead7a1]"
              href={BOOK_TEE_TIME}
            >
              Book a Tee-Time
            </Link>
          </div>
        </section>

        <section className="mx-auto max-w-7xl px-5 py-12 sm:py-16 lg:px-8">
          <p className="text-sm font-bold tracking-[0.2em] text-[#8a6f30] uppercase">Green Fees</p>
          <h2 className="mt-3 font-serif text-3xl font-semibold sm:text-4xl">Per player</h2>
          <div className="mt-8 grid gap-5 md:grid-cols-2">
            {greenFees.map((fee) => (
              <article className="rounded-sm border border-[#d8d1c3] bg-white p-6" key={fee.name}>
                <h3 className="font-serif text-2xl font-semibold">{fee.name}</h3>
                <p className="mt-1 text-[#516050]">{fee.when}</p>
                <p className="mt-6 font-serif text-5xl font-semibold tabular-nums">{fee.total}</p>
                <p className="mt-2 text-sm text-[#516050]">
                  Includes HST · {fee.base} + 13% HST
                </p>
              </article>
            ))}
          </div>
          <p className="mt-6 max-w-3xl leading-7 text-[#516050]">
            Tee times run every 9 minutes from 6:40 AM. Holiday rates may vary on select dates —
            the price shown when you book is the price you pay. Rates are subject to change
            without notice.
          </p>
        </section>

        <section className="bg-[#ebe5d7] px-5 py-12 sm:py-16 lg:px-8">
          <div className="mx-auto grid max-w-7xl gap-10 lg:grid-cols-[0.9fr_1.1fr]">
            <div>
              <p className="text-sm font-bold tracking-[0.2em] text-[#8a6f30] uppercase">Extras</p>
              <h2 className="mt-3 font-serif text-3xl font-semibold sm:text-4xl">
                Carts &amp; practice.
              </h2>
              <p className="mt-4 text-[#516050]">Prices before HST. Add them at the pro shop.</p>
              <p className="mt-6 leading-7 text-[#516050]">
                Playing often?{" "}
                <Link className="font-bold text-[#214d2f] underline" href={SITE_MEMBERSHIPS}>
                  See membership options
                </Link>
                .
              </p>
            </div>
            <div className="rounded-sm border border-[#d8d1c3] bg-white">
              {extras.map((row) => (
                <div
                  className="flex items-center justify-between gap-4 border-b border-[#d8d1c3] p-5 last:border-b-0"
                  key={row.name}
                >
                  <span className="font-bold">{row.name}</span>
                  <span className="font-bold tabular-nums">{row.price}</span>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="bg-[#214d2f] px-5 py-12 text-white lg:px-8 lg:py-16">
          <div className="mx-auto max-w-7xl">
            <h2 className="font-serif text-3xl font-semibold">Questions about rates?</h2>
            <p className="mt-4 max-w-3xl leading-7 text-[#edf4ec]">
              Call the pro shop at{" "}
              <a className="font-bold text-[#d6c28f]" href={CLUB.phoneHref}>
                {CLUB.phone}
              </a>{" "}
              or email{" "}
              <a className="font-bold text-[#d6c28f]" href={CLUB.emailHref}>
                {CLUB.email}
              </a>
              .
            </p>
          </div>
        </section>
      </main>

      <SiteFooter />
    </div>
  );
}
