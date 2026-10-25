"""전화 비서가 받는 음식 주문·현장 문제·컴플레인 (0099).

  `pelham_food_orders`   — 스낵바 음식 주문. 메뉴는 계산대 상품 중 'Food & Beverage' 이고 판매 중인 것.
  `pelham_phone_reports` — kind = problem(카트 배터리 방전 등) · complaint.

번호(`FO-0101`, `PB-0101`, `CP-0101`)는 DB 가 만든다 — 분실물(`lost_items.py`)과 같은 이유다.
처리(준비됨·가져감·해결)는 직원 화면의 일이다(0099 의 직원 함수).
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from backend.services import supabase_rest as rest

PRODUCTS = "pelham_retail_products"
FOOD_ORDERS = "pelham_food_orders"
REPORTS = "pelham_phone_reports"

#: 계산대(`RETAIL_CATEGORIES`)와 같은 글자. 스낵바 화면도 이 분류로 좁힌다.
FOOD_CATEGORY = "Food & Beverage"

__all__ = ["FOOD_CATEGORY", "food_menu", "place_food_order", "file_report", "mark_alerted"]


def food_menu() -> list[dict[str, Any]]:
    """판매 중인 음식·음료. 이름순. 재고를 세는 상품은 0개면 뺀다(못 파는 것을 받지 않게)."""
    rows = rest.select(
        PRODUCTS,
        {
            "select": "id,sku,name,price,stock",
            "category": f"eq.{FOOD_CATEGORY}",
            "is_active": "eq.true",
            "order": "name.asc",
        },
    )
    return [row for row in rows if row.get("stock") is None or int(row["stock"]) > 0]


def place_food_order(
    *,
    first_name: str,
    last_name: str,
    phone: str,
    items: list[dict[str, Any]],
    subtotal: int,
    tax: int,
    pickup_time: str = "",
    notes: str = "",
    caller_number: str = "",
    conversation_id: str = "",
) -> dict[str, Any]:
    """새 음식 주문. `ticket` 과 `id` 가 채워진 줄을 돌려준다."""
    row: dict[str, Any] = {
        "first_name": first_name.strip(),
        "last_name": last_name.strip(),
        "phone": phone.strip(),
        "items": items,
        "subtotal": subtotal,
        "tax": tax,
        "total": subtotal + tax,
        "status": "new",
    }
    if pickup_time.strip():
        row["pickup_time"] = pickup_time.strip()
    if notes.strip():
        row["notes"] = notes.strip()
    if caller_number.strip():
        row["caller_number"] = caller_number.strip()
    if conversation_id.strip():
        row["conversation_id"] = conversation_id.strip()
    return rest.insert(FOOD_ORDERS, row)


def file_report(
    *,
    kind: str,
    category: str,
    details: str,
    first_name: str,
    last_name: str,
    phone: str,
    location: str = "",
    cart_number: str = "",
    wants_callback: bool = False,
    caller_number: str = "",
    conversation_id: str = "",
) -> dict[str, Any]:
    """현장 문제 또는 컴플레인 한 건. `ticket` 과 `id` 가 채워진 줄을 돌려준다."""
    row: dict[str, Any] = {
        "kind": kind,
        "category": category.strip() or "other",
        "details": details.strip(),
        "first_name": first_name.strip(),
        "last_name": last_name.strip(),
        "phone": phone.strip(),
        "wants_callback": wants_callback,
        "status": "open",
    }
    if location.strip():
        row["location"] = location.strip()
    if cart_number.strip():
        row["cart_number"] = cart_number.strip()
    if caller_number.strip():
        row["caller_number"] = caller_number.strip()
    if conversation_id.strip():
        row["conversation_id"] = conversation_id.strip()
    return rest.insert(REPORTS, row)


def mark_alerted(report_id: str) -> None:
    """직원 번호로 문자를 보냈다고 적는다. 화면에 "Staff texted" 로 보인다."""
    rest.update(REPORTS, {"id": f"eq.{report_id}"}, {"staff_alerted_at": datetime.now(timezone.utc).isoformat()})
