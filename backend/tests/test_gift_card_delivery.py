"""온라인 기프트카드 문자·메일 (`backend/services/gift_card_delivery.py`).

실행: `python -m pytest backend/tests/test_gift_card_delivery.py -q`

SQL(0144)은 `supabase_rest.rpc` 자리의 가짜로, Twilio·SMTP 는 함수 자리의 가짜로 바꾼다.
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from backend.api.routes import gift_cards, receipts
from backend.services import gift_card_delivery as gd
from backend.services import supabase_rest
from backend.services.twilio_sms import SmsMessage

CARD = {"code": "GIFT-0A1B2C3D4E", "amount": 10000, "balance": 10000, "used": 0, "recipient": "Jane", "expires_on": None}
ROW = {"id": "u-1", "invoice": "PHG0123456789AB", "amount": 10000, "buyer_name": "Pat <Kim>",
       "buyer_email": "pat@example.com", "buyer_phone": "9055551234", "recipient_email": "jane@example.com",
       "recipient_phone": "9055550000", "card_brand": "Visa", "card_last4": "4242",
       "approved_at": "2026-10-30T18:05:00Z", "card": CARD}


@pytest.fixture()
def env(monkeypatch):
    state: dict[str, Any] = {"mail": [], "certs": [], "texts": [], "results": [], "outbox": [dict(ROW)], "fail": set()}

    def fake_rpc(function, args):
        if function == "pelham_gift_order_deliveries_claim":
            out, state["outbox"] = state["outbox"], []
            return out
        state["results"].append(args)

    def fake_cert(to, card):
        if "cert" in state["fail"]:
            raise OSError("smtp")
        state["certs"].append((to, card))

    async def fake_sms(to, body, **kw):
        state["texts"].append((to, body, kw))
        return SmsMessage(direction="out", to_e164=to, from_e164="+1", body=body, status="failed" if "text" in state["fail"] else "sent")

    monkeypatch.setattr(supabase_rest, "rpc", fake_rpc)
    monkeypatch.setattr(receipts, "email_enabled", lambda: True)
    monkeypatch.setattr(receipts, "send_mail", lambda to, subject, text, body: state["mail"].append((to, subject, body)))
    monkeypatch.setattr(gift_cards, "_send_certificate", fake_cert)
    monkeypatch.setattr(gd, "send_sms", fake_sms)
    monkeypatch.setattr(gd.settings, "TWILIO_ACCOUNT_SID", "AC")
    monkeypatch.setattr(gd.settings, "TWILIO_AUTH_TOKEN", "t")
    monkeypatch.setattr(gd.settings, "TWILIO_PHONE_NUMBER", "+15550000000")
    return state


def test_buyer_and_recipient_both_receive_it(env):
    asyncio.run(gd.run())
    assert [to for to, _ in env["certs"]] == ["pat@example.com", "jane@example.com"]
    assert [to for to, *_ in env["texts"]] == ["+19055551234", "+19055550000"]
    assert [to for to, *_ in env["mail"]] == ["pat@example.com"]
    assert env["results"] == [{"p_id": "u-1", "p_status": "sent", "p_error": None}]
    assert all(card["code"] == CARD["code"] for _, card in env["certs"])


def test_only_the_recipient_copy_names_the_sender(env):
    asyncio.run(gd.run())
    assert not env["certs"][0][1].get("from_name") and env["certs"][1][1]["from_name"] == "Pat <Kim>"
    assert "A gift from" not in env["texts"][0][1] and "A gift from Pat" in env["texts"][1][1]


def test_same_address_goes_once(env):
    env["outbox"] = [{**ROW, "recipient_email": "PAT@example.com", "recipient_phone": "905-555-1234"}]
    asyncio.run(gd.run())
    assert len(env["certs"]) == 1 and len(env["texts"]) == 1


def test_one_failure_does_not_stop_the_rest(env):
    env["fail"].add("cert")
    asyncio.run(gd.run())
    assert len(env["texts"]) == 2 and env["mail"]
    assert env["results"][0]["p_status"] == "partial" and "email" in env["results"][0]["p_error"]


def test_nothing_sent_is_failed(env):
    env["fail"].update({"cert", "text"})
    env["outbox"] = [dict(ROW)]
    env_mail = env["mail"]
    gd_send = receipts.send_mail

    def boom(*args):
        raise OSError("smtp")

    receipts.send_mail = boom
    try:
        asyncio.run(gd.run())
    finally:
        receipts.send_mail = gd_send
    assert not env_mail and env["results"][0]["p_status"] == "failed"


def test_receipt_escapes_names_and_says_no_hst(env):
    page = gd.receipt_html({**ROW, "card": {**CARD, "recipient": "<b>Jane</b>"}})
    assert "&lt;b&gt;Jane" in page and "<b>Jane" not in page and "$100.00" in page
    assert "No HST" in gd.receipt_text(ROW)


def test_certificate_email_names_the_sender_escaped():
    card = {**CARD, "from_name": "Pat <Kim>"}
    assert "From: Pat <Kim>" in gift_cards.certificate_email_text(card)
    assert "A gift from Pat &lt;Kim&gt;." in gift_cards.certificate_email_html(card)
    assert "A gift from" not in gift_cards.certificate_email_html(CARD)
