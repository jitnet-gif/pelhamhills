"use client";

/**
 * 계산대. 리테일에서 **하루에 수백 번 열리는 유일한 화면**이라, 나머지 두 탭이
 * 조금 불편한 것보다 여기가 한 번 불편한 쪽이 훨씬 비싸다.
 *
 * 실사용 기기는 프로 샵 카운터의 태블릿/휴대폰이다. 그래서
 * - 상품 카드는 손가락 과녁(최소 44px, 실제로는 카드 전체가 과녁)이고,
 * - 390px 에서 계산서는 옆이 아니라 **아래에서 올라오는 시트**이며,
 * - 담긴 것이 있으면 합계 줄이 화면 아래에 항상 붙어 있다.
 *
 * 담긴 것이 없을 때는 그 줄을 아예 그리지 않는다 — 어드민 껍데기의 하단 탭이
 * 문서 맨 아래에 있어서, 고정 줄이 늘 떠 있으면 다른 화면으로 갈 길을 덮는다.
 *
 * 장바구니는 이제 화면 상태가 아니라 **DB 의 열린 계산서**다(`lib/pos/currentBill.ts`,
 * 0005). 티 시트에서 담은 그린피가 여기 같은 계산서에 보이고, 한 번에 결제한다.
 */

import { useEffect, useMemo, useState, type KeyboardEvent } from "react";

import BillPanel from "@/components/pos/BillPanel";
import CameraScanner, { type PhotoOutcome, type ScanOutcome } from "@/components/pos/CameraScanner";
import { useBarcodeScanner } from "@/hooks/useBarcodeScanner";
import type { BillStation, OpenItemInput } from "@/lib/pos/api";
import { findProductByCode } from "@/lib/retail/findProduct";
import { matchPhoto } from "@/lib/retail/productPhoto";
import { billActions, getBillState, useCurrentBill } from "@/lib/pos/currentBill";
import { isRainCheckCode, offerRainCheckCode } from "@/lib/pos/rainCheck";
import { isPromoBarcode } from "@/lib/pos/promo";
import { groupProducts, type MenuGroup } from "@/lib/retail/menuGroups";
import { LOW_STOCK_RED_BELOW, RETAIL_CATEGORIES, formatMoney, type Product, type RetailCategory } from "@/lib/retail/types";

import OpenItemDialog from "./OpenItemDialog";
import PhoneScanDialog from "./PhoneScanDialog";
import { Chip, EmptyNote, ErrorNote, SkeletonCards, TextInput, useOverlayDismiss } from "./ui";

type Props = {
  products: Product[];
  /** 스캔으로 찾을 상품 전체. 스낵바에서 프로 샵 물건을 쏘아도 담긴다(격자는 `products` 만). */
  scanProducts?: Product[];
  loading: boolean;
  /** 서버가 없어서 예시 데이터를 보고 있는 상태. 계산서를 만들지 않는다. */
  demo: boolean;
  /** 결제가 끝나면 상품 목록(재고)을 다시 읽게 한다. */
  onSold: () => void;
  /** 스캐너를 듣는가. 탭이 숨겨져 있을 때 꺼야 Products 탭에서 쏜 스캔이 계산서로 새지 않는다. */
  scanEnabled?: boolean;
  /** 스낵바처럼 한 분류만 파는 계산대. 칩 줄을 감추고 그 분류만 보인다. */
  lockedCategory?: RetailCategory;
  /** 카메라 스캔을 켠 채로 연다. 바로가기 주소(`/admin/scan`)용. */
  startWithCamera?: boolean;
  /** 스캔을 먼저 보여 준다. true 를 돌려주면 받은 쪽이 처리한 것이다(첫 화면에서 쏜 영수증). */
  onScanned?: (code: string) => boolean;
};

/** 리테일 영수증 번호(`PH-20260915-0001`). 상품이 아니라 영수증을 쏜 경우를 알아본다. */
export const RECEIPT_NO = /^PH-\d{8}-\d+$/i;

export default function RegisterTab({
  products,
  scanProducts,
  loading,
  demo,
  onSold,
  scanEnabled = true,
  lockedCategory,
  startWithCamera = false,
  onScanned,
}: Props) {
  const [search, setSearch] = useState("");
  const [pickedCategory, setCategory] = useState<RetailCategory | "All">("All");
  const category = lockedCategory ?? pickedCategory;
  // 열어 둔 메뉴 그룹(폴더). Lightspeed 처럼 그룹 버튼을 먼저 보이고, 누르면 그 안의 상품만 보인다.
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const station: BillStation = lockedCategory === "Food & Beverage" ? "snack_bar" : "pro_shop";

  const { bill } = useCurrentBill();
  const [sheetOpen, setSheetOpen] = useState(false);
  // 스캔 실패 문구는 검색칸 바로 밑에 띄운다. 계산서 안의 오류 자리는 휴대폰에서
  // 접힌 시트 속이라, 스캐너를 쏜 직원 눈에 안 보인다.
  const [scanNote, setScanNote] = useState("");
  // 스캔으로 담으면 결제 칸을 바로 띄운다. 값이 바뀔 때마다 BillPanel 이 결제 칸으로 스크롤한다.
  const [revealPayments, setRevealPayments] = useState(0);
  const [cameraOpen, setCameraOpen] = useState(startWithCamera);
  const [openItemOpen, setOpenItemOpen] = useState(false);
  const [phoneScanOpen, setPhoneScanOpen] = useState(false);

  // PC 의 "Phone" QR 로 열렸다(`/admin/scan?bill=12`). 그 계산서로 옮겨 타야 휴대폰에서 담은 것이
  // PC 계산서에 들어간다. 새로고침해도 다시 옮겨 타지 않게 주소에서 지운다.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const id = Number(params.get("bill"));
    if (!Number.isInteger(id) || id <= 0) return;
    void billActions.select(id);
    params.delete("bill");
    const rest = params.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${rest ? `?${rest}` : ""}`);
  }, []);

  // 판매 화면에는 **활성 상품만** 올린다. 비활성 상품이 격자에 섞이면 이미
  // 안 파는 물건을 눌러 찍게 된다.
  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return products
      .filter((item) => item.is_active)
      .filter((item) => (category === "All" ? true : item.category === category))
      .filter((item) =>
        needle
          ? item.name.toLowerCase().includes(needle) ||
            item.sku.toLowerCase().includes(needle) ||
            (item.barcode ?? "").toLowerCase().includes(needle)
          : true,
      );
  }, [category, products, search]);

  // 검색 중에는 폴더를 건너뛰고 맞는 상품을 바로 늘어놓는다 — 어느 폴더에 있는지 몰라도 찾게.
  const searching = search.trim() !== "";
  const menu = useMemo(() => groupProducts(visible), [visible]);
  const shownGroup = searching ? null : (menu.groups.find((group) => group.key === openGroup) ?? null);

  function pickCategory(next: RetailCategory | "All") {
    setCategory(next);
    setOpenGroup(null);
  }

  const lineCount = bill?.lines.length ?? 0;

  function addToBill(product: Product): Promise<unknown> {
    if (demo) {
      setScanNote("예시 데이터입니다. 서버에 연결되기 전까지는 계산서에 담을 수 없습니다.");
      return Promise.resolve(null);
    }
    setScanNote("");
    return billActions.addProduct(product.id, station);
  }

  /**
   * 스캔(또는 SKU + Enter)으로 담으면 곧장 결제로 간다. 휴대폰은 계산서 시트를 열고,
   * 데스크톱은 오른쪽 계산서를 결제 칸까지 내린다. 카드를 눌러 담을 때는 열지 않는다 —
   * 여러 개를 연달아 누르는 중에 시트가 손가락을 가린다.
   * 결제 칸에 포커스는 주지 않는다. 입력칸에 커서가 있으면 다음 스캔이 그 칸에 글자로 들어간다.
   */
  function addAndOpenPayment(product: Product) {
    void addToBill(product).then((bill) => {
      if (!bill) return;
      if (!window.matchMedia("(min-width: 1024px)").matches) setSheetOpen(true);
      setRevealPayments((n) => n + 1);
    });
  }

  /**
   * 스캔 = 바코드 → SKU 정확 일치. 공산품은 Products 탭에서 바코드 칸에 쏘아 등록해 둔다.
   * 분류로 거르지 않는다 — 손님이 스낵바에서 프로 샵 물건을 같이 사면 한 계산서로 받는다.
   * 줄의 분류는 상품 것이라 매출 보고서의 구분은 그대로다.
   */
  function findBySku(raw: string): Product | null {
    return findProductByCode(scanProducts ?? products, raw);
  }

  function handleScan(code: string) {
    // 검색칸에서 쏜 스캔이면 칸에 글자(IME 가 한글이면 자모)가 남아 있다. 비운다.
    setSearch("");
    if (onScanned?.(code)) return;
    // 레인체크 전표: 계산서 결제 칸으로 넘긴다(그쪽이 찾고 금액을 잡는다).
    if (isRainCheckCode(code)) {
      if (!bill || bill.lines.length === 0) {
        setScanNote("That is a rain check. Ring in what it pays for first, then scan the rain check again.");
        return;
      }
      setScanNote("");
      offerRainCheckCode(code);
      if (!window.matchMedia("(min-width: 1024px)").matches) setSheetOpen(true);
      setRevealPayments((n) => n + 1);
      return;
    }
    // 프로모션 바코드(0078): 그린피 줄이 있는 계산서에 할인을 건다.
    if (isPromoBarcode(code)) {
      if (!bill || !bill.lines.some((line) => line.kind === "tee_player")) {
        setScanNote("That is a promo code. It discounts green fees — add the tee time to the bill first.");
        return;
      }
      setScanNote("");
      void billActions.applyPromo(code, station);
      if (!window.matchMedia("(min-width: 1024px)").matches) setSheetOpen(true);
      return;
    }
    const product = findBySku(code);
    if (product) {
      addAndOpenPayment(product);
      return;
    }
    setScanNote(
      RECEIPT_NO.test(code)
        ? `"${code}" is a receipt, not a product. Look it up on the Sales tab.`
        : `No product with barcode "${code}". Add it on the Products tab — scan it into the Barcode field.`,
    );
  }

  useBarcodeScanner(handleScan, { enabled: scanEnabled && !loading && !cameraOpen && !openItemOpen && !phoneScanOpen });

  /** 오픈 아이템(0038)을 담고 결제 칸을 띄운다 — 스캔으로 담을 때와 같다. */
  async function addOpenItem(item: OpenItemInput): Promise<boolean> {
    if (demo) {
      setScanNote("예시 데이터입니다. 서버에 연결되기 전까지는 계산서에 담을 수 없습니다.");
      return true;
    }
    setScanNote("");
    const added = await billActions.addOpenItem(item, station);
    if (!added) return false;
    if (!window.matchMedia("(min-width: 1024px)").matches) setSheetOpen(true);
    setRevealPayments((n) => n + 1);
    return true;
  }

  /**
   * 카메라 스캔 = 마트 계산대. 읽을 때마다 **담기만** 하고 결제 칸은 열지 않는다 —
   * 물건마다 시트가 튀어나오면 카메라를 가린다. 결제는 카메라 화면의 Pay 로 간다.
   */
  async function handleCameraCode(code: string): Promise<ScanOutcome> {
    if (loading) return { ok: false, message: "Products are still loading — try again in a moment." };
    // 레인체크 전표: 카메라를 닫고 계산서 결제 칸에서 크레딧을 잡는다.
    if (isRainCheckCode(code)) {
      if (!bill || bill.lines.length === 0) {
        return { ok: false, message: "That is a rain check. Scan what it pays for first, then the rain check." };
      }
      offerRainCheckCode(code);
      payFromCamera();
      return { ok: true, message: `Rain check ${code.trim().toUpperCase()}` };
    }
    if (isPromoBarcode(code)) {
      if (!bill || !bill.lines.some((line) => line.kind === "tee_player")) {
        return { ok: false, message: "That is a promo code. Add the tee time to the bill first." };
      }
      const applied = await billActions.applyPromo(code, station);
      return applied
        ? { ok: true, message: `Promo ${code.trim().toUpperCase()}` }
        : { ok: false, message: getBillState().error || "That promo code could not be used." };
    }
    const product = findBySku(code);
    if (!product) {
      return {
        ok: false,
        message: RECEIPT_NO.test(code)
          ? `"${code}" is a receipt, not a product.`
          : `No product with barcode "${code}". Add it on the Products tab first.`,
      };
    }
    if (demo) return { ok: false, message: "Demo data — the server is not connected, nothing was added." };
    const added = await addToBill(product);
    return added
      ? { ok: true, message: `${product.name} · ${formatMoney(product.price)}` }
      : { ok: false, message: `Could not add ${product.name} — the bill shows why. Try again.` };
  }

  /**
   * 사진으로 찾기(0068). 서버가 확실하다고 한 것이 하나면 바로 담고, 아니면 후보를 띄워 직원이 누른다.
   * 후보는 지금 계산대가 담을 수 있는 상품만(스캔과 같은 목록, 활성).
   */
  async function handleCameraPhoto(image: string): Promise<PhotoOutcome> {
    if (loading) return { ok: false, message: "Products are still loading — try again in a moment." };
    if (demo) return { ok: false, message: "Demo data — the server is not connected, nothing was added." };
    const result = await matchPhoto(image);
    const catalog = scanProducts ?? products;
    const found = result.candidates
      .map((candidate) => catalog.find((item) => item.id === candidate.product_id && item.is_active))
      .filter((item): item is Product => Boolean(item));
    if (found.length === 0) {
      return {
        ok: false,
        message:
          result.compared === 0
            ? "No product has a photo yet. Add photos on the Products tab (Edit → Photo)."
            : result.note || "Couldn't tell which product this is. Try again closer, or pick it by hand.",
      };
    }
    const add = async (product: Product): Promise<ScanOutcome> =>
      (await addToBill(product))
        ? { ok: true, message: `${product.name} · ${formatMoney(product.price)}` }
        : { ok: false, message: `Could not add ${product.name} — the bill shows why. Try again.` };
    if (result.status === "match") return add(found[0]);
    return {
      ok: false,
      message: result.note,
      choices: found.map((product) => ({
        key: String(product.id),
        label: product.name,
        detail: `${formatMoney(product.price)} · ${product.sku}`,
        imageUrl: product.photo_url,
        pick: () => add(product),
      })),
    };
  }

  function payFromCamera() {
    setCameraOpen(false);
    if (!window.matchMedia("(min-width: 1024px)").matches) setSheetOpen(true);
    setRevealPayments((n) => n + 1);
  }

  /** 스캐너가 아닌 손으로 SKU 를 다 치고 Enter 를 눌러도 담는다. 스캔은 훅이 먼저 가로챈다. */
  function onSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter" || event.defaultPrevented || event.nativeEvent.isComposing) return;
    const product = search.trim() ? findBySku(search) : null;
    if (product) {
      event.preventDefault();
      setSearch("");
      addAndOpenPayment(product);
    }
  }

  const billBody = (
    <BillPanel demo={demo} onPaid={onSold} revealPayments={revealPayments} station={station} />
  );

  return (
    <>
      {/* 트랙을 minmax(0,1fr) 로 못박는다. auto 트랙은 max-content 로 부풀어서
          안쪽 격자가 좁은 화면을 통째로 가로로 밀어낸다. */}
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="min-w-0">
          <div className="grid gap-2">
            <div className="flex min-w-0 gap-2">
              <div className="min-w-0 flex-1">
                <TextInput
                  aria-label="Search products by name or SKU"
                  data-scan-target=""
                  onChange={(event) => setSearch(event.target.value)}
                  onKeyDown={onSearchKeyDown}
                  placeholder="Scan a barcode, or search name or SKU…"
                  type="search"
                  value={search}
                />
              </div>
              <button
                aria-label="Scan with camera"
                className="inline-flex min-h-11 shrink-0 items-center gap-1.5 border border-[#d4d4d8] bg-white px-3 text-sm font-bold text-[#3f434a] hover:bg-[#f2f2f4]"
                onClick={() => setCameraOpen(true)}
                type="button"
              >
                <span aria-hidden>📷</span>
                <span className="hidden sm:inline">Camera</span>
              </button>
              <button
                aria-label="Scan with a phone"
                className="inline-flex min-h-11 shrink-0 items-center gap-1.5 border border-[#d4d4d8] bg-white px-3 text-sm font-bold text-[#3f434a] hover:bg-[#f2f2f4]"
                onClick={() => setPhoneScanOpen(true)}
                type="button"
              >
                <BarcodeIcon />
                <span className="hidden sm:inline">Phone</span>
              </button>
              <button
                aria-label="Add an open item"
                className="inline-flex min-h-11 shrink-0 items-center gap-1.5 border border-[#d4d4d8] bg-white px-3 text-sm font-bold text-[#3f434a] hover:bg-[#f2f2f4]"
                onClick={() => setOpenItemOpen(true)}
                type="button"
              >
                <span aria-hidden>＋</span>
                <span className="hidden sm:inline">Open Item</span>
              </button>
            </div>
            {scanNote ? <ErrorNote>{scanNote}</ErrorNote> : null}
            {/* 칩 줄은 자기 자신 안에서 가로 스크롤한다. 페이지를 밀면 안 된다. */}
            <div
              className={`-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1 ${lockedCategory ? "hidden" : ""}`}
            >
              <Chip active={category === "All"} onClick={() => pickCategory("All")}>
                All
              </Chip>
              {RETAIL_CATEGORIES.map((name) => (
                <Chip active={category === name} key={name} onClick={() => pickCategory(name)}>
                  {name}
                </Chip>
              ))}
            </div>
          </div>

          <div className="mt-3 min-w-0">
            {loading ? (
              <SkeletonCards count={9} />
            ) : visible.length === 0 ? (
              <EmptyNote>No products match that search.</EmptyNote>
            ) : searching ? (
              <ProductGrid onAdd={addToBill} products={visible} />
            ) : shownGroup ? (
              <>
                <nav aria-label="Menu group" className="mb-2 flex min-w-0 items-center gap-1 text-sm font-bold">
                  <button
                    className="inline-flex min-h-11 shrink-0 items-center px-2 text-[#4533ff] hover:underline"
                    onClick={() => setOpenGroup(null)}
                    type="button"
                  >
                    ← {category === "All" ? "All groups" : category}
                  </button>
                  <span aria-hidden className="text-[#9ca3af]">/</span>
                  <span className="min-w-0 truncate px-1">{shownGroup.label}</span>
                </nav>
                <ProductGrid onAdd={addToBill} products={shownGroup.products} />
              </>
            ) : (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2">
                {menu.groups.map((group) => (
                  <GroupButton group={group} key={group.key} onOpen={() => setOpenGroup(group.key)} />
                ))}
                {menu.loose.map((product) => (
                  <ProductButton key={product.id} onAdd={() => addToBill(product)} product={product} />
                ))}
              </div>
            )}
          </div>

          {/* 하단 고정 줄에 가리지 않도록 모바일에서만 여백을 둔다. */}
          {lineCount > 0 ? <div className="h-24 lg:hidden" /> : null}
        </div>

        {/* 데스크톱: 오른쪽에 붙는 계산서. */}
        <aside className="hidden min-w-0 lg:block">
          <div className="sticky top-3 border border-[#d4d4d8] bg-white">{billBody}</div>
        </aside>
      </div>

      {/* 모바일: 담긴 것이 있을 때만 합계 줄이 화면 아래에 붙는다.
          z-40 인 이유 — 어드민 서랍(z-50)이 열리면 그쪽이 이겨야 한다. */}
      {lineCount > 0 && !sheetOpen ? (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-[#d4d4d8] bg-white pb-safe lg:hidden">
          <button
            className="flex min-h-14 w-full items-center justify-between gap-3 px-4 text-left"
            onClick={() => setSheetOpen(true)}
            type="button"
          >
            <span className="min-w-0">
              <span className="block text-xs font-bold text-[#6b7280]">
                {`Bill #${bill?.id} · ${lineCount} line${lineCount === 1 ? "" : "s"}`}
              </span>
              <span className="block text-lg font-bold tabular-nums">{formatMoney(bill?.total ?? 0)}</span>
            </span>
            <span className="shrink-0 bg-[#4533ff] px-4 py-2.5 text-sm font-bold text-white">Review</span>
          </button>
        </div>
      ) : null}

      {cameraOpen ? (
        <CameraScanner
          canPay={lineCount > 0}
          onClose={() => setCameraOpen(false)}
          onCode={handleCameraCode}
          onDone={payFromCamera}
          onPhoto={handleCameraPhoto}
          summary={
            <>
              <span className="block text-xs font-bold text-[#6b7280]">
                {bill ? `Bill #${bill.id} · ${lineCount} line${lineCount === 1 ? "" : "s"}` : "Nothing scanned yet"}
              </span>
              <span className="block text-lg font-bold tabular-nums">{formatMoney(bill?.total ?? 0)}</span>
            </>
          }
        />
      ) : null}

      {phoneScanOpen ? <PhoneScanDialog onClose={() => setPhoneScanOpen(false)} station={station} /> : null}

      {openItemOpen ? (
        <OpenItemDialog
          defaultCategory={lockedCategory ?? "Other"}
          onAdd={addOpenItem}
          onClose={() => setOpenItemOpen(false)}
        />
      ) : null}

      {sheetOpen ? (
        <CartSheet
          onClose={() => {
            setSheetOpen(false);
            setRevealPayments(0);
          }}
          title="Bill"
        >
          {billBody}
        </CartSheet>
      ) : null}
    </>
  );
}

/**
 * 모바일 계산서 시트. 별도 컴포넌트인 이유는 `useOverlayDismiss` 때문이다 —
 * 훅은 조건부로 호출할 수 없으므로, "열렸을 때만 존재하는" 컴포넌트로 감싸서
 * 마운트/언마운트에 Esc 처리와 body 스크롤 잠금을 태운다.
 */
function CartSheet({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  useOverlayDismiss(onClose);
  return (
    // z-40: 어드민 서랍(z-50)이 함께 열리면 그쪽이 이겨야 한다.
    <div className="fixed inset-0 z-40 flex flex-col justify-end lg:hidden">
      <button
        aria-label="Close bill"
        className="absolute inset-0 bg-black/60"
        onClick={onClose}
        type="button"
      />
      <div className="relative flex max-h-[88dvh] flex-col overflow-hidden bg-white">
        <header className="flex items-center justify-between border-b border-[#d4d4d8] px-3 py-2.5">
          <h2 className="text-sm font-bold">{title}</h2>
          <button
            aria-label="Close bill"
            className="tap-target -mr-2 flex items-center justify-center text-xl leading-none"
            onClick={onClose}
            type="button"
          >
            <span aria-hidden>×</span>
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto pb-safe">{children}</div>
      </div>
    </div>
  );
}

// ===== 상품 카드 ========================================================

function ProductGrid({ products, onAdd }: { products: Product[]; onAdd: (product: Product) => void }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2">
      {products.map((product) => (
        <ProductButton key={product.id} onAdd={() => onAdd(product)} product={product} />
      ))}
    </div>
  );
}

/** 메뉴 그룹 폴더. 상품 카드와 같은 크기지만 어두운 판이라 한눈에 "들어가는 버튼" 으로 보인다. */
function GroupButton({ group, onOpen }: { group: MenuGroup; onOpen: () => void }) {
  const count = group.products.length;
  return (
    <button
      className="flex min-h-[104px] min-w-0 flex-col justify-between gap-1 border border-[#111315] bg-[#111315] p-2.5 text-left text-white hover:border-[#4533ff] hover:bg-[#1f2328]"
      onClick={onOpen}
      type="button"
    >
      <span className="line-clamp-3 text-sm leading-tight font-bold">{group.label}</span>
      <span className="flex items-baseline justify-between gap-2 text-[11px] text-white/70">
        <span>{`${count} item${count === 1 ? "" : "s"}`}</span>
        <span aria-hidden className="text-base text-white">›</span>
      </span>
    </button>
  );
}

function ProductButton({ product, onAdd }: { product: Product; onAdd: () => void }) {
  // 재고 개념이 없는 렌탈은 `stock: null` 이다. 0 과 구분하지 않으면 "품절" 로
  // 보여서 팔 수 있는 것을 못 팔게 된다.
  const out = product.stock !== null && product.stock <= 0;
  const red = product.stock !== null && product.stock < LOW_STOCK_RED_BELOW;
  return (
    <button
      className={`flex min-h-[104px] min-w-0 flex-col justify-between gap-1 border p-2.5 text-left ${
        out
          ? "border-[#e2c4c4] bg-[#fdf6f6]"
          : "border-[#d4d4d8] bg-white hover:border-[#4533ff] active:bg-[#f2f2f4]"
      }`}
      onClick={onAdd}
      type="button"
    >
      <span className="line-clamp-3 text-sm leading-tight font-bold">{product.name}</span>
      <span className="min-w-0">
        <span className="block truncate text-[11px] text-[#6b7280]">{product.sku}</span>
        <span className="flex items-baseline justify-between gap-2">
          <span className="text-base font-bold tabular-nums">{formatMoney(product.price)}</span>
          <span
            className={`text-[11px] ${out ? "font-bold text-[#8a1f1f]" : red ? "text-[#8a1f1f]" : "text-[#6b7280]"}`}
          >
            {product.stock === null ? "—" : out ? "Out" : `${product.stock} left`}
          </span>
        </span>
      </span>
    </button>
  );
}

/** 바코드 모양. 이모지에는 바코드가 없어서 직접 그린다. */
function BarcodeIcon() {
  return (
    <svg aria-hidden className="size-4" fill="currentColor" viewBox="0 0 24 24">
      <rect height="16" width="2" x="2" y="4" />
      <rect height="16" width="1" x="5.5" y="4" />
      <rect height="16" width="2.5" x="8" y="4" />
      <rect height="16" width="1" x="12" y="4" />
      <rect height="16" width="2" x="14.5" y="4" />
      <rect height="16" width="1" x="18" y="4" />
      <rect height="16" width="2" x="20" y="4" />
    </svg>
  );
}
