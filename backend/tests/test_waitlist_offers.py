"""취소된 자리를 대기자에게 다시 판다: 홀드 → 문자 → YES 면 예약, 답이 없으면 다음 사람.

실행: `cd E:\\PELHAMHILLS && python -m pytest backend/tests/test_waitlist_offers.py -q`

대기자 표(Supabase)는 메모리 가짜로 바꾼다. 티 시트는 `test_voice_booking` 의 픽스처가
임시 파일로 돌린다.
"""

from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timedelta, timezone

import pytest

from backend.api.routes import sms
from backend.api.routes import tee_sheet as ts
from backend.api.routes import voice
from backend.services import supabase_rest, tee_waitlist, twilio_sms, waitlist_offers as wo
from backend.services.tee_sheet_store import Scope
from backend.tests.test_voice_booking import (  # noqa: F401
    API, TODAY, TOMORROW, book, cancel, client, lookup_first,
)

WAITER = "+15550001111"
SECOND = "+15550002222"
MORNING = datetime(2026, 9, 8, 10, 0, tzinfo=voice.CLUB_TIMEZONE)


class FakeWaitlist:
    def __init__(self) -> None:
        self.rows: list[dict] = []

    def add(self, eid, phone=WAITER, party=2, earliest="8:00 AM", latest="8:05 AM", date=TOMORROW):
        self.rows.append({
            "id": eid, "date": date, "earliest": earliest, "latest": latest,
            "party_size": party, "holes": 18, "first_name": "Ann", "last_name": f"Walton-{eid}",
            "phone": phone, "status": "waiting", "offered_time": None, "offered_at": None,
        })

    def row(self, eid):
        return next(r for r in self.rows if r["id"] == eid)

    def open_entries(self, date_from):
        return [dict(r) for r in self.rows
                if r["date"] >= date_from and r["status"] in ("waiting", "offered")]

    def claim_offer(self, entry_id, time_label):
        row = self.row(entry_id)
        if row["status"] != "waiting":
            return False
        row.update(status="offered", offered_time=time_label,
                   offered_at=datetime.now(timezone.utc).isoformat())
        return True

    def set_status(self, entry_id, status, *, only_from=None):
        row = self.row(entry_id)
        if only_from and row["status"] != only_from:
            return False
        row["status"] = status
        return True

    def select(self, table, params):
        return [r for r in self.rows if r["status"] == "expired"]


@pytest.fixture()
def wl(client, monkeypatch):
    fake = FakeWaitlist()
    for name in ("open_entries", "claim_offer", "set_status"):
        monkeypatch.setattr(tee_waitlist, name, getattr(fake, name))
    monkeypatch.setattr(supabase_rest, "select", fake.select)
    monkeypatch.setattr(voice, "club_now", lambda: MORNING)
    twilio_sms.opted_out.clear()
    return fake


def holds_on(date=TOMORROW):
    return [b for b in ts.read_bookings(Scope(dates={date}))
            if b.source == ts.BookingSource.VOICE_HOLD]


def fill_8_01(client):
    """8:01 AM 을 네 명으로 꽉 채운다. 대기자의 시간대(8:00~8:05)에 맞는 슬롯은 이것뿐."""
    return book(client, time="8:01 AM", party=4, conversation="c-booked")


def expire_offer(wl, eid):
    """15분이 지난 것처럼 만든다 (대기 줄과 홀드 둘 다)."""
    past = datetime.now(timezone.utc) - timedelta(minutes=wo.OFFER_MINUTES + 1)
    wl.row(eid)["offered_at"] = past.isoformat()
    with ts.bookings_tx(Scope(dates={TOMORROW})) as bookings:
        for b in bookings:
            if b.holdExpiresAt is not None:
                b.holdExpiresAt = past


# ===== 자리가 비면 잡아 두고 문자 ======================================

def test_a_full_slot_is_not_offered(wl, client):
    fill_8_01(client)
    wl.add("w1")
    assert wo.sweep() == []
    assert wl.row("w1")["status"] == "waiting"


def test_a_cancelled_seat_is_held_for_the_first_person_waiting(wl, client):
    booking = fill_8_01(client)
    wl.add("w1")
    lookup_first(client, "c-cancel")
    assert cancel(client, booking["booking_id"]).status_code == 200

    outbox = wo.sweep()

    assert [phone for phone, _ in outbox] == [WAITER]
    assert "8:01 AM" in outbox[0][1] and "Reply YES" in outbox[0][1]
    assert wl.row("w1")["status"] == "offered"
    [hold] = holds_on()
    assert hold.time == "8:01 AM" and len(hold.players) == 2
    # 잡아 둔 동안 다른 손님에게는 그 자리가 안 보인다.
    taken = ts.tee_time_players(ts.read_bookings(Scope(dates={TOMORROW})), TOMORROW, "8:01 AM")
    assert taken == 2


def test_one_person_gets_one_offer_at_a_time(wl, client):
    wl.add("w1")  # 내일은 비어 있다 → 8:01 이 바로 열려 있다
    wo.sweep()
    assert wo.sweep() == []
    assert len(holds_on()) == 1


def test_the_seat_is_not_offered_twice_in_one_pass(wl, client):
    """두 자리만 비었는데 둘 다 두 명이면, 첫 사람만 받는다."""
    book(client, time="8:01 AM", party=2, conversation="c-booked")
    wl.add("w1")
    wl.add("w2", phone=SECOND)
    outbox = wo.sweep()
    assert [phone for phone, _ in outbox] == [WAITER]
    assert wl.row("w2")["status"] == "waiting"


def test_nothing_is_offered_at_night(wl, client, monkeypatch):
    monkeypatch.setattr(voice, "club_now", lambda: MORNING.replace(hour=22))
    wl.add("w1")
    assert wo.sweep() == []
    assert holds_on() == []


def test_a_tee_time_too_soon_to_reach_is_not_offered(wl, client):
    """10시에 15분 잡아 두고 2시간은 남아야 한다 → 12:15 이전 티타임은 건너뛴다."""
    wl.add("w1", date=TODAY, earliest="11:00 AM", latest="2:00 PM")
    [(_, text)] = wo.sweep()
    [hold] = holds_on(TODAY)
    assert ts.label_to_minutes(hold.time) >= 12 * 60 + 15
    assert hold.time in text


def test_a_waiter_who_wants_the_afternoon_does_not_block_the_queue(wl, client):
    wl.add("afternoon", earliest="1:00 PM", latest="1:05 PM")
    wl.add("anytime", phone=SECOND, earliest="8:00 AM", latest="8:05 AM")
    fill_slots = [s.time for s in ts.generate_slots(TOMORROW)
                  if 13 * 60 <= s.minutes <= 13 * 60 + 5]
    for i, time in enumerate(fill_slots):
        book(client, time=time, party=4, conversation=f"c-pm{i}")
    outbox = wo.sweep()
    assert [phone for phone, _ in outbox] == [SECOND]


# ===== 답장 ============================================================

def test_yes_turns_the_hold_into_a_booking(wl, client):
    wl.add("w1")
    wo.sweep()

    reply = wo.handle_reply(WAITER, "Yes!")

    assert "booked 2 players" in reply and "8:01 AM" in reply and "reply C" in reply
    assert wl.row("w1")["status"] == "booked"
    assert holds_on() == []
    [booking] = [b for b in ts.read_bookings(Scope(dates={TOMORROW}))
                 if b.source == ts.BookingSource.VOICE]
    assert booking.players[0].lastName == "Walton-w1"
    assert booking.holdExpiresAt is None
    assert "ask at check-in" in booking.notes  # 카트를 묻지 않았다


def test_yes_after_the_hold_ran_out_says_sorry(wl, client):
    wl.add("w1")
    wo.sweep()
    expire_offer(wl, "w1")
    wo.sweep()  # 넘긴다

    reply = wo.handle_reply(WAITER, "YES")

    assert "gone to the next golfer" in reply
    assert [b for b in ts.read_bookings(Scope(dates={TOMORROW}))
            if b.source == ts.BookingSource.VOICE] == []


def test_yes_when_the_seat_was_sold_meanwhile_says_sorry(wl, client, monkeypatch):
    """확인과 저장 사이에 홀드가 끝나 웹 손님이 그 자리를 샀다 → DB 트리거(0017)가 거절."""
    wl.add("w1")
    wo.sweep()
    real = ts.store.mutate

    class _Full(RuntimeError):
        code = "PT409"

    @contextmanager
    def rejecting(scope=None):
        with real(scope) as raw:
            yield raw
            raise _Full("tee time is full")

    monkeypatch.setattr(ts.store, "mutate", rejecting)
    reply = wo.handle_reply(WAITER, "YES")
    monkeypatch.setattr(ts.store, "mutate", real)

    assert "gone to the next golfer" in reply
    assert wl.row("w1")["status"] == "expired"
    assert [b for b in ts.read_bookings(Scope(dates={TOMORROW}))
            if b.source == ts.BookingSource.VOICE] == []


def test_no_answer_moves_the_seat_to_the_next_person(wl, client):
    book(client, time="8:01 AM", party=2, conversation="c-booked")  # 두 자리만 남는다
    wl.add("w1")
    wl.add("w2", phone=SECOND)
    wo.sweep()
    expire_offer(wl, "w1")

    outbox = wo.sweep()

    assert wl.row("w1")["status"] == "expired"
    assert [phone for phone, _ in outbox] == [SECOND]
    assert wl.row("w2")["status"] == "offered"


def test_no_releases_the_seat_at_once(wl, client):
    wl.add("w1")
    wo.sweep()

    reply = wo.handle_reply(WAITER, "no thanks")

    assert "passed that tee time on" in reply
    assert wl.row("w1")["status"] == "cancelled"
    assert holds_on() == []


def test_yes_without_an_offer_is_left_for_the_booking_assistant(wl, client):
    """문자 비서에게 "Yes" 라고 답한 손님의 대화를 가로채면 안 된다."""
    assert wo.handle_reply(WAITER, "Yes") is None
    assert wo.handle_reply(WAITER, "Yes but can I do 10am instead") is None


def test_inbound_yes_books_by_text(wl, client, monkeypatch):
    wl.add("w1")
    wo.sweep()

    async def params(_request):
        return {"From": WAITER, "To": "+12495550000", "Body": "YES", "MessageSid": "SM1"}

    monkeypatch.setattr(sms, "_twilio_params", params)
    client.app.include_router(sms.router, prefix=API)
    res = client.post(f"{API}/sms/inbound", data={})

    assert res.status_code == 200
    assert "booked 2 players" in res.text
    assert wl.row("w1")["status"] == "booked"


def test_without_twilio_nothing_is_held(wl, client, monkeypatch):
    """문자를 못 보내는데 자리를 15분씩 잡아 두면 그 자리는 아무도 못 산다."""
    import asyncio

    monkeypatch.setattr(wo.settings, "TWILIO_AUTH_TOKEN", "")
    wl.add("w1")
    asyncio.run(wo.run())
    assert holds_on() == []
