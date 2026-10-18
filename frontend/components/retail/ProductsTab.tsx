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

import { useBarcodeScanner } from "@/hooks/useBarcodeScanner";

import retailApi, { toRetailError } from "@/lib/retail/api";
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
  lowStock: LowStockItem[];
  loading: boolean;
  demo: boolean;
  /** 저장 후 목록을 다시 읽는다. 서버가 붙인 id·타임스탬프가 정답이기 때문. */
  onChanged: () => void;
  /** 새 상품의 기본 분류. 스낵바 화면은 `Food & Beverage` 로 연다. */
  defaultCategory?: RetailCategory;
};

export default function ProductsTab({
  products,
  lowStock,
  loading,
  demo,
  onChanged,
  defaultCategory = "Accessories",
}: Props) {
  const [search, setSearch] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const [editing, setEditing] = useState<Product | "new" | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState("");

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return products
      .filter((item) => (showInactive ? true : item.is_active))
      .filter((item) =>
        needle
          ? item.name.toLowerCase().includes(needle) ||
            item.sku.toLowerCase().includes(needle) ||
            (item.barcode ?? "").toLowerCase().includes(needle) ||
            (item.menu_group ?? "").toLowerCase().includes(needle)
          : true,
      );
  }, [products, search, showInactive]);

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
          <Chip active={showInactive} onClick={() => setShowInactive((value) => !value)}>
            {showInactive ? "Showing inactive" : "Hiding inactive"}
          </Chip>
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
                  <p className="shrink-0 text-base font-bold tabular-nums">
                    {formatMoney(product.price)}
                  </p>
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
                    <Td align="right">{formatMoney(product.price)}</Td>
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

      {editing ? (
        <ProductDialog
          allProducts={products}
          defaultCategory={defaultCategory}
          onClose={() => setEditing(null)}
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
  defaultCategory,
  onClose,
  onSaved,
}: {
  product: Product | null;
  /** 그룹 칸의 제안 목록을 만든다. */
  allProducts: Product[];
  defaultCategory: RetailCategory;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<FormState>(() => toForm(product, defaultCategory));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
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

  // `parseMoney` 는 쓰레기 입력을 조용히 0 으로 떨어뜨린다. 그러면 "$0.00 짜리
  // Pro V1" 이 만들어지고 아무도 모른다 — 저장 버튼을 켜기 전에 직접 본다.
  const priceCents = parseMoney(form.price);
  // SKU 를 비워 두면 바코드를 SKU 로도 쓴다(바코드만 있는 공산품).
  const sku = form.sku.trim() || form.barcode.trim();
  const valid = sku.length > 0 && form.name.trim().length > 0 && priceCents > 0;

  async function save() {
    if (!valid) return;
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
    <Modal onClose={onClose} title={product ? "Edit product" : "Add product"}>
      <div className="grid gap-3">
        <Field hint="Scan the product's barcode — works wherever the cursor is" label="Barcode">
          <TextInput
            autoComplete="off"
            className="font-mono"
            data-scan-target=""
            inputMode="numeric"
            onChange={(event) => set("barcode", event.target.value)}
            placeholder="Scan now, e.g. 055577420249"
            value={form.barcode}
          />
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

        {error ? <ErrorNote>{error}</ErrorNote> : null}
        {!valid ? (
          <p className="text-xs text-[#6b7280]">A barcode or SKU, a name and a price above $0.00 are required.</p>
        ) : null}

        <div className="flex gap-2">
          <Button
            className="flex-1"
            disabled={!valid || saving}
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
  );
}
