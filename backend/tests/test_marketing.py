"""고객 마케팅 발송(`routes/marketing.py`).

실행: `python -m pytest backend/tests/test_marketing.py -q`

SQL 은 `terminal._as_staff`·`marketing._service` 자리의 가짜로, Twilio·ElevenLabs 는 가짜 함수로 바꾼다.
"""

from __future__ import annotations

import asyncio
import sys
from datetime import datetime
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend.api.routes import marketing, terminal  # noqa: E402
from backend.services import voice_agent  # noqa: E402
from backend.services.twilio_sms import SmsMessage  # noqa: E402

API = "/api/v1"
TZ = marketing.CLUB_TIMEZONE


def test_window_follows_crtc_hours():
    # 2026-10-20 은 화요일, 2026-10-24 는 토요일.
    assert marketing.window_open(datetime(2026, 10, 20, 9, 0, tzinfo=TZ))
    assert marketing.window_open(datetime(2026, 10, 20, 21, 29, tzinfo=TZ))
    assert not marketing.window_open(datetime(2026, 10, 20, 21, 30, tzinfo=TZ))
    assert not marketing.window_open(datetime(2026, 10, 20, 8, 59, tzinfo=TZ))
    assert not marketing.window_open(datetime(2026, 10, 24, 9, 30, tzinfo=TZ))
    assert marketing.window_open(datetime(2026, 10, 24, 10, 0, tzinfo=TZ))
    assert not marketing.window_open(datetime(2026, 10, 24, 18, 0, tzinfo=TZ))


def test_sms_body_names_sender_and_opt_out():
    assert marketing.sms_body("Twilight $34 this week.") == (
        "Pelham Hills Golf: Twilight $34 this week. Reply STOP to opt out."
    )
    assert marketing.sms_body("Pelham Hills: hi") == "Pelham Hills: hi Reply STOP to opt out."


@pytest.fixture()
def env(monkeypatch):
    monkeypatch.setattr(marketing.settings, "TWILIO_ACCOUNT_SID", "AC_test")
    monkeypatch.setattr(marketing.settings, "TWILIO_AUTH_TOKEN", "token")
    monkeypatch.setattr(marketing.settings, "TWILIO_PHONE_NUMBER", "+15550000000")
    monkeypatch.setattr(marketing, "window_open", lambda now=None: True)
    monkeypatch.setattr(marketing, "SMS_GAP_SECONDS", 0)
    monkeypatch.setattr(marketing, "_call_gap_seconds", lambda: 0)
    marketing._running.clear()

    state = {
        "campaign": {"id": 7, "channel": "sms", "name": "Fall", "message": "20% off", "status": "ready"},
        "queue": [{"id": 1, "name": "Ann Lee", "phone": "4165550001"},
                  {"id": 2, "name": "Ed Oh", "phone": "bad"}],
        "results": [], "sent": [], "calls": [], "staff": [], "finished": False,
    }

    def fake_staff(request, function, args):
        state["staff"].append(function)
        if function == "pelham_staff_marketing_access":
            return True
        return state["campaign"]

    def fake_service(function, args):
        if function == "pelham_marketing_claim":
            batch, state["queue"] = state["queue"], []
            return {"channel": state["campaign"]["channel"], "sends": batch}
        if function == "pelham_marketing_send_result":
            state["results"].append(args["p"])
        if function == "pelham_marketing_finish":
            state["finished"] = True
        return None

    async def fake_send(to, body, template=None, booking_ref=None, media_url=None):
        state["sent"].append((to, body, template, booking_ref))
        state.setdefault("media", []).append(media_url)
        return SmsMessage(direction="out", to_e164=to, from_e164="+15550000000", body=body,
                          status="queued", twilio_sid="SM123")

    async def fake_call(to, variables):
        state["calls"].append((to, variables))
        return {"success": True, "conversation_id": "conv_1"}

    monkeypatch.setattr(terminal, "_as_staff", fake_staff)
    monkeypatch.setattr(marketing, "_service", fake_service)
    monkeypatch.setattr(marketing, "send_sms", fake_send)
    monkeypatch.setattr(voice_agent, "outbound_call", fake_call)
    # 엔드포인트는 뒤에서 돌리고 바로 답한다. 테스트에서는 그 자리에서 끝까지 돌린다.
    monkeypatch.setattr(marketing, "_start", lambda campaign: state.setdefault("started", []).append(campaign["id"]))

    app = FastAPI()
    app.include_router(marketing.router, prefix=API)
    return TestClient(app), state


def test_send_runs_sms_campaign(env):
    client, state = env
    res = client.post(f"{API}/marketing/campaigns/7/send", headers={"Authorization": "Bearer t"})
    assert res.status_code == 200, res.text
    assert state["staff"] == ["pelham_marketing_campaign"]
    assert state["started"] == [7]
    # 두 번 눌러도 한 줄만.
    assert client.post(f"{API}/marketing/campaigns/7/send").json()["already_running"] is True
    asyncio.run(marketing.run_campaign(state["campaign"]))
    assert state["sent"] == [("+14165550001", "Pelham Hills Golf: 20% off Reply STOP to opt out.", "marketing", "MK-7")]
    assert state["results"] == [
        {"id": 1, "status": "sent", "provider_ref": "SM123", "error": None},
        {"id": 2, "status": "skipped", "provider_ref": None, "error": "bad phone number"},
    ]
    assert state["finished"] is True
    assert marketing._running == set()


def test_promo_campaign_attaches_the_barcode(env, monkeypatch):
    client, state = env
    monkeypatch.setenv("PUBLIC_API_BASE_URL", "https://api.example.com/api/v1")
    state["campaign"]["audience"] = {"segment": "all", "barcode": "PROMO-FALL18"}
    state["queue"] = [{"id": 1, "name": "Ann Lee", "phone": "4165550001"}]
    asyncio.run(marketing.run_campaign(state["campaign"]))
    assert state["media"] == ["https://api.example.com/api/v1/sms/barcode/PROMO-FALL18.png"]


def test_plain_campaign_has_no_barcode(env):
    _client, state = env
    state["queue"] = [{"id": 1, "name": "Ann Lee", "phone": "4165550001"}]
    asyncio.run(marketing.run_campaign(state["campaign"]))
    assert state["media"] == [None]


def test_call_campaign_uses_elevenlabs(env, monkeypatch):
    client, state = env
    state["campaign"].update(channel="call", message="$38.94 after 2 PM")
    state["queue"] = [{"id": 5, "name": "Ann Lee", "phone": "4165550001"}]
    monkeypatch.setattr(marketing, "calls_ready", lambda: True)
    res = client.post(f"{API}/marketing/campaigns/7/send", headers={"Authorization": "Bearer t"})
    assert res.status_code == 200, res.text
    asyncio.run(marketing.run_campaign(state["campaign"]))
    to, variables = state["calls"][0]
    assert to == "+14165550001"
    assert variables["customer_name"] == "Ann"
    assert variables["promo_message"] == "$38.94 after 2 PM"
    assert state["results"] == [{"id": 5, "status": "sent", "provider_ref": "conv_1", "error": None}]


def test_call_campaign_refused_without_elevenlabs(env, monkeypatch):
    client, state = env
    state["campaign"]["channel"] = "call"
    monkeypatch.setattr(marketing, "calls_ready", lambda: False)
    res = client.post(f"{API}/marketing/campaigns/7/send", headers={"Authorization": "Bearer t"})
    assert res.status_code == 503
    assert state["calls"] == []


def test_refused_outside_hours(env, monkeypatch):
    client, state = env
    monkeypatch.setattr(marketing, "window_open", lambda now=None: False)
    res = client.post(f"{API}/marketing/campaigns/7/send", headers={"Authorization": "Bearer t"})
    assert res.status_code == 409
    assert state["sent"] == []


def test_finished_campaign_not_resent(env):
    client, state = env
    state["campaign"]["status"] = "sent"
    res = client.post(f"{API}/marketing/campaigns/7/send", headers={"Authorization": "Bearer t"})
    assert res.status_code == 409


def test_window_closing_mid_run_requeues_the_rest(env, monkeypatch):
    _, state = env
    state["queue"] = [{"id": 1, "name": "A", "phone": "4165550001"}, {"id": 2, "name": "B", "phone": "4165550002"}]
    ticks = iter([True, True, False])
    monkeypatch.setattr(marketing, "window_open", lambda now=None: next(ticks, False))
    asyncio.run(marketing.run_campaign(state["campaign"]))
    assert [r["status"] for r in state["results"]] == ["sent", "queued"]
    assert state["finished"] is False


def test_status_requires_marketing_account(env, monkeypatch):
    client, _ = env
    monkeypatch.setattr(terminal, "_as_staff", lambda request, function, args: False)
    res = client.get(f"{API}/marketing/status", headers={"Authorization": "Bearer t"})
    assert res.status_code == 403


def test_voice_opt_out_records_both_channels(env, monkeypatch):
    client, _ = env
    monkeypatch.delenv("VOICE_TOOL_SECRET", raising=False)
    recorded = []
    monkeypatch.setattr(marketing, "_service", lambda function, args: recorded.append((function, args)))
    res = client.post(f"{API}/marketing/voice/opt-out", json={"caller_phone": "416-555-0001"})
    assert res.json()["ok"] is True
    assert [args["p_channel"] for _, args in recorded] == ["call", "sms"]


# ===== 날씨 알림(0118) =====================================================

def test_alert_window_is_every_day_6_to_22():
    assert marketing.alert_window_open(datetime(2026, 10, 24, 6, 0, tzinfo=TZ))  # 토요일 이른 아침
    assert not marketing.alert_window_open(datetime(2026, 10, 24, 5, 59, tzinfo=TZ))
    assert marketing.alert_window_open(datetime(2026, 10, 20, 21, 59, tzinfo=TZ))
    assert not marketing.alert_window_open(datetime(2026, 10, 20, 22, 0, tzinfo=TZ))


def test_alert_body_fills_name_and_time_without_opt_out_line():
    msg = "Hi {name}, frost delay: your {time} tee time moves back 30 minutes."
    assert marketing.alert_body(msg, "Ann Lee", "7:10 AM") == (
        "Pelham Hills Golf: Hi Ann, frost delay: your 7:10 AM tee time moves back 30 minutes."
    )
    assert marketing.alert_body(msg, "Guest", None) == (
        "Pelham Hills Golf: Hi there, frost delay: your tee time moves back 30 minutes."
    )


def _weather(state, day="2026-10-25"):
    state["campaign"]["audience"] = {"kind": "weather", "channel": "sms", "date": day}
    state["campaign"]["message"] = "Hi {name}, rain: the course is closed. Your {time} tee time is cancelled."


def test_weather_alert_sends_personal_text(env, monkeypatch):
    client, state = env
    _weather(state, datetime.now(TZ).date().isoformat())
    state["queue"] = [{"id": 1, "name": "Ann Lee", "phone": "4165550001", "tee_time": "9:20 AM"}]
    # 프로모션 시각이 닫혀 있어도 날씨 알림 시각이 열려 있으면 나간다.
    monkeypatch.setattr(marketing, "window_open", lambda now=None: False)
    monkeypatch.setattr(marketing, "alert_window_open", lambda now=None: True)
    res = client.post(f"{API}/marketing/campaigns/7/send", headers={"Authorization": "Bearer t"})
    assert res.status_code == 200, res.text
    asyncio.run(marketing.run_campaign(state["campaign"]))
    assert state["sent"] == [(
        "+14165550001",
        "Pelham Hills Golf: Hi Ann, rain: the course is closed. Your 9:20 AM tee time is cancelled.",
        "weather_alert",
        "MK-7",
    )]
    assert state["finished"] is True


def test_weather_alert_for_a_past_day_is_refused(env, monkeypatch):
    client, state = env
    _weather(state, "2026-01-02")
    monkeypatch.setattr(marketing, "alert_window_open", lambda now=None: True)
    res = client.post(f"{API}/marketing/campaigns/7/send", headers={"Authorization": "Bearer t"})
    assert res.status_code == 409
    assert "passed" in res.json()["detail"]


def test_weather_alert_refused_outside_alert_hours(env, monkeypatch):
    client, state = env
    _weather(state, datetime.now(TZ).date().isoformat())
    monkeypatch.setattr(marketing, "alert_window_open", lambda now=None: False)
    res = client.post(f"{API}/marketing/campaigns/7/send", headers={"Authorization": "Bearer t"})
    assert res.status_code == 409


def test_sms_campaign_cost_sums_twilio_prices(env, monkeypatch):
    client, state = env
    state["campaign"].update(status="sent", started_at="2026-10-28T14:00:00+00:00",
                             finished_at="2026-10-28T14:05:00+00:00",
                             sends=[{"id": 1, "provider_ref": "SM1"}, {"id": 2, "provider_ref": "SM2"},
                                    {"id": 3, "provider_ref": None}])
    seen = {}

    async def fake_prices(sids, since, until):
        seen.update(sids=list(sids), since=since.isoformat(), until=until.isoformat())
        return {"SM1": {"price": 0.0083, "unit": "USD", "segments": 1}}

    from backend.services import service_usage
    monkeypatch.setattr(service_usage, "twilio_message_prices", fake_prices)
    res = client.get(f"{API}/marketing/campaigns/7/cost", headers={"Authorization": "Bearer t"})
    assert res.status_code == 200, res.text
    assert res.json() == {"channel": "sms", "unit": "USD", "total": 0.0083, "priced": 1, "pending": 1, "segments": 1}
    assert seen == {"sids": ["SM1", "SM2"], "since": "2026-10-28", "until": "2026-10-28"}


def test_call_campaign_cost_is_elevenlabs_credits(env, monkeypatch):
    client, state = env
    state["campaign"].update(channel="call", sends=[{"id": 1, "provider_ref": "conv_1"}])

    async def fake_costs(ids):
        return {"conv_1": 812.0}

    from backend.services import service_usage
    monkeypatch.setattr(service_usage, "call_costs", fake_costs)
    res = client.get(f"{API}/marketing/campaigns/7/cost")
    assert res.json() == {"channel": "call", "unit": "credits", "total": 812.0, "priced": 1, "pending": 0,
                          "segments": None}
