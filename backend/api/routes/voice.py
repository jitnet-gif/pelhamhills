"""ElevenLabs 음성 에이전트가 티 시트를 쓰기 위한 도구 계층.

에이전트에게 `/tee-sheet/*` 를 그대로 주지 않는 이유는 세 가지다.

1. **권한.** 통화로 들어온 손님이 리포트를 뽑거나 남의 예약을 지울 수 있으면 안 된다.
   여기 있는 도구는 "빈 시간 찾기 / 잡기 / 반납 / 확정 / 조회 / 취소" 여섯 가지뿐이다.
2. **경합.** 손님이 "3시요" 라고 말하고 이름을 부르는 20초 사이에 웹 손님이 같은
   자리를 살 수 있다. 그래서 확정 전에 `hold` 로 자리를 잠근다.
3. **말투.** LLM 이 읽어 줄 응답은 격자가 아니라 문장이어야 한다. 모든 도구는
   `message` 에 그대로 읽어도 되는 한 문장을 함께 돌려준다.

정원·슬롯·상태 전이의 진실은 전부 `tee_sheet.py` 에 있다. 이 파일은 그 함수들을
부를 뿐 규칙을 다시 구현하지 않는다 — 두 벌이 되는 순간 전화와 웹이 어긋난다.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import logging
import os
import re
import secrets
import threading
from datetime import date as date_cls, datetime, timedelta, timezone
from time import monotonic
from typing import Any, Literal, Optional
from zoneinfo import ZoneInfo

from urllib.parse import quote_plus

from fastapi import APIRouter, BackgroundTasks, Depends, Header, HTTPException, Request
from pydantic import BaseModel, Field

from backend.api.routes import tee_sheet as ts
# HST 는 리테일이 이미 상수로 갖고 있다. 여기에 13% 를 또 적으면 언젠가 한쪽만 바뀐다.
from backend.api.routes.retail import TAX_RATE
from backend.services import (
    customer_lookup,
    lost_items,
    supabase_rest,
    tee_waitlist,
    voice_agent,
)
from backend.core.config import settings
from backend.services.barcode_png import barcode_url
from backend.services.tee_sheet_store import Scope
from backend.services.twilio_sms import send_sms

logger = logging.getLogger(__name__)


# ===== 정책 상수 ======================================================
# 여기 있는 숫자는 전부 "프로 샵이 바꾸고 싶어할 값" 이다. 코드 곳곳에 흩어
# 놓지 않고 한군데 모아 둔다.

#: 손님이 예약할 수 있는 범위. 고객 웹(`/book/tee-time` 의 `DAYS_AHEAD`)과 같은 값.
BOOKING_WINDOW_DAYS = 14

#: 티오프까지 이보다 적게 남았으면 에이전트는 취소하지 못하고 프로 샵으로 넘긴다.
#: 카트 배정과 환불이 걸려 있어 사람이 판단할 구간이다.
CANCEL_CUTOFF_MINUTES = 120

#: 한 번에 읽어 줄 티타임 개수. 전화로 다섯 개 넘게 불러 주면 손님이 못 따라온다.
MAX_OPTIONS = 5

#: 통화 한 건이 부를 수 있는 도구 호출 총량. 폭주한 에이전트가 티 시트를 두드리는
#: 것을 막는 최후의 방어선이다.
MAX_CALLS_PER_CONVERSATION = 80

#: 통화 세션을 기억해 두는 시간. 통화가 끝나고도 한동안 남겨 post-call 웹훅이
#: 같은 세션을 찾을 수 있게 한다.
SESSION_TTL_SECONDS = 2 * 60 * 60

#: 골프장 현지 시간대. "이 티타임이 이미 지났나" 는 UTC 로 판단하면 안 된다 —
#: 온타리오 저녁 8시는 UTC 로 이미 다음 날이다.
CLUB_TIMEZONE = ZoneInfo(os.getenv("CLUB_TIMEZONE", "America/Toronto"))

CLUB_NAME = os.getenv("CLUB_NAME", "Pelham Hills Golf Club")

#: 안내 문자에 쓰는 사실들. **저장소가 이미 아는 값만** 둔다.
#: 주소는 `frontend/lib/nav.ts` 의 `CLUB.mailingAddress` 와 같은 표기다 (클럽이 쓰던
#: Lightspeed 영수증 2026-09-15 기준). 영업시간·메뉴·분실물 규정 같은 건 넣지 않는다 —
#: 시연 시나리오에 나오는 그 값들은 클럽 확인 전 샘플이라, 문자로 보내면 틀린 정보가
#: 손님 손에 남는다.
CLUB_ADDRESS = "196 Webber Road, Welland, Ontario, L3B 5N9"
SITE_URL = os.getenv("PUBLIC_SITE_URL", "https://pelhamhills.vercel.app").rstrip("/")

#: 한 통화가 보낼 수 있는 안내 문자 수. 에이전트가 말에 끌려 같은 문자를 반복해서
#: 보내는 것을 막는다.
MAX_INFO_SMS_PER_CALL = 2

DayPart = Literal["morning", "afternoon", "evening", "any"]


# ===== 인증 ===========================================================

def _tool_secret() -> str:
    return os.getenv("VOICE_TOOL_SECRET", "").strip()


def require_tool_secret(x_voice_tool_secret: Optional[str] = Header(None)) -> None:
    """에이전트의 웹훅 도구 호출임을 확인한다.

    `VOICE_TOOL_SECRET` 이 비어 있으면 검사를 건너뛴다. 로컬 개발에서 터널을 띄우기
    전에 curl 로 도구를 두드려 볼 수 있어야 하기 때문이다. **배포에서는 반드시
    채울 것** — 이 엔드포인트들은 인증 없이 예약을 만들고 취소할 수 있다.
    """
    expected = _tool_secret()
    if not expected:
        return
    if not x_voice_tool_secret or not secrets.compare_digest(x_voice_tool_secret, expected):
        raise HTTPException(status_code=401, detail="Invalid or missing voice tool secret")


# 라우터가 둘인 이유: 이 파일의 엔드포인트는 **인증 방식이 서로 다르다.**
#
#   tools_router  — 에이전트가 부른다. 공유 시크릿 헤더로 막는다.
#   router        — 브라우저와 ElevenLabs 웹훅이 부른다. 시크릿을 가질 수 없다.
#
# 한 라우터에 시크릿 검사를 걸면 `/voice/session` 도 같이 막힌다. 브라우저는 그
# 시크릿을 알 수 없으므로(알면 시크릿이 아니다) 배포에서 위젯이 조용히 죽는다.
# post-call 웹훅도 마찬가지다 — 그쪽은 `ElevenLabs-Signature` HMAC 으로 검증하지,
# 우리 헤더를 보내지 않는다.
#
# 도구는 tools_router 에만 단다. 검사를 라우터 레벨에 걸어 두면 나중에 도구를
# 추가하면서 인증을 빠뜨릴 수 없다.
tools_router = APIRouter(dependencies=[Depends(require_tool_secret)])
router = APIRouter()


# ===== 웹 세션 발급 제한 ==============================================
#
# `/voice/session` 은 시크릿 없이 열려 있어야 하고(브라우저가 시크릿을 가질 수
# 없다), 호출 한 번이 ElevenLabs 대화 크레딧을 태울 수 있는 티켓을 만든다.
# 통화별 도구 호출 상한(`MAX_CALLS_PER_CONVERSATION`)은 여기에 닿지 않으므로,
# 이 엔드포인트만 따로 막는다.

SESSION_RATE_LIMIT = 10
SESSION_RATE_WINDOW_SECONDS = 60

_session_hits: dict[str, list[float]] = {}
_session_rate_lock = threading.Lock()


def _check_session_rate(caller: str) -> None:
    now = monotonic()
    cutoff = now - SESSION_RATE_WINDOW_SECONDS

    with _session_rate_lock:
        for key in [k for k, hits in _session_hits.items() if not hits or hits[-1] < cutoff]:
            del _session_hits[key]

        hits = [hit for hit in _session_hits.get(caller, []) if hit >= cutoff]
        hits.append(now)
        _session_hits[caller] = hits
        over_limit = len(hits) > SESSION_RATE_LIMIT

    if over_limit:
        raise HTTPException(
            status_code=429,
            detail="Too many voice sessions from here. Please wait a minute and try again.",
        )


# ===== 통화 세션 ======================================================
#
# 왜 필요한가: `cancel_booking` 이 booking_id 만 믿으면, 에이전트가 (혹은 이
# 엔드포인트를 직접 두드리는 누군가가) 아무 id 나 넣어 남의 예약을 취소할 수 있다.
# 그래서 "이 통화에서 조회로 확인된 예약" 만 취소 대상이 되게 묶어 둔다.

class _Session:
    __slots__ = (
        "conversation_id", "created_at", "last_seen", "revealed", "holds", "calls", "info_sms",
    )

    def __init__(self, conversation_id: str) -> None:
        now = datetime.now(timezone.utc)
        self.conversation_id = conversation_id
        self.created_at = now
        self.last_seen = now
        self.revealed: set[str] = set()   # 조회로 손님에게 확인된 booking_id
        self.holds: set[str] = set()      # 이 통화가 잡은 홀드 id
        self.calls = 0
        self.info_sms = 0                 # 이 통화가 보낸 안내 문자 수


_sessions: dict[str, _Session] = {}
_sessions_lock = threading.Lock()


def _touch_session(conversation_id: str | None) -> _Session | None:
    """세션을 찾거나 만들고 호출 횟수를 센다. conversation_id 가 없으면 None."""
    if not conversation_id:
        return None

    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(seconds=SESSION_TTL_SECONDS)

    with _sessions_lock:
        for stale in [k for k, v in _sessions.items() if v.last_seen < cutoff]:
            del _sessions[stale]

        session = _sessions.get(conversation_id)
        if session is None:
            session = _Session(conversation_id)
            _sessions[conversation_id] = session

        session.last_seen = now
        session.calls += 1
        if session.calls > MAX_CALLS_PER_CONVERSATION:
            raise HTTPException(
                status_code=429,
                detail="This call has made too many booking requests. Transfer to the pro shop.",
            )
        return session


# ===== 날짜 · 시간 헬퍼 ================================================

def club_now() -> datetime:
    return datetime.now(CLUB_TIMEZONE)


def today_iso() -> str:
    return club_now().date().isoformat()


_RELATIVE_DATES = {
    "today": 0,
    "tonight": 0,
    "tomorrow": 1,
}


def resolve_date(value: str) -> str:
    """에이전트가 준 날짜를 ISO 로 확정한다.

    LLM 은 오늘 날짜를 모르면 지어낸다. 프롬프트에 `today_iso` 를 dynamic variable
    로 주입하지만, 그래도 "tomorrow" 를 그대로 흘려보내는 경우가 있어 여기서 한 번
    더 받아 준다. 그 외의 자연어는 거절하고 **에이전트가 다시 물어보게** 한다 —
    "next Tuesday" 를 서버가 추측했다가 틀리면 손님이 엉뚱한 날에 온다.
    """
    text = (value or "").strip().lower()
    if not text:
        raise HTTPException(status_code=422, detail="A date is required, as YYYY-MM-DD.")

    if text in _RELATIVE_DATES:
        return (club_now().date() + timedelta(days=_RELATIVE_DATES[text])).isoformat()

    if not ts.ISO_DATE_RE.match(text):
        raise HTTPException(
            status_code=422,
            detail=(
                "Ask the caller for the date again and send it as YYYY-MM-DD "
                f"(today is {today_iso()})."
            ),
        )
    try:
        date_cls.fromisoformat(text)
    except ValueError:
        raise HTTPException(status_code=422, detail=f"{value} is not a real date.") from None
    return text


def spoken_date(iso_date: str) -> str:
    """2026-09-10 -> "Thursday, September 10". 에이전트가 그대로 읽는다."""
    day = date_cls.fromisoformat(iso_date)
    return f"{day.strftime('%A')}, {day.strftime('%B')} {day.day}"


def require_bookable_date(iso_date: str) -> None:
    """예약 가능한 창(오늘 ~ +14일) 안인지. 밖이면 에이전트가 읽을 문장으로 거절한다."""
    today = club_now().date()
    day = date_cls.fromisoformat(iso_date)
    if day < today:
        raise HTTPException(status_code=422, detail=f"{spoken_date(iso_date)} is in the past.")

    furthest = today + timedelta(days=BOOKING_WINDOW_DAYS)
    if day > furthest:
        raise HTTPException(
            status_code=422,
            detail=(
                f"We only take bookings {BOOKING_WINDOW_DAYS} days out. The furthest date "
                f"available is {spoken_date(furthest.isoformat())}."
            ),
        )


def day_part_of(minutes: int) -> str:
    """`components/booking/availability.ts` 의 `dayPartOf` 와 같은 경계."""
    if minutes < 12 * 60:
        return "morning"
    if minutes < 16 * 60:
        return "afternoon"
    return "evening"


def slot_datetime(iso_date: str, time_label: str) -> datetime | None:
    """슬롯의 골프장 현지 시각. 파싱 실패면 None."""
    minutes = ts.label_to_minutes(time_label)
    if minutes is None:
        return None
    day = date_cls.fromisoformat(iso_date)
    # 자정에 timedelta 를 더하지 않는다. aware datetime 의 덧셈은 벽시계 기준이라
    # 결과의 UTC 오프셋이 자정 것으로 남고, 서머타임이 바뀌는 이틀 동안 한 시간
    # 어긋난다. 시/분으로 직접 만들면 zoneinfo 가 그날의 오프셋을 제대로 고른다.
    hour, minute = divmod(minutes, 60)
    return datetime(day.year, day.month, day.day, hour, minute, tzinfo=CLUB_TIMEZONE)


def normalize_phone(value: str) -> str:
    """비교용 정규화: 숫자만 남기고 뒤에서 10자리.

    손님은 "905-892-1234", "(905) 892 1234", "+1 905 892 1234" 를 다 말한다.
    저장은 손님이 말한 그대로 하되 대조는 이 값으로 한다.
    """
    digits = re.sub(r"\D", "", value or "")
    return digits[-10:] if len(digits) >= 10 else digits


# ===== 요청 · 응답 모델 ================================================

class _VoiceRequest(BaseModel):
    """모든 도구가 공유하는 필드. ElevenLabs 가 통화마다 값을 채워 보낸다."""

    conversation_id: str | None = Field(
        default=None,
        description="ElevenLabs conversation id. 취소 권한을 이 통화에 묶는 데 쓴다.",
    )


class FindTeeTimesRequest(_VoiceRequest):
    date: str = Field(..., description="ISO date (YYYY-MM-DD), or 'today' / 'tomorrow'.")
    party_size: int = Field(..., ge=1, le=ts.PLAYERS_PER_TEE_TIME)
    day_part: DayPart = "any"


class TeeTimeOption(BaseModel):
    time: str
    day_part: str
    seats_open: int
    rate: float


class FindTeeTimesResponse(BaseModel):
    ok: bool
    date: str
    spoken_date: str
    party_size: int
    total_open: int
    options: list[TeeTimeOption]
    message: str


class HoldRequest(_VoiceRequest):
    date: str
    time: str = Field(..., description="Exactly one of the time labels find_tee_times returned.")
    party_size: int = Field(..., ge=1, le=ts.PLAYERS_PER_TEE_TIME)


class HoldResponse(BaseModel):
    ok: bool
    hold_id: str
    date: str
    spoken_date: str
    time: str
    party_size: int
    rate: float
    expires_in_seconds: int
    message: str


class ReleaseHoldRequest(_VoiceRequest):
    hold_id: str


class ReleaseHoldResponse(BaseModel):
    ok: bool
    released: bool
    message: str


class ConfirmRequest(_VoiceRequest):
    hold_id: str
    first_name: str = Field(..., min_length=1, max_length=60)
    last_name: str = Field(..., min_length=1, max_length=60)
    holes: Literal[9, 18] = 18
    #: 카트를 탈 사람 수. 0 이면 걸어서 친다. 앞에서부터 이 수만큼 카트 요금을 붙인다.
    riders: int = Field(default=0, ge=0, le=ts.PLAYERS_PER_TEE_TIME)
    #: 손님이 **스스로 회원이라고 말했는지**. 확인된 사실이 아니므로 요금제는 바꾸지 않고
    #: 메모만 남긴다 — 프로 샵이 체크인 때 실제 회원 요금제로 고친다.
    member: bool = False
    #: 손님이 **다른** 번호를 불러 줬을 때만 채운다. 비면 발신번호를 쓴다.
    phone: str = Field(default="", max_length=40)
    #: 전화선이 알려 준 발신번호 (`system__caller_id`). LLM 이 채우지 않는다.
    caller_number: str = Field(default="", max_length=40)


class BookingSummary(BaseModel):
    booking_id: str
    confirmation_code: str
    date: str
    spoken_date: str
    time: str
    party_size: int
    holes: int
    rate: float
    name: str
    status: str


class ConfirmResponse(BaseModel):
    ok: bool
    booking: BookingSummary
    message: str


class LookupRequest(_VoiceRequest):
    phone: str = Field(..., min_length=7, max_length=40)
    last_name: str = Field(..., min_length=1, max_length=60)


class LookupResponse(BaseModel):
    ok: bool
    found: int
    bookings: list[BookingSummary]
    message: str


class CancelRequest(_VoiceRequest):
    booking_id: str
    last_name: str = Field(..., min_length=1, max_length=60)
    reason: str = Field(default="Caller asked to cancel.", max_length=200)
    preview: bool = Field(
        default=False,
        description="True 면 취소하지 않고 취소할 수 있는지만 본다. 손님에게 먼저 알려 줄 때 쓴다.",
    )


class CancelResponse(BaseModel):
    ok: bool
    booking_id: str
    date: str
    spoken_date: str
    time: str
    message: str
    #: preview 호출이면 False. 기존 호출부가 깨지지 않게 기본값은 True 다.
    cancelled: bool = True


class IdentifyCallerRequest(_VoiceRequest):
    caller_number: str = Field(
        default="",
        max_length=40,
        description="전화선이 알려 준 발신번호. 손님이 말한 번호를 여기 넣지 말 것.",
    )


class IdentifyCallerResponse(BaseModel):
    ok: bool
    known: bool
    greeting_name: str
    is_member: bool
    upcoming: int
    message: str


class RatesRequest(_VoiceRequest):
    date: str
    players: int = Field(default=1, ge=1, le=ts.PLAYERS_PER_TEE_TIME)
    holes: Literal[9, 18] = 18
    riders: int = Field(default=0, ge=0, le=ts.PLAYERS_PER_TEE_TIME)


class RatesResponse(BaseModel):
    ok: bool
    date: str
    spoken_date: str
    players: int
    riders: int
    green_fee_per_player: float
    cart_fee_per_rider: float
    subtotal: float
    tax: float
    total: float
    message: str


class ModifyRequest(_VoiceRequest):
    booking_id: str
    last_name: str = Field(..., min_length=1, max_length=60)
    party_size: Optional[int] = Field(default=None, ge=1, le=ts.PLAYERS_PER_TEE_TIME)
    holes: Optional[Literal[9, 18]] = None


class ModifyResponse(BaseModel):
    ok: bool
    booking: BookingSummary
    message: str


#: 보낼 수 있는 안내 문자. 새 항목은 **클럽이 확인해 준 사실**만 추가한다.
InfoTopic = Literal["directions", "booking_link"]


class InfoSmsRequest(_VoiceRequest):
    topic: InfoTopic
    caller_number: str = Field(
        default="",
        max_length=40,
        description="전화선이 알려 준 발신번호. 손님이 말한 번호를 여기 넣지 말 것.",
    )


class InfoSmsResponse(BaseModel):
    ok: bool
    sent: bool
    topic: str
    message: str


class LostItemRequest(_VoiceRequest):
    item: str = Field(..., min_length=2, max_length=80)
    last_name: str = Field(..., min_length=1, max_length=60)
    first_name: str = Field(default="", max_length=60)
    description: str = Field(default="", max_length=200)
    lost_on: str = Field(default="", max_length=20, description="ISO date, 'today' 또는 'yesterday'.")
    where_lost: str = Field(default="", max_length=80)
    caller_number: str = Field(default="", max_length=40)


class LostItemResponse(BaseModel):
    ok: bool
    ticket: str
    message: str


class WaitlistRequest(_VoiceRequest):
    date: str
    party_size: int = Field(..., ge=1, le=ts.PLAYERS_PER_TEE_TIME)
    last_name: str = Field(..., min_length=1, max_length=60)
    first_name: str = Field(default="", max_length=60)
    earliest: str = Field(default="", max_length=10)
    latest: str = Field(default="", max_length=10)
    holes: Literal[9, 18] = 18
    caller_number: str = Field(default="", max_length=40)


class WaitlistResponse(BaseModel):
    ok: bool
    joined: bool
    date: str
    spoken_date: str
    message: str


# ===== 공용 내부 헬퍼 ==================================================

def _confirmation_code(booking_id: str) -> str:
    """손님에게 줄 6자리 숫자 확인 번호. id 에서 결정론적으로 뽑는다 (따로 저장하지 않는다).

    숫자만 쓰는 이유: 문자로 받은 손님이 "C 482915" 를 숫자 자판으로 바로 칠 수 있고,
    전화로 불러 줄 때 O/0·I/1 을 헷갈리지 않는다. 취소는 발신번호도 맞아야 하므로
    (`sms.cancel_by_reply`) 다른 손님의 번호와 겹쳐도 남의 예약이 지워지지 않는다.
    """
    digest = hashlib.sha256(booking_id.encode()).digest()
    return f"{int.from_bytes(digest[:8], 'big') % 1_000_000:06d}"


def _legacy_confirmation_code(booking_id: str) -> str:
    """2026-10-08 이전 확인 문자에 실린 영숫자 코드. 그 문자를 받은 손님의 "C <코드>" 취소용."""
    return re.sub(r"[^A-Z0-9]", "", booking_id.upper())[-6:].rjust(6, "0")


def confirmation_text(summary: BookingSummary) -> str:
    """티타임 확정 문자. 전화·문자 예약과 대기자 YES 가 같은 문장을 보낸다."""
    players_word = "player" if summary.party_size == 1 else "players"
    code = summary.confirmation_code
    return (
        f"{CLUB_NAME}: booked {summary.party_size} {players_word}, {summary.spoken_date} at "
        f"{summary.time}. Confirmation #{code}. "
        f"To cancel, reply C {code} (up to {CANCEL_CUTOFF_MINUTES // 60} hours before your tee time) "
        f"or call {settings.PROSHOP_PHONE_NUMBER}. Show this barcode at the pro shop when you check in."
    )


def _summary(booking: ts.TeeBooking) -> BookingSummary:
    active = [p for p in booking.players if not p.cancelled] or booking.players
    return BookingSummary(
        booking_id=booking.id,
        confirmation_code=_confirmation_code(booking.id),
        date=booking.date,
        spoken_date=spoken_date(booking.date),
        time=booking.time,
        party_size=len(booking.players),
        holes=booking.holes,
        rate=booking.rate,
        name=active[0].name if active else booking.title,
        status=booking.status.value,
    )


def _blocked_times(bookings: list[ts.TeeBooking], iso_date: str) -> set[str]:
    """대회·정비로 막아 둔 티타임.

    서버는 `blocked` 예약이 걸린 슬롯에도 POST 를 허용한다 (플레이어가 0명이라
    정원이 비어 보인다). 고객 웹이 이걸 숨기고 있으므로 전화도 똑같이 숨긴다.
    """
    return {
        b.time for b in bookings
        if b.date == iso_date and b.status == ts.BookingStatus.BLOCKED
    }


def _spread(options: list[TeeTimeOption], count: int) -> list[TeeTimeOption]:
    """열려 있는 티타임이 많을 때 하루에 고르게 퍼진 몇 개만 고른다.

    앞에서부터 자르면 6:40, 6:49, 6:58 … 처럼 9분 간격 연속 슬롯만 읽어 주게 되어
    손님에게는 사실상 선택지가 하나다. 첫 번째와 마지막을 포함해 균등 추출한다.
    """
    if len(options) <= count:
        return options
    step = (len(options) - 1) / (count - 1)
    return [options[round(index * step)] for index in range(count)]


def _require_open_slot(
    bookings: list[ts.TeeBooking], iso_date: str, time_label: str, party_size: int
) -> ts.TeeSlot:
    """손님에게 팔아도 되는 슬롯인지 전부 검사하고 슬롯을 돌려준다.

    `require_tee_time_capacity` 가 보지 않는 두 가지(막힌 슬롯 / 지나간 시각)를
    여기서 추가로 막는다. 규칙은 고객 웹(`buildOpenTeeTimes`)과 같아야 한다.
    """
    slot = ts.require_slot(iso_date, time_label)

    if time_label in _blocked_times(bookings, iso_date):
        raise HTTPException(
            status_code=409,
            detail=f"{time_label} on {spoken_date(iso_date)} is closed for an event.",
        )

    at = slot_datetime(iso_date, time_label)
    if at is not None and at <= club_now():
        raise HTTPException(status_code=409, detail=f"{time_label} has already passed today.")

    ts.require_tee_time_capacity(bookings, iso_date, time_label, incoming=party_size)
    return slot


# ===== 도구 1: 빈 티타임 찾기 ==========================================

@tools_router.post("/voice/tools/find-tee-times", response_model=FindTeeTimesResponse)
def find_tee_times(body: FindTeeTimesRequest) -> FindTeeTimesResponse:
    _touch_session(body.conversation_id)
    iso_date = resolve_date(body.date)
    require_bookable_date(iso_date)

    now = club_now()
    utc_now = datetime.now(timezone.utc)
    # 그날만 읽는다. 컴프리헨션으로 다시 거르지 않는다 — 평범한 list 가 되면 읽은
    # 범위가 떨어져 `tee_time_players` 가 받지 않는다.
    bookings = ts.read_bookings(Scope(dates={iso_date}))
    blocked = _blocked_times(bookings, iso_date)

    options: list[TeeTimeOption] = []
    for slot in ts.generate_slots(iso_date):
        if slot.time in blocked:
            continue

        at = slot_datetime(iso_date, slot.time)
        if at is not None and at <= now:
            continue

        part = day_part_of(slot.minutes)
        if body.day_part != "any" and part != body.day_part:
            continue

        seats = ts.PLAYERS_PER_TEE_TIME - ts.tee_time_players(
            bookings, iso_date, slot.time, now=utc_now
        )
        if seats < body.party_size:
            continue

        options.append(
            TeeTimeOption(time=slot.time, day_part=part, seats_open=seats, rate=slot.rate)
        )

    if not options:
        window = "" if body.day_part == "any" else f" in the {body.day_part}"
        return FindTeeTimesResponse(
            ok=False,
            date=iso_date,
            spoken_date=spoken_date(iso_date),
            party_size=body.party_size,
            total_open=0,
            options=[],
            message=(
                f"Nothing is open for {body.party_size} on {spoken_date(iso_date)}{window}. "
                "Offer the caller a different day or a different part of the day."
            ),
        )

    picked = _spread(options, MAX_OPTIONS)
    times = ", ".join(option.time for option in picked)
    return FindTeeTimesResponse(
        ok=True,
        date=iso_date,
        spoken_date=spoken_date(iso_date),
        party_size=body.party_size,
        total_open=len(options),
        options=picked,
        message=(
            f"{len(options)} tee times are open for {body.party_size} on "
            f"{spoken_date(iso_date)}. Read a few of these to the caller: {times}. "
            f"The rate is ${picked[0].rate:.2f} per player."
        ),
    )


# ===== 도구 2: 자리 잡기 (홀드) ========================================

@tools_router.post("/voice/tools/hold-tee-time", response_model=HoldResponse)
def hold_tee_time(body: HoldRequest) -> HoldResponse:
    session = _touch_session(body.conversation_id)
    iso_date = resolve_date(body.date)
    require_bookable_date(iso_date)
    time_label = body.time.strip()

    expires_at = datetime.now(timezone.utc) + timedelta(seconds=ts.HOLD_TTL_SECONDS)

    # 그날(정원 검사) + 날짜 무관 홀드(아래 purge 가 예전처럼 전부 걷는다).
    with ts.bookings_tx(Scope(dates={iso_date}, holds=True)) as bookings:
        ts.purge_expired_holds(bookings)
        slot = _require_open_slot(bookings, iso_date, time_label, body.party_size)

        # 홀드는 **진짜 예약 레코드**다. 그래야 `tee_time_players` 가 이 자리를
        # 찬 것으로 세고, 웹 손님에게 같은 자리가 보이지 않는다.
        hold = ts.TeeBooking(
            date=iso_date,
            time=time_label,
            title="Phone hold",
            rate=slot.rate,
            color="gray",
            status=ts.BookingStatus.RESERVED,
            source=ts.BookingSource.VOICE_HOLD,
            holdExpiresAt=expires_at,
            notes="Held by the phone assistant while the caller gives their name.",
            players=[ts.Player(name="Guest", ratePlan="Public") for _ in range(body.party_size)],
        )
        ts._audit(hold, f"Phone assistant held {body.party_size} seats at {time_label}.")
        bookings.append(hold)

        hold_id = hold.id
        rate = hold.rate

    if session is not None:
        session.holds.add(hold_id)

    return HoldResponse(
        ok=True,
        hold_id=hold_id,
        date=iso_date,
        spoken_date=spoken_date(iso_date),
        time=time_label,
        party_size=body.party_size,
        rate=rate,
        expires_in_seconds=ts.HOLD_TTL_SECONDS,
        message=(
            f"{time_label} on {spoken_date(iso_date)} is held for {body.party_size}. "
            "Get the caller's first name, last name, and phone number, then confirm within "
            f"{ts.HOLD_TTL_SECONDS // 60} minutes."
        ),
    )


# ===== 도구 3: 홀드 반납 ===============================================

@tools_router.post("/voice/tools/release-hold", response_model=ReleaseHoldResponse)
def release_hold(body: ReleaseHoldRequest) -> ReleaseHoldResponse:
    """손님이 마음을 바꾸면 즉시 자리를 돌려놓는다.

    TTL 을 기다려도 결과는 같지만, 그동안 그 자리는 아무도 못 산다. 통화 중에
    "역시 다른 날로 할게요" 는 흔한 전개라 명시적으로 반납한다.
    """
    _touch_session(body.conversation_id)

    with ts.bookings_tx(Scope(ids={body.hold_id}, holds=True)) as bookings:
        ts.purge_expired_holds(bookings)
        before = len(bookings)
        bookings[:] = [
            b for b in bookings
            if not (b.id == body.hold_id and b.source == ts.BookingSource.VOICE_HOLD)
        ]
        released = len(bookings) != before

    return ReleaseHoldResponse(
        ok=True,
        released=released,
        message=(
            "The tee time is back on the sheet."
            if released
            else "That hold was already gone; there is nothing to release."
        ),
    )


# ===== 도구 4: 예약 확정 ===============================================

@tools_router.post("/voice/tools/confirm-booking", response_model=ConfirmResponse)
def confirm_booking(body: ConfirmRequest, background: BackgroundTasks) -> ConfirmResponse:
    session = _touch_session(body.conversation_id)

    first = body.first_name.strip()
    last = body.last_name.strip()

    # 번호는 **발신번호를 기본으로** 쓰고, 손님이 다른 번호를 불러 줬을 때만 그것을 쓴다.
    #
    # 예전에는 LLM 이 받아 적은 `phone` 하나만 받았다. 2026-10-06 첫 실제 통화에서
    # 에이전트가 그 자리에 `"caller_number"` 라는 **글자 그대로**를 넣어 보냈고
    # (다른 도구에서 그 이름의 동적 변수를 보고 따라 한 것으로 보인다), 422 가 세 번
    # 난 뒤 통화가 직원에게 넘어갔다. 홀드만 남고 예약은 만들어지지 않았다.
    #
    # 전화선이 주는 번호가 손님이 말한 번호보다 정확하다. 받아 적기는 틀릴 수 있다.
    spoken = body.phone.strip()
    phone = spoken if normalize_phone(spoken) else body.caller_number.strip()

    if not normalize_phone(phone):
        raise HTTPException(
            status_code=422,
            detail=(
                "No usable phone number for this booking. Ask the caller to say the number "
                "digit by digit and send just the digits — never a placeholder word."
            ),
        )

    # 인원을 늘리지 않는다 (홀드가 이미 자리를 잡고 있다) → 그 홀드 하나만 읽는다.
    with ts.bookings_tx(Scope(ids={body.hold_id})) as bookings:
        hold = next((b for b in bookings if b.id == body.hold_id), None)

        if hold is None or hold.source != ts.BookingSource.VOICE_HOLD:
            raise HTTPException(
                status_code=404,
                detail="That hold no longer exists. Search for open tee times again.",
            )

        if ts.hold_expired(hold, datetime.now(timezone.utc)):
            # 자리는 이미 정원 계산에서 빠져 있다. 레코드만 치우고 다시 잡게 한다.
            bookings[:] = [b for b in bookings if b.id != hold.id]
            raise HTTPException(
                status_code=409,
                detail=(
                    "The hold expired. Tell the caller you need to check again, then search "
                    "and hold the tee time once more."
                ),
            )

        party_size = len(hold.players)
        if body.riders > party_size:
            raise HTTPException(
                status_code=422,
                detail=(
                    f"{body.riders} cart riders but only {party_size} players are booked. "
                    "Ask the caller how many of the group want to ride in a cart."
                ),
            )

        # 첫 자리는 전화한 손님. 나머지는 이름을 모르는 동반자라 Guest 로 둔다 —
        # 프로 샵이 체크인 때 채운다.
        hold.players = [
            ts.Player(
                firstName=first, lastName=last, phone=phone,
                type=ts.PlayerType.EXISTING, ratePlan="Public",
            ),
            *[ts.Player(name="Guest", ratePlan="Public") for _ in range(party_size - 1)],
        ]
        hold.title = f"{last}, {first}".strip(", ")
        hold.holes = body.holes

        # 카트. 예전에는 전화 예약에 카트가 전혀 적히지 않아, 계산서에 카트 요금이 빠졌다.
        # 계산서는 사람마다 `cart`/`cartFee` 를 읽고, `cartCount` 는 실제 카트 대수다.
        # 둘 다 채운다. 대수는 웹 예약과 같이 한 대에 두 명(올림).
        for player in hold.players[: body.riders]:
            player.cart = True
            player.cartFee = ts.cart_fee_for(player.ratePlan, body.holes)
        hold.cartCount = -(-body.riders // 2)
        hold.color = "blue"
        hold.source = ts.BookingSource.VOICE
        hold.holdExpiresAt = None
        # 문자 비서도 이 함수로 확정한다 (`services/sms_agent.py`). 출처는 VOICE 로 두어
        # 리마인더·확인 문자를 그대로 받게 하고, 어느 경로였는지는 메모로 남긴다.
        by_text = (body.conversation_id or "").startswith("sms:")
        hold.notes = (
            "Booked by text message with the booking assistant."
            if by_text
            else "Booked by phone with the voice assistant."
        )
        if body.member:
            hold.notes += " Caller says they are a member — set their rate plan at check-in."
        ts._audit(
            hold, f"Phone assistant confirmed {party_size} players for {first} {last} ({phone})."
        )
        if body.riders:
            ts._audit(
                hold,
                f"{body.riders} riding, {hold.cartCount} cart{'' if hold.cartCount == 1 else 's'}.",
            )
        summary = _summary(hold)

    if session is not None:
        session.holds.discard(body.hold_id)
        # 방금 만든 예약은 같은 통화에서 취소할 수 있어야 한다 (손님이 말을 바꾸는 경우).
        session.revealed.add(summary.booking_id)

    players_word = "player" if summary.party_size == 1 else "players"
    # 확인 문자 + 바코드(MMS). 응답이 나간 뒤에 보낸다 — Twilio 가 느려도 에이전트가 기다리지 않게.
    # 취소 답장에 코드를 요구하는 이유는 `routes/sms.py` 참고.
    background.add_task(
        send_sms,
        phone,
        confirmation_text(summary),
        template="confirm",
        booking_ref=summary.confirmation_code,
        media_url=barcode_url(summary.confirmation_code),
    )
    return ConfirmResponse(
        ok=True,
        booking=summary,
        message=(
            f"Booked. {first} {last}, {summary.party_size} {players_word} at {summary.time} on "
            f"{summary.spoken_date}. Read back the confirmation code "
            f"{summary.confirmation_code} one digit at a time, and tell them the text with the "
            "confirmation number, how to cancel, and a barcode for check-in is on its way."
        ),
    )


# ===== 도구 5: 예약 조회 ===============================================

@tools_router.post("/voice/tools/lookup-booking", response_model=LookupResponse)
def lookup_booking(body: LookupRequest) -> LookupResponse:
    """전화번호 **와** 성이 둘 다 맞아야 예약을 보여준다.

    열쇠를 두 개 요구하는 것이 취소 안전장치의 첫 단계다. 전화번호 하나만으로
    조회가 되면, 번호를 아는 누구나 남의 라운드를 취소할 수 있다.
    """
    session = _touch_session(body.conversation_id)

    wanted_phone = normalize_phone(body.phone)
    wanted_last = body.last_name.strip().casefold()
    if not wanted_phone:
        raise HTTPException(
            status_code=422,
            detail="That phone number did not come through. Ask the caller to repeat it.",
        )

    today = today_iso()
    now = datetime.now(timezone.utc)

    matches: list[ts.TeeBooking] = []
    # 지난 날짜는 어차피 버린다. 과거 예약 수천 건을 읽지 않게 오늘부터만.
    for booking in ts.read_bookings(Scope(date_from=today)):
        if booking.date < today:
            continue
        if booking.status in (ts.BookingStatus.CANCELLED, ts.BookingStatus.BLOCKED):
            continue
        if booking.source == ts.BookingSource.VOICE_HOLD or ts.hold_expired(booking, now):
            continue
        for player in booking.players:
            if player.cancelled:
                continue
            if normalize_phone(player.phone) != wanted_phone:
                continue
            if player.lastName.strip().casefold() != wanted_last:
                continue
            matches.append(booking)
            break

    if session is not None:
        session.revealed.update(booking.id for booking in matches)

    summaries = [_summary(booking) for booking in matches]

    if not summaries:
        return LookupResponse(
            ok=False,
            found=0,
            bookings=[],
            message=(
                "No upcoming reservation matches that phone number and last name. Offer to "
                "transfer the caller to the pro shop rather than guessing."
            ),
        )

    spoken = "; ".join(
        f"{s.spoken_date} at {s.time} for {s.party_size}" for s in summaries
    )
    word = "reservation" if len(summaries) == 1 else "reservations"
    return LookupResponse(
        ok=True,
        found=len(summaries),
        bookings=summaries,
        message=(
            f"Found {len(summaries)} upcoming {word}: {spoken}. Read the details back and ask "
            "the caller to confirm before changing anything."
        ),
    )


# ===== 도구 6: 예약 취소 ===============================================

@tools_router.post("/voice/tools/cancel-booking", response_model=CancelResponse)
def cancel_booking(body: CancelRequest, background: BackgroundTasks) -> CancelResponse:
    """조회로 확인된 예약만, 티오프 2시간 전까지만 취소한다.

    취소는 되돌리기 어려운 쪽의 동작이라 문을 셋 세워 둔다.
      1. 이 통화에서 `lookup_booking`(또는 `confirm_booking`)이 확인해 준 id 인가.
      2. 손님이 말한 성이 예약에 실제로 있는가.
      3. 티오프까지 `CANCEL_CUTOFF_MINUTES` 이상 남았는가.
    그리고 레코드를 지우지 않는다 — `status=cancelled` 로만 바꾼다. 잘못돼도
    프로 샵이 티 시트에서 되돌릴 수 있어야 한다.
    """
    # 통화를 특정할 수 없으면 취소하지 않는다. `_touch_session(None)` 은 None 을
    # 돌려주므로, "세션이 있으면 검사" 로 쓰면 conversation_id 를 빼는 것만으로
    # 이 문을 통과할 수 있다 — 이 파일에서 가장 중요한 검사가 fail-open 하는 셈이다.
    # 다른 도구들은 세션이 없어도 안전하지만(자리를 찾고 잡는 일뿐이다) 취소는 아니다.
    NEEDS_LOOKUP = (
        "Look the reservation up first with the caller's phone number and last name. "
        "Only a reservation confirmed on this call can be cancelled."
    )

    session = _touch_session(body.conversation_id)
    if session is None or body.booking_id not in session.revealed:
        raise HTTPException(status_code=403, detail=NEEDS_LOOKUP)

    wanted_last = body.last_name.strip().casefold()

    # 취소는 자리를 돌려줄 뿐이라 정원을 셀 필요가 없다 → 그 예약 하나만.
    with ts.bookings_tx(Scope(ids={body.booking_id})) as bookings:
        booking = next((b for b in bookings if b.id == body.booking_id), None)
        if booking is None or booking.source == ts.BookingSource.VOICE_HOLD:
            raise HTTPException(status_code=404, detail="That reservation is not on the sheet.")

        if booking.status == ts.BookingStatus.CANCELLED:
            return CancelResponse(
                ok=True,
                booking_id=booking.id,
                date=booking.date,
                spoken_date=spoken_date(booking.date),
                time=booking.time,
                message="That reservation was already cancelled. There is nothing else to do.",
            )

        caller = next(
            (p for p in booking.players if p.lastName.strip().casefold() == wanted_last), None
        )
        if caller is None:
            raise HTTPException(
                status_code=403,
                detail=(
                    "That last name does not match the reservation. Do not cancel it. Offer to "
                    "transfer the caller to the pro shop."
                ),
            )

        at = slot_datetime(booking.date, booking.time)
        if at is not None and (at - club_now()).total_seconds() / 60 < CANCEL_CUTOFF_MINUTES:
            raise HTTPException(
                status_code=409,
                detail=(
                    f"That tee time is less than {CANCEL_CUTOFF_MINUTES // 60} hours away, so "
                    "the pro shop has to cancel it. Transfer the caller."
                ),
            )

        # 미리보기: 문 세 개를 다 지났다는 것만 알려 주고 아무것도 바꾸지 않는다.
        # 손님에게 "취소해도 괜찮습니다" 를 먼저 말하고 동의를 받기 위한 것이다.
        #
        # **수수료 금액을 말하지 않는다.** 코드에 취소 수수료라는 개념 자체가 없다.
        # 데모 시나리오는 "24시간 전까지 무료" 라고 말하지만 이 저장소가 아는 규칙은
        # `CANCEL_CUTOFF_MINUTES`(2시간) 하나뿐이고, 둘은 서로 다른 값이다.
        # 확정되기 전까지 금액이나 시간 규정을 지어내지 않는다.
        if body.preview:
            return CancelResponse(
                ok=True,
                cancelled=False,
                booking_id=booking.id,
                date=booking.date,
                spoken_date=spoken_date(booking.date),
                time=booking.time,
                message=(
                    f"This reservation can still be cancelled: {spoken_date(booking.date)} at "
                    f"{booking.time}. Ask the caller to confirm, then call cancel_booking again "
                    "without preview. Do not quote a cancellation fee."
                ),
            )

        message = ts._apply_status(
            booking, ts.BookingStatus.CANCELLED, f"{body.reason.strip()} (phone assistant)"
        )
        ts._audit(booking, message)
        iso_date, time_label = booking.date, booking.time

    if caller.phone:
        background.add_task(
            send_sms,
            caller.phone,
            f"{CLUB_NAME}: cancelled your tee time, {spoken_date(iso_date)} at {time_label}.",
            template="cancel",
            booking_ref=_confirmation_code(body.booking_id),
        )

    # 빈자리를 대기자에게 바로 건다 (1분 루프를 기다리지 않게). 응답이 나간 뒤에 돈다 —
    # 대기자 명단이 느리거나 꺼져 있어도 취소 자체는 이미 끝났다.
    background.add_task(_offer_to_waitlist)

    return CancelResponse(
        ok=True,
        booking_id=body.booking_id,
        date=iso_date,
        spoken_date=spoken_date(iso_date),
        time=time_label,
        message=(
            f"Cancelled: {spoken_date(iso_date)} at {time_label}. Tell the caller it is done "
            "and that the seats are back on the sheet."
        ),
    )


# 도구 라우터를 합친다. `include_router` 는 tools_router 의 의존성(시크릿 검사)을
# 그대로 들고 오므로, `main.py` 는 지금처럼 `voice.router` 하나만 달면 된다.
# ===== 도구 7: 발신번호로 손님 알아보기 =================================

@tools_router.post("/voice/tools/identify-caller", response_model=IdentifyCallerResponse)
def identify_caller(body: IdentifyCallerRequest) -> IdentifyCallerResponse:
    """발신번호로 이름을 찾아 **인사에만** 쓴다.

    `lookup_booking` 과 달리 이 도구는 `_Session.revealed` 를 건드리지 않는다.
    발신번호는 위조할 수 있으므로 이것으로 취소·수정 권한을 주면 첫 번째 문이
    그대로 무너진다. 예약을 보거나 바꾸려면 여전히 번호 **와** 성을 받아
    `lookup_booking` 을 거쳐야 한다.

    다가오는 예약도 **건수만** 돌려준다. 시간과 인원까지 읽어 주면 번호만 아는
    사람에게 남의 일정을 알려 주는 셈이다.

    번호 하나에 고객이 둘 이상이면 이름을 부르지 않는다 — 소스에 부부가 유선
    하나를 같이 쓰는 행이 여럿 있다 (`customer_lookup.find_by_phone` 참고).
    """
    _touch_session(body.conversation_id)

    phone = normalize_phone(body.caller_number)
    if not phone:
        return IdentifyCallerResponse(
            ok=True,
            known=False,
            greeting_name="",
            is_member=False,
            upcoming=0,
            message="The caller's number did not come through. Greet them warmly without a name.",
        )

    today = today_iso()
    now = datetime.now(timezone.utc)
    upcoming = 0
    for booking in ts.read_bookings(Scope(date_from=today)):
        if booking.date < today:
            continue
        if booking.status in (ts.BookingStatus.CANCELLED, ts.BookingStatus.BLOCKED):
            continue
        if booking.source == ts.BookingSource.VOICE_HOLD or ts.hold_expired(booking, now):
            continue
        if any(not p.cancelled and normalize_phone(p.phone) == phone for p in booking.players):
            upcoming += 1

    caller = customer_lookup.find_by_phone(phone)
    guard = (
        "Use this only for the greeting. Before showing or changing any reservation, still ask "
        "for the phone number and last name and call lookup_booking."
    )

    if caller is None or caller.ambiguous or not caller.display:
        reason = (
            "More than one customer shares that number, so do not guess a name."
            if caller is not None and caller.ambiguous
            else "No customer on file for that number."
        )
        return IdentifyCallerResponse(
            ok=True,
            known=False,
            greeting_name="",
            is_member=False,
            upcoming=upcoming,
            message=f"{reason} Greet the caller warmly without a name. {guard}",
        )

    name = caller.first_name or caller.display
    standing = "a member" if caller.is_member else "a public player"
    tail = ""
    if upcoming:
        word = "reservation" if upcoming == 1 else "reservations"
        tail = f" They have {upcoming} upcoming {word}."
    return IdentifyCallerResponse(
        ok=True,
        known=True,
        greeting_name=name,
        is_member=caller.is_member,
        upcoming=upcoming,
        message=(
            f"This is {caller.display}, {standing}. Greet them by first name ({name}).{tail} {guard}"
        ),
    )


# ===== 도구 8: 요금 확인 ===============================================

@tools_router.post("/voice/tools/get-rates", response_model=RatesResponse)
def get_rates(body: RatesRequest) -> RatesResponse:
    """그 날짜에 **실제로 청구되는** 금액. 에이전트가 외운 숫자를 말하지 않게 한다.

    숫자는 전부 `tee_sheet` 의 요금 함수에서 온다 — `slot_rate_for`(주말/평일과
    `RATE_OVERRIDES`)와 `cart_fee_for`. 세율은 리테일의 `TAX_RATE` 한 벌을 쓴다.

    **9홀 요금은 코드에 없다.** 데모 시나리오에는 오후·트와일라잇·가을 요금이
    나오지만 요금표에는 평일/주말 두 가지뿐이다. 없는 요금을 여기서 지어내면
    손님이 전화로 들은 금액과 프로 샵에서 내는 금액이 달라진다. 그래서 9홀은
    금액을 말하지 않고 사람에게 넘긴다.
    """
    _touch_session(body.conversation_id)
    iso_date = resolve_date(body.date)

    if body.holes == 9:
        raise HTTPException(
            status_code=422,
            detail=(
                "Nine-hole pricing is not in our rate table, so do not quote a number. "
                "Offer to transfer the caller to the pro shop."
            ),
        )

    green = ts.slot_rate_for(iso_date)
    cart = ts.cart_fee_for("Public", body.holes)
    subtotal = round(green * body.players + cart * body.riders, 2)
    tax = round(subtotal * TAX_RATE, 2)
    total = round(subtotal + tax, 2)

    players_word = "player" if body.players == 1 else "players"
    cart_part = ""
    if body.riders:
        riders_word = "rider" if body.riders == 1 else "riders"
        cart_part = f" plus ${cart:.2f} per {riders_word} for a cart,"
    return RatesResponse(
        ok=True,
        date=iso_date,
        spoken_date=spoken_date(iso_date),
        players=body.players,
        riders=body.riders,
        green_fee_per_player=green,
        cart_fee_per_rider=cart,
        subtotal=subtotal,
        tax=tax,
        total=total,
        message=(
            f"On {spoken_date(iso_date)} it is ${green:.2f} per player for 18 holes "
            f"before tax,{cart_part} so ${total:.2f} in total for {body.players} "
            f"{players_word} with tax. Read the total, not the breakdown, unless they ask."
        ),
    )


# ===== 도구 9: 예약 수정 ===============================================

@tools_router.post("/voice/tools/modify-booking", response_model=ModifyResponse)
def modify_booking(body: ModifyRequest) -> ModifyResponse:
    """인원과 홀 수만 바꾼다. **시간은 바꾸지 않는다** — 취소하고 다시 잡는다.

    시간 변경을 넣지 않는 이유: 옮길 자리를 잡는 동안 원래 자리를 들고 있어야 하고,
    실패하면 어느 쪽도 잃지 않게 되돌려야 한다. 그 경로는 홀드와 똑같은 경합 문제를
    다시 만든다. 취소 후 재예약은 이미 두 도구로 안전하게 된다.

    취소와 **같은 문 세 개**를 지난다 — 이 통화의 조회로 확인된 예약인가, 성이
    맞는가, 티오프까지 `CANCEL_CUTOFF_MINUTES` 이상 남았는가. 인원을 늘릴 때는
    정원도 다시 센다 (`tee_time_players`). 늘린 뒤에 자리가 모자라면 그 티 타임이
    초과 예약된다.
    """
    session = _touch_session(body.conversation_id)
    if session is None or body.booking_id not in session.revealed:
        raise HTTPException(
            status_code=403,
            detail=(
                "Look the reservation up first with the caller's phone number and last name. "
                "Only a reservation confirmed on this call can be changed."
            ),
        )

    if body.party_size is None and body.holes is None:
        raise HTTPException(
            status_code=422,
            detail="Ask the caller what to change — the number of players, or nine versus eighteen holes.",
        )

    # 정원을 다시 세려면 그 날짜를 통째로 읽어야 하는데, 날짜는 예약을 봐야 안다.
    found = [b for b in ts.read_bookings(Scope(ids={body.booking_id})) if b.id == body.booking_id]
    if not found or found[0].source == ts.BookingSource.VOICE_HOLD:
        raise HTTPException(status_code=404, detail="That reservation is not on the sheet.")
    iso_date = found[0].date

    wanted_last = body.last_name.strip().casefold()

    with ts.bookings_tx(Scope(dates={iso_date}, ids={body.booking_id})) as bookings:
        booking = next((b for b in bookings if b.id == body.booking_id), None)
        if booking is None or booking.source == ts.BookingSource.VOICE_HOLD:
            raise HTTPException(status_code=404, detail="That reservation is not on the sheet.")

        if booking.status == ts.BookingStatus.CANCELLED:
            raise HTTPException(
                status_code=409,
                detail="That reservation is already cancelled. Offer to book a new tee time.",
            )

        if not any(p.lastName.strip().casefold() == wanted_last for p in booking.players):
            raise HTTPException(
                status_code=403,
                detail=(
                    "That last name does not match the reservation. Do not change it. Offer to "
                    "transfer the caller to the pro shop."
                ),
            )

        at = slot_datetime(booking.date, booking.time)
        if at is not None and (at - club_now()).total_seconds() / 60 < CANCEL_CUTOFF_MINUTES:
            raise HTTPException(
                status_code=409,
                detail=(
                    f"That tee time is less than {CANCEL_CUTOFF_MINUTES // 60} hours away, so "
                    "the pro shop has to change it. Transfer the caller."
                ),
            )

        changes: list[str] = []

        if body.party_size is not None and body.party_size != len(booking.players):
            before = len(booking.players)
            if body.party_size > before:
                taken = ts.tee_time_players(
                    bookings, booking.date, booking.time, exclude_id=booking.id
                )
                if taken + body.party_size > ts.PLAYERS_PER_TEE_TIME:
                    free = max(ts.PLAYERS_PER_TEE_TIME - taken, 0)
                    raise HTTPException(
                        status_code=409,
                        detail=(
                            f"That tee time only has room for {free}. Offer the caller a "
                            "different time for the larger group."
                        ),
                    )
                booking.players.extend(
                    ts.Player(name="Guest", ratePlan="Public")
                    for _ in range(body.party_size - before)
                )
            else:
                # 뒤에서부터 줄인다. 첫 자리는 전화한 손님이라 남긴다.
                booking.players = booking.players[: body.party_size]
            changes.append(f"players {before} to {body.party_size}")

        if body.holes is not None and body.holes != booking.holes:
            changes.append(f"holes {booking.holes} to {body.holes}")
            booking.holes = body.holes

        if not changes:
            summary = _summary(booking)
            return ModifyResponse(
                ok=True,
                booking=summary,
                message="Nothing changed — the reservation already matches what the caller asked for.",
            )

        note = "Phone assistant changed " + " and ".join(changes) + "."
        ts._audit(booking, note)
        summary = _summary(booking)

    players_word = "player" if summary.party_size == 1 else "players"
    return ModifyResponse(
        ok=True,
        booking=summary,
        message=(
            f"Updated: {summary.spoken_date} at {summary.time}, {summary.party_size} "
            f"{players_word}, {summary.holes} holes. Read that back to the caller."
        ),
    )


# ===== 도구 10: 안내 문자 =============================================

def _info_sms_body(topic: str) -> str:
    """고정 문구. 에이전트가 쓴 문장을 그대로 보내지 않는다."""
    if topic == "directions":
        maps = "https://maps.google.com/?q=" + quote_plus(f"{CLUB_NAME} {CLUB_ADDRESS}")
        return f"{CLUB_NAME}: {CLUB_ADDRESS}. Map: {maps}"
    return f"{CLUB_NAME}: book a tee time at {SITE_URL}/book/tee-time"


@tools_router.post("/voice/tools/send-info-sms", response_model=InfoSmsResponse)
def send_info_sms(body: InfoSmsRequest, background: BackgroundTasks) -> InfoSmsResponse:
    """정해진 안내 문자를 **전화를 건 그 번호로만** 보낸다.

    받는 번호를 손님 말에서 받지 않고 발신번호(`system__caller_id`)에서만 가져온다.
    말한 번호로 보낼 수 있게 두면 에이전트를 설득해 아무 번호로나 문자를 보내게 만들 수
    있다 — 이 도구가 문자 폭탄 장치가 된다.

    문구도 고정 템플릿뿐이다. 에이전트가 쓴 문장을 그대로 실어 보내면, 지어낸 영업시간이
    손님 손에 **글자로** 남는다. 말은 지나가지만 문자는 남는다.

    한 통화당 `MAX_INFO_SMS_PER_CALL` 건까지만 보낸다.
    """
    session = _touch_session(body.conversation_id)

    if not normalize_phone(body.caller_number):
        raise HTTPException(
            status_code=422,
            detail=(
                "There is no caller number on this call, so there is nowhere to text. "
                "Read the information out loud instead."
            ),
        )

    if session is not None:
        if session.info_sms >= MAX_INFO_SMS_PER_CALL:
            raise HTTPException(
                status_code=429,
                detail="You have already texted this caller. Read it out loud instead.",
            )
        session.info_sms += 1

    # 응답이 나간 뒤에 보낸다 — Twilio 가 느려도 에이전트가 기다리지 않게.
    background.add_task(
        send_sms,
        body.caller_number,
        _info_sms_body(body.topic),
        template=f"info_{body.topic}",
    )

    what = "our address and a map link" if body.topic == "directions" else "a booking link"
    return InfoSmsResponse(
        ok=True,
        sent=True,
        topic=body.topic,
        message=f"Texted {what} to the number they are calling from. Tell them it is on its way.",
    )


# ===== 도구 11: 분실물 접수 ============================================

def _resolve_past_date(value: str) -> str | None:
    """지나간 날짜. 모르겠으면 **추측하지 않고** None 을 돌려준다.

    `resolve_date` 와 달리 거절하지 않는다 — 날짜를 몰라도 분실물 접수는 받아야
    한다. 날짜 칸이 비는 것이 틀린 날짜가 적히는 것보다 낫다.
    """
    text = (value or "").strip().lower()
    if not text:
        return None
    if text in ("today", "tonight"):
        return today_iso()
    if text == "yesterday":
        return (club_now().date() - timedelta(days=1)).isoformat()
    if ts.ISO_DATE_RE.match(text):
        try:
            date_cls.fromisoformat(text)
        except ValueError:
            return None
        return text
    return None


@tools_router.post("/voice/tools/report-lost-item", response_model=LostItemResponse)
def report_lost_item(body: LostItemRequest) -> LostItemResponse:
    """분실물을 접수하고 티켓 번호를 돌려준다.

    에이전트는 **접수만** 한다. "찾았습니다" 나 "있을 거예요" 를 말하면 안 된다 —
    물건을 실제로 본 사람은 직원이고, 전화로 희망을 주면 헛걸음을 만든다.

    연락처는 손님이 말한 번호가 아니라 발신번호를 쓴다. 찾았을 때 문자를 보낼
    곳이고, 말한 번호를 받으면 아무 번호나 명단에 들어갈 수 있다.
    """
    _touch_session(body.conversation_id)

    try:
        row = lost_items.report(
            item=body.item,
            description=body.description,
            lost_on=_resolve_past_date(body.lost_on),
            where_lost=body.where_lost,
            caller_phone=body.caller_number.strip(),
            caller_name=f"{body.first_name} {body.last_name}".strip(),
        )
    except supabase_rest.SupabaseUnavailable:
        raise HTTPException(
            status_code=503,
            detail=(
                "The lost and found list is not reachable, so do not promise anything. "
                "Take the caller's details by transferring them to the pro shop."
            ),
        ) from None

    ticket = str(row.get("ticket") or "")
    return LostItemResponse(
        ok=True,
        ticket=ticket,
        message=(
            f"Logged. Read the reference back one character at a time: {ticket}. Tell them staff "
            "will text if they find it. Never say it has been found — you do not know that."
        ),
    )


# ===== 도구 12: 대기자 등록 + 취소 시 자동 알림 ==========================

@tools_router.post("/voice/tools/join-waitlist", response_model=WaitlistResponse)
def join_waitlist(body: WaitlistRequest) -> WaitlistResponse:
    """그날이 다 찼을 때 대기자로 올린다. 자리가 비면 문자가 간다.

    손님이 **먼저 요청했을 때만** 부른다 — 번호를 보관하고 문자를 보내는 일이라,
    묻지 않고 넣으면 동의 없이 연락처를 쌓는 것이 된다. DB 의 `consented_at` 이
    그 시각을 남긴다.
    """
    _touch_session(body.conversation_id)
    iso_date = resolve_date(body.date)
    require_bookable_date(iso_date)

    # 시간대는 `9:00 AM` 꼴만 받는다. "9am" 을 그대로 저장하면 `label_to_minutes` 가
    # None 을 돌려주고, 자리가 났을 때 그 조건이 **조용히 무시된다** — 오후만 원한다고
    # 말한 손님이 새벽 티타임 문자를 받는다.
    for label, field in ((body.earliest, "earliest"), (body.latest, "latest")):
        text = label.strip()
        if text and not ts.SLOT_TIME_RE.match(text):
            raise HTTPException(
                status_code=422,
                detail=f"Send the {field} time like '9:00 AM' (hour, colon, minutes, AM or PM).",
            )

    phone = body.caller_number.strip()
    if not normalize_phone(phone):
        raise HTTPException(
            status_code=422,
            detail=(
                "There is no caller number on this call, so we could not text them if a spot "
                "opened. Offer to transfer the caller to the pro shop instead."
            ),
        )

    try:
        if tee_waitlist.already_waiting(iso_date, phone):
            return WaitlistResponse(
                ok=True,
                joined=False,
                date=iso_date,
                spoken_date=spoken_date(iso_date),
                message=(
                    f"They are already on the list for {spoken_date(iso_date)}. Tell them that, "
                    "and that we will text the moment something opens."
                ),
            )
        tee_waitlist.join(
            date=iso_date,
            party_size=body.party_size,
            last_name=body.last_name,
            first_name=body.first_name,
            phone=phone,
            earliest=body.earliest,
            latest=body.latest,
            holes=body.holes,
        )
    except supabase_rest.SupabaseUnavailable:
        raise HTTPException(
            status_code=503,
            detail=(
                "The waitlist is not reachable right now. Do not promise a callback — offer to "
                "transfer the caller to the pro shop."
            ),
        ) from None

    return WaitlistResponse(
        ok=True,
        joined=True,
        date=iso_date,
        spoken_date=spoken_date(iso_date),
        message=(
            f"On the list for {spoken_date(iso_date)}, {body.party_size} players. Tell them we "
            "will text if a spot opens and hold it for them for 15 minutes; they reply YES to book it."
        ),
    )


def _window_allows(entry: dict[str, Any], minutes: int | None) -> bool:
    """대기자가 적어 둔 시간대 안에 드는가. 시간대를 안 적었으면 아무 때나 괜찮다.

    라벨 비교는 분으로 바꿔서 한다 — 문자열로 비교하면 "10:00 AM" 이 "9:00 AM" 보다
    작게 나온다.
    """
    if minutes is None:
        return True
    lo = ts.label_to_minutes(entry.get("earliest") or "")
    hi = ts.label_to_minutes(entry.get("latest") or "")
    if lo is not None and minutes < lo:
        return False
    if hi is not None and minutes > hi:
        return False
    return True


async def _offer_to_waitlist() -> None:
    """빈자리를 대기자에게 건다 — `services/waitlist_offers.py`. 오류는 거기서 삼킨다."""
    from backend.services import waitlist_offers  # 그 모듈이 이 모듈을 임포트한다

    await waitlist_offers.run()


router.include_router(tools_router)


# ===== 웹 위젯 세션 ====================================================

class SessionResponse(BaseModel):
    signed_url: str
    agent_id: str


@router.post("/voice/session", response_model=SessionResponse)
async def create_voice_session(request: Request) -> SessionResponse:
    """브라우저가 마이크를 열 때 쓸 signed URL 을 발급한다.

    프론트엔드는 `output: "export"` 정적 사이트라 route handler 가 없다. 이 값을
    만들 수 있는 서버는 여기뿐이고, 그래서 ElevenLabs API 키는 이 프로세스 밖으로
    나가지 않는다.
    """
    _check_session_rate(request.client.host if request.client else "unknown")

    agent = voice_agent.agent_id()
    if not agent:
        raise HTTPException(
            status_code=503,
            detail="No voice agent is configured. Run scripts/elevenlabs_sync_agent.py first.",
        )
    try:
        url = await voice_agent.signed_url(agent)
    except voice_agent.VoiceAgentError as exc:
        # ElevenLabs 가 거절했다 (키 만료 / 잘못된 agent_id / 한도 초과).
        # 브라우저에는 원문을 흘리지 않는다 — 응답 본문에 계정 정보가 섞일 수 있다.
        logger.error("음성 세션 발급 실패: %s", exc)
        raise HTTPException(
            status_code=503, detail="The voice assistant is unavailable right now."
        ) from exc
    return SessionResponse(signed_url=url, agent_id=agent)


# ===== post-call 웹훅 ==================================================

def _verify_webhook(raw: bytes, signature_header: str | None) -> None:
    """ElevenLabs post-call 웹훅 서명 검증 (`t=<ts>,v0=<hex hmac>`).

    시크릿이 설정돼 있지 않으면 검증을 건너뛴다. 이 웹훅은 예약을 만들지 않고
    감사 로그만 남기므로, 검증 없이 받는 최악은 "가짜 메모가 붙는다" 다.
    """
    secret = os.getenv("ELEVENLABS_WEBHOOK_SECRET", "").strip()
    if not secret:
        # 공개 배포에서는 시크릿이 없으면 **닫는다**. 로컬에서는 예전처럼 통과시킨다.
        #
        # 터널을 쓰던 동안에는 `voice_tunnel_proxy.py` 가 이 경로를 아예 안 열어서
        # 막혀 있었다. Fly 에는 그 프록시가 없으므로 여기서 막아야 한다. 검증 없이
        # 열어 두면 통화의 conversation_id 를 아는 사람이 남의 예약 감사 로그에
        # 가짜 메모를 붙일 수 있다 (예약을 만들거나 지우지는 못한다).
        if os.getenv("PUBLIC_SURFACE", "all").strip().lower() == "voice":
            raise HTTPException(status_code=404, detail="Not Found")
        return
    if not signature_header:
        raise HTTPException(status_code=401, detail="Missing webhook signature")

    parts = dict(
        piece.split("=", 1) for piece in signature_header.split(",") if "=" in piece
    )
    timestamp, provided = parts.get("t"), parts.get("v0")
    if not timestamp or not provided:
        raise HTTPException(status_code=401, detail="Malformed webhook signature")

    expected = hmac.new(
        secret.encode("utf-8"), f"{timestamp}.".encode("utf-8") + raw, hashlib.sha256
    ).hexdigest()
    if not hmac.compare_digest(expected, provided):
        raise HTTPException(status_code=401, detail="Bad webhook signature")


@router.post("/voice/post-call")
async def post_call(
    request: Request, elevenlabs_signature: Optional[str] = Header(None)
) -> dict[str, Any]:
    """통화가 끝나면 그 사실을 예약의 감사 로그에 남긴다.

    프로 샵이 티 시트에서 "이 예약은 8시 12분 전화로 들어왔고, 통화는 이만큼
    걸렸다" 를 볼 수 있어야 나중에 분쟁이 났을 때 되짚을 수 있다.
    """
    raw = await request.body()
    _verify_webhook(raw, elevenlabs_signature)

    try:
        payload = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Body was not JSON") from None

    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="Body was not a JSON object")

    data = payload.get("data")
    data = data if isinstance(data, dict) else payload

    conversation_id = str(data.get("conversation_id") or "")
    metadata = data.get("metadata")
    duration = metadata.get("call_duration_secs") if isinstance(metadata, dict) else None

    with _sessions_lock:
        session = _sessions.get(conversation_id)
        booking_ids = set(session.revealed) if session else set()

    if not booking_ids:
        return {"ok": True, "annotated": 0}

    note = f"Phone call {conversation_id} ended"
    if isinstance(duration, (int, float)):
        note += f" after {int(duration)} seconds"
    note += "."

    def annotate() -> int:
        annotated = 0
        with ts.bookings_tx(Scope(ids=booking_ids)) as bookings:
            for booking in bookings:
                if booking.id in booking_ids:
                    ts._audit(booking, note)
                    annotated += 1
        return annotated

    # 저장소가 Supabase 면 이 트랜잭션은 네트워크 왕복이다. async 핸들러에서 그대로
    # 돌리면 그동안 이벤트 루프 전체(다른 통화의 웹훅, 음성 세션 발급)가 멈춘다.
    annotated = await asyncio.to_thread(annotate)
    return {"ok": True, "annotated": annotated}
