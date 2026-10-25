/**
 * 네트워크(이더넷·와이파이) Epson TM 프린터의 **ePOS-Print** 요청 — 순수 함수만 둔다(연결은 `receiptPrinter.ts`).
 *
 * 프린터 안에 웹 서비스가 있다: `https://<주소>/cgi-bin/epos/service.cgi?devid=local_printer` 에
 * SOAP XML 을 POST 하면 찍는다. Epson 의 `epos-*.js` SDK 가 하는 일도 이것이다 — SDK 없이 직접 보낸다.
 * 내용은 블루투스 경로와 **같은 ESC/POS 바이트**(`escpos.ts`)를 `<command>` 에 16진수로 담는다.
 * 그래서 로고·바코드·장마다 자르기·현금 결제에만 현금함 열기가 블루투스와 똑같다.
 *
 * 사이트가 HTTPS 라서 프린터도 HTTPS 로만 부른다(HTTP 는 Chrome 이 혼합 콘텐츠로 막는다).
 */

/** 프린터 웹 설정의 기본 장치 이름. */
const DEVICE_ID = "local_printer";

/** 프린터가 종이를 다 뽑을 때까지 기다리는 시간(ms). 이 안에 못 찍으면 실패로 돌려준다. */
export const EPOS_TIMEOUT_MS = 10000;

/**
 * 직원이 적은 주소를 `호스트[:포트]` 로 정리한다. `https://192.168.0.50/` 처럼 붙여 넣어도 된다.
 * 알아볼 수 없으면 빈 문자열.
 */
export function normalizePrinterHost(input: string): string {
  const host = input
    .trim()
    .replace(/^[a-z]+:\/\//i, "")
    .replace(/[/?#].*$/, "")
    .toLowerCase();
  return /^[a-z0-9.-]+(:\d{1,5})?$/.test(host) ? host : "";
}

export function eposPrintUrl(host: string): string {
  return `https://${host}/cgi-bin/epos/service.cgi?devid=${DEVICE_ID}&timeout=${EPOS_TIMEOUT_MS}`;
}

/** ESC/POS 바이트 → `<epos-print>` 요소 하나. 네트워크 프린터와 TM Print Assistant 앱이 같은 것을 받는다. */
export function eposPrintXml(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return `<epos-print xmlns="http://www.epson-pos.com/schemas/2011/03/epos-print"><command>${hex}</command></epos-print>`;
}

/** ESC/POS 바이트 → ePOS-Print SOAP 본문. */
export function eposPrintEnvelope(bytes: Uint8Array): string {
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>' +
    eposPrintXml(bytes) +
    "</s:Body></s:Envelope>"
  );
}

/** TM Print Assistant 가 URL 로 받을 수 있는 최대 길이(Epson 설명서: 200KB). */
export const TM_PRINT_ASSISTANT_MAX_URL = 200 * 1024;

/**
 * iPad·iPhone 의 **Epson TM Print Assistant** 앱을 여는 주소. Safari 는 블루투스 프린터에 닿을 수 없지만,
 * 이 앱은 iPad 에 페어링된 TM-m30(블루투스)에 보낼 수 있다. 같은 ESC/POS 바이트를 ePOS-Print XML 로 넘긴다.
 * `reselect=no` — 앱에 한 번 골라 둔 프린터로 바로 찍는다. `success` 는 다 찍고 앱이 열어 줄 주소(없으면 앱에 머문다).
 */
export function tmPrintAssistantUrl(bytes: Uint8Array, success?: string): string {
  const params: [string, string][] = [
    ["ver", "1"],
    ["data-type", "eposprintxml"],
    ["reselect", "no"],
    ["error-dialog", "yes"],
    ["data", eposPrintXml(bytes)],
  ];
  if (success) params.push(["success", success]);
  return (
    "tmprintassistant://tmprintassistant.epson.com/print?" +
    params.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join("&")
  );
}

/**
 * 프린터가 돌려준 `<response success=… code=…>` 를 읽는다. 알아볼 수 없으면 실패.
 * SDK(epos-2.27.0.js)처럼 `success` 는 `true` 와 `1` 을 모두 성공으로 본다.
 */
export function eposPrintResult(xml: string): { ok: boolean; code: string } {
  const tag = /<(?:\w+:)?response\b[^>]*>/.exec(xml)?.[0] ?? "";
  const attr = (name: string) => new RegExp(`\\b${name}\\s*=\\s*"\\s*([^"]*?)\\s*"`).exec(tag)?.[1] ?? "";
  return { ok: /^(1|true)$/.test(attr("success")), code: attr("code") };
}

/** 자주 나오는 실패 코드를 직원이 할 일로 옮긴다. 모르는 코드는 그대로 보여 준다. */
export function eposPrintErrorMessage(code: string): string {
  switch (code) {
    case "EPTR_COVER_OPEN":
      return "The printer cover is open.";
    case "EPTR_REC_EMPTY":
      return "The printer is out of paper.";
    case "EPTR_AUTOMATICAL":
    case "EPTR_UNRECOVERABLE":
    case "EPTR_CUTTER":
    case "EPTR_MECHANICAL":
      return `The printer reported an error (${code}). Turn it off and on.`;
    case "EX_TIMEOUT":
      return "The printer did not finish in time.";
    case "EX_ENPC_TIMEOUT":
      // 다른 기기(다른 계산대·주방 등)가 프린터를 쓰는 중. SDK 는 ERROR_DEVICE_BUSY 로 바꿔 부른다.
      return "The printer is busy with another job. Try again in a moment.";
    case "DeviceNotFound":
      return 'The printer has no device named "local_printer". Check ePOS-Print in the printer settings.';
    case "SchemaError":
    case "ParameterError":
      return `The printer rejected the request (${code}).`;
    default:
      return `The printer could not print (${code || "unknown error"}).`;
  }
}
