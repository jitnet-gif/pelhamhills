import type { Metadata, Viewport } from "next";

/**
 * 설치형 직원 앱 "Pelham Staff". 루트 manifest 는 손님 예약 앱이라 `/book` 으로 열린다 —
 * 맥·아이패드에서 어드민을 설치하면 예약 화면이 뜨던 것을 여기서 덮어쓴다.
 * 범위는 `/` 다. 어드민 메뉴의 계산대 링크(`/pos/*`)로 나가도 앱 창 안에 머문다.
 */
export const metadata: Metadata = {
  title: { default: "Pelham Staff", template: "%s · Pelham Staff" },
  applicationName: "Pelham Staff",
  manifest: "/admin.webmanifest",
  appleWebApp: { capable: true, title: "Pelham Staff", statusBarStyle: "black-translucent" },
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#111315",
};

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return children;
}
