"""기프트카드 문자(`routes/gift_cards.py`).

실행: `python -m pytest backend/tests/test_gift_card_texts.py -q`

SQL 은 `terminal._as_staff` 자리의 가짜로, Twilio 는 `send_sms` 자리의 가짜로 바꾼다.
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

from backend.api.routes import gift_cards, sms, terminal  # noqa: E402
from backend.services.twilio_sms import SmsMessage  # noqa: E402

API = "/api/v1"
CODE = "GIFT-0A1B2C3D4E"
CARD = {"code": CODE, "status": "active", "amount": 10000, "balance": 7550, "recipient": "Jane Smith"}


@pytest.fixture()
def env(monkeypatch):
    monkeypatch.setattr(gift_cards.settings, "TWILIO_ACCOUNT_SID", "AC_test")
    monkeypatch.setattr(gift_cards.settings, "TWILIO_AUTH_TOKEN", "token")
    monkeypatch.setattr(gift_cards.settings, "TWILIO_PHONE_NUMBER", "+15550000000")
    monkeypatch.setenv("PUBLIC_API_BASE_URL", "https://api.example.com/api/v1")
    state = {"card": dict(CARD), "sent": [], "calls": []}

    def fake_staff(request, function, args):
        state["calls"].append((function, args))
        return state["card"]

    async def fake_send(to, body, template=None, booking_ref=None, media_url=None):
        state["sent"].append({"to": to, "body": body, "media_url": media_url, "template": template})
        return SmsMessage(direction="out", to_e164=to, from_e164="+15550000000", body=body,
                          media_url=media_url, status="queued", twilio_sid="SM1")

    monkeypatch.setattr(terminal, "_as_staff", fake_staff)
    monkeypatch.setattr(gift_cards, "send_sms", fake_send)
    app = FastAPI()
    app.include_router(gift_cards.router, prefix=API)
    app.include_router(sms.router, prefix=API)
    return TestClient(app), state


def test_sends_barcode_mms_with_balance(env):
    client, state = env
    res = client.post(f"{API}/gift-cards/{CODE.lower()}/text", json={"phone": "(905) 555-0101"})
    assert res.status_code == 200, res.text
    assert res.json()["to"] == "+19055550101"
    assert state["calls"] == [("pelham_staff_gift_card", {"p_code": CODE})]
    sent = state["sent"][0]
    assert sent["media_url"] == f"https://api.example.com/api/v1/sms/barcode/{CODE}.png"
    assert CODE in sent["body"] and "$75.50" in sent["body"] and "Jane Smith" in sent["body"]
    assert sent["template"] == "gift_card"


def test_barcode_png_serves_gift_card_code(env):
    client, _ = env
    res = client.get(f"{API}/sms/barcode/{CODE}.png")
    assert res.status_code == 200
    assert res.content.startswith(b"\x89PNG")
    assert client.get(f"{API}/sms/barcode/GIFT-XYZ.png").status_code == 404


@pytest.mark.parametrize("change", [{"status": "void"}, {"balance": 0}])
def test_refuses_unusable_card(env, change):
    client, state = env
    state["card"].update(change)
    res = client.post(f"{API}/gift-cards/{CODE}/text", json={"phone": "9055550101"})
    assert res.status_code == 409
    assert state["sent"] == []


def test_bad_phone_or_code(env):
    client, state = env
    assert client.post(f"{API}/gift-cards/{CODE}/text", json={"phone": "555"}).status_code == 422
    assert client.post(f"{API}/gift-cards/RC-0A1B2C3D4E/text", json={"phone": "9055550101"}).status_code == 404
    assert state["calls"] == [] and state["sent"] == []
