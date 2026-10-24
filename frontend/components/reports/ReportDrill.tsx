"use client";

/**
 * 리포트 숫자를 눌렀을 때의 두 단계(2026-10-24) — 먼저 요약(묶음별 건수·합계), 묶음 하나를 누르면 그 안의 거래.
 * Daily close 의 Cash·Card Sales 칸(`SalesDrilldown`)과 같은 흐름을 다른 탭·패널에서도 쓴다.
 *
 * 무엇으로 묶을지는 부르는 쪽이 정한다(`groupOf` — 담당자·계산대·경로·상태 등). 묶음의 합이 누른 숫자와 같아야
 * 한다 — 아래 Total 에서 바로 보인다. 금액이 없는 목록(예약·마감 건수)은 `amountOf` 를 빼면 건수만 센다.
 */

import { useMemo, useState, type ReactNode } from "react";

import { formatMoney, type Cents } from "@/lib/retail/types";

import { EmptyNote, Modal } from "@/components/retail/ui";

export type DrillGroup = { key: string; label: string };

export type DrillSummary<T> = { key: string; label: string; rows: T[]; total: Cents };

/** 처음 나온 순서대로 묶는다(부르는 쪽이 rows 를 시각 순 등으로 넘긴다). `last` 키는 맨 뒤로(예: 이름 없음). */
export function summarize<T>(
  rows: readonly T[],
  groupOf: (row: T) => DrillGroup,
  amountOf?: (row: T) => Cents,
  last = "",
): DrillSummary<T>[] {
  const groups = new Map<string, DrillSummary<T>>();
  for (const row of rows) {
    const { key, label } = groupOf(row);
    const group = groups.get(key) ?? { key, label, rows: [], total: 0 };
    group.rows.push(row);
    group.total += amountOf ? amountOf(row) : 0;
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => Number(a.key === last) - Number(b.key === last));
}

/** 거래 한 줄. `onOpen` 이 있으면 눌러서 그 거래(영수증·상세)를 연다. */
export type DrillItem = {
  key: string;
  primary: string;
  secondary?: string;
  /** 오른쪽 숫자. 금액이 아니면 `value` 로 글자를 준다. */
  amount?: Cents;
  value?: string;
  onOpen?: () => void;
};

export function DrillRow({ item }: { item: DrillItem }) {
  const body = (
    <>
      <span className="min-w-0">
        <span className="block truncate text-sm font-bold">{item.primary}</span>
        {item.secondary ? <span className="block text-xs break-words text-[#6b7280]">{item.secondary}</span> : null}
      </span>
      <span className="shrink-0 text-sm font-bold tabular-nums">
        {item.value ?? (item.amount !== undefined ? formatMoney(item.amount) : "")}
      </span>
    </>
  );
  const className = "flex w-full items-center justify-between gap-3 border border-[#e4e4e8] px-3 py-2 text-left";
  return item.onOpen ? (
    <button className={`${className} hover:border-[#4533ff]`} onClick={item.onOpen} type="button">
      {body}
    </button>
  ) : (
    <div className={className}>{body}</div>
  );
}

export function BackLink({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button className="justify-self-start text-xs font-bold text-[#4533ff] hover:underline" onClick={onClick} type="button">
      ← {label}
    </button>
  );
}

export default function ReportDrill<T>({
  title,
  rows,
  groupOf,
  groupName,
  amountOf,
  itemOf,
  unit,
  detailOf,
  lastGroup = "",
  note,
  onClose,
  wide = false,
}: {
  title: string;
  rows: readonly T[];
  groupOf: (row: T) => DrillGroup;
  /** 요약 단계 이름 — 되돌아가기 링크에 쓴다. 예: "cashiers" → "← All cashiers". */
  groupName: string;
  amountOf?: (row: T) => Cents;
  itemOf: (row: T) => DrillItem;
  /** 건수 단위(단수). 예: "booking" → "3 booking(s)". */
  unit: string;
  /** 요약 줄 아래에 덧붙이는 말(예: 선수 수). */
  detailOf?: (rows: readonly T[]) => string;
  lastGroup?: string;
  note?: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const groups = useMemo(() => summarize(rows, groupOf, amountOf, lastGroup), [rows, groupOf, amountOf, lastGroup]);
  const [picked, setPicked] = useState<string | null>(null);
  const group = picked === null ? null : (groups.find((item) => item.key === picked) ?? null);
  const shown = group ? group.rows : rows;
  const total = amountOf ? shown.reduce((sum, row) => sum + amountOf(row), 0) : null;
  const count = (list: readonly T[]) => `${list.length} ${unit}(s)`;

  return (
    <Modal onClose={onClose} title={group ? `${title} — ${group.label}` : title} wide={wide}>
      <div className="grid gap-3">
        {group ? <BackLink label={`All ${groupName}`} onClick={() => setPicked(null)} /> : null}
        {note && !group ? <p className="text-xs text-[#6b7280]">{note}</p> : null}

        {rows.length === 0 ? (
          <EmptyNote>Nothing here.</EmptyNote>
        ) : group ? (
          <ul className="grid gap-1.5">
            {group.rows.map((row) => {
              const item = itemOf(row);
              return (
                <li key={item.key}>
                  <DrillRow item={item} />
                </li>
              );
            })}
          </ul>
        ) : (
          <ul className="grid gap-1.5">
            {groups.map((item) => (
              <li key={item.key}>
                <DrillRow
                  item={{
                    key: item.key,
                    primary: `${item.label} ›`,
                    secondary: [count(item.rows), detailOf ? detailOf(item.rows) : ""].filter(Boolean).join(" · "),
                    value: amountOf ? formatMoney(item.total) : String(item.rows.length),
                    onOpen: () => setPicked(item.key),
                  }}
                />
              </li>
            ))}
          </ul>
        )}

        <div className="flex items-baseline justify-between gap-2 border-t border-[#d4d4d8] pt-2">
          <span className="text-sm font-bold">
            Total <span className="text-xs font-normal text-[#6b7280]">{count(shown)}</span>
          </span>
          <span className="text-lg font-bold tabular-nums">{total !== null ? formatMoney(total) : shown.length}</span>
        </div>
        <p className="text-[11px] text-[#6b7280]">
          {group
            ? shown.some((row) => itemOf(row).onOpen)
              ? "Tap a row to open it."
              : `Every ${unit} in this group.`
            : "Tap a line to see what is behind it."}
        </p>
      </div>
    </Modal>
  );
}
