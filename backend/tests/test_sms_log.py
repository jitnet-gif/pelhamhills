"""문자 기록(0058)과 DB 수신 거부(0047) 테스트.

Supabase 는 `twilio_sms.supabase_rest` 를 가짜로 바꿔 흉내 낸다 — 표 두 개(문자 기록, 수신 거부)뿐이다.
"""

from __future__ import annotations

import asyncio

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from backend.api.routes import marketing, sms, terminal
from backend.services import supabase_rest, twilio_sms

API = "/api/v1"
SENDER = "+19058921234"


class FakeDb:
    def __init__(self) -> None:
        self.messages: list[dict] = []
        self.optouts: list[dict] = []
        self.down = False

    def _check(self) -> None:
        if self.down:
            raise supabase_rest.SupabaseUnavailable("down")

    def insert(self, table, row):
        self._check()
        assert table == twilio_sms.SMS_TABLE
        self.messages.append(dict(row))
        return row

    def update(self, table, params, patch):
        self._check()
        sid = params["twilio_sid"].removeprefix("eq.")
        hit = [m for m in self.messages if m.get("twilio_sid") == sid]
        for m in hit:
            m.update(patch)
        return hit

    def select(self, table, params):
        self._check()
        if table == twilio_sms.OPTOUT_TABLE:
            rows = [o for o in self.optouts if o.get("source", "reply") == "reply"]
            if "phone" in params:
                rows = [o for o in rows if o["phone"] == params["phone"].removeprefix("eq.")]
            return rows
        rows = sorted(self.messages, key=lambda m: m["created_at"], reverse=True)
        if "phone" in params:
            rows = [m for m in rows if m["phone"] == params["phone"].removeprefix("eq.")]
        return rows[: int(params.get("limit", "1000"))]


@pytest.fixture()
def db(monkeypatch):
    fake = FakeDb()
    monkeypatch.setattr(supabase_rest, "insert", fake.insert)
    monkeypatch.setattr(supabase_rest, "update", fake.update)
    monkeypatch.setattr(supabase_rest, "select", fake.select)
    monkeypatch.setattr(twilio_sms.settings, "TWILIO_AUTH_TOKEN", "")
    twilio_sms.sms_messages.clear()
    twilio_sms.opted_out.clear()
    yield fake
    twilio_sms.sms_messages.clear()
    twilio_sms.opted_out.clear()


@pytest.fixture()
def client(db, monkeypatch):
    monkeypatch.setattr(terminal, "_require_staff", lambda request: None)
    # 서명 확인은 test_sms 가 본다. 여기서는 웹훅 본문만.
    monkeypatch.setattr(sms, "validate_twilio_signature", lambda *a: True)
    monkeypatch.setattr(sms.sms_agent, "enabled", lambda: False)
    app = FastAPI()
    app.include_router(sms.router, prefix=API)
    with TestClient(app) as test_client:
        yield test_client


def test_sent_text_is_saved(db):
    msg = asyncio.run(twilio_sms.send_sms("905-892-1234", "hello", template="confirm", booking_ref="123456"))
    [row] = db.messages
    assert row["id"] == msg.id
    assert row["direction"] == "out"
    assert row["phone"] == SENDER
    assert row["template"] == "confirm"
    assert row["booking_ref"] == "123456"
    assert row["status"] == "skipped"  # 테스트에는 Twilio 키가 없다


def test_stop_in_the_db_blocks_a_text_this_machine_never_saw(db):
    db.optouts.append({"phone": "9058921234", "channel": "sms", "source": "reply"})
    msg = asyncio.run(twilio_sms.send_sms(SENDER, "reminder"))
    assert msg.status == "skipped"
    assert msg.error == "recipient opted out (STOP)"


def test_staff_marketing_optout_does_not_block_booking_texts(db):
    db.optouts.append({"phone": "9058921234", "channel": "sms", "source": "staff"})
    assert twilio_sms.is_opted_out(SENDER) is False


def test_db_start_clears_a_stale_stop_in_memory(db):
    twilio_sms.opted_out.add(SENDER)
    assert twilio_sms.is_opted_out(SENDER) is False
    assert SENDER not in twilio_sms.opted_out


def test_memory_is_used_when_the_db_is_down(db):
    db.down = True
    twilio_sms.opted_out.add(SENDER)
    assert twilio_sms.is_opted_out(SENDER) is True


def test_inbound_and_its_reply_are_saved(client, db):
    res = client.post(f"{API}/sms/inbound", data={"From": SENDER, "To": "+12895550000", "Body": "hours?",
                                                   "MessageSid": "SM1"})
    assert res.status_code == 200
    got = [(m["direction"], m["template"], m["status"]) for m in db.messages]
    assert got == [("in", None, "received"), ("out", "reply", "sent")]
    assert all(m["phone"] == SENDER for m in db.messages)


def test_stop_reply_is_recorded_before_answering(client, db, monkeypatch):
    seen = []
    monkeypatch.setattr(marketing, "record_sms_reply", lambda phone, stop: seen.append((phone, stop)))
    client.post(f"{API}/sms/inbound", data={"From": SENDER, "Body": "STOP", "MessageSid": "SM2"})
    assert seen == [(SENDER, True)]
    assert SENDER in twilio_sms.opted_out


def test_status_callback_updates_the_saved_row(client, db):
    db.messages.append({"twilio_sid": "SM9", "status": "queued", "phone": SENDER, "created_at": "x"})
    res = client.post(f"{API}/sms/status", data={"MessageSid": "SM9", "MessageStatus": "delivered"})
    assert res.status_code == 204
    assert db.messages[0]["status"] == "delivered"


def test_messages_list_reads_the_db(client, db):
    asyncio.run(twilio_sms.send_sms(SENDER, "one"))
    asyncio.run(twilio_sms.send_sms("+19055550100", "two"))
    body = client.get(f"{API}/sms/messages", params={"phone": "905-892-1234"}).json()
    assert body["source"] == "db"
    assert [m["body"] for m in body["messages"]] == ["one"]


def test_messages_list_falls_back_to_memory(client, db):
    asyncio.run(twilio_sms.send_sms(SENDER, "one"))
    db.down = True
    body = client.get(f"{API}/sms/messages").json()
    assert body["source"] == "memory"
    assert [m["body"] for m in body["messages"]] == ["one"]


def test_opt_outs_list(client, db):
    db.optouts.append({"phone": "9058921234", "channel": "sms", "source": "reply", "created_at": "2026-10-20"})
    assert client.get(f"{API}/sms/opt-outs").json()["opt_outs"] == [{"phone": SENDER, "created_at": "2026-10-20"}]


def test_staff_only(client, monkeypatch):
    def refuse(request):
        raise HTTPException(status_code=401, detail="Sign in")
    monkeypatch.setattr(terminal, "_require_staff", refuse)
    assert client.get(f"{API}/sms/messages").status_code == 401
    assert client.get(f"{API}/sms/opt-outs").status_code == 401
