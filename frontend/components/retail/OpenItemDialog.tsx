"use client";

/**
 * 오픈 아이템: 상품 목록에 없는 것(레슨비, 수선비, 행사 참가비…)을 이름·가격만 쳐서 계산서에 담는다.
 * Lightspeed 의 "Open Item" 과 같다. 재고는 건드리지 않는다(0038).
 *
 * 가격은 세전 단가다. 세금은 계산서 전체에 붙는다. 한도는 0038 과 같다 — 바꾸면 둘을 같이 고쳐라.
 */

import { useState, type FormEvent } from "react";

import { RETAIL_CATEGORIES, formatMoney, parseMoney } from "@/lib/retail/types";
import type { OpenItemInput } from "@/lib/pos/api";

import { Button, ErrorNote, Field, Modal, Select, TextInput } from "./ui";

const NAME_MAX = 80;
const PRICE_MAX = 1_000_000;
const OTHER = "Other";

export default function OpenItemDialog({
  defaultCategory,
  onAdd,
  onClose,
}: {
  /** 스낵바는 Food & Beverage, 프로 샵은 Other. */
  defaultCategory: string;
  /** 담기에 성공하면 true. 실패 문장은 계산서가 보여 준다. */
  onAdd: (item: OpenItemInput) => Promise<boolean>;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [category, setCategory] = useState(defaultCategory);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const cents = parseMoney(price);
  const qty = Number.parseInt(quantity, 10);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return setError("Enter a name for the item.");
    if (cents < 1 || cents > PRICE_MAX) return setError("Price must be between $0.01 and $10,000.00.");
    if (!Number.isInteger(qty) || qty < 1 || qty > 9999) return setError("Quantity must be between 1 and 9999.");
    setError("");
    setBusy(true);
    const ok = await onAdd({ name: trimmed, price: cents, quantity: qty, category });
    setBusy(false);
    if (ok) onClose();
    else setError("Could not add the item — the bill shows why. Try again.");
  }

  return (
    <Modal onClose={onClose} title="Open item">
      <form className="grid gap-3" onSubmit={submit}>
        <Field label="Item name">
          <TextInput
            autoFocus
            maxLength={NAME_MAX}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. Lesson — 30 min"
            value={name}
          />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field hint="Before tax" label="Price">
            <TextInput
              inputMode="decimal"
              onChange={(event) => setPrice(event.target.value)}
              placeholder="0.00"
              value={price}
            />
          </Field>
          <Field label="Quantity">
            <TextInput
              inputMode="numeric"
              min={1}
              onChange={(event) => setQuantity(event.target.value)}
              type="number"
              value={quantity}
            />
          </Field>
        </div>
        <Field hint="Where it shows up on the sales report" label="Category">
          <Select onChange={(event) => setCategory(event.target.value)} value={category}>
            {[...RETAIL_CATEGORIES, OTHER].map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </Select>
        </Field>
        {error ? <ErrorNote>{error}</ErrorNote> : null}
        <div className="flex items-center justify-between gap-2 border-t border-[#e4e4e8] pt-3">
          <span className="text-sm text-[#6b7280] tabular-nums">
            {cents > 0 && qty > 0 ? `${formatMoney(cents * qty)} + tax` : ""}
          </span>
          <div className="flex gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button disabled={busy} tone="primary" type="submit">
              {busy ? "Adding…" : "Add to bill"}
            </Button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
