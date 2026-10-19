/**
 * 2027 Early Bird 혜택 안내. 예전에는 회원권 첫 장의 "Early Bird Benefits" 버튼이 옛 사이트의 .docx 를
 * 내려받게 했다 — 휴대폰에서는 열리지도 않는다. 내용은 클럽의 안내문
 * ("Flyer for Early Bird Special Benefit for Membership (Final_2027)", 2026-10-19 확인)을 옮긴 것이다.
 *
 * 서버 컴포넌트다. `"use client"` 를 붙이지 마라.
 */

import type { Metadata } from "next";
import Link from "next/link";

import SiteFooter from "@/components/site/SiteFooter";
import SiteHeader from "@/components/site/SiteHeader";
import { BOOK_INDOOR, CLUB, SITE_MEMBERSHIPS, SITE_MEMBERSHIP_APPLY } from "@/lib/nav";

export const metadata: Metadata = {
  title: `2027 Early Bird Benefits | ${CLUB.name}`,
  description:
    "Join Pelham Hills Golf Club for 2027 by November 15, 2026 and get 14-day advance tee time booking, free indoor golf simulator hours and discounted guest green fees.",
};

const couponHours = [
  { name: "Full", hours: 10 },
  { name: "Weekdays & Intermediate", hours: 8 },
  { name: "9 Holes & Twilight", hours: 6 },
];

export default function EarlyBirdPage() {
  return (
    <div className="min-h-dvh bg-[#f7f4ed] text-[#182118]">
      <SiteHeader />

      <main>
        <section className="bg-[#214d2f] px-5 py-14 text-white sm:py-20 lg:px-8">
          <div className="mx-auto max-w-7xl">
            <Link className="text-sm font-bold text-[#d6c28f] hover:underline" href={SITE_MEMBERSHIPS}>
              ← Memberships
            </Link>
            <p className="mt-6 text-sm font-bold tracking-[0.2em] text-[#d6c28f] uppercase">
              2027 Membership
            </p>
            <h1 className="mt-3 max-w-3xl font-serif text-4xl leading-tight font-semibold sm:text-5xl">
              Early Bird special benefits.
            </h1>
            <p className="mt-5 max-w-2xl text-lg leading-8 text-[#edf4ec]">
              2027 memberships are available now. Pay in full by{" "}
              <strong className="text-white">November 15, 2026</strong> to lock in Early Bird rates and
              the benefits below.
            </p>
            <Link
              className="mt-8 inline-block rounded-sm bg-[#d6c28f] px-6 py-3 text-center text-sm font-extrabold tracking-[0.12em] text-[#182118] uppercase transition hover:bg-[#ead7a1]"
              href={SITE_MEMBERSHIP_APPLY}
            >
              Apply Online
            </Link>
          </div>
        </section>

        <section className="mx-auto grid max-w-7xl gap-6 px-5 py-12 sm:py-16 md:grid-cols-3 lg:px-8">
          <article className="rounded-sm border border-[#d8d1c3] bg-white p-6">
            <p className="font-serif text-5xl font-semibold text-[#214d2f]">14</p>
            <h2 className="mt-2 font-serif text-2xl font-semibold">Days advance booking</h2>
            <p className="mt-3 leading-7 text-[#516050]">
              Reserve your tee times up to 14 days ahead — before the public can.
            </p>
          </article>
          <article className="rounded-sm border border-[#d8d1c3] bg-white p-6">
            <p className="font-serif text-5xl font-semibold text-[#214d2f]">10 h</p>
            <h2 className="mt-2 font-serif text-2xl font-semibold">Free simulator hours</h2>
            <p className="mt-3 leading-7 text-[#516050]">
              Hourly coupons for our indoor golf simulators, so you can keep swinging all winter.
            </p>
          </article>
          <article className="rounded-sm border border-[#d8d1c3] bg-white p-6">
            <p className="font-serif text-5xl font-semibold text-[#214d2f]">$</p>
            <h2 className="mt-2 font-serif text-2xl font-semibold">Guest green fees</h2>
            <p className="mt-3 leading-7 text-[#516050]">
              Discounted green fees for the guests you bring. Details to be announced in April 2027.
            </p>
          </article>
        </section>

        <section className="bg-[#ebe5d7] px-5 py-12 sm:py-16 lg:px-8">
          <div className="mx-auto grid max-w-7xl gap-10 lg:grid-cols-[0.9fr_1.1fr]">
            <div>
              <p className="text-sm font-bold tracking-[0.2em] text-[#8a6f30] uppercase">
                Indoor Golf Coupons
              </p>
              <h2 className="mt-3 font-serif text-3xl font-semibold sm:text-4xl">Hours by membership.</h2>
              <ul className="mt-6 grid gap-2 leading-7 text-[#516050]">
                <li>
                  Coupons are <strong className="text-[#182118]">awarded electronically</strong> once your
                  membership is paid in full.
                </li>
                <li>
                  They <strong className="text-[#182118]">expire December 21, 2026</strong>.
                </li>
                <li>Use them on open Bays #1 &amp; #2 (private Bay #3 excluded).</li>
              </ul>
              <Link
                className="mt-8 inline-block rounded-sm bg-[#214d2f] px-6 py-3 text-sm font-extrabold tracking-[0.12em] text-white uppercase transition hover:bg-[#163820]"
                href={BOOK_INDOOR}
              >
                Reserve a Simulator
              </Link>
            </div>
            <div className="rounded-sm border border-[#d8d1c3] bg-white">
              {couponHours.map((row) => (
                <div
                  className="flex items-baseline justify-between gap-4 border-b border-[#d8d1c3] p-5 last:border-b-0"
                  key={row.name}
                >
                  <span className="font-bold">{row.name}</span>
                  <span className="shrink-0 font-serif text-2xl font-semibold text-[#214d2f]">
                    {row.hours} Hours
                  </span>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="bg-[#214d2f] px-5 py-12 text-white lg:px-8 lg:py-16">
          <div className="mx-auto grid max-w-7xl items-center gap-6 lg:grid-cols-[minmax(0,1fr)_auto]">
            <div>
              <h2 className="font-serif text-3xl font-semibold">Ready to join for 2027?</h2>
              <p className="mt-4 max-w-3xl leading-7 text-[#edf4ec]">
                Apply online, or call the pro shop at{" "}
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
            <div className="flex flex-col gap-3 sm:flex-row">
              <Link
                className="rounded-sm bg-white px-6 py-3 text-center text-sm font-extrabold tracking-[0.12em] text-[#214d2f] uppercase transition hover:bg-[#ebe5d7]"
                href={SITE_MEMBERSHIP_APPLY}
              >
                Apply Online
              </Link>
              <Link
                className="rounded-sm border border-white/70 px-6 py-3 text-center text-sm font-extrabold tracking-[0.12em] text-white uppercase transition hover:bg-white hover:text-[#214d2f]"
                href={SITE_MEMBERSHIPS}
              >
                See Rates
              </Link>
            </div>
          </div>
        </section>
      </main>

      <SiteFooter />
    </div>
  );
}
