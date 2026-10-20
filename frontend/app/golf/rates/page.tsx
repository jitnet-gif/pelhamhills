/**
 * 그린피 안내. 홈의 "See Rates" 가 옛 WordPress 주소(`/golf/rates/`)를 가리켰는데, 도메인이
 * 이 사이트로 넘어온 뒤로 그 주소는 404 였다(2026-10-18). 같은 주소에 이 장을 둔다.
 *
 * 요금은 **DB 가 실제로 매기는 값**의 사본 `lib/rateCard.ts` 에서 읽는다(0045 요금표, 2026-10-19):
 *   - 그린피: 요금표(날짜) × 가격대(티오프 시각). 9홀은 요금표마다 한 가격·판매 시작 시각
 *   - 세금: `pelham_pos_tax` (0005) — HST 13%. 온라인 결제도 세전 요금에 이것을 더한다.
 *   - 추가 품목: `pelham_tee_extras` (0026, 값은 0040)
 *   - 파워 카트: `pelham_tee_cart_fee_on` (0045) — 1인 18홀 19.47(Senior 평일 17.70), 9홀 11.50 (세전)
 * 공휴일별 요금(`pelham_tee_holidays.rate`)은 날마다 달라질 수 있어 여기에는 기본값만 적는다.
 *
 * 서버 컴포넌트다. 홈(`app/page.tsx`)과 같은 이유로 `"use client"` 를 붙이지 마라.
 */

import type { Metadata } from "next";
import Link from "next/link";

import SiteFooter from "@/components/site/SiteFooter";
import SiteHeader from "@/components/site/SiteHeader";
import { BOOK_TEE_TIME, CLUB, SITE_MEMBERSHIPS } from "@/lib/nav";
import { RATE_CARDS, type RateCard, withHst } from "@/lib/rateCard";

export const metadata: Metadata = {
  title: `Golf Rates | ${CLUB.name}`,
  description:
    "Public green fees at Pelham Hills Golf Club — 18 and 9 holes by season, day and tee time, senior and junior rates, power carts, pull carts and driving range baskets.",
};

// 손님에게 보이는 요금표: 지금(가을) 시즌을 먼저, 정규 시즌을 다음에. 특별·공휴일 요금표는 문구로만 안내한다.
const seasons: { title: string; when: string; cards: RateCard[] }[] = [
  {
    title: "Shoulder season",
    when: "October 1 – December 15 and April 26 – May 7",
    cards: ["weekday_shoulder", "weekend_shoulder"].map((code) => RATE_CARDS.find((card) => card.code === code)!),
  },
  {
    title: "Main season",
    when: "May 8 – September 30",
    cards: ["weekday", "friday", "weekend"].map((code) => RATE_CARDS.find((card) => card.code === code)!),
  },
];

const dollars = (value: number) => `$${value.toFixed(2)}`;

const extras = [
  // 1인 하프 카트 — `pelham_tee_cart_fee` (0039).
  { name: "Power Cart (18 Holes, per player)", price: "$19.47" },
  { name: "Power Cart (18 Holes, Senior, per player)", price: "$17.70" },
  { name: "Power Cart (9 Holes, per player)", price: "$11.50" },
  { name: "Pull Cart (18 Holes)", price: "$7.08" },
  { name: "Pull Cart (9 Holes)", price: "$3.54" },
  { name: "Small Range Basket", price: "$8.00" },
  { name: "Large Range Basket", price: "$13.00" },
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
          {seasons.map((season) => (
            <div className="mt-8" key={season.title}>
              <h3 className="font-serif text-2xl font-semibold">{season.title}</h3>
              <p className="mt-1 text-[#516050]">{season.when}</p>
              <div className={`mt-5 grid gap-5 ${season.cards.length === 3 ? "md:grid-cols-3" : "md:grid-cols-2"}`}>
                {season.cards.map((card) => (
                  <article className="rounded-sm border border-[#d8d1c3] bg-white p-6" key={card.code}>
                    <h4 className="font-serif text-xl font-semibold">{card.name.replace(" 2026", "")}</h4>
                    <p className="mt-1 text-sm text-[#516050]">{card.applies.split(" · ")[0]}</p>
                    {card.bands.map((band, index) => (
                      <p
                        className={`text-[#182118] ${index === 0 ? "mt-5" : "mt-3 border-t border-[#d8d1c3] pt-3"}`}
                        key={band.from}
                      >
                        <span className={`font-serif font-semibold tabular-nums ${index === 0 ? "text-4xl" : "text-2xl"}`}>
                          {dollars(withHst(band.rate))}
                        </span>{" "}
                        <span className="text-sm text-[#516050]">
                          18 holes · {band.from === "Open" ? "from open" : `from ${band.from}`} · {dollars(band.rate)} + HST
                        </span>
                      </p>
                    ))}
                    {card.nine ? (
                      <p className="mt-3 border-t border-[#d8d1c3] pt-3 text-[#182118]">
                        <span className="font-serif text-2xl font-semibold tabular-nums">{dollars(withHst(card.nine.rate))}</span>{" "}
                        <span className="text-sm text-[#516050]">
                          9 holes · from {card.nine.from} · {dollars(card.nine.rate)} + HST
                        </span>
                      </p>
                    ) : null}
                  </article>
                ))}
              </div>
            </div>
          ))}
          <p className="mt-6 max-w-3xl leading-7 text-[#516050]">
            Seniors: {dollars(withHst(40.71))} for 18 holes and {dollars(withHst(30.97))} for 9 holes (not on shoulder-season
            weekends). Juniors: {dollars(withHst(35.4))} before 2:00 PM, {dollars(withHst(32.75))} after;{" "}
            {dollars(withHst(25.67))} for 9 holes. Victoria Day, Canada Day and other holidays follow their own holiday rate
            card.
          </p>
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
