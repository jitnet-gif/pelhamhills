/**
 * 한/영 화면 전환 엔진(2026-10-24). 이 파일은 GPS 앱(golf-gps-pelhamhills-seven,
 * `frontend/src/lib/i18n/engine.ts`)에도 **똑같이** 들어 있다 — 고치면 둘 다 고친다.
 *
 * 왜 화면(DOM)을 바꾸나: 화면 문구가 파일 130여 개에 흩어져 있고(영어 원문 + 로그인 같은 일부 한국어),
 * 그걸 전부 `t("...")` 로 감싸면 화면마다 큰 수정이 된다. 대신 React 가 그린 글자를 사전으로
 * 바꿔 끼운다. 입력칸의 값·고객 이름·금액처럼 사전에 없는 글자는 그대로 둔다.
 *
 * - `ko` 모드: 영어 문구 → 한국어 (사전 `KO`)
 * - `en` 모드: 한국어 문구 → 영어 (사전 `EN`) — 원래 한국어로 쓰인 화면도 영어로 보인다.
 *
 * 노드마다 원문을 기억해서(WeakMap) 언제든 되돌린다. React 가 글자를 새로 쓰면 그것이 새 원문이 된다.
 * 사전 키의 `{0}` `{1}` 은 템플릿 자리 — 그 자리에 든 글자도 사전에 있으면 함께 바꾼다.
 * 번역하지 말아야 할 부분은 `translate="no"` 또는 `data-no-translate` 를 붙인다.
 */

export type Lang = "en" | "ko";
export type Dict = Record<string, string>;

const STORAGE_KEY = "pelham-lang";
const EVENT = "pelham-lang-change";
const ATTRS = ["placeholder", "title", "aria-label", "alt"] as const;
const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "TEXTAREA", "INPUT", "CODE", "PRE", "NOSCRIPT"]);

/** 언어를 달리 쓰는 다른 앱(GPS 지도 등)으로 가는 링크에는 `?lang=` 을 붙여 같은 언어로 열리게 한다. */
const PARTNER_HOSTS = [/golf-gps-pelhamhills/i, /pelhamhills\.(ca|com)$/i];

type Pattern = { re: RegExp; out: string; hint: string };
type Compiled = { exact: Map<string, string>; patterns: Pattern[]; memo: Map<string, string> };

const compiled: Partial<Record<Lang, Compiled>> = {};
let lang: Lang = "en";
let observer: MutationObserver | null = null;
const textSrc = new WeakMap<Text, { src: string; out: string }>();
const attrSrc = new WeakMap<Element, Map<string, { src: string; out: string }>>();

function squash(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 사전 키는 소스에서 뽑아 `&apos;` 같은 JSX 기호가 남아 있다. 화면에는 풀린 글자로 그려지므로 풀어서 맞춘다. */
const ENTITIES: Record<string, string> = {
  apos: "'", quot: '"', amp: "&", lsquo: "\u2018", rsquo: "\u2019", ldquo: "\u201c", rdquo: "\u201d",
  middot: "·", mdash: "—", ndash: "–", nbsp: " ", hellip: "…", times: "×", rarr: "→", larr: "←", bull: "•",
};
function decode(s: string): string {
  return s.replace(/&([a-z]+);/g, (m, n: string) => ENTITIES[n] ?? m);
}

function compile(dict: Dict): Compiled {
  const exact = new Map<string, string>();
  const patterns: Pattern[] = [];
  for (const [rawFrom, rawTo] of Object.entries(dict)) {
    const from = decode(rawFrom);
    const to = decode(rawTo);
    if (!to) continue;
    if (!/\{\d\}/.test(from)) {
      exact.set(squash(from), to);
      continue;
    }
    const parts = from.split(/\{\d\}/);
    const order = [...from.matchAll(/\{(\d)\}/g)].map((m) => m[1]);
    // 자리표시자를 차례대로 1,2,… 캡처로 바꾸고, 결과 문장의 {n} 은 원래 번호로 찾아 넣는다.
    const last = parts.length - 1;
    const re = new RegExp(
      "^" +
        parts
          .map((p, i) => {
            let q = p.replace(/\s+/g, " ");
            if (i === 0) q = q.trimStart();
            if (i === last) q = q.trimEnd();
            return escapeRe(q);
          })
          .join("(.+?)") +
        "$",
      "s",
    );
    const hint = parts.reduce((a, b) => (b.trim().length > a.length ? b.trim() : a), "");
    if (!hint) continue; // "{0}{1}" 처럼 고정 글자가 없는 것은 아무 글자나 먹으므로 쓰지 않는다.
    let out = to;
    order.forEach((n, i) => {
      out = out.split(`{${n}}`).join(`\u0000${i + 1}\u0000`);
    });
    patterns.push({ re, out, hint });
  }
  patterns.sort((a, b) => b.hint.length - a.hint.length);
  return { exact, patterns, memo: new Map() };
}

function lookup(core: string, c: Compiled): string | null {
  const hit = c.exact.get(core);
  if (hit !== undefined) return hit;
  if (c.memo.has(core)) return c.memo.get(core)!;
  let result: string | null = null;
  for (const p of c.patterns) {
    if (!core.includes(p.hint)) continue;
    const m = p.re.exec(core);
    if (!m) continue;
    result = p.out.replace(/\u0000(\d+)\u0000/g, (_, i) => {
      const part = m[Number(i)] ?? "";
      return c.exact.get(squash(part)) ?? part;
    });
    break;
  }
  if (c.memo.size > 5000) c.memo.clear();
  c.memo.set(core, result as string);
  return result;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS: Record<string, string> = { sun: "일", mon: "월", tue: "화", wed: "수", thu: "목", fri: "금", sat: "토" };
const DATE_RE =
  /^(?:(Sun|Mon|Tue|Wed|Thu|Fri|Sat)[a-z]*\.?,?\s+)?(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?$/;

/** 'Saturday, October 24, 2026' · 'Sat, Oct 24' 같은 날짜(toLocaleDateString)는 사전 대신 규칙으로. */
function dateToKo(core: string): string | null {
  const m = DATE_RE.exec(core);
  if (!m) return null;
  const month = MONTHS.indexOf(m[2].toLowerCase()) + 1;
  const day = m[1] ? ` (${DAYS[m[1].toLowerCase()]})` : "";
  return `${m[4] ? `${m[4]}년 ` : ""}${month}월 ${m[3]}일${day}`;
}

/** 문자열 하나를 지금 언어로. 앞뒤 공백은 그대로 둔다. */
export function translateText(s: string, to: Lang = lang): string {
  const c = compiled[to];
  if (!c || !s) return s;
  const core = squash(s);
  if (!core || !/[A-Za-z가-힣]/.test(core)) return s;
  const hit = lookup(core, c) ?? (to === "ko" ? dateToKo(core) : null);
  if (hit === null || hit === undefined) return s;
  const lead = s.match(/^\s*/)![0];
  const trail = s.match(/\s*$/)![0];
  return (lead ? " " : "") + hit + (trail ? " " : "");
}

function skipped(el: Element | null): boolean {
  for (let e = el; e; e = e.parentElement) {
    if (SKIP_TAGS.has(e.tagName)) return true;
    if (e.getAttribute("translate") === "no" || e.hasAttribute("data-no-translate")) return true;
    if ((e as HTMLElement).isContentEditable) return true;
  }
  return false;
}

function doText(t: Text) {
  const cur = t.nodeValue ?? "";
  const rec = textSrc.get(t);
  const src = rec && cur === rec.out ? rec.src : cur;
  if (!rec && !/[A-Za-z가-힣]/.test(cur)) return;
  const parent = t.parentElement;
  if (skipped(parent)) return;
  // value 가 없는 <option> 은 글자가 곧 값이라 바꾸면 고른 값이 달라진다.
  if (parent?.tagName === "OPTION" && !parent.hasAttribute("value")) return;
  const out = translateText(src);
  textSrc.set(t, { src, out });
  if (out !== cur) t.nodeValue = out;
}

function doAttrs(el: Element) {
  for (const name of ATTRS) {
    if (!el.hasAttribute(name)) continue;
    const cur = el.getAttribute(name) ?? "";
    let map = attrSrc.get(el);
    const rec = map?.get(name);
    const src = rec && cur === rec.out ? rec.src : cur;
    const out = translateText(src);
    if (!map) attrSrc.set(el, (map = new Map()));
    map.set(name, { src, out });
    if (out !== cur) el.setAttribute(name, out);
  }
}

function walk(root: Node) {
  if (root.nodeType === Node.TEXT_NODE) return doText(root as Text);
  if (root.nodeType !== Node.ELEMENT_NODE) return;
  const el = root as Element;
  if (skipped(el)) return;
  doAttrs(el);
  const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
    acceptNode: (n) =>
      n.nodeType === Node.ELEMENT_NODE && (SKIP_TAGS.has((n as Element).tagName) || (n as Element).getAttribute("translate") === "no" || (n as Element).hasAttribute("data-no-translate"))
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  });
  for (let n = tw.nextNode(); n; n = tw.nextNode()) {
    if (n.nodeType === Node.TEXT_NODE) doText(n as Text);
    else doAttrs(n as Element);
  }
}

export function getLang(): Lang {
  return lang;
}

/** 처음 언어: 주소의 `?lang=` → 이 브라우저에 기억된 값 → 영어. */
function initialLang(): Lang {
  try {
    const q = new URLSearchParams(window.location.search).get("lang");
    if (q === "ko" || q === "en") {
      localStorage.setItem(STORAGE_KEY, q);
      return q;
    }
    return localStorage.getItem(STORAGE_KEY) === "ko" ? "ko" : "en";
  } catch {
    return "en";
  }
}

export function setLang(next: Lang) {
  lang = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* 사생활 보호 창 — 이번 탭에서만 바뀐다 */
  }
  document.documentElement.lang = next;
  if (document.body) walk(document.body);
  window.dispatchEvent(new CustomEvent(EVENT, { detail: next }));
}

export function toggleLang() {
  setLang(lang === "ko" ? "en" : "ko");
}

/** 언어가 바뀔 때마다 부른다. 반환값은 해제 함수. */
export function onLangChange(fn: (l: Lang) => void): () => void {
  const h = (e: Event) => fn((e as CustomEvent<Lang>).detail);
  window.addEventListener(EVENT, h);
  return () => window.removeEventListener(EVENT, h);
}

function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el) return false;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable;
}

/**
 * 엔진을 켠다. 여러 번 불러도 한 번만 켜진다.
 * `ko` 는 크니까 필요할 때 불러오는 함수로 받는다.
 */
export function startI18n(dicts: { en: Dict; ko: () => Promise<Dict> }) {
  if (observer || typeof window === "undefined") return;
  compiled.en = compile(dicts.en);
  lang = initialLang();
  document.documentElement.lang = lang;

  let koLoad: Promise<void> | null = null;
  const ensureKo = () =>
    (koLoad ??= dicts.ko().then((d) => {
      compiled.ko = compile(d);
    }));
  const apply = () => {
    if (lang === "ko" && !compiled.ko) {
      ensureKo().then(() => walk(document.body));
      return;
    }
    walk(document.body);
  };
  window.addEventListener(EVENT, () => {
    if (lang === "ko" && !compiled.ko) ensureKo().then(() => walk(document.body));
  });

  observer = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === "characterData") doText(r.target as Text);
      else if (r.type === "attributes") {
        if (!skipped(r.target as Element)) doAttrs(r.target as Element);
      } else r.addedNodes.forEach((n) => (n.nodeType === Node.TEXT_NODE ? doText(n as Text) : walk(n)));
    }
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: [...ATTRS],
  });
  apply();
  // 처음 언어를 버튼들에게 알린다(주소의 ?lang= 이나 기억된 값이 영어가 아닐 수 있다).
  window.dispatchEvent(new CustomEvent(EVENT, { detail: lang }));

  // alert/confirm/prompt 의 문구도 같은 사전으로.
  const w = window as Window & { __pelhamI18nDialogs?: boolean };
  if (!w.__pelhamI18nDialogs) {
    w.__pelhamI18nDialogs = true;
    const { alert, confirm, prompt } = window;
    window.alert = (m?: unknown) => alert.call(window, typeof m === "string" ? translateText(m) : m);
    window.confirm = (m?: string) => confirm.call(window, m === undefined ? m : translateText(m));
    window.prompt = (m?: string, d?: string) => prompt.call(window, m === undefined ? m : translateText(m), d);
  }

  // 한/영 키(윈도우 한국어 자판의 HangulMode/Lang1). 글자를 치는 중이면 입력기 전환이라 건드리지 않는다.
  window.addEventListener("keydown", (e) => {
    if ((e.key === "HangulMode" || e.code === "Lang1") && !isTypingTarget(e.target)) toggleLang();
  });

  // 다른 앱(GPS 지도)으로 넘어갈 때 같은 언어로 열리게.
  document.addEventListener(
    "click",
    (e) => {
      const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || a.host === window.location.host || !PARTNER_HOSTS.some((h) => h.test(a.hostname))) return;
      const u = new URL(a.href);
      u.searchParams.set("lang", lang);
      a.href = u.toString();
    },
    true,
  );
}
