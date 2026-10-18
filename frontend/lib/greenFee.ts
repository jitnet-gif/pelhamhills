/**
 * 홀 수별 1인 그린피(세전). 9홀은 그날 18홀 요금의 절반, 센트에서 반올림한다.
 * DB 의 `pelham_tee_rate_for`(0033)와 같은 값이어야 한다 — 화면이 미리 보여 주는 금액과
 * 예약에 실제로 적히는 금액이 달라지지 않게. 요금을 바꾸면 두 곳을 같이 고쳐라.
 */
export function greenFeeFor(rate18: number, holes: 9 | 18): number {
  return holes === 9 ? Math.round(Math.round(rate18 * 100) / 2) / 100 : rate18;
}
