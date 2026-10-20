// 플레이어 톤(색)의 단일 소유자.
//
// 왜 별도 파일인가: 일간 시트(WeekGrid 의 day 브랜치)와 예약 상세 패널이
// 같은 플레이어를 서로 다른 색으로 그리면 사용자는 "다른 예약"으로 오해한다.
// 그래서 색 판정 규칙은 오직 여기 한 곳에만 둔다. 화면 쪽에서는 절대
// ratePlan / type 을 다시 들여다보고 색을 고르지 않는다.
//
// 색 체계가 두 개라는 점을 반드시 기억할 것:
//   1) `booking.color` ("blue" | "gold" | "gray") 는 여전히 **주간 뷰**의
//      COLOR_CLASS 막대 색을 결정한다. 이건 예약 단위 색이다.
//   2) **일간 시트**에서는 셀 배경이 플레이어 단위 톤(아래 PlayerTone)이고,
//      톤은 거의 전부 player.ratePlan(요금제 이름 = 회원 등급)으로 정한다.
//      booking.color 중에서는 "blue" 만 의미가 있다 — 퍼블릭 요금 손님이
//      GolfNow 같은 외부 온라인 채널로 들어왔다는 표시. "gold"/"gray" 는 무시된다.
// 다음 사람이 두 체계를 헷갈리지 않도록 여기 명시해 둔다.

import type { Player, TeeBooking } from "@/lib/teeSheet/types";

/** 프로 샵이 정한 일간 시트 색 범례 (2026-10-19). */
export type PlayerTone =
  | "publicJunior" // green
  | "employee" // purple
  | "intermediate" // teal
  | "weekday" // light pink
  | "full" // dark pink
  | "public" // yellow
  | "golfnow" // dark blue
  | "nineHole" // blue
  | "senior" // light blue
  | "twilight"; // brown

/**
 * 요금제 이름(대소문자 무시)으로 판정한다. 위에서 먼저 맞는 것이 이긴다:
 *   1. "golfnow"                         → golfnow
 *   2. "staff" / "employee"              → employee
 *   3. "junior"                          → publicJunior (Junior Member 도 같은 초록)
 *   4. "senior"                          → senior
 *   5. "twilight"                        → twilight
 *   6. "9 hole" / "nine hole" / "9-hole" → nineHole
 *   7. "intermediate"                    → intermediate
 *   8. "weekday"                         → weekday
 *   9. "full"                            → full
 *  10. 그 밖의 "member"                   → weekday (연분홍 = 일반 회원)
 *  11. 나머지(Public·Guest·빈 값)          → booking.color 가 "blue" 면 golfnow, 아니면 public
 *
 * 등급 단어를 "member" 보다 먼저 보는 이유: "Twilight Member", "9 Hole Member" 처럼
 * 회원 요금제 이름에 등급이 들어 있다(backend customer_store `_MEMBER_TIERS` 와 같은 목록).
 * 회원이 GolfNow 로 잡은 예약이라도 회원 색이 우선이다 — 결제 주체가 회원 계정이기 때문.
 */
export function playerTone(booking: TeeBooking, player: Player): PlayerTone {
  const plan = (player.ratePlan ?? "").trim().toLowerCase();
  if (plan.includes("golfnow") || plan.includes("golf now")) return "golfnow";
  if (plan.includes("staff") || plan.includes("employee")) return "employee";
  if (plan.includes("junior")) return "publicJunior";
  if (plan.includes("senior")) return "senior";
  if (plan.includes("twilight")) return "twilight";
  if (/\b(9|nine)[ -]?hole/.test(plan)) return "nineHole";
  if (plan.includes("intermediate")) return "intermediate";
  if (plan.includes("weekday")) return "weekday";
  if (plan.startsWith("full")) return "full";
  if (plan.includes("member")) return "weekday";
  return booking.color === "blue" ? "golfnow" : "public";
}

/** 범례 순서·이름. 화면에 범례를 그릴 때 이 목록을 쓴다. */
export const TONE_LABEL: Record<PlayerTone, string> = {
  full: "Full member",
  weekday: "Weekday member",
  intermediate: "Intermediate member",
  nineHole: "9-hole member",
  twilight: "Twilight member",
  employee: "Employee",
  public: "Public tee time",
  golfnow: "GolfNow (public)",
  senior: "Senior public",
  publicJunior: "Public junior",
};

/** Tailwind 가 스캔할 수 있도록 리터럴로 둔다. */
export const TONE_CLASS: Record<PlayerTone, string> = {
  publicJunior: "bg-[#2e9d4f] text-white",
  employee: "bg-[#7a3fc8] text-white",
  intermediate: "bg-[#139a96] text-white",
  weekday: "bg-[#f3c1d8] text-[#2b1f27]",
  full: "bg-[#d6219b] text-white",
  public: "bg-[#ffd400] text-[#1d232b]",
  golfnow: "bg-[#0b2a7a] text-white",
  nineHole: "bg-[#2f7de1] text-white",
  senior: "bg-[#a8d8f5] text-[#11283a]",
  twilight: "bg-[#8a5a2b] text-white",
};

/** 플레이어가 죽은 상태(취소/노쇼)인지 — 셀에 취소선을 그을지 결정한다. */
export function isDeadPlayer(player: Player): boolean {
  return player.cancelled || player.no_show;
}

/**
 * 이름 표기는 Chronogolf 방식인 `Lastname, Firstname`.
 * 이름 없는 자리는 격자에서 "Guest" 를 이탤릭으로 — 아직 신원이 없는 자리라는 뜻이다.
 * type "Guest" 라도 이름이 있으면 이름을 보인다(온라인 예약의 대표자가 그렇다).
 *
 * 이름이 하나도 없으면 "Guest" 다. 예전에는 "Player" 였는데, 이름 없는 자리를
 * 부르는 말이 화면마다 달라졌다 — 서버도(`pelham_tee_name`) 빈 이름을 "Guest" 로
 * 채우고, 격자의 Guest 칸도 그렇게 읽는다. 한 단어로 통일한다.
 */
export function playerLabel(player: Player): string {
  const last = player.lastName.trim();
  const first = player.firstName.trim();
  if (last && first) return `${last}, ${first}`;
  return last || first || player.name.trim() || GUEST_NAME;
}

/** 이름이 없는 자리를 부르는 이름. 서버의 `pelham_tee_name` 과 같은 값이어야 한다. */
export const GUEST_NAME = "Guest";

/**
 * 격자 막대(주간 뷰)에 찍히는 예약 이름. 대표자(첫 플레이어) 이름을 그대로 쓴다.
 *
 * 예약의 `title` 은 서버 필수값이라 만들 때 한 번 정해지는데, 그 뒤 상세 패널에서
 * 이름을 고쳐도 자동으로 따라가지 않는다(서버에 동기화 규칙이 없다). 그래서
 * "지금 이름이라면 title 이 무엇이어야 하는가" 를 이 함수 하나로 정해 두고,
 * 상세 패널이 이름을 저장할 때 같은 값으로 title 도 맞춘다.
 */
export function reservationTitle(players: Player[]): string {
  const lead = players[0];
  return lead ? playerLabel(lead) : GUEST_NAME;
}
