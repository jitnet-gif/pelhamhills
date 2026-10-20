"""티 시트 백엔드 통합 테스트.

실행: `cd E:\\PELHAMHILLS && python -m pytest backend/tests/test_tee_sheet.py -q`

모든 테스트는 `TEE_SHEET_DATA_FILE` 를 tmp_path 로 돌려 실제 데이터 파일을 건드리지 않는다.
"""

from __future__ import annotations

import sys
import time
from datetime import date, timedelta
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend.api.routes import tee_sheet as module  # noqa: E402
from backend.services import tee_sheet_store as store  # noqa: E402

API = "/api/v1"


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv(store.ENV_VAR, str(tmp_path / "tee_sheet.json"))
    # 이전 테스트의 캐시를 확실히 버린다 (경로 키가 다르면 자동 무효화되지만 명시적으로).
    store._cache = None
    store._cache_path = None
    with module._task_lock:
        module._tasks.clear()

    app = FastAPI()
    app.include_router(module.router, prefix=API)
    with TestClient(app) as test_client:
        yield test_client

    store._cache = None
    store._cache_path = None


# ===== 헬퍼 ===========================================================

def slots_for(client, iso_date: str) -> dict:
    response = client.get(f"{API}/tee-sheet/slots", params={"date": iso_date})
    assert response.status_code == 200, response.text
    return response.json()


def wait_for_tasks(client, task_ids: list[str], timeout: float = 15.0) -> dict[str, dict]:
    deadline = time.time() + timeout
    last: dict[str, dict] = {}
    while time.time() < deadline:
        status = client.get(f"{API}/tee-sheet/orchestration/status").json()
        last = {t["id"]: t for t in status["tasks"]}
        if all(last.get(tid, {}).get("state") in ("success", "failed") for tid in task_ids):
            return last
        time.sleep(0.05)
    raise AssertionError(f"tasks did not reach a terminal state: {last}")


def create(client, **payload):
    return client.post(f"{API}/tee-sheet/bookings", json=payload)


def party(n: int, last: str = "Extra") -> list[dict]:
    """직원 시트용 n명 일행. 정원(4) 위 여분 4자리(최대 8)를 채울 때 쓴다."""
    return [{"name": f"Guest{i} {last}"} for i in range(1, n + 1)]


# ===== 저장소 / 시드 ===================================================

def test_store_seeds_the_file_and_persists(client, tmp_path):
    data_file = tmp_path / "tee_sheet.json"
    bookings = client.get(f"{API}/tee-sheet/bookings").json()
    assert data_file.exists(), "store should seed the JSON file on first access"
    assert store.data_file() == data_file.resolve()
    assert len(bookings) == 11
    dates = sorted({b["date"] for b in bookings})
    assert dates == ["2026-09-08"]
    # dayIndex 는 와이어에서 사라져야 한다.
    assert all("dayIndex" not in b for b in bookings)
    assert all("span" in b for b in bookings)


def test_seed_names_round_trip(client):
    booking = client.get(f"{API}/tee-sheet/bookings/b-xeric").json()
    names = [p["name"] for p in booking["players"]]
    assert names == ["Micah Xeric", "Blake Jo Kestrel", "Tatum Isle", "Wren Dell"]

    # 성은 **마지막 토큰**이다. 프론트가 `${lastName}, ${firstName}` 로 그리므로
    # 여기서 틀리면 시트에 "Jo Kestrel, Blake" 가 찍힌다.
    kestrel = booking["players"][1]
    assert kestrel["firstName"] == "Blake Jo"
    assert kestrel["lastName"] == "Kestrel"

    xeric = booking["players"][0]
    assert (xeric["firstName"], xeric["lastName"]) == ("Micah", "Xeric")

    guest = client.get(f"{API}/tee-sheet/bookings/b-cedar").json()["players"][1]
    assert (guest["name"], guest["firstName"], guest["lastName"]) == ("Guest", "Guest", "")


@pytest.mark.parametrize(
    ("full_name", "expected"),
    [
        ("Micah Xeric", ("Micah", "Xeric")),          # 두 토큰
        ("Blake Jo Kestrel", ("Blake Jo", "Kestrel")),  # 세 토큰: 성은 마지막 토큰
        ("Guest", ("Guest", "")),                          # 한 토큰: ("", "Guest") 가 아니다
        ("  Ada  ", ("Ada", "")),
        ("", ("", "")),
    ],
)
def test_split_name_takes_the_last_token_as_the_surname(full_name, expected):
    """시드와 API 가 **같은** 함수로 쪼개야 한다. 갈라지면 시트에 잘못된 성이 찍힌다."""
    assert store.split_name(full_name) == expected
    assert module._split_name(full_name) == expected


def test_seed_shares_one_tee_time_between_two_reservations(client):
    """7:43 AM = 회원 2인(9홀) + GolfNow 2인 = 정확히 4자리. Chronogolf 의 분할 예약."""
    day = client.get(f"{API}/tee-sheet/bookings", params={"date": "2026-09-08"}).json()

    at_743 = [b for b in day if b["time"] == "7:43 AM"]
    assert [b["id"] for b in at_743] == ["b-willow", "b-cedar"]
    assert sum(len(b["players"]) for b in at_743) == module.PLAYERS_PER_TEE_TIME == 4
    assert {b["color"] for b in at_743} == {"gold", "blue"}
    assert at_743[0]["holes"] == 9                      # Willow 는 9홀
    assert "GolfNow" in at_743[1]["notes"]              # 온라인 예약에는 메모가 붙는다

    at_752 = [b for b in day if b["time"] == "7:52 AM"]
    assert [b["id"] for b in at_752] == ["b-ash", "b-brook"]
    assert sum(len(b["players"]) for b in at_752) == 4


def test_every_seeded_time_is_a_real_slot(client):
    bookings = client.get(f"{API}/tee-sheet/bookings").json()
    cache: dict[str, set[str]] = {}
    for booking in bookings:
        if booking["date"] not in cache:
            cache[booking["date"]] = {s["time"] for s in slots_for(client, booking["date"])["slots"]}
        assert booking["time"] in cache[booking["date"]], (
            f"{booking['id']} at {booking['time']} is not a slot on {booking['date']}"
        )


# ===== 슬롯 ===========================================================

def test_slots_shape_and_rates(client):
    tuesday = slots_for(client, "2026-09-08")           # 정규 시즌 평일 (시드가 있는 날)
    friday = slots_for(client, "2026-09-11")            # 정규 시즌 금요일 (Weekend Friday's 요금표)
    saturday = slots_for(client, "2026-09-12")          # 정규 시즌 주말

    slots = tuesday["slots"]
    assert tuesday["date"] == "2026-09-08"
    assert slots[0] == {"time": "6:40 AM", "minutes": 400, "rate": 47.79, "cartsTotal": 4,
                        "dayType": "weekday", "holiday": None}
    assert slots[1]["time"] == "6:49 AM"
    # 마지막 티는 6:58 PM — Chronogolf export 에 이 시각까지 실제 예약이 있다.
    assert slots[-1] == {"time": "6:58 PM", "minutes": 18 * 60 + 58, "rate": 34.52, "cartsTotal": 4,
                        "dayType": "weekday", "holiday": None}
    # 9분 간격이 끝까지 유지되는지
    assert all(b["minutes"] - a["minutes"] == 9 for a, b in zip(slots, slots[1:]))
    assert all(s["cartsTotal"] == 4 for s in slots)

    # 2026 요금표(0045): 가격대는 오후 2시, 5시에 내려간다. 금요일은 17시 이후가 $1 높다.
    assert {s["rate"] for s in friday["slots"]} == {58.41, 46.90, 39.94}
    assert {s["rate"] for s in saturday["slots"]} == {58.41, 46.90, 38.94}
    by_time = {s["time"]: s["rate"] for s in saturday["slots"]}
    assert by_time["1:52 PM"] == 58.41 and by_time["2:01 PM"] == 46.90 and by_time["5:01 PM"] == 38.94
    assert {s["time"]: s["rate"] for s in slots}["2:01 PM"] == 38.94
    # 가을 숄더(10/1–12/15): 평일 40.71 → 35.40, 주말 51.33 → 46.02.
    assert {s["rate"] for s in slots_for(client, "2026-10-20")["slots"]} == {40.71, 35.40}
    assert {s["rate"] for s in slots_for(client, "2026-10-24")["slots"]} == {51.33, 46.02}
    assert len(friday["slots"]) == len(slots) == len(saturday["slots"])


def test_rate_override_still_wins_when_configured(client, monkeypatch):
    """RATE_OVERRIDES 는 살아 있는 기능이다. 시드 보존용 항목만 지웠다."""
    assert module.RATE_OVERRIDES == {}
    monkeypatch.setitem(module.RATE_OVERRIDES, "2026-09-11", 99.0)
    assert {s["rate"] for s in slots_for(client, "2026-09-11")["slots"]} == {99.0}


def test_slots_rejects_bad_date(client):
    assert client.get(f"{API}/tee-sheet/slots", params={"date": "Sept 11"}).status_code == 422


# ===== 목록 / 필터 =====================================================

def test_list_filters_by_date_and_range(client):
    day = client.get(f"{API}/tee-sheet/bookings", params={"date": "2026-09-08"}).json()
    assert len(day) == 11
    assert all(b["date"] == "2026-09-08" for b in day)
    # 같은 시각의 두 예약도 그대로 두 줄로 나온다 (7:43 / 7:52).
    assert [b["time"] for b in day] == [
        "6:58 AM", "7:07 AM", "7:16 AM", "7:25 AM", "7:34 AM",
        "7:43 AM", "7:43 AM", "7:52 AM", "7:52 AM", "8:01 AM", "8:10 AM",
    ]

    later = create(client, date="2026-09-12", time="9:04 AM", title="Later, Sam",
                   players=[{"name": "Sam Later"}])
    assert later.status_code == 201, later.text

    ranged = client.get(
        f"{API}/tee-sheet/bookings", params={"from": "2026-09-09", "to": "2026-09-30"}
    ).json()
    assert len(ranged) == 1
    assert all(b["date"] == "2026-09-12" for b in ranged)

    empty = client.get(
        f"{API}/tee-sheet/bookings", params={"from": "2026-01-01", "to": "2026-01-31"}
    ).json()
    assert empty == []

    everything = client.get(f"{API}/tee-sheet/bookings").json()
    assert len(everything) == 12
    keys = [(b["date"], b["time"]) for b in everything]
    assert keys == sorted(keys, key=lambda kv: (kv[0], module.label_to_minutes(kv[1])))


# ===== 생성 ===========================================================

def test_create_booking_defaults_rate_from_slot(client):
    response = create(client, date="2026-09-08", time="9:04 AM", title="Walk-in, Pat")
    assert response.status_code == 201, response.text
    booking = response.json()
    assert booking["rate"] == 47.79          # 정규 시즌 평일 요금이 슬롯에서 흘러들어와야 한다
    assert booking["date"] == "2026-09-08"
    assert booking["status"] == "reserved"
    assert booking["span"] == 1
    assert booking["audit"][0]["message"] == "Reservation created for 2026-09-08 9:04 AM."

    weekend = create(client, date="2026-09-12", time="9:04 AM", title="Weekend, Sam").json()
    assert weekend["rate"] == 58.41

    afternoon = create(client, date="2026-09-12", time="3:04 PM", title="Afternoon, Lee").json()
    assert afternoon["rate"] == 46.90          # 오후 2시부터 18홀은 다음 가격대


def test_create_rejects_unknown_slot_with_422(client):
    bad = create(client, date="2026-09-08", time="9:05 AM", title="Off grid")
    assert bad.status_code == 422
    assert "not a bookable tee time" in bad.json()["detail"]

    too_early = create(client, date="2026-09-08", time="6:00 AM", title="Too early")
    assert too_early.status_code == 422

    too_late = create(client, date="2026-09-08", time="7:00 PM", title="Too late")
    assert too_late.status_code == 422

    garbage = create(client, date="2026-09-08", time="nope", title="Garbage")
    assert garbage.status_code == 422


def test_create_shares_a_tee_time_until_it_hits_eight_players(client):
    """한 티 타임에 예약이 몇 건이든 상관없다. 직원 시트는 합계 8명(4 + 여분 4)이 한계다."""
    # 6:58 AM 은 이미 4명(b-xeric). 직원은 4명을 더 넣을 수 있다.
    extra = create(client, date="2026-09-08", time="6:58 AM", title="Extra, Ed", players=party(4))
    assert extra.status_code == 201, extra.text
    # 이제 8명. 한 명도 더 못 들어간다.
    clash = create(client, date="2026-09-08", time="6:58 AM", title="Clash, Joe",
                   players=[{"name": "Joe Clash"}])
    assert clash.status_code == 409
    assert "only holds 8 players" in clash.json()["detail"]

    # 7:07 AM 은 3명(b-dune) -> 두 번째 예약 1명은 통과해야 한다.
    shared = create(client, date="2026-09-08", time="7:07 AM", title="Single, Sam",
                    players=[{"name": "Sam Single"}])
    assert shared.status_code == 201, shared.text
    day = client.get(f"{API}/tee-sheet/bookings", params={"date": "2026-09-08"}).json()
    at_707 = [b for b in day if b["time"] == "7:07 AM"]
    assert len(at_707) == 2
    assert sum(len(b["players"]) for b in at_707) == 4

    # 이제 7:07 AM 은 기본 4자리가 찼다. 여분 4자리 위로는 못 넣는다.
    overflow = create(client, date="2026-09-08", time="7:07 AM", title="Late, Larry",
                      players=party(5, "Late"))
    assert overflow.status_code == 409

    # 7:25 AM 은 2명(b-ridge): 7명은 넘치고 6명은 딱 맞는다.
    too_big = create(client, date="2026-09-08", time="7:25 AM", title="Seven, Tom", players=party(7))
    assert too_big.status_code == 409
    fits = create(client, date="2026-09-08", time="7:25 AM", title="Six, Tim", players=party(6))
    assert fits.status_code == 201, fits.text

    # 같은 시각이라도 날짜가 다르면 정원도 따로다.
    ok = create(client, date="2026-09-12", time="6:58 AM", title="Other day",
                players=[{"name": "Other Day"}])
    assert ok.status_code == 201


def test_cancelled_reservation_releases_its_tee_time_slots(client):
    """취소된 예약은 티 타임 자리를 붙들고 있으면 안 된다."""
    # 7:43 AM 은 4명(b-cedar 2 + b-willow 2). 여분 4자리까지 채운다.
    assert create(client, date="2026-09-08", time="7:43 AM", title="Extra, Ed",
                  players=party(4)).status_code == 201
    blocked = create(client, date="2026-09-08", time="7:43 AM", title="Waiting, Wes",
                     players=[{"name": "Wes Waiting"}])
    assert blocked.status_code == 409

    cancelled = client.patch(f"{API}/tee-sheet/bookings/b-cedar", json={"status": "cancelled"})
    assert cancelled.status_code == 200
    freed = create(client, date="2026-09-08", time="7:43 AM", title="Waiting, Wes",
                   players=[{"name": "Wes Waiting"}, {"name": "Pat Waiting"}])
    assert freed.status_code == 201, freed.text


def test_reinstating_a_cancelled_reservation_cannot_overflow_the_tee_time(client):
    """놓아 준 자리가 이미 팔렸으면 되살리기는 409 여야 한다 (정원 10명이 되면 안 된다)."""
    url = f"{API}/tee-sheet/bookings/b-cedar"          # 7:43 AM, 2명
    assert client.patch(url, json={"status": "cancelled"}).status_code == 200

    taken = create(client, date="2026-09-08", time="7:43 AM", title="Fast, Fran", players=party(6, "Fast"))
    assert taken.status_code == 201, taken.text

    revived = client.patch(url, json={"status": "reserved"})
    assert revived.status_code == 409
    assert "only holds 8 players" in revived.json()["detail"]
    assert client.get(url).json()["status"] == "cancelled"   # 거절이 아무것도 바꾸지 않았다

    day = client.get(f"{API}/tee-sheet/bookings", params={"date": "2026-09-08"}).json()
    active = [b for b in day if b["time"] == "7:43 AM" and b["status"] != "cancelled"]
    assert sum(len(b["players"]) for b in active) == 8

    # 자리가 다시 나면 되살릴 수 있다.
    assert client.delete(f"{API}/tee-sheet/bookings/{taken.json()['id']}").status_code == 204
    assert client.patch(url, json={"status": "reserved"}).status_code == 200


def test_create_splits_supplied_names(client):
    response = create(
        client,
        date="2026-09-08",
        time="9:13 AM",
        title="Names, Test",
        players=[
            {"name": "Blake Jo Kestrel"},
            {"name": "Guest"},
            {"firstName": "Ada", "lastName": "Lovelace"},
        ],
    )
    assert response.status_code == 201, response.text
    players = response.json()["players"]
    assert (players[0]["firstName"], players[0]["lastName"]) == ("Blake Jo", "Kestrel")
    assert (players[1]["name"], players[1]["firstName"], players[1]["lastName"]) == ("Guest", "Guest", "")
    assert players[2]["name"] == "Ada Lovelace"


# ===== 조회 / 삭제 =====================================================

def test_get_booking_and_404(client):
    booking = client.get(f"{API}/tee-sheet/bookings/b-elm")
    assert booking.status_code == 200
    assert booking.json()["title"] == "Elm, Noel"
    assert client.get(f"{API}/tee-sheet/bookings/nope").status_code == 404


def test_delete_booking(client):
    assert client.delete(f"{API}/tee-sheet/bookings/b-dune").status_code == 204
    assert client.get(f"{API}/tee-sheet/bookings/b-dune").status_code == 404
    assert len(client.get(f"{API}/tee-sheet/bookings").json()) == 10
    assert client.delete(f"{API}/tee-sheet/bookings/b-dune").status_code == 404


# ===== PATCH ==========================================================

def test_patch_status_transitions_and_uncancel(client):
    url = f"{API}/tee-sheet/bookings/b-ridge"

    checked_in = client.patch(url, json={"status": "checked_in"}).json()
    assert checked_in["status"] == "checked_in"
    assert all(p["arrived"] for p in checked_in["players"])
    assert checked_in["audit"][0]["message"] == "Reservation checked in."

    paid = client.patch(url, json={"status": "paid"}).json()
    assert all(p["paid"] and p["arrived"] for p in paid["players"])

    cancelled = client.patch(url, json={"status": "cancelled", "cancelReason": "Rain"}).json()
    assert cancelled["status"] == "cancelled"
    assert cancelled["cancelReason"] == "Rain"
    assert all(p["cancelled"] for p in cancelled["players"])
    assert cancelled["audit"][0]["message"] == "Reservation cancelled: Rain"

    reserved = client.patch(url, json={"status": "reserved"}).json()
    assert reserved["status"] == "reserved"
    assert reserved["cancelReason"] is None
    assert not any(p["cancelled"] for p in reserved["players"])
    # 복구된 예약은 결제/체크인 상태까지 되돌아가야 한다. 그러지 않으면
    # collected_revenue 가 실제로 받지 않은 돈을 계상한다.
    assert not any(p["paid"] for p in reserved["players"])
    assert not any(p["arrived"] for p in reserved["players"])
    assert not any(p["no_show"] for p in reserved["players"])
    assert reserved["audit"][0]["message"] == "Reservation reinstated as reserved."

    report = client.get(f"{API}/tee-sheet/reports/daily", params={"date": "2026-09-08"}).json()
    assert report["collected_revenue"] == 0
    assert report["cancelled"] == 0 and report["checked_in"] == 0


def test_patch_writes_specific_audit_lines(client):
    url = f"{API}/tee-sheet/bookings/b-elm"
    booking = client.patch(url, json={"cartCount": 2, "holes": 9, "rate": 30.0,
                                      "color": "gray", "title": "Elm, Martin",
                                      "notes": "Back nine only"}).json()
    messages = [entry["message"] for entry in booking["audit"]]
    assert "Cart count set to 2." in messages
    assert "Holes set to 9." in messages
    assert "Rate set to $30.00." in messages
    assert "Color set to gray." in messages
    assert "Title changed to 'Elm, Martin'." in messages
    assert "Notes updated." in messages
    assert booking["cartCount"] == 2 and booking["holes"] == 9 and booking["color"] == "gray"

    # 값이 바뀌지 않으면 감사 로그를 남기지 않는다.
    before = len(booking["audit"])
    again = client.patch(url, json={"cartCount": 2}).json()
    assert len(again["audit"]) == before


def test_patch_moves_booking_to_another_slot(client):
    url = f"{API}/tee-sheet/bookings/b-elm"          # 4명
    moved = client.patch(url, json={"date": "2026-09-12", "time": "7:25 AM"})
    assert moved.status_code == 200, moved.text
    body = moved.json()
    assert (body["date"], body["time"]) == ("2026-09-12", "7:25 AM")
    assert body["audit"][0]["message"] == "Moved to 2026-09-12 7:25 AM."
    assert client.get(f"{API}/tee-sheet/bookings", params={"date": "2026-09-08"}).json().__len__() == 10

    # 존재하지 않는 슬롯으로는 이동 불가
    assert client.patch(url, json={"time": "7:26 AM"}).status_code == 422
    # 정원을 넘기는 티 타임으로도 이동 불가 (4명 + 1명 + 4명 = 9명)
    assert create(client, date="2026-09-08", time="6:58 AM", title="Extra, Ed",
                  players=party(1)).status_code == 201
    conflict = client.patch(url, json={"date": "2026-09-08", "time": "6:58 AM"})
    assert conflict.status_code == 409
    assert "only holds 8 players" in conflict.json()["detail"]
    # 실패한 이동이 원본을 건드리지 않았는지
    assert client.get(url).json()["date"] == "2026-09-12"


def test_patch_moves_into_a_tee_time_that_still_has_room(client):
    # b-brook 는 1명. 7:07 AM 은 3명(b-dune) -> 합쳐서 정확히 4명이라 통과해야 한다.
    moved = client.patch(f"{API}/tee-sheet/bookings/b-brook", json={"time": "7:07 AM"})
    assert moved.status_code == 200, moved.text
    assert moved.json()["time"] == "7:07 AM"

    # 여분 1자리를 더 채우면 남는 자리는 3. 4명짜리 b-ford 은 못 들어간다.
    assert create(client, date="2026-09-08", time="7:07 AM", title="Extra, Ed",
                  players=party(1)).status_code == 201
    blocked = client.patch(f"{API}/tee-sheet/bookings/b-ford", json={"time": "7:07 AM"})
    assert blocked.status_code == 409
    assert client.get(f"{API}/tee-sheet/bookings/b-ford").json()["time"] == "7:16 AM"


def test_cancelled_booking_moves_into_a_full_tee_time_but_cannot_be_reinstated_there(client):
    """취소된 예약은 자리를 잡지 않으므로 이동을 정원으로 막을 이유가 없다.

    막아야 하는 건 이동이 아니라 **되살리기**다. 그건 별도 게이트가 이미 막는다.
    """
    url = f"{API}/tee-sheet/bookings/b-cedar"          # 7:43 AM, 2명
    assert client.patch(url, json={"status": "cancelled"}).status_code == 200

    # 6:58 AM 을 b-xeric 4명 + 여분 4명으로 꽉 채운다. 그래도 취소된 예약은 옮겨갈 수 있다.
    assert create(client, date="2026-09-08", time="6:58 AM", title="Extra, Ed",
                  players=party(4)).status_code == 201
    moved = client.patch(url, json={"time": "6:58 AM"})
    assert moved.status_code == 200, moved.text
    after_move = client.get(url).json()
    assert after_move["time"] == "6:58 AM"
    assert after_move["status"] == "cancelled"            # 이동이 상태를 되살리지는 않는다
    assert after_move["audit"][0]["message"] == "Moved to 2026-09-08 6:58 AM."

    # 옮겨간 자리에는 남는 자리가 없다 -> 되살리기는 여전히 409 (오버플로 구멍이 아니다).
    revived = client.patch(url, json={"status": "reserved"})
    assert revived.status_code == 409
    assert "only holds 8 players" in revived.json()["detail"]
    still = client.get(url).json()
    assert (still["status"], still["time"]) == ("cancelled", "6:58 AM")

    # 존재하지 않는 슬롯으로는 취소된 예약도 못 간다 (슬롯 검증은 상태와 무관).
    assert client.patch(url, json={"time": "7:26 AM"}).status_code == 422

    # 자리가 있는 티 타임으로 옮기면 되살아난다.
    assert client.patch(url, json={"time": "9:13 AM"}).status_code == 200
    assert client.patch(url, json={"status": "reserved"}).status_code == 200


def test_patch_to_its_own_slot_is_a_noop_not_a_conflict(client):
    url = f"{API}/tee-sheet/bookings/b-xeric"
    response = client.patch(url, json={"date": "2026-09-08", "time": "6:58 AM"})
    assert response.status_code == 200
    assert response.json()["time"] == "6:58 AM"


# ===== 플레이어 =======================================================

def test_add_patch_remove_player(client):
    url = f"{API}/tee-sheet/bookings/b-ridge"           # 2명, 7:25 AM 에는 자리가 남아 있다

    added = client.post(f"{url}/players", json={"name": "Blake Jo Kestrel"})
    assert added.status_code == 200, added.text
    players = added.json()["players"]
    assert len(players) == 3
    new_player = players[-1]
    assert (new_player["firstName"], new_player["lastName"]) == ("Blake Jo", "Kestrel")
    assert added.json()["audit"][0]["message"] == "Player added: Blake Jo Kestrel."

    # firstName 만 패치하면 name 이 재계산된다
    patched = client.patch(f"{url}/players/{new_player['id']}", json={"firstName": "Elizabeth"}).json()
    updated = patched["players"][-1]
    assert updated["name"] == "Elizabeth Kestrel"
    assert updated["lastName"] == "Kestrel"

    # name 만 패치하면 다시 쪼개진다
    patched = client.patch(f"{url}/players/{new_player['id']}", json={"name": "Ada Lovelace"}).json()
    updated = patched["players"][-1]
    assert (updated["firstName"], updated["lastName"]) == ("Ada", "Lovelace")

    # 단일 토큰 이름
    patched = client.patch(f"{url}/players/{new_player['id']}", json={"name": "Guest"}).json()
    updated = patched["players"][-1]
    assert (updated["name"], updated["firstName"], updated["lastName"]) == ("Guest", "Guest", "")

    # 비이름 필드 패치는 이름을 건드리지 않는다
    patched = client.patch(f"{url}/players/{new_player['id']}", json={"paid": True}).json()
    assert patched["players"][-1]["name"] == "Guest"
    assert patched["players"][-1]["paid"] is True

    removed = client.delete(f"{url}/players/{new_player['id']}")
    assert removed.status_code == 200
    assert len(removed.json()["players"]) == 2
    assert client.delete(f"{url}/players/{new_player['id']}").status_code == 404


def _cart_booking(client, **extra):
    """카트 요금 테스트용 예약: Public Senior 1명 + Public 1명, 18홀."""
    response = create(client, date="2026-09-08", time="9:22 AM", title="Cart, Test", players=[
        {"name": "Ann Senior", "ratePlan": "Public Senior"},
        {"name": "Bob Public", "ratePlan": "Public"},
    ], **extra)
    assert response.status_code == 201, response.text
    booking = response.json()
    return f"{API}/tee-sheet/bookings/{booking['id']}", [p["id"] for p in booking["players"]]


def test_cart_fee_is_filled_in_and_stays_editable(client):
    url, (ann, bob) = _cart_booking(client)

    # 클럽 요금: 18홀 세전 $19.47(Public Senior $17.70), 9홀 $11.50. 자동값이면 홀 수를 따라간다.
    on = client.patch(f"{url}/players/{ann}", json={"cart": True}).json()
    assert (on["players"][0]["cart"], on["players"][0]["cartFee"]) == (True, 17.70)
    assert on["audit"][0]["message"] == "Cart added for Ann Senior ($17.70)."
    assert client.patch(f"{url}/players/{bob}", json={"cart": True}).json()["players"][1]["cartFee"] == 19.47
    assert [p["cartFee"] for p in client.patch(url, json={"holes": 9}).json()["players"]] == [11.50, 11.50]

    # 이름에 Cart 가 든 회원 요금제는 카트 포함 → 0. 일반 요금제로 돌리면 자동값이 돌아온다.
    member = client.patch(f"{url}/players/{ann}", json={"ratePlan": "Weekday Member - Single with Weekday Cart"}).json()
    assert member["players"][0]["cartFee"] == 0
    assert client.patch(f"{url}/players/{ann}", json={"ratePlan": "Public"}).json()["players"][0]["cartFee"] == 11.50  # 지금 9홀

    # 사람이 고친 금액은 요금제·홀 수가 바뀌어도 그대로다.
    client.patch(f"{url}/players/{bob}", json={"cartFee": 15.0})
    kept = client.patch(f"{url}/players/{bob}", json={"ratePlan": "Public Senior"}).json()
    assert kept["players"][1]["cartFee"] == 15.0
    assert client.patch(url, json={"holes": 18}).json()["players"][1]["cartFee"] == 15.0

    # 끄면 0, 다시 켜면 새로 계산된다.
    off = client.patch(f"{url}/players/{bob}", json={"cart": False}).json()
    assert (off["players"][1]["cart"], off["players"][1]["cartFee"]) == (False, 0)
    assert off["audit"][0]["message"] == "Cart removed for Bob Public."
    assert client.patch(f"{url}/players/{bob}", json={"cart": True}).json()["players"][1]["cartFee"] == 17.70  # 위에서 Public Senior 로 바꿨다


def test_changing_holes_resets_the_green_fee_until_someone_pays(client):
    url, (ann, _) = _cart_booking(client)                 # 2026-09-08 화요일 → 18홀 $47.79, 9홀 $34.52
    assert client.patch(url, json={"holes": 9}).json()["rate"] == 34.52

    # 손으로 고친 금액(0033 때의 절반 요금 $23.90 같은 옛 값 포함)도 홀 수를 바꾸면 요금표 값이 된다.
    client.patch(url, json={"rate": 23.90})
    assert client.patch(url, json={"holes": 18}).json()["rate"] == 47.79

    # 같은 요청에 준 금액이 이긴다.
    assert client.patch(url, json={"holes": 9, "rate": 30.0}).json()["rate"] == 30.0

    # 한 명이라도 결제하면 그대로 둔다.
    client.patch(f"{url}/players/{ann}", json={"paid": True})
    assert client.patch(url, json={"holes": 18}).json()["rate"] == 30.0


def test_new_players_get_a_cart_fee_unless_one_is_given(client):
    url, _ = _cart_booking(client)
    added = client.post(f"{url}/players", json={"name": "Cy Senior", "ratePlan": "Public Senior", "cart": True})
    assert added.status_code == 200, added.text
    assert added.json()["players"][-1]["cartFee"] == 17.70

    comp = client.post(f"{url}/players", json={"name": "Di Comp", "cart": True, "cartFee": 0}).json()
    assert comp["players"][-1]["cartFee"] == 0              # 공짜 카트는 공짜로 남는다

    created = create(client, date="2026-09-08", time="9:31 AM", title="Ride, Along", players=[
        {"name": "Ed Ride", "ratePlan": "Public", "cart": True},
    ]).json()
    assert created["players"][0]["cartFee"] == 19.47
    assert client.get(f"{API}/tee-sheet/bookings/{created['id']}").json()["players"][0]["cartFee"] == 19.47

    # 예약을 만들 때 준 금액(공짜 카트 0 포함)도 자동값으로 덮이지 않는다.
    comped = create(client, date="2026-09-08", time="9:40 AM", title="Comp, Cart", players=[
        {"name": "Fay Comp", "ratePlan": "Public", "cart": True, "cartFee": 0},
    ]).json()
    assert comped["players"][0]["cartFee"] == 0

    # 음수 요금은 모델이 거절한다 (위 예약은 이미 4명이라 POST 로는 인원 제한과 구분이 안 된다).
    cy = added.json()["players"][-1]["id"]
    assert client.patch(f"{url}/players/{cy}", json={"cartFee": -1}).status_code == 422


def test_paid_at_is_stamped_by_the_server_and_cleared_on_unpay(client):
    url, (ann, bob) = _cart_booking(client)
    client.patch(f"{url}/players/{ann}", json={"cart": True})

    paid = client.patch(f"{url}/players/{ann}", json={"paid": True}).json()
    stamp = paid["players"][0]["paidAt"]
    assert stamp is not None
    assert paid["audit"][0]["message"] == "Payment recorded for Ann Senior."
    assert paid["players"][1]["paidAt"] is None

    # 이미 결제한 사람을 다시 결제로 표시해도 시각은 처음 그대로다.
    again = client.patch(f"{url}/players/{ann}", json={"paid": True}).json()
    assert again["players"][0]["paidAt"] == stamp

    # 결제한 사람의 카트 요금은 요금제를 바꿔도 움직이지 않는다 (재인쇄 영수증 = 받은 돈).
    client.patch(f"{url}/players/{ann}", json={"cartFee": 11.5})
    assert (
        client.patch(f"{url}/players/{ann}", json={"ratePlan": "Public"}).json()["players"][0]["cartFee"] == 11.5
    )

    unpaid = client.patch(f"{url}/players/{ann}", json={"paid": False}).json()
    assert unpaid["players"][0]["paidAt"] is None
    assert unpaid["audit"][0]["message"] == "Payment cleared for Ann Senior."

    # 예약 단위 Collect All 도 시각을 찍고, 되살리면 지운다.
    collected = client.patch(url, json={"status": "paid"}).json()
    assert all(p["paidAt"] for p in collected["players"])
    reinstated = client.patch(url, json={"status": "reserved"}).json()
    assert all(p["paidAt"] is None for p in reinstated["players"])


def test_daily_report_counts_cart_fees(client):
    url, (ann, bob) = _cart_booking(client)
    base = 32 * 47.79                                       # 시드 예약 (카트 켠 사람 없음)
    seat = client.get(url).json()["rate"]

    client.patch(f"{url}/players/{ann}", json={"cart": True})       # 17.70 (Public Senior)
    client.patch(f"{url}/players/{bob}", json={"cart": True})       # 19.47
    client.patch(f"{url}/players/{ann}", json={"paid": True})

    report = client.get(f"{API}/tee-sheet/reports/daily", params={"date": "2026-09-08"}).json()
    assert report["total_revenue"] == pytest.approx(base + 2 * seat + 17.70 + 19.47, abs=0.01)
    assert report["collected_revenue"] == pytest.approx(seat + 17.70, abs=0.01)
    assert report["outstanding_revenue"] == pytest.approx(base + seat + 19.47, abs=0.01)


def test_player_guards(client):
    # 예약 하나가 담을 수 있는 인원(8명)을 넘기면 422. 티 타임 정원 초과(409)보다 먼저 걸린다.
    full = f"{API}/tee-sheet/bookings/b-xeric"          # 4명 -> 여분 4명까지 들어간다
    for n in range(5, 9):
        grew = client.post(f"{full}/players", json={"name": f"Wheel {n}"})
        assert grew.status_code == 200, grew.text
    too_many = client.post(f"{full}/players", json={"name": "Ninth Wheel"})
    assert too_many.status_code == 422
    assert "at most 8 players" in too_many.json()["detail"]

    single = create(client, date="2026-09-08", time="9:22 AM", title="Solo, Han",
                    players=[{"name": "Han Solo"}]).json()
    player_id = single["players"][0]["id"]
    last_one = client.delete(f"{API}/tee-sheet/bookings/{single['id']}/players/{player_id}")
    assert last_one.status_code == 422
    assert "at least one player" in last_one.json()["detail"]


def test_add_player_rejected_when_the_whole_tee_time_is_full(client):
    """예약 자체는 8명 미만이지만 티 타임 전체가 8명이면 409 (자원 충돌)."""
    url = f"{API}/tee-sheet/bookings/b-willow"             # 7:43 AM, 2명 (+ b-cedar 2명)
    assert len(client.get(url).json()["players"]) == 2
    assert create(client, date="2026-09-08", time="7:43 AM", title="Extra, Ed",
                  players=party(4)).status_code == 201

    blocked = client.post(f"{url}/players", json={"name": "Ninth Wheel"})
    assert blocked.status_code == 409
    assert "only holds 8 players" in blocked.json()["detail"]
    assert len(client.get(url).json()["players"]) == 2    # 거절이 아무것도 바꾸지 않았다

    # 7:52 AM 도 여분까지 채워 합계 8명이면 1명짜리 b-brook 에도 못 넣는다.
    assert create(client, date="2026-09-08", time="7:52 AM", title="Extra, Ed",
                  players=party(4)).status_code == 201
    solo = f"{API}/tee-sheet/bookings/b-brook"
    assert client.post(f"{solo}/players", json={"name": "Sixth Wheel"}).status_code == 409

    # 자리가 남은 티 타임(7:25 AM, 2명)에는 들어간다.
    ok = client.post(f"{API}/tee-sheet/bookings/b-ridge/players", json={"name": "Third Wheel"})
    assert ok.status_code == 200, ok.text


def test_add_player_to_a_cancelled_booking_ignores_tee_time_capacity(client):
    """취소된 예약은 자리를 잡지 않는다. 그러니 그 인원 편집이 **무관한 다른 예약**에
    좌우되어서는 안 된다. 넘치는 걸 막는 건 되살리기 게이트다.
    """
    crowded = f"{API}/tee-sheet/bookings/b-willow"   # 7:43 AM, 2명 (b-cedar 과 티 타임 공유)
    quiet = f"{API}/tee-sheet/bookings/b-ridge"   # 7:25 AM, 2명 (같은 티 타임에 다른 예약 없음)

    for url in (crowded, quiet):
        assert client.patch(url, json={"status": "cancelled"}).status_code == 200

    # b-willow 가 비운 자리를 이웃 b-cedar 이 가져가 7:43 AM 의 8자리를 **혼자** 다 쓴다.
    neighbour = f"{API}/tee-sheet/bookings/b-cedar"
    for n in range(3, 9):
        grew = client.post(f"{neighbour}/players", json={"name": f"Wheel {n}"})
        assert grew.status_code == 200, grew.text
    assert len(client.get(neighbour).json()["players"]) == 8
    assert module.tee_time_players(module.read_bookings(), "2026-09-08", "7:43 AM") == 8

    # 이제 두 취소 예약은 이웃 사정이 정반대다. 그래도 **똑같이** 행동해야 한다.
    for url in (crowded, quiet):
        for n in range(3, 9):
            added = client.post(f"{url}/players", json={"name": f"Wheel {n}"})
            assert added.status_code == 200, f"{url}: {added.text}"
        assert len(client.get(url).json()["players"]) == 8
        # 예약 하나가 담을 수 있는 인원(8명) 제한은 취소돼도 그대로 살아 있다.
        ninth = client.post(f"{url}/players", json={"name": "Ninth Wheel"})
        assert ninth.status_code == 422
        assert "at most 8 players" in ninth.json()["detail"]

    # 8자리를 이웃이 다 쓰고 있는 쪽은 되살릴 수 없다 -> 오버플로 구멍이 아니다.
    blocked = client.patch(crowded, json={"status": "reserved"})
    assert blocked.status_code == 409
    assert "only holds 8 players" in blocked.json()["detail"]
    assert client.get(crowded).json()["status"] == "cancelled"

    # 조용한 티 타임의 예약은 8명 그대로 되살아난다.
    revived = client.patch(quiet, json={"status": "reserved"})
    assert revived.status_code == 200, revived.text
    assert len(revived.json()["players"]) == 8


# ===== 리포트 =========================================================

def test_daily_report_numbers(client):
    slots = slots_for(client, "2026-09-08")["slots"]
    report = client.get(f"{API}/tee-sheet/reports/daily", params={"date": "2026-09-08"}).json()

    assert report["date"] == "2026-09-08"
    assert report["total_slots"] == len(slots) * 4          # len(bookings)*4 가 아니다
    assert report["total_tee_times"] == 11                  # 예약 11건 (서로 다른 티 타임은 9개)
    assert report["booked_slots"] == 32
    assert report["available_slots"] == report["total_slots"] - 32
    assert report["total_revenue"] == pytest.approx(32 * 47.79, abs=0.01)
    assert report["collected_revenue"] == 0
    assert report["outstanding_revenue"] == pytest.approx(report["total_revenue"], abs=0.01)
    assert report["carts"] == 5
    assert report["checked_in"] == 0 and report["cancelled"] == 0 and report["no_show"] == 0
    assert report["occupancy_rate"] == pytest.approx(32 / report["total_slots"] * 100, abs=0.01)
    line = report["bookings"][0]
    assert line["title"] == "Xeric, Micah" and line["status"] == "reserved" and line["players"] == 4


def test_daily_report_revenue_reacts_to_paid_and_cancelled(client):
    client.patch(f"{API}/tee-sheet/bookings/b-ridge", json={"status": "paid"})       # 2명 x 47.79
    client.patch(f"{API}/tee-sheet/bookings/b-cedar", json={"status": "cancelled"})  # 2명 제외

    report = client.get(f"{API}/tee-sheet/reports/daily", params={"date": "2026-09-08"}).json()
    assert report["total_tee_times"] == 11          # 시트에는 여전히 11건
    assert report["cancelled"] == 1
    assert report["booked_slots"] == 30             # 취소된 2명 제외
    assert report["total_revenue"] == pytest.approx(30 * 47.79, abs=0.01)
    assert report["collected_revenue"] == pytest.approx(2 * 47.79, abs=0.01)
    assert report["outstanding_revenue"] == pytest.approx(28 * 47.79, abs=0.01)
    assert report["carts"] == 5 - 0                 # b-cedar 은 카트 0대였다


def test_week_report_explicit_range(client):
    report = client.get(
        f"{API}/tee-sheet/reports/week", params={"from": "2026-09-07", "to": "2026-09-13"}
    ).json()

    assert report["from"] == "2026-09-07" and report["to"] == "2026-09-13"
    assert len(report["days"]) == 7
    assert [d["date"] for d in report["days"]][0] == "2026-09-07"
    assert report["summary"]["total_days"] == 7
    assert report["summary"]["total_tee_times"] == 11
    assert report["summary"]["total_booked_slots"] == 32
    assert report["summary"]["total_revenue"] == pytest.approx(32 * 47.79, abs=0.02)
    assert report["summary"]["collected_revenue"] == 0
    capacity = sum(d["total_slots"] for d in report["days"])
    assert report["summary"]["average_occupancy"] == pytest.approx(32 / capacity * 100, abs=0.01)


def test_week_report_defaults_to_current_iso_week(client):
    report = client.get(f"{API}/tee-sheet/reports/week").json()
    assert len(report["days"]) == 7
    monday = date.fromisoformat(report["from"])
    assert monday.weekday() == 0
    assert date.fromisoformat(report["to"]) - monday == timedelta(days=6)


def test_week_report_rejects_inverted_range(client):
    bad = client.get(f"{API}/tee-sheet/reports/week", params={"from": "2026-09-13", "to": "2026-09-07"})
    assert bad.status_code == 422


# ===== cleanup ========================================================

def test_cleanup_actually_deletes(client):
    # 시드(11건, 2026-09-08)보다 나중 날짜에 한 건 만들어 두고 그 앞을 전부 지운다.
    later = create(client, date="2026-09-12", time="9:04 AM", title="Later, Sam",
                   players=[{"name": "Sam Later"}])
    assert later.status_code == 201, later.text

    ack = client.post(f"{API}/tee-sheet/orchestration/cleanup", params={"before": "2026-09-12"})
    assert ack.status_code == 200
    body = ack.json()
    assert body["accepted"] is True and len(body["tasks"]) == 1
    assert body["tasks"][0]["state"] == "queued"

    finished = wait_for_tasks(client, [body["tasks"][0]["id"]])[body["tasks"][0]["id"]]
    assert finished["state"] == "success", finished
    assert finished["result"]["deleted"] == 11
    assert finished["result"]["remaining"] == 1
    assert finished["duration_ms"] is not None

    survivors = client.get(f"{API}/tee-sheet/bookings").json()
    assert len(survivors) == 1
    assert {b["date"] for b in survivors} == {"2026-09-12"}


def test_cleanup_is_idempotent(client):
    for expected in (11, 0):
        ack = client.post(f"{API}/tee-sheet/orchestration/cleanup", params={"before": "2026-09-09"}).json()
        task_id = ack["tasks"][0]["id"]
        result = wait_for_tasks(client, [task_id])[task_id]["result"]
        assert result["deleted"] == expected


# ===== worker sync pass ===============================================

def test_worker_is_deterministic_and_never_random(client):
    # 반드시 "먼 미래" 날짜로 돌린다. 시드 날짜(2026-09-08)는 실행 시점에 따라 이미
    # 지나간 티 타임이 되어 워커가 no_show 로 넘겨 버리고, 그러면 결과가 시각에 따라 흔들린다.
    future = (date.today() + timedelta(days=400)).isoformat()
    # 카트 수가 인원보다 많은 예약을 하나 만들어 둔다 -> 안정적인 finding 소스
    made = create(client, date=future, time="7:25 AM", title="Future, Fay",
                  cartCount=4, players=[{"name": "Fay Future"}, {"name": "Guest"}])
    assert made.status_code == 201, made.text

    runs = []
    for _ in range(3):
        ack = client.post(f"{API}/tee-sheet/worker/run", params={"date": future}).json()
        task_id = ack["tasks"][0]["id"]
        runs.append(wait_for_tasks(client, [task_id])[task_id]["result"])

    assert runs[0] == runs[1] == runs[2], "sync pass must be deterministic"
    assert runs[0]["scanned"] == 1
    assert runs[0]["updated"] == 0           # 미래 날짜라 아무것도 바뀌면 안 된다
    issues = [f["issue"] for f in runs[0]["findings"]]
    assert issues == ["cart_count_exceeds_players"]

    # 예약 상태도 전혀 변하지 않았어야 한다
    statuses = {b["status"] for b in client.get(f"{API}/tee-sheet/bookings").json()}
    assert statuses == {"reserved"}


def test_worker_marks_stale_reservations_no_show_once(client):
    past = (date.today() - timedelta(days=400)).isoformat()
    stale = create(client, date=past, time="6:40 AM", title="Stale, Sam",
                   players=[{"name": "Sam Stale"}]).json()

    ack = client.post(f"{API}/tee-sheet/worker/run", params={"date": past}).json()
    first = wait_for_tasks(client, [ack["tasks"][0]["id"]])[ack["tasks"][0]["id"]]["result"]
    assert first["updated"] == 1
    assert first["findings"][0]["issue"] == "past_tee_time_still_reserved"
    assert first["findings"][0]["action"] == "marked_no_show"

    booking = client.get(f"{API}/tee-sheet/bookings/{stale['id']}").json()
    assert booking["status"] == "no_show"
    assert booking["players"][0]["no_show"] is True

    # 두 번째 호출은 더 이상 아무것도 바꾸지 않는다
    ack2 = client.post(f"{API}/tee-sheet/worker/run", params={"date": past}).json()
    second = wait_for_tasks(client, [ack2["tasks"][0]["id"]])[ack2["tasks"][0]["id"]]["result"]
    assert second["updated"] == 0
    assert second["findings"] == []
    assert client.get(f"{API}/tee-sheet/bookings/{stale['id']}").json()["status"] == "no_show"


# ===== 오케스트레이션 =================================================

def test_orchestration_status_shape(client):
    status = client.get(f"{API}/tee-sheet/orchestration/status").json()
    assert status["status"] == "ready"
    assert status["total_bookings"] == 11
    assert status["tasks"] == []
    names = {t["name"] for t in status["available_tasks"]}
    assert names == {"daily_batch", "send_reminders", "cleanup", "worker_sync"}
    assert all({"name", "description", "endpoint"} <= set(t) for t in status["available_tasks"])


def test_daily_batch_runs_subtasks_in_parallel(client):
    ack = client.post(f"{API}/tee-sheet/orchestration/daily-batch", params={"date": "2026-09-08"})
    assert ack.status_code == 200
    body = ack.json()
    assert body["accepted"] is True
    assert len(body["tasks"]) == 1
    task_id = body["tasks"][0]["id"]
    assert body["tasks"][0]["state"] == "queued"
    assert body["tasks"][0]["finished_at"] is None

    task = wait_for_tasks(client, [task_id])[task_id]
    assert task["state"] == "success", task
    assert task["started_at"] is not None and task["finished_at"] is not None
    assert task["error"] is None

    result = task["result"]
    assert result["failed_subtasks"] == 0
    subtasks = {s["task"]: s for s in result["subtasks"]}
    assert set(subtasks) == {"send_reminders", "generate_report", "refresh_availability"}
    assert all(s["status"] == "success" for s in subtasks.values())
    assert subtasks["generate_report"]["total_tee_times"] == 11   # 예약 건수
    assert subtasks["refresh_availability"]["taken_slots"] == 9    # 서로 다른 티 타임 수

    # 진짜 병렬인지: 벽시계 시간이 각 파트 합보다 확연히 작아야 한다.
    parts = [s["duration_ms"] for s in result["subtasks"]]
    assert result["sequential_ms"] == sum(parts)
    assert result["duration_ms"] < result["sequential_ms"] * 0.75, result
    assert result["duration_ms"] < max(parts) + 200, result
    assert result["speedup"] > 1.3


def test_send_reminders_task_reaches_terminal_state(client):
    ack = client.post(f"{API}/tee-sheet/orchestration/send-reminders", params={"date": "2026-09-08"}).json()
    task_id = ack["tasks"][0]["id"]
    task = wait_for_tasks(client, [task_id])[task_id]
    assert task["state"] == "success"
    assert task["result"]["bookings"] == 11
    assert task["result"]["recipients"] == 32


def test_task_failure_is_recorded_not_crashed(client, monkeypatch):
    def boom(_iso_date):
        raise RuntimeError("mail gateway down")

    monkeypatch.setattr(module, "send_reminders", boom)
    ack = client.post(f"{API}/tee-sheet/orchestration/send-reminders", params={"date": "2026-09-08"}).json()
    task_id = ack["tasks"][0]["id"]
    task = wait_for_tasks(client, [task_id])[task_id]
    assert task["state"] == "failed"
    assert "mail gateway down" in task["error"]
    assert task["finished_at"] is not None
    # 서버는 살아 있어야 한다
    assert client.get(f"{API}/tee-sheet/bookings").status_code == 200


def test_task_registry_is_capped(client):
    ids = []
    for _ in range(module.MAX_TASKS + 5):
        ack = client.post(f"{API}/tee-sheet/orchestration/send-reminders",
                          params={"date": "2026-09-08"}).json()
        ids.append(ack["tasks"][0]["id"])
    wait_for_tasks(client, ids[-5:], timeout=30.0)
    tasks = client.get(f"{API}/tee-sheet/orchestration/status").json()["tasks"]
    assert len(tasks) == module.MAX_TASKS
    assert tasks[0]["id"] == ids[-1]        # 최신순


def test_orchestration_rejects_bad_date(client):
    assert client.post(f"{API}/tee-sheet/orchestration/daily-batch",
                       params={"date": "11/09/2026"}).status_code == 422
