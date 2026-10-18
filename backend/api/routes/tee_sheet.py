"""Pelham Hills 티 시트 API.

와이어 계약: `frontend/lib/teeSheet/types.ts` (frozen).
- 모든 날짜는 ISO `YYYY-MM-DD`. `dayIndex` 는 더 이상 존재하지 않는다 (프론트가 파생).
- 모든 `time` 은 `GET /tee-sheet/slots?date=` 가 돌려주는 슬롯 라벨 중 하나여야 한다.
- Player 는 `firstName`/`lastName` 를 갖고 `name` 은 서버가 파생한다.

영속화는 `backend/services/tee_sheet_store.py` (기본은 JSON 파일 + RLock + 원자적 쓰기,
`TEE_SHEET_BACKEND=supabase` 면 Supabase 테이블). 모든 읽기·쓰기는 `Scope` 로 그 요청이
실제로 필요한 날짜/id 만 다룬다 — 과거 예약을 들여오면 테이블 전체를 읽을 수 없다.
"""

from __future__ import annotations

import asyncio
import logging
import re
import threading
import time
from contextlib import contextmanager
from datetime import date as date_cls, datetime, timedelta, timezone
from enum import Enum
from typing import Any, Iterator, Literal, Optional
from uuid import uuid4

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field, model_validator

from backend.services import tee_sheet_store as store
from backend.services.tee_sheet_store import Scope

logger = logging.getLogger(__name__)
router = APIRouter()


# ===== 슬롯 설정 ======================================================
# Chronogolf 와 동일한 격자: 첫 티 6:40 AM, 9분 간격, 마지막 티 6:58 PM.
# 마지막 티를 처음엔 "오후 6시까지" 로 짐작했는데 틀렸다. Chronogolf export
# (2026-04~09, 예약 8,600여 건) 에 6:04~6:58 PM 예약이 250건 가까이 있고 전부 이
# 9분 격자 위다 — 격자 밖 시각이나 6:40 AM 이전은 한 건도 없다. 격자를 좁게 두면
# 그 예약들이 시트에서 칸을 잃는다. 해가 짧은 달의 마감 시각은 여기서 다루지 않는다.
# 임포터(`scripts/import_*`)도 이 상수를 그대로 쓴다 — 격자 정의는 여기 하나뿐이다.

FIRST_TEE_MINUTES = 6 * 60 + 40      # 06:40
LAST_TEE_MINUTES = 18 * 60 + 58      # 18:58 (경계 포함, 격자 위의 마지막 슬롯)
SLOT_INTERVAL_MINUTES = 9
CARTS_PER_SLOT = 4
# 하나의 티 타임은 플레이어 4자리다. 이 4자리는 **여러 예약이 나눠 가질 수 있다**
# (예: 7:43 AM 에 회원 2인 예약 + GolfNow 온라인 2인 예약). Chronogolf 와 동일한 규칙.
PLAYERS_PER_TEE_TIME = 4

# 음성 에이전트가 손님 이름과 전화번호를 받아 적는 동안 자리를 잠가 두는 시간.
# 통화 한 건이 "3시에 두 명" 에서 확정까지 가는 데 보통 40~60초 걸린다. 3분이면
# 넉넉하고, 손님이 중간에 끊어도 자리가 오래 죽어 있지 않다.
HOLD_TTL_SECONDS = 180

WEEKDAY_RATE = 47.79
WEEKEND_RATE = 58.41

# 1인 카트 요금(세전, 달러). **2026-09-15 클럽 확인: 홀 수·요금제와 무관하게 $19.00 한 가지다**
# (HST 13% 를 더하면 $21.47).
#
# 참고로 Chronogolf export(2026-04~09, 좌석 25,108행)에 남아 있는 과거 금액은 여러 가지였다:
# 19.47(6,607행, 18홀 일반), 17.70(2,607행, Public Senior), 9.74(1,760행, 9홀), 11.50(1,369행, 미상).
# 지금 요금표는 한 금액으로 통일됐으므로 상수 하나만 둔다. 옛 예약의 금액은 그대로 보존된다 —
# 이 값은 카트를 **새로 켤 때** 채우는 기본값이고, 이미 적힌 금액을 건드리지 않는다.
CART_FEE = 19.00


def cart_fee_for(rate_plan: str, holes: int) -> float:
    """1인 카트 요금. 카드가 처음 채우는 값이고, 사람이 카드에서 고칠 수 있다.

    이름에 "Cart" 가 든 회원 요금제("... with Weekday Cart", "... with 7 Day Cart")는
    회원권에 카트가 들어 있다고 보고 0 이다 — export 로 확인한 것이 아니라 요금제 이름을 읽은 것이다.

    `holes` 는 지금 금액에 영향을 주지 않지만 인자로 남겨 둔다. 홀 수별 요금이 다시 생기면
    호출부(카드·예약 수정·리포트)를 건드리지 않고 이 함수만 고치면 된다.
    """
    if "cart" in (rate_plan or "").lower():
        return 0.0
    return CART_FEE


def _same_money(a: float, b: float) -> bool:
    return round(a, 2) == round(b, 2)

# 특정 날짜 강제 요금 (공휴일 / 이벤트 / 단체 행사용).
# 지금은 비어 있다. 날짜를 넣으면 주말/평일 판정보다 우선한다.
RATE_OVERRIDES: dict[str, float] = {}

# 공휴일 — supabase/migrations/0025_tee_holiday_rates.sql 의 `pelham_tee_holidays` 시드와 같다.
# 프로덕션은 그 표가 기준이고, 이 사본은 로컬/레거시 API 가 같은 금액을 내게 하려는 것이다.
HOLIDAY_RATE = WEEKEND_RATE
HOLIDAYS: dict[str, str] = {
    "2026-01-01": "New Year's Day", "2026-02-16": "Family Day", "2026-04-03": "Good Friday",
    "2026-05-18": "Victoria Day", "2026-07-01": "Canada Day", "2026-08-03": "Civic Holiday",
    "2026-09-07": "Labour Day", "2026-10-12": "Thanksgiving", "2026-12-25": "Christmas Day",
    "2026-12-26": "Boxing Day",
    "2027-01-01": "New Year's Day", "2027-02-15": "Family Day", "2027-03-26": "Good Friday",
    "2027-05-24": "Victoria Day", "2027-07-01": "Canada Day", "2027-08-02": "Civic Holiday",
    "2027-09-06": "Labour Day", "2027-10-11": "Thanksgiving", "2027-12-25": "Christmas Day",
    "2027-12-26": "Boxing Day",
}

ISO_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
SLOT_TIME_RE = re.compile(r"^\d{1,2}:\d{2} (AM|PM)$")
MAX_TASKS = 50
AUDIT_LIMIT = 40


# ===== 열거형 / 모델 ==================================================

class BookingStatus(str, Enum):
    RESERVED = "reserved"
    CHECKED_IN = "checked_in"
    PAID = "paid"
    CANCELLED = "cancelled"
    NO_SHOW = "no_show"
    BLOCKED = "blocked"


class PlayerType(str, Enum):
    EXISTING = "Existing Customer"
    GUEST = "Guest"


class BookingSource(str, Enum):
    """이 예약을 누가 만들었나. 통화로 들어온 건을 티 시트에서 구분하기 위한 것."""

    STAFF = "staff"          # 프로 샵 직원이 어드민에서 직접
    WEB = "web"              # 손님이 /book/tee-time 에서
    VOICE = "voice"          # 음성 에이전트가 확정한 예약
    VOICE_HOLD = "voice_hold"  # 통화 중 임시 홀드. 확정되면 VOICE 로 바뀐다.


class TaskState(str, Enum):
    QUEUED = "queued"
    RUNNING = "running"
    SUCCESS = "success"
    FAILED = "failed"


def _split_name(name: str) -> tuple[str, str]:
    """성은 **마지막 토큰**이다. 구현은 `store.split_name` 하나뿐 (시드와 동일해야 한다).

    "Micah Xeric" -> ("Micah", "Xeric")
    "Blake Jo Kestrel" -> ("Blake Jo", "Kestrel")
    "Guest" -> ("Guest", "")
    """
    return store.split_name(name)


class Player(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid4()))
    name: str = "Guest"
    firstName: str = ""
    lastName: str = ""
    email: str = ""
    phone: str = ""
    type: PlayerType = PlayerType.GUEST
    ratePlan: str = "Public"
    arrived: bool = False
    paid: bool = False
    cancelled: bool = False
    no_show: bool = False
    # 이 사람이 카트를 쓰나(1인 요금 한 줄). 예약 단위 `cartCount`(카트 대수)와는 따로 둔다 —
    # 둘을 한 숫자로 합치면 헬스 체크의 카트 대수 검사와 두 곳에서 같은 값을 쓰게 된다.
    cart: bool = False
    # 1인 카트 요금(세전, 달러 — `rate` 와 같은 단위). 카트를 켤 때 `cart_fee_for` 로 채운다.
    cartFee: float = Field(default=0.0, ge=0)
    # 결제로 표시된 시각. 영수증의 날짜·시각이다. 이 필드가 생기기 전의 결제에는 없다.
    paidAt: datetime | None = None

    @model_validator(mode="before")
    @classmethod
    def _reconcile_names(cls, data: Any) -> Any:
        """`name` 은 항상 서버가 파생한다.

        - firstName/lastName 중 하나라도 오면 그것이 진실. name 은 재계산.
        - name 만 오면 첫 토큰을 firstName, 나머지를 lastName 으로 쪼갠다.
        """
        if not isinstance(data, dict):
            return data
        data = dict(data)
        first = str(data.get("firstName") or "").strip()
        last = str(data.get("lastName") or "").strip()
        name = str(data.get("name") or "").strip()

        if first or last:
            pass
        elif name:
            first, last = _split_name(name)
        else:
            first, last = "Guest", ""

        data["firstName"] = first
        data["lastName"] = last
        data["name"] = f"{first} {last}".strip()
        return data


class AuditEntry(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid4()))
    ts: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    message: str


class TeeBooking(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid4()))
    date: str = Field(..., pattern=r"^\d{4}-\d{2}-\d{2}$")
    time: str = Field(..., pattern=r"^\d{1,2}:\d{2} (AM|PM)$")
    holes: Literal[9, 18] = 18
    rate: float = WEEKDAY_RATE
    span: int = Field(default=1, ge=1, le=7)
    color: Literal["blue", "gold", "gray"] = "gold"
    title: str
    status: BookingStatus = BookingStatus.RESERVED
    cartCount: int = Field(default=0, ge=0, le=4)
    notes: str = ""
    players: list[Player] = Field(default_factory=list, max_length=4)
    audit: list[AuditEntry] = Field(default_factory=list)
    cancelReason: str | None = None
    source: BookingSource = BookingSource.STAFF
    # 음성 홀드에만 채워진다. 이 시각이 지나면 정원 계산에서 빠지고, 다음
    # 정리 패스가 레코드를 실제로 지운다. 확정된 예약은 항상 None.
    holdExpiresAt: datetime | None = None
    createdAt: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    updatedAt: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class TeeSlot(BaseModel):
    time: str
    minutes: int
    rate: float
    cartsTotal: int
    dayType: Literal["weekday", "weekend", "holiday"] = "weekday"
    holiday: str | None = None


class SlotsResponse(BaseModel):
    date: str
    slots: list[TeeSlot]


class CreateBookingRequest(BaseModel):
    date: str
    time: str
    title: str
    holes: Literal[9, 18] = 18
    rate: float | None = None
    cartCount: int = Field(default=0, ge=0, le=4)
    color: Literal["blue", "gold", "gray"] = "gold"
    notes: str = ""
    span: int = Field(default=1, ge=1, le=7)
    players: list[Player] = Field(default_factory=list, max_length=4)


class PatchBookingRequest(BaseModel):
    date: str | None = None
    time: str | None = None
    title: str | None = None
    holes: Literal[9, 18] | None = None
    rate: float | None = None
    cartCount: int | None = Field(default=None, ge=0, le=4)
    color: Literal["blue", "gold", "gray"] | None = None
    notes: str | None = None
    status: BookingStatus | None = None
    cancelReason: str | None = None
    span: int | None = Field(default=None, ge=1, le=7)


class AddPlayerRequest(BaseModel):
    name: str | None = None
    firstName: str | None = None
    lastName: str | None = None
    email: str = ""
    phone: str = ""
    type: PlayerType = PlayerType.GUEST
    ratePlan: str = "Public"
    arrived: bool = False
    paid: bool = False
    cancelled: bool = False
    no_show: bool = False
    cart: bool = False
    # 비우면 요금제·홀 수로 채운다.
    cartFee: float | None = Field(default=None, ge=0)


class PatchPlayerRequest(BaseModel):
    name: str | None = None
    firstName: str | None = None
    lastName: str | None = None
    email: str | None = None
    phone: str | None = None
    type: PlayerType | None = None
    ratePlan: str | None = None
    arrived: bool | None = None
    paid: bool | None = None
    cancelled: bool | None = None
    no_show: bool | None = None
    cart: bool | None = None
    cartFee: float | None = Field(default=None, ge=0)


class ReportBookingLine(BaseModel):
    id: str
    time: str
    title: str
    players: int
    rate: float
    status: BookingStatus


class DailyReport(BaseModel):
    date: str
    total_tee_times: int
    total_slots: int
    booked_slots: int
    available_slots: int
    occupancy_rate: float
    total_revenue: float
    collected_revenue: float
    outstanding_revenue: float
    checked_in: int
    cancelled: int
    no_show: int
    carts: int
    bookings: list[ReportBookingLine]


class WeekSummary(BaseModel):
    total_days: int
    total_tee_times: int
    total_booked_slots: int
    total_revenue: float
    collected_revenue: float
    average_occupancy: float


class WeekReport(BaseModel):
    from_: str = Field(..., alias="from")
    to: str
    days: list[DailyReport]
    summary: WeekSummary

    model_config = {"populate_by_name": True}


class OrchestrationTask(BaseModel):
    id: str
    name: str
    state: TaskState
    created_at: datetime
    started_at: datetime | None = None
    finished_at: datetime | None = None
    duration_ms: int | None = None
    detail: str = ""
    result: dict[str, Any] | None = None
    error: str | None = None


class AvailableTask(BaseModel):
    name: str
    description: str
    endpoint: str


class OrchestrationStatus(BaseModel):
    status: str
    total_bookings: int
    timestamp: datetime
    available_tasks: list[AvailableTask]
    tasks: list[OrchestrationTask]


class TaskAck(BaseModel):
    accepted: bool
    tasks: list[OrchestrationTask]
    message: str


# ===== 시간 / 슬롯 헬퍼 ================================================

def minutes_to_label(minutes: int) -> str:
    normalized = minutes % (24 * 60)
    hour24, minute = divmod(normalized, 60)
    suffix = "AM" if hour24 < 12 else "PM"
    hour12 = hour24 % 12 or 12
    return f"{hour12}:{minute:02d} {suffix}"


def label_to_minutes(label: str) -> int | None:
    match = re.match(r"^(\d{1,2}):(\d{2})\s*(AM|PM)$", label.strip(), re.IGNORECASE)
    if not match:
        return None
    hour = int(match.group(1)) % 12
    if match.group(3).upper() == "PM":
        hour += 12
    return hour * 60 + int(match.group(2))


def parse_iso_date(value: str, field: str = "date") -> date_cls:
    if not isinstance(value, str) or not ISO_DATE_RE.match(value):
        raise HTTPException(status_code=422, detail=f"'{field}' must be an ISO date (YYYY-MM-DD)")
    try:
        return date_cls.fromisoformat(value)
    except ValueError:
        raise HTTPException(status_code=422, detail=f"'{field}' is not a real calendar date: {value}")


def day_type_for(iso_date: str) -> str:
    """'holiday' > 'weekend' > 'weekday'."""
    if iso_date in HOLIDAYS:
        return "holiday"
    return "weekend" if parse_iso_date(iso_date).weekday() >= 5 else "weekday"


def slot_rate_for(iso_date: str) -> float:
    """날짜별 요금: 오버라이드 > 공휴일 > 주말 > 평일."""
    override = RATE_OVERRIDES.get(iso_date)
    if override is not None:
        return override
    kind = day_type_for(iso_date)
    if kind == "holiday":
        return HOLIDAY_RATE
    return WEEKEND_RATE if kind == "weekend" else WEEKDAY_RATE


def green_fee_for(iso_date: str, holes: int) -> float:
    """그 날, 그 홀 수의 1인 그린피(세전). 9홀은 18홀 요금의 절반, 센트에서 반올림(half-up).

    DB 의 `pelham_tee_rate_for`(0033)와 같은 값이어야 한다 — 파이썬 `round` 는 은행가 반올림이라
    58.41 의 절반을 29.20 으로 만든다. 그래서 센트 정수로 계산한다.
    """
    rate = slot_rate_for(iso_date)
    if holes != 9:
        return rate
    return (round(rate * 100) + 1) // 2 / 100


def generate_slots(iso_date: str) -> list[TeeSlot]:
    rate = slot_rate_for(iso_date)
    kind = day_type_for(iso_date)
    slots: list[TeeSlot] = []
    minutes = FIRST_TEE_MINUTES
    while minutes <= LAST_TEE_MINUTES:
        slots.append(
            TeeSlot(
                time=minutes_to_label(minutes),
                minutes=minutes,
                rate=rate,
                cartsTotal=CARTS_PER_SLOT,
                dayType=kind,
                holiday=HOLIDAYS.get(iso_date),
            )
        )
        minutes += SLOT_INTERVAL_MINUTES
    return slots


def slot_index(iso_date: str) -> dict[str, TeeSlot]:
    return {slot.time: slot for slot in generate_slots(iso_date)}


def require_slot(iso_date: str, time_label: str) -> TeeSlot:
    parse_iso_date(iso_date)
    if not isinstance(time_label, str) or not SLOT_TIME_RE.match(time_label.strip()):
        raise HTTPException(status_code=422, detail=f"'{time_label}' is not a valid tee time label")
    slot = slot_index(iso_date).get(time_label.strip())
    if slot is None:
        raise HTTPException(
            status_code=422,
            detail=f"{time_label} is not a bookable tee time on {iso_date}",
        )
    return slot


def _sort_key(booking: TeeBooking) -> tuple[str, int]:
    return (booking.date, label_to_minutes(booking.time) or 0)


# ===== 저장소 브리지 ===================================================

def _to_models(raw: list[dict[str, Any]]) -> list[TeeBooking]:
    models: list[TeeBooking] = []
    for item in raw:
        try:
            models.append(TeeBooking.model_validate(item))
        except Exception as exc:  # pragma: no cover - 손상 레코드 방어
            logger.warning("티 시트 레코드 파싱 실패, 건너뜀: %s", exc)
    return models


class ScopedBookings(list):
    """`read_bookings` / `bookings_tx` 가 돌려주는 목록. **무엇을 읽었는지** 를 함께 든다.

    `.scope` 가 None 이면 전체를 읽은 것이다. 정원 검사(`tee_time_players`)가 이것을
    보고, 검사하려는 날짜를 다 읽지 않은 목록이면 거절한다. 범위를 목록에 붙여 두는
    이유: 따로 인자로 넘기면 다른 목록과 짝이 어긋나도 아무도 모른다.
    슬라이스 대입(`bookings[:] = ...`)과 sort 는 이 객체를 그대로 두지만, 컴프리헨션이나
    `sorted()` 결과는 평범한 list 라 범위가 떨어진다 — 그런 목록은 정원 검사가 받지 않는다.
    """

    def __init__(self, items: Any = (), scope: Scope | None = None) -> None:
        super().__init__(items)
        self.scope = scope


class ScopeNotLoaded(RuntimeError):
    """정원 검사 대상 날짜를 다 읽지 않은 목록으로 검사하려 했다 (프로그래밍 오류)."""


def read_bookings(scope: Scope | None = None) -> ScopedBookings:
    return ScopedBookings(sorted(_to_models(store.load_bookings(scope)), key=_sort_key), scope)


@contextmanager
def bookings_tx(scope: Scope | None = None) -> Iterator[ScopedBookings]:
    """읽기-수정-쓰기 트랜잭션. 이 블록 안에서 절대 `await` 하지 말 것.

    `scope` 밖의 예약은 목록에 없고, 저장소도 건드리지 않는다 (`store.mutate` 참고).

    블록 안의 정원 검사는 읽은 시점 기준이다. 그사이 웹·직원 화면이 같은 티타임을 채웠으면
    DB 트리거(0017)가 쓰기를 거절하고, 여기서 `require_tee_time_capacity` 와 같은 409 로
    바꾼다. 거절된 쓰기는 저장되지 않는다.
    """
    try:
        with store.mutate(scope) as raw:
            models = ScopedBookings(sorted(_to_models(raw), key=_sort_key), scope)
            yield models
            models.sort(key=_sort_key)
            raw[:] = [m.model_dump(mode="json") for m in models]
    except RuntimeError as exc:
        # `SupabaseStoreError` 를 임포트하지 않는다: JSON 모드는 그 모듈(httpx) 없이 돈다.
        if getattr(exc, "code", None) != "PT409":
            raise
        raise HTTPException(
            status_code=409,
            detail="That tee time just filled up. Please pick another time.",
        ) from None


def _require_loaded(bookings: list[TeeBooking], iso_date: str) -> None:
    """이 목록이 `iso_date` 의 예약을 **전부** 담고 있지 않으면 터뜨린다.

    `tee_time_players` 는 받은 목록을 더할 뿐이다. 그 티 타임의 다른 예약이 빠진 목록을
    주면 인원이 적게 나오고, 정원 검사가 통과하고, 초과 예약이 된다 — 오류도 로그도 없이.
    그래서 조용히 세지 않고 멈춘다. 범위를 모르는 평범한 list 도 같은 이유로 거절한다.
    """
    if not isinstance(bookings, ScopedBookings):
        raise ScopeNotLoaded(
            "capacity check needs the list from read_bookings()/bookings_tx(); "
            "a plain list does not say which dates it covers"
        )
    if bookings.scope is not None and not bookings.scope.covers_date(iso_date):
        raise ScopeNotLoaded(f"capacity check on {iso_date}, which this transaction did not load")


def _require_date_in_tx(bookings: ScopedBookings, iso_date: str) -> None:
    """미리 읽은 날짜로 범위를 잡은 트랜잭션에서, 예약이 그사이 다른 날로 옮겨졌는지.

    PATCH·플레이어 추가는 id 로 먼저 읽어 날짜를 알아낸 뒤 그 날짜로 트랜잭션을 연다.
    그 사이 다른 요청이 예약을 옮겼으면 새 날짜는 읽지 않았으므로 정원을 셀 수 없다.
    500 대신 409 로 돌려보내 호출자가 다시 시도하게 한다.
    """
    if bookings.scope is not None and not bookings.scope.covers_date(iso_date):
        raise HTTPException(
            status_code=409,
            detail="This reservation changed while it was being edited. Reload and try again.",
        )


def _find(bookings: list[TeeBooking], booking_id: str) -> TeeBooking:
    for booking in bookings:
        if booking.id == booking_id:
            return booking
    raise HTTPException(status_code=404, detail="Booking not found")


def _audit(booking: TeeBooking, message: str) -> None:
    booking.audit.insert(0, AuditEntry(message=message))
    del booking.audit[AUDIT_LIMIT:]
    booking.updatedAt = datetime.now(timezone.utc)


def _as_utc(value: datetime) -> datetime:
    """JSON 을 오가며 tzinfo 가 떨어진 값을 UTC 로 되돌린다.

    naive datetime 과 aware datetime 을 비교하면 TypeError 가 난다. 홀드 만료
    판정은 예약 경로 전체가 지나가는 길목이라 여기서 한 번 정규화한다.
    """
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def hold_expired(booking: TeeBooking, now: datetime) -> bool:
    """만료된 음성 홀드인가. 홀드가 아닌 예약(`holdExpiresAt is None`)은 언제나 False."""
    if booking.holdExpiresAt is None:
        return False
    return _as_utc(booking.holdExpiresAt) <= now


def occupies_seat(booking: TeeBooking, now: datetime) -> bool:
    """이 예약이 티 타임 정원을 실제로 잡아먹고 있는가.

    - 취소된 예약은 자리를 반납한다 (그 자리는 다시 팔 수 있어야 한다).
    - 만료된 음성 홀드도 마찬가지다. **레코드가 아직 디스크에 남아 있어도**
      정원 계산에서는 즉시 빠진다 — 자리를 되찾는 데 정리 패스를 기다리게
      하면, 손님이 전화를 끊은 뒤 3분 동안 팔 수 있는 자리가 죽어 있게 된다.
    """
    if booking.status == BookingStatus.CANCELLED:
        return False
    return not hold_expired(booking, now)


def purge_expired_holds(bookings: list[TeeBooking], now: datetime | None = None) -> int:
    """만료된 음성 홀드를 목록에서 실제로 지운다. 지운 개수를 돌려준다.

    반드시 `bookings_tx()` 블록 안에서 부를 것. 정원 계산은 이미 만료 홀드를
    무시하므로(`occupies_seat`) 이 정리는 순전히 위생 목적이다 — 티 시트 격자에
    유령 예약이 쌓이지 않게 한다.
    """
    now = now or datetime.now(timezone.utc)
    keep = [b for b in bookings if not hold_expired(b, now)]
    removed = len(bookings) - len(keep)
    if removed:
        bookings[:] = keep
    return removed


def tee_time_players(
    bookings: list[TeeBooking],
    iso_date: str,
    time_label: str,
    exclude_id: str | None = None,
    now: datetime | None = None,
) -> int:
    """해당 티 타임이 이미 잡아먹은 플레이어 자리 수.

    무엇이 자리를 차지하는지의 판정은 `occupies_seat` 하나뿐이다.
    `bookings` 는 그 날짜를 다 읽은 `ScopedBookings` 여야 한다 (아니면 `ScopeNotLoaded`).
    검사를 여기 둔 이유: 음성 `find_tee_times` 는 이 함수를 직접 부른다.
    """
    _require_loaded(bookings, iso_date)
    now = now or datetime.now(timezone.utc)
    return sum(
        len(other.players)
        for other in bookings
        if other.id != exclude_id
        and other.date == iso_date
        and other.time == time_label
        and occupies_seat(other, now)
    )


def require_tee_time_capacity(
    bookings: list[TeeBooking],
    iso_date: str,
    time_label: str,
    incoming: int,
    exclude_id: str | None = None,
) -> None:
    """티 타임 정원(4명) 검사. 절대 아무것도 변경하지 않는다 (읽기 전용).

    한 티 타임에 예약이 몇 건이든 상관없다. 합계 인원만 4명을 넘지 않으면 된다.
    """
    taken = tee_time_players(bookings, iso_date, time_label, exclude_id)
    if taken + incoming > PLAYERS_PER_TEE_TIME:
        raise HTTPException(
            status_code=409,
            detail=(
                f"{time_label} on {iso_date} only holds {PLAYERS_PER_TEE_TIME} players; "
                f"{taken} are already taken and {incoming} more were requested"
            ),
        )


# ===== 슬롯 엔드포인트 =================================================

@router.get("/tee-sheet/slots", response_model=SlotsResponse)
def get_slots(date: str = Query(..., description="ISO date, YYYY-MM-DD")) -> SlotsResponse:
    parse_iso_date(date)
    return SlotsResponse(date=date, slots=generate_slots(date))


# ===== 예약 CRUD =======================================================

@router.get("/tee-sheet/bookings", response_model=list[TeeBooking])
def list_bookings(
    date: str | None = Query(None),
    from_: str | None = Query(None, alias="from"),
    to: str | None = Query(None),
) -> list[TeeBooking]:
    # 만료된 음성 홀드는 아무에게도 보여주지 않는다. 정리 패스가 레코드를 지우기
    # 전이라도 티 시트 격자와 고객 예약 화면에는 존재하지 않는 것으로 취급한다.
    now = datetime.now(timezone.utc)

    # 날짜는 범위를 만들기 **전에** 검증한다. 잘못된 값이 supabase 필터로 가면
    # Postgres 22007 → 500 이 된다. 여기서 막아야 422 다.
    if date:
        parse_iso_date(date)
        scope: Scope | None = Scope(dates={date})
    elif from_ or to:
        if from_:
            parse_iso_date(from_, "from")
        if to:
            parse_iso_date(to, "to")
        scope = Scope(date_from=from_ or None, date_to=to or None)
    else:
        scope = None  # 파라미터 없음 = 전체 (예전 그대로)

    return [b for b in read_bookings(scope) if not hold_expired(b, now)]


@router.get("/tee-sheet/bookings/{booking_id}", response_model=TeeBooking)
def get_booking(booking_id: str) -> TeeBooking:
    return _find(read_bookings(Scope(ids={booking_id})), booking_id)


@router.post("/tee-sheet/bookings", response_model=TeeBooking, status_code=201)
def create_booking(body: CreateBookingRequest) -> TeeBooking:
    slot = require_slot(body.date, body.time)
    time_label = body.time.strip()

    # 정원은 그날의 예약만으로 결정된다. require_slot 이 날짜를 이미 검증했다.
    with bookings_tx(Scope(dates={body.date})) as bookings:
        # 생성 엔드포인트는 기본 플레이어를 만들지 않는다. 요청에 실려 온 인원이 곧 정원 소비량.
        require_tee_time_capacity(bookings, body.date, time_label, incoming=len(body.players))
        booking = TeeBooking(
            date=body.date,
            time=time_label,
            title=body.title,
            holes=body.holes,
            rate=slot.rate if body.rate is None else body.rate,
            span=body.span,
            color=body.color,
            notes=body.notes,
            cartCount=body.cartCount,
            players=body.players,
        )
        for player in booking.players:
            _settle_new_player(player, booking.holes, fee_given="cartFee" in player.model_fields_set)
        _audit(booking, f"Reservation created for {booking.date} {booking.time}.")
        bookings.append(booking)
        return booking


def _settle_new_player(player: Player, holes: int, *, fee_given: bool) -> None:
    """새로 들어온 플레이어의 파생 값: 카트 요금과 결제 시각."""
    if not player.cart:
        player.cartFee = 0.0
    elif not fee_given:
        player.cartFee = cart_fee_for(player.ratePlan, holes)
    if player.paid and player.paidAt is None:
        player.paidAt = datetime.now(timezone.utc)


def _apply_status(booking: TeeBooking, status: BookingStatus, cancel_reason: str | None) -> str:
    """상태 전이 + 플레이어 플래그 동기화. 감사 로그 문구를 돌려준다."""
    booking.status = status

    if status == BookingStatus.CHECKED_IN:
        for player in booking.players:
            if not player.cancelled:
                player.arrived = True
                player.no_show = False
        return "Reservation checked in."

    if status == BookingStatus.PAID:
        now = datetime.now(timezone.utc)
        for player in booking.players:
            if not player.cancelled:
                player.arrived = True
                if not player.paid:
                    player.paidAt = now
                player.paid = True
                player.no_show = False
        return "Reservation marked paid."

    if status == BookingStatus.CANCELLED:
        booking.cancelReason = cancel_reason or "Cancelled by pro shop."
        for player in booking.players:
            player.cancelled = True
            player.arrived = False
        return f"Reservation cancelled: {booking.cancelReason}"

    if status == BookingStatus.NO_SHOW:
        for player in booking.players:
            if not player.cancelled:
                player.no_show = True
        return "Reservation marked no-show."

    if status == BookingStatus.BLOCKED:
        return "Tee time blocked."

    # reserved: 취소/노쇼/체크인/결제를 모두 되돌린다.
    # paid 를 남겨두면 취소 후 복구한 예약이 collected_revenue 에 잡혀 매출이 부풀려진다.
    booking.cancelReason = None
    for player in booking.players:
        player.cancelled = False
        player.no_show = False
        player.arrived = False
        player.paid = False
        player.paidAt = None
    return "Reservation reinstated as reserved."


@router.patch("/tee-sheet/bookings/{booking_id}", response_model=TeeBooking)
def patch_booking(booking_id: str, body: PatchBookingRequest) -> TeeBooking:
    fields = body.model_dump(exclude_unset=True)

    # 정원 검사에 필요한 날짜(현재 날짜, 옮길 날짜)를 알려면 먼저 id 로 읽어야 한다.
    # 없는 예약은 여기서 404 — 날짜 검증(422)보다 먼저라는 순서도 예전과 같다.
    current = _find(read_bookings(Scope(ids={booking_id})), booking_id)
    dates = {current.date}
    if fields.get("date"):
        parse_iso_date(fields["date"])  # 범위에 넣기 전에 검증 (supabase 필터 → 500 방지)
        dates.add(fields["date"])

    with bookings_tx(Scope(ids={booking_id}, dates=dates)) as bookings:
        booking = _find(bookings, booking_id)

        # --- 날짜/시간 이동은 슬롯 재검증 + 충돌 검사 ---
        if "date" in fields or "time" in fields:
            new_date = fields.get("date") or booking.date
            new_time = (fields.get("time") or booking.time).strip()
            require_slot(new_date, new_time)
            if new_date != booking.date or new_time != booking.time:
                # 취소된 예약은 어디에서도 자리를 잡지 않는다 (`tee_time_players` 가 제외한다).
                # 따라서 옮기는 것만으로는 목적지 정원을 한 자리도 먹지 않는다.
                # 되살릴 때 아래 status 게이트가 (이동 후의) 목적지 정원을 다시 검사한다.
                if booking.status != BookingStatus.CANCELLED:
                    # 시간만 바꾸면 목적지는 예약의 **지금** 날짜다. 미리 읽은 뒤 누가 옮겼으면
                    # 그 날짜는 읽지 않았다.
                    _require_date_in_tx(bookings, new_date)
                    require_tee_time_capacity(
                        bookings, new_date, new_time,
                        incoming=len(booking.players), exclude_id=booking.id,
                    )
                booking.date = new_date
                booking.time = new_time
                _audit(booking, f"Moved to {new_date} {new_time}.")

        if "title" in fields and fields["title"] is not None and fields["title"] != booking.title:
            booking.title = fields["title"]
            _audit(booking, f"Title changed to '{booking.title}'.")

        if "holes" in fields and fields["holes"] is not None and fields["holes"] != booking.holes:
            old_holes = booking.holes
            booking.holes = fields["holes"]
            # 그린피도 아직 자동값이고 아무도 결제하지 않았으면 새 홀 수의 값으로(0033 과 같은 규칙).
            # 같은 요청에 rate 를 직접 보냈으면 아래에서 그 값이 덮어쓴다.
            if not any(p.paid for p in booking.players) and _same_money(
                booking.rate, green_fee_for(booking.date, old_holes)
            ):
                booking.rate = green_fee_for(booking.date, booking.holes)
                _audit(booking, f"Rate set to ${booking.rate:.2f}.")
            # 카트 요금이 아직 자동값이면 새 홀 수의 값으로 따라간다. 사람이 고친 금액과
            # 이미 결제한 사람의 금액은 그대로 둔다 — 결제한 뒤에 금액이 바뀌면 재인쇄한
            # 영수증이 받은 돈과 달라진다.
            for player in booking.players:
                if (
                    player.cart
                    and not player.paid
                    and _same_money(player.cartFee, cart_fee_for(player.ratePlan, old_holes))
                ):
                    player.cartFee = cart_fee_for(player.ratePlan, booking.holes)
            _audit(booking, f"Holes set to {booking.holes}.")

        if "rate" in fields and fields["rate"] is not None and fields["rate"] != booking.rate:
            booking.rate = fields["rate"]
            _audit(booking, f"Rate set to ${booking.rate:.2f}.")

        if "cartCount" in fields and fields["cartCount"] is not None and fields["cartCount"] != booking.cartCount:
            booking.cartCount = fields["cartCount"]
            _audit(booking, f"Cart count set to {booking.cartCount}.")

        if "color" in fields and fields["color"] is not None and fields["color"] != booking.color:
            booking.color = fields["color"]
            _audit(booking, f"Color set to {booking.color}.")

        if "span" in fields and fields["span"] is not None and fields["span"] != booking.span:
            booking.span = fields["span"]
            _audit(booking, f"Span set to {booking.span}.")

        if "notes" in fields and fields["notes"] is not None and fields["notes"] != booking.notes:
            booking.notes = fields["notes"]
            _audit(booking, "Notes updated.")

        if "status" in fields and fields["status"] is not None:
            status = BookingStatus(fields["status"])
            # 취소된 예약은 정원을 차지하지 않으므로 그 사이 자리가 다른 예약에 팔릴 수 있다.
            # 되살릴 때는 자리가 아직 남아 있는지 반드시 다시 확인해야 한다.
            if booking.status == BookingStatus.CANCELLED and status != BookingStatus.CANCELLED:
                # booking.date 는 미리 읽은 값으로 범위를 잡았다. 그사이 옮겨졌으면 409.
                _require_date_in_tx(bookings, booking.date)
                require_tee_time_capacity(
                    bookings, booking.date, booking.time,
                    incoming=len(booking.players), exclude_id=booking.id,
                )
            message = _apply_status(booking, status, fields.get("cancelReason"))
            _audit(booking, message)
        elif "cancelReason" in fields:
            booking.cancelReason = fields["cancelReason"]
            _audit(booking, f"Cancellation reason set to '{fields['cancelReason']}'."
                   if fields["cancelReason"] else "Cancellation reason cleared.")

        return booking


# `response_model=None` 이 반드시 있어야 한다. 없으면 FastAPI 가 `-> None` 반환
# 주석을 **응답 본문 스키마**로 읽고, 204 는 본문을 가질 수 없으므로 라우터 등록이
# 통째로 터진다 ("Status code 204 must not have a response body").
#
# 개발 머신(fastapi 0.136)은 이 경우를 특별 취급해서 그냥 넘어가지만 배포 이미지가
# 고정한 0.109 는 예외를 던진다. `backend/main.py` 의 include_route_module 이 그
# 예외를 잡아 로그만 남기고 넘어가기 때문에 **서버는 정상 기동한 것처럼 보이면서
# 티 시트 API 전체가 404** 가 된다 — 실제로 첫 Fly 배포가 그렇게 나갔다.
# voice 라우터도 이 모듈을 임포트해서 같이 사라졌다.
@router.delete("/tee-sheet/bookings/{booking_id}", status_code=204, response_model=None)
def delete_booking(booking_id: str) -> None:
    with bookings_tx(Scope(ids={booking_id})) as bookings:
        booking = _find(bookings, booking_id)
        bookings.remove(booking)


# ===== 플레이어 =======================================================

@router.post("/tee-sheet/bookings/{booking_id}/players", response_model=TeeBooking)
def add_player(booking_id: str, body: AddPlayerRequest) -> TeeBooking:
    # 정원 검사에 그날의 다른 예약이 필요하다. 날짜는 id 로 먼저 읽어 알아낸다.
    current = _find(read_bookings(Scope(ids={booking_id})), booking_id)
    with bookings_tx(Scope(ids={booking_id}, dates={current.date})) as bookings:
        booking = _find(bookings, booking_id)
        # 두 개의 서로 다른 한계를 구분한다.
        # 1) 예약 하나가 담을 수 있는 인원 = 4 -> 422 (요청 자체가 모델 제약 위반)
        # 2) 티 타임 전체가 담을 수 있는 인원 = 4 -> 409 (다른 예약과의 자원 충돌)
        # 순서가 중요하다: 둘 다 걸리는 예약(4명짜리 꽉 찬 티 타임)은 422 를 돌려준다.
        if len(booking.players) >= PLAYERS_PER_TEE_TIME:
            raise HTTPException(status_code=422, detail="A tee time can contain at most 4 players")
        # 취소된 예약은 자리를 잡지 않으므로 (2) 를 물어볼 이유가 없다. 물어보면
        # "취소된 예약에 사람을 더할 수 있는가" 가 **무관한 다른 예약**의 인원수에 좌우된다.
        # 되살릴 때 PATCH status 게이트가 정원을 다시 검사하므로 넘칠 길은 없다.
        if booking.status != BookingStatus.CANCELLED:
            # 미리 읽은 날짜로 범위를 잡았다. 그사이 다른 날로 옮겨졌으면 409.
            _require_date_in_tx(bookings, booking.date)
            # exclude_id 를 주지 않는다: taken 에 이 예약의 인원이 이미 포함돼야 incoming=1 이 맞다.
            require_tee_time_capacity(bookings, booking.date, booking.time, incoming=1)
        payload = body.model_dump(exclude_none=True)
        player = Player.model_validate(payload)
        _settle_new_player(player, booking.holes, fee_given=body.cartFee is not None)
        booking.players.append(player)
        _audit(booking, f"Player added: {player.name}.")
        return booking


@router.patch("/tee-sheet/bookings/{booking_id}/players/{player_id}", response_model=TeeBooking)
def patch_player(booking_id: str, player_id: str, body: PatchPlayerRequest) -> TeeBooking:
    fields = body.model_dump(exclude_unset=True)

    # 플레이어 정보만 바꾼다. 인원이 늘지 않으니 정원을 셀 필요가 없다 → 이 예약 하나만.
    with bookings_tx(Scope(ids={booking_id})) as bookings:
        booking = _find(bookings, booking_id)
        for index, player in enumerate(booking.players):
            if player.id != player_id:
                continue

            merged = player.model_dump()
            merged.update({k: v for k, v in fields.items() if v is not None})

            # 이름 재계산 규칙: first/last 가 오면 그게 진실, name 만 오면 쪼갠다.
            if fields.get("firstName") is not None or fields.get("lastName") is not None:
                merged.pop("name", None)
            elif fields.get("name") is not None:
                merged["firstName"] = ""
                merged["lastName"] = ""

            updated = Player.model_validate(merged)
            updated.id = player.id

            # 카트: 켜면서 금액을 안 보냈으면 요금제·홀 수로 채운다. 요금제를 바꿨고 금액이
            # 아직 옛 요금제의 자동값이면 따라간다(결제 전일 때만). 끄면 0 — 다시 켜면 새로 계산된다.
            if fields.get("cartFee") is None and updated.cart:
                if not player.cart:
                    updated.cartFee = cart_fee_for(updated.ratePlan, booking.holes)
                elif (
                    updated.ratePlan != player.ratePlan
                    and not updated.paid
                    and _same_money(player.cartFee, cart_fee_for(player.ratePlan, booking.holes))
                ):
                    updated.cartFee = cart_fee_for(updated.ratePlan, booking.holes)
            if not updated.cart:
                updated.cartFee = 0.0

            # 결제 시각은 서버가 찍는다. 영수증의 날짜·시각이 이 값이다.
            if updated.paid and not player.paid:
                updated.paidAt = datetime.now(timezone.utc)
            elif not updated.paid:
                updated.paidAt = None

            booking.players[index] = updated

            messages = []
            if fields.keys() - {"paid", "cart", "cartFee"}:
                messages.append(f"Player updated: {updated.name}.")
            if updated.cart != player.cart or not _same_money(updated.cartFee, player.cartFee):
                messages.append(
                    f"Cart added for {updated.name} (${updated.cartFee:.2f})." if updated.cart and not player.cart
                    else f"Cart fee for {updated.name} set to ${updated.cartFee:.2f}." if updated.cart
                    else f"Cart removed for {updated.name}."
                )
            if updated.paid != player.paid:
                messages.append(
                    f"Payment recorded for {updated.name}." if updated.paid
                    else f"Payment cleared for {updated.name}."
                )
            _audit(booking, " ".join(messages) or f"Player updated: {updated.name}.")
            return booking

    raise HTTPException(status_code=404, detail="Player not found")


@router.delete("/tee-sheet/bookings/{booking_id}/players/{player_id}", response_model=TeeBooking)
def delete_player(booking_id: str, player_id: str) -> TeeBooking:
    with bookings_tx(Scope(ids={booking_id})) as bookings:
        booking = _find(bookings, booking_id)
        if len(booking.players) <= 1:
            raise HTTPException(status_code=422, detail="A reservation must keep at least one player")
        for player in booking.players:
            if player.id == player_id:
                booking.players.remove(player)
                _audit(booking, f"Player removed: {player.name}.")
                return booking

    raise HTTPException(status_code=404, detail="Player not found")


# ===== 리포트 =========================================================

def build_daily_report(iso_date: str, bookings: list[TeeBooking]) -> DailyReport:
    day = [b for b in bookings if b.date == iso_date]
    day.sort(key=lambda b: label_to_minutes(b.time) or 0)

    total_slots = len(generate_slots(iso_date)) * CARTS_PER_SLOT
    active = [b for b in day if b.status != BookingStatus.CANCELLED]

    booked_slots = 0
    total_revenue = 0.0
    collected_revenue = 0.0
    carts = 0
    for booking in active:
        payable = [p for p in booking.players if not p.cancelled]
        booked_slots += len(payable)
        for player in payable:
            # 한 사람이 내는 돈 = 그린피 + (카트를 쓰면) 카트 요금. 둘 다 세전.
            due = booking.rate + (player.cartFee if player.cart else 0.0)
            total_revenue += due
            if player.paid:
                collected_revenue += due
        carts += booking.cartCount

    available = max(total_slots - booked_slots, 0)
    occupancy = (booked_slots / total_slots * 100) if total_slots else 0.0

    return DailyReport(
        date=iso_date,
        total_tee_times=len(day),
        total_slots=total_slots,
        booked_slots=booked_slots,
        available_slots=available,
        occupancy_rate=round(occupancy, 2),
        total_revenue=round(total_revenue, 2),
        collected_revenue=round(collected_revenue, 2),
        outstanding_revenue=round(total_revenue - collected_revenue, 2),
        checked_in=sum(1 for b in day if b.status == BookingStatus.CHECKED_IN),
        cancelled=sum(1 for b in day if b.status == BookingStatus.CANCELLED),
        no_show=sum(1 for b in day if b.status == BookingStatus.NO_SHOW),
        carts=carts,
        bookings=[
            ReportBookingLine(
                id=b.id,
                time=b.time,
                title=b.title,
                players=len(b.players),
                rate=b.rate,
                status=b.status,
            )
            for b in day
        ],
    )


def _current_iso_week() -> tuple[str, str]:
    today = date_cls.today()
    monday = today - timedelta(days=today.weekday())
    return monday.isoformat(), (monday + timedelta(days=6)).isoformat()


@router.get("/tee-sheet/reports/daily", response_model=DailyReport)
def get_daily_report(date: str = Query(...)) -> DailyReport:
    parse_iso_date(date)
    return build_daily_report(date, read_bookings(Scope(dates={date})))


@router.get("/tee-sheet/reports/week", response_model=WeekReport, response_model_by_alias=True)
def get_week_report(
    from_: str | None = Query(None, alias="from"),
    to: str | None = Query(None),
) -> WeekReport:
    default_from, default_to = _current_iso_week()
    start_iso = from_ or default_from
    end_iso = to or default_to
    start = parse_iso_date(start_iso, "from")
    end = parse_iso_date(end_iso, "to")
    if end < start:
        raise HTTPException(status_code=422, detail="'to' must not be before 'from'")
    if (end - start).days > 62:
        raise HTTPException(status_code=422, detail="Week report range is limited to 62 days")

    bookings = read_bookings(Scope(date_from=start_iso, date_to=end_iso))
    days: list[DailyReport] = []
    cursor = start
    while cursor <= end:
        days.append(build_daily_report(cursor.isoformat(), bookings))
        cursor += timedelta(days=1)

    total_revenue = sum(d.total_revenue for d in days)
    collected = sum(d.collected_revenue for d in days)
    booked = sum(d.booked_slots for d in days)
    capacity = sum(d.total_slots for d in days)

    return WeekReport(
        **{"from": start_iso},
        to=end_iso,
        days=days,
        summary=WeekSummary(
            total_days=len(days),
            total_tee_times=sum(d.total_tee_times for d in days),
            total_booked_slots=booked,
            total_revenue=round(total_revenue, 2),
            collected_revenue=round(collected, 2),
            average_occupancy=round((booked / capacity * 100) if capacity else 0.0, 2),
        ),
    )


# ===== 작업 레지스트리 =================================================

_task_lock = threading.RLock()
_tasks: list[OrchestrationTask] = []          # 최신순
_inflight: set[asyncio.Task[Any]] = set()     # GC 방지용 강한 참조


def _register_task(name: str, detail: str) -> OrchestrationTask:
    task = OrchestrationTask(
        id=str(uuid4()),
        name=name,
        state=TaskState.QUEUED,
        created_at=datetime.now(timezone.utc),
        detail=detail,
    )
    with _task_lock:
        _tasks.insert(0, task)
        del _tasks[MAX_TASKS:]
    return task


def _update_task(task_id: str, **changes: Any) -> None:
    with _task_lock:
        for task in _tasks:
            if task.id == task_id:
                for key, value in changes.items():
                    setattr(task, key, value)
                return


def _snapshot(task_ids: list[str]) -> list[OrchestrationTask]:
    with _task_lock:
        by_id = {t.id: t for t in _tasks}
        return [by_id[tid].model_copy(deep=True) for tid in task_ids if tid in by_id]


def recent_tasks() -> list[OrchestrationTask]:
    with _task_lock:
        return [t.model_copy(deep=True) for t in _tasks]


def _launch(task: OrchestrationTask, coro_factory: Any) -> None:
    """작업을 이벤트 루프에 올린다. 어떤 경우에도 running 에서 멈추지 않게 한다."""

    async def runner() -> None:
        started = datetime.now(timezone.utc)
        clock = time.perf_counter()
        _update_task(task.id, state=TaskState.RUNNING, started_at=started)
        try:
            result = await coro_factory()
            _update_task(
                task.id,
                state=TaskState.SUCCESS,
                result=result if isinstance(result, dict) else {"value": result},
                finished_at=datetime.now(timezone.utc),
                duration_ms=int((time.perf_counter() - clock) * 1000),
            )
        except asyncio.CancelledError:
            _update_task(
                task.id,
                state=TaskState.FAILED,
                error="Task cancelled before completion",
                finished_at=datetime.now(timezone.utc),
                duration_ms=int((time.perf_counter() - clock) * 1000),
            )
            raise
        except Exception as exc:
            logger.exception("오케스트레이션 작업 실패: %s", task.name)
            _update_task(
                task.id,
                state=TaskState.FAILED,
                error=f"{type(exc).__name__}: {exc}",
                finished_at=datetime.now(timezone.utc),
                duration_ms=int((time.perf_counter() - clock) * 1000),
            )

    handle = asyncio.create_task(runner(), name=f"tee-sheet:{task.name}")
    _inflight.add(handle)
    handle.add_done_callback(_inflight.discard)


# ===== 실제 작업 구현 ==================================================

async def send_reminders(iso_date: str) -> dict[str, Any]:
    """해당 날짜의 유효 예약에 리마인더를 보낸다 (외부 호출은 시뮬레이션)."""
    clock = time.perf_counter()
    # 저장소가 네트워크(Supabase)일 수 있다. 루프에서 동기로 읽으면 gather 로 묶인
    # 다른 작업까지 그동안 멈춰, 병렬 배치가 조용히 순차 실행으로 떨어진다.
    bookings = await asyncio.to_thread(read_bookings, Scope(dates={iso_date}))
    targets = [
        b for b in bookings
        if b.date == iso_date and b.status in (BookingStatus.RESERVED, BookingStatus.CHECKED_IN)
    ]
    recipients: list[str] = []
    for booking in targets:
        for player in booking.players:
            if player.cancelled:
                continue
            recipients.append(player.email or f"{player.name.replace(' ', '.').lower()}@example.com")

    await asyncio.sleep(0.25)  # 메일 게이트웨이 왕복 시뮬레이션
    return {
        "task": "send_reminders",
        "date": iso_date,
        "bookings": len(targets),
        "recipients": len(recipients),
        "sent": len(recipients),
        "failed": 0,
        "duration_ms": int((time.perf_counter() - clock) * 1000),
    }


async def build_report_task(iso_date: str) -> dict[str, Any]:
    clock = time.perf_counter()
    # 이유는 send_reminders 참고
    bookings = await asyncio.to_thread(read_bookings, Scope(dates={iso_date}))
    report = build_daily_report(iso_date, bookings)
    await asyncio.sleep(0.18)  # 리포트 파이프라인 시뮬레이션
    return {
        "task": "generate_report",
        "date": iso_date,
        "total_tee_times": report.total_tee_times,
        "booked_slots": report.booked_slots,
        "total_revenue": report.total_revenue,
        "occupancy_rate": report.occupancy_rate,
        "duration_ms": int((time.perf_counter() - clock) * 1000),
    }


async def refresh_availability(iso_date: str) -> dict[str, Any]:
    clock = time.perf_counter()
    slots = generate_slots(iso_date)
    # 이유는 send_reminders 참고
    bookings = await asyncio.to_thread(read_bookings, Scope(dates={iso_date}))
    taken = {b.time for b in bookings if b.date == iso_date and b.status != BookingStatus.CANCELLED}
    await asyncio.sleep(0.12)  # 채널 매니저 푸시 시뮬레이션
    return {
        "task": "refresh_availability",
        "date": iso_date,
        "total_slots": len(slots),
        "taken_slots": len(taken),
        "open_slots": len(slots) - len(taken),
        "duration_ms": int((time.perf_counter() - clock) * 1000),
    }


async def run_daily_batch(iso_date: str) -> dict[str, Any]:
    """리마인더 / 리포트 / 가용성 갱신을 **실제로 동시에** 돌린다."""
    clock = time.perf_counter()
    results = await asyncio.gather(
        send_reminders(iso_date),
        build_report_task(iso_date),
        refresh_availability(iso_date),
        return_exceptions=True,
    )

    subtasks: list[dict[str, Any]] = []
    names = ("send_reminders", "generate_report", "refresh_availability")
    failures = 0
    sequential_ms = 0
    for name, outcome in zip(names, results):
        if isinstance(outcome, BaseException):
            failures += 1
            subtasks.append({"task": name, "status": "failed", "error": str(outcome), "duration_ms": 0})
        else:
            sequential_ms += int(outcome.get("duration_ms") or 0)
            subtasks.append({**outcome, "status": "success"})

    wall_ms = int((time.perf_counter() - clock) * 1000)
    return {
        "task": "daily_batch",
        "date": iso_date,
        "parallel": True,
        "subtasks": subtasks,
        "failed_subtasks": failures,
        # 병렬성 증거: 벽시계 시간이 각 파트 합보다 확연히 작아야 한다.
        "duration_ms": wall_ms,
        "sequential_ms": sequential_ms,
        "speedup": round(sequential_ms / wall_ms, 2) if wall_ms else None,
    }


def cleanup_expired_bookings(before_iso: str) -> dict[str, Any]:
    """`before_iso` 보다 **엄격히 이전** 날짜의 예약을 실제로 삭제한다."""
    removed: list[dict[str, str]] = []
    # 읽는 범위만 좁힌다. 지우는 규칙은 그대로다: 구간은 before 의 **전날** 까지라
    # "엄격히 이전" 이 유지되고, 만료 홀드를 날짜와 무관하게 걷으려고 holds 를 더한다.
    day_before = (parse_iso_date(before_iso, "before") - timedelta(days=1)).isoformat()
    with bookings_tx(Scope(date_to=day_before, holds=True)) as bookings:
        # 지난 날짜 정리와 별개로, 아무 날짜의 만료 홀드는 항상 함께 걷어낸다.
        holds_purged = purge_expired_holds(bookings)
        keep: list[TeeBooking] = []
        for booking in bookings:
            if booking.date < before_iso:
                removed.append({"id": booking.id, "date": booking.date, "time": booking.time,
                                "title": booking.title})
            else:
                keep.append(booking)
        bookings[:] = keep

    # keep 은 읽은 범위 안에서 남은 것뿐이다. "남은 예약 수" 는 테이블 전체의 수라
    # 커밋 뒤에 따로 센다 (행을 읽지 않는 count 한 번).
    remaining = store.count_bookings()

    return {
        "task": "cleanup",
        "status": "success",
        "before": before_iso,
        "deleted": len(removed),
        "expired_holds_purged": holds_purged,
        "remaining": remaining,
        "deleted_bookings": removed,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


async def cleanup_task(before_iso: str) -> dict[str, Any]:
    return await asyncio.to_thread(cleanup_expired_bookings, before_iso)


NO_SHOW_GRACE_MINUTES = 30


def _minutes_past(iso_date: str, time_label: str, now: datetime) -> int | None:
    """슬롯 시각이 지금보다 몇 분 지났는지. 미래면 음수, 파싱 실패면 None."""
    minutes = label_to_minutes(time_label)
    if minutes is None:
        return None
    try:
        day = date_cls.fromisoformat(iso_date)
    except ValueError:
        return None
    slot_at = datetime.combine(day, datetime.min.time()) + timedelta(minutes=minutes)
    return int((now - slot_at).total_seconds() // 60)


def run_sync_pass(iso_date: str) -> dict[str, Any]:
    """결정론적 동기화 패스.

    무작위 상태 변경은 하지 않는다. 문제를 스캔해서 보고하고,
    슬롯 시각이 30분 넘게 지난 `reserved` 건만 `no_show` 로 넘긴다.
    """
    now = datetime.now()
    findings: list[dict[str, Any]] = []
    updated = 0

    # 그날 + 날짜 무관 홀드 (아래 purge 가 예전처럼 모든 날짜의 만료 홀드를 걷는다).
    with bookings_tx(Scope(dates={iso_date}, holds=True)) as bookings:
        # 노쇼 스캔 전에 유령 홀드를 치운다. 안 그러면 통화 중 끊긴 홀드가
        # "플레이어 없는 예약" 경고로 잡혀 리포트를 오염시킨다.
        purged_holds = purge_expired_holds(bookings)
        day = [b for b in bookings if b.date == iso_date]
        day.sort(key=lambda b: label_to_minutes(b.time) or 0)

        for booking in day:
            past = _minutes_past(booking.date, booking.time, now)

            if not booking.players and booking.status not in (BookingStatus.BLOCKED, BookingStatus.CANCELLED):
                findings.append({
                    "booking_id": booking.id, "time": booking.time, "title": booking.title,
                    "issue": "empty_booking", "severity": "warning",
                    "detail": "Reservation has no players.", "action": "none",
                })

            if booking.cartCount > len(booking.players):
                findings.append({
                    "booking_id": booking.id, "time": booking.time, "title": booking.title,
                    "issue": "cart_count_exceeds_players", "severity": "warning",
                    "detail": f"{booking.cartCount} carts for {len(booking.players)} players.",
                    "action": "none",
                })

            if booking.status == BookingStatus.RESERVED and past is not None and past > 0:
                if past > NO_SHOW_GRACE_MINUTES:
                    booking.status = BookingStatus.NO_SHOW
                    for player in booking.players:
                        if not player.cancelled:
                            player.no_show = True
                    _audit(booking, f"Sync pass marked no-show ({past} minutes past tee time).")
                    updated += 1
                    findings.append({
                        "booking_id": booking.id, "time": booking.time, "title": booking.title,
                        "issue": "past_tee_time_still_reserved", "severity": "error",
                        "detail": f"Tee time passed {past} minutes ago with no check-in.",
                        "action": "marked_no_show",
                    })
                else:
                    findings.append({
                        "booking_id": booking.id, "time": booking.time, "title": booking.title,
                        "issue": "past_tee_time_still_reserved", "severity": "warning",
                        "detail": f"Tee time passed {past} minutes ago; within the "
                                  f"{NO_SHOW_GRACE_MINUTES} minute grace period.",
                        "action": "no_show_candidate",
                    })

        scanned = len(day)

    return {
        "task": "worker_sync",
        "date": iso_date,
        "scanned": scanned,
        "expired_holds_purged": purged_holds,
        "issues": len(findings),
        "updated": updated,
        "findings": findings,
        "deterministic": True,
    }


async def worker_task(iso_date: str) -> dict[str, Any]:
    return await asyncio.to_thread(run_sync_pass, iso_date)


# ===== 오케스트레이션 엔드포인트 =======================================

AVAILABLE_TASKS = [
    AvailableTask(
        name="daily_batch",
        description="일일 배치: 리마인더 · 리포트 · 가용성 갱신을 병렬로 실행",
        endpoint="POST /tee-sheet/orchestration/daily-batch",
    ),
    AvailableTask(
        name="send_reminders",
        description="해당 날짜 예약자에게 리마인더 발송",
        endpoint="POST /tee-sheet/orchestration/send-reminders",
    ),
    AvailableTask(
        name="cleanup",
        description="기준일 이전의 지난 예약 삭제",
        endpoint="POST /tee-sheet/orchestration/cleanup",
    ),
    AvailableTask(
        name="worker_sync",
        description="결정론적 동기화 패스: 문제 스캔 + 노쇼 처리",
        endpoint="POST /tee-sheet/worker/run",
    ),
]


@router.get("/tee-sheet/orchestration/status", response_model=OrchestrationStatus)
def orchestration_status() -> OrchestrationStatus:
    return OrchestrationStatus(
        status="ready",
        total_bookings=store.count_bookings(),  # 건수만 필요하다. 행을 읽지 않는다.
        timestamp=datetime.now(timezone.utc),
        available_tasks=AVAILABLE_TASKS,
        tasks=recent_tasks(),
    )


@router.post("/tee-sheet/orchestration/daily-batch", response_model=TaskAck)
async def orchestration_daily_batch(date: str | None = Query(None)) -> TaskAck:
    iso_date = date or date_cls.today().isoformat()
    parse_iso_date(iso_date)
    task = _register_task("daily_batch", f"Parallel daily batch for {iso_date}")
    _launch(task, lambda: run_daily_batch(iso_date))
    return TaskAck(
        accepted=True,
        tasks=_snapshot([task.id]),
        message=f"Daily batch queued for {iso_date}; poll /tee-sheet/orchestration/status.",
    )


@router.post("/tee-sheet/orchestration/send-reminders", response_model=TaskAck)
async def orchestration_send_reminders(date: str | None = Query(None)) -> TaskAck:
    iso_date = date or date_cls.today().isoformat()
    parse_iso_date(iso_date)
    task = _register_task("send_reminders", f"Reminder run for {iso_date}")
    _launch(task, lambda: send_reminders(iso_date))
    return TaskAck(
        accepted=True,
        tasks=_snapshot([task.id]),
        message=f"Reminders queued for {iso_date}.",
    )


@router.post("/tee-sheet/orchestration/cleanup", response_model=TaskAck)
async def orchestration_cleanup(before: str | None = Query(None)) -> TaskAck:
    before_iso = before or date_cls.today().isoformat()
    parse_iso_date(before_iso, "before")
    task = _register_task("cleanup", f"Delete bookings before {before_iso}")
    _launch(task, lambda: cleanup_task(before_iso))
    return TaskAck(
        accepted=True,
        tasks=_snapshot([task.id]),
        message=f"Cleanup queued for bookings before {before_iso}.",
    )


@router.post("/tee-sheet/worker/run", response_model=TaskAck)
async def run_worker(date: str | None = Query(None)) -> TaskAck:
    iso_date = date or date_cls.today().isoformat()
    parse_iso_date(iso_date)
    task = _register_task("worker_sync", f"Deterministic sync pass for {iso_date}")
    _launch(task, lambda: worker_task(iso_date))
    return TaskAck(
        accepted=True,
        tasks=_snapshot([task.id]),
        message=f"Sync pass queued for {iso_date}.",
    )
