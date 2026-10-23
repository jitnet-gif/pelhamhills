"""손님 개인 QR 문자(`routes/customer_qr.py`).

실행: `python -m pytest backend/tests/test_customer_qr.py -q`

SQL 은 `supabase_rest.rpc_as` 자리의 가짜로, Twilio 는 `send_sms` 자리의 가짜로 바꾼다.
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

from backend.api.routes import customer_qr  # noqa: E402
from backend.services import supabase_rest  # noqa: E402
from backend.services.twilio_sms import SmsMessage  # noqa: E402

API = "/api/v1"
STAFF = {"Authorization": "Bearer staff"}
CODE = "PHC-FSPESYMNAX"


@pytest.fixture()
def env(monkeypatch):
    state = {
        "card": {"customerRef": "PH00001", "name": "Jordan Park", "firstName": "Jordan", "phone": "4165550101",
                 "qrCode": CODE},
        "sent": [],
        "opted_out": False,
        "status": "sent",
    }

    def fake_rpc_as(token, function, args):
        if not token:
            raise supabase_rest.RpcRefused(401, "Sign in with a pro shop account.")
        assert function == "pelham_staff_customer_qr"
        assert args == {"p_ref": "PH00001"}
        return state["card"]

    async def fake_send(to, body, template=None, booking_ref=None, media_url=None):
        state["sent"].append({"to": to, "body": body, "media_url": media_url})
        return SmsMessage(direction="out", to_e164=to, from_e164="+10000000000", body=body, status=state["status"])

    monkeypatch.setattr(supabase_rest, "rpc_as", fake_rpc_as)
    monkeypatch.setattr(customer_qr, "send_sms", fake_send)
    monkeypatch.setattr(customer_qr, "is_opted_out", lambda phone: state["opted_out"])
    monkeypatch.setenv("PUBLIC_API_BASE_URL", "https://pelhamhills-api.fly.dev/api/v1")
    app = FastAPI()
    app.include_router(customer_qr.router, prefix=API)
    return TestClient(app), state


def test_texts_qr_with_picture(env):
    client, state = env
    response = client.post(f"{API}/pos/customer-qr/text", json={"customer_ref": "PH00001"}, headers=STAFF)
    assert response.status_code == 200
    assert response.json() == {"last4": "0101"}
    [sent] = state["sent"]
    assert sent["to"] == "+14165550101"
    assert "Hi Jordan" in sent["body"]
    assert f"https://golf-gps-pelhamhills-seven.vercel.app/me?c={CODE}" in sent["body"]
    assert sent["media_url"] == f"https://pelhamhills-api.fly.dev/api/v1/sms/qr/{CODE}.png"


def test_needs_staff_sign_in(env):
    client, state = env
    response = client.post(f"{API}/pos/customer-qr/text", json={"customer_ref": "PH00001"})
    assert response.status_code == 401
    assert state["sent"] == []


def test_no_phone(env):
    client, state = env
    state["card"]["phone"] = None
    response = client.post(f"{API}/pos/customer-qr/text", json={"customer_ref": "PH00001"}, headers=STAFF)
    assert response.status_code == 422
    assert state["sent"] == []


def test_opted_out_number_is_not_texted(env):
    client, state = env
    state["opted_out"] = True
    response = client.post(f"{API}/pos/customer-qr/text", json={"customer_ref": "PH00001"}, headers=STAFF)
    assert response.status_code == 409
    assert state["sent"] == []


def test_failed_send(env):
    client, state = env
    state["status"] = "failed"
    response = client.post(f"{API}/pos/customer-qr/text", json={"customer_ref": "PH00001"}, headers=STAFF)
    assert response.status_code == 502


def test_qr_image(env):
    client, _ = env
    response = client.get(f"{API}/sms/qr/{CODE}.png")
    assert response.status_code == 200
    assert response.headers["content-type"] == "image/png"
    assert response.content.startswith(b"\x89PNG")


def test_qr_image_rejects_other_codes(env):
    client, _ = env
    assert client.get(f"{API}/sms/qr/PHC-0000000000.png").status_code == 404
    assert client.get(f"{API}/sms/qr/hello.png").status_code == 404
