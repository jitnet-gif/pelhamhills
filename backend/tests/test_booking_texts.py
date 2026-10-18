"""웹 예약 → 손님 확인 문자 (`backend/services/booking_texts.py`).

실행: `python -m pytest backend/tests/test_booking_texts.py -q`

SQL(0032)은 `supabase_rest.rpc` 자리의 가짜로, Twilio 는 `send_sms` 자리의 가짜로 바꾼다.
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from backend.api.routes import voice
from backend.services import booking_texts as bt
from backend.services import supabase_rest
from backend.services.twilio_sms import SmsMessage

TEE_ROW = {"id": 1, "kind": "tee", "ref": "6f1c0e8e-1b7a-4c55-9a0e-2d4f3b7e9a10", "phone": "905-555-0101",
           "date": "2026-10-20", "time": "8:10 AM", "party_size": 2, "holes": 18, "rate": 65,
           "name": "Pat Lee", "status": "reserved"}
SIM_ROW = {"id": 2, "kind": "sim", "ref": "41", "phone": "+19055559999", "date": "2026-10-20",
           "start_minutes": 19 * 60 + 30, "duration_hours": 2, "confirmation_code": "4f09a1c2b7"}


class FakeSql:
    def __init__(self, outbox: list[dict[str, Any]]) -> None:
        self.outbox = outbox
        self.results: list[dict[str, Any]] = []
        self.calls: list[str] = []

    def rpc(self, function: str, args: dict[str, Any]) -> Any:
        self.calls.append(function)
        if function == "pelham_booking_texts_claim":
            out, self.outbox = self.outbox, []  # 집은 줄은 다시 오지 않는다
            return out
        if function == "pelham_booking_text_result":
            self.results.append(args)
            return None
        raise AssertionError(function)


@pytest.fixture
def twilio(monkeypatch):
    monkeypatch.setattr(bt.settings, "TWILIO_ACCOUNT_SID", "AC_test")
    monkeypatch.setattr(bt.settings, "TWILIO_AUTH_TOKEN", "token")
    monkeypatch.setattr(bt.settings, "TWILIO_PHONE_NUMBER", "+15550000000")
    sent: list[tuple[str, str, str | None]] = []

    async def fake_send(to, body, template=None, booking_ref=None, media_url=None):
        sent.append((to, body, booking_ref))
        status = "failed" if to.endswith("9999") else "queued"
        return SmsMessage(direction="out", to_e164=to, from_e164="+15550000000", body=body, template=template,
                          status=status, twilio_sid=None if status == "failed" else "SM1",
                          error="21211: invalid" if status == "failed" else None)

    monkeypatch.setattr(bt, "send_sms", fake_send)
    return sent


def test_tee_text_matches_phone_booking_text_and_code():
    text, code = bt.tee_text(TEE_ROW)
    assert code == voice._confirmation_code(TEE_ROW["ref"])  # "C <번호>" 취소가 찾는 번호
    assert f"booked 2 players" in text and "at 8:10 AM" in text
    assert f"Confirmation #{code}" in text and f"reply C {code}" in text


def test_sim_text_uses_reservation_code_and_label_time():
    text, code = bt.sim_text(SIM_ROW)
    assert code == "4f09a1c2b7"
    assert "simulator bay booked" in text and "at 7:30 PM for 2 hours" in text
    assert "reply C 4f09a1c2b7" in text


def test_run_sends_each_claimed_row_once_and_records_result(monkeypatch, twilio):
    sql = FakeSql([TEE_ROW, SIM_ROW])
    monkeypatch.setattr(supabase_rest, "rpc", sql.rpc)
    asyncio.run(bt.run())
    asyncio.run(bt.run())  # 두 번째 패스는 집을 것이 없다
    assert [to for to, _, _ in twilio] == ["905-555-0101", "+19055559999"]
    assert sql.results == [
        {"p_id": 1, "p_status": "sent", "p_error": None, "p_sid": "SM1"},
        {"p_id": 2, "p_status": "failed", "p_error": "21211: invalid", "p_sid": None},
    ]


def test_bad_row_is_marked_failed_and_others_still_go(monkeypatch, twilio):
    sql = FakeSql([{"id": 3, "kind": "sim", "phone": "+19055550103"}, TEE_ROW])
    monkeypatch.setattr(supabase_rest, "rpc", sql.rpc)
    asyncio.run(bt.run())
    assert [to for to, _, _ in twilio] == ["905-555-0101"]
    assert sql.results[0]["p_id"] == 3 and sql.results[0]["p_status"] == "failed"


def test_without_twilio_nothing_is_claimed(monkeypatch):
    monkeypatch.setattr(bt.settings, "TWILIO_ACCOUNT_SID", "")
    sql = FakeSql([TEE_ROW])
    monkeypatch.setattr(supabase_rest, "rpc", sql.rpc)
    asyncio.run(bt.run())
    assert sql.calls == []


def test_database_down_is_swallowed(monkeypatch, twilio):
    def down(function, args):
        raise supabase_rest.SupabaseUnavailable("down")

    monkeypatch.setattr(supabase_rest, "rpc", down)
    asyncio.run(bt.run())
    assert twilio == []
