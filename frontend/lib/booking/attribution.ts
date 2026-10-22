/**
 * 웹 예약의 유입 경로(0067). 손님이 사이트에 들어온 입구를 브라우저에 잡아 두었다가, 예약이 끝나면
 * `pelham_booking_attribution_save` 로 그 예약에 붙인다. Reports 의 Bookings 탭이 "Google search",
 * "Google Ads", "Facebook / Instagram", "Direct" 같은 이름표로 보여 준다(이름표는 SQL 이 정한다).
 *
 * - 이번 방문의 입구(sessionStorage): 탭을 연 뒤 처음 본 페이지의 리퍼러·utm·광고 클릭 표시.
 * - 처음 온 날의 입구(localStorage, 30일): 같은 칸 + 시각. 검색으로 처음 보고 며칠 뒤 직접 와서 예약한 경우를 위해.
 * 저장소가 막힌 브라우저(사생활 보호 창 등)에서는 조용히 아무것도 남기지 않는다 — 예약은 그대로 된다.
 *
 * 개인 정보는 담지 않는다: 리퍼러는 호스트 이름만(검색어가 든 전체 주소는 버린다), 광고 클릭은 id 값이 아니라 종류만.
 */

import { bookingRpc } from "@/lib/booking/rpc";

export type Visit = {
  referrer_host: string | null;
  landing: string;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_term: string | null;
  click_id: "google" | "microsoft" | "facebook" | null;
  at: string;
};

const SESSION_KEY = "ph_visit";
const FIRST_KEY = "ph_first_visit";
const FIRST_DAYS = 30;

/** 직원 화면에서는 잡지 않는다 — 직원 브라우저의 "Direct" 가 손님 기록에 섞이지 않게. */
const STAFF_PREFIXES = [
  "/admin", "/teesheet", "/pos", "/cash", "/reports", "/retail", "/snack-bar", "/simulator-sheet", "/scan",
  "/settings", "/customers", "/marketing", "/calls",
];

function read(storage: () => Storage, key: string): Visit | null {
  try {
    const raw = storage().getItem(key);
    return raw ? (JSON.parse(raw) as Visit) : null;
  } catch {
    return null;
  }
}

function write(storage: () => Storage, key: string, visit: Visit) {
  try {
    storage().setItem(key, JSON.stringify(visit));
  } catch {
    // 저장소가 막혔다. 남기지 않는다.
  }
}

function currentVisit(): Visit {
  const params = new URLSearchParams(window.location.search);
  let host: string | null = null;
  try {
    if (document.referrer) {
      const from = new URL(document.referrer);
      if (from.host !== window.location.host) host = from.hostname.toLowerCase();
    }
  } catch {
    host = null;
  }
  const get = (name: string) => params.get(name)?.trim().slice(0, 120) || null;
  const click: Visit["click_id"] =
    params.has("gclid") || params.has("gbraid") || params.has("wbraid")
      ? "google"
      : params.has("msclkid")
        ? "microsoft"
        : params.has("fbclid")
          ? "facebook"
          : null;
  return {
    referrer_host: host,
    landing: window.location.pathname.slice(0, 200),
    utm_source: get("utm_source"),
    utm_medium: get("utm_medium"),
    utm_campaign: get("utm_campaign"),
    utm_term: get("utm_term"),
    click_id: click,
    at: new Date().toISOString(),
  };
}

/** 모든 페이지가 열릴 때 한 번(`VisitTracker`). 이번 방문의 입구는 처음 것만, 단 새 광고·utm 링크로 다시 오면 바꾼다. */
export function captureVisit() {
  if (typeof window === "undefined") return;
  if (STAFF_PREFIXES.some((prefix) => window.location.pathname.startsWith(prefix))) return;
  const visit = currentVisit();
  const tagged = Boolean(visit.referrer_host || visit.utm_source || visit.click_id);

  const session = read(() => window.sessionStorage, SESSION_KEY);
  if (!session || tagged) write(() => window.sessionStorage, SESSION_KEY, visit);

  const first = read(() => window.localStorage, FIRST_KEY);
  const expired = first ? Date.now() - new Date(first.at).getTime() > FIRST_DAYS * 86_400_000 : true;
  if (expired) write(() => window.localStorage, FIRST_KEY, visit);
}

/** 예약이 끝난 직후. 실패해도 손님 화면에는 아무것도 띄우지 않는다. */
export function recordBookingSource(kind: "tee" | "bay", confirmationCode: string | null | undefined) {
  if (typeof window === "undefined" || !confirmationCode) return;
  const visit = read(() => window.sessionStorage, SESSION_KEY) ?? currentVisit();
  const first = read(() => window.localStorage, FIRST_KEY);
  bookingRpc<boolean>("pelham_booking_attribution_save", {
    p_kind: kind,
    p_code: confirmationCode,
    p: { ...visit, first_touch: first, user_agent: navigator.userAgent.slice(0, 300) },
  }).catch(() => undefined);
}
