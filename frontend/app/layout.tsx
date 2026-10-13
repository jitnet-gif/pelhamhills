import type { Metadata, Viewport } from "next";
import "./globals.css";

import ManagerApprovalHost from "@/components/pos/ManagerApprovalHost";

export const metadata: Metadata = {
  title: {
    default: "Pelham Hills Golf Club - Golf, Pub, and Indoor Simulators",
    template: "%s · Pelham Hills Golf Club",
  },
  description:
    "Pelham Hills Golf Club offers an 18-hole parkland course, clubhouse dining, and indoor golf simulators in Welland, Ontario.",
  applicationName: "Pelham Hills",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    // 홈 화면에서 띄웠을 때 사파리 크롬 없이 앱처럼 열리게 한다.
    capable: true,
    title: "Pelham Hills",
    statusBarStyle: "black-translucent",
  },
  icons: {
    icon: [
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
};

/**
 * 모바일 대응의 출발점. 이 뷰포트 선언이 없으면 안드로이드·iOS 브라우저가
 * 페이지를 980px 짜리 데스크톱으로 렌더한 뒤 축소해서 보여 준다 — `sm:` 브레이크포인트를
 * 아무리 붙여도 **한 번도 발동하지 않고** 글자만 작아진다.
 *
 * `viewport-fit=cover` 는 노치 있는 기기에서 화면 끝까지 그리게 하고, 대신 안전 영역은
 * `env(safe-area-inset-*)` 로 각 컴포넌트가 직접 확보한다(예: 어드민 하단 탭).
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  // 확대를 막지 않는다. `maximum-scale=1` 은 저시력 사용자에게서 확대 기능을
  // 빼앗는 접근성 문제라, 손가락 오조작을 막자고 쓸 만한 값이 아니다.
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#214d2f" },
    { media: "(prefers-color-scheme: dark)", color: "#111315" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className="min-h-screen w-full bg-bepu-bg text-bepu-text antialiased selection:bg-bepu-mint/30 selection:text-bepu-text"
      >
        {children}
        {/* 환불·레인체크·선수 삭제의 매니저 PIN 창(0024). 직원 화면 어디서든 뜬다. */}
        <ManagerApprovalHost />
      </body>
    </html>
  );
}
