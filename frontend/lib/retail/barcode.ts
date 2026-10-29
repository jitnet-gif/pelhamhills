/**
 * Code 128 (subset B) 바코드. 영수증 번호(`PH-20260915-0001`)를 **그대로** 담는다.
 *
 * 왜 Code 128 인가: 클럽이 쓰던 Lightspeed 영수증은 숫자 12자리 티켓 번호에 체크 숫자를
 * 붙인 EAN-13 이다. 우리 영수증 번호에는 영문과 하이픈이 섞여 있어 EAN-13 으로는 못
 * 담는다. 숫자 티켓을 새로 만들면 화면·매출 탭의 번호와 종이의 번호가 달라진다.
 * Code 128 은 영숫자를 그대로 담고, 프로 샵 스캐너(Zebra DS2208)도 읽고, TM-m30III 의
 * ESC/POS 바코드 명령(GS k, m=73)도 직접 찍는다.
 *
 * 브라우저 인쇄에서는 SVG 로 직접 그린다. 필요한 것은 기호 표 하나와 체크섬 한 줄이라
 * 라이브러리를 들이지 않았다. 표가 한 칸이라도 틀리면 그 기호가 들어간 영수증만 스캔이
 * 안 되므로, 표 전체를 실제 해독기로 읽어 확인했다(2026-09-15, pyzbar).
 */

/**
 * 기호 값 0–106 의 막대·공백 폭(모듈 단위). 막대부터 막대·공백을 번갈아 적는다.
 * 103/104/105 는 시작 A/B/C, 106 은 정지 기호(원소 7개, 13모듈)다.
 */
export const CODE128_PATTERNS: readonly string[] = [
  "212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312", "132212", "221213",
  "221312", "231212", "112232", "122132", "122231", "113222", "123122", "123221", "223211", "221132",
  "221231", "213212", "223112", "312131", "311222", "321122", "321221", "312212", "322112", "322211",
  "212123", "212321", "232121", "111323", "131123", "131321", "112313", "132113", "132311", "211313",
  "231113", "231311", "112133", "112331", "132131", "113123", "113321", "133121", "313121", "211331",
  "231131", "213113", "213311", "213131", "311123", "311321", "331121", "312113", "312311", "332111",
  "314111", "221411", "431111", "111224", "111422", "121124", "121421", "141122", "141221", "112214",
  "112412", "122114", "122411", "142112", "142211", "241211", "221114", "413111", "241112", "134111",
  "111242", "121142", "121241", "114212", "124112", "124211", "411212", "421112", "421211", "212141",
  "214121", "412121", "111143", "111341", "131141", "114113", "114311", "411113", "411311", "113141",
  "114131", "311141", "411131", "211412", "211214", "211232", "2331112",
];

const START_B = 104;
const STOP = 106;
/** 앞뒤로 비워 둘 모듈 수. 규격 최소값이다 — 좁으면 스캐너가 시작 기호를 못 찾는다. */
const QUIET_ZONE = 10;

/**
 * 문자열 → 기호 값 배열: `[시작 B, 데이터…, 체크섬, 정지]`.
 * 체크섬은 시작 값 + Σ(자리 번호 × 값) 을 103 으로 나눈 나머지다.
 * subset B 는 인쇄 가능한 ASCII(32–126)만 담는다. 그 밖의 글자는 던진다.
 */
export function code128Values(text: string): number[] {
  const data: number[] = [];
  for (const char of text) {
    const code = char.charCodeAt(0);
    if (char.length !== 1 || code < 32 || code > 126) {
      throw new Error(`Code 128 B cannot encode ${JSON.stringify(char)}`);
    }
    data.push(code - 32);
  }
  let sum = START_B;
  data.forEach((value, index) => {
    sum += value * (index + 1);
  });
  return [START_B, ...data, sum % 103, STOP];
}

/**
 * 화면에 띄울 바코드의 CSS 폭(px): 모듈 한 칸이 정확히 `modulePx` 픽셀이 되게 한다.
 * 2026-10-28: 기프트카드(GIFT- 15자 = 220 모듈)를 256px 에 맞추니 막대가 1.16px 로 뭉개져 스캐너가 못 읽었다.
 * 정수 배가 아니면 crispEdges 가 막대마다 1px·2px 로 다르게 반올림해 폭 비율이 깨진다.
 */
export function code128ScreenWidth(text: string, modulePx = 2): number {
  const modules = code128Values(text).reduce((sum, value) => sum + [...CODE128_PATTERNS[value]].reduce((s, w) => s + Number(w), 0), 0);
  return (modules + QUIET_ZONE * 2) * modulePx;
}

/**
 * 막대만 그린 SVG 문자열. 좌표 단위는 모듈이고, 인쇄 폭과 높이는 CSS 가 정한다
 * (`preserveAspectRatio="none"`). 사람이 읽는 번호는 호출하는 쪽이 아래에 따로 적는다.
 */
export function code128Svg(text: string): string {
  const widths = code128Values(text).flatMap((value) => [...CODE128_PATTERNS[value]].map(Number));
  const total = widths.reduce((sum, width) => sum + width, 0) + QUIET_ZONE * 2;
  const bars: string[] = [];
  let x = QUIET_ZONE;
  widths.forEach((width, index) => {
    // 모든 기호가 막대로 시작하고 원소 수가 짝수(정지 기호만 7개로 끝)라 짝수 번째가 막대다.
    if (index % 2 === 0) bars.push(`<rect x="${x}" y="0" width="${width}" height="1"/>`);
    x += width;
  });
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} 1" preserveAspectRatio="none" ` +
    `shape-rendering="crispEdges" aria-hidden="true">${bars.join("")}</svg>`
  );
}

/**
 * 제조사 바코드가 없는 상품(스낵바 음식·렌탈·로고 상품)에 클럽이 붙이는 바코드: `PH` + 상품 번호 6자리.
 * 상품 번호는 바뀌지 않고 겹치지 않으므로 이 값도 겹치지 않는다. 숫자만 쓰는 UPC/EAN 과도 겹칠 수 없다.
 * 2026-10-21: 스낵바에서 바코드 없는 것을 계산대 화면의 가격 옆 바코드를 쏘아 팔고 싶다고 했다.
 */
export function houseBarcode(productId: number): string {
  return `PH${String(productId).padStart(6, "0")}`;
}

/**
 * 상품 창의 Generate 버튼이 넣는 바코드. 있는 상품은 `houseBarcode(id)` 그대로(목록의 일괄 생성과 같은 값),
 * 새 상품은 아직 id 가 없으므로 지금 가장 큰 id·PH 번호 다음 번호에서 시작한다. 이미 누가 쓰면 1씩 올린다.
 * `taken` 은 소문자로 정리한 SKU·바코드 집합이다.
 */
export function nextHouseBarcode(productId: number | null, catalog: { id: number; barcode?: string | null }[], taken: Set<string>): string {
  let next = productId;
  if (next === null) {
    const numbers = catalog.flatMap((item) => {
      const code = (item.barcode ?? "").trim();
      return [item.id, isHouseBarcode(code) ? Number(code.slice(2)) : 0];
    });
    next = Math.max(0, ...numbers) + 1;
  }
  while (taken.has(houseBarcode(next).toLowerCase())) next += 1;
  return houseBarcode(next);
}

/** 클럽이 만든 바코드인가. 이런 상품은 포장에 바코드가 없으니 화면·인쇄 시트에 그려 준다. */
export function isHouseBarcode(code: string | null | undefined): boolean {
  return /^PH\d{6,}$/i.test((code ?? "").trim());
}
