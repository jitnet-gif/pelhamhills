/**
 * 영수증 프린터 연결 — **이 기기에만** 저장되는 설정과 블루투스(Web Serial)·네트워크(ePOS-Print) 운반.
 *
 * 세 가지 경로가 있다:
 * - `browser`: 지금까지처럼 `window.print()`. 드라이버가 깔린 USB·네트워크 프린터, iPad 의 AirPrint.
 * - `bluetooth`: 맥·윈도에 **페어링된** Epson TM-m30 계열에 ESC/POS(`escpos.ts`)를 직접 보낸다.
 *   Chrome·Edge 117+ 의 Web Serial 이 블루투스 SPP 포트를 연다. 드라이버도 인쇄 창도 없다.
 *   iPad Safari 에는 Web Serial 이 없다 — iPad 는 `browser` 경로만 된다.
 * - `network`: 매장 네트워크(이더넷·와이파이)의 TM-m30III 에 같은 ESC/POS 를 ePOS-Print(`eposPrint.ts`)로
 *   보낸다. 프린터 인증서가 자체 서명이라 **기기마다 한 번** `https://프린터주소` 를 열어 허용해야 하고,
 *   Chrome 은 처음에 "로컬 네트워크 접근" 을 묻는다.
 *
 * 포트 권한은 Chrome 이 사이트별로 기억한다. 한 번 "Choose printer" 로 고르면 다음부터는
 * `getPorts()` 가 그 포트를 돌려준다.
 */

import { escposReceipt, rasterFromRgba, type Raster } from "./escpos";
import {
  EPOS_TIMEOUT_MS,
  eposPrintEnvelope,
  eposPrintErrorMessage,
  eposPrintResult,
  eposPrintUrl,
  normalizePrinterHost,
} from "./eposPrint";
import { RECEIPT_LOGO } from "./logo";
import type { ReceiptBlock } from "./receipt";

export type ReceiptPrinterMode = "browser" | "bluetooth" | "network";

/** 블루투스 Serial Port Profile. TM-m30 계열 블루투스 모델이 이 서비스로 받는다. */
const SPP_UUID = "00001101-0000-1000-8000-00805f9b34fb";
const MODE_KEY = "pelham.retail.receiptPrinter";
const HOST_KEY = "pelham.retail.receiptPrinterHost";

// ===== 설정 (이 브라우저에만) ===========================================

let modeFallback: ReceiptPrinterMode = "browser";
let hostFallback = "";
const listeners = new Set<() => void>();

export function readReceiptPrinterMode(): ReceiptPrinterMode {
  try {
    const stored = window.localStorage.getItem(MODE_KEY);
    return stored === "bluetooth" || stored === "network" ? stored : "browser";
  } catch {
    return modeFallback;
  }
}

/** 네트워크 프린터 주소(`192.168.0.50` 또는 `printer1.example.com`). 없으면 빈 문자열. */
export function readReceiptPrinterHost(): string {
  try {
    return normalizePrinterHost(window.localStorage.getItem(HOST_KEY) ?? "");
  } catch {
    return hostFallback;
  }
}

/** 주소를 정리해 저장하고 정리된 값을 돌려준다. 알아볼 수 없는 주소면 오류. */
export function writeReceiptPrinterHost(input: string): string {
  const host = normalizePrinterHost(input);
  if (!host) throw new Error("Enter the printer's IP address, e.g. 192.168.0.50.");
  hostFallback = host;
  try {
    window.localStorage.setItem(HOST_KEY, host);
  } catch {
    // 메모리 값으로 버틴다.
  }
  notify();
  return host;
}

export function writeReceiptPrinterMode(mode: ReceiptPrinterMode): void {
  modeFallback = mode;
  try {
    window.localStorage.setItem(MODE_KEY, mode);
  } catch {
    // 메모리 값으로 버틴다.
  }
  notify();
}

export function subscribeReceiptPrinter(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

function notify(): void {
  listeners.forEach((listener) => listener());
}

// ===== Web Serial (TypeScript 기본 lib 에 없는 부분만) ==================

type SerialPortInfo = { usbVendorId?: number; usbProductId?: number; bluetoothServiceClassId?: string };
type SerialPortLike = {
  readonly writable: WritableStream<Uint8Array> | null;
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
  forget?(): Promise<void>;
  getInfo(): SerialPortInfo;
};
type SerialLike = {
  getPorts(): Promise<SerialPortLike[]>;
  requestPort(options?: { allowedBluetoothServiceClassIds?: string[] }): Promise<SerialPortLike>;
};

function serial(): SerialLike | null {
  if (typeof navigator === "undefined") return null;
  return (navigator as Navigator & { serial?: SerialLike }).serial ?? null;
}

/** 이 브라우저가 블루투스 프린터에 직접 보낼 수 있나(Chrome·Edge 데스크톱). */
export function bluetoothPrintingSupported(): boolean {
  return serial() !== null;
}

/** 이미 권한을 받은 포트. 여럿이면 블루투스 쪽을 먼저. */
async function grantedPort(): Promise<SerialPortLike | null> {
  const api = serial();
  if (!api) return null;
  const ports = await api.getPorts();
  return ports.find((port) => port.getInfo().bluetoothServiceClassId) ?? ports[0] ?? null;
}

export async function hasChosenPrinter(): Promise<boolean> {
  return (await grantedPort().catch(() => null)) !== null;
}

/** 프린터 고르기 창. **버튼 클릭 안에서** 불러야 한다(브라우저 규칙). */
export async function choosePrinter(): Promise<void> {
  const api = serial();
  if (!api) throw new Error("This browser cannot reach Bluetooth printers. Use Chrome or Edge on a Mac or PC.");
  // 예전에 고른 포트는 놓아준다 — 계산대 하나에 프린터 하나.
  for (const old of await api.getPorts()) {
    if (old === openPort) await closePort();
    await old.forget?.().catch(() => undefined);
  }
  await api.requestPort({ allowedBluetoothServiceClassIds: [SPP_UUID] });
  writeReceiptPrinterMode("bluetooth");
}

// ===== 보내기 ==========================================================

let openPort: SerialPortLike | null = null;
let queue: Promise<unknown> = Promise.resolve();

async function closePort(): Promise<void> {
  const port = openPort;
  openPort = null;
  await port?.close().catch(() => undefined);
}

async function writeBytes(bytes: Uint8Array): Promise<void> {
  if (!openPort) {
    const port = await grantedPort();
    if (!port) throw new Error("No receipt printer chosen. On the register home screen, open Receipt Printer → Choose printer.");
    // 블루투스 SPP 는 속도 값을 쓰지 않지만 open() 은 값을 요구한다.
    await port.open({ baudRate: 115200 });
    openPort = port;
  }
  const writable = openPort.writable;
  if (!writable) throw new Error("The receipt printer is not accepting data.");
  const writer = writable.getWriter();
  try {
    // 블루투스 버퍼가 작다 — 조금씩 보낸다.
    for (let offset = 0; offset < bytes.length; offset += 512) {
      await writer.ready;
      await writer.write(bytes.subarray(offset, offset + 512));
    }
    await writer.ready;
  } finally {
    writer.releaseLock();
  }
}

/**
 * 장 여러 개를 한 번에 보낸다. 프린터가 꺼졌다 켜져 연결이 끊겼으면 한 번 다시 연다.
 * 인쇄는 한 줄로 세운다 — 두 영수증의 바이트가 섞이면 종이가 망가진다.
 */
export function printBluetooth(
  sheets: readonly (readonly ReceiptBlock[])[],
  options: { openDrawer?: boolean } = {},
): Promise<void> {
  const job = queue.then(async () => {
    const bytes = escposReceipt(sheets, { logo: await receiptLogo(), openDrawer: options.openDrawer });
    try {
      await writeBytes(bytes);
    } catch {
      await closePort();
      await writeBytes(bytes);
    }
  });
  queue = job.catch(() => undefined);
  return job;
}

/**
 * 네트워크 프린터로 보낸다. 프린터가 다 찍고 응답할 때까지 기다리므로, 성공이면 종이가 나온 것이다.
 * 블루투스와 같은 줄에 세운다(기기에서 한 경로만 쓰지만, 연달아 누른 두 영수증이 섞이지 않게).
 */
export function printNetwork(
  sheets: readonly (readonly ReceiptBlock[])[],
  options: { openDrawer?: boolean } = {},
): Promise<void> {
  const job = queue.then(async () => {
    const host = readReceiptPrinterHost();
    if (!host) throw new Error("No printer address. On the register home screen, open Receipt Printer and enter it.");
    const bytes = escposReceipt(sheets, { logo: await receiptLogo(), openDrawer: options.openDrawer });
    const abort = new AbortController();
    const timer = window.setTimeout(() => abort.abort(), EPOS_TIMEOUT_MS + 5000);
    let response: Response;
    try {
      response = await fetch(eposPrintUrl(host), {
        method: "POST",
        headers: { "Content-Type": "text/xml; charset=utf-8", SOAPAction: '""' },
        body: eposPrintEnvelope(bytes),
        signal: abort.signal,
      });
    } catch {
      // 인증서를 허용하지 않았거나, 로컬 네트워크 접근을 막았거나, 주소·전원·네트워크가 틀렸다.
      // 브라우저는 셋을 구분해 알려 주지 않는다.
      throw new Error(
        `Could not reach the printer at ${host}. Check it is on and on the same network, ` +
          `open https://${host} once on this device and accept the certificate, ` +
          "and allow local network access if Chrome asks.",
      );
    } finally {
      window.clearTimeout(timer);
    }
    const result = eposPrintResult(await response.text().catch(() => ""));
    if (!result.ok) throw new Error(eposPrintErrorMessage(result.code || `HTTP ${response.status}`));
  });
  queue = job.catch(() => undefined);
  return job;
}

// ===== 로고 ============================================================

/** 15mm 폭 — 화면 인쇄(`.rc-logo-img`)와 같다. 203dpi 에서 120점. */
const LOGO_DOTS = 120;
let logoRaster: Promise<Raster | null> | null = null;

/** 로고 그림을 한 번만 1비트로 바꿔 둔다. 실패하면 로고 없이 찍는다. */
function receiptLogo(): Promise<Raster | null> {
  logoRaster ??= new Promise<Raster | null>((resolve) => {
    const image = new Image();
    image.onload = () => {
      try {
        const height = Math.round((image.naturalHeight / image.naturalWidth) * LOGO_DOTS);
        const canvas = document.createElement("canvas");
        canvas.width = LOGO_DOTS;
        canvas.height = height;
        const context = canvas.getContext("2d");
        if (!context) return resolve(null);
        context.drawImage(image, 0, 0, LOGO_DOTS, height);
        resolve(rasterFromRgba(context.getImageData(0, 0, LOGO_DOTS, height).data, LOGO_DOTS, height));
      } catch {
        resolve(null);
      }
    };
    image.onerror = () => resolve(null);
    image.src = RECEIPT_LOGO;
  });
  return logoRaster;
}
