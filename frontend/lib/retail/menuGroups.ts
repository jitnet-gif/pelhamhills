import type { Product } from "./types";

/**
 * 계산대 메뉴 그룹(0030) — Lightspeed 계산대의 그룹 버튼처럼 상품을 폴더로 묶는다.
 *
 * 이름은 대소문자·앞뒤 공백을 무시하고 하나로 본다. "hot food" 와 "Hot Food " 가 따로 뜨면
 * 직원은 한쪽 폴더에서 상품을 못 찾는다. 폴더 이름은 그 그룹의 첫 상품이 쓴 글자다.
 */
export function menuGroupKey(product: Product): string {
  return (product.menu_group ?? "").trim().toLowerCase();
}

export type MenuGroup = { key: string; label: string; products: Product[] };

/** 그룹 있는 상품은 이름순 폴더로, 그룹 없는 상품은 `loose` 로. 들어온 상품 순서는 폴더 안에서 지킨다. */
export function groupProducts(products: Product[]): { groups: MenuGroup[]; loose: Product[] } {
  const byKey = new Map<string, MenuGroup>();
  const loose: Product[] = [];
  for (const product of products) {
    const key = menuGroupKey(product);
    if (!key) {
      loose.push(product);
      continue;
    }
    const group = byKey.get(key);
    if (group) group.products.push(product);
    else byKey.set(key, { key, label: (product.menu_group ?? "").trim(), products: [product] });
  }
  const groups = [...byKey.values()].sort((a, b) => a.label.localeCompare(b.label));
  return { groups, loose };
}

/** 상품 창의 그룹 칸 제안 목록. 같은 분류의 그룹을 앞에 둔다. */
export function menuGroupSuggestions(products: Product[], category?: string): string[] {
  const { groups } = groupProducts(products);
  const inCategory = (group: MenuGroup) => group.products.some((item) => item.category === category);
  return [...groups.filter(inCategory), ...groups.filter((group) => !inCategory(group))].map((group) => group.label);
}
