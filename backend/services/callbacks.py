"""전화 상담 콜백 명단 (`pelham_callback_requests`, 0059).

업무시간 밖에 걸려 온 전화에서 손님이 사람과 얘기해야 하면, 전화 비서는 프로 샵으로 연결하지 않고
"업무시간에 직원이 전화드리겠습니다" 라고 말한 뒤 여기에 적는다. 직원은 Reports 의 Phone callbacks
탭에서 목록을 보고 전화한 뒤 "Called" 로 바꾼다(0059 의 직원 함수).

번호는 DB 시퀀스가 만든다 — 분실물(`lost_items.py`)과 같은 이유다.
"""

from __future__ import annotations

from typing import Any

from backend.services import supabase_rest as rest

TABLE = "pelham_callback_requests"

__all__ = ["TABLE", "request"]


def request(
    *,
    first_name: str,
    last_name: str,
    phone: str,
    reason: str,
    preferred_time: str = "",
    caller_number: str = "",
    conversation_id: str = "",
) -> dict[str, Any]:
    """새 콜백 요청. `ticket` 과 `id` 가 채워진 줄을 돌려준다."""
    row: dict[str, Any] = {
        "first_name": first_name.strip(),
        "last_name": last_name.strip(),
        "phone": phone.strip(),
        "reason": reason.strip(),
        "status": "open",
    }
    if preferred_time.strip():
        row["preferred_time"] = preferred_time.strip()
    if caller_number.strip():
        row["caller_number"] = caller_number.strip()
    if conversation_id.strip():
        row["conversation_id"] = conversation_id.strip()
    return rest.insert(TABLE, row)
