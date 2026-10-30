"""온라인 결제 승인 → 손님 이메일 영수증 (`backend/services/payment_emails.py`).

실행: `python -m pytest backend/tests/test_payment_emails.py -q`

SQL(0141)은 `supabase_rest.rpc` 자리의 가짜로, SMTP 는 `receipts.send_mail` 자리의 가짜로 바꾼다.
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from backend.api.routes import receipts
from backend.services import payment_emails as pe
from backend.services import supabase_rest

BILL = {"id": 7, "status": "paid", "receipt_no": "PH-20261030-0004", "paid_at": "2026-10-30T18:05:00Z",
        "subtotal": 4000, "discount": 0, "tax": 520, "total": 4520, "tip": 0,
        "lines": [{"name": "Simulator bay 2", "quantity": 1, "line_total": 4000, "active": True}],
        "payments": [{"method": "card", "amount": 4520, "card_last4": "4242"}]}
BOOKING = {"id": 1, "kind": "booking", "email": "pat@example.com", "bill": BILL}
MEMBERSHIP = {"id": 2, "kind": "membership", "email": "sam@example.com", "invoice": "PHM0123456789AB", "amount": 305100,
              "card_brand": "Visa", "card_last4": "4242", "approved_at": "2026-10-30T18:05:00Z", "reference": "AB12CD34",
              "member_name": "Sam <Kim>", "season": 2027, "membership_type": "nine_hole", "plan": "single", "balance": 0}


class FakeSql:
    def __init__(self, outbox: list[dict[str, Any]]) -> None:
        self.outbox = outbox
        self.results: list[dict[str, Any]] = []
        self.calls: list[str] = []

    def rpc(self, function: str, args: dict[str, Any]) -> Any:
        self.calls.append(function)
        if function == "pelham_payment_emails_claim":
            out, self.outbox = self.outbox, []  # 집은 줄은 다시 오지 않는다
            return out
        if function == "pelham_payment_email_result":
            self.results.append(args)
            return None
        raise AssertionError(function)


@pytest.fixture
def smtp(monkeypatch):
    monkeypatch.setenv("RECEIPT_SMTP_USER", "club@example.com")
    monkeypatch.setenv("RECEIPT_SMTP_PASSWORD", "app password")
    sent: list[dict[str, str]] = []

    def fake_mail(to, subject, text, body_html):
        if to.startswith("down"):
            raise OSError("smtp down")
        sent.append({"to": to, "subject": subject, "text": text, "html": body_html})

    monkeypatch.setattr(receipts, "send_mail", fake_mail)
    return sent


def test_booking_gets_the_same_receipt_as_the_register(monkeypatch, smtp):
    sql = FakeSql([BOOKING])
    monkeypatch.setattr(supabase_rest, "rpc", sql.rpc)
    asyncio.run(pe.run())
    assert smtp[0]["to"] == "pat@example.com"
    assert smtp[0]["subject"] == "Your Pelham Hills receipt PH-20261030-0004"
    assert smtp[0]["text"] == receipts.receipt_email_text(BILL)
    assert "$45.20" in smtp[0]["text"] and "••••4242" in smtp[0]["text"]
    assert sql.results == [{"p_id": 1, "p_status": "sent", "p_error": None}]


def test_membership_receipt_shows_the_payment_and_escapes_the_name(monkeypatch, smtp):
    sql = FakeSql([MEMBERSHIP])
    monkeypatch.setattr(supabase_rest, "rpc", sql.rpc)
    asyncio.run(pe.run())
    mail = smtp[0]
    assert mail["subject"] == "Your Pelham Hills membership receipt AB12CD34"
    for out in (mail["text"], mail["html"]):
        assert "$3,051.00 on Card ••••4242" in out and "2027 · Nine Hole · Single" in out
        assert "Balance owing" not in out
    assert "Sam &lt;Kim&gt;" in mail["html"] and "Sam <Kim>" not in mail["html"]


def test_membership_receipt_shows_a_balance_in_dollars():
    assert "Balance owing: $150.50" in pe.membership_text({**MEMBERSHIP, "balance": 150.5})


def test_each_claimed_row_goes_once_and_a_failure_does_not_stop_the_rest(monkeypatch, smtp):
    failed = {**BOOKING, "id": 3, "email": "down@example.com"}
    bad = {**BOOKING, "id": 4, "email": "no-at-sign"}
    sql = FakeSql([failed, bad, BOOKING])
    monkeypatch.setattr(supabase_rest, "rpc", sql.rpc)
    asyncio.run(pe.run())
    asyncio.run(pe.run())  # 두 번째 패스는 집을 것이 없다
    assert [mail["to"] for mail in smtp] == ["pat@example.com"]
    assert [(r["p_id"], r["p_status"]) for r in sql.results] == [(3, "failed"), (4, "failed"), (1, "sent")]


def test_without_smtp_nothing_is_claimed(monkeypatch):
    for key in ("RECEIPT_SMTP_USER", "RECEIPT_SMTP_PASSWORD", "ACTIVITY_SMTP_USER", "ACTIVITY_SMTP_PASSWORD"):
        monkeypatch.delenv(key, raising=False)
    sql = FakeSql([BOOKING])
    monkeypatch.setattr(supabase_rest, "rpc", sql.rpc)
    asyncio.run(pe.run())
    assert sql.calls == []


def test_database_down_is_swallowed(monkeypatch, smtp):
    def down(function, args):
        raise supabase_rest.SupabaseUnavailable("down")

    monkeypatch.setattr(supabase_rest, "rpc", down)
    asyncio.run(pe.run())
    assert smtp == []
