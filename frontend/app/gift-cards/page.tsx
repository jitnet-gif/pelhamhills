/**
 * 기프트카드 온라인 판매. 화면 틀은 서버 컴포넌트, 입력은 `GiftCardForm`(클라이언트)이다.
 */

import type { Metadata } from "next";

import GiftCardForm from "@/components/site/GiftCardForm";
import SiteFooter from "@/components/site/SiteFooter";
import SiteHeader from "@/components/site/SiteHeader";
import { CLUB } from "@/lib/nav";

export const metadata: Metadata = {
  title: `Gift Cards | ${CLUB.name}`,
  description:
    "Buy a Pelham Hills gift card online. Good for green fees, the pro shop and the snack bar. Sent by email and text right after you pay.",
};

export default function GiftCardsPage() {
  return (
    <div className="min-h-dvh bg-[#f7f4ed] text-[#182118]">
      <SiteHeader />

      <main>
        <section className="bg-[#214d2f] px-5 py-14 text-white sm:py-16 lg:px-8">
          <div className="mx-auto max-w-3xl">
            <h1 className="font-serif text-4xl font-semibold sm:text-5xl">Gift Cards</h1>
            <p className="mt-4 text-lg leading-8">
              Good for green fees, the pro shop and the snack bar. Pay online and the gift certificate comes by email
              and the barcode by text, right away.
            </p>
          </div>
        </section>

        <section className="px-5 py-12 sm:py-16 lg:px-8">
          <div className="mx-auto max-w-3xl">
            <GiftCardForm />
            <p className="mt-10 border-t border-[#d8d1c3] pt-5 text-sm leading-6 text-[#516050]">
              Show the barcode at the counter, on your phone or printed. Any amount left stays on the card. Not
              redeemable for cash. Anyone with the barcode can spend it, so keep it safe. Questions? Call{" "}
              <a className="font-bold text-[#214d2f] underline" href={CLUB.phoneHref}>
                {CLUB.phone}
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
