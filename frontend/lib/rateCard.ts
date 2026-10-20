/**
 * 2026 요금표 — Lightspeed(Chronogolf) 관리자의 활성 요금표를 그대로 옮긴 것(2026-10-19 클럽 승인,
 * https://claude.ai/artifact/E4hw145aCiExyuuaUHcjjC). 세전 달러, HST 13% 별도.
 *
 * 티 시트가 실제로 받는 값은 DB 가 매긴다(0045 `pelham_tee_rate_cards`·`pelham_tee_rate_bands`·
 * `pelham_tee_plan_fee`·`pelham_tee_cart_fee_on`). 이 파일은 요금 안내 화면(/golf/rates,
 * /admin/pricing)이 보여 주는 사본이다. DB 에서 요금을 바꾸면 이 파일도 같이 고쳐라.
 */

export type RateBand = { from: string; rate: number };

export type RateCard = {
  code: string;
  name: string;
  /** 언제 쓰이는 표인가. */
  applies: string;
  bands: RateBand[];
  /** 9홀 1인 요금과 판매 시작. null 이면 9홀 없음. */
  nine: { rate: number; from: string } | null;
};

export const RATE_CARDS: RateCard[] = [
  {
    code: "weekday_shoulder",
    name: "Weekday Shoulder",
    applies: "Mon – Fri · Oct 1 – Dec 15 and Apr 26 – May 7",
    bands: [
      { from: "Open", rate: 40.71 },
      { from: "2:00 PM", rate: 35.4 },
    ],
    nine: { rate: 28.31, from: "10:00 AM" },
  },
  {
    code: "weekend_shoulder",
    name: "Weekend Shoulder",
    applies: "Sat & Sun · Oct 1 – Dec 15 and Apr 26 – May 7",
    bands: [
      { from: "Open", rate: 51.33 },
      { from: "2:00 PM", rate: 46.02 },
    ],
    nine: { rate: 38.94, from: "4:00 PM" },
  },
  {
    code: "weekday",
    name: "Weekday 2026",
    applies: "Mon – Thu · May 8 – Sep 30",
    bands: [
      { from: "Open", rate: 47.79 },
      { from: "2:00 PM", rate: 38.94 },
      { from: "5:00 PM", rate: 34.52 },
    ],
    nine: { rate: 34.52, from: "10:00 AM" },
  },
  {
    code: "friday",
    name: "Weekend Friday's / Holiday",
    applies: "Fri · May 8 – Sep 30, plus Civic Holiday, Labour Day, Thanksgiving",
    bands: [
      { from: "Open", rate: 58.41 },
      { from: "2:00 PM", rate: 46.9 },
      { from: "5:00 PM", rate: 39.94 },
    ],
    nine: { rate: 35.4, from: "4:00 PM" },
  },
  {
    code: "weekend",
    name: "Weekend 2026",
    applies: "Sat & Sun · May 8 – Sep 30, plus Canada Day",
    bands: [
      { from: "Open", rate: 58.41 },
      { from: "2:00 PM", rate: 46.9 },
      { from: "5:00 PM", rate: 38.94 },
    ],
    nine: { rate: 35.4, from: "4:00 PM" },
  },
  {
    code: "june_friday",
    name: "WE June Friday's",
    applies: "Fridays in June",
    bands: [
      { from: "Open", rate: 58.41 },
      { from: "12:00 PM", rate: 49.56 },
      { from: "5:00 PM", rate: 38.94 },
    ],
    nine: { rate: 35.4, from: "4:00 PM" },
  },
  {
    code: "sixty",
    name: "60th Anniversary Special",
    applies: "Mon – Thu · Jun 25 – 30, 2026",
    bands: [
      { from: "Open", rate: 47.79 },
      { from: "1:00 PM", rate: 38.94 },
      { from: "5:00 PM", rate: 34.52 },
    ],
    nine: { rate: 34.52, from: "10:00 AM" },
  },
  {
    code: "victoria",
    name: "Victoria Day",
    applies: "Victoria Day",
    bands: [
      { from: "Open", rate: 47.79 },
      { from: "2:00 PM", rate: 38.94 },
    ],
    nine: { rate: 34.52, from: "10:00 AM" },
  },
];

/** 요금제(회원 등급)별 1인 그린피·카트 규칙. 문구는 직원·손님 화면에 그대로 쓴다. */
export const RATE_PLAN_RULES: { plan: string; greenFee: string; cart: string }[] = [
  { plan: "Public · GolfNow", greenFee: "Rate card price", cart: "$19.47 (18) · $11.50 (9)" },
  {
    plan: "Public Senior",
    greenFee: "$40.71 (18) · $30.97 (9), or the rate card if lower · weekend shoulder: rate card",
    cart: "Weekdays $17.70 (18) · $9.74 (9); weekends $19.47 · $11.50",
  },
  {
    plan: "Public Junior",
    greenFee: "$35.40 before 2 PM ($34.40 weekends), $32.75 from 2 PM · $25.67 (9)",
    cart: "$19.47 (18) · $11.50 (9)",
  },
  { plan: "Friends & Family", greenFee: "$44.25 (18) · $22.12 (9)", cart: "$19.47 (18) · $11.50 (9)" },
  { plan: "LS League", greenFee: "$45.00 (18) all day", cart: "$19.47 (18) · $11.50 (9)" },
  {
    plan: "Full · Corporate · Intermediate · Restricted · Weekday · Junior Member",
    greenFee: "$0",
    cart: "\"7 Day Cart\" $0 · \"Weekday Cart\" $0 on weekdays · otherwise $19.47 / $11.50",
  },
  { plan: "9 Hole Member", greenFee: "$0 weekdays · weekends 9 holes from 4 PM $0, otherwise rate card", cart: "Per membership" },
  { plan: "Twilight Member", greenFee: "$0 from 3 PM, rate card before 3 PM", cart: "Per membership" },
  { plan: "Pelham Staff", greenFee: "$0 · weekends & holidays from 4 PM, rate card before", cart: "Per membership" },
];

export const HST_RATE = 0.13;

/** 세전 → HST 포함(센트 반올림). */
export function withHst(rate: number): number {
  return Math.round(rate * (1 + HST_RATE) * 100) / 100;
}
