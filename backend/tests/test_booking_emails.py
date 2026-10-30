"""시뮬레이터 웹 예약 → 손님 확정 메일 (`backend/services/booking_emails.py`).

실행: `python -m pytest backend/tests/test_booking_emails.py -q`

SQL(0140)은 `supabase_rest.rpc` 자리의 가짜로, SMTP 는 `_send` 자리의 가짜로 바꾼다.
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from backend.services import booking_emails as be
from backend.services import supabase_rest

ROW = {"id": 1, "email": "pat@example.com", "name": "Pat <Lee>", "date": "2026-10-31", "start_minutes": 19 * 60 + 30,
       "duration_hours": 2, "player_count": 3, "bay_number": 2, "total_price": 40, "confirmation_code": "4f09a1c2b7"}


class FakeSql:
    def __init__(self, outbox: list[dict[str, Any]]) -> None:
        self.outbox = outbox
        self.results: list[dict[str, Any]] = []
        self.calls: list[str] = []

    def rpc(self, function: str, args: dict[str, Any]) -> Any:
        self.calls.append(function)
        if function == "pelham_sim_emails_claim":
            out, self.outbox = self.outbox, []  # 집은 줄은 다시 오지 않는다
            return out
        if function == "pelham_sim_email_result":
            self.results.append(args)
            return None
        raise AssertionError(function)


@pytest.fixture
def smtp(monkeypatch):
    monkeypatch.setenv("RECEIPT_SMTP_USER", "club@example.com")
    monkeypatch.setenv("RECEIPT_SMTP_PASSWORD", "app password")
    sent: list[str] = []

    def fake_send(row):
        if row["email"].startswith("down"):
            raise OSError("smtp down")
        sent.append(row["email"])

    monkeypatch.setattr(be, "_send", fake_send)
    return sent


def test_email_shows_the_booking_and_escapes_the_name():
    text, body = be.email_text(ROW), be.email_html(ROW)
    for out in (text, body):
        assert "7:30 PM" in out and "2 hours" in out and "$40.00 + HST" in out and "4f09a1c2b7" in out
    assert "/book/lookup?code=4f09a1c2b7" in text
    assert "Pat &lt;Lee&gt;" in body and "Pat <Lee>" not in body


def test_run_sends_each_claimed_row_once_and_records_result(monkeypatch, smtp):
    failed = {**ROW, "id": 2, "email": "down@example.com"}
    sql = FakeSql([ROW, failed])
    monkeypatch.setattr(supabase_rest, "rpc", sql.rpc)
    asyncio.run(be.run())
    asyncio.run(be.run())  # 두 번째 패스는 집을 것이 없다
    assert smtp == ["pat@example.com"]
    assert sql.results[0] == {"p_id": 1, "p_status": "sent", "p_error": None}
    assert sql.results[1]["p_id"] == 2 and sql.results[1]["p_status"] == "failed"


def test_bad_address_is_marked_failed_and_others_still_go(monkeypatch, smtp):
    sql = FakeSql([{**ROW, "id": 3, "email": "no-at-sign"}, ROW])
    monkeypatch.setattr(supabase_rest, "rpc", sql.rpc)
    asyncio.run(be.run())
    assert smtp == ["pat@example.com"]
    assert sql.results[0]["p_id"] == 3 and sql.results[0]["p_status"] == "failed"


def test_without_smtp_nothing_is_claimed(monkeypatch):
    for key in ("RECEIPT_SMTP_USER", "RECEIPT_SMTP_PASSWORD", "ACTIVITY_SMTP_USER", "ACTIVITY_SMTP_PASSWORD"):
        monkeypatch.delenv(key, raising=False)
    sql = FakeSql([ROW])
    monkeypatch.setattr(supabase_rest, "rpc", sql.rpc)
    asyncio.run(be.run())
    assert sql.calls == []


def test_database_down_is_swallowed(monkeypatch, smtp):
    def down(function, args):
        raise supabase_rest.SupabaseUnavailable("down")

    monkeypatch.setattr(supabase_rest, "rpc", down)
    asyncio.run(be.run())
    assert smtp == []
