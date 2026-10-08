/**
 * 카드 단말기(Ingenico AXIUM DX8000 + J.P. Morgan Payment Terminal Application) 연동.
 *
 * ## 어떻게 붙는가
 * 단말기의 결제 앱(PTA)은 **반통합(semi-integrated)** 모드에서 단말기 안에 WebSocket 서버를 띄운다
 * (`wss://<단말기 IP>:8443`). 계산대 브라우저가 매장 LAN 으로 거기 직접 붙어 JSON 을 주고받는다.
 * 카드 번호는 단말기 밖으로 나오지 않고, 가맹점 정보·호스트 연결도 단말기가 갖고 있다 — 그래서
 * 이 정적 사이트에 비밀 키가 필요 없다. Fly·Supabase 서버는 단말기에 닿지 않는다(닿을 수도 없다).
 *
 * 문서: https://developer.payments.jpmorgan.com/docs/commerce/in-store-payments/capabilities/payment-terminal-application
 *
 * ## 메시지 규칙(PTA)
 * - 요청 하나에 `operation`. 단순 작업은 같은 `operation` 의 응답 한 번으로 끝난다.
 * - 복잡한 작업(Transaction 등)은 그 사이에 `Status` 알림을 여러 번 보낸 뒤 같은 `operation` 의 최종 응답을
 *   보낸다. `result: "60"` 은 "진행 중" 이라 최종이 아니다.
 * - 거래는 동기식이다: 최종 응답을 받기 전에는 다음 요청을 보내지 않는다(`busy` 잠금).
 * - 금액은 센트 문자열(`"500"` = $5.00). `result: "0"` 은 "작업이 끝났다" 일 뿐 승인이 아니다 —
 *   승인은 `approval: "approved"` 로 본다.
 *
 * ## 돈을 잃지 않는 순서
 * 1) 보내기 전에 참조번호(reference)를 이 브라우저에 적어 둔다(`PENDING_KEY`).
 * 2) 최종 응답 전에 연결이 끊기면 다시 붙어 `LastTransaction` 으로 그 참조번호의 결과를 묻는다.
 * 3) 결과는 Charge 전에 곧바로 서버(`pelham_staff_terminal_record`, 0019)에 남긴다. 남긴 뒤에야
 *    적어 둔 참조번호를 지운다. 화면을 다시 열면 `recoverPending()` 이 남은 것을 마저 처리한다.
 */

import { useSyncExternalStore } from "react";

import { ApiError } from "@/lib/teeSheet/api";
import { staffRpc } from "@/lib/teeSheet/staffRpc";
import type { Cents } from "@/lib/retail/types";

// ===== 설정 (이 기기에만) ==============================================

/** off = 예전처럼 손으로 친다. live = 진짜 단말기. practice = 단말기 없이 흉내(교육·테스트). */
export type TerminalMode = "off" | "live" | "practice";
export type TerminalSettings = { mode: TerminalMode; url: string };

const SETTINGS_KEY = "pelham.pos.terminal";
const DEFAULT_SETTINGS: TerminalSettings = { mode: "off", url: "" };
let settingsFallback: TerminalSettings = DEFAULT_SETTINGS;
let settingsCache: { raw: string | null; value: TerminalSettings } | null = null;
const settingsListeners = new Set<() => void>();

function parseSettings(raw: string | null): TerminalSettings {
  if (!raw) return DEFAULT_SETTINGS;
  try {
    const value = JSON.parse(raw) as Partial<TerminalSettings>;
    const mode: TerminalMode = value.mode === "live" || value.mode === "practice" ? value.mode : "off";
    return { mode, url: typeof value.url === "string" ? value.url : "" };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function readTerminalSettings(): TerminalSettings {
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(SETTINGS_KEY);
  } catch {
    return settingsFallback;
  }
  // useSyncExternalStore 는 같은 값이면 같은 객체를 받아야 한다.
  if (!settingsCache || settingsCache.raw !== raw) settingsCache = { raw, value: parseSettings(raw) };
  return settingsCache.value;
}

export function writeTerminalSettings(next: TerminalSettings): void {
  const value = { mode: next.mode, url: normalizeTerminalUrl(next.url) };
  settingsFallback = value;
  try {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(value));
  } catch {
    // 메모리 값으로 버틴다.
  }
  settingsListeners.forEach((listener) => listener());
}

function subscribeSettings(listener: () => void): () => void {
  settingsListeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    settingsListeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

export function useTerminalSettings(): TerminalSettings {
  return useSyncExternalStore(subscribeSettings, readTerminalSettings, () => DEFAULT_SETTINGS);
}

/** `192.168.1.50` 만 쳐도 `wss://192.168.1.50:8443` 으로. */
export function normalizeTerminalUrl(input: string): string {
  const text = input.trim();
  if (!text) return "";
  if (/^wss?:\/\//i.test(text)) return text;
  return /:\d+$/.test(text) ? `wss://${text}` : `wss://${text}:8443`;
}

/** 브라우저가 단말기 인증서를 믿게 하려고 한 번 열어 보는 주소. */
export function certificatePageUrl(url: string): string {
  return normalizeTerminalUrl(url).replace(/^wss:/i, "https:").replace(/^ws:/i, "http:");
}

export function terminalEnabled(settings: TerminalSettings): boolean {
  return settings.mode === "practice" || (settings.mode === "live" && settings.url !== "");
}

// ===== 결과 ============================================================

export type CardType = "credit" | "debit" | "gift" | "ebt";

/** 단말기 응답에서 우리가 쓰는 것만. 카드 토큰·전표 원문·EMV 태그는 버린다. */
export type TerminalResult = {
  kind: "sale" | "void" | "refund";
  reference: string;
  result: string;
  approved: boolean;
  requested_amount: Cents;
  tip: Cents;
  total_amount: Cents;
  auth_code: string | null;
  original_auth_code: string | null;
  transaction_id: string | null;
  batch_number: string | null;
  response_code: string | null;
  host_message: string | null;
  card_brand: string | null;
  card_last4: string | null;
  card_type: CardType | null;
  entry_mode: string | null;
  terminal_id: string | null;
};

/** 서버(0019)에 남은 기록. */
export type TerminalRecord = TerminalResult & {
  id: number;
  bill_id: number | null;
  used: boolean;
  voided_at: string | null;
  created_at: string;
};

/** PTA `result` 코드 → 직원이 읽을 문장. */
const RESULT_TEXT: Record<string, string> = {
  "1": "The terminal app had an error. Try again.",
  "2": "The card could not be read. Try again or use another card.",
  "3": "The terminal rejected the request (bad or missing field).",
  "4": "The terminal did not recognise the original transaction.",
  "5": "The terminal is busy with another transaction.",
  "9": "The card was removed too early.",
  "10": "Nobody touched the terminal in time.",
  "11": "Cancelled on the terminal.",
  "12": "Cancelled from the register.",
  "13": "Too late to cancel — the terminal is already talking to the bank.",
  "17": "Declined by the card.",
  "19": "Declined by the bank.",
  "20": "The terminal is not ready to take payments.",
  "21": "The terminal could not reach the bank.",
  "22": "The terminal could not send to the bank.",
  "23": "No answer from the bank.",
  "24": "Bad answer from the bank.",
  "26": "Fraud check failed (card number mismatch).",
};

export function describeTerminalResult(result: TerminalResult): string {
  if (result.approved) return "Approved";
  if (result.result === "0") {
    return `Declined${result.host_message ? ` — ${result.host_message}` : result.response_code ? ` (code ${result.response_code})` : ""}.`;
  }
  return RESULT_TEXT[result.result] ?? `The terminal returned error ${result.result}.`;
}

export class TerminalError extends Error {
  constructor(
    message: string,
    /** true = 돈이 나갔는지 모른다. 직원이 단말기 화면·전표를 봐야 한다. */
    readonly uncertain = false,
  ) {
    super(message);
  }
}

type PtaMessage = Record<string, unknown>;

const str = (value: unknown): string | null => {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text === "" ? null : text;
};
const cents = (value: unknown): Cents => {
  const n = Number.parseInt(String(value ?? "0"), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
};
const CARD_TYPES: Record<string, CardType> = { "1": "credit", "2": "debit", "3": "gift", "4": "ebt" };

export function parseTransaction(kind: TerminalResult["kind"], reference: string, msg: PtaMessage): TerminalResult {
  const account = str(msg.account);
  const digits = account ? account.replace(/\D/g, "") : "";
  return {
    kind,
    reference,
    result: str(msg.result) ?? "",
    approved: str(msg.result) === "0" && str(msg.approval)?.toLowerCase() === "approved",
    requested_amount: cents(msg.requestedAmount),
    tip: cents(msg.tipAmount),
    total_amount: cents(msg.totalAmount),
    auth_code: str(msg.authCode),
    original_auth_code: str(msg.originalAuthCode),
    transaction_id: str(msg.transactionID),
    batch_number: str(msg.batchNumber),
    response_code: str(msg.responseCode),
    host_message: str(msg.hostMessage),
    card_brand: str(msg.cardBrand),
    card_last4: digits.length >= 4 ? digits.slice(-4) : null,
    card_type: CARD_TYPES[str(msg.cardTypeProcessed) ?? ""] ?? null,
    entry_mode: str(msg.entryMode),
    terminal_id: str(msg.terminalID),
  };
}

// ===== WebSocket 한 번 =================================================

type Live = { socket: WebSocket; operation: string } | null;
let live: Live = null;
let busy = false;

/** 연결이 최종 응답 전에 끊겼다. 거래였다면 결과를 다시 물어야 한다. */
class DroppedError extends Error {}

/**
 * 요청 하나를 보내고 같은 `operation` 의 최종 응답을 기다린다. 연결은 작업마다 새로 연다 —
 * 한 계산대가 한 단말기를 쓰고, 끊긴 연결을 되살리는 상태를 들고 다니지 않아도 된다.
 */
function exchange(
  url: string,
  request: PtaMessage,
  { timeoutMs, onStatus }: { timeoutMs: number; onStatus?: (text: string) => void },
): Promise<PtaMessage> {
  const operation = String(request.operation);
  return new Promise((resolve, reject) => {
    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch {
      reject(new TerminalError(`"${url}" is not a valid terminal address.`));
      return;
    }
    let opened = false;
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      if (live?.socket === socket) live = null;
      try {
        socket.close();
      } catch {
        // 이미 닫혔다.
      }
      fn();
    };
    const timer = window.setTimeout(
      () => finish(() => reject(opened ? new DroppedError("timeout") : unreachable(url))),
      timeoutMs,
    );
    socket.onopen = () => {
      opened = true;
      live = { socket, operation };
      socket.send(JSON.stringify(request));
    };
    socket.onmessage = (event) => {
      let msg: PtaMessage;
      try {
        msg = JSON.parse(String(event.data)) as PtaMessage;
      } catch {
        return;
      }
      if (msg.operation === operation && str(msg.result) !== "60") {
        finish(() => resolve(msg));
        return;
      }
      // 진행 알림(Status). 화면에 한 줄로만 보여 준다 — 결과 판단에는 쓰지 않는다(문서 권고).
      const context = str(msg.context);
      if (onStatus && msg.operation === "Status") onStatus(statusText(context, str(msg.result)));
    };
    socket.onerror = () => {
      // 원인은 onclose 가 정한다(열리기 전이면 연결 실패, 연 뒤면 끊김).
    };
    socket.onclose = () => finish(() => reject(opened ? new DroppedError("closed") : unreachable(url)));
  });
}

function unreachable(url: string): TerminalError {
  return new TerminalError(
    `Can't reach the terminal at ${url}. Check that it is on, on the club Wi-Fi, and showing "Waiting for POS Connection". ` +
      `If this is a new computer, open ${certificatePageUrl(url)} once and accept the certificate.`,
  );
}

function statusText(context: string | null, result: string | null): string {
  if (context === "Communication") return "Talking to the bank…";
  if (context === "Card" || context === "CardEntry") return "Waiting for the card…";
  if (context === "Pin") return "Customer is entering the PIN…";
  if (context === "Tip") return "Customer is choosing a tip…";
  return context ? `${context}…` : result ? `Terminal status ${result}` : "Working…";
}

// ===== 연습 모드 (단말기 없이) =========================================

/** 끝자리가 .13 인 금액은 거절, .21 은 연결 끊김을 흉내 낸다 — 교육과 테스트용. */
async function practiceExchange(request: PtaMessage, onStatus?: (text: string) => void): Promise<PtaMessage> {
  const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));
  if (request.operation !== "Transaction") return { operation: request.operation, result: "0" };
  const amount = cents(request.requestedAmount);
  onStatus?.("Waiting for the card…");
  await wait(900);
  onStatus?.("Talking to the bank…");
  await wait(700);
  const auth = String(Math.floor(100000 + Math.random() * 900000));
  const declined = request.type === "SALE" && amount % 100 === 13;
  return {
    operation: "Transaction",
    type: request.type,
    result: "0",
    approval: declined ? "declined" : "approved",
    hostMessage: declined ? "DECLINED (PRACTICE)" : undefined,
    responseCode: declined ? "05" : "00",
    authCode: request.type === "VOID" ? request.originalAuthCode : declined ? undefined : auth,
    requestedAmount: String(amount),
    tipAmount: "0",
    totalAmount: String(amount),
    account: "476173******4242",
    cardBrand: "VISA",
    cardTypeProcessed: "1",
    entryMode: "Contactless",
    transactionID: `PRACTICE${Date.now()}`,
    batchNumber: "000001",
    reference: request.reference,
    terminalID: "PRACTICE",
  };
}

// ===== 거래 ============================================================

const PENDING_KEY = "pelham.pos.terminalPending";

type Pending = {
  reference: string;
  /** VOID·REFUND 가 무르는 SALE 기록 id. */
  cancels?: number;
  kind: TerminalResult["kind"];
  bill_id: number;
  /** 보낸 시각(ms). 하루가 지나도 결과를 모르면 버린다 — 그때는 직원이 이미 단말기로 확인했다. */
  at: number;
  result?: TerminalResult;
};
const PENDING_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function readPending(): Pending[] {
  try {
    const list = JSON.parse(window.localStorage.getItem(PENDING_KEY) ?? "[]") as Pending[];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function writePending(list: Pending[]): void {
  try {
    if (list.length === 0) window.localStorage.removeItem(PENDING_KEY);
    else window.localStorage.setItem(PENDING_KEY, JSON.stringify(list));
  } catch {
    // 저장할 수 없는 브라우저(사생활 모드). 서버 기록이 유일한 안전망이 된다.
  }
}

const updatePending = (fn: (list: Pending[]) => Pending[]) => writePending(fn(readPending()));

/** 영숫자 12자. 단말기 배치 안에서 유일해야 한다. 시각 + 무작위면 충분하다. */
function newReference(): string {
  const time = Date.now().toString(36).toUpperCase().slice(-7);
  const random = Math.floor(Math.random() * 36 ** 5)
    .toString(36)
    .toUpperCase()
    .padStart(5, "0");
  return `${time}${random}`.slice(0, 12);
}

function toRecordArgs(bill: number, result: TerminalResult, cancels?: number) {
  return { p: { ...result, bill_id: bill, ...(cancels ? { cancels } : {}) } };
}

/** 서버에 남긴다. 네트워크가 잠깐 끊겨도 몇 번 다시 해 본다(같은 참조번호는 한 번만 남는다). */
async function record(bill: number, result: TerminalResult, cancels?: number): Promise<TerminalRecord> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await staffRpc<TerminalRecord>("pelham_staff_terminal_record", toRecordArgs(bill, result, cancels));
    } catch (error) {
      lastError = error;
      // 입력 오류(422)·로그인(401)은 다시 해도 같다.
      if (error instanceof ApiError && error.status !== 0) break;
      await new Promise((resolve) => window.setTimeout(resolve, 800 * (attempt + 1)));
    }
  }
  throw lastError;
}

export type RunOptions = {
  /** 진행 알림 한 줄. */
  onStatus?: (text: string) => void;
  /** Charge 전에 지우는 결제 줄의 SALE 기록 id(0019 가 그 승인을 voided 로 둔다). */
  cancels?: number;
  /** 이 VOID·REFUND 가 무르는 원래 승인번호. 기록에만 남는다(환불 화면이 "했음" 을 안다). */
  forAuthCode?: string;
};

/** 거래 하나: 단말기로 보내고, 끊기면 결과를 다시 묻고, 서버에 남긴다. */
async function run(
  settings: TerminalSettings,
  bill: number,
  kind: TerminalResult["kind"],
  request: PtaMessage,
  { onStatus, cancels, forAuthCode }: RunOptions = {},
): Promise<TerminalRecord> {
  if (!terminalEnabled(settings)) throw new TerminalError("The card terminal is not set up on this computer.");
  if (busy) throw new TerminalError("The terminal is already running a transaction.");
  busy = true;
  const reference = newReference();
  updatePending((list) => [...list, { reference, kind, bill_id: bill, at: Date.now(), ...(cancels ? { cancels } : {}) }]);
  try {
    const message = { ...request, operation: "Transaction", reference };
    let response: PtaMessage;
    if (settings.mode === "practice") {
      response = await practiceExchange(message, onStatus);
    } else {
      try {
        response = await exchange(settings.url, message, { timeoutMs: 180_000, onStatus });
      } catch (error) {
        if (!(error instanceof DroppedError)) {
          // 연결조차 안 됐다 → 단말기는 아무것도 받지 않았다.
          updatePending((list) => list.filter((item) => item.reference !== reference));
          throw error;
        }
        onStatus?.("Lost the terminal — checking what happened…");
        const found = await askLastTransaction(settings.url, reference);
        if (!found) {
          throw new TerminalError(
            "Lost the connection to the terminal and could not confirm the result. Look at the terminal screen or slip " +
              "before trying again — the card may have been charged.",
            true,
          );
        }
        response = found;
      }
    }
    const result = parseTransaction(kind, reference, response);
    const original = forAuthCode ?? str(request.originalAuthCode);
    if (original) result.original_auth_code = original;
    // 결과가 나왔다. 서버에 남기기 전까지 이 브라우저에 결과째 들고 있는다.
    updatePending((list) => list.map((item) => (item.reference === reference ? { ...item, result } : item)));
    const saved = await record(bill, result, cancels).catch(() => {
      throw new TerminalError(
        `${describeTerminalResult(result)} but the app could not save it (no internet?). Do not run the card again — ` +
          "keep this screen open; it will save when the connection is back.",
        true,
      );
    });
    updatePending((list) => list.filter((item) => item.reference !== reference));
    return saved;
  } finally {
    busy = false;
  }
}

/** 끊긴 거래의 결과. 단말기가 마지막으로 처리한 거래가 그 참조번호일 때만 믿는다. */
async function askLastTransaction(url: string, reference: string): Promise<PtaMessage | null> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await new Promise((resolve) => window.setTimeout(resolve, 1500 * (attempt + 1)));
    try {
      const last = await exchange(url, { operation: "LastTransaction" }, { timeoutMs: 15_000 });
      // 단말기는 우리가 보낸 참조번호를 응답의 reference(RRN) 에 그대로 돌려준다.
      if (str(last.reference)?.toUpperCase() === reference) return { ...last, operation: "Transaction" };
      // 바쁨(5) = 아직 우리 거래를 처리 중일 수 있다. 다시 묻는다.
      if (str(last.result) === "5") continue;
      // 마지막 거래가 다른 것이다. 우리 거래가 안 갔을 가능성이 크지만 확신할 수 없다 —
      // "안 나갔다" 고 잘못 말하면 카드를 두 번 긁게 된다. 직원이 단말기를 보게 한다.
      return null;
    } catch {
      // 아직 단말기가 돌아오지 않았다. 다시.
    }
  }
  return null;
}

export const terminal = {
  /** 판매. 손님이 단말기에서 카드를 대고(팁은 단말기 설정대로) 승인되면 서버 기록을 돌려준다. */
  sale: (settings: TerminalSettings, bill: number, amount: Cents, onStatus?: RunOptions["onStatus"]) =>
    run(settings, bill, "sale", { type: "SALE", requestedAmount: String(amount) }, { onStatus }),

  /** 아직 정산(배치 마감) 전인 거래를 통째로 취소. 카드가 필요 없다. 체크카드는 안 된다(PTA 규칙). */
  void: (settings: TerminalSettings, bill: number, originalAuthCode: string, options: RunOptions = {}) =>
    run(settings, bill, "void", { type: "VOID", originalAuthCode }, options),

  /** 환불. 손님이 카드를 다시 댄다. 체크카드나 정산이 끝난 거래는 VOID 대신 이것. */
  refund: (settings: TerminalSettings, bill: number, amount: Cents, options: RunOptions = {}) =>
    run(settings, bill, "refund", { type: "REFUND", requestedAmount: String(amount) }, options),

  /** 진행 중인 거래를 계산대에서 취소. 은행과 통신을 시작했으면 단말기가 거절한다(result 13). */
  cancel: () => {
    if (live?.operation === "Transaction") live.socket.send(JSON.stringify({ operation: "Cancel" }));
  },

  /** 연결 확인. 단말기 모델·일련번호를 한 줄로. */
  async test(settings: TerminalSettings): Promise<string> {
    if (settings.mode === "practice") return "Practice mode — no terminal needed.";
    if (!settings.url) throw new TerminalError("Enter the terminal's IP address first.");
    if (busy) throw new TerminalError("The terminal is running a transaction.");
    const response = await exchange(settings.url, { operation: "GetInformation" }, { timeoutMs: 10_000 }).catch(
      (error) => {
        throw error instanceof DroppedError ? new TerminalError("The terminal closed the connection.") : error;
      },
    );
    const info = (response.information ?? {}) as Record<string, unknown>;
    const model = str(info.model) ?? "terminal";
    const serial = str(info.serialNumber) ?? str(info.serial) ?? "";
    return `Connected to ${model}${serial ? ` (${serial})` : ""}.`;
  },

  /** 이 계산서에서 승인됐는데 아직 Charge 에 안 쓰인 것(화면을 다시 열었을 때 결제 줄로 되살린다). */
  pending: (bill: number) => staffRpc<TerminalRecord[]>("pelham_staff_terminal_pending", { p_bill: bill }),
  forBill: (bill: number) => staffRpc<TerminalRecord[]>("pelham_staff_terminal_for_bill", { p_bill: bill }),

  /**
   * 지난번에 서버에 못 남긴 결과를 마저 남긴다. 결과도 못 받은 것은 단말기에 물어본다.
   * 계산서 화면을 열 때 부른다. 남긴 개수를 돌려준다.
   */
  async recoverPending(settings: TerminalSettings): Promise<number> {
    if (busy) return 0;
    let saved = 0;
    for (const item of readPending()) {
      let result = item.result;
      if (!result && settings.mode === "live" && settings.url) {
        const found = await askLastTransaction(settings.url, item.reference).catch(() => null);
        if (found) result = parseTransaction(item.kind, item.reference, found);
      }
      if (!result) {
        if (!(Date.now() - (item.at ?? 0) < PENDING_MAX_AGE_MS)) {
          updatePending((list) => list.filter((entry) => entry.reference !== item.reference));
        }
        continue;
      }
      try {
        await record(item.bill_id, result, item.cancels);
        saved += 1;
        updatePending((list) => list.filter((entry) => entry.reference !== item.reference));
      } catch {
        // 다음에 다시.
      }
    }
    return saved;
  },
};
