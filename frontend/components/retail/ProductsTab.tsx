"use client";

/**
 * 상품·재고 관리. 계산대만큼 자주 열리지는 않지만, **여기서 틀리면 계산대가
 * 전부 틀린다** — 가격 한 자리가 어긋나면 그날 판 모든 영수증이 어긋난다.
 *
 * 표를 390px 에 밀어 넣지 않는다. 좁은 화면에서는 카드 목록으로 바뀐다.
 * (표를 `overflow-x-auto` 로 감싸는 방법도 있지만, 재고 편집처럼 손이 자주 가는
 *  화면에서 가로로 밀어 가며 쓰는 것은 카운터에서 실제로 못 쓴다.)
 */

import { useMemo, useState } from "react";

import CameraScanner, { type ScanOutcome } from "@/components/pos/CameraScanner";
import { useBarcodeScanner } from "@/hooks/useBarcodeScanner";

import retailApi, { toRetailError } from "@/lib/retail/api";
import { code128Svg, houseBarcode, isHouseBarcode } from "@/lib/retail/barcode";
import { LABEL_LAYOUTS, printBarcodeLabels, type LabelLayout } from "@/lib/retail/barcodeLabels";
import { menuGroupSuggestions } from "@/lib/retail/menuGroups";
import {
  LOW_STOCK_RED_BELOW,
  RETAIL_CATEGORIES,
  formatMoney,
  parseMoney,
  type LowStockItem,
  type Product,
  type ProductCreate,
  type RetailCategory,
} from "@/lib/retail/types";

import {
  Button,
  Chip,
  EmptyNote,
  ErrorNote,
  Field,
  Modal,
  Select,
  SkeletonRows,
  TextInput,
} from "./ui";

type Props = {
  products: Product[];
  /**
   * 분류 필터를 거치지 않은 전체 상품(비활성 포함). SKU·바코드가 겹치는지는 이것으로 본다 —
   * 2026-10-18: 바코드를 SKU 로 쓴 상품이 다른 분류에 있어서 목록에 안 보였는데, 저장하면
   * "SKU … already exists" 만 나와 무엇과 겹치는지 알 수 없었다.
   */
  catalog?: Product[];
  lowStock: LowStockItem[];
  loading: boolean;
  demo: boolean;
  /** 저장 후 목록을 다시 읽는다. 서버가 붙인 id·타임스탬프가 정답이기 때문. */
  onChanged: () => void;
  /** 새 상품의 기본 분류. 스낵바 화면은 `Food & Beverage` 로 연다. */
  defaultCategory?: RetailCategory;
};

// 바코드 칸이 비어 있으면 "바코드 없음" 이다. SKU 는 바코드가 없어도 늘 있으므로 보지 않는다.
type BarcodeFilter = "all" | "with" | "without";

const BARCODE_FILTERS: { value: BarcodeFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "with", label: "Barcode" },
  { value: "without", label: "No barcode" },
];

function hasBarcode(product: Product) {
  return (product.barcode ?? "").trim() !== "";
}

export default function ProductsTab({
  products,
  catalog,
  lowStock,
  loading,
  demo,
  onChanged,
  defaultCategory = "Accessories",
}: Props) {
  const [search, setSearch] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const [barcodeFilter, setBarcodeFilter] = useState<BarcodeFilter>("all");
  const [editing, setEditing] = useState<Product | "new" | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [generating, setGenerating] = useState(false);
  const [printingLabels, setPrintingLabels] = useState(false);

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return products
      .filter((item) => (showInactive ? true : item.is_active))
      .filter((item) =>
        barcodeFilter === "all" ? true : hasBarcode(item) === (barcodeFilter === "with"),
      )
      .filter((item) =>
        needle
          ? item.name.toLowerCase().includes(needle) ||
            item.sku.toLowerCase().includes(needle) ||
            (item.barcode ?? "").toLowerCase().includes(needle) ||
            (item.menu_group ?? "").toLowerCase().includes(needle)
          : true,
      );
  }, [products, search, showInactive, barcodeFilter]);

  // 칩 옆 숫자는 검색어와 상관없이, 지금 활성/비활성 보기에서 몇 개인지다.
  const barcodeCounts = useMemo(() => {
    const shown = products.filter((item) => (showInactive ? true : item.is_active));
    const withCode = shown.filter(hasBarcode).length;
    return { all: shown.length, with: withCode, without: shown.length - withCode };
  }, [products, showInactive]);

  // 바코드를 만들어 줄 상품: 지금 화면 분류의 **활성** 상품 중 바코드 칸이 빈 것.
  const missingBarcode = useMemo(
    () => products.filter((item) => item.is_active && !hasBarcode(item)),
    [products],
  );
  // 인쇄 시트: 클럽이 만든 바코드(포장에 바코드가 없는 것)를 단 활성 상품.
  const houseCoded = useMemo(
    () => products.filter((item) => item.is_active && isHouseBarcode(item.barcode)),
    [products],
  );

  async function generateBarcodes() {
    if (demo || missingBarcode.length === 0) return;
    if (
      !window.confirm(
        `Give ${missingBarcode.length} product(s) without a barcode a club barcode (PH + product number)? ` +
          "The barcode then shows next to the price so the register can scan it.",
      )
    ) {
      return;
    }
    // 다른 분류의 SKU·바코드와도 겹치지 않게 전체 목록으로 본다. 겹치면 그 상품은 건너뛴다.
    const taken = new Set(
      (catalog ?? products).flatMap((item) => [item.sku, item.barcode ?? ""]).map((code) => code.trim().toLowerCase()),
    );
    setGenerating(true);
    setError("");
    const skipped: string[] = [];
    try {
      for (const product of missingBarcode) {
        const code = houseBarcode(product.id);
        if (taken.has(code.toLowerCase())) {
          skipped.push(product.name);
          continue;
        }
        await retailApi.updateProduct(product.id, { barcode: code });
        taken.add(code.toLowerCase());
      }
      if (skipped.length) setError(`Skipped (code already used): ${skipped.join(", ")}`);
    } catch (cause) {
      setError(toRetailError(cause).message);
    } finally {
      setGenerating(false);
      onChanged();
    }
  }

  async function deactivate(product: Product) {
    if (demo) return;
    // 되돌리려면 다시 활성으로 바꾸면 되지만, 판매 화면에서 즉시 사라지므로
    // 한 번은 물어본다. 실수로 눌러 놓고 "물건이 없어졌다" 고 찾게 하지 않는다.
    if (!window.confirm(`Deactivate “${product.name}”? It disappears from the register.`)) return;
    setBusyId(product.id);
    setError("");
    try {
      await retailApi.deactivateProduct(product.id);
      onChanged();
    } catch (cause) {
      setError(toRetailError(cause).message);
    } finally {
      setBusyId(null);
    }
  }

  async function reactivate(product: Product) {
    if (demo) return;
    setBusyId(product.id);
    setError("");
    try {
      await retailApi.updateProduct(product.id, { is_active: true });
      onChanged();
    } catch (cause) {
      setError(toRetailError(cause).message);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="grid min-w-0 gap-3">
      {lowStock.length > 0 ? (
        <div className="border border-[#f0c36d] bg-[#fff8e1] px-3 py-2.5 text-sm text-[#5b4708]">
          <p className="font-bold">Low stock — {lowStock.length} item(s) at or below reorder point</p>
          <ul className="mt-1 grid gap-0.5">
            {lowStock.map((item) => (
              <li className="truncate" key={item.product_id}>
                {item.name} — {item.stock} left (reorder at {item.reorder_point})
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
        <TextInput
          aria-label="Search products by name or SKU"
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search name or SKU…"
          type="search"
          value={search}
        />
        <div className="flex flex-wrap gap-2">
          {BARCODE_FILTERS.map((option) => (
            <Chip
              active={barcodeFilter === option.value}
              key={option.value}
              onClick={() => setBarcodeFilter(option.value)}
            >
              {option.label} ({barcodeCounts[option.value]})
            </Chip>
          ))}
          <Chip active={showInactive} onClick={() => setShowInactive((value) => !value)}>
            {showInactive ? "Showing inactive" : "Hiding inactive"}
          </Chip>
          {missingBarcode.length > 0 ? (
            <Button disabled={demo || generating} onClick={generateBarcodes}>
              {generating ? "Generating…" : `Generate barcodes (${missingBarcode.length})`}
            </Button>
          ) : null}
          {houseCoded.length > 0 ? (
            <Button onClick={() => setPrintingLabels(true)}>
              Print barcode stickers ({houseCoded.length})
            </Button>
          ) : null}
          <Button disabled={demo} onClick={() => setEditing("new")} tone="primary">
            + Add product
          </Button>
        </div>
      </div>

      {error ? <ErrorNote>{error}</ErrorNote> : null}

      {loading ? (
        <SkeletonRows count={8} />
      ) : visible.length === 0 ? (
        <EmptyNote>No products match that search.</EmptyNote>
      ) : (
        <>
          {/* 모바일: 카드 목록. */}
          <ul className="grid gap-2 lg:hidden">
            {visible.map((product) => (
              <li className="min-w-0 border border-[#d4d4d8] bg-white p-3" key={product.id}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm leading-tight font-bold">{product.name}</p>
                    <p className="truncate text-xs text-[#6b7280]">
                      {product.sku}{product.barcode ? ` · ${product.barcode}` : ""} · {product.category}
                      {product.menu_group ? ` › ${product.menu_group}` : ""}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="text-base font-bold tabular-nums">{formatMoney(product.price)}</p>
                    <PriceBarcode product={product} />
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[#6b7280]">
                  <StockText product={product} />
                  <span>Cost {formatMoney(product.cost)}</span>
                  {!product.is_active ? (
                    <span className="bg-[#e4e4e8] px-1.5 py-0.5 font-bold text-[#3f434a]">
                      Inactive
                    </span>
                  ) : null}
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button disabled={demo} onClick={() => setEditing(product)}>
                    Edit
                  </Button>
                  {product.is_active ? (
                    <Button
                      disabled={demo || busyId === product.id}
                      onClick={() => deactivate(product)}
                      tone="danger"
                    >
                      Deactivate
                    </Button>
                  ) : (
                    <Button
                      disabled={demo || busyId === product.id}
                      onClick={() => reactivate(product)}
                    >
                      Reactivate
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>

          {/* 데스크톱: 표. */}
          <div className="hidden min-w-0 border border-[#d4d4d8] bg-white lg:block">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-[#d4d4d8] text-left text-xs text-[#6b7280]">
                  <Th>SKU</Th>
                  <Th>Name</Th>
                  <Th>Category</Th>
                  <Th>Menu group</Th>
                  <Th align="right">Price</Th>
                  <Th align="right">Stock</Th>
                  <Th align="right">Reorder</Th>
                  <Th>Status</Th>
                  <Th align="right">Actions</Th>
                </tr>
              </thead>
              <tbody>
                {visible.map((product) => (
                  <tr className="border-b border-[#e4e4e8] last:border-b-0" key={product.id}>
                    <Td className="font-mono text-xs">
                      {product.sku}
                      {product.barcode ? <span className="block text-[#6b7280]">{product.barcode}</span> : null}
                    </Td>
                    <Td className="font-bold">{product.name}</Td>
                    <Td className="text-[#6b7280]">{product.category}</Td>
                    <Td className="text-[#6b7280]">{product.menu_group || "—"}</Td>
                    <Td align="right">
                      <span className="font-bold tabular-nums">{formatMoney(product.price)}</span>
                      <PriceBarcode product={product} />
                    </Td>
                    <Td align="right">
                      <StockText product={product} />
                    </Td>
                    <Td align="right" className="text-[#6b7280]">
                      {product.reorder_point}
                    </Td>
                    <Td>
                      {product.is_active ? (
                        <span className="text-[#1f7a3d]">Active</span>
                      ) : (
                        <span className="text-[#6b7280]">Inactive</span>
                      )}
                    </Td>
                    <Td align="right">
                      <span className="flex justify-end gap-1.5">
                        <Button disabled={demo} onClick={() => setEditing(product)}>
                          Edit
                        </Button>
                        {product.is_active ? (
                          <Button
                            disabled={demo || busyId === product.id}
                            onClick={() => deactivate(product)}
                            tone="danger"
                          >
                            Deactivate
                          </Button>
                        ) : (
                          <Button
                            disabled={demo || busyId === product.id}
                            onClick={() => reactivate(product)}
                          >
                            Reactivate
                          </Button>
                        )}
                      </span>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {printingLabels ? (
        <LabelDialog items={houseCoded} onClose={() => setPrintingLabels(false)} />
      ) : null}

      {editing ? (
        <ProductDialog
          // 겹치는 상품을 열면 같은 창이 그 상품으로 바뀐다. 폼은 처음 한 번만 채우므로 새로 만든다.
          key={editing === "new" ? "new" : editing.id}
          allProducts={products}
          catalog={catalog ?? products}
          defaultCategory={defaultCategory}
          onClose={() => setEditing(null)}
          onOpenExisting={(existing) => setEditing(existing)}
          onSaved={() => {
            setEditing(null);
            onChanged();
          }}
          product={editing === "new" ? null : editing}
        />
      ) : null}
    </div>
  );
}

/**
 * 가격 바로 밑의 바코드. 클럽이 만든 바코드만 그린다 — 제조사 바코드는 포장에 이미 있다.
 * 계산대 스캐너(DS2208)는 화면의 바코드도 읽으므로, 이 줄을 그대로 쏘면 담긴다.
 */
function PriceBarcode({ product }: { product: Product }) {
  if (!isHouseBarcode(product.barcode)) return null;
  const code = product.barcode!.trim();
  return (
    <span className="mt-1 ml-auto block w-[150px] bg-white text-center">
      {/* code128Svg 는 막대(rect)만 그린 SVG 다. 사람이 입력한 글자는 들어가지 않는다. */}
      <span className="block h-9 [&>svg]:h-full [&>svg]:w-full" dangerouslySetInnerHTML={{ __html: code128Svg(code) }} />
      <span className="block font-mono text-[10px] tracking-wider text-[#3f434a]">{code}</span>
    </span>
  );
}

/**
 * 바코드 스티커 인쇄 창. 어떤 종이에(시트·롤·리스트), 몇 장씩, 어느 상품을 찍을지 고른다.
 * 기본은 전부 한 장씩 — 처음 붙일 때 쓰고, 다시 찍을 때는 그 상품만 남긴다.
 */
function LabelDialog({ items, onClose }: { items: Product[]; onClose: () => void }) {
  const [layout, setLayout] = useState<LabelLayout>("avery5160");
  const [copies, setCopies] = useState("1");
  const [skip, setSkip] = useState("0");
  const [showPrice, setShowPrice] = useState(false);
  const [picked, setPicked] = useState<Set<number>>(() => new Set(items.map((item) => item.id)));
  const [error, setError] = useState("");

  const chosen = items.filter((item) => picked.has(item.id));
  const copyCount = Math.min(Math.max(Number.parseInt(copies, 10) || 1, 1), 100);
  const skipCount = layout === "avery5160" ? Math.min(Math.max(Number.parseInt(skip, 10) || 0, 0), 29) : 0;
  const total = layout === "list" ? chosen.length : chosen.length * copyCount;

  function toggle(id: number) {
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function print() {
    setError("");
    const opened = printBarcodeLabels(chosen, { layout, copies: copyCount, skip: skipCount, showPrice });
    if (!opened) setError("Allow pop-ups for this site, then press Print again.");
  }

  return (
    <Modal onClose={onClose} title="Print barcode stickers">
      <div className="grid gap-3">
        <Field hint={LABEL_LAYOUTS.find((option) => option.value === layout)?.hint} label="Paper">
          <Select onChange={(event) => setLayout(event.target.value as LabelLayout)} value={layout}>
            {LABEL_LAYOUTS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </Field>
        {layout !== "list" ? (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Copies of each">
              <TextInput inputMode="numeric" min={1} max={100} onChange={(event) => setCopies(event.target.value)} type="number" value={copies} />
            </Field>
            {layout === "avery5160" ? (
              <Field hint="Labels already used on the sheet" label="Skip first">
                <TextInput inputMode="numeric" min={0} max={29} onChange={(event) => setSkip(event.target.value)} type="number" value={skip} />
              </Field>
            ) : null}
          </div>
        ) : null}
        {layout !== "list" ? (
          <label className="flex items-center gap-2 text-sm">
            <input checked={showPrice} onChange={(event) => setShowPrice(event.target.checked)} type="checkbox" />
            Show the price on the sticker
          </label>
        ) : null}

        <div className="grid gap-1">
          <div className="flex items-center justify-between text-sm">
            <span className="font-bold text-[#3f434a]">
              Products ({chosen.length} of {items.length})
            </span>
            <span className="flex gap-3 text-xs">
              <button className="underline" onClick={() => setPicked(new Set(items.map((item) => item.id)))} type="button">
                All
              </button>
              <button className="underline" onClick={() => setPicked(new Set())} type="button">
                None
              </button>
            </span>
          </div>
          <ul className="max-h-60 overflow-y-auto border border-[#d4d4d8]">
            {items.map((item) => (
              <li className="border-b border-[#e4e4e8] last:border-b-0" key={item.id}>
                <label className="flex items-center gap-2 px-2.5 py-1.5 text-sm">
                  <input checked={picked.has(item.id)} onChange={() => toggle(item.id)} type="checkbox" />
                  <span className="min-w-0 flex-1 truncate">{item.name}</span>
                  <span className="font-mono text-xs text-[#6b7280]">{item.barcode}</span>
                </label>
              </li>
            ))}
          </ul>
        </div>

        <p className="text-xs text-[#6b7280]">
          In the print window choose <b>Scale 100% / Actual size</b> and <b>Margins: None</b> so the barcodes line up
          with the stickers. Print one test page on plain paper first and hold it behind a sticker sheet.
        </p>
        {error ? <ErrorNote>{error}</ErrorNote> : null}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button disabled={chosen.length === 0} onClick={print} tone="primary">
            {layout === "list" ? `Print list (${total})` : `Print ${total} sticker(s)`}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** 렌탈은 `stock: null` — 재고 개념이 없다. 0 과 같이 보이면 품절로 오해한다. */
function StockText({ product }: { product: Product }) {
  if (product.stock === null) return <span className="text-[#6b7280]">Not tracked</span>;
  // 20개 미만이면 빨간 글씨, 재주문점 이하이면 굵게까지.
  const low = product.stock <= product.reorder_point;
  const red = low || product.stock < LOW_STOCK_RED_BELOW;
  return (
    <span className={red ? `text-[#8a1f1f]${low ? " font-bold" : ""}` : undefined}>
      {product.stock} in stock
    </span>
  );
}

function Th({
  children,
  align = "left",
}: {
  children: React.ReactNode;
  align?: "left" | "right";
}) {
  return (
    <th className={`px-2.5 py-2 font-bold ${align === "right" ? "text-right" : "text-left"}`}>
      {children}
    </th>
  );
}

function Td({
  children,
  align = "left",
  className = "",
}: {
  children: React.ReactNode;
  align?: "left" | "right";
  className?: string;
}) {
  return (
    <td className={`px-2.5 py-2 ${align === "right" ? "text-right" : ""} ${className}`}>
      {children}
    </td>
  );
}

// ===== 추가/수정 다이얼로그 =============================================

type FormState = {
  barcode: string;
  sku: string;
  name: string;
  category: RetailCategory;
  /** 계산대 메뉴 그룹. 빈 문자열이면 그룹 없음(null). */
  menuGroup: string;
  /** "19.99" 같은 **날 문자열**. 센트 변환은 저장 직전에 한 번만 한다. */
  price: string;
  cost: string;
  /** 빈 문자열이면 재고 미추적(`null`). "0" 과 다르다. */
  stock: string;
  reorderPoint: string;
  isActive: boolean;
};

function toForm(product: Product | null, defaultCategory: RetailCategory): FormState {
  if (!product) {
    return {
      barcode: "",
      sku: "",
      name: "",
      category: defaultCategory,
      menuGroup: "",
      price: "",
      cost: "",
      stock: "",
      reorderPoint: "4",
      isActive: true,
    };
  }
  return {
    barcode: product.barcode ?? "",
    sku: product.sku,
    name: product.name,
    category: product.category,
    menuGroup: product.menu_group ?? "",
    price: (product.price / 100).toFixed(2),
    cost: (product.cost / 100).toFixed(2),
    stock: product.stock === null ? "" : String(product.stock),
    reorderPoint: String(product.reorder_point),
    isActive: product.is_active,
  };
}

function ProductDialog({
  product,
  allProducts,
  catalog,
  defaultCategory,
  onClose,
  onSaved,
  onOpenExisting,
}: {
  product: Product | null;
  /** 그룹 칸의 제안 목록을 만든다. */
  allProducts: Product[];
  /** 겹치는 SKU·바코드를 찾는다. 다른 분류·비활성 상품까지 들어 있다. */
  catalog: Product[];
  defaultCategory: RetailCategory;
  onClose: () => void;
  onSaved: () => void;
  /** 겹치는 상품을 이 창 대신 연다. */
  onOpenExisting: (existing: Product) => void;
}) {
  const [form, setForm] = useState<FormState>(() => toForm(product, defaultCategory));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [cameraOpen, setCameraOpen] = useState(false);
  const groupOptions = useMemo(
    () => menuGroupSuggestions(allProducts, form.category),
    [allProducts, form.category],
  );

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  // 상품 바코드(UPC 등)를 쏘면 **어느 칸에 커서가 있든** 바코드 칸이 그 값이 된다
  // (2026-09-30: 원가 칸에 커서가 있어서 바코드가 원가로 들어갔다). 스캐너가 그 칸에 이미
  // 찍어 놓은 글자는 지운다. 입력기가 한글이면 칸에 자모가 찍히므로 칸의 글자가 아니라
  // 스캐너가 보낸 키를 믿는다. 계산대는 바코드 → SKU 순으로 정확 일치 검색을 한다.
  useBarcodeScanner(
    (code) =>
      setForm((current) => {
        const strip = (value: string) => (value.endsWith(code) ? value.slice(0, -code.length) : value);
        return {
          ...current,
          barcode: code,
          name: strip(current.name),
          sku: strip(current.sku),
          menuGroup: strip(current.menuGroup),
          price: strip(current.price),
          cost: strip(current.cost),
          stock: strip(current.stock),
          reorderPoint: strip(current.reorderPoint),
        };
      }),
    { everywhere: true },
  );

  // 휴대폰·아이패드처럼 USB 스캐너가 없는 기기는 카메라로 읽는다. 상품 하나에 바코드 하나라
  // 읽자마자 칸에 넣고 닫는다.
  async function onCameraCode(code: string): Promise<ScanOutcome> {
    set("barcode", code);
    setCameraOpen(false);
    return { ok: true, message: code };
  }

  // `parseMoney` 는 쓰레기 입력을 조용히 0 으로 떨어뜨린다. 그러면 "$0.00 짜리
  // Pro V1" 이 만들어지고 아무도 모른다 — 저장 버튼을 켜기 전에 직접 본다.
  const priceCents = parseMoney(form.price);
  // SKU 를 비워 두면 바코드를 SKU 로도 쓴다(바코드만 있는 공산품).
  const sku = form.sku.trim() || form.barcode.trim();
  const valid = sku.length > 0 && form.name.trim().length > 0 && priceCents > 0;

  // 서버도 같은 규칙(대소문자 무시 정확 일치)으로 막지만, 서버 메시지는 무엇과 겹치는지
  // 말하지 않는다. 저장 전에 여기서 찾아 그 상품을 보여 주고 바로 열 수 있게 한다.
  const clash = useMemo(() => {
    const others = catalog.filter((item) => item.id !== product?.id);
    const same = (a: string | null | undefined, b: string) => (a ?? "").trim().toLowerCase() === b.toLowerCase();
    const barcode = form.barcode.trim();
    const byBarcode = barcode ? others.find((item) => same(item.barcode, barcode)) : undefined;
    if (byBarcode) return { field: "Barcode", value: barcode, owner: byBarcode };
    const bySku = sku ? others.find((item) => same(item.sku, sku)) : undefined;
    if (bySku) return { field: "SKU", value: sku, owner: bySku };
    return null;
  }, [catalog, product?.id, form.barcode, sku]);

  async function save() {
    if (!valid || clash) return;
    setSaving(true);
    setError("");

    const payload: ProductCreate = {
      sku,
      barcode: form.barcode.trim() || null,
      name: form.name.trim(),
      category: form.category,
      menu_group: form.menuGroup.trim() || null,
      price: priceCents,
      cost: parseMoney(form.cost),
      // 빈 칸은 "재고를 세지 않는 품목"(렌탈)이라는 뜻이라 0 이 아니라 null 이다.
      stock: form.stock.trim() === "" ? null : Math.max(0, Math.round(Number(form.stock) || 0)),
      reorder_point: Math.max(0, Math.round(Number(form.reorderPoint) || 0)),
      is_active: form.isActive,
    };

    try {
      if (product) await retailApi.updateProduct(product.id, payload);
      else await retailApi.createProduct(payload);
      onSaved();
    } catch (cause) {
      setError(toRetailError(cause).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      {/* 카메라가 떠 있을 때 Esc 는 카메라만 닫는다. 이 창까지 닫히면 적던 것이 날아간다. */}
      <Modal onClose={cameraOpen ? () => undefined : onClose} title={product ? "Edit product" : "Add product"}>
        <div className="grid gap-3">
          <Field hint="Scan the product's barcode — works wherever the cursor is" label="Barcode">
            <div className="flex min-w-0 gap-2">
              <button
                aria-label="Scan barcode with camera"
                className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center border border-[#d4d4d8] bg-white text-lg hover:bg-[#f2f2f4]"
                onClick={() => setCameraOpen(true)}
                type="button"
              >
                <span aria-hidden>📷</span>
              </button>
              <div className="min-w-0 flex-1">
                <TextInput
                  autoComplete="off"
                  className="font-mono"
                  data-scan-target=""
                  inputMode="numeric"
                  onChange={(event) => set("barcode", event.target.value)}
                  placeholder="Scan now, e.g. 055577420249"
                  value={form.barcode}
                />
              </div>
            </div>
          </Field>

          <Field hint="Club code. Leave blank to use the barcode." label="SKU">
            <TextInput
              autoComplete="off"
              onChange={(event) => set("sku", event.target.value)}
              placeholder="GTR-591"
              value={form.sku}
            />
          </Field>

          <Field label="Name">
            <TextInput
              autoComplete="off"
              onChange={(event) => set("name", event.target.value)}
              placeholder="Titleist Pro V1 (dozen)"
              value={form.name}
            />
          </Field>

          <Field label="Category">
            <Select
              onChange={(event) => set("category", event.target.value as RetailCategory)}
              value={form.category}
            >
              {RETAIL_CATEGORIES.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </Select>
          </Field>

          <Field hint="Folder on the register, e.g. Hot Food, Beer, Men's Shirts. Blank = no folder." label="Menu group">
            <TextInput
              autoComplete="off"
              list="pelham-menu-groups"
              maxLength={40}
              onChange={(event) => set("menuGroup", event.target.value)}
              placeholder="Hot Food"
              value={form.menuGroup}
            />
            <datalist id="pelham-menu-groups">
              {groupOptions.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
          </Field>

          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <Field hint="Shelf price, tax excluded" label="Price">
              <TextInput
                inputMode="decimal"
                onChange={(event) => set("price", event.target.value)}
                placeholder="19.99"
                value={form.price}
              />
            </Field>
            <Field hint="Margin only — never shown to customers" label="Cost">
              <TextInput
                inputMode="decimal"
                onChange={(event) => set("cost", event.target.value)}
                placeholder="9.50"
                value={form.cost}
              />
            </Field>
          </div>

          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <Field hint="Leave blank for rentals (not tracked)" label="Stock">
              <TextInput
                inputMode="numeric"
                onChange={(event) => set("stock", event.target.value)}
                placeholder="12"
                value={form.stock}
              />
            </Field>
            <Field label="Reorder point">
              <TextInput
                inputMode="numeric"
                onChange={(event) => set("reorderPoint", event.target.value)}
                placeholder="4"
                value={form.reorderPoint}
              />
            </Field>
          </div>

          <label className="flex min-h-11 items-center gap-2 text-sm font-bold">
            <input
              checked={form.isActive}
              className="h-5 w-5"
              onChange={(event) => set("isActive", event.target.checked)}
              type="checkbox"
            />
            Active (shows on the register)
          </label>

          {clash ? (
            <ErrorNote>
              {clash.field} {clash.value} is already used by “{clash.owner.name}” ({clash.owner.category}
              {clash.owner.is_active ? "" : ", inactive"}
              {clash.field === "SKU" && !form.sku.trim() ? " — an empty SKU uses the barcode" : ""}).{" "}
              <button
                className="font-bold underline"
                onClick={() => onOpenExisting(clash.owner)}
                type="button"
              >
                Open that product
              </button>
              {clash.field === "SKU" ? " or type a different SKU." : "."}
            </ErrorNote>
          ) : null}
          {error ? <ErrorNote>{error}</ErrorNote> : null}
          {!valid ? (
            <p className="text-xs text-[#6b7280]">A barcode or SKU, a name and a price above $0.00 are required.</p>
          ) : null}

          <div className="flex gap-2">
            <Button
              className="flex-1"
              disabled={!valid || Boolean(clash) || saving}
              onClick={save}
              tone="primary"
            >
              {saving ? "Saving…" : "Save"}
            </Button>
            <Button className="flex-1" onClick={onClose}>
              Cancel
            </Button>
          </div>
        </div>
      </Modal>
      {/* 이 창(z-[60]) 뒤에 그려서 같은 층에서 위에 뜬다. */}
      {cameraOpen ? (
        <CameraScanner
          canPay
          doneLabel="Cancel"
          onClose={() => setCameraOpen(false)}
          onCode={onCameraCode}
          onDone={() => setCameraOpen(false)}
          summary={<span className="text-sm font-bold">Scan the product&apos;s barcode</span>}
        />
      ) : null}
    </>
  );
}
