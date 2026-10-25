"""전화 비서가 받는 음식 주문·현장 문제·컴플레인.

  음식 주문            — GPS 앱의 `menu_items` · `place_food_order`(같은 Supabase). GPS 운영 관리의 주문 탭에 뜬다.
  `pelham_phone_reports` — kind = problem(카트 배터리 방전 등) · complaint (0099).

번호(`PB-0101`, `CP-0101`)는 DB 가 만든다 — 분실물(`lost_items.py`)과 같은 이유다.
처리(해결)는 직원 화면의 일이다(0099 의 직원 함수).
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from backend.services import supabase_rest as rest

REPORTS = "pelham_phone_reports"

__all__ = ["food_menu", "food_order_settings", "place_food_order", "file_report", "mark_alerted"]


# ----- 음식 주문: GPS 앱(golf-gps-pelhamhills-seven 0012)의 표와 함수를 그대로 쓴다 -----

def food_menu() -> list[dict[str, Any]]:
    """GPS 메뉴 중 지금 있는 것. GPS 앱 화면과 같은 순서(분류 → 정렬 → 이름)."""
    return rest.select(
        "menu_items",
        {
            "select": "id,name,category,price_cents",
            "is_available": "eq.true",
            "order": "category.asc,sort_order.asc,name.asc",
        },
    )


def food_order_settings() -> dict[str, Any]:
    """GPS 운영 관리에서 고치는 주문 시간 설정(open·close·lead_minutes·slot_minutes·enabled)."""
    value = rest.rpc("food_order_settings", {})
    return value if isinstance(value, dict) else {}


def place_food_order(payload: dict[str, Any]) -> dict[str, Any]:
    """GPS 의 `place_food_order(p)`. 값·품절·시간은 그 함수가 다시 확인하고, 거절은 RpcRefused 로 온다.
    성공하면 {code, items, total_cents, pickup_at, status}. 직원 푸시도 그 함수가 보낸다."""
    return rest.rpc("place_food_order", {"p": payload})


# ----- 현장 문제 · 컴플레인 (0099) -----

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
