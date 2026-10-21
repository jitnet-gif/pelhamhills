"""음성 예약 도구 계층 통합 테스트.

실행: `cd E:\\PELHAMHILLS && python -m pytest backend/tests/test_voice_booking.py -q`

시간을 고정하는 이유: 이 도구들은 "지나간 티타임은 팔지 않는다", "티오프 2시간 전
이후에는 취소하지 않는다" 처럼 **지금 몇 시인가** 에 따라 답이 달라진다. 실제 시계로
돌리면 밤에 실행할 때와 아침에 실행할 때 결과가 달라진다. 그래서 `club_now` 를
시드 날짜(2026-09-08) 아침 6시로 고정한다 — 그날 슬롯(6:40~18:00)이 전부 미래다.
"""

from __future__ import annotations

import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend.api.routes import tee_sheet as ts  # noqa: E402
from backend.api.routes import voice  # noqa: E402
from backend.services import tee_sheet_store as store  # noqa: E402

API = "/api/v1"

def tool_status(response):
    """도구는 거절도 200 + {ok: false, status, message} 로 돌려준다(voice.ToolRoute). 그 status, 아니면 HTTP 코드."""
    if response.status_code == 200:
        body = response.json()
        if isinstance(body, dict) and body.get("ok") is False and "status" in body:
            return body["status"]
    return response.status_code


TODAY = "2026-09-08"      # 시드 데이터가 들어 있는 화요일
TOMORROW = "2026-09-09"   # 예약이 하나도 없는 날
FIXED_NOW = datetime(2026, 9, 8, 6, 0, tzinfo=voice.CLUB_TIMEZONE)


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv(store.ENV_VAR, str(tmp_path / "tee_sheet.json"))
    monkeypatch.setenv("VOICE_TOOL_SECRET", "")
    # 개발 머신의 셸에 agent id 가 export 돼 있어도 테스트 결과가 흔들리지 않게 한다.
    monkeypatch.setenv("ELEVENLABS_AGENT_ID", "")
    monkeypatch.setattr(voice, "club_now", lambda: FIXED_NOW)

    store._cache = None
    store._cache_path = None
    with voice._sessions_lock:
        voice._sessions.clear()
    with voice._session_rate_lock:
        voice._session_hits.clear()

    app = FastAPI()
    app.include_router(voice.router, prefix=API)
    app.include_router(ts.router, prefix=API)
    with TestClient(app) as test_client:
        yield test_client

    store._cache = None
    store._cache_path = None


@pytest.fixture()
def nine_by_phone(monkeypatch):
    """전화 9홀은 지금 꺼져 있다(PHONE_NINE_HOLES). 9홀 시각 검사를 시험하는 테스트는 켜고 돈다."""
    monkeypatch.setattr(voice, "PHONE_NINE_HOLES", True)


# ===== 헬퍼 ============================================================

def find(client, date=TOMORROW, party=2, day_part="any", conversation="c-test"):
    return client.post(
        f"{API}/voice/tools/find-tee-times",
        json={"date": date, "party_size": party, "day_part": day_part,
              "conversation_id": conversation},
    )


def hold(client, date=TOMORROW, time="8:01 AM", party=2, conversation="c-test"):
    return client.post(
        f"{API}/voice/tools/hold-tee-time",
        json={"date": date, "time": time, "party_size": party,
              "conversation_id": conversation},
    )


def confirm(client, hold_id, last="Nakamura", phone="905-892-1234", conversation="c-test"):
    return client.post(
        f"{API}/voice/tools/confirm-booking",
        json={"hold_id": hold_id, "first_name": "Jin", "last_name": last,
              "phone": phone, "conversation_id": conversation},
    )


def open_count(client, date=TOMORROW, party=4):
    """그 인원이 실제로 살 수 있는 티타임 개수.

    `options` 로 자리 반납을 검증하면 안 된다 — 그 목록은 `_spread` 가 하루치에서
    다섯 개만 균등 추출한 것이라, 자리가 돌아와도 표본에 안 뽑힐 수 있다.
    총 개수가 우리가 실제로 확인하려는 값이다.
    """
    return find(client, date=date, party=party).json()["total_open"]


def book(client, **kwargs):
    """찾기 → 잡기 → 확정 전체를 한 번에. 확정된 예약 요약을 돌려준다."""
    conversation = kwargs.pop("conversation", "c-test")
    held = hold(client, conversation=conversation, **kwargs)
    assert held.status_code == 200, held.text
    done = confirm(client, held.json()["hold_id"], conversation=conversation)
    assert done.status_code == 200, done.text
    return done.json()["booking"]


# ===== 빈 시간 찾기 ====================================================

def test_find_returns_open_times_with_a_spoken_message(client):
    body = find(client).json()

    assert body["ok"] is True
    assert body["date"] == TOMORROW
    assert body["spoken_date"] == "Wednesday, September 9"
    assert 0 < len(body["options"]) <= voice.MAX_OPTIONS
    assert all(option["seats_open"] >= 2 for option in body["options"])
    # 에이전트는 이 문장을 그대로 읽는다. 요금이 빠지면 손님이 가격을 못 듣는다.
    assert "$" in body["message"]


def test_find_hides_tee_times_that_already_passed_today(client):
    """오늘 06:00 기준. 6:40 은 아직 살 수 있고, 그 이전 시각은 애초에 없다."""
    times = [option["time"] for option in find(client, date=TODAY, party=1).json()["options"]]
    assert times, "오늘도 살 수 있는 시간이 있어야 한다"

    for label in times:
        assert ts.label_to_minutes(label) > 6 * 60, f"{label} 은 이미 지난 시각이다"


def test_sun_times_match_the_tee_sheet_header():
    """DateNav·SQL `pelham_tee_sun` 과 같은 값. 2026-10-20 Welland: 7:35 AM / 6:28 PM."""
    assert ts.sun_minutes("2026-10-20") == (7 * 60 + 35, 18 * 60 + 28)


def test_the_first_tee_is_at_sunrise_and_the_last_two_hours_before_sunset():
    """일출 7:35 에 칸이 하나 더 생기고(격자 7:34·7:43 사이), 일몰 6:28 PM 의 2시간 전 4:28 PM 까지만 판다."""
    times = [slot.minutes for slot in ts.daylight_slots("2026-10-20")]
    assert times[0] == 7 * 60 + 35
    assert times[1] == 7 * 60 + 43  # 나머지 격자는 그대로
    assert times[-1] <= 16 * 60 + 28
    assert 7 * 60 + 35 in [slot.minutes for slot in ts.generate_slots("2026-10-20")]
    assert ts.require_slot("2026-10-20", "7:35 AM").minutes == 7 * 60 + 35


def test_staff_block_and_release_override_the_sun(monkeypatch):
    """블록한 칸은 해가 있어도 닫히고, 릴리스한 칸은 해 뜨기 전이어도 열린다."""
    monkeypatch.setattr(ts, "slot_locks", lambda iso: {9 * 60 + 4: True, 7 * 60 + 25: False})
    times = [slot.minutes for slot in ts.daylight_slots("2026-10-20")]
    assert 9 * 60 + 4 not in times
    assert 7 * 60 + 25 in times
    assert ts.slot_lock_reason("2026-10-20", 9 * 60 + 4) == "that tee time is closed"


def test_find_offers_nothing_before_sunrise(client):
    """9월 9일 일출은 6:49 — 격자 첫 칸 6:40 은 팔지 않고, 6:49 에 첫 티가 있다."""
    sunrise, _ = ts.sun_minutes(TOMORROW)
    assert sunrise > 6 * 60 + 40
    # 전부 잡지 않은 날이라 `total_open` 은 열린 칸 수 그대로다.
    assert open_count(client, party=1) == len(ts.daylight_slots(TOMORROW))
    assert ts.daylight_slots(TOMORROW)[0].minutes == sunrise


def test_a_hold_before_sunrise_is_refused(client):
    response = hold(client, time="6:40 AM")
    assert tool_status(response) == 409
    assert "before sunrise" in response.json()["message"]


def test_a_hold_too_close_to_sunset_is_refused(client):
    """9월 9일 일몰 7:41 PM → 마지막 티 5:41 PM. 6:04 PM 은 격자 위지만 팔지 않는다."""
    response = hold(client, time="6:04 PM")
    assert tool_status(response) == 409
    assert "too close to sunset" in response.json()["message"]


def test_find_respects_the_booking_window(client):
    far = (FIXED_NOW.date() + timedelta(days=voice.BOOKING_WINDOW_DAYS + 1)).isoformat()
    response = find(client, date=far)

    assert tool_status(response) == 422
    assert "14 days out" in response.json()["message"]


def test_find_rejects_natural_language_dates(client):
    """"next Tuesday" 를 서버가 추측하면 손님이 엉뚱한 날에 온다. 되물어야 한다."""
    response = find(client, date="next Tuesday")

    assert tool_status(response) == 422
    assert TODAY in response.json()["message"]


def test_find_accepts_today_and_tomorrow(client):
    assert find(client, date="tomorrow").json()["date"] == TOMORROW
    assert find(client, date="today").json()["date"] == TODAY


def test_a_full_tee_time_is_not_sold_again(client):
    """7:16 AM 은 시드에서 이미 4명이 다 찼다."""
    response = hold(client, date=TODAY, time="7:16 AM", party=1)
    assert tool_status(response) == 409
    assert "4 are already taken" in response.json()["message"]


# ===== 홀드 ============================================================

def test_a_hold_takes_the_seats_off_the_sheet(client):
    before = open_count(client)

    assert hold(client, time="8:01 AM", party=4).status_code == 200

    assert open_count(client) == before - 1, "홀드한 자리가 아직도 팔리고 있다"


def test_a_hold_blocks_the_website_too(client):
    """웹 손님과 전화 손님이 같은 자리를 사면 안 된다 — 정원 검사는 한 곳뿐이다."""
    held = hold(client, time="8:01 AM", party=4)
    assert held.status_code == 200

    # 직원 시트는 4자리 위로 4명을 더 넣을 수 있다. 홀드 4명이 세어지면 5명은 넘친다.
    web = client.post(
        f"{API}/tee-sheet/bookings",
        json={"date": TOMORROW, "time": "8:01 AM", "title": "Web, Walk-in",
              "players": [{"name": f"Web Walkin{i}"} for i in range(5)]},
    )
    assert tool_status(web) == 409


def test_an_expired_hold_gives_the_seats_back_immediately(client, monkeypatch):
    """정리 패스를 기다리지 않는다. 만료된 순간 정원 계산에서 빠져야 한다."""
    monkeypatch.setattr(ts, "HOLD_TTL_SECONDS", -1)  # 만들자마자 만료

    before = open_count(client)
    assert hold(client, time="8:01 AM", party=4).status_code == 200

    assert open_count(client) == before, "만료된 홀드가 아직 자리를 붙들고 있다"


def test_holding_more_than_the_tee_time_holds_fails(client):
    assert hold(client, time="8:01 AM", party=3).status_code == 200

    second = hold(client, time="8:01 AM", party=3)
    assert tool_status(second) == 409
    assert "4 players" in second.json()["message"]


def test_release_hold_puts_the_seats_back(client):
    before = open_count(client)
    held = hold(client, time="8:01 AM", party=4).json()
    assert open_count(client) == before - 1

    released = client.post(
        f"{API}/voice/tools/release-hold",
        json={"hold_id": held["hold_id"], "conversation_id": "c-test"},
    )
    assert released.json()["released"] is True
    assert open_count(client) == before


def test_a_hold_cannot_be_placed_on_a_time_that_passed(client):
    """오늘 06:00 기준으로 6:40 이전 슬롯은 없지만, 어제 날짜는 아예 막힌다."""
    response = hold(client, date="2026-09-07", time="8:01 AM")
    assert tool_status(response) == 422
    assert "in the past" in response.json()["message"]


# ===== 확정 ============================================================

def test_confirm_turns_a_hold_into_a_real_reservation(client):
    booking = book(client, time="8:01 AM", party=2)

    assert booking["status"] == "reserved"
    assert booking["party_size"] == 2
    assert booking["name"] == "Jin Nakamura"
    assert len(booking["confirmation_code"]) == 6

    stored = client.get(f"{API}/tee-sheet/bookings/{booking['booking_id']}").json()
    assert stored["source"] == "voice"
    assert stored["holdExpiresAt"] is None
    assert stored["title"] == "Nakamura, Jin"
    # 이름을 아는 사람은 전화한 손님 하나. 나머지 자리는 프로 샵이 체크인 때 채운다.
    assert stored["players"][0]["phone"] == "905-892-1234"
    assert stored["players"][1]["name"] == "Guest"


def _confirm_with(client, party, **extra):
    held = hold(client, time="8:01 AM", party=party).json()
    return client.post(
        f"{API}/voice/tools/confirm-booking",
        json={"hold_id": held["hold_id"], "first_name": "Jin", "last_name": "Nakamura",
              "phone": "905-892-1234", "conversation_id": "c-test", **extra},
    )


def test_confirm_puts_the_cart_on_the_riders_bill(client):
    """2026-10-06: 전화 예약에는 카트가 적히지 않아 계산서에서 카트 요금이 빠졌다.
    계산서는 사람마다 `cart`/`cartFee` 를 읽는다. 대수는 한 대에 두 명(올림)."""
    done = _confirm_with(client, party=3, riders=2)
    assert done.status_code == 200, done.text

    stored = client.get(f"{API}/tee-sheet/bookings/{done.json()['booking']['booking_id']}").json()
    assert [p["cart"] for p in stored["players"]] == [True, True, False]
    assert [p["cartFee"] for p in stored["players"]] == [ts.CART_FEE, ts.CART_FEE, 0.0]
    assert stored["cartCount"] == 1
    # 2026-10-21: 카트가 들어가도 에이전트·문자 어디에도 안 보였다. 이제 읽어 주고 문자에도 적는다.
    assert done.json()["booking"]["riders"] == 2
    assert "2 power cart seats are on the booking" in done.json()["message"]
    assert ", 2 with a power cart," in voice.confirmation_text(voice.BookingSummary(**done.json()["booking"]))


def test_confirm_without_riders_books_walkers(client):
    done = _confirm_with(client, party=2)
    stored = client.get(f"{API}/tee-sheet/bookings/{done.json()['booking']['booking_id']}").json()
    assert not any(p["cart"] for p in stored["players"])
    assert stored["cartCount"] == 0
    assert "No power cart is on this booking" in done.json()["message"]


def test_confirm_refuses_more_riders_than_players(client):
    refused = _confirm_with(client, party=2, riders=3)
    assert tool_status(refused) == 422
    assert "riders" in refused.json()["message"]


def test_a_caller_who_says_member_is_noted_not_repriced(client):
    """전화로 "회원이에요" 는 확인된 사실이 아니다. 요금제는 그대로, 메모만 남긴다."""
    done = _confirm_with(client, party=1, riders=1, member=True)
    stored = client.get(f"{API}/tee-sheet/bookings/{done.json()['booking']['booking_id']}").json()
    assert "says they are a member" in stored["notes"]
    assert stored["players"][0]["ratePlan"] == "Public"
    assert stored["players"][0]["cartFee"] == ts.CART_FEE


def test_confirming_an_expired_hold_fails_and_cleans_up(client, monkeypatch):
    held = hold(client, time="8:01 AM", party=2).json()
    monkeypatch.setattr(ts, "HOLD_TTL_SECONDS", -1)

    # 홀드를 강제로 만료시킨다 (통화가 길어져 3분을 넘긴 상황).
    with ts.bookings_tx() as bookings:
        for booking in bookings:
            if booking.id == held["hold_id"]:
                booking.holdExpiresAt = datetime.now(timezone.utc) - timedelta(seconds=1)

    response = confirm(client, held["hold_id"])
    assert tool_status(response) == 409
    assert "expired" in response.json()["message"]

    # 유령 레코드가 남으면 안 된다.
    assert all(b["id"] != held["hold_id"] for b in client.get(f"{API}/tee-sheet/bookings").json())


def test_confirm_rejects_an_unusable_phone_number(client):
    held = hold(client, time="8:01 AM", party=1).json()
    response = confirm(client, held["hold_id"], phone="not a phone")
    assert tool_status(response) == 422


# ===== 조회 ============================================================

def test_lookup_needs_both_the_phone_and_the_last_name(client):
    book(client, time="8:01 AM", party=2)

    def lookup(phone, last):
        return client.post(
            f"{API}/voice/tools/lookup-booking",
            json={"phone": phone, "last_name": last, "conversation_id": "c-lookup"},
        ).json()

    assert lookup("905-892-1234", "Nakamura")["found"] == 1
    assert lookup("905-892-1234", "Wrongname")["found"] == 0
    assert lookup("905-000-0000", "Nakamura")["found"] == 0


def test_lookup_accepts_any_way_the_caller_says_the_number(client):
    book(client, time="8:01 AM", party=1)

    for spoken in ["(905) 892 1234", "+1 905 892 1234", "9058921234"]:
        found = client.post(
            f"{API}/voice/tools/lookup-booking",
            json={"phone": spoken, "last_name": "nakamura", "conversation_id": "c-phone"},
        ).json()
        assert found["found"] == 1, spoken


def test_lookup_never_returns_a_live_hold(client):
    hold(client, time="8:01 AM", party=2)
    found = client.post(
        f"{API}/voice/tools/lookup-booking",
        json={"phone": "905-892-1234", "last_name": "Nakamura", "conversation_id": "c-h"},
    ).json()
    assert found["found"] == 0


# ===== 취소 ============================================================

def cancel(client, booking_id, last="Nakamura", conversation="c-cancel"):
    return client.post(
        f"{API}/voice/tools/cancel-booking",
        json={"booking_id": booking_id, "last_name": last, "conversation_id": conversation},
    )


def lookup_first(client, conversation, phone="905-892-1234", last="Nakamura"):
    return client.post(
        f"{API}/voice/tools/lookup-booking",
        json={"phone": phone, "last_name": last, "conversation_id": conversation},
    )


def test_cancel_needs_a_lookup_on_the_same_call(client):
    booking = book(client, time="8:01 AM", party=2, conversation="c-booked")

    # 조회를 거치지 않은 다른 통화에서는 취소할 수 없다.
    denied = cancel(client, booking["booking_id"], conversation="c-stranger")
    assert tool_status(denied) == 403
    assert "Look the reservation up first" in denied.json()["message"]

    lookup_first(client, "c-stranger")
    assert cancel(client, booking["booking_id"], conversation="c-stranger").status_code == 200


def test_cancel_without_a_conversation_is_refused(client):
    """`conversation_id` 를 빼는 것만으로 조회 게이트를 통과할 수 있으면 안 된다.

    그 값이 없으면 "이 통화에서 확인된 예약" 이라는 개념 자체가 성립하지 않는다.
    남는 검사는 성 하나뿐인데, 그건 두 열쇠 중 약한 쪽이다.
    """
    booking = book(client, time="8:01 AM", party=2, conversation="c-nogate")
    lookup_first(client, "c-nogate")

    denied = client.post(
        f"{API}/voice/tools/cancel-booking",
        json={"booking_id": booking["booking_id"], "last_name": "Nakamura"},
    )
    assert tool_status(denied) == 403
    assert "Look the reservation up first" in denied.json()["message"]


def test_cancel_rejects_a_last_name_that_does_not_match(client):
    booking = book(client, time="8:01 AM", party=2, conversation="c-a")
    lookup_first(client, "c-a")

    denied = cancel(client, booking["booking_id"], last="Somebody", conversation="c-a")
    assert tool_status(denied) == 403
    assert "does not match" in denied.json()["message"]


def test_cancel_gives_the_seats_back(client):
    before = open_count(client)
    booking = book(client, time="8:01 AM", party=4, conversation="c-b")
    assert open_count(client) == before - 1

    lookup_first(client, "c-b")
    assert cancel(client, booking["booking_id"], conversation="c-b").status_code == 200

    assert open_count(client) == before


def test_cancel_marks_the_booking_rather_than_deleting_it(client):
    """잘못 취소돼도 프로 샵이 티 시트에서 되돌릴 수 있어야 한다."""
    booking = book(client, time="8:01 AM", party=2, conversation="c-c")
    lookup_first(client, "c-c")
    cancel(client, booking["booking_id"], conversation="c-c")

    stored = client.get(f"{API}/tee-sheet/bookings/{booking['booking_id']}").json()
    assert stored["status"] == "cancelled"
    assert "phone assistant" in stored["cancelReason"]
    assert any("phone assistant" in entry["message"].lower() for entry in stored["audit"])


def test_cancel_within_two_hours_goes_to_the_pro_shop(client):
    """지금이 06:00, 티오프가 6:49 — 49분 뒤다. 사람이 판단할 구간이다."""
    booking = book(client, date=TODAY, time="6:49 AM", party=1, conversation="c-d")
    lookup_first(client, "c-d")

    denied = cancel(client, booking["booking_id"], conversation="c-d")
    assert tool_status(denied) == 409
    assert "pro shop" in denied.json()["message"]


def test_cancel_outside_the_cutoff_is_allowed(client):
    """08:10 은 지금(06:00)으로부터 130분 뒤 — 문턱을 넘었다."""
    booking = book(client, date=TODAY, time="8:19 AM", party=1, conversation="c-e")
    lookup_first(client, "c-e")

    assert cancel(client, booking["booking_id"], conversation="c-e").status_code == 200


def test_cancelling_twice_is_harmless(client):
    booking = book(client, time="8:01 AM", party=1, conversation="c-f")
    lookup_first(client, "c-f")

    assert cancel(client, booking["booking_id"], conversation="c-f").status_code == 200
    again = cancel(client, booking["booking_id"], conversation="c-f")
    assert again.status_code == 200
    assert "already cancelled" in again.json()["message"]


# ===== 인증 ============================================================

def test_the_tool_secret_is_enforced_when_it_is_set(client, monkeypatch):
    monkeypatch.setenv("VOICE_TOOL_SECRET", "shhh")

    assert tool_status(find(client)) == 401

    allowed = client.post(
        f"{API}/voice/tools/find-tee-times",
        json={"date": TOMORROW, "party_size": 2},
        headers={"X-Voice-Tool-Secret": "shhh"},
    )
    assert allowed.status_code == 200


def test_the_browser_endpoints_are_not_behind_the_tool_secret(client, monkeypatch):
    """브라우저와 ElevenLabs 웹훅은 그 시크릿을 가질 수 없다.

    `/voice/session` 을 도구와 같은 라우터에 두면, 시크릿을 켠 배포에서 웹 위젯이
    401 로 조용히 죽는다 — 손님에게는 그냥 "지금은 안 됩니다" 로만 보인다.
    post-call 웹훅도 마찬가지로 자기 서명(HMAC)을 쓰지 우리 헤더를 보내지 않는다.
    """
    monkeypatch.setenv("VOICE_TOOL_SECRET", "shhh")

    # 에이전트가 설정돼 있지 않아 503 이 맞다. 중요한 것은 **401 이 아니라는** 것.
    session = client.post(f"{API}/voice/session")
    assert tool_status(session) == 503, session.text

    webhook = client.post(f"{API}/voice/post-call", json={"data": {"conversation_id": "x"}})
    assert webhook.status_code == 200


def test_voice_sessions_are_rate_limited(client):
    """이 엔드포인트는 시크릿 없이 열려 있고, 한 번 부를 때마다 대화 크레딧을
    태울 수 있는 티켓이 나온다. 통화별 상한은 여기에 닿지 않는다."""
    for _ in range(voice.SESSION_RATE_LIMIT):
        assert tool_status(client.post(f"{API}/voice/session")) == 503

    assert tool_status(client.post(f"{API}/voice/session")) == 429


# ===== 도구 7: 발신번호로 손님 알아보기 =================================

def identify(client, number="905-892-1234", conversation="c-id"):
    return client.post(
        f"{API}/voice/tools/identify-caller",
        json={"caller_number": number, "conversation_id": conversation},
    )


def test_identify_caller_does_not_unlock_cancelling(client):
    """번호를 안다고 취소 권한이 생기면 안 된다. 발신번호는 위조할 수 있다."""
    booking = book(client, time="8:01 AM", party=2, conversation="c-booked")
    assert identify(client, conversation="c-spoof").status_code == 200
    refused = cancel(client, booking["booking_id"], conversation="c-spoof")
    assert tool_status(refused) == 403


def test_identify_caller_counts_upcoming_without_reading_them_out(client):
    """건수만 알려 준다. 시간까지 읽어 주면 번호만 아는 사람에게 일정을 알려 주는 셈이다."""
    book(client, time="8:01 AM", party=2, conversation="c-booked")
    body = identify(client).json()
    assert body["upcoming"] == 1
    assert "8:01" not in body["message"]


def test_identify_caller_without_a_number_greets_without_a_name(client):
    body = identify(client, number="").json()
    assert body["known"] is False
    assert body["greeting_name"] == ""


# ===== 도구 8: 요금 확인 ===============================================

def rates(client, date=TOMORROW, players=2, holes=18, riders=0, conversation="c-rate"):
    return client.post(
        f"{API}/voice/tools/get-rates",
        json={"date": date, "players": players, "holes": holes, "riders": riders,
              "conversation_id": conversation},
    )


def test_get_rates_uses_the_tee_sheets_own_numbers(client):
    body = rates(client).json()
    green = ts.slot_rate_for(TOMORROW)
    assert body["green_fee_per_player"] == green
    subtotal = round(green * 2, 2)
    assert body["subtotal"] == subtotal
    assert body["total"] == round(subtotal + round(subtotal * voice.TAX_RATE, 2), 2)


def test_get_rates_quotes_the_nine_hole_rate_and_when_it_starts(nine_by_phone, client):
    """9홀은 요금표마다 한 가격(DB 0045 와 같은 값). 날짜만 받으므로 몇 시부터인지도 알려 준다."""
    body = rates(client, holes=9).json()
    assert body["green_fee_per_player"] == 34.52   # 정규 시즌 평일
    assert "9 holes" in body["message"]
    assert "10:00 AM" in body["message"]


def test_nine_hole_rates_follow_the_club_rate_card():
    assert ts.green_fee_for("2026-10-20", 9) == 28.31  # 가을 숄더 화요일
    assert ts.green_fee_for("2026-10-24", 9) == 38.94  # 가을 숄더 토요일
    assert ts.green_fee_for("2026-10-12", 9) == 35.40  # 추수감사절(월) — 공휴일 요금표
    assert ts.green_fee_for("2026-09-08", 9) == 34.52  # 정규 시즌 화요일
    assert ts.green_fee_for("2026-10-20", 18) == ts.slot_rate_for("2026-10-20")
    assert ts.nine_holes_from("2026-10-20") == 10 * 60
    # 주말·공휴일 요금표는 9홀을 오후 4시부터 판다.
    assert ts.nine_holes_from("2026-10-24") == 16 * 60
    assert ts.nine_holes_from("2026-10-12") == 16 * 60
    assert "4:00 PM" in ts.nine_holes_rule("2026-10-24")


def test_confirm_refuses_nine_holes_before_the_nine_hole_start(nine_by_phone, client):
    held = hold(client, time="9:58 AM")
    refused = client.post(
        f"{API}/voice/tools/confirm-booking",
        json={"hold_id": held.json()["hold_id"], "first_name": "Jin", "last_name": "Nakamura",
              "phone": "905-892-1234", "holes": 9, "conversation_id": "c-test"},
    )
    assert tool_status(refused) == 422
    assert "10:00 AM" in refused.json()["message"]


def test_confirm_books_nine_holes_from_the_nine_hole_start(nine_by_phone, client):
    held = hold(client, time="10:07 AM")
    done = client.post(
        f"{API}/voice/tools/confirm-booking",
        json={"hold_id": held.json()["hold_id"], "first_name": "Jin", "last_name": "Nakamura",
              "phone": "905-892-1234", "holes": 9, "conversation_id": "c-test"},
    )
    assert done.status_code == 200, done.text
    assert done.json()["booking"]["holes"] == 9
    assert done.json()["booking"]["rate"] == 34.52   # 정규 시즌 평일 9홀


def find_nine(client, date=TOMORROW, party=2, day_part="any"):
    return client.post(
        f"{API}/voice/tools/find-tee-times",
        json={"date": date, "party_size": party, "day_part": day_part, "holes": 9,
              "conversation_id": "c-nine"},
    )


def test_find_nine_holes_returns_only_times_from_the_nine_hole_start(nine_by_phone, client):
    body = find_nine(client).json()
    assert body["ok"] is True
    assert all(ts.label_to_minutes(o["time"]) >= 10 * 60 for o in body["options"])
    assert all(o["rate"] == 34.52 for o in body["options"])   # 정규 시즌 평일 9홀
    assert "10:00 AM" in body["message"]


def test_find_nine_holes_in_the_morning_says_when_nine_holes_start(nine_by_phone, client):
    body = find_nine(client, day_part="morning").json()
    # 10:00~11:59 는 아침이라 남는다. 그 칸이 다 있어도 7~9시는 빠져야 한다.
    assert all(ts.label_to_minutes(o["time"]) >= 10 * 60 for o in body["options"])


def test_find_nine_holes_on_a_day_without_nine_says_no_and_names_the_next_day(nine_by_phone, client, monkeypatch):
    real = ts.nine_holes_from
    # 9/9 는 9홀 시작이 마지막 티 뒤라 9홀 칸이 없다고 가정한다(11월 주말과 같은 모양).
    monkeypatch.setattr(ts, "nine_holes_from",
                        lambda iso: 23 * 60 if iso == TOMORROW else real(iso))
    body = find_nine(client).json()
    assert body["ok"] is False
    assert body["options"] == []
    assert "Nine holes cannot be booked on" in body["message"]
    assert "11:00 PM" in body["message"]                          # 그날 9홀 시작
    assert "next day nine holes can be booked" in body["message"]
    assert "Thursday, September 10, from 10:07 AM" in body["message"]  # 9분 격자의 첫 9홀 칸


def test_find_nine_holes_when_no_day_in_the_window_has_nine(nine_by_phone, client, monkeypatch):
    monkeypatch.setattr(ts, "nine_holes_from", lambda iso: ts.NO_NINE)
    body = find_nine(client).json()
    assert body["ok"] is False
    assert "not sold that day" in body["message"]
    assert "No day in the next 14 days" in body["message"]


def test_hold_refuses_nine_holes_before_the_nine_hole_start(nine_by_phone, client):
    refused = client.post(
        f"{API}/voice/tools/hold-tee-time",
        json={"date": TOMORROW, "time": "9:58 AM", "party_size": 2, "holes": 9,
              "conversation_id": "c-test"},
    )
    assert tool_status(refused) == 422
    assert "10:00 AM" in refused.json()["message"]
    assert "eighteen holes only" in refused.json()["message"]


def test_hold_takes_nine_holes_from_the_nine_hole_start(nine_by_phone, client):
    held = client.post(
        f"{API}/voice/tools/hold-tee-time",
        json={"date": TOMORROW, "time": "10:07 AM", "party_size": 2, "holes": 9,
              "conversation_id": "c-test"},
    )
    assert held.status_code == 200 and held.json()["ok"] is True, held.text


@pytest.mark.parametrize("tool,payload", [
    ("find-tee-times", {"date": TOMORROW, "party_size": 2}),
    ("hold-tee-time", {"date": TOMORROW, "time": "10:07 AM", "party_size": 2}),
    ("get-rates", {"date": TOMORROW, "players": 2}),
    ("join-waitlist", {"date": TOMORROW, "party_size": 2, "last_name": "Nakamura"}),
])
def test_phone_takes_no_nine_holes_on_any_day(client, tool, payload):
    """2026-10-20 클럽 결정: 전화로는 주중·주말 모두 9홀을 받지 않는다. 손님에게 읽을 한 줄을 준다."""
    refused = client.post(f"{API}/voice/tools/{tool}",
                          json={**payload, "holes": 9, "conversation_id": "c-no-nine"})
    assert tool_status(refused) == 422
    message = refused.json()["message"]
    assert "Sorry, we can't book nine holes over the phone." in message
    assert "eighteen holes" in message


def test_phone_refuses_to_confirm_or_change_to_nine_holes(client):
    held = hold(client, time="10:07 AM")
    refused = client.post(
        f"{API}/voice/tools/confirm-booking",
        json={"hold_id": held.json()["hold_id"], "first_name": "Jin", "last_name": "Nakamura",
              "phone": "905-892-1234", "holes": 9, "conversation_id": "c-test"},
    )
    assert tool_status(refused) == 422
    assert "over the phone" in refused.json()["message"]
    booking = confirm(client, held.json()["hold_id"]).json()["booking"]
    changed = modify(client, booking["booking_id"], "c-test", holes=9)
    assert tool_status(changed) == 422
    assert "over the phone" in changed.json()["message"]


def test_get_rates_charges_a_cart_per_rider(client):
    walking = rates(client, riders=0).json()["total"]
    riding = rates(client, riders=2).json()["total"]
    assert riding > walking


# ===== 도구 9: 예약 수정 ===============================================

def modify(client, booking_id, conversation, last="Nakamura", **fields):
    payload = {"booking_id": booking_id, "last_name": last, "conversation_id": conversation}
    payload.update(fields)
    return client.post(f"{API}/voice/tools/modify-booking", json=payload)


def test_modify_needs_a_lookup_on_the_same_call(client):
    booking = book(client, time="8:01 AM", party=2, conversation="c-booked")
    assert tool_status(modify(client, booking["booking_id"], "c-other", party_size=3)) == 403


def test_modify_rejects_a_last_name_that_does_not_match(client):
    booking = book(client, time="8:01 AM", party=2, conversation="c-booked")
    lookup_first(client, "c-mod")
    refused = modify(client, booking["booking_id"], "c-mod", last="Wrong", party_size=3)
    assert tool_status(refused) == 403


def test_modify_shrinks_a_party_and_gives_the_seat_back(client):
    booking = book(client, time="8:01 AM", party=3, conversation="c-booked")
    assert "8:01 AM" not in [o["time"] for o in find(client, party=2).json()["options"]]
    lookup_first(client, "c-mod")
    done = modify(client, booking["booking_id"], "c-mod", party_size=2)
    assert done.status_code == 200
    assert done.json()["booking"]["party_size"] == 2
    assert open_count(client, party=2) > 0


def test_modify_cannot_overfill_a_tee_time(client):
    first = book(client, time="8:01 AM", party=2, conversation="c-a")
    book(client, time="8:01 AM", party=1, conversation="c-b")
    lookup_first(client, "c-mod")
    refused = modify(client, first["booking_id"], "c-mod", party_size=4)
    assert tool_status(refused) == 409


def test_modify_changes_the_number_of_holes(nine_by_phone, client):
    booking = book(client, time="10:07 AM", party=2, conversation="c-booked")
    lookup_first(client, "c-mod")
    done = modify(client, booking["booking_id"], "c-mod", holes=9)
    assert done.status_code == 200
    assert done.json()["booking"]["holes"] == 9
    # 그린피도 9홀 요금으로 따라간다.
    assert done.json()["booking"]["rate"] == ts.green_fee_for(TOMORROW, 9)


def test_modify_keeps_an_early_tee_time_at_eighteen_holes(nine_by_phone, client):
    booking = book(client, time="8:01 AM", party=2, conversation="c-booked")
    lookup_first(client, "c-mod")
    refused = modify(client, booking["booking_id"], "c-mod", holes=9)
    assert tool_status(refused) == 409
    assert "10:00 AM" in refused.json()["message"]


def test_modify_cannot_move_the_tee_time(client):
    """시간 변경은 일부러 없다. 보내도 무시되는 게 아니라 바꿀 것이 없다고 답해야 한다."""
    booking = book(client, time="8:01 AM", party=2, conversation="c-booked")
    lookup_first(client, "c-mod")
    nothing = modify(client, booking["booking_id"], "c-mod")
    assert tool_status(nothing) == 422


# ===== 취소 미리보기 ===================================================

def preview_cancel(client, booking_id, conversation, last="Nakamura"):
    return client.post(
        f"{API}/voice/tools/cancel-booking",
        json={"booking_id": booking_id, "last_name": last,
              "conversation_id": conversation, "preview": True},
    )


def test_cancel_preview_leaves_the_booking_alone(client):
    booking = book(client, time="8:01 AM", party=2, conversation="c-booked")
    lookup_first(client, "c-prev")
    body = preview_cancel(client, booking["booking_id"], "c-prev")
    assert body.status_code == 200
    assert body.json()["cancelled"] is False
    assert lookup_first(client, "c-check").json()["found"] == 1


def test_cancel_preview_still_needs_a_lookup(client):
    booking = book(client, time="8:01 AM", party=2, conversation="c-booked")
    assert tool_status(preview_cancel(client, booking["booking_id"], "c-nope")) == 403


# ===== 도구 10: 안내 문자 =============================================

def info_sms(client, topic="directions", number="905-892-1234", conversation="c-info"):
    return client.post(
        f"{API}/voice/tools/send-info-sms",
        json={"topic": topic, "caller_number": number, "conversation_id": conversation},
    )


def test_info_sms_has_no_path_to_a_number_the_caller_said(client):
    """받는 번호는 발신번호에서만 온다. 없으면 보내지 않고 읽어 주라고 답한다."""
    refused = info_sms(client, number="")
    assert tool_status(refused) == 422


def test_info_sms_is_capped_per_call(client):
    assert info_sms(client).status_code == 200
    assert info_sms(client).status_code == 200
    assert tool_status(info_sms(client)) == 429


def test_info_sms_rejects_a_topic_we_have_not_confirmed(client):
    """영업시간처럼 확인 안 된 사실은 보낼 통로 자체가 없어야 한다."""
    assert tool_status(info_sms(client, topic="hours")) == 422


def test_info_sms_sends_the_clubs_real_address(client):
    from backend.services import twilio_sms

    twilio_sms.sms_messages.clear()
    assert info_sms(client).status_code == 200
    assert twilio_sms.sms_messages, "문자가 기록되지 않았다"
    assert voice.CLUB_ADDRESS in twilio_sms.sms_messages[0].body


# ===== 도구 11: 분실물 접수 ============================================

def lost(client, conversation="c-lost", **fields):
    payload = {"item": "rangefinder", "last_name": "Walton",
               "caller_number": "+19058921234", "conversation_id": conversation}
    payload.update(fields)
    return client.post(f"{API}/voice/tools/report-lost-item", json=payload)


def test_lost_item_stores_the_caller_id_not_a_spoken_number(client, monkeypatch):
    seen = {}

    def fake_report(**kwargs):
        seen.update(kwargs)
        return {"ticket": "LF-0401"}

    monkeypatch.setattr(voice.lost_items, "report", fake_report)
    body = lost(client, description="black Bushnell", where_lost="cart 34")
    assert body.status_code == 200
    assert body.json()["ticket"] == "LF-0401"
    assert seen["caller_phone"] == "+19058921234"


def test_lost_item_never_tells_the_agent_it_was_found(client, monkeypatch):
    monkeypatch.setattr(voice.lost_items, "report", lambda **kw: {"ticket": "LF-0402"})
    message = lost(client).json()["message"].lower()
    assert "never say it has been found" in message


def test_lost_item_without_the_list_promises_nothing(client, monkeypatch):
    def boom(**kwargs):
        raise voice.supabase_rest.SupabaseUnavailable("down")

    monkeypatch.setattr(voice.lost_items, "report", boom)
    assert tool_status(lost(client)) == 503


def test_lost_item_does_not_guess_a_date_it_cannot_parse(client, monkeypatch):
    seen = {}

    def fake_report(**kwargs):
        seen.update(kwargs)
        return {"ticket": "LF-0403"}

    monkeypatch.setattr(voice.lost_items, "report", fake_report)
    assert lost(client, lost_on="last Tuesday").status_code == 200
    assert seen["lost_on"] is None


# ===== 도구 12: 대기자 등록 ============================================

def waitlist(client, conversation="c-wait", **fields):
    payload = {"date": TOMORROW, "party_size": 2, "last_name": "Walton",
               "caller_number": "+19058921234", "conversation_id": conversation}
    payload.update(fields)
    return client.post(f"{API}/voice/tools/join-waitlist", json=payload)


def test_waitlist_needs_a_number_to_text(client):
    assert tool_status(waitlist(client, caller_number="")) == 422


def test_waitlist_does_not_add_the_same_caller_twice(client, monkeypatch):
    monkeypatch.setattr(voice.tee_waitlist, "already_waiting", lambda date, phone: True)
    body = waitlist(client).json()
    assert body["joined"] is False


def test_waitlist_records_what_the_caller_asked_for(client, monkeypatch):
    seen = {}
    monkeypatch.setattr(voice.tee_waitlist, "already_waiting", lambda date, phone: False)
    monkeypatch.setattr(voice.tee_waitlist, "join", lambda **kw: seen.update(kw) or {"id": "w1"})
    assert waitlist(client, earliest="9:00 AM", latest="11:00 AM").status_code == 200
    assert seen["earliest"] == "9:00 AM"
    assert seen["phone"] == "+19058921234"


def test_waitlist_without_the_list_promises_nothing(client, monkeypatch):
    def boom(date, phone):
        raise voice.supabase_rest.SupabaseUnavailable("down")

    monkeypatch.setattr(voice.tee_waitlist, "already_waiting", boom)
    assert tool_status(waitlist(client)) == 503


# 취소된 자리를 대기자에게 다시 거는 흐름은 `test_waitlist_offers.py` 에 있다.


def test_waitlist_rejects_a_time_it_cannot_parse(client):
    """"9am" 을 그대로 저장하면 조건이 조용히 무시되고 새벽 문자를 받게 된다."""
    assert tool_status(waitlist(client, earliest="9am")) == 422


def test_confirm_falls_back_to_the_caller_id(client):
    """2026-10-06 첫 실제 통화: 에이전트가 phone 자리에 "caller_number" 라는 글자를
    그대로 넣어 422 가 세 번 나고 통화가 직원에게 넘어갔다. 홀드만 남고 예약은 없었다.
    받아 적은 값이 번호가 아니면 발신번호를 쓴다."""
    held = hold(client, time="8:01 AM", party=2, conversation="c-fallback")
    done = client.post(
        f"{API}/voice/tools/confirm-booking",
        json={"hold_id": held.json()["hold_id"], "first_name": "Kenneth", "last_name": "Tanath",
              "phone": "caller_number", "caller_number": "+19058921234",
              "conversation_id": "c-fallback"},
    )
    assert done.status_code == 200, done.text
    assert lookup_first(client, "c-check", phone="905-892-1234", last="Tanath").json()["found"] == 1


def test_confirm_without_any_number_is_refused(client):
    held = hold(client, time="8:10 AM", party=2, conversation="c-nonum")
    refused = client.post(
        f"{API}/voice/tools/confirm-booking",
        json={"hold_id": held.json()["hold_id"], "first_name": "Kenneth", "last_name": "Tanath",
              "conversation_id": "c-nonum"},
    )
    assert tool_status(refused) == 422
    assert "placeholder" in refused.json()["message"]


# ===== 2026-10-20 통화에서 드러난 것들 ====================================

def _raw_docs(date):
    with store.mutate(voice.Scope(dates={date})) as raw:
        return [dict(doc) for doc in raw]


def test_a_hold_does_not_rewrite_the_other_bookings_of_that_day(client):
    """DB 가 붙인 칸(confirmationCode 등)을 모델이 몰라도, hold 는 다른 예약을 다시 쓰지 않는다.

    예전에는 그날 예약 전체가 "바뀜" 으로 보여 다시 쓰였고, 그 upsert 가 일출·일몰 트리거에
    새 예약처럼 걸려 hold 가 PT422 로 실패했다.
    """
    booked = book(client)
    with store.mutate(voice.Scope(dates={TOMORROW})) as raw:
        for doc in raw:
            if doc["id"] == booked["booking_id"]:
                doc["confirmationCode"] = "TDB123456"
                doc["players"][0]["greenFee"] = 40.71
    before = next(d for d in _raw_docs(TOMORROW) if d["id"] == booked["booking_id"])

    assert hold(client, time="10:16 AM", conversation="c-other").json()["ok"] is True

    after = next(d for d in _raw_docs(TOMORROW) if d["id"] == booked["booking_id"])
    assert after == before


def test_a_changed_booking_keeps_fields_the_model_does_not_know(client):
    with ts.bookings_tx(voice.Scope(dates={TOMORROW})) as bookings:
        pass  # 빈 날 — 아래에서 예약을 만든다
    booked = book(client)
    with store.mutate(voice.Scope(dates={TOMORROW})) as raw:
        for doc in raw:
            if doc["id"] == booked["booking_id"]:
                doc["confirmationCode"] = "TDB123456"
    with ts.bookings_tx(voice.Scope(dates={TOMORROW})) as bookings:
        target = next(b for b in bookings if b.id == booked["booking_id"])
        target.notes = "changed"

    doc = next(d for d in _raw_docs(TOMORROW) if d["id"] == booked["booking_id"])
    assert doc["notes"] == "changed"
    assert doc["confirmationCode"] == "TDB123456"


def test_a_refusal_comes_back_as_a_readable_message_not_an_http_error(client):
    response = find(client, date="2026-10-20")  # 시드 오늘(9/8)에서 42일 뒤

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is False and body["status"] == 422
    assert "two weeks" in body["message"]
    assert "Tuesday, September 22" in body["message"]
    assert "system problem" in body["message"]  # "Do not call this a system problem."


def test_missing_fields_come_back_as_a_message(client):
    response = client.post(f"{API}/voice/tools/hold-tee-time", json={"date": TOMORROW})

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is False and body["status"] == 422
    assert "time" in body["message"] and "party_size" in body["message"]


def test_a_storage_failure_is_a_message_not_a_500(client, monkeypatch):
    def broken(*args, **kwargs):
        raise RuntimeError("POST pelham_tee_bookings failed: HTTP 422 (code PT422)")

    monkeypatch.setattr(voice.ts, "bookings_tx", broken)
    body = hold(client).json()

    assert body["ok"] is False and body["status"] == 503
    assert "request_callback" in body["message"]
    assert "PT422" not in body["message"]


def test_a_bad_tool_secret_is_still_an_http_401(client, monkeypatch):
    monkeypatch.setenv("VOICE_TOOL_SECRET", "s3cret")
    assert find(client).status_code == 401


# ===== 업무시간 · 콜백 =================================================

def identify_now(client, number="+19058921234"):
    return client.post(f"{API}/voice/tools/identify-caller",
                       json={"caller_number": number, "conversation_id": "c-id"})


def callback(client, **fields):
    payload = {"first_name": "Jin", "last_name": "Nakamura", "reason": "Wants a tee time for six players",
               "caller_number": "+19058921234", "conversation_id": "c-cb"}
    payload.update(fields)
    return client.post(f"{API}/voice/tools/request-callback", json=payload)


def test_staff_hours_parse_and_speak(monkeypatch):
    monkeypatch.setattr(voice, "PRO_SHOP_HOURS", "07:30-17:00")
    assert voice.staff_hours() == (450, 1020)
    assert voice.staff_hours_spoken() == "7:30 AM to 5 PM"
    assert voice.staff_on_duty(datetime(2026, 10, 20, 7, 29, tzinfo=voice.CLUB_TIMEZONE)) is False
    assert voice.staff_on_duty(datetime(2026, 10, 20, 7, 30, tzinfo=voice.CLUB_TIMEZONE)) is True
    assert voice.staff_on_duty(datetime(2026, 10, 20, 17, 0, tzinfo=voice.CLUB_TIMEZONE)) is False

    monkeypatch.setattr(voice, "PRO_SHOP_HOURS", "nonsense")
    assert voice.staff_hours() == (480, 1080)


def test_identify_caller_says_the_shop_is_closed_after_hours(client, monkeypatch):
    monkeypatch.setattr(voice.customer_lookup, "find_by_phone", lambda phone: None)
    body = identify_now(client).json()  # FIXED_NOW 는 아침 6시 — 문 열기 전

    assert body["staff_available"] is False
    assert "Do not transfer" in body["message"]
    assert "request_callback" in body["message"]


def test_identify_caller_allows_a_transfer_during_hours(client, monkeypatch):
    monkeypatch.setattr(voice.customer_lookup, "find_by_phone", lambda phone: None)
    monkeypatch.setattr(voice, "club_now", lambda: FIXED_NOW.replace(hour=10))
    body = identify_now(client).json()

    assert body["staff_available"] is True
    assert "transfer to the pro shop is possible" in body["message"]


def test_callback_after_hours_promises_a_call_in_business_hours(client, monkeypatch):
    seen = {}

    def fake_request(**kwargs):
        seen.update(kwargs)
        return {"ticket": "CB-0101"}

    monkeypatch.setattr(voice.callbacks, "request", fake_request)
    body = callback(client).json()

    assert body["ok"] is True and body["ticket"] == "CB-0101"
    assert body["staff_available"] is False
    assert "during business hours, 8 AM to 6 PM" in body["message"]
    assert "1234" in body["message"]
    assert seen["phone"] == "+19058921234"
    assert seen["reason"] == "Wants a tee time for six players"
    assert seen["conversation_id"] == "c-cb"


def test_callback_uses_a_spoken_number_when_given(client, monkeypatch):
    seen = {}
    monkeypatch.setattr(voice.callbacks, "request", lambda **kw: seen.update(kw) or {"ticket": "CB-0102"})
    callback(client, phone="905 555 0142")
    assert seen["phone"] == "905 555 0142"


def test_callback_needs_a_real_number(client, monkeypatch):
    monkeypatch.setattr(voice.callbacks, "request", lambda **kw: {"ticket": "x"})
    body = callback(client, caller_number="", phone="caller_number").json()
    assert body["ok"] is False and body["status"] == 422


def test_callback_list_down_is_a_message(client, monkeypatch):
    def boom(**kwargs):
        raise voice.supabase_rest.SupabaseUnavailable("down")

    monkeypatch.setattr(voice.callbacks, "request", boom)
    body = callback(client).json()
    assert body["ok"] is False and body["status"] == 503
    assert "business hours" in body["message"]
