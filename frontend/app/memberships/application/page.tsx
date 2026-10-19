/**
 * 온라인 회원권 신청. 예전에는 회원권 첫 장의 "Membership Application" 버튼이 옛 사이트의 요금표 PDF 로
 * 내보냈고, 손님은 그것을 인쇄해 들고 와야 했다. 이제 여기서 내면 프로 샵 명부(`/admin/memberships`)에
 * 바로 들어간다. 종이로 내고 싶은 손님을 위해 PDF 링크는 남긴다.
 *
 * 화면 틀은 서버 컴포넌트, 입력은 `MembershipApplicationForm`(클라이언트)이다.
 */

import type { Metadata } from "next";
import Link from "next/link";

import MembershipApplicationForm from "@/components/site/MembershipApplicationForm";
import SiteFooter from "@/components/site/SiteFooter";
import SiteHeader from "@/components/site/SiteHeader";
import { CLUB, SITE_MEMBERSHIPS, SITE_MEMBERSHIP_EARLY_BIRD } from "@/lib/nav";

export const metadata: Metadata = {
  title: `Membership Application | ${CLUB.name}`,
  description:
    "Apply online for a 2027 Pelham Hills Golf Club membership at Early Bird rates. Pay in full by November 15, 2026.",
};

/** 클럽이 관리하는 종이 신청서(요금표 PDF 2쪽). */
const APPLICATION_PDF =
  "https://pelhamhills.com/wp-content/uploads/sites/216/2026/09/Pelham_Hills_2027_Rates.pdf";

export default function MembershipApplicationPage() {
  return (
    <div className="min-h-dvh bg-[#f7f4ed] text-[#182118]">
      <SiteHeader />

      <main>
        <section className="bg-[#214d2f] px-5 py-14 text-white sm:py-16 lg:px-8">
          <div className="mx-auto max-w-3xl">
            <Link className="text-sm font-bold text-[#d6c28f] hover:underline" href={SITE_MEMBERSHIPS}>
              ← Memberships
            </Link>
            <p className="mt-6 text-sm font-bold tracking-[0.2em] text-[#d6c28f] uppercase">
              2027 Membership · Early Bird
            </p>
            <h1 className="mt-3 font-serif text-4xl leading-tight font-semibold sm:text-5xl">
              Membership application.
            </h1>
            <p className="mt-5 text-lg leading-8 text-[#edf4ec]">
              Apply in a few minutes. The pro shop will confirm your membership and arrange payment, which is
              due in full by <strong className="text-white">November 15, 2026</strong>.{" "}
              <Link className="font-bold text-[#d6c28f] underline" href={SITE_MEMBERSHIP_EARLY_BIRD}>
                See Early Bird benefits
              </Link>
              .
            </p>
          </div>
        </section>

        <section className="mx-auto max-w-3xl px-5 py-12 sm:py-16 lg:px-8">
          <MembershipApplicationForm />
          <p className="mt-8 text-sm leading-6 text-[#516050]">
            Prefer paper?{" "}
            <a className="font-bold text-[#214d2f] underline" href={APPLICATION_PDF} rel="noreferrer" target="_blank">
              Download the printable application (PDF)
            </a>{" "}
            and bring it to the pro shop. Questions? Call{" "}
            <a className="font-bold text-[#214d2f]" href={CLUB.phoneHref}>
              {CLUB.phone}
            </a>{" "}
            or email{" "}
            <a className="font-bold text-[#214d2f]" href={CLUB.emailHref}>
              {CLUB.email}
            </a>
            .
          </p>
        </section>
      </main>

      <SiteFooter />
    </div>
  );
}
