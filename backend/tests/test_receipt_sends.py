"""결제 영수증 문자·이메일(`routes/receipts.py`).

실행: `python -m pytest backend/tests/test_receipt_sends.py -q`

SQL 은 `terminal._as_staff`·`supabase_rest.select` 자리의 가짜로, Twilio 는 `send_sms`, 메일은 `_send_email` 자리의 가짜로 바꾼다.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend.api.routes import receipts, terminal  # noqa: E402
from backend.services.twilio_sms import SmsMessage  # noqa: E402

API = "/api/v1"
BILL = {
    "id": 41, "status": "paid", "receipt_no": "PH-20261026-0007", "paid_at": "2026-10-26T18:15:00Z",
    "subtotal": 14000, "discount": 0, "tax": 1820, "total": 15820, "tip": 0,
    "lines": [
        {"name": "Green fee — Jane <b>Smith</b>", "quantity": 2, "unit_price": 6000, "discount": 0, "line_total": 12000},
        {"name": "Power cart", "quantity": 1, "unit_price": 2000, "discount": 0, "line_total": 2000},
    ],
    "payments": [{"method": "cash", "amount": 15820, "tip": 0, "entry": "none", "card_last4": None}],
}
TABLES = {
    "pelham_bill_lines": [{"kind": "tee_player", "booking_id": "B1", "player_id": "p2", "sim_reservation_id": None}],
    "pelham_tee_bookings": [{"id": "B1", "doc": {"players": [
        {"id": "p1", "phone": "905-555-0100", "email": "first@example.com"},
        {"id": "p2", "phone": "905-555-0101", "email": "jane@example.com"},
    ]}}],
}


@pytest.fixture()
def env(monkeypatch):
    monkeypatch.setattr(receipts.settings, "TWILIO_ACCOUNT_SID", "AC_test")
    monkeypatch.setattr(receipts.settings, "TWILIO_AUTH_TOKEN", "token")
    monkeypatch.setattr(receipts.settings, "TWILIO_PHONE_NUMBER", "+15550000000")
    monkeypatch.setenv("RECEIPT_SMTP_USER", "receipts@pelhamhills.ca")
    monkeypatch.setenv("RECEIPT_SMTP_PASSWORD", "app pass word")
    state = {"bill": dict(BILL), "sms": [], "mail": [], "calls": []}

    def fake_staff(request, function, args):
        state["calls"].append((function, args))
        return state["bill"]

    async def fake_send(to, body, template=None, booking_ref=None, media_url=None):
        state["sms"].append({"to": to, "body": body, "template": template, "ref": booking_ref})
        return SmsMessage(direction="out", to_e164=to, from_e164="+15550000000", body=body,
                          status="queued", twilio_sid="SM1")

    monkeypatch.setattr(terminal, "_as_staff", fake_staff)
    monkeypatch.setattr(receipts, "send_sms", fake_send)
    monkeypatch.setattr(receipts, "_send_email", lambda to, bill: state["mail"].append((to, bill["id"])))
    monkeypatch.setattr(receipts.supabase_rest, "select", lambda table, params: TABLES.get(table, []))
    app = FastAPI()
    app.include_router(receipts.router, prefix=API)
    return TestClient(app), state


def test_contact_prefers_the_player_on_the_bill(env):
    client, state = env
    res = client.get(f"{API}/pos/receipts/41/contact")
    assert res.status_code == 200, res.text
    assert res.json() == {"phone": "905-555-0101", "email": "jane@example.com", "can_text": True, "can_email": True}
    assert state["calls"] == [("pelham_staff_bill", {"p_id": 41})]


def test_cash_bill_sends_text_and_email(env):
    client, state = env
    res = client.post(f"{API}/pos/receipts/41/send", json={"phone": "(905) 555-0101", "email": "jane@example.com"})
    assert res.status_code == 200, res.text
    sms = state["sms"][0]
    assert sms["to"] == "+19055550101" and sms["template"] == "bill_receipt" and sms["ref"] == "PH-20261026-0007"
    assert "Total $158.20" in sms["body"] and "Cash $158.20" in sms["body"] and "x2 $120.00" in sms["body"]
    assert state["mail"] == [("jane@example.com", 41)]


def test_email_only(env):
    client, state = env
    res = client.post(f"{API}/pos/receipts/41/send", json={"email": "jane@example.com"})
    assert res.status_code == 200, res.text
    assert state["sms"] == [] and len(state["mail"]) == 1


def test_open_bill_is_refused(env):
    client, state = env
    state["bill"]["status"] = "open"
    res = client.post(f"{API}/pos/receipts/41/send", json={"phone": "9055550101"})
    assert res.status_code == 409
    assert state["sms"] == []


def test_bad_inputs(env):
    client, _ = env
    assert client.post(f"{API}/pos/receipts/41/send", json={}).status_code == 422
    assert client.post(f"{API}/pos/receipts/41/send", json={"phone": "123"}).status_code == 422
    assert client.post(f"{API}/pos/receipts/41/send", json={"email": "not-an-email"}).status_code == 422


def test_email_without_smtp_is_503(env, monkeypatch):
    client, _ = env
    for name in ("RECEIPT_SMTP_USER", "RECEIPT_SMTP_PASSWORD", "ACTIVITY_SMTP_USER", "ACTIVITY_SMTP_PASSWORD"):
        monkeypatch.delenv(name, raising=False)
    res = client.post(f"{API}/pos/receipts/41/send", json={"email": "jane@example.com"})
    assert res.status_code == 503


def test_email_html_escapes_names():
    html = receipts.receipt_email_html(BILL)
    assert "<b>Smith</b>" not in html and "&lt;b&gt;Smith&lt;/b&gt;" in html
    assert "$158.20" in html and "PH-20261026-0007" in html


def test_long_bill_text_is_cut():
    bill = dict(BILL, lines=[{"name": f"Item {i}", "quantity": 1, "line_total": 100} for i in range(9)])
    text = receipts.receipt_sms(bill)
    assert "Item 5" in text and "Item 6" not in text and "+3 more" in text
