/**
 * 공개 사이트의 홈. pelhamhills.com 을 찾아온 방문자가 처음 보는 화면이다.
 *
 * **서버 컴포넌트로 둔다.** 문구와 이미지뿐이라 클라이언트에서 할 일이 없다.
 * 상태가 필요한 곳은 헤더의 햄버거 하나뿐이고, 그건 `SiteHeader` 안에 갇혀 있다.
 * 여기에 `"use client"` 를 붙이면 홈 전체가 번들에 실린다.
 */

import Link from "next/link";

import SiteFooter from "@/components/site/SiteFooter";
import SiteHeader from "@/components/site/SiteHeader";
import { clubHours } from "@/components/site/clubHours";
import { BOOK_INDOOR, BOOK_TEE_TIME, CLUB, SITE_GOLF_RATES, SITE_MEMBERSHIPS } from "@/lib/nav";

/**
 * 앵커 섹션이 sticky 헤더에 가리지 않게 하는 여백. 헤더 높이(`SiteHeader` 의
 * `h-14 sm:h-[72px]`)와 짝이다 — 없으면 `#golf` 로 점프했을 때 제목 줄이
 * 헤더 밑에 숨는다.
 */
const ANCHOR_OFFSET = "scroll-mt-14 sm:scroll-mt-[72px]";

const highlights = [
  {
    title: "18-Hole Parkland Course",
    body: "Rolling terrain, mature trees, and natural water features create a memorable round in the Niagara Region.",
  },
  {
    title: "Pelham Hills Pub",
    body: "Our restaurant is temporarily closed, but the pub remains open and we look forward to welcoming you.",
  },
  {
    title: "Indoor Golf Year-Round",
    body: "Play iconic virtual courses with modern swing data and comfortable simulator bays through every season.",
  },
];

const quickLinks = [
  { label: "Book a Tee-Time", href: BOOK_TEE_TIME, external: false },
  { label: "View Memberships", href: SITE_MEMBERSHIPS, external: false },
  { label: "Reserve Indoor Golf", href: BOOK_INDOOR, external: false },
  { label: "Contact the Club", href: "/#visit", external: false },
];

export default function Home() {
  return (
    // `layout.tsx` 의 body 는 다른 크림색(#FFF9F0)이라, 감싸는 상자가 자기 배경을
    // 칠하지 않으면 오버스크롤할 때 다른 색이 비친다.
    <div className="min-h-dvh bg-[#f7f4ed] text-[#182118]">
      <SiteHeader />

      <main>
        {/* 히어로. 높이 계산은 한 곳(이 section)에만 있다 — 안쪽 그리드에도
            같은 calc 를 적어 두면 헤더 높이를 바꿀 때 한쪽만 고치게 된다. */}
        <section className="relative grid min-h-[calc(100dvh-56px)] content-center overflow-hidden sm:min-h-[calc(100dvh-72px)]">
          <div
            className="absolute inset-0 bg-cover bg-center"
            style={{ backgroundImage: "url('/pelham-hills/hero-course.png')" }}
          />
          <div className="absolute inset-0 bg-gradient-to-r from-[#10170f]/82 via-[#10170f]/48 to-[#10170f]/18" />
          <div className="relative mx-auto w-full max-w-7xl px-5 py-14 sm:py-16 lg:px-8">
            <div className="max-w-3xl text-white">
              <p className="mb-5 text-sm font-bold tracking-[0.22em] text-[#d6c28f] uppercase">
                {CLUB.established}
              </p>
              <h1 className="font-serif text-5xl leading-[1.02] font-semibold sm:text-6xl lg:text-7xl">
                Play golf and dine year-round at Pelham Hills.
              </h1>
              <p className="mt-6 max-w-2xl text-lg leading-8 text-[#f2efe8] sm:text-xl">
                An 18-hole parkland-style course in Welland, Ontario with a welcoming clubhouse,
                scenic views, and indoor golf when the weather turns.
              </p>
              <div className="mt-9 flex flex-col gap-3 sm:flex-row">
                <Link
                  className="rounded-sm bg-[#d6c28f] px-6 py-3 text-center text-sm font-extrabold tracking-[0.12em] text-[#182118] uppercase transition hover:bg-[#ead7a1]"
                  href={BOOK_TEE_TIME}
                >
                  Book a Tee-Time
                </Link>
                <a
                  className="rounded-sm border border-white/70 px-6 py-3 text-center text-sm font-extrabold tracking-[0.12em] text-white uppercase transition hover:bg-white hover:text-[#182118]"
                  href="/#visit"
                >
                  Plan Your Visit
                </a>
              </div>
            </div>
          </div>
        </section>

        {/* 바로가기 줄. 390px 에서 4칸을 유지하면 글자가 두 줄로 접히고 과녁이
            좁아진다 — 1 → 2 → 4 칸으로 벌린다. */}
        <section className="border-y border-[#d8d1c3] bg-white">
          <div className="mx-auto grid max-w-7xl gap-px bg-[#d8d1c3] sm:grid-cols-2 md:grid-cols-4">
            {quickLinks.map((link) =>
              link.external ? (
                <a
                  className="bg-white px-5 py-5 text-sm font-extrabold tracking-[0.12em] text-[#214d2f] uppercase transition hover:bg-[#eef1e8]"
                  href={link.href}
                  key={link.label}
                  rel="noreferrer"
                  target="_blank"
                >
                  {link.label}
                </a>
              ) : (
                <Link
                  className="bg-white px-5 py-5 text-sm font-extrabold tracking-[0.12em] text-[#214d2f] uppercase transition hover:bg-[#eef1e8]"
                  href={link.href}
                  key={link.label}
                >
                  {link.label}
                </Link>
              ),
            )}
          </div>
        </section>

        {/* 예약 안내 밴드. 여기 있던 "Booking Automation / Tee-Sniper" 설명은
            내부 도구 이야기라 방문자 홈페이지에서 뺐다 — 방문자가 알아야 할 것은
            "무엇으로 만들었는가" 가 아니라 "어디를 눌러야 예약이 되는가" 다. */}
        <section className="bg-[#214d2f] px-5 py-12 text-white lg:px-8 lg:py-16">
          <div className="mx-auto grid max-w-7xl items-center gap-6 lg:grid-cols-[minmax(0,1fr)_auto]">
            <div>
              <p className="text-sm font-bold tracking-[0.2em] text-[#d6c28f] uppercase">
                Reservations
              </p>
              <h2 className="mt-3 font-serif text-3xl font-semibold">Book in a couple of taps.</h2>
              <p className="mt-4 max-w-3xl leading-7 text-[#edf4ec]">
                Reserve a tee time on the course or a bay in PH Indoor Golf online, any time. Prefer
                to talk it through? Call the pro shop at{" "}
                <a className="font-bold text-[#d6c28f]" href={CLUB.phoneHref}>
                  {CLUB.phone}
                </a>
                .
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1">
              <Link
                className="rounded-sm bg-white px-6 py-3 text-center text-sm font-extrabold tracking-[0.12em] text-[#214d2f] uppercase transition hover:bg-[#ebe5d7]"
                href={BOOK_TEE_TIME}
              >
                Book a Tee-Time
              </Link>
              <Link
                className="rounded-sm border border-white/70 px-6 py-3 text-center text-sm font-extrabold tracking-[0.12em] text-white uppercase transition hover:bg-white hover:text-[#214d2f]"
                href={BOOK_INDOOR}
              >
                Reserve Indoor Golf
              </Link>
            </div>
          </div>
        </section>

        <section className="mx-auto grid max-w-7xl gap-10 px-5 py-12 sm:py-20 lg:grid-cols-[0.8fr_1.2fr] lg:px-8">
          <div>
            <p className="text-sm font-bold tracking-[0.2em] text-[#8a6f30] uppercase">The Club</p>
            <h2 className="mt-3 font-serif text-4xl font-semibold text-[#182118]">
              Classic Niagara golf, refreshed for modern play.
            </h2>
          </div>
          <div className="grid gap-5 md:grid-cols-3">
            {highlights.map((item) => (
              <article
                className="rounded-sm border border-[#d8d1c3] bg-[#fbfaf6] p-6"
                key={item.title}
              >
                <h3 className="font-serif text-2xl font-semibold">{item.title}</h3>
                <p className="mt-4 leading-7 text-[#516050]">{item.body}</p>
              </article>
            ))}
          </div>
        </section>

        <section className={`grid lg:grid-cols-2 ${ANCHOR_OFFSET}`} id="golf">
          <div
            className="min-h-[280px] bg-cover bg-center sm:min-h-[420px]"
            style={{ backgroundImage: "url('/pelham-hills/course-detail.png')" }}
          />
          <div className="bg-[#214d2f] px-5 py-12 text-white sm:px-10 sm:py-16 lg:px-16">
            <p className="text-sm font-bold tracking-[0.2em] text-[#d6c28f] uppercase">Golf</p>
            <h2 className="mt-3 font-serif text-4xl font-semibold">
              A scenic round for every player.
            </h2>
            <p className="mt-5 max-w-xl text-lg leading-8 text-[#edf4ec]">
              The course balances approachable play with shot-making variety, framed by trees,
              water features, and the relaxed pace of a community club.
            </p>
            <Link
              className="mt-8 inline-block rounded-sm bg-white px-5 py-3 text-sm font-extrabold tracking-[0.12em] text-[#214d2f] uppercase"
              href={SITE_GOLF_RATES}
            >
              See Rates
            </Link>
          </div>
        </section>

        <section
          className={`mx-auto grid max-w-7xl gap-8 px-5 py-12 sm:py-20 lg:grid-cols-2 lg:px-8 ${ANCHOR_OFFSET}`}
          id="pub"
        >
          <div>
            <p className="text-sm font-bold tracking-[0.2em] text-[#8a6f30] uppercase">
              Pelham Hills Pub
            </p>
            <h2 className="mt-3 font-serif text-4xl font-semibold">
              Restaurant Temporarily Closed | Pub Remains Open
            </h2>
          </div>
          <p className="text-lg leading-8 text-[#516050]">
            Our restaurant is temporarily closed as we explore exciting plans for the future. In the
            meantime, our pub remains open, and we look forward to welcoming you!
          </p>
        </section>

        <section
          className={`bg-[#ebe5d7] px-5 py-12 sm:py-20 lg:px-8 ${ANCHOR_OFFSET}`}
          id="indoor"
        >
          <div className="mx-auto grid max-w-7xl items-center gap-8 lg:grid-cols-[minmax(0,1fr)_0.9fr] lg:gap-10">
            <div>
              <p className="text-sm font-bold tracking-[0.2em] text-[#8a6f30] uppercase">
                PH Indoor Golf
              </p>
              <h2 className="mt-3 font-serif text-4xl font-semibold">
                Rain, snow, or shine, it is golf season.
              </h2>
              <p className="mt-5 max-w-2xl text-lg leading-8 text-[#516050]">
                Simulator bays make it easy to keep playing, practice with real-time data, and enjoy
                iconic courses without leaving the clubhouse.
              </p>
            </div>
            <Link
              className="rounded-sm bg-[#214d2f] px-6 py-4 text-center text-sm font-extrabold tracking-[0.12em] text-white uppercase transition hover:bg-[#163820]"
              href={BOOK_INDOOR}
            >
              Reserve a Simulator
            </Link>
          </div>
        </section>

        <section
          className={`mx-auto grid max-w-7xl gap-10 px-5 py-12 sm:py-20 lg:grid-cols-[0.9fr_1.1fr] lg:px-8 ${ANCHOR_OFFSET}`}
          id="visit"
        >
          <div>
            <p className="text-sm font-bold tracking-[0.2em] text-[#8a6f30] uppercase">Visit</p>
            <h2 className="mt-3 font-serif text-4xl font-semibold">{CLUB.address}</h2>
            <p className="mt-5 text-lg leading-8 text-[#516050]">
              Call{" "}
              <a className="font-bold text-[#214d2f]" href={CLUB.phoneHref}>
                {CLUB.phone}
              </a>{" "}
              or email{" "}
              <a className="font-bold text-[#214d2f]" href={CLUB.emailHref}>
                {CLUB.email}
              </a>
              .
            </p>
          </div>
          {/* 트랙을 `1fr` 대신 `minmax(0,1fr)` 로 못박는다. `1fr` 은 minmax(auto,1fr)
              이라 내용의 min-content 아래로 줄지 못하고, 긴 영업시간 문자열이
              좁은 화면에서 칸을 밀어낸다. */}
          <div className="rounded-sm border border-[#d8d1c3] bg-white">
            {clubHours.map((item) => (
              <div
                className="grid gap-1 border-b border-[#d8d1c3] p-5 last:border-b-0 sm:grid-cols-[180px_minmax(0,1fr)] sm:gap-2"
                key={item.label}
              >
                <span className="font-bold text-[#182118]">{item.label}</span>
                <span className="min-w-0 text-[#516050]">{item.value}</span>
              </div>
            ))}
          </div>
        </section>
      </main>

      <SiteFooter />
    </div>
  );
}
