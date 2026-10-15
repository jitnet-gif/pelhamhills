"""카드 승인 → 손님 문자 (`backend/services/payment_texts.py`).

실행: `python -m pytest backend/tests/test_payment_texts.py -q`

SQL(0028)은 `supabase_rest.rpc` 자리의 가짜로, Twilio 는 `send_sms` 자리의 가짜로 바꾼다.
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from backend.api.routes import payments as online
from backend.api.routes import terminal
from backend.services import payment_texts as pt
from backend.services import supabase_rest
from backend.services.twilio_sms import SmsMessage

TERMINAL_ROW = {"id": 1, "source": "terminal", "phone": "+19055550101", "amount": 8550, "tip": 1000,
                "card_brand": "visa", "card_last4": "4242", "receipt_no": None,
                "approved_at": "2026-10-15T18:41:00Z"}
ONLINE_ROW = {"id": 2, "source": "online", "phone": "+19055550102", "amount": 12000, "tip": 0,
              "card_brand": "amex", "card_last4": "0005", "receipt_no": "PH-20261015-0007",
              "invoice": "PHW0000000000AA", "confirmation_code": "T4E7858394",
              "description": "Tee time Oct 16, 8:10 AM (2 players)", "approved_at": "2026-10-15T18:41:00Z"}


class FakeSql:
    def __init__(self, outbox: list[dict[str, Any]]) -> None:
        self.outbox = outbox
        self.results: list[dict[str, Any]] = []
        self.calls: list[tuple[str, dict[str, Any]]] = []

    def rpc(self, function: str, args: dict[str, Any]) -> Any:
        self.calls.append((function, args))
        if function == "pelham_payment_texts_claim":
            out, self.outbox = self.outbox, []  # 집은 줄은 다시 오지 않는다
            return out
        if function == "pelham_payment_text_result":
            self.results.append(args)
            return None
        raise AssertionError(function)


@pytest.fixture
def twilio(monkeypatch):
    monkeypatch.setattr(pt.settings, "TWILIO_ACCOUNT_SID", "AC_test")
    monkeypatch.setattr(pt.settings, "TWILIO_AUTH_TOKEN", "token")
    monkeypatch.setattr(pt.settings, "TWILIO_PHONE_NUMBER", "+15550000000")
    sent: list[tuple[str, str]] = []

    async def fake_send(to, body, template=None, booking_ref=None, media_url=None):
        sent.append((to, body))
        status = "failed" if to.endswith("9999") else "queued"
        return SmsMessage(direction="out", to_e164=to, from_e164="+15550000000", body=body, template=template,
                          status=status, twilio_sid=None if status == "failed" else "SM1",
                          error="21211: invalid" if status == "failed" else None)

    monkeypatch.setattr(pt, "send_sms", fake_send)
    return sent


def test_terminal_text_shows_amount_tip_card_and_time():
    text = pt.receipt_text(TERMINAL_ROW)
    assert "payment approved — $85.50 (incl. $10.00 tip) on Visa ending 4242" in text
    assert "Oct 15, 2:41 PM" in text  # 토론토 시각
    assert "Booking" not in text and "Receipt" not in text
    assert "STOP" in text


def test_online_text_names_the_booking_and_receipt():
    text = pt.receipt_text(ONLINE_ROW)
    assert "$120.00 on AMEX ending 0005" in text
    assert "For Tee time Oct 16, 8:10 AM (2 players)." in text
    assert "Booking T4E7858394." in text and "Receipt PH-20261015-0007." in text


def test_run_sends_each_claimed_row_once_and_records_result(monkeypatch, twilio):
    sql = FakeSql([TERMINAL_ROW, {**ONLINE_ROW, "phone": "+19055559999"}])
    monkeypatch.setattr(supabase_rest, "rpc", sql.rpc)
    asyncio.run(pt.run())
    asyncio.run(pt.run())  # 두 번째 패스는 집을 것이 없다
    assert [to for to, _ in twilio] == ["+19055550101", "+19055559999"]
    assert sql.results == [
        {"p_id": 1, "p_status": "sent", "p_error": None, "p_sid": "SM1"},
        {"p_id": 2, "p_status": "failed", "p_error": "21211: invalid", "p_sid": None},
    ]


def test_without_twilio_nothing_is_claimed(monkeypatch):
    monkeypatch.setattr(pt.settings, "TWILIO_ACCOUNT_SID", "")
    sql = FakeSql([TERMINAL_ROW])
    monkeypatch.setattr(supabase_rest, "rpc", sql.rpc)
    asyncio.run(pt.run())
    assert sql.calls == []


def test_database_down_is_swallowed(monkeypatch, twilio):
    def down(function, args):
        raise supabase_rest.SupabaseUnavailable("down")

    monkeypatch.setattr(supabase_rest, "rpc", down)
    asyncio.run(pt.run())
    assert twilio == []


def test_loop_wakes_on_kick_from_another_thread(monkeypatch):
    passes: list[int] = []

    async def fake_run():
        passes.append(1)

    monkeypatch.setattr(pt, "run", fake_run)
    monkeypatch.setattr(pt, "SWEEP_SECONDS", 30)

    async def scenario():
        task = asyncio.create_task(pt.loop())
        await asyncio.sleep(0.01)
        await asyncio.to_thread(pt.kick)
        await asyncio.sleep(0.05)
        task.cancel()
        return len(passes)

    assert asyncio.run(scenario()) == 1
    monkeypatch.setattr(pt, "_loop", None)
    monkeypatch.setattr(pt, "_wake", None)
    pt.kick()  # 루프가 없으면 아무 일도 없다


def test_terminal_final_kicks_only_for_approved_sales(monkeypatch):
    kicks: list[int] = []
    monkeypatch.setattr(pt, "kick", lambda: kicks.append(1))
    monkeypatch.setattr(terminal, "_service", lambda function, args: {"id": args["p"]["id"]})
    terminal._final({"id": 5, "kind": "sale"}, approved=False, result="failed")
    terminal._final({"id": 6, "kind": "refund"}, approved=True, result="succeeded")
    assert kicks == []
    terminal._final({"id": 7, "kind": "sale"}, approved=True, result="succeeded")
    assert kicks == [1]


def test_online_settle_kicks_when_approved(monkeypatch):
    kicks: list[int] = []
    monkeypatch.setattr(pt, "kick", lambda: kicks.append(1))

    class Paid:
        trans_id = "pi_1"

        def complete_args(self, invoice):
            return {"invoice": invoice}

    monkeypatch.setattr(online, "_rpc", lambda function, args: {"status": "approved", "invoice": "PHW1"})
    online.settle(Paid(), "PHW1")
    monkeypatch.setattr(online, "_rpc", lambda function, args: {"status": "declined"})
    online.settle(Paid(), "PHW1")
    assert kicks == [1]


def test_sale_stores_the_typed_phone_and_rejects_a_bad_one(monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    app = FastAPI()
    app.include_router(terminal.router)
    client = TestClient(app)
    monkeypatch.setattr(terminal.sg, "configured", lambda: True)
    monkeypatch.setattr(terminal, "_as_staff", lambda request, function, args: {"id": 41, "reference": "R1"})
    monkeypatch.setattr(terminal.sg, "create_terminal_intent", lambda **kw: {"id": "pi_41"})
    monkeypatch.setattr(terminal.sg, "process_on_reader", lambda reader, pi: None)
    monkeypatch.setattr(terminal, "_service", lambda function, args: {"id": 41, "pending": True})
    stored: list[dict[str, Any]] = []
    monkeypatch.setattr(supabase_rest, "rpc", lambda function, args: stored.append({function: args}))

    body = {"bill_id": 9, "amount": 1000, "reader_id": "tmr_abc"}
    bad = client.post("/payments/terminal/sale", json={**body, "receipt_phone": "12"})
    assert bad.status_code == 422 and stored == []
    ok = client.post("/payments/terminal/sale", json={**body, "receipt_phone": "(905) 555-0101"})
    assert ok.status_code == 200
    assert stored == [{"pelham_payment_text_phone": {"p_txn": 41, "p_phone": "+19055550101"}}]
    client.post("/payments/terminal/sale", json=body)
    assert len(stored) == 1  # 비우면 적지 않는다(예약 번호로 간다)
