/**
 * 회원권 안내. 예전에는 이 사이트에 없어서 홈과 푸터가 옛 pelhamhills.com 으로 내보냈다.
 *
 * 내용은 pelhamhills.com/memberships (2027 "Early Bird", 2026-10-06 확인) 를 옮긴 것이다.
 * 결제 방법·환불/이월 규정·완납 후 쿠폰 지급은 클럽의 요금표 PDF(v3, 2026-09-14) 2쪽 신청서와
 * Early Bird 혜택 안내문(Final_2027)에서 옮겼다(2026-10-19).
 * 가격은 계산하지 않고 **원문 표기 그대로** 문자열로 둔다 — 클럽이 요율을 바꾸면 원문과
 * 한 줄씩 대조해서 고치게 된다. 신청서·혜택 안내 파일은 클럽이 원본을 관리하므로 복사하지
 * 않는다. 두 버튼은 사이트 안의 하위 페이지(온라인 신청서·Early Bird 안내)로 간다(2026-10-19).
 *
 * 서버 컴포넌트다. 홈(`app/page.tsx`)과 같은 이유로 `"use client"` 를 붙이지 마라.
 */

import type { Metadata } from "next";
import Link from "next/link";

import SiteFooter from "@/components/site/SiteFooter";
import SiteHeader from "@/components/site/SiteHeader";
import {
  BOOK_INDOOR,
  BOOK_TEE_TIME,
  CLUB,
  SITE_MEMBERSHIP_APPLY,
  SITE_MEMBERSHIP_EARLY_BIRD,
} from "@/lib/nav";

export const metadata: Metadata = {
  title: `Memberships | ${CLUB.name}`,
  description:
    "2027 Early Bird membership rates at Pelham Hills Golf Club — full, weekday, intermediate, 9-hole, twilight and junior memberships, power cart packages and driving range passes.",
};


/** `spousal` 이 없는 회원권은 원문에도 칸이 비어 있다(개인 전용). */
const memberships: { name: string; access: string; single: string; spousal?: string }[] = [
  { name: "Full Membership", access: "Play anytime · Driving range included", single: "$3,051.00", spousal: "$5,152.80" },
  {
    name: "Weekday Membership",
    access: "Weekdays anytime / Excludes Holidays",
    single: "$2,316.50",
    spousal: "$3,955.00",
  },
  { name: "Intermediate Membership", access: "Ages 18–35, play anytime", single: "$2,316.50" },
  {
    name: "9-Hole Membership",
    access: "Weekdays Only after 10:00 AM / Excludes Holidays",
    single: "$1,638.50",
    spousal: "$2,881.50",
  },
  {
    name: "Twilight Membership",
    access: "After 3:00pm including Weekends",
    single: "$1,638.50",
    spousal: "$2,881.50",
  },
  {
    name: "Junior Membership (17 yrs & Under)",
    access: "Weekdays after 11:00am / Weekend & Holidays after 2:00pm",
    single: "$565.00",
  },
];

const simulatorHours = [
  { name: "Full Membership", hours: "10 Hours" },
  { name: "Weekdays & Intermediate Membership", hours: "8 Hours" },
  { name: "9-Holes & Twilight Membership", hours: "6 Hours" },
];
const SIMULATOR_COUPON_EXPIRES = "Dec. 21, 2026";

const cartPackages = [
  { name: "Unlimited 7-Day (1/2 Cart)", price: "$1,850.00", note: "Valid for 18-holes" },
  {
    name: "Unlimited Weekday (1/2 Cart)",
    price: "$1,350.00",
    note: "Valid for 18-holes; excludes holidays",
  },
  { name: "18-Hole Member Rate (1/2 Cart)", price: "$20.00", note: "Per 18 holes" },
  { name: "9-Hole Member Rate (1/2 Cart)", price: "$11.00", note: "Per 9 holes" },
];

/** 신청서 2쪽의 결제 수단. 순서도 원문 그대로. */
const paymentMethods = [
  { name: "Cheque", detail: "Payable to \u201cPelham Hills Golf\u201d only \u2014 do not add \u201cClub\u201d, \u201cCourse\u201d or anything else." },
  { name: "Credit Card", detail: "An additional 3% is charged on credit card payments." },
  { name: "Interac e-Transfer", detail: "Send to info@pelhamhills.com." },
  { name: "Cash", detail: "At the pro shop." },
];

/** 의료 사유일 때만. 원문 표 두 개 그대로. */
const refundRates = [
  { when: "Before the season opening", rate: "100% except admin fee ($150)" },
  { when: "On or before May 15", rate: "60%" },
  { when: "On or before June 15", rate: "30%" },
  { when: "On or after June 16", rate: "0%" },
];
const carryOverRates = [
  { when: "Before the season opening", rate: "100% with admin fee ($150)" },
  { when: "On or before June 30", rate: "50%" },
  { when: "On or before July 31", rate: "30%" },
  { when: "On or after August 1", rate: "Can\u2019t carry over" },
];

const rangePasses = [
  { name: "Members", price: "$395.50" },
  { name: "Non-Members", price: "$508.50" },
];

export default function MembershipsPage() {
  return (
    <div className="min-h-dvh bg-[#f7f4ed] text-[#182118]">
      <SiteHeader />

      <main>
        <section className="bg-[#214d2f] px-5 py-14 text-white sm:py-20 lg:px-8">
          <div className="mx-auto max-w-7xl">
            <p className="text-sm font-bold tracking-[0.2em] text-[#d6c28f] uppercase">
              Memberships
            </p>
            <h1 className="mt-3 max-w-3xl font-serif text-4xl leading-tight font-semibold sm:text-5xl">
              Membership options for every golfer.
            </h1>
            <p className="mt-5 max-w-2xl text-lg leading-8 text-[#edf4ec]">
              Enjoy access to golf, practice facilities, dining, and indoor golf simulators at{" "}
              {CLUB.name}.
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <Link
                className="rounded-sm bg-[#d6c28f] px-6 py-3 text-center text-sm font-extrabold tracking-[0.12em] text-[#182118] uppercase transition hover:bg-[#ead7a1]"
                href={SITE_MEMBERSHIP_APPLY}
              >
                Membership Application
              </Link>
              <Link
                className="rounded-sm border border-white/70 px-6 py-3 text-center text-sm font-extrabold tracking-[0.12em] text-white uppercase transition hover:bg-white hover:text-[#214d2f]"
                href={SITE_MEMBERSHIP_EARLY_BIRD}
              >
                Early Bird Benefits
              </Link>
            </div>
          </div>
        </section>

        <section className="mx-auto max-w-7xl px-5 py-12 sm:py-16 lg:px-8">
          <p className="text-sm font-bold tracking-[0.2em] text-[#8a6f30] uppercase">
            2027 Membership
          </p>
          <h2 className="mt-3 font-serif text-3xl font-semibold sm:text-4xl">
            &ldquo;Early Bird&rdquo; promo rates
          </h2>
          <p className="mt-4 max-w-3xl leading-7 text-[#516050]">
            All prices include HST and reflect &ldquo;Early Bird&rdquo; membership rates, which are
            subject to change without notice. Annual &ldquo;Early Bird&rdquo; rates are available{" "}
            <strong className="text-[#182118]">September 15 to November 15, 2026</strong>, and
            &ldquo;Early Bird&rdquo; membership fees must be paid in full by{" "}
            <strong className="text-[#182118]">November 15, 2026</strong>. No exceptions or
            extensions will be permitted.
          </p>

          {/* 표 대신 카드 목록: 390px 폭에서 4열 표는 접근 조건 문장이 한 단어씩 접힌다.
              sm 이상에서는 같은 카드가 4열 격자로 펴져 표처럼 읽힌다. */}
          <div className="mt-8 overflow-hidden rounded-sm border border-[#d8d1c3] bg-white">
            <div className="hidden grid-cols-[minmax(0,1.1fr)_minmax(0,1.4fr)_8rem_8rem] gap-4 border-b border-[#d8d1c3] bg-[#ebe5d7] px-5 py-3 text-xs font-bold tracking-[0.16em] text-[#516050] uppercase sm:grid">
              <span>Membership Type</span>
              <span>Access</span>
              <span className="text-right">Single</span>
              <span className="text-right">Spousal</span>
            </div>
            {memberships.map((m) => (
              <div
                className="grid gap-2 border-b border-[#d8d1c3] px-5 py-5 last:border-b-0 sm:grid-cols-[minmax(0,1.1fr)_minmax(0,1.4fr)_8rem_8rem] sm:items-center sm:gap-4"
                key={m.name}
              >
                <h3 className="font-serif text-xl font-semibold">{m.name}</h3>
                <p className="text-[#516050]">{m.access}</p>
                <p className="flex justify-between gap-4 sm:block sm:text-right">
                  <span className="text-sm text-[#516050] sm:hidden">Single</span>
                  <span className="font-bold tabular-nums">{m.single}</span>
                </p>
                <p className="flex justify-between gap-4 sm:block sm:text-right">
                  <span className="text-sm text-[#516050] sm:hidden">Spousal</span>
                  <span className="font-bold tabular-nums">
                    {m.spousal ?? (
                      <span className="font-normal text-[#8a8f86]" aria-label="Not offered">
                        —
                      </span>
                    )}
                  </span>
                </p>
              </div>
            ))}
          </div>
        </section>

        <section className="bg-[#ebe5d7] px-5 py-12 sm:py-16 lg:px-8">
          <div className="mx-auto grid max-w-7xl gap-10 lg:grid-cols-[0.9fr_1.1fr]">
            <div>
              <p className="text-sm font-bold tracking-[0.2em] text-[#8a6f30] uppercase">
                Early Bird Benefits
              </p>
              <h2 className="mt-3 font-serif text-3xl font-semibold sm:text-4xl">
                Join early, play more.
              </h2>
              <ul className="mt-6 grid gap-3 text-lg leading-8 text-[#516050]">
                <li>
                  <strong className="text-[#182118]">14-day advance</strong> tee time reservations
                </li>
                <li>
                  <strong className="text-[#182118]">Free golf simulator</strong> hourly coupons
                </li>
                <li>
                  <strong className="text-[#182118]">Discounted green fees</strong> for your guests
                  (details in April 2027)
                </li>
              </ul>
              <Link
                className="mt-8 inline-block rounded-sm bg-[#214d2f] px-6 py-3 text-sm font-extrabold tracking-[0.12em] text-white uppercase transition hover:bg-[#163820]"
                href={BOOK_INDOOR}
              >
                Reserve a Simulator
              </Link>
            </div>
            <div>
              <div className="rounded-sm border border-[#d8d1c3] bg-white">
                {simulatorHours.map((row) => (
                  <div
                    className="flex items-baseline justify-between gap-4 border-b border-[#d8d1c3] p-5 last:border-b-0"
                    key={row.name}
                  >
                    <span className="font-bold">{row.name}</span>
                    <span className="shrink-0 font-serif text-2xl font-semibold text-[#214d2f]">
                      {row.hours}
                    </span>
                  </div>
                ))}
              </div>
              <p className="mt-3 text-sm leading-6 text-[#516050]">
                Coupons are sent electronically once your membership is paid in full, and expire{" "}
                {SIMULATOR_COUPON_EXPIRES}. Available on Bays #1 &amp; #2 (VIP Bay #3 excluded).
              </p>
            </div>
          </div>
        </section>

        <section className="mx-auto grid max-w-7xl gap-10 px-5 py-12 sm:py-16 lg:grid-cols-2 lg:px-8">
          <div>
            <p className="text-sm font-bold tracking-[0.2em] text-[#8a6f30] uppercase">
              Power Cart Packages
            </p>
            <h2 className="mt-3 font-serif text-3xl font-semibold">Ride all season.</h2>
            <p className="mt-3 text-[#516050]">Available for member purchase only.</p>
            <div className="mt-6 rounded-sm border border-[#d8d1c3] bg-white">
              {cartPackages.map((row) => (
                <div
                  className="flex items-start justify-between gap-4 border-b border-[#d8d1c3] p-5 last:border-b-0"
                  key={row.name}
                >
                  <div className="min-w-0">
                    <p className="font-bold">{row.name}</p>
                    <p className="mt-1 text-sm text-[#516050]">{row.note}</p>
                  </div>
                  <span className="shrink-0 font-bold tabular-nums">{row.price}</span>
                </div>
              ))}
            </div>
          </div>

          <div>
            <p className="text-sm font-bold tracking-[0.2em] text-[#8a6f30] uppercase">
              Driving Range Membership
            </p>
            <h2 className="mt-3 font-serif text-3xl font-semibold">Practice every day.</h2>
            <p className="mt-3 text-[#516050]">Two large buckets per day. Prices include HST.</p>
            <div className="mt-6 rounded-sm border border-[#d8d1c3] bg-white">
              {rangePasses.map((row) => (
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

        <section className="bg-[#ebe5d7] px-5 py-12 sm:py-16 lg:px-8">
          <div className="mx-auto grid max-w-7xl gap-10 lg:grid-cols-[0.9fr_1.1fr]">
            <div>
              <p className="text-sm font-bold tracking-[0.2em] text-[#8a6f30] uppercase">How to Join</p>
              <h2 className="mt-3 font-serif text-3xl font-semibold sm:text-4xl">Apply and pay by Nov 15.</h2>
              <p className="mt-4 leading-7 text-[#516050]">
                Fill in the{" "}
                <Link className="font-bold text-[#214d2f] underline" href={SITE_MEMBERSHIP_APPLY}>
                  online membership application
                </Link>{" "}
                with your membership category, name(s), address, cellphone and email. The pro shop will
                confirm it and arrange payment in full by{" "}
                <strong className="text-[#182118]">November 15, 2026</strong>.
              </p>
            </div>
            <div className="rounded-sm border border-[#d8d1c3] bg-white">
              {paymentMethods.map((row) => (
                <div className="border-b border-[#d8d1c3] p-5 last:border-b-0" key={row.name}>
                  <p className="font-bold">{row.name}</p>
                  <p className="mt-1 text-sm text-[#516050]">{row.detail}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="mx-auto max-w-7xl px-5 py-12 sm:py-16 lg:px-8">
          <p className="text-sm font-bold tracking-[0.2em] text-[#8a6f30] uppercase">Membership Policies</p>
          <h2 className="mt-3 font-serif text-3xl font-semibold sm:text-4xl">Before you sign up.</h2>
          <ul className="mt-6 grid max-w-3xl gap-3 leading-7 text-[#516050]">
            <li>
              Memberships are <strong className="text-[#182118]">non-refundable and non-transferable</strong>{" "}
              except for medical reasons.
            </li>
            <li>A maximum of 36 holes of golf per day is permitted with a golf membership.</li>
            <li>
              A membership can be refunded or carried over to the next season{" "}
              <strong className="text-[#182118]">only for a medical issue</strong>, with a doctor&rsquo;s note
              stating that you are unable to golf. The amount depends on when you stop playing:
            </li>
          </ul>
          <div className="mt-8 grid gap-6 lg:grid-cols-2">
            {[
              { title: "Refund", head: "Refund rate", rows: refundRates },
              { title: "Carry over to next season", head: "Credit toward next season", rows: carryOverRates },
            ].map((table) => (
              <div key={table.title}>
                <h3 className="font-serif text-xl font-semibold">{table.title}</h3>
                <div className="mt-3 rounded-sm border border-[#d8d1c3] bg-white">
                  <div className="flex justify-between gap-4 border-b border-[#d8d1c3] bg-[#ebe5d7] px-5 py-3 text-xs font-bold tracking-[0.16em] text-[#516050] uppercase">
                    <span>Stopped playing</span>
                    <span className="text-right">{table.head}</span>
                  </div>
                  {table.rows.map((row) => (
                    <div
                      className="flex items-baseline justify-between gap-4 border-b border-[#d8d1c3] px-5 py-4 last:border-b-0"
                      key={row.when}
                    >
                      <span>{row.when}</span>
                      <span className="text-right font-bold">{row.rate}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="bg-[#214d2f] px-5 py-12 text-white lg:px-8 lg:py-16">
          <div className="mx-auto grid max-w-7xl items-center gap-6 lg:grid-cols-[minmax(0,1fr)_auto]">
            <div>
              <h2 className="font-serif text-3xl font-semibold">Questions about membership?</h2>
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
            <Link
              className="rounded-sm bg-white px-6 py-3 text-center text-sm font-extrabold tracking-[0.12em] text-[#214d2f] uppercase transition hover:bg-[#ebe5d7]"
              href={BOOK_TEE_TIME}
            >
              Book a Tee-Time
            </Link>
          </div>
        </section>
      </main>

      <SiteFooter />
    </div>
  );
}
