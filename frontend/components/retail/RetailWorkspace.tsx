"use client";

/**
 * 프로 샵 리테일(POS). 계산 / 상품·재고 두 가지를 **한 페이지 안의 상태**로 전환한다.
 * 매출·마감은 여기 없다 — 클럽 종합 보고서(Reports)로 가는 링크만 둔다(2026-09-30 일원화).
 *
 * 왜 라우트를 쪼개지 않는가: 정적 export 라 탭마다 페이지를 만들면 이동할 때마다
 * 컴포넌트가 새로 마운트되어 **담아 둔 장바구니가 날아간다.** 계산 중에 재고를
 * 확인하러 갔다 오는 것은 카운터에서 늘 있는 일이다.
 *
 * 같은 이유로 탭 전환도 `{tab === "register" ? <RegisterTab/> : null}` 로 하면 안 된다.
 * 조건부 렌더는 **언마운트**라서 라우트를 쪼갠 것과 똑같이 장바구니가 사라진다.
 * 그래서 둘 다 켜 두고 `hidden` 으로 **보이기만** 끈다.
 *
 * 데이터는 여기서 한 번만 읽어서 탭에 내려 준다. 탭마다 각자 읽으면 계산대에서
 * 팔린 재고가 상품 목록에는 반영되지 않은, 서로 다른 두 진실이 생긴다.
 *
 * 프로 샵(`/admin/retail`)과 스낵바(`/admin/snack-bar`)가 이 한 벌을 같이 쓴다. 스낵바는
 * `category` 로 `Food & Beverage` 만 보는 계산대다 — 계산대를 두 개 만들면 결제·영수증·
 * 스캐너 규칙이 따로 늙는다.
 */

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import AdminShell from "@/components/admin/AdminShell";
import ProductsTab from "@/components/retail/ProductsTab";
import RegisterHome from "@/components/retail/RegisterHome";
import RegisterTab, { RECEIPT_NO } from "@/components/retail/RegisterTab";
import { demoLowStock, demoProducts } from "@/components/retail/demoData";
import { Chip, ErrorNote, OfflineBanner } from "@/components/retail/ui";
import { ADMIN_REPORTS, ADMIN_RETAIL, ADMIN_SNACK_BAR } from "@/lib/nav";
import retailApi, { toRetailError } from "@/lib/retail/api";
import type { LowStockItem, Product, RetailCategory } from "@/lib/retail/types";

const TABS = [
  { id: "register", label: "Register" },
  { id: "products", label: "Products" },
] as const;

type TabId = (typeof TABS)[number]["id"];

type Props = {
  title: string;
  /** 이 분류만 파는 계산대(스낵바). 없으면 프로 샵 전체. */
  category?: RetailCategory;
  /** 계산대를 카메라 스캔이 켜진 채로 연다(`/admin/scan` 바로가기). */
  startWithCamera?: boolean;
  /** 설치형 계산대 앱(`/pos`)에서 열렸다. 관리자 메뉴와 Reports 링크를 감춘다. */
  posApp?: boolean;
};

export default function RetailWorkspace({ title, category, startWithCamera, posApp = false }: Props) {
  const [tab, setTab] = useState<TabId>("register");
  /**
   * Register 탭 안의 두 화면: Lightspeed 식 첫 화면(home)과 판매 화면(sale). 카메라 바로가기는
   * 곧장 판매로 연다. 판매 화면은 홈에서도 마운트된 채라 스캔·장바구니가 그대로다.
   */
  const [view, setView] = useState<"home" | "sale">(startWithCamera ? "sale" : "home");
  const [refundRequest, setRefundRequest] = useState<{ code: string; at: number } | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [lowStock, setLowStock] = useState<LowStockItem[]>([]);
  const [loading, setLoading] = useState(true);
  /**
   * 서버에 닿지 못했다 → 예시 데이터를 보여 주고 저장 계열을 전부 잠근다.
   * `unconfigured`(주소 없음)와 `network`(연결 실패)를 화면에서 구분하지는 않는다 —
   * 계산대 앞 직원에게 둘은 같은 상황이다.
   */
  const [offline, setOffline] = useState(false);
  const [detail, setDetail] = useState("");
  /** 진짜 목록을 들고 있는데 새로고침만 실패한 경우. 데모로 내려가지 않는다. */
  const [refreshError, setRefreshError] = useState("");

  // 한 번이라도 진짜 목록을 받아 봤는가. 아래 `load` 의 실패 처리에서만 쓰므로
  // 렌더를 다시 돌릴 이유가 없어 state 가 아니라 ref 다.
  const hasRealData = useRef(false);

  const load = useCallback(async (options?: { background?: boolean }) => {
    // 판매 직후의 재고 갱신처럼 배경에서 도는 재조회는 스켈레톤을 띄우지 않는다.
    // 띄우면 결제할 때마다 상품 격자가 통째로 깜빡여서, 다음 손님을 찍으려던
    // 직원이 사라진 카드를 다시 찾아야 한다.
    if (!options?.background) setLoading(true);
    try {
      const list = await retailApi.listProducts();
      hasRealData.current = true;
      setProducts(list);
      setOffline(false);
      setDetail("");
      setRefreshError("");
      // 저재고는 곁가지다. 이게 없다고 상품 목록까지 데모로 떨어뜨리지 않는다.
      try {
        setLowStock(await retailApi.listLowStock());
      } catch {
        setLowStock([]);
      }
    } catch (cause) {
      const error = toRetailError(cause);

      if (hasRealData.current) {
        // 이미 진짜 목록을 들고 있다. 새로고침 한 번 실패했다고 예시 데이터로
        // 갈아 끼우면, 방금 서버가 찍어 준 진짜 영수증 위에 "표시된 값은
        // 예시입니다" 배너가 뜬다 — 직원이 방금 받은 돈을 의심하게 된다.
        setRefreshError(error.message);
        return;
      }

      // 처음부터 아무것도 못 받았다 → 예시 데이터로 착지한다. 빈 화면을
      // 보여 주면 직원은 "앱이 고장났다" 고 판단하고 닫는다.
      setOffline(true);
      // HTTP 오류일 때만 서버가 쓴 문장을 덧붙인다. 연결 실패의 문구에는
      // 서버 주소가 섞여 나올 수 있어 그대로 보여 주지 않는다.
      setDetail(error.kind === "http" ? error.message : "");
      setProducts(demoProducts);
      setLowStock(demoLowStock);
    } finally {
      if (!options?.background) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const refresh = useCallback(() => {
    void load({ background: true });
  }, [load]);

  // 데모 = 서버 없이 예시를 보고 있는 상태. 저장 계열 버튼을 전부 잠근다.
  // 저장된 줄 알았는데 아무 데도 안 남는 것이 빈 화면보다 나쁘다.
  const demo = offline;

  const registerName = category ? "Snack Bar / Bev Cart" : "Pro Shop";
  const station = category === "Food & Beverage" ? "snack_bar" : "pro_shop";
  // 설치형 앱은 `/pos` 의 계산대 고르기로(`pick` 이 있으면 지난 계산대로 바로 가지 않는다).
  const switchHref = posApp ? "/pos?pick=1" : category ? ADMIN_RETAIL : ADMIN_SNACK_BAR;

  /** 첫 화면에서 쏜 스캔: 영수증이면 환불 창, 상품이면 판매 화면으로 넘기고 계산대가 담는다. */
  function onScanned(code: string): boolean {
    if (view !== "home") return false;
    if (RECEIPT_NO.test(code.trim())) {
      setRefundRequest({ code: code.trim(), at: Date.now() });
      return true;
    }
    setView("sale");
    return false;
  }

  const shownProducts = useMemo(
    () => (category ? products.filter((item) => item.category === category) : products),
    [category, products],
  );
  const shownLowStock = useMemo(
    () => (category ? lowStock.filter((item) => item.category === category) : lowStock),
    [category, lowStock],
  );

  return (
    <AdminShell
      actions={
        // AdminShell 은 `actions` 를 데스크톱 헤더와 모바일 줄에 **두 번** 그린다.
        // 그래서 여기에는 id/htmlFor 를 쓰지 않는다 — 중복 id 는 label 연결을 깬다.
        <div className="flex flex-wrap gap-1.5">
          {TABS.map((item) => (
            <Chip
              active={tab === item.id}
              key={item.id}
              onClick={() => {
                // 이미 Register 에 있는데 또 누르면 첫 화면으로(Lightspeed 의 Sales 메뉴와 같다).
                if (item.id === "register" && tab === "register") setView("home");
                setTab(item.id);
              }}
            >
              {item.label}
            </Chip>
          ))}
          {posApp ? null : (
            <Link
              className="inline-flex min-h-11 shrink-0 items-center border border-[#d4d4d8] bg-white px-3 text-sm font-bold whitespace-nowrap text-[#3f434a] hover:bg-[#f2f2f4]"
              href={ADMIN_REPORTS}
            >
              Sales report →
            </Link>
          )}
        </div>
      }
      title={title}
      variant={posApp ? "pos" : "admin"}
    >
      {/* 문서형 화면이라 `fill` 을 쓰지 않는다. pb-safe 로 홈 인디케이터를 피한다. */}
      <div className="grid min-w-0 gap-3 p-3 pb-safe">
        {offline ? <OfflineBanner demo detail={detail} /> : null}
        {refreshError ? (
          <ErrorNote>목록을 새로 읽지 못했습니다 — 화면의 값이 최신이 아닐 수 있습니다. {refreshError}</ErrorNote>
        ) : null}

        {/* 세 탭 모두 마운트한 채로 두고 보이기만 끈다. 조건부 렌더로 바꾸면
            상품을 담아 둔 채 재고를 확인하러 갔다 온 순간 장바구니가 비어 있다. */}
        {tab === "register" && view === "home" ? (
          <RegisterHome
            active
            demo={demo}
            onOpenSale={() => setView("sale")}
            refundRequest={refundRequest}
            registerName={registerName}
            station={station}
            switchHref={switchHref}
          />
        ) : null}

        <div className={tab === "register" && view === "sale" ? "grid min-w-0 gap-3" : "hidden"}>
          <div className="flex min-w-0 items-center gap-2">
            <button
              className="inline-flex min-h-11 shrink-0 items-center gap-1.5 border border-[#d4d4d8] bg-white px-3 text-sm font-bold text-[#3f434a] hover:bg-[#f2f2f4]"
              onClick={() => setView("home")}
              type="button"
            >
              <span aria-hidden>←</span> Register
            </button>
            <span className="truncate text-xs font-bold tracking-wide text-[#6b7280] uppercase">{registerName}</span>
          </div>
          <RegisterTab
            demo={demo}
            loading={loading}
            lockedCategory={category}
            onScanned={onScanned}
            onSold={refresh}
            products={shownProducts}
            scanEnabled={tab === "register"}
            scanProducts={products}
            startWithCamera={startWithCamera}
          />
        </div>

        <div className={tab === "products" ? "min-w-0" : "hidden"}>
          <ProductsTab
            catalog={products}
            defaultCategory={category}
            demo={demo}
            loading={loading}
            lowStock={shownLowStock}
            onChanged={refresh}
            products={shownProducts}
          />
        </div>
      </div>
    </AdminShell>
  );
}
