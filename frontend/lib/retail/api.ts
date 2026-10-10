/**
 * 프로 샵 리테일(POS) 의 **유일한** 서버 래퍼. 다른 곳에 두 번째 래퍼를 만들지 마라.
 *
 * ## 왜 FastAPI 가 아니라 Supabase 함수인가
 * 리테일 API(`backend/api/routes/retail.py`)는 2026-09-16 Fly.io 체험 종료로 꺼졌다. 클럽은
 * 2026-09-29 에 리테일·스낵바를 티 시트처럼 Supabase 로 옮기기로 했다. 그래서 여기서는
 * `supabase/migrations/0005_pos_bills.sql` 의 `pelham_staff_pos_*` / `pelham_staff_bill*` 함수를
 * 티 시트와 같은 `staffRpc`(직원 로그인 토큰)로 부른다. 판매는 이제 "계산서"다 —
 * 담기와 결제는 `lib/pos/currentBill.ts` 가 맡고, 이 파일은 상품·매출·리포트를 읽고 쓴다.
 *
 * 화면이 받는 JSON 모양은 예전 FastAPI 와 같다(`types.ts`). 그래서 Products·Sales 탭은
 * 전송만 바뀌고 그대로 돈다.
 *
 * 오류: `ApiError` 를 `RetailApiError` 로 옮긴다. status 0 → network(연결 실패),
 * 그 밖은 http. 0005 가 아직 안 돌았으면(함수 없음) 그 사실을 문장으로 알린다.
 */

import { ApiError } from "@/lib/teeSheet/api";
import { staffRpc } from "@/lib/teeSheet/staffRpc";
import { MISSING_MIGRATION_MESSAGE, isMissingMigration } from "@/lib/pos/api";

import {
  computeTax,
  type Cents,
  type CloseoutReport,
  type CloseoutSave,
  type LowStockItem,
  type Product,
  type ProductCreate,
  type ProductUpdate,
  type RefundRequest,
  type RetailDailyReport,
  type Sale,
  type SaleCreate,
} from "./types";

/**
 * 리테일 서버가 없을 때 화면에 쓰는 문구. `NO_API_MESSAGE` 를 재사용하지 않는 이유:
 * 그쪽은 "전화로 예약하세요" 라는 **고객용** 문장이다. 계산대 앞의 직원에게
 * 클럽 전화번호를 안내해 봐야 아무 소용이 없다.
 */
export const NO_RETAIL_API_MESSAGE = "리테일 서버에 연결할 수 없습니다.";

/** 요청이 왜 실패했는가. 화면이 배너 문구를 고르는 데 쓴다. */
export type RetailErrorKind = "unconfigured" | "network" | "http";

export class RetailApiError extends Error {
  readonly kind: RetailErrorKind;
  /** HTTP 오류일 때만 의미가 있다. 그 외에는 0. */
  readonly status: number;

  constructor(kind: RetailErrorKind, status: number, message: string) {
    super(message);
    this.name = "RetailApiError";
    this.kind = kind;
    this.status = status;
  }

  /** 서버가 없어서 실패한 것인가(= 데모 데이터로 착지해야 하는가). */
  get offline(): boolean {
    return this.kind !== "http";
  }
}

/** 알 수 없는 throw 값을 화면이 다룰 수 있는 형태로. */
export function toRetailError(cause: unknown): RetailApiError {
  if (cause instanceof RetailApiError) return cause;
  if (isMissingMigration(cause)) return new RetailApiError("http", 404, MISSING_MIGRATION_MESSAGE);
  if (cause instanceof ApiError) {
    return cause.status === 0
      ? new RetailApiError("network", 0, NO_RETAIL_API_MESSAGE)
      : new RetailApiError("http", cause.status, cause.message);
  }
  return new RetailApiError("network", 0, NO_RETAIL_API_MESSAGE);
}

async function call<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  try {
    return await staffRpc<T>(fn, args);
  } catch (cause) {
    throw toRetailError(cause);
  }
}

/** 0010 이 아직 안 돌았을 때. 0005 문구로 내려가면 엉뚱한 파일을 다시 돌리게 된다. */
export const CLOSEOUT_MISSING_MESSAGE =
  "담당자별 마감이 아직 켜지지 않았습니다. Supabase SQL Editor 에서 0010_staff_closeout.sql 을 실행해 주세요.";

async function closeoutCall<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  try {
    return await staffRpc<T>(fn, args);
  } catch (cause) {
    if (isMissingMigration(cause)) throw new RetailApiError("http", 404, CLOSEOUT_MISSING_MESSAGE);
    throw toRetailError(cause);
  }
}

/** 매장 현지 날짜 `YYYY-MM-DD`. `toISOString()` 은 UTC 라 저녁에 하루가 밀린다. */
export function localBusinessDate(date: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export const retailApi = {
  // ===== 상품 =====
  /**
   * 필터를 주지 않으면 **비활성 상품까지 포함해** 돌려준다(재활성화용).
   * 분류·검색 필터는 여기서 거른다 — 상품은 수십 개라 서버에서 나눌 이유가 없다.
   */
  listProducts: async (filters?: { category?: string; q?: string; active?: boolean }) => {
    const list = await call<Product[]>("pelham_staff_pos_products", {
      p_active: filters?.active === undefined ? null : filters.active,
    });
    const needle = filters?.q?.trim().toLowerCase();
    return list
      .filter((item) => (filters?.category ? item.category === filters.category : true))
      .filter((item) =>
        needle ? item.name.toLowerCase().includes(needle) || item.sku.toLowerCase().includes(needle) : true,
      );
  },

  createProduct: (input: ProductCreate) => call<Product>("pelham_staff_pos_product_create", { p: input }),

  updateProduct: (id: number, patch: ProductUpdate) =>
    call<Product>("pelham_staff_pos_product_update", { p_id: id, p: patch }),

  /** 지우지 않고 `is_active = false`. 지난 계산서가 이 상품을 가리키기 때문이다. */
  deactivateProduct: (id: number) => call<Product>("pelham_staff_pos_product_deactivate", { p_id: id }),

  // ===== 매출 (= 결제된·환불된 계산서) =====
  listSales: (businessDate?: string) =>
    call<Sale[]>("pelham_staff_bills", { p_date: businessDate || localBusinessDate() }),

  getSale: (id: number) => call<Sale>("pelham_staff_bill", { p_id: id }),

  /**
   * 카드·체크카드 환불은 **단말기(Stripe)에서 먼저** 한다. 이 호출은 그 뒤에 장부를 맞춘다:
   * 계산서를 refunded 로, 재고를 되돌리고, 그린피를 미결제로.
   */
  refundSale: (id: number, body: RefundRequest) =>
    call<Sale>("pelham_staff_bill_refund", { p_bill: id, p_reason: body.reason }),

  // ===== 리포트 =====
  getDailyReport: (businessDate: string) =>
    call<RetailDailyReport>("pelham_staff_pos_report_daily", { p_date: businessDate }),

  listLowStock: () => call<LowStockItem[]>("pelham_staff_pos_low_stock"),

  // ===== 담당자별 마감 + 팁 나누기 (0010) =====
  getCloseouts: (businessDate: string) =>
    closeoutCall<CloseoutReport>("pelham_staff_closeout_report", { p_date: businessDate }),

  /** 마감(같은 사람을 다시 마감하면 덮어쓴다). 리포트 전체를 돌려준다. */
  saveCloseout: (businessDate: string, body: CloseoutSave) =>
    closeoutCall<CloseoutReport>("pelham_staff_closeout_save", { p_date: businessDate, p: body }),

  reopenCloseout: (businessDate: string, staffKey: string) =>
    closeoutCall<CloseoutReport>("pelham_staff_closeout_reopen", { p_date: businessDate, p_staff_key: staffKey }),
};

export default retailApi;

// ===== 금액 계산 ========================================================
//
// 금액과 재고는 **서버가 정답**이다(`SaleCreate` 는 합계를 아예 보내지 않는다).
// 그래도 계산대 화면은 "Charge" 를 누르기 전에 합계를 보여 줘야 하므로 같은
// 산술이 두 저장소에 존재한다. 프론트 쪽 사본을 여기 한 함수로 모아 둔다 —
// 나중에 서버와 어긋났을 때 고칠 자리가 한 곳이도록.

export type CartLine = {
  product: Product;
  quantity: number;
  /** 이 줄에 걸린 할인(센트). 단가가 아니라 줄 합계에서 뺀다. */
  discount: Cents;
};

export type CartTotals = {
  subtotal: Cents;
  discount: Cents;
  tax: Cents;
  total: Cents;
  /** 줄 단위 합계. 화면에 그대로 찍는다. */
  lineTotals: Cents[];
};

/** 0 이상 정수로 자른다. 음수 수량·소수점 수량이 서버로 새어 나가지 않게. */
function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * 장바구니 합계. 전부 센트 정수다 — 달러 실수로 계산하면 하루치를 합산한
 * 마감 리포트에서 1센트씩 어긋난 게 눈에 보인다.
 *
 * 세금은 **할인 뒤 금액**에 매기고, 반올림은 계약의 `computeTax` 에 맡긴다.
 * `Math.round` 를 쓰면 서버(파이썬 `round()`, 은행가 반올림)와 1센트 어긋난다 —
 * 0..200000 센트 전 구간을 두 런타임으로 비교해 1000개가 어긋나는 것을 확인했다.
 *
 * 이 값은 **결제 전 미리보기 전용**이다. 결제 후에는 서버가 돌려준 `tax`/`total`
 * 을 그대로 표시한다.
 */
export function computeCartTotals(lines: CartLine[], orderDiscount: Cents): CartTotals {
  const lineTotals: Cents[] = [];
  let subtotal = 0;

  for (const line of lines) {
    const quantity = clampInt(line.quantity, 0, 9999);
    const gross = quantity * line.product.price;
    // 줄 할인이 줄 합계를 넘으면 음수 줄이 생긴다. 그런 영수증은 존재할 수 없다.
    const discount = clampInt(line.discount, 0, gross);
    const lineTotal = gross - discount;
    lineTotals.push(lineTotal);
    subtotal += lineTotal;
  }

  const discount = clampInt(orderDiscount, 0, subtotal);
  const taxable = subtotal - discount;
  const tax = computeTax(taxable);

  return { subtotal, discount, tax, total: taxable + tax, lineTotals };
}

/** 장바구니를 `POST /retail/sales` 가 받는 모양으로. 서버가 금액을 다시 계산한다. */
export function toSaleCreate(
  lines: CartLine[],
  fields: {
    orderDiscount: Cents;
    paymentMethod: SaleCreate["payment_method"];
    cashier?: string | null;
    note?: string | null;
    businessDate?: string;
  },
): SaleCreate {
  // 서버는 줄 할인 > 줄 합계, 주문 할인 > 소계를 400 으로 거절한다. 거절에
  // 기대지 않고 여기서 잘라 둔다 — 화면에는 이미 잘린 합계가 찍혀 있으므로,
  // 그대로 보내면 "화면과 다른 이유로" 결제가 실패한 것처럼 보인다.
  const totals = computeCartTotals(lines, fields.orderDiscount);

  return {
    lines: lines.map((line) => ({
      product_id: line.product.id,
      quantity: clampInt(line.quantity, 1, 9999),
      discount: clampInt(line.discount, 0, clampInt(line.quantity, 1, 9999) * line.product.price),
    })),
    // `computeCartTotals` 가 소계로 잘라 준 값. 소계를 넘는 주문 할인은 없다.
    discount: totals.discount,
    payment_method: fields.paymentMethod,
    cashier: fields.cashier?.trim() || null,
    note: fields.note?.trim() || null,
    ...(fields.businessDate ? { business_date: fields.businessDate } : {}),
  };
}
