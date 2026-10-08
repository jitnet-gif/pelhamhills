"""전화·문자 비서의 실내 골프(시뮬레이터) 도구 테스트.

실행: `cd E:\\PELHAMHILLS && python -m pytest backend/tests/test_voice_sim.py -q`

Supabase 는 부르지 않는다. 0016 의 SQL 함수 네 개를 흉내 내는 가짜를 `supabase_rest.rpc`
자리에 끼운다. 여기서 확인하는 것은 SQL 의 규칙(겹침·마감)이 아니라 **파이썬 쪽이 지키는 선**이다:
번호는 발신번호, 시각 변환, 조회한 예약만 취소, 문자 취소는 번호와 코드 둘 다, 거절 문장 전달.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any

import pytest

from backend.api.routes import sms, voice, voice_sim
from backend.services import sms_agent, supabase_rest, twilio_sms
from backend.tests.test_voice_booking import API, client  # noqa: F401

SAT = "2026-09-12"  # FIXED_NOW(화 2026-09-08) 기준 예약 창 안의 토요일
CALLER = "+19058921234"


class FakeSim:
    """0016 함수의 꼴만 흉내 낸다. 호출을 기록해 인자를 검사한다."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.rows: dict[int, dict[str, Any]] = {}
        self.refuse: dict[str, supabase_rest.RpcRefused | Exception] = {}
        self.next_id = 41

    def row(self, **over: Any) -> dict[str, Any]:
        self.next_id += 1
        row = {
            "id": self.next_id, "confirmation_code": f"AB12CD34E{self.next_id % 10}", "bay_number": 1,
            "date": SAT, "start_time": "18:30", "duration_hours": 2, "player_count": 3,
            "customer_name": "Ana Nakamura", "phone": "905-892-1234", "total_price": 40.0,
            "status": "confirmed", "cancellable": True, "reason": None,
        }
        row.update(over)
        self.rows[row["id"]] = row
        return row

    def __call__(self, function: str, args: dict[str, Any]) -> Any:
        self.calls.append((function, args))
        if function in self.refuse:
            raise self.refuse[function]
        if function == "pelham_sim_phone_availability":
            return {"date": args["p_date"], "is_closed": False, "hourly_rate": 20, "total_bays": 3,
                    "slots": [{"time": t, "free_bays": 2} for t in ("14:00", "15:00", "17:45", "18:30", "19:00")],
                    "reason": None}
        if function == "pelham_sim_phone_reserve":
            p = args["p"]
            return self.row(date=p["date"], start_time=p["start_time"], duration_hours=p["duration_hours"],
                            player_count=p["player_count"], customer_name=p["customer_name"], phone=p["phone"],
                            total_price=20.0 * p["duration_hours"])
        if function == "pelham_sim_phone_find":
            key = voice.normalize_phone(args["p_phone"])
            return [r for r in self.rows.values()
                    if voice.normalize_phone(r["phone"]) == key and r["status"] != "cancelled"
                    and (args["p_last_name"] is None or r["customer_name"].split()[-1].lower() == args["p_last_name"].lower())
                    and (args["p_code"] is None or r["confirmation_code"] == args["p_code"])]
        if function == "pelham_sim_phone_cancel":
            r = self.rows[args["p_id"]]
            if args["p_preview"]:
                return {**r, "cancelled": False, "already": False}
            r["status"] = "cancelled"
            return {**r, "cancelled": True, "already": False}
        raise AssertionError(function)


@pytest.fixture()
def sim(client, monkeypatch):  # noqa: F811
    fake = FakeSim()
    monkeypatch.setattr(supabase_rest, "rpc", fake)
    monkeypatch.setattr(twilio_sms.settings, "TWILIO_AUTH_TOKEN", "")
    twilio_sms.sms_messages.clear()
    client.app.include_router(voice_sim.router, prefix=API)
    yield fake
    twilio_sms.sms_messages.clear()


def post(client, tool: str, **body):  # noqa: F811
    body.setdefault("conversation_id", "c-sim")
    return client.post(f"{API}/voice/tools/{tool}", json=body)


def texts(template: str) -> list[str]:
    return [m.body for m in twilio_sms.sms_messages if m.template == template]


# ===== 시각 ============================================================

@pytest.mark.parametrize("spoken,expected", [
    ("3:00 PM", "15:00"), ("3 pm", "15:00"), ("6:30PM", "18:30"), ("15:45", "15:45"),
    ("7:30", "19:30"),  # 오전/오후 없이: 영업이 오후뿐이라 저녁으로
    ("12:00 PM", "12:00"),
])
def test_spoken_times_become_24_hour(spoken, expected):
    assert voice_sim.to_hhmm(spoken) == expected
    assert voice_sim.to_label(expected).endswith(("AM", "PM"))


# ===== 찾기 ============================================================

def test_find_reads_times_like_tee_times_and_quotes_the_bay_price_with_tax(client, sim):
    res = post(client, "find-sim-times", date=SAT, duration_hours=2, earliest="5:30 PM")

    assert res.status_code == 200, res.text
    data = res.json()
    assert [o["time"] for o in data["options"]] == ["5:45 PM", "6:30 PM", "7:00 PM"]
    assert data["price"] == 40.0 and data["price_with_tax"] == 45.2
    assert "plus HST" in data["message"]
    assert sim.calls[0] == ("pelham_sim_phone_availability", {"p_date": SAT, "p_duration_hours": 2})


def test_find_refuses_dates_past_the_booking_window(client, sim):
    res = post(client, "find-sim-times", date="2026-12-01", duration_hours=1)
    assert res.status_code == 422
    assert sim.calls == []


# ===== 예약 ============================================================

def test_booking_uses_the_caller_id_and_texts_the_code(client, sim):
    res = post(client, "book-sim-bay", date=SAT, time="6:30 PM", duration_hours=2, players=3,
               first_name="Ana", last_name="Nakamura", caller_number=CALLER)

    assert res.status_code == 200, res.text
    booking = res.json()["booking"]
    _, args = sim.calls[-1]
    assert args["p"] == {"date": SAT, "start_time": "18:30", "duration_hours": 2, "player_count": 3,
                         "customer_name": "Ana Nakamura", "phone": CALLER, "via": "phone"}
    sent = texts("confirm")
    assert len(sent) == 1 and booking["confirmation_code"] in sent[0]
    assert f"reply C {booking['confirmation_code']}" in sent[0]
    assert "phone" not in booking  # 번호는 비서에게 돌려주지 않는다


def test_booking_without_a_usable_number_is_refused(client, sim):
    res = post(client, "book-sim-bay", date=SAT, time="6:30 PM", first_name="Ana", last_name="Nakamura",
               phone="caller_number", caller_number="")
    assert res.status_code == 422
    assert not any(f == "pelham_sim_phone_reserve" for f, _ in sim.calls)


def test_a_taken_slot_comes_back_as_409_with_the_sql_sentence(client, sim):
    sim.refuse["pelham_sim_phone_reserve"] = supabase_rest.RpcRefused(409, "Every bay is booked for that time.")
    res = post(client, "book-sim-bay", date=SAT, time="6:30 PM", first_name="Ana", last_name="Nakamura",
               caller_number=CALLER)
    assert res.status_code == 409
    assert res.json()["detail"] == "Every bay is booked for that time."
    assert texts("confirm") == []


def test_supabase_down_is_a_503_that_says_transfer(client, sim):
    sim.refuse["pelham_sim_phone_availability"] = supabase_rest.SupabaseUnavailable("down")
    res = post(client, "find-sim-times", date=SAT, duration_hours=1)
    assert res.status_code == 503
    assert "pro shop" in res.json()["detail"]


# ===== 조회 · 취소 =====================================================

def test_cancel_without_lookup_on_this_call_is_refused(client, sim):
    row = sim.row()
    res = post(client, "cancel-sim-booking", reservation_id=str(row["id"]), last_name="Nakamura")
    assert res.status_code == 403
    assert sim.rows[row["id"]]["status"] == "confirmed"


def test_lookup_then_preview_then_cancel(client, sim):
    row = sim.row()

    found = post(client, "lookup-sim-booking", phone="(905) 892-1234", last_name="nakamura").json()
    assert found["found"] == 1
    rid = found["bookings"][0]["reservation_id"]

    preview = post(client, "cancel-sim-booking", reservation_id=rid, last_name="Nakamura", preview=True)
    assert preview.json()["cancelled"] is False
    assert sim.rows[row["id"]]["status"] == "confirmed"

    done = post(client, "cancel-sim-booking", reservation_id=rid, last_name="Nakamura")
    assert done.json()["cancelled"] is True
    assert sim.rows[row["id"]]["status"] == "cancelled"
    _, args = sim.calls[-1]
    assert args == {"p_id": row["id"], "p_phone": None, "p_last_name": "Nakamura", "p_preview": False, "p_via": "phone"}
    assert len(texts("cancel")) == 1


def test_lookup_in_one_call_does_not_unlock_another_call(client, sim):
    row = sim.row()
    post(client, "lookup-sim-booking", phone="9058921234", last_name="Nakamura", conversation_id="c-one")
    res = post(client, "cancel-sim-booking", reservation_id=str(row["id"]), last_name="Nakamura",
               conversation_id="c-two")
    assert res.status_code == 403


def test_tee_lookup_does_not_unlock_a_sim_booking_with_the_same_id(client, sim):
    row = sim.row()
    session = voice._touch_session("c-sim")
    session.revealed.add(str(row["id"]))  # 티타임 쪽 id 가 우연히 같아도
    res = post(client, "cancel-sim-booking", reservation_id=str(row["id"]), last_name="Nakamura")
    assert res.status_code == 403


def test_too_late_to_cancel_says_transfer(client, sim):
    row = sim.row()
    post(client, "lookup-sim-booking", phone="9058921234", last_name="Nakamura")
    sim.refuse["pelham_sim_phone_cancel"] = supabase_rest.RpcRefused(
        409, "This booking can't be cancelled by phone or text because it starts in less than 24 hours.")
    res = post(client, "cancel-sim-booking", reservation_id=str(row["id"]), last_name="Nakamura")
    assert res.status_code == 409
    assert "less than 24 hours" in res.json()["detail"] and "pro shop" in res.json()["detail"]


# ===== 문자 "C <코드>" =================================================

def test_text_reply_with_a_sim_code_cancels_with_number_and_code(client, sim):
    row = sim.row()
    reply = voice_sim.cancel_by_code(CALLER, row["confirmation_code"])
    assert "cancelled your simulator bay" in reply
    assert sim.rows[row["id"]]["status"] == "cancelled"
    find_args = next(a for f, a in sim.calls if f == "pelham_sim_phone_find")
    assert find_args == {"p_phone": CALLER, "p_last_name": None, "p_code": row["confirmation_code"]}
    _, cancel_args = sim.calls[-1]
    assert cancel_args["p_phone"] == CALLER and cancel_args["p_via"] == "text"


def test_text_reply_from_another_number_does_not_cancel(client, sim):
    row = sim.row()
    reply = voice_sim.cancel_by_code("+12895550000", row["confirmation_code"])
    assert "no upcoming booking" in reply
    assert sim.rows[row["id"]]["status"] == "confirmed"


def test_inbound_routes_ten_character_codes_to_the_simulator(client, sim, monkeypatch):
    row = sim.row()

    async def params(_request):
        return {"From": CALLER, "To": "+12495550000", "Body": f"c {row['confirmation_code'].lower()}",
                "MessageSid": "SM1"}

    monkeypatch.setattr(sms, "_twilio_params", params)
    client.app.include_router(sms.router, prefix=API)
    res = client.post(f"{API}/sms/inbound", data={})
    assert res.status_code == 200
    assert "simulator bay" in res.text
    assert sim.rows[row["id"]]["status"] == "cancelled"


# ===== 문자 비서 =======================================================

def _scripted(monkeypatch, *responses):
    queue = list(responses)

    async def create(**_kwargs):
        return queue.pop(0)

    monkeypatch.setattr(sms_agent, "_client", SimpleNamespace(beta=SimpleNamespace(messages=SimpleNamespace(create=create))))


def _tool(name, **args):
    return SimpleNamespace(stop_reason="tool_use",
                           content=[SimpleNamespace(type="tool_use", id=f"tu_{name}", name=name, input=args)])


def _says(text):
    return SimpleNamespace(stop_reason="end_turn", content=[SimpleNamespace(type="text", text=text)])


def test_text_assistant_books_a_bay_to_the_sender(client, sim, monkeypatch):
    sms_agent.reset()
    _scripted(monkeypatch,
              _tool("book_sim_bay", date=SAT, time="6:30 PM", duration_hours=2, players=2,
                    first_name="Ana", last_name="Nakamura"),
              _says("Booked."))
    asyncio.run(sms_agent.handle_text(CALLER, "simulator sat 6:30 2h, Ana Nakamura"))

    _, args = next(c for c in sim.calls if c[0] == "pelham_sim_phone_reserve")
    assert args["p"]["phone"] == CALLER and args["p"]["via"] == "text"
    assert len(texts("confirm")) == 1
    sms_agent.reset()


def test_text_bookings_share_one_daily_cap(client, sim, monkeypatch):
    sms_agent.reset()
    sms_agent._daily[f"{voice.today_iso()}|{CALLER}|booked"] = sms_agent.MAX_BOOKINGS_PER_SENDER_PER_DAY
    content, is_error = asyncio.run(sms_agent._run_tool(
        CALLER, "sms:x", "book_sim_bay",
        {"date": SAT, "time": "6:30 PM", "duration_hours": 1, "players": 1, "first_name": "A", "last_name": "B"}))
    assert is_error and "bookings by text" in content
    assert not any(f == "pelham_sim_phone_reserve" for f, _ in sim.calls)
    sms_agent.reset()


def test_sms_tool_list_matches_handlers():
    assert {t["name"] for t in sms_agent.TOOLS} == set(sms_agent._HANDLERS)
