"use client";

/**
 * 아직 실제 데이터가 붙지 않은 어드민 화면들의 공통 뼈대 — 설명 한 줄, 지표 카드,
 * 그리고 상태를 토글할 수 있는 표 하나.
 *
 * 예전에는 이 파일이 사이드바 마크업과 메뉴 배열을 **자체 복사본**으로 들고 있었고
 * `hidden lg:block` 이라 폭 1024px 미만에서는 메뉴가 통째로 사라졌다. 이제 껍데기는
 * `AdminShell` 하나뿐이고 메뉴는 `lib/nav.ts` 가 유일한 출처다. 그래서 `active` prop 도
 * 없앴다 — 어느 항목이 활성인지는 `AdminShell` 이 `usePathname()` 으로 판단한다.
 */

import { useState, type ReactNode } from "react";

import AdminShell from "@/components/admin/AdminShell";
import type { Screen } from "@/lib/screens";

type Metric = {
  label: string;
  value: string;
};

type Row = {
  name: string;
  detail: string;
  status: string;
};

export default function AdminFeaturePage({
  title,
  description,
  metrics,
  rows,
  actionLabel,
  screen,
  children,
}: {
  title: string;
  description: string;
  metrics: Metric[];
  rows: Row[];
  actionLabel: string;
  /** Account Setup 의 화면 권한(0098)으로 여는 화면이면 그 이름(`AdminShell` 의 같은 prop). */
  screen?: Screen;
  /** 뼈대(설명·지표·표) 아래에 붙일 진짜 패널. 없으면 아무것도 그리지 않는다. */
  children?: ReactNode;
}) {
  const [items, setItems] = useState(rows);
  const [saved, setSaved] = useState("Ready");

  function addItem() {
    const next = {
      // 예전에는 `active` prop 으로 이름을 지었지만 그 prop 은 사라졌다. 화면 이름은
      // 이제 `title` 하나뿐이고, 사람이 읽는 라벨로도 그쪽이 맞다.
      name: `${title} Item ${items.length + 1}`,
      detail: "Draft operational record",
      status: "Draft",
    };
    setItems((current) => [next, ...current]);
    setSaved("Draft added locally");
  }

  function toggleStatus(index: number) {
    setItems((current) =>
      current.map((item, itemIndex) =>
        itemIndex === index
          ? { ...item, status: item.status === "Active" ? "Paused" : "Active" }
          : item,
      ),
    );
    setSaved("Status updated locally");
  }

  return (
    <AdminShell
      screen={screen}
      actions={
        <>
          <span className="text-xs font-bold text-[#6b7280]">{saved}</span>
          <button
            className="tap-target bg-[#4533ff] px-4 py-1.5 text-xs font-bold text-white"
            onClick={addItem}
            type="button"
          >
            {actionLabel}
          </button>
        </>
      }
      title={title}
    >
      <section className="border-b border-[#d4d4d8] bg-white px-4 py-4">
        <p className="max-w-4xl text-sm leading-6 text-[#4e5560]">{description}</p>
      </section>

      <section className="grid gap-4 p-4">
        {/* 390px 에서 1열로 두면 카드 네 장이 세로로 길게 늘어져 아래 표가 접힌 화면
            밖으로 밀린다. 2열이면 한 화면에 지표가 다 들어온다. */}
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {metrics.map((metric) => (
            <article className="border border-[#d6d6dc] bg-white p-3" key={metric.label}>
              <p className="text-xs font-bold text-[#6b7280] uppercase">{metric.label}</p>
              <p className="mt-2 text-2xl font-semibold">{metric.value}</p>
            </article>
          ))}
        </div>

        {/* 표는 네 칸 중 두 칸이 고정폭이라 390px 에서 반드시 넘친다. 좁힐 수는 없으니
            (버튼 칸을 줄이면 44px 과녁이 깨진다) 표 자신이 가로 스크롤 컨테이너 안에서
            스크롤하게 하고, 페이지는 밀리지 않게 한다. 어드민의 모든 넓은 표가 같은
            방식이다 — 카드 목록으로 다시 그리면 같은 표를 두 벌 유지해야 한다. */}
        <div className="min-w-0 overflow-x-auto border border-[#d6d6dc] bg-white">
          <section className="min-w-[720px]">
            <div className="grid grid-cols-[1fr_1.3fr_140px_120px] border-b border-[#d6d6dc] bg-[#d7d5da] px-3 py-2 text-xs font-bold">
              <span>Name</span>
              <span>Detail</span>
              <span>Status</span>
              <span className="text-right">Controls</span>
            </div>
            {items.map((item, index) => (
              <div
                className="grid grid-cols-[1fr_1.3fr_140px_120px] items-center border-b border-[#ececf0] px-3 py-3 text-xs last:border-b-0"
                key={`${item.name}-${index}`}
              >
                <strong>{item.name}</strong>
                <span className="text-[#5d6673]">{item.detail}</span>
                <span>{item.status}</span>
                <button
                  className="justify-self-end border border-[#cfd2d8] bg-white px-3 py-1.5 font-bold"
                  onClick={() => toggleStatus(index)}
                  type="button"
                >
                  Toggle
                </button>
              </div>
            ))}
          </section>
        </div>

        {children}
      </section>
    </AdminShell>
  );
}
