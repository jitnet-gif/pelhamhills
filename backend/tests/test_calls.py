"""통화 기록 화면(`routes/calls.py`) — ElevenLabs 를 흉내 내고 모양만 본다.

실행: `python -m pytest backend/tests/test_calls.py -q`
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend.api.routes import calls, terminal  # noqa: E402
from backend.services import voice_agent  # noqa: E402

API = "/api/v1"

DETAIL = {
    "conversation_id": "conv_abc",
    "status": "done",
    "has_audio": True,
    "metadata": {"start_time_unix_secs": 1760000000, "call_duration_secs": 94,
                 "phone_call": {"external_number": "+19055550100"}},
    "analysis": {"transcript_summary": "Booked four players.", "call_summary_title": "Tee time booking",
                 "call_successful": "success"},
    "transcript": [
        {"role": "agent", "message": "Hi!", "time_in_call_secs": 0},
        {"role": "agent", "message": None, "time_in_call_secs": 40,
         "tool_calls": [{"tool_name": "cancel_booking", "params_as_json": "{}"}],
         "tool_results": [{"tool_name": "cancel_booking", "is_error": False,
                           "result_value": json.dumps({"ok": True, "cancelled": False, "booking_id": "x"})}]},
        {"role": "agent", "message": None, "time_in_call_secs": 60,
         "tool_calls": [{"tool_name": "confirm_booking", "params_as_json": "{}"}],
         "tool_results": [{"tool_name": "confirm_booking", "is_error": False,
                           "result_value": json.dumps({"ok": True, "booking": {
                               "booking_id": "bk_1", "date": "2026-10-19", "time": "7:52 AM",
                               "name": "Kim, Daniel", "confirmation_code": "ABCD-1234", "party_size": 4}})}]},
    ],
}


@pytest.fixture()
def client(monkeypatch):
    monkeypatch.setattr(terminal, "_require_staff", lambda request: None)

    async def fake_list(cursor=None, page_size=30):
        return {"conversations": [
            {"conversation_id": "conv_abc", "tool_names": ["identify_caller", "confirm_booking"],
             "call_summary_title": "Tee time booking", "start_time_unix_secs": 1760000000},
            {"conversation_id": "conv_def", "tool_names": ["transfer_to_number"]},
        ], "has_more": False, "next_cursor": None}

    async def fake_get(conversation_id):
        return DETAIL

    monkeypatch.setattr(voice_agent, "list_conversations", fake_list)
    monkeypatch.setattr(voice_agent, "get_conversation", fake_get)
    app = FastAPI()
    app.include_router(calls.router, prefix=API)
    with TestClient(app) as test_client:
        yield test_client


def test_list_labels_outcome(client):
    body = client.get(f"{API}/calls").json()
    assert [c["outcome"] for c in body["calls"]] == ["booked", "transferred"]


def test_detail_finds_booking_and_skips_preview(client):
    body = client.get(f"{API}/calls/conv_abc").json()
    assert body["caller"] == "+19055550100"
    assert body["bookings"] == [{
        "kind": "tee", "action": "booked", "booking_id": "bk_1", "date": "2026-10-19",
        "time": "7:52 AM", "name": "Kim, Daniel", "confirmation_code": "ABCD-1234", "party_size": 4,
    }]
    assert body["outcome"] == "booked"
    assert len(body["transcript"]) == 3


def test_rejects_bad_id(client):
    assert client.get(f"{API}/calls/bad id!").status_code in (404, 422)


def test_staff_only(monkeypatch, client):
    def refuse(request):
        raise HTTPException(status_code=401, detail="Sign in")
    monkeypatch.setattr(terminal, "_require_staff", refuse)
    assert client.get(f"{API}/calls").status_code == 401
