/**
 * 카드 단말기(Stripe Terminal — S700 등 스마트 리더) 연동.
 *
 * ## 어떻게 붙는가 (서버 주도, server-driven)
 * 계산대 브라우저는 리더에 직접 닿지 않는다. 브라우저가 FastAPI(`backend/api/routes/terminal.py`)에
 * "이 계산서의 $X 를 이 리더로" 를 보내면, 서버가 Stripe 에 PaymentIntent 를 만들고 리더에 띄운다.
 * 리더는 인터넷으로 Stripe 에 붙어 있으므로 매장 LAN·인증서 설정이 필요 없고, 비밀 키는 서버에만 있다.
 * 직원 확인은 요청에 붙는 Supabase 로그인 토큰으로 SQL(0021 `pelham_staff_terminal_*`)이 한다.
 *
 * ## 돈을 잃지 않는 순서
 * 1) 서버가 보내기 **전에** pending 한 줄을 남긴다(0021). 그 줄 id 가 결제 줄의 `terminal_txn` 이 된다.
 * 2) 화면은 몇 초마다 그 줄을 묻는다. 서버는 그때마다 Stripe 에 다시 물어 결과가 나왔으면 기록한다.
 *    웹훅도 같은 일을 하므로 화면이 닫혀도 결과는 남는다.
 * 3) 화면을 다시 열면 `recover()` 가 결과를 모르는 줄을 마무리하고, `pending()` 이 승인됐는데 아직
 *    Charge 에 안 쓰인 줄을 결제 줄로 되살린다.
 *
 * 테스트 키(`sk_test_…`)에서는 가상 리더(`simulated-s700`)를 등록해 "Simulate tap" 으로 카드를 댄 것처럼
 * 할 수 있다 — 실제 리더 없이 계산대 흐름 전체를 시험한다.
 */

import { useSyncExternalStore } from "react";

import { paymentsApiBase } from "@/lib/booking/payments";
import { ApiError } from "@/lib/teeSheet/api";
import { accessToken } from "@/lib/teeSheet/session";
import { staffRpc } from "@/lib/teeSheet/staffRpc";
import type { Cents } from "@/lib/retail/types";

// ===== 설정 (이 기기에만) ==============================================

/** off = 예전처럼 단말기에 손으로 치고 승인번호를 적는다. live = Stripe 리더로 보낸다. */
export type TerminalMode = "off" | "live";
export type TerminalSettings = { mode: TerminalMode; readerId: string; readerLabel: string };

const SETTINGS_KEY = "pelham.pos.stripeTerminal";
const DEFAULT_SETTINGS: TerminalSettings = { mode: "off", readerId: "", readerLabel: "" };
let settingsFallback: TerminalSettings = DEFAULT_SETTINGS;
let settingsCache: { raw: string | null; value: TerminalSettings } | null = null;
const settingsListeners = new Set<() => void>();

function parseSettings(raw: string | null): TerminalSettings {
  if (!raw) return DEFAULT_SETTINGS;
  try {
    const value = JSON.parse(raw) as Partial<TerminalSettings>;
    return {
      mode: value.mode === "live" ? "live" : "off",
      readerId: typeof value.readerId === "string" ? value.readerId : "",
      readerLabel: typeof value.readerLabel === "string" ? value.readerLabel : "",
    };
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
  settingsFallback = next;
  try {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
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

export function terminalEnabled(settings: TerminalSettings): boolean {
  return settings.mode === "live" && settings.readerId !== "";
}

// ===== 결과 ============================================================

export type CardType = "credit" | "debit" | "gift" | "ebt";

/** 서버(0021)의 단말기 기록 한 줄. */
export type TerminalRecord = {
  id: number;
  kind: "sale" | "refund" | "void";
  reference: string;
  bill_id: number | null;
  /** pending · succeeded · failed · canceled */
  result: string;
  pending: boolean;
  approved: boolean;
  requested_amount: Cents;
  tip: Cents;
  total_amount: Cents;
  auth_code: string | null;
  original_auth_code: string | null;
  transaction_id: string | null;
  payment_intent: string | null;
  reader_id: string | null;
  refund_of: number | null;
  response_code: string | null;
  host_message: string | null;
  card_brand: string | null;
  card_last4: string | null;
  card_type: CardType | null;
  entry_mode: string | null;
  used: boolean;
  voided_at: string | null;
  created_at: string;
};

export function describeTerminalResult(record: TerminalRecord): string {
  if (record.approved) return "Approved";
  if (record.pending) return "Still waiting for the reader.";
  if (record.result === "canceled") return record.host_message || "Cancelled.";
  return record.host_message ? `Declined — ${record.host_message}` : "Declined.";
}

export class TerminalError extends Error {
  constructor(
    message: string,
    /** true = 돈이 나갔는지 모른다. 직원이 리더 화면을 봐야 한다. */
    readonly uncertain = false,
  ) {
    super(message);
  }
}

export type Reader = {
  id: string;
  label: string;
  device_type: string | null;
  status: string | null;
  simulated: boolean;
};

// ===== 서버 호출 =======================================================

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await accessToken();
  if (!token) throw new ApiError(401, "Sign in with a pro shop account.");
  let response: Response;
  try {
    response = await fetch(`${paymentsApiBase()}/payments${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(init?.headers ?? {}) },
    });
  } catch {
    throw new ApiError(0, "Network error");
  }
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`.trim();
    try {
      const body = (await response.json()) as { detail?: unknown };
      if (typeof body?.detail === "string" && body.detail) message = body.detail;
    } catch {
      // JSON 이 아닌 오류 본문. 상태 줄을 그대로 쓴다.
    }
    throw new ApiError(response.status, message);
  }
  return (await response.json()) as T;
}

const post = <T>(path: string, body: unknown = {}) => call<T>(path, { method: "POST", body: JSON.stringify(body) });

let configPromise: Promise<{ enabled: boolean; environment: "test" | "live" }> | null = null;

/** 서버에 Stripe 키가 있는가, 테스트 키인가. 한 번 읽어 둔다(실패하면 다음에 다시). */
export function terminalConfig(): Promise<{ enabled: boolean; environment: "test" | "live" }> {
  configPromise ??= fetch(`${paymentsApiBase()}/payments/terminal/config`)
    .then((r) => (r.ok ? r.json() : { enabled: false, environment: "live" }))
    .catch(() => {
      configPromise = null;
      return { enabled: false, environment: "live" as const };
    });
  return configPromise;
}

// ===== 결과 기다리기 ===================================================

const POLL_MS = 1500;
/** 리더가 손님을 기다리는 최대 시간보다 조금 길게. 그 뒤에는 직원이 리더를 본다. */
const POLL_LIMIT_MS = 4 * 60 * 1000;

const STATUS_TEXT: Record<string, string> = {
  sale: "Waiting for the customer to tap, insert or swipe…",
  refund: "Waiting for the customer to tap the card for the refund…",
};

/** pending 이 끝날 때까지 서버에 묻는다. 연결이 잠깐 끊겨도 계속 묻는다 — 결과는 서버에 남아 있다. */
async function waitFor(record: TerminalRecord, onStatus?: (text: string) => void): Promise<TerminalRecord> {
  const started = Date.now();
  let current = record;
  let misses = 0;
  while (current.pending) {
    onStatus?.(misses > 0 ? "Lost the connection — still checking…" : (STATUS_TEXT[current.kind] ?? "Working…"));
    if (Date.now() - started > POLL_LIMIT_MS) {
      throw new TerminalError(
        "The reader has not finished. Look at the reader screen; if it shows Approved, reopen this bill and the payment comes back.",
        true,
      );
    }
    await new Promise((resolve) => window.setTimeout(resolve, POLL_MS));
    try {
      current = await call<TerminalRecord>(`/terminal/txn/${current.id}`);
      misses = 0;
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) throw error;
      misses += 1;
    }
  }
  return current;
}

export type RunOptions = {
  /** 진행 알림 한 줄. */
  onStatus?: (text: string) => void;
  /** 서버가 pending 줄을 만들었을 때(취소·시험 버튼이 그 id 를 쓴다). */
  onStarted?: (record: TerminalRecord) => void;
};

export const terminal = {
  /** 판매. 리더에 금액이 뜨고, 손님이 카드를 대면(팁은 리더 설정대로) 승인된 서버 기록을 돌려준다. */
  async sale(settings: TerminalSettings, bill: number, amount: Cents, options: RunOptions = {}): Promise<TerminalRecord> {
    if (!terminalEnabled(settings)) throw new TerminalError("Pick a card reader for this register first.");
    options.onStatus?.("Sending to the reader…");
    const started = await post<TerminalRecord>("/terminal/sale", { bill_id: bill, amount, reader_id: settings.readerId });
    options.onStarted?.(started);
    return waitFor(started, options.onStatus);
  },

  /**
   * 승인된 판매를 되돌린다(Charge 전 결제 줄 삭제, 또는 환불 화면). 신용카드는 카드 없이 바로,
   * Interac(체크카드)은 손님이 리더에 카드를 다시 댄다. 금액을 주지 않으면 전액(팁 포함).
   */
  async refund(
    settings: TerminalSettings,
    bill: number,
    sale: Pick<TerminalRecord, "id">,
    options: RunOptions & { amount?: Cents } = {},
  ): Promise<TerminalRecord> {
    options.onStatus?.("Refunding…");
    const started = await post<TerminalRecord>("/terminal/refund", {
      bill_id: bill,
      refund_of: sale.id,
      ...(options.amount ? { amount: options.amount } : {}),
      ...(settings.readerId ? { reader_id: settings.readerId } : {}),
    });
    options.onStarted?.(started);
    return waitFor(started, options.onStatus);
  },

  /** 진행 중인 거래를 계산대에서 취소. 손님이 이미 승인을 받았으면 취소되지 않는다. */
  cancel: (id: number) => post<TerminalRecord>(`/terminal/txn/${id}/cancel`),

  /** 테스트 모드: 가상 리더에 카드를 댄 것처럼. interac = 체크카드. */
  simulate: (id: number, interac = false) => post<TerminalRecord>(`/terminal/txn/${id}/simulate`, { interac }),

  readers: () => call<{ environment: "test" | "live"; readers: Reader[] }>("/terminal/readers"),

  /** 리더 등록. 진짜 리더는 리더 화면의 등록 코드, 테스트 모드는 `simulated-s700`. */
  register: (registrationCode: string, label: string) =>
    post<Reader>("/terminal/readers", { registration_code: registrationCode, label }),

  /** 연결 확인: 고른 리더가 Stripe 에 온라인인가. */
  async test(settings: TerminalSettings): Promise<string> {
    if (!settings.readerId) throw new TerminalError("Pick a reader first.");
    const { readers, environment } = await terminal.readers();
    const found = readers.find((reader) => reader.id === settings.readerId);
    if (!found) throw new TerminalError("That reader is no longer registered in Stripe. Pick another one.");
    const mode = environment === "test" ? " (Stripe test mode — no real charges)" : "";
    return found.status === "online"
      ? `${found.label} is online${mode}.`
      : `${found.label} is ${found.status ?? "offline"}. Check that it is on and connected to the internet${mode}.`;
  },

  /** 이 계산서에서 승인됐는데 아직 Charge 에 안 쓰인 것(화면을 다시 열었을 때 결제 줄로 되살린다). */
  pending: (bill: number) => staffRpc<TerminalRecord[]>("pelham_staff_terminal_pending", { p_bill: bill }),
  forBill: (bill: number) => staffRpc<TerminalRecord[]>("pelham_staff_terminal_for_bill", { p_bill: bill }),

  /** 결과를 모르는 거래를 서버가 Stripe 에 물어 마무리한다. 계산서 화면을 열 때 부른다. */
  recover: (bill: number) =>
    post<{ transactions: TerminalRecord[] }>(`/terminal/bill/${bill}/sync`).then((body) => body.transactions),
};
