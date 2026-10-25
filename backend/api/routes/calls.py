"""통화 기록 — 어드민 "Calls & SMS" 화면.

GET /calls                 이 에이전트의 통화 목록 (최근 것부터, 커서로 다음 쪽)
GET /calls/{id}            통화 한 건: 요약, 녹취, 그 통화에서 생긴 예약
GET /calls/{id}/audio      통화 녹음 (mp3)

원본은 ElevenLabs 다. 우리 쪽에 통화를 따로 쌓지 않는다 — 두 벌이 되면 어긋난다.
녹취에는 손님 이름과 전화번호가 있으므로 직원만 본다(요청의 Supabase 토큰 → SQL,
단말기·대사 리포트와 같은 확인). 그래서 공개 배포에서도 연다.

"이 통화로 예약이 생겼나" 는 녹취 속 도구 결과에서 읽는다. confirm_booking 의 응답이
`booking.booking_id` 와 날짜를 담고 있어, 화면은 그걸로 티 시트의 그 예약을 연다.
"""

from __future__ import annotations

import asyncio
import json
import re
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Query, Request, Response

from backend.api.routes import terminal
from backend.services import voice_agent

router = APIRouter(prefix="/calls", tags=["Calls"])

_CONVERSATION_ID = re.compile(r"^[A-Za-z0-9_-]{1,100}$")

#: 목록 한 줄의 결과. 한 통화에 여러 도구가 섞이면 위에 있는 것이 이긴다.
_OUTCOMES: list[tuple[str, set[str]]] = [
    ("booked", {"confirm_booking", "book_sim_bay"}),
    ("modified", {"modify_booking"}),
    ("cancelled", {"cancel_booking", "cancel_sim_booking"}),
    ("waitlist", {"join_waitlist"}),
    ("food_order", {"place_food_order"}),
    ("problem", {"report_problem"}),
    ("complaint", {"file_complaint"}),
    ("lost_item", {"report_lost_item"}),
    ("transferred", {"transfer_to_number"}),
]

#: 녹취에서 예약을 읽어 낼 도구. (종류, 동작)
_BOOKING_TOOLS: dict[str, tuple[str, str]] = {
    "confirm_booking": ("tee", "booked"),
    "modify_booking": ("tee", "modified"),
    "cancel_booking": ("tee", "cancelled"),
    "book_sim_bay": ("sim", "booked"),
    "cancel_sim_booking": ("sim", "cancelled"),
}


def _upstream(exc: voice_agent.VoiceAgentError) -> HTTPException:
    text = str(exc)
    if "is not set" in text:
        return HTTPException(status_code=503, detail="ElevenLabs is not set up on the server yet.")
    if "convai_read" in text:
        return HTTPException(
            status_code=503,
            detail="The ElevenLabs API key cannot read call history (needs the convai_read permission).",
        )
    if " 404 " in text:
        return HTTPException(status_code=404, detail="No such call.")
    return HTTPException(status_code=502, detail="ElevenLabs did not answer. Try again in a moment.")


async def _require_staff(request: Request) -> None:
    # 직원 확인은 Supabase 왕복이다. async 핸들러에서 그대로 부르면 그동안 음성 도구까지 멈춘다.
    await asyncio.to_thread(terminal._require_staff, request)


def _check_id(conversation_id: str) -> None:
    if not _CONVERSATION_ID.match(conversation_id):
        raise HTTPException(status_code=422, detail="Bad call id.")


def outcome(tool_names: list[str]) -> str:
    names = set(tool_names)
    for label, tools in _OUTCOMES:
        if names & tools:
            return label
    return "info"


def transfer_failed(transcript: list[dict[str, Any]]) -> bool:
    """직원 연결을 불렀지만 하나도 이어지지 않았나.

    ElevenLabs 는 연결 중에 손님이 말하면 도구를 버리고 is_error 로 남긴다
    ("Tool execution was abandoned due to user input"). 결과가 없으면 실패로 보지 않는다.
    """
    results = [
        res for turn in transcript for res in turn.get("tool_results") or []
        if res.get("tool_name") == "transfer_to_number"
    ]
    return bool(results) and all(res.get("is_error") for res in results)


def _settle(label: str, transcript: list[dict[str, Any]]) -> str:
    return "transfer_failed" if label == "transferred" and transfer_failed(transcript) else label


def _row(item: dict[str, Any]) -> dict[str, Any]:
    tools = [str(t) for t in item.get("tool_names") or []]
    return {
        "id": item.get("conversation_id"),
        "started_at": item.get("start_time_unix_secs"),
        "duration": item.get("call_duration_secs"),
        "status": item.get("status"),
        "successful": item.get("call_successful"),
        "title": item.get("call_summary_title") or "",
        "summary": item.get("transcript_summary") or "",
        "direction": item.get("direction"),
        "source": item.get("conversation_initiation_source"),
        "tools": tools,
        "outcome": outcome(tools),
    }


def _parse_result(value: Any) -> dict[str, Any] | None:
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except ValueError:
            return None
        return parsed if isinstance(parsed, dict) else None
    return None


def bookings_from(transcript: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """녹취의 도구 결과에서 이 통화가 만들거나 바꾸거나 취소한 예약을 뽑는다.

    취소 미리보기(`cancelled: false`)와 실패한 호출은 건너뛴다.
    """
    found: list[dict[str, Any]] = []
    for turn in transcript:
        for result in turn.get("tool_results") or []:
            name = result.get("tool_name")
            if name not in _BOOKING_TOOLS or result.get("is_error"):
                continue
            body = _parse_result(result.get("result_value"))
            if not body or body.get("ok") is False or body.get("cancelled") is False:
                continue
            kind, action = _BOOKING_TOOLS[name]
            booking = body.get("booking") if isinstance(body.get("booking"), dict) else body
            booking_id = booking.get("booking_id") or booking.get("reservation_id")
            if not booking_id:
                continue
            found.append({
                "kind": kind,
                "action": action,
                "booking_id": str(booking_id),
                "date": booking.get("date"),
                "time": booking.get("time"),
                "name": booking.get("name"),
                "confirmation_code": booking.get("confirmation_code"),
                "party_size": booking.get("party_size") or booking.get("players"),
            })
    return found


def _caller(detail: dict[str, Any]) -> str:
    metadata = detail.get("metadata") or {}
    phone = metadata.get("phone_call") if isinstance(metadata, dict) else None
    if isinstance(phone, dict) and phone.get("external_number"):
        return str(phone["external_number"])
    client = detail.get("conversation_initiation_client_data") or {}
    variables = client.get("dynamic_variables") if isinstance(client, dict) else None
    if isinstance(variables, dict) and variables.get("system__caller_id"):
        return str(variables["system__caller_id"])
    return ""


def _turns(transcript: list[dict[str, Any]]) -> list[dict[str, Any]]:
    turns = []
    for turn in transcript:
        tools = [
            {"name": call.get("tool_name"), "params": call.get("params_as_json") or ""}
            for call in turn.get("tool_calls") or []
        ]
        results = [
            {"name": res.get("tool_name"), "error": bool(res.get("is_error")),
             "result": str(res.get("result_value") or "")[:2000]}
            for res in turn.get("tool_results") or []
        ]
        message = turn.get("message") or ""
        if not message and not tools and not results:
            continue
        turns.append({
            "role": turn.get("role"),
            "message": message,
            "at": turn.get("time_in_call_secs"),
            "tool_calls": tools,
            "tool_results": results,
        })
    return turns


@router.get("")
async def list_calls(
    request: Request,
    cursor: Optional[str] = None,
    page_size: int = Query(default=30, ge=1, le=100),
) -> dict[str, Any]:
    await _require_staff(request)
    try:
        payload = await voice_agent.list_conversations(cursor, page_size)
    except voice_agent.VoiceAgentError as exc:
        raise _upstream(exc) from None
    rows = [_row(item) for item in payload.get("conversations") or []]
    # 목록에는 도구 이름만 온다. 연결이 실제로 됐는지는 녹취를 봐야 알아서, 연결한 통화만
    # 한 건씩 더 읽는다(드물다). 못 읽으면 "Transferred" 그대로 둔다.
    transfers = [row for row in rows if row["outcome"] == "transferred" and row["id"]]
    details = await asyncio.gather(
        *(voice_agent.get_conversation(str(row["id"])) for row in transfers), return_exceptions=True,
    )
    for row, detail in zip(transfers, details):
        if isinstance(detail, dict):
            transcript = [t for t in detail.get("transcript") or [] if isinstance(t, dict)]
            row["outcome"] = _settle(row["outcome"], transcript)
    return {
        "calls": rows,
        "next_cursor": payload.get("next_cursor"),
        "has_more": bool(payload.get("has_more")),
    }


@router.get("/{conversation_id}")
async def get_call(request: Request, conversation_id: str) -> dict[str, Any]:
    _check_id(conversation_id)
    await _require_staff(request)
    try:
        detail = await voice_agent.get_conversation(conversation_id)
    except voice_agent.VoiceAgentError as exc:
        raise _upstream(exc) from None

    metadata = detail.get("metadata") or {}
    analysis = detail.get("analysis") or {}
    transcript = [t for t in detail.get("transcript") or [] if isinstance(t, dict)]
    tool_names = sorted({
        str(call.get("tool_name"))
        for turn in transcript for call in turn.get("tool_calls") or [] if call.get("tool_name")
    })
    return {
        "id": detail.get("conversation_id") or conversation_id,
        "status": detail.get("status"),
        "started_at": metadata.get("start_time_unix_secs"),
        "duration": metadata.get("call_duration_secs"),
        "termination_reason": metadata.get("termination_reason") or "",
        "caller": _caller(detail),
        "title": analysis.get("call_summary_title") or "",
        "summary": analysis.get("transcript_summary") or "",
        "successful": analysis.get("call_successful"),
        "has_audio": bool(detail.get("has_audio")),
        "outcome": _settle(outcome(tool_names), transcript),
        "bookings": bookings_from(transcript),
        "transcript": _turns(transcript),
    }


@router.get("/{conversation_id}/audio")
async def get_call_audio(request: Request, conversation_id: str) -> Response:
    _check_id(conversation_id)
    await _require_staff(request)
    try:
        body, content_type = await voice_agent.conversation_audio(conversation_id)
    except voice_agent.VoiceAgentError as exc:
        raise _upstream(exc) from None
    return Response(content=body, media_type=content_type, headers={"Cache-Control": "private, no-store"})
