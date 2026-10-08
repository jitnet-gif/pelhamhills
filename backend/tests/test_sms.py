"""문자 계층 테스트: 확인 문자, "C <코드>" 답장 취소, 웹훅 서명, 리마인더.

실행: `cd E:\\PELHAMHILLS && python -m pytest backend/tests/test_sms.py -q`

예약은 음성 도구로 만든다 (`test_voice_booking` 의 픽스처와 헬퍼를 그대로 쓴다).
Twilio 키가 없으므로 실제 발송은 없고, 문자는 `skipped` 로 기록만 된다.
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from backend.api.routes import sms
from backend.api.routes import tee_sheet as ts
from backend.api.routes import voice
from backend.services import twilio_sms
from backend.services.tee_sheet_store import Scope
from backend.tests.test_voice_booking import API, TOMORROW, book, client  # noqa: F401

PHONE = "905-892-1234"


@pytest.fixture(autouse=True)
def clean_sms_log(monkeypatch):
    monkeypatch.setattr(twilio_sms.settings, "TWILIO_AUTH_TOKEN", "")
    twilio_sms.sms_messages.clear()
    twilio_sms.opted_out.clear()
    yield
    twilio_sms.sms_messages.clear()
    twilio_sms.opted_out.clear()


def status_of(booking_id: str) -> str:
    return next(b for b in ts.read_bookings(Scope(ids={booking_id})) if b.id == booking_id).status


def test_confirm_sends_a_text_with_the_confirmation_code(client):
    booking = book(client)

    sent = [m for m in twilio_sms.sms_messages if m.template == "confirm"]
    assert len(sent) == 1
    assert booking["confirmation_code"] in sent[0].body
    assert f"reply C {booking['confirmation_code']}" in sent[0].body
    assert "call" in sent[0].body  # 취소 방법: 답장 또는 프로 샵 전화
    assert sent[0].status == "skipped"  # 키가 없으니 보내지 않고 기록만
    assert sent[0].media_url is None  # 로컬은 공개 https 주소가 없어 바코드를 붙이지 않는다


def test_confirmation_code_is_six_digits(client):
    assert book(client)["confirmation_code"].isdigit()


def test_confirm_attaches_the_barcode_when_the_api_is_public(client, monkeypatch):
    monkeypatch.setenv("PUBLIC_API_BASE_URL", "https://example.test/api/v1")
    booking = book(client)

    [sent] = [m for m in twilio_sms.sms_messages if m.template == "confirm"]
    assert sent.media_url == f"https://example.test/api/v1/sms/barcode/{booking['confirmation_code']}.png"


def test_barcode_is_a_png_for_numeric_codes_only(client):
    client.app.include_router(sms.router, prefix=API)

    res = client.get(f"{API}/sms/barcode/482915.png")
    assert res.status_code == 200
    assert res.headers["content-type"] == "image/png"
    assert res.content.startswith(b"\x89PNG\r\n\x1a\n")

    assert client.get(f"{API}/sms/barcode/4F2K9Q.png").status_code == 404


def test_reply_with_the_old_letter_code_still_cancels(client):
    """숫자로 바뀌기 전에 확인 문자를 받은 손님도 그 코드로 취소할 수 있어야 한다."""
    booking = book(client)

    reply = sms.cancel_by_reply("+19058921234", voice._legacy_confirmation_code(booking["booking_id"]))

    assert "cancelled" in reply
    assert status_of(booking["booking_id"]) == ts.BookingStatus.CANCELLED


def test_reply_with_code_from_the_booking_phone_cancels(client):
    booking = book(client)

    reply = sms.cancel_by_reply("+19058921234", booking["confirmation_code"].lower())

    assert "cancelled" in reply
    assert status_of(booking["booking_id"]) == ts.BookingStatus.CANCELLED


def test_reply_from_another_phone_does_not_cancel(client):
    booking = book(client)

    reply = sms.cancel_by_reply("+12895550000", booking["confirmation_code"])

    assert "no upcoming booking" in reply
    assert status_of(booking["booking_id"]) == ts.BookingStatus.RESERVED


def test_reply_without_a_code_does_not_cancel(client):
    booking = book(client)

    reply = sms.cancel_by_reply("+19058921234", "")

    assert "code" in reply
    assert status_of(booking["booking_id"]) == ts.BookingStatus.RESERVED


def test_reply_close_to_tee_off_is_sent_to_the_pro_shop(client, monkeypatch):
    booking = book(client)
    monkeypatch.setattr(voice, "club_now", lambda: datetime(2026, 9, 9, 7, 0, tzinfo=voice.CLUB_TIMEZONE))

    reply = sms.cancel_by_reply("+19058921234", booking["confirmation_code"])

    assert "pro shop" in reply
    assert status_of(booking["booking_id"]) == ts.BookingStatus.RESERVED


def test_webhooks_are_refused_without_a_twilio_token(client):
    """토큰이 없으면 서명을 못 본다. 그때 열어 두면 From 위조로 남의 예약을 지울 수 있다."""
    client.app.include_router(sms.router, prefix=API)

    res = client.post(f"{API}/sms/inbound", data={"From": "+19058921234", "Body": "C 123456"})

    assert res.status_code == 403


def test_day_before_reminder_goes_once(client, monkeypatch):
    booking = book(client)  # 내일 8:01 AM
    with ts.bookings_tx(Scope(ids={booking["booking_id"]})) as bookings:
        for b in bookings:
            b.createdAt = datetime(2026, 9, 8, 10, 0, tzinfo=timezone.utc)

    evening = datetime(2026, 9, 8, 18, 30, tzinfo=voice.CLUB_TIMEZONE)
    monkeypatch.setattr(voice, "club_now", lambda: evening)

    first = sms._due_reminders()
    second = sms._due_reminders()

    assert len(first) == 1
    assert first[0][0] == PHONE
    assert "tomorrow at 8:01 AM" in first[0][1]
    assert second == []  # 감사 로그에 남겨서 두 번 보내지 않는다


def test_reminders_skip_bookings_that_did_not_come_by_phone(client, monkeypatch):
    booking = book(client)
    with ts.bookings_tx(Scope(ids={booking["booking_id"]})) as bookings:
        for b in bookings:
            b.source = ts.BookingSource.WEB
            b.createdAt = datetime(2026, 9, 8, 10, 0, tzinfo=timezone.utc)
    monkeypatch.setattr(voice, "club_now", lambda: datetime(2026, 9, 8, 18, 30, tzinfo=voice.CLUB_TIMEZONE))

    assert sms._due_reminders() == []


assert TOMORROW == "2026-09-09"  # 위 시각들은 이 날짜를 전제로 한다
