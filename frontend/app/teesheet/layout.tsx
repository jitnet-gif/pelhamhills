import { Lato } from "next/font/google";

// 티 시트 글꼴은 Lato — 직원들이 매일 보던 Chronogolf 티 시트와 같은 글꼴이다.
// 앱 전체의 `--font-pretendard` 는 실제로 로드되는 곳이 없어 시스템 글꼴로 떨어지므로,
// 이 화면만이라도 레퍼런스와 같은 글자 모양으로 맞춘다. 굵기는 격자가 쓰는
// font-semibold(600)·font-bold(700)를 Lato 의 700 으로, 본문은 400 으로 받는다.
const lato = Lato({ subsets: ["latin"], weight: ["400", "700", "900"], style: ["normal", "italic"] });

export default function TeeSheetLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <div className={`${lato.className} contents`}>{children}</div>;
}
