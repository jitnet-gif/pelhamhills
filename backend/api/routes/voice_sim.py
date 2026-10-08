"""전화·문자 비서의 실내 골프(시뮬레이터) 도구: 빈 시간 찾기 / 예약 / 조회 / 취소.

티타임 도구(`voice.py`)와 나란히 있지만 저장소가 다르다. 시뮬레이터 예약의 진실은
Supabase 의 `pelham_sim_reservations` 이고, 손님 웹(`/book/indoor`)·Bay Sheet 가 같은
표에 쓴다. 그래서 여기서는 **SQL 함수만** 부른다(`supabase/migrations/0016_phone_sim_booking.sql`).
옛 `routes/simulator.py`(JSON 파일)는 쓰지 않는다 — 잠금이 따로라 같은 베이를 두 번 판다.

## 티타임과 다른 점

- **홀드가 없다.** 티타임은 한 자리에 여럿이 나눠 앉아 홀드가 필요했지만, 베이는 예약
  한 건이 통째로 쓴다. 이름을 받은 뒤 `book_sim_bay` 한 번으로 잡고 확정한다. 그 사이
  팔렸으면 409 가 돌아오고 비서가 다른 시간을 제안한다.
- **베이를 고르지 않는다.** 베이 3개가 전부 좌우 겸용이다(0009). 빈 베이 중 번호가 낮은
  곳으로 들어간다.
- **취소 마감은 손님 웹과 같다**: 시작 24시간 전. 티타임 전화 취소의 2시간이 아니다.
  규칙은 SQL(`pelham_sim_phone_block`)에 있고 여기서 다시 세지 않는다.

## 본인 확인

티타임과 같다. 전화는 번호 **와** 성으로 `lookup_sim_booking` 이 찾아 준 예약만
(`_Session.revealed` 에 `sim:<id>` 로 담는다 — 티타임 id 와 섞이지 않게) 취소할 수 있다.
문자에는 조회 도구가 없고, 확인 문자의 코드로 `C <코드>` 답장을 받는다(`routes/sms.py`).
"""

from __future__ import annotations

import logging
import re
from typing import Any, Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel, Field

from backend.api.routes import voice
from backend.api.routes.retail import TAX_RATE
from backend.core.config import settings
from backend.services import supabase_rest
from backend.services.barcode_png import barcode_url
from backend.services.twilio_sms import send_sms

logger = logging.getLogger(__name__)

# 시크릿 검사는 `voice.tools_router` 와 같다. 라우터 레벨에 걸어 도구를 더해도 빠지지 않게.
router = APIRouter(dependencies=[Depends(voice.require_tool_secret)])

MAX_PLAYERS = 4
MAX_HOURS = 5
UNAVAILABLE = (
    "The simulator booking system is not reachable right now. Offer to transfer the caller "
    "to the pro shop."
)


# ===== Supabase 호출 ===================================================

def _rpc(function: str, args: dict[str, Any]) -> Any:
    """SQL 거절은 그 상태·문장 그대로, 연결 실패는 503 으로."""
    try:
        return supabase_rest.rpc(function, args)
    except supabase_rest.RpcRefused as exc:
        raise HTTPException(status_code=exc.status, detail=exc.message) from None
    except supabase_rest.SupabaseUnavailable:
        raise HTTPException(status_code=503, detail=UNAVAILABLE) from None


def availability(iso_date: str, hours: int) -> dict[str, Any]:
    return _rpc("pelham_sim_phone_availability", {"p_date": iso_date, "p_duration_hours": hours})


def reserve(**fields: Any) -> dict[str, Any]:
    return _rpc("pelham_sim_phone_reserve", {"p": fields})


def find(phone: str, *, last_name: str | None = None, code: str | None = None) -> list[dict[str, Any]]:
    return _rpc(
        "pelham_sim_phone_find", {"p_phone": phone, "p_last_name": last_name, "p_code": code}
    ) or []


def cancel(
    reservation_id: int,
    *,
    phone: str | None = None,
    last_name: str | None = None,
    preview: bool = False,
    via: str = "phone",
) -> dict[str, Any]:
    return _rpc(
        "pelham_sim_phone_cancel",
        {"p_id": reservation_id, "p_phone": phone, "p_last_name": last_name,
         "p_preview": preview, "p_via": via},
    )


# ===== 시각 =============================================================

_TIME_RE = re.compile(r"^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?$", re.IGNORECASE)


def to_hhmm(label: str) -> str:
    """"3:00 PM" · "3 PM" · "15:00" → "15:00". 시뮬레이터는 오후·저녁만 열어서 오전/오후
    표시가 없는 "7:30" 같은 말은 저녁으로 읽는다 (영업이 14:00-22:00)."""
    match = _TIME_RE.match((label or "").strip())
    if not match:
        raise HTTPException(
            status_code=422,
            detail="Send the time exactly as find_sim_times returned it, for example '3:00 PM'.",
        )
    hour, minute, half = int(match.group(1)), int(match.group(2) or 0), (match.group(3) or "").upper()
    if half:
        hour = hour % 12 + (12 if half == "PM" else 0)
    elif hour < 12:
        hour += 12
    if hour > 23 or minute > 59:
        raise HTTPException(status_code=422, detail=f"{label} is not a time.")
    return f"{hour:02d}:{minute:02d}"


def to_label(hhmm: str) -> str:
    """"15:00" → "3:00 PM" (티타임 도구와 같은 꼴)."""
    hour, minute = (int(part) for part in hhmm.split(":"))
    return f"{hour % 12 or 12}:{minute:02d} {'AM' if hour < 12 else 'PM'}"


def _hours_word(hours: int) -> str:
    return f"{hours} hour{'' if hours == 1 else 's'}"


def _with_tax(amount: float) -> float:
    return round(amount * (1 + TAX_RATE), 2)


# ===== 요청 · 응답 모델 ================================================

class FindSimTimesRequest(voice._VoiceRequest):
    date: str = Field(..., description="ISO date (YYYY-MM-DD), or 'today' / 'tomorrow'.")
    duration_hours: int = Field(default=1, ge=1, le=MAX_HOURS)
    earliest: str = Field(default="", max_length=10, description="Like '6:00 PM'. Empty if any time.")


class SimTimeOption(BaseModel):
    time: str
    free_bays: int


class FindSimTimesResponse(BaseModel):
    ok: bool
    date: str
    spoken_date: str
    duration_hours: int
    total_open: int
    options: list[SimTimeOption]
    price: float
    price_with_tax: float
    message: str


class BookSimRequest(voice._VoiceRequest):
    date: str
    time: str = Field(..., description="One of the times find_sim_times returned, e.g. '3:00 PM'.")
    duration_hours: int = Field(default=1, ge=1, le=MAX_HOURS)
    players: int = Field(default=1, ge=1, le=MAX_PLAYERS)
    first_name: str = Field(..., min_length=1, max_length=60)
    last_name: str = Field(..., min_length=1, max_length=60)
    #: 손님이 **다른** 번호를 불러 줬을 때만. 비면 발신번호.
    phone: str = Field(default="", max_length=40)
    #: 전화선의 발신번호 (`system__caller_id`), 문자면 Twilio 의 `From`. LLM 이 채우지 않는다.
    caller_number: str = Field(default="", max_length=40)


class SimBookingSummary(BaseModel):
    reservation_id: str
    confirmation_code: str
    date: str
    spoken_date: str
    time: str
    duration_hours: int
    players: int
    bay_number: int
    name: str
    price: float
    price_with_tax: float
    status: str
    cancellable: bool
    #: 취소할 수 없으면 그 이유 (예: "it starts in less than 24 hours").
    reason: Optional[str] = None


class BookSimResponse(BaseModel):
    ok: bool
    booking: SimBookingSummary
    message: str


class LookupSimRequest(voice._VoiceRequest):
    phone: str = Field(..., min_length=7, max_length=40)
    last_name: str = Field(..., min_length=1, max_length=60)


class LookupSimResponse(BaseModel):
    ok: bool
    found: int
    bookings: list[SimBookingSummary]
    message: str


class CancelSimRequest(voice._VoiceRequest):
    reservation_id: str
    last_name: str = Field(..., min_length=1, max_length=60)
    preview: bool = False


class CancelSimResponse(BaseModel):
    ok: bool
    cancelled: bool
    booking: SimBookingSummary
    message: str


def summary(row: dict[str, Any]) -> SimBookingSummary:
    price = float(row.get("total_price") or 0)
    return SimBookingSummary(
        reservation_id=str(row["id"]),
        confirmation_code=row["confirmation_code"],
        date=row["date"],
        spoken_date=voice.spoken_date(row["date"]),
        time=to_label(row["start_time"]),
        duration_hours=row["duration_hours"],
        players=row["player_count"],
        bay_number=row["bay_number"],
        name=row.get("customer_name") or "",
        price=price,
        price_with_tax=_with_tax(price),
        status=row["status"],
        cancellable=bool(row.get("cancellable")),
        reason=row.get("reason"),
    )


def _session_key(reservation_id: str | int) -> str:
    return f"sim:{reservation_id}"


# ===== 도구 1: 빈 시간 찾기 ============================================

@router.post("/voice/tools/find-sim-times", response_model=FindSimTimesResponse)
def find_sim_times(body: FindSimTimesRequest) -> FindSimTimesResponse:
    voice._touch_session(body.conversation_id)
    iso_date = voice.resolve_date(body.date)
    voice.require_bookable_date(iso_date)
    floor = to_hhmm(body.earliest) if body.earliest.strip() else ""

    data = availability(iso_date, body.duration_hours)
    spoken = voice.spoken_date(iso_date)
    price = float(data.get("hourly_rate") or 0) * body.duration_hours
    options = [
        SimTimeOption(time=to_label(slot["time"]), free_bays=slot["free_bays"])
        for slot in data.get("slots") or []
        if not floor or slot["time"] >= floor
    ]

    if not options:
        reason = data.get("reason") or "Nothing is open then."
        if floor and not data.get("is_closed"):
            reason = f"Nothing is open from {to_label(floor)} on for {_hours_word(body.duration_hours)}."
        return FindSimTimesResponse(
            ok=False, date=iso_date, spoken_date=spoken, duration_hours=body.duration_hours,
            total_open=0, options=[], price=price, price_with_tax=_with_tax(price),
            message=f"{reason} Offer the caller a different day or time.",
        )

    picked = voice._spread(options, voice.MAX_OPTIONS)
    times = ", ".join(option.time for option in picked)
    return FindSimTimesResponse(
        ok=True,
        date=iso_date,
        spoken_date=spoken,
        duration_hours=body.duration_hours,
        total_open=len(options),
        options=picked,
        price=price,
        price_with_tax=_with_tax(price),
        message=(
            f"A simulator bay is open for {_hours_word(body.duration_hours)} on {spoken} at "
            f"these start times: {times}. Read a few. The bay costs ${price:.2f} plus HST "
            f"(${_with_tax(price):.2f} total) for the whole group, paid at the club."
        ),
    )


# ===== 도구 2: 예약 ====================================================

@router.post("/voice/tools/book-sim-bay", response_model=BookSimResponse)
def book_sim_bay(body: BookSimRequest, background: BackgroundTasks) -> BookSimResponse:
    session = voice._touch_session(body.conversation_id)
    iso_date = voice.resolve_date(body.date)
    voice.require_bookable_date(iso_date)

    first, last = body.first_name.strip(), body.last_name.strip()
    spoken_phone = body.phone.strip()
    # 티타임 확정(`voice.confirm_booking`)과 같다: 발신번호가 기본, 다른 번호를 불러 줬을 때만 그것.
    phone = spoken_phone if voice.normalize_phone(spoken_phone) else body.caller_number.strip()
    if len(voice.normalize_phone(phone)) != 10:
        raise HTTPException(
            status_code=422,
            detail=(
                "No usable phone number for this booking. Ask the caller to say the number "
                "digit by digit and send just the digits — never a placeholder word."
            ),
        )

    by_text = (body.conversation_id or "").startswith("sms:")
    row = reserve(
        date=iso_date,
        start_time=to_hhmm(body.time),
        duration_hours=body.duration_hours,
        player_count=body.players,
        customer_name=f"{first} {last}",
        phone=phone,
        via="text" if by_text else "phone",
    )
    booked = summary(row)

    if session is not None:
        # 같은 통화에서 손님이 말을 바꾸면 바로 취소할 수 있게.
        session.revealed.add(_session_key(booked.reservation_id))

    code = booked.confirmation_code
    background.add_task(
        send_sms,
        phone,
        (
            f"{voice.CLUB_NAME}: simulator bay booked, {booked.spoken_date} at {booked.time} for "
            f"{_hours_word(booked.duration_hours)}. Confirmation #{code}. "
            f"To cancel, reply C {code} (up to 24 hours before) or call {settings.PROSHOP_PHONE_NUMBER}. "
            "Show this barcode at the front desk when you check in."
        ),
        template="confirm",
        booking_ref=code,
        media_url=barcode_url(code),
    )

    return BookSimResponse(
        ok=True,
        booking=booked,
        message=(
            f"Booked. {first} {last}, Bay {booked.bay_number}, {booked.spoken_date} at {booked.time} "
            f"for {_hours_word(booked.duration_hours)}. ${booked.price:.2f} plus HST "
            f"(${booked.price_with_tax:.2f}), paid at the club. A text with the confirmation number, "
            "how to cancel, and a barcode for check-in is on its way; read the number back one "
            "character at a time."
        ),
    )


# ===== 도구 3: 조회 ====================================================

@router.post("/voice/tools/lookup-sim-booking", response_model=LookupSimResponse)
def lookup_sim_booking(body: LookupSimRequest) -> LookupSimResponse:
    """번호 **와** 성이 둘 다 맞는 다가오는 시뮬레이터 예약. 티타임 `lookup_booking` 과 같은 문."""
    session = voice._touch_session(body.conversation_id)
    if len(voice.normalize_phone(body.phone)) != 10:
        raise HTTPException(
            status_code=422,
            detail="That phone number did not come through. Ask the caller to repeat it.",
        )

    found = [summary(row) for row in find(body.phone, last_name=body.last_name.strip())]
    if session is not None:
        session.revealed.update(_session_key(b.reservation_id) for b in found)

    if not found:
        return LookupSimResponse(
            ok=False, found=0, bookings=[],
            message=(
                "No upcoming simulator booking matches that phone number and last name. Offer "
                "to transfer the caller to the pro shop rather than guessing."
            ),
        )
    spoken = "; ".join(
        f"{b.spoken_date} at {b.time} for {_hours_word(b.duration_hours)}" for b in found
    )
    word = "booking" if len(found) == 1 else "bookings"
    return LookupSimResponse(
        ok=True,
        found=len(found),
        bookings=found,
        message=(
            f"Found {len(found)} upcoming simulator {word}: {spoken}. Read the details back and "
            "ask the caller to confirm before changing anything."
        ),
    )


# ===== 도구 4: 취소 ====================================================

@router.post("/voice/tools/cancel-sim-booking", response_model=CancelSimResponse)
def cancel_sim_booking(body: CancelSimRequest, background: BackgroundTasks) -> CancelSimResponse:
    """이 통화에서 조회로 확인된 예약만. 세션이 없으면 거절한다 (`voice.cancel_booking` 참고)."""
    session = voice._touch_session(body.conversation_id)
    if session is None or _session_key(body.reservation_id) not in session.revealed:
        raise HTTPException(
            status_code=403,
            detail=(
                "Look the simulator booking up first with the caller's phone number and last "
                "name. Only a booking confirmed on this call can be cancelled."
            ),
        )
    try:
        reservation_id = int(body.reservation_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="That simulator booking is not on the sheet.") from None

    try:
        row = cancel(reservation_id, last_name=body.last_name.strip(), preview=body.preview)
    except HTTPException as exc:
        if exc.status_code == 409:
            raise HTTPException(
                status_code=409, detail=f"{exc.detail} Offer to transfer the caller to the pro shop."
            ) from None
        raise
    booking = summary(row)
    when = f"{booking.spoken_date} at {booking.time}"

    if row.get("already"):
        return CancelSimResponse(
            ok=True, cancelled=True, booking=booking,
            message="That simulator booking was already cancelled. There is nothing else to do.",
        )
    if body.preview:
        return CancelSimResponse(
            ok=True, cancelled=False, booking=booking,
            message=(
                f"This simulator booking can still be cancelled: {when}. Ask the caller to "
                "confirm, then call cancel_sim_booking again without preview. Do not quote a "
                "cancellation fee."
            ),
        )

    if row.get("phone"):
        background.add_task(
            send_sms,
            row["phone"],
            f"{voice.CLUB_NAME}: cancelled your simulator bay, {when}.",
            template="cancel",
            booking_ref=booking.confirmation_code,
        )
    return CancelSimResponse(
        ok=True, cancelled=True, booking=booking,
        message=f"Cancelled: the simulator bay on {when}. Tell the caller it is done.",
    )


def cancel_by_code(sender: str, code: str) -> str:
    """문자 "C <코드>" 의 시뮬레이터 쪽 (`routes/sms.py`). 손님에게 보낼 문장을 돌려준다.

    발신번호와 코드가 둘 다 맞는 예약만 취소한다. 코드는 확인 문자에만 실려 간다.
    """
    help_line = f"Call {settings.PROSHOP_PHONE_NUMBER} for help."
    try:
        rows = find(sender, code=code)
        if not rows:
            return f"Pelham Hills: no upcoming booking matches code {code} for this number. {help_line}"
        row = cancel(int(rows[0]["id"]), phone=sender, via="text")
    except HTTPException as exc:
        if exc.status_code == 409:
            return f"Pelham Hills: {exc.detail} {help_line}"
        if exc.status_code == 503:
            return f"Pelham Hills: we can't cancel by text right now. {help_line}"
        return f"Pelham Hills: no upcoming booking matches code {code} for this number. {help_line}"
    booking = summary(row)
    when = f"{booking.spoken_date} at {booking.time}"
    if row.get("already"):
        return f"Pelham Hills: your simulator bay on {when} was already cancelled."
    return f"Pelham Hills: cancelled your simulator bay, {when}. Hope to see you soon."
