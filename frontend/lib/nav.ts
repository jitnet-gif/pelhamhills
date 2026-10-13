/**
 * 사이트 전체의 **경로 지도**. 링크 주소는 여기서만 정한다.
 *
 * 왜 한 곳에 모으는가: 예전에는 사이드바 메뉴 배열이
 * `components/admin/AdminFeaturePage.tsx` 와 `app/teesheet/page.tsx` 두 곳에
 * 각각 복사되어 있었고, 이미 서로 어긋나 있었다(한쪽에만 있는 항목, 다른 주소).
 * 메뉴가 화면마다 다르면 사용자는 "아까 있던 메뉴가 사라졌다" 고 느낀다.
 *
 * ## 세 개의 표면(surface)
 *
 * 이 프로젝트는 한 Next 앱 안에 성격이 다른 세 사이트를 담는다. `output: "export"`
 * (정적 export) 라서 미들웨어도 rewrite 도 없다 — 구분은 **경로**로만 한다.
 *
 * | 표면        | 경로       | 보는 사람            |
 * | ----------- | ---------- | -------------------- |
 * | 공개 사이트 | `/`        | 클럽을 찾아온 방문자 |
 * | 예약 사이트 | `/book/*`  | 예약하려는 고객      |
 * | 어드민      | `/admin/*` | 프로 샵 직원         |
 *
 * 세 표면은 서로의 껍데기(헤더·사이드바)를 공유하지 않는다. 방문자에게 어드민
 * 사이드바가 보이거나, 직원 화면에 마케팅 헤더가 붙으면 안 되기 때문이다.
 * 넘어가는 지점은 명시적인 링크뿐이다 — 공개 사이트의 "Book" 버튼, 어드민
 * 사이드바 맨 위의 클럽 이름(→ 공개 사이트).
 */

/** 사이드바·탭에 쓰는 한 줄짜리 항목. `glyph` 는 장식이라 `aria-hidden` 으로 렌더한다. */
export type NavItem = {
  label: string;
  href: string;
  glyph: string;
};

// ===== 공개 사이트 (pelhamhills.com) ====================================
//
// 홈 한 장에 섹션 앵커로 구성한다. 마케팅 문구가 늘어나기 전까지는 페이지를
// 쪼개 봐야 각 장이 얇아지기만 한다.

export const SITE_HOME = "/";

/** 회원권 요금은 홈 섹션 하나로는 길어서 따로 한 장이다. */
export const SITE_MEMBERSHIPS = "/memberships";

export const siteNav: NavItem[] = [
  { label: "Golf", href: "/#golf", glyph: "⛳" },
  { label: "Memberships", href: SITE_MEMBERSHIPS, glyph: "★" },
  { label: "Pub", href: "/#pub", glyph: "🍽" },
  { label: "Indoor", href: "/#indoor", glyph: "🏌" },
  { label: "Visit", href: "/#visit", glyph: "📍" },
];

// ===== 예약 사이트 (고객용) =============================================

/** 예약 허브. 어느 쪽을 예약할지 아직 안 정한 사람이 오는 자리. */
export const BOOK_HOME = "/book";

/**
 * 두 예약 목적지는 허브를 거치지 않고 바로 가리키는 CTA 가 많아서 상수로 뺀다.
 * `bookNav[0].href` 로 꺼내 쓰는 것은 배열 순서가 바뀌는 순간 조용히 엉뚱한 곳을
 * 가리키므로 문자열을 그대로 쓰는 것보다 오히려 나쁘다.
 */
export const BOOK_TEE_TIME = "/book/tee-time";
export const BOOK_INDOOR = "/book/indoor";
export const BOOK_LOOKUP = "/book/lookup";

export const bookNav: NavItem[] = [
  { label: "Tee Time(Field)", href: BOOK_TEE_TIME, glyph: "⛳" },
  { label: "Simulator(Indoor)", href: BOOK_INDOOR, glyph: "🏌" },
  { label: "My Booking", href: BOOK_LOOKUP, glyph: "🔎" },
];

/**
 * 확인 코드로 예약을 찾는 주소. 정적 export 에는 `generateStaticParams` 없는
 * 동적 세그먼트(`/book/lookup/[code]`)가 존재할 수 없으므로 **쿼리스트링**으로 받는다.
 */
export function lookupHref(code: string): string {
  return `/book/lookup?code=${encodeURIComponent(code)}`;
}

// ===== 어드민 콘솔 ======================================================

export const ADMIN_HOME = "/admin";

/**
 * 코스 지도(홀 점선을 페어웨이 위로 옮기는 편집기). 이 Next 앱이 아니라 GPS 앱
 * (golf-gps-app) 의 화면이다 — 위성 지도·홀 좌표·Leaflet 이 전부 그쪽에 있어서,
 * 여기에 두 번째 지도 스택을 만들지 않고 절대 주소로 넘긴다.
 * `adminNav` 보다 위에 있어야 한다: 배열이 모듈을 읽는 순간 평가되므로 아래에
 * 두면 `const` 를 선언 전에 읽어 ReferenceError 가 난다.
 */
/** 클럽 종합 매출 보고서. 리테일 작업 화면의 "Sales report" 링크도 여기를 가리킨다. */
export const ADMIN_REPORTS = "/admin/reports";

export const GOLF_GPS_MAP_EDITOR = "https://golf-gps-pelhamhills-seven.vercel.app/admin/map";

/**
 * 어드민 사이드바 메뉴. 순서가 곧 화면에 보이는 순서다.
 *
 * 티 시트만 `/admin` 이고 나머지가 `/admin/<slug>` 인 이유: 티 시트가 어드민의
 * 첫 화면이라 별도 slug 를 붙이면 `/admin` 이 갈 곳 없는 주소가 된다.
 */
export const adminNav: NavItem[] = [
  { label: "Tee Sheet", href: "/admin", glyph: "▦" },
  // 프로 샵 계산대. 티 시트에서 담은 그린피를 여기서 받으므로 골프 메뉴에도 둔다(2026-10-12).
  { label: "Pro Shop", href: "/admin/retail", glyph: "🛒" },
  { label: "Tee Times & Pricing", href: "/admin/pricing", glyph: "◉" },
  { label: "Dynamic Pricing", href: "/admin/dynamic-pricing", glyph: "↗" },
  { label: "Events", href: "/admin/events", glyph: "▤" },
  { label: "Customers", href: "/admin/customers", glyph: "●" },
  { label: "Tour Operators", href: "/admin/tour-operators", glyph: "✈" },
  { label: "Promotions", href: "/admin/promotions", glyph: "▶" },
  { label: "Calls & SMS", href: "/admin/calls", glyph: "☏" },
  { label: "Lost & Found", href: "/admin/lost-items", glyph: "?" },
  { label: "Reports", href: ADMIN_REPORTS, glyph: "▥" },
  { label: "Business Intelligence", href: "/admin/business-intelligence", glyph: "◧" },
  { label: "Radar", href: "/admin/radar", glyph: "◎" },
  { label: "Course Map", href: GOLF_GPS_MAP_EDITOR, glyph: "⌖" },
  { label: "Integrations", href: "/admin/integrations", glyph: "⊞" },
  { label: "Settings", href: "/admin/settings", glyph: "⚙" },
  { label: "Staff Guides", href: "/guide", glyph: "▶" },
];

/**
 * 모바일 하단 탭에 올릴 어드민 메뉴. 12개를 전부 탭으로 만들면 글자가 뭉개지므로
 * 프로 샵에서 하루에도 몇 번씩 여는 4개만 남기고 나머지는 서랍(drawer)으로 보낸다.
 *
 * `Retail` 은 여기 있었지만 사이드바에서 빠지면서 함께 빠졌다 (아래 주석 참고) —
 * 이 배열은 `adminNav` 를 걸러 만들기 때문에, 없는 라벨을 남겨 두면 탭이 조용히
 * 3개가 된다.
 */
export const adminQuickNav: NavItem[] = adminNav.filter((item) =>
  ["Tee Sheet", "Customers", "Promotions", "Reports"].includes(item.label),
);

/**
 * 프로 샵 계산대. 골프 메뉴(`adminNav` 의 Pro Shop)와 "Snack Bar & Retail" 사업부 메뉴
 * (아래 `adminDivisions`) 양쪽에 있다.
 */
export const ADMIN_RETAIL = "/admin/retail";

/** 계산대 첫 화면 사용법 — 나레이션 프레젠테이션(`public/guides/register-home/`). 로그인 없이 열린다. */
export const REGISTER_GUIDE = "/guides/register-home/index.html";

/**
 * 직원용 사용 안내 모음. 각 안내는 `public/guides/<slug>/` 에 통째로 둔 정적 HTML 이고,
 * 이 주소는 그 목록 한 장이다(`app/guide/page.tsx`). 로그인 없이 열린다.
 */
export const GUIDE_HOME = "/guide";

/** 스낵바 계산대. 프로 샵 계산대와 Switch Registers 로 오간다. */
export const ADMIN_SNACK_BAR = "/admin/snack-bar";

/** 카메라 스캔 바로가기 — 켜자마자 카메라가 켜진 계산대. 홈 화면에 붙여 두는 주소. */
export const ADMIN_SCAN = "/admin/scan";

/**
 * 사업부(division). 사이드바 맨 위 드롭다운이 이 셋 사이를 오가며 메뉴를 바꿔 끼우고,
 * 그 사업부의 첫 화면(`home`)으로 바로 이동한다.
 *
 * 골프 메뉴는 `adminNav` 를 그대로 쓴다 — 복사하면 다시 두 벌이 된다. 다른 두 사업부는
 * 자기 화면 몇 개와, 사업부를 가리지 않는 공용 화면(Reports 등)을 골프 쪽과 **같은
 * 항목 객체**로 가리킨다.
 */
export type AdminDivision = {
  key: "golf" | "snack-retail" | "simulator";
  label: string;
  /**
   * 드롭다운에서 이 사업부를 고르면 바로 가는 첫 화면. `links[0]` 으로 꺼내지 않고
   * 따로 적는 이유는 `bookNav` 위 주석과 같다 — 배열 순서가 바뀌면 조용히 엉뚱한 곳으로 간다.
   */
  home: string;
  links: NavItem[];
};

const pick = (label: string): NavItem => {
  const item = adminNav.find((entry) => entry.label === label);
  if (!item) throw new Error(`adminNav has no "${label}"`);
  return item;
};

export const adminDivisions: AdminDivision[] = [
  { key: "golf", label: "Golf", home: ADMIN_HOME, links: adminNav },
  {
    key: "snack-retail",
    label: "Snack Bar & Retail",
    home: ADMIN_SNACK_BAR,
    links: [
      { label: "Snack Bar / Bev Cart", href: ADMIN_SNACK_BAR, glyph: "☕" },
      { label: "Pro Shop Retail", href: ADMIN_RETAIL, glyph: "🛒" },
      { label: "Camera Scan", href: ADMIN_SCAN, glyph: "📷" },
      { label: "Register Guide", href: REGISTER_GUIDE, glyph: "▶" },
      { label: "Staff Guides", href: GUIDE_HOME, glyph: "▶" },
      pick("Reports"),
      pick("Integrations"),
    ],
  },
  {
    key: "simulator",
    label: "Indoor Golf Simulator",
    home: "/admin/simulator-sheet",
    links: [
      { label: "Bay Sheet", href: "/admin/simulator-sheet", glyph: "▦" },
      { label: "Online Booking", href: BOOK_INDOOR, glyph: "🏌" },
      pick("Customers"),
      pick("Calls & SMS"),
      pick("Reports"),
    ],
  },
];

/**
 * 지금 주소가 속한 사업부. 여러 사업부에 걸친 공용 화면(Reports 등)은 골프가 먼저다 —
 * 배열 순서가 곧 우선순위.
 */
export function divisionFor(pathname: string | null | undefined): AdminDivision {
  return (
    adminDivisions.find((division) => division.links.some((item) => isActive(pathname, item.href))) ??
    adminDivisions[0]
  );
}

/**
 * 정적 export 는 뒤에 슬래시가 붙은 주소도 같은 페이지로 서빙한다(`cleanUrls`).
 * `usePathname()` 이 돌려주는 값과 메뉴의 `href` 를 그냥 `===` 로 비교하면
 * `/admin/retail/` 에서 활성 표시가 사라지므로, 비교 전에 정규화한다.
 *
 * 접두사 일치를 쓰지 않는 이유: `/admin` 은 모든 어드민 주소의 접두사라
 * 어느 화면에서든 "Tee Sheet" 가 활성으로 보이게 된다. 따라서 정확히 일치할 때만
 * 활성이고, 하위 경로는 각자 자기 항목을 갖는다.
 */
export function isActive(pathname: string | null | undefined, href: string): boolean {
  if (!pathname) return false;

  // 앵커 링크(`/#golf`)는 "페이지"가 아니라 같은 문서 안의 위치다. 프래그먼트를
  // 떼고 비교하면 `siteNav` 네 항목이 홈에서 **전부 동시에 활성**으로 표시된다.
  // 어느 섹션을 보고 있는지는 스크롤 위치로 정해지는 별개의 문제이고,
  // 경로만 아는 이 함수는 답할 수 없다 — 그러니 답하는 척하지 않는다.
  if (href.includes("#")) return false;

  const trim = (value: string) => {
    const [path] = value.split(/[?#]/, 1);
    return path.length > 1 ? path.replace(/\/+$/, "") : path;
  };
  return trim(pathname) === trim(href);
}

// ===== 클럽 정보 ========================================================
//
// 전화번호·주소가 공개 사이트 / 예약 실패 안내 / 어드민 푸터 세 곳에 나온다.
// 번호가 바뀌었을 때 세 곳을 따로 고치면 반드시 한 곳이 남는다.

export const CLUB = {
  name: "Pelham Hills Golf Club",
  shortName: "Pelham Hills",
  address: "196 Webber Road, Welland, ON L3B 5N9",
  /** 우편 주소 전체. 영수증 머리글이 쓴다 — 클럽이 쓰던 Lightspeed 영수증(2026-09-15)의 표기 그대로. */
  mailingAddress: ["196 Webber Road", "Welland, Ontario, L3B 5N9", "Canada"],
  phone: "+1 (249) 805-0556",
  phoneHref: "tel:+12498050556",
  email: "info@pelhamhills.com",
  emailHref: "mailto:info@pelhamhills.com",
  established: "Established 1966 · Niagara Region",
} as const;
