/**
 * 1번 티 스타터 앱(Android, `android/starter`)과 이 웹 화면 사이의 다리.
 *
 * 앱은 이 사이트를 WebView 로 띄우고, 브라우저가 못 하는 두 가지만 맡는다:
 * - **탭 결제**: Stripe Terminal SDK 의 Tap to Pay — 폰이 카드 리더가 된다.
 * - **영수증 인쇄**: 페어링한 블루투스 프린터(SPP) 또는 와이파이 프린터(TCP 9100)에 ESC/POS 를 보낸다.
 *
 * 앱 밖(보통 브라우저)에서는 `inStarterApp()` 이 false 이고, 화면은 이 기능들을 숨긴다.
 *
 * ## 주고받는 모양
 * - 웹 → 앱: `PelhamStarterNative.call(id, method, argsJson)`. 앱은 끝나면
 *   `window.__pelhamStarter.reply(id, ok, payloadJson)` 를 부른다.
 * - 앱 → 웹: SDK 가 Stripe 연결 토큰이 필요할 때 `window.__pelhamStarter.request(id, "connectionToken", "{}")`.
 *   웹은 직원 로그인 토큰으로 서버에서 받아 `PelhamStarterNative.reply(id, ok, payloadJson)` 로 돌려준다.
 *   로그인 토큰이 앱으로 가지 않는다 — 앱은 Stripe 의 일회용 토큰만 본다.
 */

type Native = {
  call(id: string, method: string, args: string): void;
  reply(id: string, ok: boolean, payload: string): void;
};

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

type Hooks = {
  reply(id: string, ok: boolean, payload: string): void;
  request(id: string, method: string, args: string): void;
};

declare global {
  interface Window {
    PelhamStarterNative?: Native;
    __pelhamStarter?: Hooks;
  }
}

const pending = new Map<string, Pending>();
const handlers = new Map<string, (args: unknown) => Promise<unknown>>();
let seq = 0;

function native(): Native | null {
  if (typeof window === "undefined") return null;
  return window.PelhamStarterNative ?? null;
}

/** 스타터 앱 안에서 열렸나. */
export function inStarterApp(): boolean {
  return native() !== null;
}

function parse(payload: string): unknown {
  try {
    return payload ? JSON.parse(payload) : null;
  } catch {
    return payload;
  }
}

function install(): void {
  if (typeof window === "undefined" || window.__pelhamStarter) return;
  window.__pelhamStarter = {
    reply(id, ok, payload) {
      const waiting = pending.get(id);
      if (!waiting) return;
      pending.delete(id);
      const value = parse(payload);
      if (ok) waiting.resolve(value);
      else {
        const message =
          value && typeof value === "object" && "message" in value ? String((value as { message: unknown }).message) : String(value ?? "");
        waiting.reject(new StarterError(message || "The phone app did not finish."));
      }
    },
    request(id, method, args) {
      const handler = handlers.get(method);
      const app = native();
      if (!app) return;
      if (!handler) {
        app.reply(id, false, JSON.stringify({ message: `Unknown request ${method}` }));
        return;
      }
      handler(parse(args)).then(
        (value) => app.reply(id, true, JSON.stringify(value ?? null)),
        (error: unknown) =>
          app.reply(id, false, JSON.stringify({ message: error instanceof Error ? error.message : String(error) })),
      );
    },
  };
}

export class StarterError extends Error {}

/** 앱의 기능 하나를 부른다. 앱 밖이면 바로 실패한다. */
export function callStarter<T>(method: string, args: unknown = {}): Promise<T> {
  const app = native();
  if (!app) return Promise.reject(new StarterError("Open this screen in the Pelham Starter app."));
  install();
  const id = `w${++seq}`;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    app.call(id, method, JSON.stringify(args ?? {}));
  });
}

/** 앱이 웹에 묻는 것(지금은 Stripe 연결 토큰 하나)에 답할 함수를 건다. */
export function onStarterRequest(method: string, handler: (args: unknown) => Promise<unknown>): void {
  install();
  handlers.set(method, handler);
}

// ===== 기능 ==============================================================

export type TapResult = {
  /** succeeded = 승인. canceled = 직원·손님이 취소. failed = 거절·오류(message). */
  status: "succeeded" | "canceled" | "failed";
  message?: string;
};

/** 탭 결제. 서버가 만든 PaymentIntent 의 client_secret 으로 카드를 읽고 확정한다. */
export function tapToPay(clientSecret: string, amount: number): Promise<TapResult> {
  return callStarter<TapResult>("tapToPay", { clientSecret, amount });
}

/** 진행 중인 탭 결제를 멈춘다(손님이 카드를 대기 전). */
export function cancelTap(): Promise<void> {
  return callStarter<void>("cancelTap");
}

export type StarterPrinter = { kind: "bluetooth" | "network"; name: string; address: string };

/** ESC/POS 바이트를 앱이 고른 프린터로 보낸다. */
export function printOnStarter(bytes: Uint8Array): Promise<void> {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return callStarter<void>("print", { base64: btoa(binary) });
}

/** 앱에 설정된 프린터와, 고를 수 있는 페어링된 블루투스 프린터들. */
export function starterPrinters(): Promise<{ current: StarterPrinter | null; paired: StarterPrinter[] }> {
  return callStarter("printers");
}

export function chooseStarterPrinter(printer: StarterPrinter): Promise<void> {
  return callStarter<void>("choosePrinter", printer);
}
