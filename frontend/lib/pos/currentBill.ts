"use client";

/**
 * 이 계산대(브라우저)가 지금 채우고 있는 계산서 하나.
 *
 * 계산서 자체는 DB 에 있다(0005). 여기 남기는 것은 "어느 계산서를 채우는 중인가" 의 id 하나뿐이고,
 * 그것도 이 브라우저의 localStorage 에 둔다. 그래서 티 시트에서 그린피를 담고 리테일 화면으로
 * 넘어가도 같은 계산서가 이어진다(페이지가 바뀌면 React 상태는 사라진다).
 *
 * 규칙
 * - 서버에 보내는 변경은 **한 줄로 줄 세운다**(`enqueue`). 스캔을 빠르게 두 번 쏘면 응답이
 *   거꾸로 올 수 있고, 늦게 온 옛 계산서가 화면을 덮으면 장바구니가 튄다.
 * - 계산서가 다른 곳에서 결제·취소되면(다른 계산대, 다른 탭) 다음 새로고침에서 놓아 준다.
 * - `bills_open` 은 부를 때마다 금액을 다시 계산해 쓴다. 폴링하지 않는다 — 변경 뒤와
 *   창에 포커스가 돌아올 때만 읽는다.
 */

import { useSyncExternalStore } from "react";

import { describePosError, isMissingMigration, posApi, type Bill, type BillStation, type OpenItemInput, type PaymentInput } from "./api";

const STORAGE_KEY = "pelham.pos.currentBill";
const CASHIER_KEY = "pelham.pos.cashier";
const RECENT_CASHIERS_KEY = "pelham.pos.recentCashiers";

// ===== 담당자(이 기기) ==================================================
// 직원 로그인은 공용이라 "누가 받았나" 는 계산서의 Cashier 이름뿐이다. 담당자별 마감(0010)과
// 팁 나누기가 이 이름으로 묶이므로, 기기마다 마지막 이름을 기억해 새 계산서에 미리 넣는다.
// 최근 이름 목록은 자동 완성용 — 오타 하나로 한 사람이 두 마감으로 갈라지지 않게.

export function rememberedCashier(): string {
  try {
    return window.localStorage.getItem(CASHIER_KEY) ?? "";
  } catch {
    return "";
  }
}

export function recentCashiers(): string[] {
  try {
    const list = JSON.parse(window.localStorage.getItem(RECENT_CASHIERS_KEY) ?? "[]");
    return Array.isArray(list) ? list.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export function rememberCashier(name: string): void {
  const trimmed = name.trim().replace(/\s+/g, " ");
  if (!trimmed) return;
  try {
    window.localStorage.setItem(CASHIER_KEY, trimmed);
    const rest = recentCashiers().filter((item) => item.toLowerCase() !== trimmed.toLowerCase());
    window.localStorage.setItem(RECENT_CASHIERS_KEY, JSON.stringify([trimmed, ...rest].slice(0, 12)));
  } catch {
    // 저장소가 막힌 브라우저. 다음 계산서에서 다시 적으면 된다.
  }
}

export type CurrentBillState = {
  billId: number | null;
  bill: Bill | null;
  openBills: Bill[];
  busy: boolean;
  error: string;
  /** 0005 가 아직 안 돌았다. 계산서 기능 전체를 잠근다. */
  missing: boolean;
};

let state: CurrentBillState = {
  billId: null,
  bill: null,
  openBills: [],
  busy: false,
  error: "",
  missing: false,
};
let hydrated = false;
const listeners = new Set<() => void>();
let queue: Promise<unknown> = Promise.resolve();

function emit(patch: Partial<CurrentBillState>) {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener());
}

function readStoredId(): number | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const id = raw ? Number(raw) : NaN;
    return Number.isInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

function storeId(id: number | null) {
  try {
    if (id === null) window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, String(id));
  } catch {
    // 저장소가 막힌 브라우저. 이 탭이 열려 있는 동안은 메모리 값으로 버틴다.
  }
}

function setCurrent(bill: Bill | null) {
  const id = bill && bill.status === "open" ? bill.id : null;
  storeId(id);
  emit({ billId: id, bill: id ? bill : null });
}

/** 변경을 한 줄로 세운다. 앞의 것이 실패해도 뒤의 것은 돈다. */
function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => undefined);
  return run;
}

async function guarded<T>(task: () => Promise<T>): Promise<T | null> {
  emit({ busy: true, error: "" });
  try {
    const result = await task();
    emit({ busy: false, missing: false });
    return result;
  } catch (error) {
    emit({ busy: false, error: describePosError(error), missing: isMissingMigration(error) });
    return null;
  }
}

async function loadOpenBills() {
  const list = await posApi.listOpen();
  emit({ openBills: list });
  return list;
}

/** 서버에서 지금 계산서와 열린 계산서 목록을 다시 읽는다. 페이지 진입과 포커스 복귀 때. */
export function refreshBills(): Promise<void> {
  return enqueue(async () => {
    await guarded(async () => {
      const list = await loadOpenBills();
      const id = state.billId ?? readStoredId();
      const current = id ? list.find((bill) => bill.id === id) ?? null : null;
      // 목록에 없으면 다른 곳에서 결제·취소됐다. 놓아 준다.
      setCurrent(current);
    });
  });
}

async function ensureBill(station: BillStation): Promise<number> {
  if (state.billId) return state.billId;
  const cashier = rememberedCashier();
  const bill = await posApi.open({ station, ...(cashier ? { cashier } : {}) });
  setCurrent(bill);
  return bill.id;
}

/** 변경 하나를 보내고 결과 계산서로 화면을 바꾼다. 실패하면 목록을 다시 읽어 맞춘다. */
function mutate(task: (billId: number) => Promise<Bill>, station: BillStation): Promise<Bill | null> {
  return enqueue(async () => {
    const result = await guarded(async () => {
      const id = await ensureBill(station);
      const bill = await task(id);
      setCurrent(bill);
      return bill;
    });
    // 성공이든 실패든 목록은 최신으로(다른 계산대가 그 사이에 결제했을 수 있다).
    try {
      await loadOpenBills();
    } catch {
      // 목록만 못 읽었다. 지금 계산서는 이미 위에서 맞췄다.
    }
    return result;
  });
}

export const billActions = {
  addProduct: (productId: number, station: BillStation, quantity = 1) =>
    mutate((id) => posApi.addProduct(id, productId, quantity), station),
  addOpenItem: (item: OpenItemInput, station: BillStation) =>
    mutate((id) => posApi.addOpenItem(id, item), station),
  addTee: (bookingId: string, playerIds: string[] | undefined, station: BillStation = "tee_sheet") =>
    mutate((id) => posApi.addTee(id, bookingId, playerIds), station),
  addSim: (reservationId: number, station: BillStation = "simulator") =>
    mutate((id) => posApi.addSim(id, reservationId), station),
  setQuantity: (lineId: number, quantity: number, station: BillStation) =>
    mutate((id) => posApi.updateLine(id, lineId, { quantity }), station),
  setLineDiscount: (lineId: number, discount: number, station: BillStation) =>
    mutate((id) => posApi.updateLine(id, lineId, { discount }), station),
  update: (fields: { discount?: number; cashier?: string; note?: string; label?: string }, station: BillStation) =>
    mutate((id) => posApi.update(id, fields), station),

  /** 목록에서 다른 열린 계산서로 옮겨 탄다(손님 두 팀을 번갈아 받을 때). */
  select: (billId: number) =>
    enqueue(() =>
      guarded(async () => {
        const bill = await posApi.get(billId);
        setCurrent(bill);
      }),
    ),

  /** 지금 계산서를 놓고 빈 상태로. 계산서는 열린 채 목록에 남는다. */
  park: () => {
    setCurrent(null);
  },

  voidBill: (billId: number) =>
    enqueue(async () => {
      await guarded(async () => {
        await posApi.void(billId);
        if (state.billId === billId) setCurrent(null);
      });
      try {
        await loadOpenBills();
      } catch {
        // 무시: 다음 새로고침에서 맞춘다.
      }
    }),

  /**
   * 결제. 성공하면 결제된 계산서를 돌려주고 "지금 계산서" 를 비운다.
   * 연결이 끊겨 결과를 모르면 같은 checkoutId 로 다시 부르면 된다(서버가 한 번만 받는다).
   */
  pay: (checkoutId: string, payments: PaymentInput[]) =>
    enqueue(async () => {
      const billId = state.billId;
      if (!billId) return null;
      const paid = await guarded(() => posApi.pay(billId, checkoutId, payments));
      if (paid) {
        setCurrent(null);
      } else {
        // 결과를 모를 때: 서버에서 다시 읽어 이미 결제됐는지 본다.
        try {
          const latest = await posApi.get(billId);
          if (latest.status === "paid" && latest.checkout_id === checkoutId) {
            setCurrent(null);
            emit({ error: "" });
            return latest;
          }
          setCurrent(latest);
        } catch {
          // 그대로 둔다. 화면의 오류 문장이 다시 시도하라고 말한다.
        }
      }
      try {
        await loadOpenBills();
      } catch {
        // 무시.
      }
      return paid;
    }),

  /** 결제 직전에 금액을 서버 값으로 다시 맞춘다(직원이 단말기에 칠 금액). */
  reload: () =>
    enqueue(async () => {
      const billId = state.billId;
      if (!billId) return null;
      return guarded(async () => {
        const bill = await posApi.get(billId);
        setCurrent(bill);
        return bill;
      });
    }),

  clearError: () => emit({ error: "" }),
};

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!hydrated && typeof window !== "undefined") {
    hydrated = true;
    // 첫 구독 때 저장된 id 를 읽고 서버와 맞춘다. 렌더 중에 localStorage 를 읽지 않기 위해 여기서.
    emit({ billId: readStoredId() });
    void refreshBills();
    window.addEventListener("focus", () => void refreshBills());
  }
  return () => listeners.delete(listener);
}

/** 이벤트 처리기 안에서 지금 값을 읽을 때(렌더 밖). 렌더 중에는 `useCurrentBill` 을 쓴다. */
export function getBillState(): CurrentBillState {
  return state;
}

const SERVER_STATE: CurrentBillState = state;

export function useCurrentBill(): CurrentBillState {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => SERVER_STATE,
  );
}
