"""바깥 서비스 사용량(`services/service_usage.py`).

실행: `python -m pytest backend/tests/test_service_usage.py -q`

Twilio·ElevenLabs·Fly 는 httpx.MockTransport 로 바꾼다.
"""

from __future__ import annotations

import asyncio
import sys
from datetime import date
from pathlib import Path

import httpx
import pytest

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend.services import service_usage  # noqa: E402


@pytest.fixture
def mock_http(monkeypatch):
    routes = {}
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        for prefix, reply in routes.items():
            if str(request.url).startswith(prefix):
                return reply(request) if callable(reply) else httpx.Response(200, json=reply)
        return httpx.Response(404, json={"message": "nope"})

    real = httpx.AsyncClient

    def client(*args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(handler)
        return real(*args, **kwargs)

    monkeypatch.setattr(service_usage.httpx, "AsyncClient", client)
    monkeypatch.setattr(service_usage.settings, "TWILIO_ACCOUNT_SID", "AC1")
    monkeypatch.setattr(service_usage.settings, "TWILIO_AUTH_TOKEN", "tok")
    service_usage._twilio_prices.clear()
    return routes, calls


def test_message_prices_follow_pages_and_skip_unpriced(mock_http):
    routes, calls = mock_http
    base = "https://api.twilio.com/2010-04-01/Accounts/AC1/Messages.json"

    def pages(request):
        if "Page=1" in str(request.url):
            return httpx.Response(200, json={"messages": [
                {"sid": "SM2", "price": "-0.0166", "price_unit": "USD", "num_segments": "2"}], "next_page_uri": None})
        return httpx.Response(200, json={"messages": [
            {"sid": "SM1", "price": "-0.0083", "price_unit": "USD", "num_segments": "1"},
            {"sid": "SM3", "price": None, "price_unit": "USD", "num_segments": "1"},
            {"sid": "SMx", "price": "-1.00", "price_unit": "USD", "num_segments": "1"}],
            "next_page_uri": "/2010-04-01/Accounts/AC1/Messages.json?Page=1&PageSize=1000"})

    routes[base] = pages
    got = asyncio.run(service_usage.twilio_message_prices(["SM1", "SM2", "SM3"], date(2026, 10, 28), date(2026, 10, 28)))
    assert got == {"SM1": {"price": 0.0083, "unit": "USD", "segments": 1},
                   "SM2": {"price": 0.0166, "unit": "USD", "segments": 2}}
    first = calls[0].url
    assert first.params["DateSent>"] == "2026-10-28" and first.params["DateSent<"] == "2026-10-29"
    # 붙은 요금은 담아 두고 다시 묻지 않는다(SM3 만 남아 한 번 더 읽는다).
    calls.clear()
    asyncio.run(service_usage.twilio_message_prices(["SM1", "SM2"], date(2026, 10, 28), date(2026, 10, 28)))
    assert calls == []


def test_twilio_usage_keeps_paid_rows(mock_http):
    routes, _ = mock_http
    base = "https://api.twilio.com/2010-04-01/Accounts/AC1"
    routes[f"{base}/Balance.json"] = {"balance": "-3.20", "currency": "USD"}
    routes[f"{base}/Usage/Records/ThisMonth.json"] = {"usage_records": [
        {"category": "totalprice", "price": "12.50", "price_unit": "usd", "start_date": "2026-10-01"},
        {"category": "sms-outbound", "count": "900", "usage": "950", "usage_unit": "segments", "price": "7.88"},
        {"category": "mms-inbound", "count": "0", "usage": "0", "price": "0"},
        {"category": "phonenumbers", "count": "1", "usage": "1", "usage_unit": "phonenumbers", "price": "1.15"},
    ]}
    got = asyncio.run(service_usage.twilio_usage())
    assert got["ok"] and got["balance"] == -3.2 and got["month_total"] == 12.5
    assert [r["category"] for r in got["rows"]] == ["sms-outbound", "phonenumbers"]


def test_elevenlabs_missing_permission_says_how_to_fix(mock_http, monkeypatch):
    routes, _ = mock_http
    monkeypatch.setenv("ELEVENLABS_API_KEY", "sk_real")
    routes["https://api.elevenlabs.io/v1/user/subscription"] = lambda r: httpx.Response(401, json={"detail": {
        "message": "The API key you used is missing the permission user_read to execute this operation."}})
    got = asyncio.run(service_usage.elevenlabs_usage())
    assert got["ok"] is False and got["needs_permission"] == "user_read"


def test_elevenlabs_subscription(mock_http, monkeypatch):
    routes, _ = mock_http
    monkeypatch.setenv("ELEVENLABS_API_KEY", "sk_real")
    routes["https://api.elevenlabs.io/v1/user/subscription"] = {
        "tier": "creator", "status": "active", "character_count": 61000, "character_limit": 100000,
        "next_character_count_reset_unix": 1767225600, "currency": "usd",
        "next_invoice": {"amount_due_cents": 2200, "next_payment_attempt_unix": 1767225600}}
    got = asyncio.run(service_usage.elevenlabs_usage())
    assert (got["tier"], got["used"], got["limit"], got["next_invoice_cents"]) == ("creator", 61000, 100000, 2200)


def test_fly_without_token_explains(monkeypatch):
    monkeypatch.delenv("FLY_API_TOKEN", raising=False)
    got = asyncio.run(service_usage.fly_usage())
    assert got["ok"] is False and "FLY_API_TOKEN" in got["error"]


def test_fly_reads_org_and_machines(mock_http, monkeypatch):
    routes, calls = mock_http
    monkeypatch.setenv("FLY_API_TOKEN", "FlyV1 fm2_abc")
    routes["https://api.fly.io/graphql"] = {"data": {"organization": {
        "name": "SMEAG", "billable": True, "billingStatus": "CURRENT", "creditBalance": 0,
        "isCreditCardSaved": True, "paidPlan": True,
        "apps": {"nodes": [{"name": "pelham-hills-api", "status": "deployed"}]}}}}
    routes["https://api.machines.dev/v1/apps/pelham-hills-api/machines"] = lambda r: httpx.Response(200, json=[
        {"id": "m1", "state": "started", "region": "yyz",
         "config": {"guest": {"cpu_kind": "shared", "cpus": 1, "memory_mb": 512}}}])
    got = asyncio.run(service_usage.fly_usage())
    assert got["ok"] and got["billing_status"] == "CURRENT"
    assert got["apps"][0]["machines"][0]["memory_mb"] == 512
    assert calls[0].headers["Authorization"] == "FlyV1 fm2_abc"
