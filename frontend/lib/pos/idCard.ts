/**
 * 운전면허증 뒷면 바코드(PDF417, AAMVA 형식)에서 이름·생년월일만 꺼낸다.
 *
 * 카운터 스캐너(DS2208)는 바코드 내용을 키보드처럼 쳐 넣는다. 내용은 `@` 로 시작하고, 줄마다
 * 세 글자 표시 + 값이다 — `DCS` 성, `DAC` 이름, `DBB` 생년월일, `DAQ` 면허 번호, `DAG` 주소 …
 * 줄바꿈은 스캐너가 Enter·Ctrl 키로 보내므로 `useBarcodeScanner` 가 `\n` 으로 모아 준다.
 *
 * 면허 번호·주소는 **읽지 않는다** — 여기서 돌려주는 것은 이름과 생년월일뿐이고, 원문은 어디에도 남기지 않는다.
 * 생년월일: 미국은 MMDDCCYY, 캐나다(온타리오 포함)는 CCYYMMDD — 앞 네 자리가 연도로 읽히면 캐나다 순서다.
 */

export type IdCard = {
  firstName: string;
  lastName: string;
  /** YYYY-MM-DD */
  dateOfBirth: string;
};

/** 스캔이 면허증 바코드인가. AAMVA 는 `@` 로 시작하고 앞쪽에 `ANSI ` 나 `AAMVA` 가 있다. */
export function isIdCardScan(raw: string): boolean {
  return raw.startsWith("@") && /ANSI ?\d|AAMVA/.test(raw.slice(0, 40));
}

/** "PARK" → "Park", "O'BRIEN" → "O'Brien", "MARY-ANN" → "Mary-Ann". */
function nameCase(value: string): string {
  return value
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase()
    .replace(/(^|[\s'-])(\p{L})/gu, (_, sep: string, letter: string) => sep + letter.toUpperCase());
}

function isoDate(digits: string): string | null {
  if (!/^\d{8}$/.test(digits)) return null;
  const head = Number(digits.slice(0, 4));
  const [y, m, d] =
    head >= 1900 && head <= 2100
      ? [digits.slice(0, 4), digits.slice(4, 6), digits.slice(6, 8)]
      : [digits.slice(4, 8), digits.slice(0, 2), digits.slice(2, 4)];
  const date = new Date(`${y}-${m}-${d}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== `${y}-${m}-${d}`) return null;
  return `${y}-${m}-${d}`;
}

/**
 * 세 글자 표시 → 값. 줄바꿈이 있으면 줄 머리에서 읽는다.
 * 줄바꿈이 없으면(스캐너가 제어 문자를 버린 경우) 표시와 이름 글자를 가를 수 없다 — "JORDAN" 의 "DAN" 도
 * 표시다. 그때는 표준 순서(DCS 성 → DAC 이름 → DAD 가운데 이름)와 숫자뿐인 DBB 만 믿는다. 틀린 이름을
 * 넣느니 못 읽는 편이 낫다.
 */
function fields(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  const text = raw.replace(/\r\n?/g, "\n");
  if (/\n/.test(text.slice(1))) {
    // 첫 하위 파일은 머리줄 끝의 "DL"/"ID" 바로 뒤에서 시작한다(…DLDCAJ).
    for (const match of text.matchAll(/(?:^|\n|DL|ID)(D[A-Z]{2})([^\n]*)/g)) {
      if (!out.has(match[1])) out.set(match[1], match[2].trim());
    }
    return out;
  }
  const last = /DCS(.+?)DAC/.exec(text);
  const first = /DAC(.+?)DAD/.exec(text);
  const born = /DBB(\d{8})/.exec(text);
  if (last) out.set("DCS", last[1].trim());
  if (first) out.set("DAC", first[1].trim());
  if (born) out.set("DBB", born[1]);
  return out;
}

/** 이름과 생년월일이 다 있을 때만 돌려준다. 하나라도 없으면 null — 손으로 넣게 한다. */
export function parseIdCard(raw: string): IdCard | null {
  if (!isIdCardScan(raw)) return null;
  const f = fields(raw);
  let last = f.get("DCS") ?? "";
  let first = f.get("DAC") ?? f.get("DCT") ?? "";
  // 옛 형식: DAA = "성,이름,가운데"
  if ((!last || !first) && f.get("DAA")) {
    const [l = "", fi = ""] = (f.get("DAA") ?? "").split(/[,$]/);
    last ||= l;
    first ||= fi;
  }
  // DCT 에는 가운데 이름이 붙어 오기도 한다 — 첫 단어만.
  first = first.split(/[\s,]+/)[0] ?? "";
  const dateOfBirth = isoDate((f.get("DBB") ?? "").slice(0, 8));
  if (!last || !first || !dateOfBirth) return null;
  return { firstName: nameCase(first), lastName: nameCase(last), dateOfBirth };
}
