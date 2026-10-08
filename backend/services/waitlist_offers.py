"""빈자리를 대기자에게 다시 판다: 자리를 잡아 두고 문자 → YES 면 예약, 답이 없으면 다음 사람.

## 왜 "취소 이벤트" 가 아니라 "빈자리" 를 보나

취소는 여러 길로 들어온다. 전화 비서(`voice.cancel_booking`), 문자 답장
(`sms.cancel_by_reply`), 프로 샵 티 시트, 그리고 웹의 손님 취소
(`pelham_tee_guest_cancel`) — 마지막 것은 Postgres 안에서 끝나서 이 서버가 알 길이
없다. 취소마다 알림을 다는 대신, 1분마다 "대기자가 있는 날짜에 그 사람이 들어갈
자리가 있는가" 를 본다. 어느 길로 비었든 다음 패스가 찾는다. 전화·문자 취소는
기다리지 않게 바로 `run()` 을 한 번 더 부른다.

## 흐름

1. 자리가 맞는 첫 대기자에게 그 인원만큼 홀드(`VOICE_HOLD`)를 `OFFER_MINUTES` 동안
   건다. 홀드는 진짜 예약 레코드라 그동안 웹·전화에서 그 자리가 보이지 않는다.
2. 문자: "YES 로 답하면 예약됩니다".
3. YES → 홀드를 예약으로 바꾸고 확인 코드를 답장한다. NO → 바로 풀고 다음 사람.
4. 답이 없으면 홀드가 저절로 만료되고(정원 계산에서 빠진다), 대기자는 `expired`.
   다음 패스가 같은 자리를 다음 사람에게 건다.

## 새벽에는 보내지 않는다

밤 1시에 웹 취소가 나면, 아무도 답하지 않는 15분짜리 제안이 명단 끝까지 돌아 버린다.
`OFFER_HOURS` 밖에서 생긴 자리는 아침 첫 패스가 건다.

대기자 줄과 홀드는 홀드의 `notes` 에 적은 `waitlist:<id>` 로 잇는다. 표에 열을
더하지 않으려고 이렇게 했다 (SQL 을 또 실행하지 않아도 된다).
"""

from __future__ import annotations

import asyncio
import logging
import re
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import HTTPException

from backend.api.routes import tee_sheet as ts
from backend.api.routes import voice
from backend.core.config import settings
from backend.services import supabase_rest, tee_waitlist
from backend.services.tee_sheet_store import Scope
from backend.services.twilio_sms import opted_out, send_sms

logger = logging.getLogger(__name__)

#: 대기자에게 자리를 잡아 두는 시간.
OFFER_MINUTES = 15

#: 제안 문자를 보내는 시각(클럽 현지 시각, 시작 포함·끝 제외).
OFFER_HOURS = (7, 21)

#: 홀드가 끝난 뒤에도 티오프까지 이만큼은 남아야 건다. 답하자마자 출발해야 하는
#: 자리는 제안하지 않는다 — 전화·문자 취소 마감(2시간)과 같은 값이다.
MIN_LEAD_AFTER_HOLD = timedelta(minutes=voice.CANCEL_CUTOFF_MINUTES)

#: YES 로 읽는 답. 문장 전체가 짧을 때만 본다 — "Yes but can I do 10am" 은 예약이 아니다.
ACCEPT_WORDS = {"YES", "Y", "BOOK"}
DECLINE_WORDS = {"NO", "N", "PASS"}
MAX_REPLY_WORDS = 3

_lock = asyncio.Lock()


def _marker(entry_id: str) -> str:
    return f"waitlist:{entry_id}"


def _phone(value: str | None) -> str:
    return voice.normalize_phone(value or "")


def _offered_at(entry: dict[str, Any]) -> datetime | None:
    raw = entry.get("offered_at")
    if not raw:
        return None
    try:
        at = datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
    except ValueError:
        return None
    return at if at.tzinfo else at.replace(tzinfo=timezone.utc)


def _offer_live(entry: dict[str, Any], now: datetime) -> bool:
    at = _offered_at(entry)
    return (
        entry.get("status") == "offered"
        and at is not None
        and now < at + timedelta(minutes=OFFER_MINUTES)
    )


def _in_offer_hours(now_local: datetime) -> bool:
    start, end = OFFER_HOURS
    return start <= now_local.hour < end


# ===== 자리 찾기 + 홀드 ===============================================

def _first_fit(
    bookings: list[ts.TeeBooking], entry: dict[str, Any], now_local: datetime, now_utc: datetime
) -> ts.TeeSlot | None:
    """이 대기자가 들어갈 수 있는 그날 첫 슬롯. 규칙은 `voice.find_tee_times` 와 같다."""
    iso_date = entry["date"]
    party = int(entry.get("party_size") or 0)
    blocked = voice._blocked_times(bookings, iso_date)
    earliest_tee = now_local + timedelta(minutes=OFFER_MINUTES) + MIN_LEAD_AFTER_HOLD

    for slot in ts.generate_slots(iso_date):
        if slot.time in blocked or not voice._window_allows(entry, slot.minutes):
            continue
        at = voice.slot_datetime(iso_date, slot.time)
        if at is None or at < earliest_tee:
            continue
        taken = ts.tee_time_players(bookings, iso_date, slot.time, now=now_utc)
        if ts.PLAYERS_PER_TEE_TIME - taken >= party:
            return slot
    return None


def _hold_for(entry: dict[str, Any], slot: ts.TeeSlot, now_utc: datetime) -> ts.TeeBooking:
    name = " ".join(x for x in (entry.get("first_name"), entry.get("last_name")) if x)
    hold = ts.TeeBooking(
        date=entry["date"],
        time=slot.time,
        title=f"Waitlist hold - {entry.get('last_name') or 'guest'}",
        rate=slot.rate,
        color="gray",
        status=ts.BookingStatus.RESERVED,
        source=ts.BookingSource.VOICE_HOLD,
        holdExpiresAt=now_utc + timedelta(minutes=OFFER_MINUTES),
        notes=(
            f"Held for {name or 'a waitlisted golfer'} from the waitlist while we wait for a "
            f"YES by text ({OFFER_MINUTES} min). {_marker(entry['id'])}"
        ),
        players=[ts.Player(name="Guest", ratePlan="Public") for _ in range(int(entry["party_size"]))],
    )
    ts._audit(hold, f"Offered to the waitlist: {entry['party_size']} seats at {slot.time}.")
    return hold


def _remove_hold(iso_date: str, entry_id: str) -> None:
    """이 대기자에게 걸어 둔 홀드를 지운다 (아직 예약으로 바뀌지 않았을 때만)."""
    marker = _marker(entry_id)
    with ts.bookings_tx(Scope(dates={iso_date})) as bookings:
        bookings[:] = [
            b for b in bookings
            if not (b.source == ts.BookingSource.VOICE_HOLD and marker in b.notes)
        ]


def _offer_text(entry: dict[str, Any], slot_time: str) -> str:
    party = int(entry["party_size"])
    players = "player" if party == 1 else "players"
    return (
        f"{voice.CLUB_NAME}: a tee time opened on {voice.spoken_date(entry['date'])} at {slot_time} "
        f"for {party} {players}. We're holding it for you for {OFFER_MINUTES} minutes. "
        "Reply YES to book it, or NO to pass."
    )


def sweep() -> list[tuple[str, str]]:
    """한 패스. 만료된 제안을 정리하고 새 제안을 건다. 보낼 (번호, 문구) 목록을 돌려준다.

    동기 함수다 (저장소가 동기). `run()` 이 스레드에서 부른다.
    """
    now_local = voice.club_now()
    now_utc = datetime.now(timezone.utc)
    entries = tee_waitlist.open_entries(now_local.date().isoformat())

    # 1. 답이 없던 제안은 넘긴다. 홀드는 이미 만료돼 정원에서 빠져 있다.
    for entry in entries:
        if entry.get("status") == "offered" and not _offer_live(entry, now_utc):
            if tee_waitlist.set_status(entry["id"], "expired", only_from="offered"):
                entry["status"] = "expired"

    if not _in_offer_hours(now_local):
        return []

    # 한 번호에 살아 있는 제안은 하나만. YES 하나가 어느 자리인지 헷갈리면 안 된다.
    busy = {_phone(e.get("phone")) for e in entries if _offer_live(e, now_utc)}
    by_date: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for entry in entries:
        if entry.get("status") == "waiting":
            by_date[entry["date"]].append(entry)

    outbox: list[tuple[str, str]] = []
    for iso_date, waiting in sorted(by_date.items()):
        placed: list[tuple[dict[str, Any], str]] = []
        with ts.bookings_tx(Scope(dates={iso_date})) as bookings:
            for entry in waiting:  # 먼저 온 순서
                phone = _phone(entry.get("phone"))
                if not phone or phone in busy or phone in opted_out:
                    continue
                slot = _first_fit(bookings, entry, now_local, now_utc)
                if slot is None:
                    continue
                # 목록에 바로 넣는다 — 같은 패스의 뒷사람이 이 자리를 또 받지 않게.
                bookings.append(_hold_for(entry, slot, now_utc))
                placed.append((entry, slot.time))
                busy.add(phone)

        for entry, slot_time in placed:
            if tee_waitlist.claim_offer(entry["id"], slot_time):
                outbox.append((entry["phone"], _offer_text(entry, slot_time)))
            else:
                # 다른 패스가 먼저 이 사람에게 제안했다. 우리가 건 홀드는 걷는다.
                _remove_hold(iso_date, entry["id"])
    return outbox


async def run() -> None:
    """한 패스 돌리고 문자를 보낸다. 오류는 삼킨다 — 부르는 쪽(취소·리마인더 루프)을
    망치면 안 된다.

    Twilio 가 없으면 돌지 않는다. 보내지도 못할 문자 때문에 자리를 15분씩 잡아 두면
    그 자리는 아무도 못 산다.
    """
    if not settings.TWILIO_ENABLED:
        return
    from starlette.concurrency import run_in_threadpool

    async with _lock:
        try:
            outbox = await run_in_threadpool(sweep)
        except supabase_rest.SupabaseUnavailable:
            return
        except Exception as exc:  # 티 시트 오류 등
            logger.error("대기자 제안 패스 실패: %s", exc)
            return
    for phone, text in outbox:
        await send_sms(phone, text, template="waitlist_offer")


# ===== 손님 답장 ======================================================

def reply_word(body: str) -> str:
    """짧은 답장의 첫 단어가 YES/NO 류면 그 단어. 아니면 빈 문자열."""
    words = re.sub(r"[^\w\s]", "", body).upper().split()
    if not words or len(words) > MAX_REPLY_WORDS:
        return ""
    if words[0] in ACCEPT_WORDS or words[0] in DECLINE_WORDS:
        return words[0]
    return ""


def _sender_entries(sender: str) -> list[dict[str, Any]]:
    """이 번호의 대기 줄. 저장된 번호 꼴이 제각각이라(+1905…, 905-…) 양쪽을 맞춰 비교한다."""
    wanted = _phone(sender)
    if not wanted:
        return []
    rows = tee_waitlist.open_entries(voice.today_iso())
    return [e for e in rows if _phone(e.get("phone")) == wanted]


def _recently_expired(sender: str, now: datetime) -> bool:
    wanted = _phone(sender)
    rows = supabase_rest.select(
        tee_waitlist.TABLE,
        {"select": "phone,offered_at", "status": "eq.expired",
         "offered_at": f"gte.{(now - timedelta(hours=2)).isoformat()}", "limit": "20"},
    )
    return any(_phone(r.get("phone")) == wanted for r in rows)


def handle_reply(sender: str, body: str) -> str | None:
    """대기자 제안에 대한 YES/NO. 이 번호에 걸린 제안이 없으면 None — 다른 처리로 넘긴다."""
    word = reply_word(body)
    if not word:
        return None
    now = datetime.now(timezone.utc)
    help_line = f"Call {settings.PROSHOP_PHONE_NUMBER} for help."

    try:
        live = next((e for e in _sender_entries(sender) if _offer_live(e, now)), None)
        if live is None:
            if word in ACCEPT_WORDS and _recently_expired(sender, now):
                return (
                    f"Pelham Hills: sorry, that tee time was only held for {OFFER_MINUTES} minutes "
                    f"and has gone to the next golfer. {help_line}"
                )
            return None
    except supabase_rest.SupabaseUnavailable:
        return None

    if word in DECLINE_WORDS:
        try:
            tee_waitlist.set_status(live["id"], "cancelled", only_from="offered")
        except supabase_rest.SupabaseUnavailable:
            pass
        _remove_hold(live["date"], live["id"])
        return "Pelham Hills: no problem, we've passed that tee time on. You're off the waitlist for that day."

    return _accept(live, help_line)


def _accept(entry: dict[str, Any], help_line: str) -> str:
    marker = _marker(entry["id"])
    now = datetime.now(timezone.utc)
    first = (entry.get("first_name") or "").strip()
    last = (entry.get("last_name") or "").strip()

    try:
        with ts.bookings_tx(Scope(dates={entry["date"]})) as bookings:
            hold = next(
                (b for b in bookings
                 if b.source == ts.BookingSource.VOICE_HOLD and marker in b.notes),
                None,
            )
            if hold is None or ts.hold_expired(hold, now):
                hold = None
            else:
                party = len(hold.players)
                hold.players = [
                    ts.Player(firstName=first, lastName=last, phone=entry["phone"],
                              type=ts.PlayerType.EXISTING, ratePlan="Public"),
                    *[ts.Player(name="Guest", ratePlan="Public") for _ in range(party - 1)],
                ]
                hold.title = f"{last}, {first}".strip(", ") or "Waitlist"
                hold.holes = 9 if entry.get("holes") == 9 else 18
                hold.color = "blue"
                # VOICE 로 두어 전화·문자 예약과 똑같이 리마인더를 받고 "C <코드>" 로 취소된다.
                hold.source = ts.BookingSource.VOICE
                hold.holdExpiresAt = None
                # 대기 명단은 카트를 묻지 않는다. 계산서에 카트가 빠지지 않게 직원에게 남긴다.
                hold.notes = (
                    "Booked from the waitlist by text reply. Cart not asked - ask at check-in."
                )
                ts._audit(hold, f"Waitlist golfer {first} {last} ({entry['phone']}) replied YES.")
                summary = voice._summary(hold)
    except HTTPException as exc:
        # 확인과 저장 사이에 홀드가 만료됐고 그 자리를 웹·직원이 채웠다(0017 트리거).
        if exc.status_code != 409:
            raise
        hold = None

    if hold is None:
        try:
            tee_waitlist.set_status(entry["id"], "expired", only_from="offered")
        except supabase_rest.SupabaseUnavailable:
            pass
        return (
            f"Pelham Hills: sorry, that tee time was only held for {OFFER_MINUTES} minutes "
            f"and has gone to the next golfer. {help_line}"
        )

    try:
        tee_waitlist.set_status(entry["id"], "booked")
    except supabase_rest.SupabaseUnavailable:
        # 예약은 이미 됐다. 줄은 다음 패스가 `expired` 로 넘긴다 — 손님에게는 상관없다.
        pass
    # 다른 확정 문자와 같은 문장. 바코드는 이 답장을 돌려주는 `sms.inbound` 가 붙인다.
    return voice.confirmation_text(summary)
