"""PH Indoor Golf 시뮬레이터 베이 예약 API.

와이어 계약: `frontend/app/simulator/page.tsx` 의 `AvailabilityResponse` /
`ReservationResponse` 인터페이스.

영속화는 `backend/services/simulator_store.py` (JSON 파일 + RLock + 원자적 쓰기).
티 시트가 `a21318c` 에서 간 것과 같은 길이다 — 이 라우터만 Postgres 를 붙잡고
있었고, DB 가 없는 환경에서 `/simulator/availability` 가 500 을 뱉어 예약 화면이
"Failed to load available time slots" 만 띄우고 있었다.
"""

from __future__ import annotations

import logging
import os
import secrets
import smtplib
from datetime import datetime, timezone
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from backend.services import simulator_store as store

logger = logging.getLogger(__name__)
router = APIRouter()


# ===== 영업 규칙 ======================================================

SIMULATOR_HOURS = {"start": 14, "end": 22}  # 2:00 PM - 10:00 PM
CLOSED_DAYS = [0, 1]  # Monday=0, Tuesday=1
TIME_SLOT_MINUTES = 15
OPEN_MINUTES = SIMULATOR_HOURS["start"] * 60
CLOSE_MINUTES = SIMULATOR_HOURS["end"] * 60

BAY_TYPES = ("right_handed", "left_right", "vip")

MIN_DURATION_HOURS = 1
MAX_DURATION_HOURS = 5
MAX_PLAYERS = 4


# ===== 요청 모델 ======================================================


class ReservationRequest(BaseModel):
    """예약 생성 요청.

    `bay_id` 는 선택이다. 없으면 `bay_type` 으로 서버가 **비어 있는** 베이를 고른다.
    (예전에는 프론트가 `/bays` 목록의 첫 번째 id 를 무조건 보냈다. 우타 베이 3개 중
    2개가 비어 있어도 항상 1번을 집었기 때문에, 같은 시간대 두 번째 예약이 409 로
    막혔다.)
    """

    date: str
    start_time: str
    duration_hours: int = Field(ge=MIN_DURATION_HOURS, le=MAX_DURATION_HOURS)
    customer_name: str
    customer_email: str
    bay_id: Optional[int] = None
    bay_type: Optional[str] = None
    player_count: int = Field(default=1, ge=1, le=MAX_PLAYERS)
    phone: str = ""
    notes: str = ""


# ===== 작은 헬퍼 ======================================================


def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def generate_confirmation_code() -> str:
    return secrets.token_hex(5).upper()


def _parse_date(value: str):
    """`YYYY-MM-DD` → `date`.

    `strptime` 은 `2026-9-10` 처럼 0 이 안 붙은 날짜도 받아준다. 그래서 파싱한
    `date` 만 쓰고 원본 문자열은 버려야 한다 — 저장과 조회가 서로 다른 표기를
    쓰면 겹침 검사가 통째로 빗나가 같은 베이가 두 번 예약된다.
    """
    try:
        return datetime.strptime(value, "%Y-%m-%d").date()
    except (ValueError, TypeError):
        raise HTTPException(status_code=400, detail="Invalid date format. Use YYYY-MM-DD")


def _parse_time_to_minutes(value: str) -> int:
    """`HH:MM` → 자정 기준 분. 슬롯 라벨과 저장된 값이 모두 이 형식이다."""
    try:
        hour_text, minute_text = str(value).split(":")
        hour, minute = int(hour_text), int(minute_text)
    except (AttributeError, ValueError):
        raise HTTPException(status_code=400, detail="Invalid time format. Use HH:MM")
    if not (0 <= hour < 24 and 0 <= minute < 60):
        raise HTTPException(status_code=400, detail="Invalid time format. Use HH:MM")
    return hour * 60 + minute


def _bay_type_label(bay_type: str) -> str:
    return str(bay_type).replace("_", " ").title()


def _active_bays(bays: list[dict[str, Any]], bay_type: Optional[str] = None) -> list[dict[str, Any]]:
    selected = [bay for bay in bays if bay.get("is_active", True)]
    if bay_type:
        selected = [bay for bay in selected if bay.get("bay_type") == bay_type]
    return sorted(selected, key=lambda bay: bay.get("bay_number", 0))


def _busy_minutes_by_bay(
    reservations: list[dict[str, Any]], date_str: str
) -> dict[int, list[tuple[int, int]]]:
    """해당 날짜의 확정 예약을 베이별 `(시작분, 종료분)` 목록으로 접는다.

    슬롯마다 DB 를 다시 때리던 예전 구조(슬롯 32개 × 베이 N개 = 쿼리 폭발)를
    한 번의 순회로 대체한다.
    """
    busy: dict[int, list[tuple[int, int]]] = {}
    for res in reservations:
        if res.get("status") != "confirmed" or res.get("date") != date_str:
            continue
        try:
            hour_text, minute_text = str(res.get("start_time", "")).split(":")
            start = int(hour_text) * 60 + int(minute_text)
            end = start + int(res.get("duration_hours", 0)) * 60
            bay_id = int(res.get("bay_id"))
        except (TypeError, ValueError):
            # 손상된 레코드 하나 때문에 예약 화면 전체가 죽지는 않게 한다.
            logger.warning("시뮬레이터 예약 레코드 건너뜀: %r", res)
            continue
        busy.setdefault(bay_id, []).append((start, end))
    return busy


def _is_free(intervals: list[tuple[int, int]], start: int, end: int) -> bool:
    """`[start, end)` 가 기존 예약과 겹치지 않는가."""
    return all(not (res_start < end and res_end > start) for res_start, res_end in intervals)


def _slot_starts(duration_hours: int) -> list[int]:
    """마감까지 `duration_hours` 가 통째로 들어가는 슬롯 시작 시각(분)."""
    span = duration_hours * 60
    return [
        start
        for start in range(OPEN_MINUTES, CLOSE_MINUTES, TIME_SLOT_MINUTES)
        if start + span <= CLOSE_MINUTES
    ]


def _minutes_to_label(minutes: int) -> str:
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


# ===== 확정 메일 ======================================================


def send_confirmation_email(
    customer_name: str,
    customer_email: str,
    bay_type: str,
    date_str: str,
    start_time: str,
    duration_hours: int,
    player_count: int,
    total_price: float,
    confirmation_code: str,
) -> bool:
    try:
        smtp_host = os.getenv("SMTP_HOST", "smtp.gmail.com")
        smtp_port = int(os.getenv("SMTP_PORT", "587"))
        sender_email = os.getenv("SENDER_EMAIL", "noreply@pelhamhills.com")
        sender_password = os.getenv("SENDER_PASSWORD", "")

        if not sender_password:
            return False

        msg = MIMEMultipart("alternative")
        msg["Subject"] = f"Booking Confirmation - PH Indoor Golf ({confirmation_code})"
        msg["From"] = sender_email
        msg["To"] = customer_email

        html = f"""
        <html>
          <body style="font-family: Arial, sans-serif; color: #333;">
            <div style="max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #ddd; border-radius: 8px;">
              <h2 style="color: #214d2f;">Your booking is confirmed</h2>
              <p>Hi {customer_name},</p>
              <p>Your booking for PH Indoor Golf has been confirmed.</p>

              <div style="background-color: #f7f4ed; padding: 15px; border-radius: 5px; margin: 20px 0;">
                <p><strong>{bay_type} Bay</strong></p>
                <p><strong>Date:</strong> {date_str}</p>
                <p><strong>Time:</strong> {start_time} ({duration_hours} hour{'s' if duration_hours > 1 else ''})</p>
                <p><strong>Players:</strong> {player_count}</p>
                <p><strong>Total Price:</strong> ${total_price:.2f}</p>
                <p><strong>Confirmation Code:</strong> <span style="color: #214d2f; font-weight: bold; font-size: 18px;">{confirmation_code}</span></p>
              </div>

              <p style="color: #666; font-size: 14px;">
                <strong>Operating Hours:</strong><br>
                Monday - Tuesday: CLOSED<br>
                Wednesday - Sunday: 2:00 PM - 10:00 PM
              </p>

              <p style="color: #666; font-size: 12px;">
                Questions? Contact us at info@pelhamhills.ca or call 416-822-7609
              </p>
            </div>
          </body>
        </html>
        """

        msg.attach(MIMEText(html, "html"))

        with smtplib.SMTP(smtp_host, smtp_port) as server:
            server.starttls()
            server.login(sender_email, sender_password)
            server.sendmail(sender_email, customer_email, msg.as_string())

        return True
    except Exception as exc:
        logger.warning("확정 메일 발송 실패: %s", exc)
        return False


# ===== 엔드포인트 =====================================================


@router.get("/simulator/bays")
def list_bays(bay_type: str = Query(None)):
    """활성 베이 목록. 타입으로 걸러 볼 수 있다.

    설정된 베이가 없는 타입은 404 가 아니라 빈 목록이다 — 라우트는 존재하고,
    답은 "그 타입 베이가 없다" 이지 "그런 주소가 없다" 가 아니다.
    """
    data = store.load()
    return [
        {
            "id": bay["id"],
            "bay_number": bay["bay_number"],
            "bay_type": bay["bay_type"],
            "hourly_rate": bay["hourly_rate"],
        }
        for bay in _active_bays(data["bays"], bay_type)
    ]


@router.get("/simulator/availability")
def get_availability(
    date: str,
    bay_type: str = Query("right_handed"),
    duration_hours: int = Query(1, ge=MIN_DURATION_HOURS, le=MAX_DURATION_HOURS),
):
    """특정 날짜/베이 타입/이용 시간에 대한 예약 가능 슬롯.

    슬롯이 없는 경우는 오류가 아니다. `available_slots: []` 와 함께 `reason` 으로
    이유(휴무일 / 해당 타입 베이 없음 / 전부 예약됨)를 돌려준다. 프론트가 그대로
    보여줄 수 있는 문장이라, 예전처럼 모든 실패가 하나의 문구로 뭉개지지 않는다.
    """
    target_date = _parse_date(date)
    iso_date = target_date.isoformat()

    base: dict[str, Any] = {
        "date": iso_date,
        "bay_type": bay_type,
        "duration_hours": duration_hours,
        "is_closed": False,
        "available_slots": [],
        "reason": None,
    }

    if target_date.weekday() in CLOSED_DAYS:
        return {
            **base,
            "is_closed": True,
            "reason": "The simulator is closed on Mondays and Tuesdays.",
        }

    data = store.load()
    bays = _active_bays(data["bays"], bay_type)
    if not bays:
        return {
            **base,
            "reason": f"No bays are configured for {_bay_type_label(bay_type)}.",
        }

    busy = _busy_minutes_by_bay(data["reservations"], iso_date)
    span = duration_hours * 60

    slots = []
    for start in _slot_starts(duration_hours):
        end = start + span
        free_bays = sum(1 for bay in bays if _is_free(busy.get(bay["id"], []), start, end))
        if free_bays:
            slots.append(
                {
                    "time": _minutes_to_label(start),
                    "available_bays": free_bays,
                    "total_bays": len(bays),
                }
            )

    reason = None
    if not slots:
        reason = (
            f"Every {_bay_type_label(bay_type)} bay is booked for "
            f"{duration_hours} hour{'s' if duration_hours > 1 else ''} on this date."
        )

    return {**base, "available_slots": slots, "reason": reason}


@router.post("/simulator/reservations")
def create_simulator_reservation(reservation: ReservationRequest):
    """시뮬레이터 베이 예약 생성."""
    target_date = _parse_date(reservation.date)
    iso_date = target_date.isoformat()
    if target_date.weekday() in CLOSED_DAYS:
        raise HTTPException(
            status_code=400, detail="The simulator is closed on Mondays and Tuesdays."
        )

    if reservation.bay_id is None and not reservation.bay_type:
        raise HTTPException(status_code=400, detail="bay_type or bay_id is required")
    if reservation.bay_type and reservation.bay_type not in BAY_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown bay type: {reservation.bay_type}",
        )

    if not reservation.customer_name.strip():
        raise HTTPException(status_code=400, detail="Name is required")
    if not reservation.customer_email.strip():
        raise HTTPException(status_code=400, detail="Email is required")

    start = _parse_time_to_minutes(reservation.start_time)
    end = start + reservation.duration_hours * 60
    if start < OPEN_MINUTES or end > CLOSE_MINUTES:
        raise HTTPException(
            status_code=400,
            detail="Requested time is outside operating hours (2:00 PM - 10:00 PM).",
        )

    # 빈 베이 확인과 기록을 한 락 안에서 처리한다. 동시에 들어온 두 요청이
    # 같은 베이를 잡는 경합을 여기서 막는다.
    with store.mutate() as data:
        candidates = _active_bays(data["bays"], reservation.bay_type)
        if reservation.bay_id is not None:
            candidates = [bay for bay in candidates if bay["id"] == reservation.bay_id]
            if not candidates:
                raise HTTPException(status_code=404, detail="Bay not found or inactive")
        if not candidates:
            raise HTTPException(
                status_code=404,
                detail=f"No bays are configured for {_bay_type_label(reservation.bay_type)}.",
            )

        busy = _busy_minutes_by_bay(data["reservations"], iso_date)
        bay = next(
            (bay for bay in candidates if _is_free(busy.get(bay["id"], []), start, end)),
            None,
        )
        if bay is None:
            raise HTTPException(status_code=409, detail="Time slot already booked")

        total_price = float(bay["hourly_rate"]) * reservation.duration_hours
        now = _iso_now()
        record = {
            "id": store.next_reservation_id(data["reservations"]),
            "bay_id": bay["id"],
            "date": iso_date,
            "start_time": _minutes_to_label(start),
            "duration_hours": reservation.duration_hours,
            "player_count": reservation.player_count,
            "customer_name": reservation.customer_name.strip(),
            "customer_email": reservation.customer_email.strip(),
            "phone": reservation.phone,
            "notes": reservation.notes,
            "confirmation_code": generate_confirmation_code(),
            "total_price": total_price,
            "status": "confirmed",
            "created_at": now,
            "updated_at": now,
        }
        data["reservations"].append(record)

    bay_type_display = _bay_type_label(bay["bay_type"])

    # 메일은 락 밖에서. SMTP 가 느려도 다른 예약을 막지 않는다.
    send_confirmation_email(
        customer_name=record["customer_name"],
        customer_email=record["customer_email"],
        bay_type=bay_type_display,
        date_str=record["date"],
        start_time=record["start_time"],
        duration_hours=record["duration_hours"],
        player_count=record["player_count"],
        total_price=total_price,
        confirmation_code=record["confirmation_code"],
    )

    return {
        "id": record["id"],
        "confirmation_code": record["confirmation_code"],
        "bay_type": bay_type_display,
        "bay_number": bay["bay_number"],
        "date": record["date"],
        "start_time": record["start_time"],
        "duration_hours": record["duration_hours"],
        "player_count": record["player_count"],
        "total_price": total_price,
    }


@router.get("/simulator/reservations/{confirmation_code}")
def get_reservation_by_code(confirmation_code: str):
    """확정 코드로 예약 조회."""
    data = store.load()
    wanted = confirmation_code.strip().upper()
    record = next(
        (
            res
            for res in data["reservations"]
            if str(res.get("confirmation_code", "")).upper() == wanted
        ),
        None,
    )
    if record is None:
        raise HTTPException(status_code=404, detail="Reservation not found")

    bay = next((bay for bay in data["bays"] if bay["id"] == record.get("bay_id")), None)

    return {
        "id": record["id"],
        "confirmation_code": record["confirmation_code"],
        "bay_type": _bay_type_label(bay["bay_type"]) if bay else "Unknown",
        "bay_number": bay["bay_number"] if bay else None,
        "date": record["date"],
        "start_time": record["start_time"],
        "duration_hours": record["duration_hours"],
        "player_count": record["player_count"],
        "customer_name": record["customer_name"],
        "customer_email": record["customer_email"],
        "total_price": record.get("total_price"),
        "status": record["status"],
        "created_at": record["created_at"],
    }


@router.post("/simulator/admin/init-bays")
def init_simulator_bays():
    """기본 베이 시딩 (Admin only - v1 no auth).

    저장소가 비어 있으면 알아서 시드하므로 보통은 쓸 일이 없다. 베이 목록만
    날려먹었을 때 예약 기록은 남긴 채 되살리는 복구용으로 남겨 둔다.
    """
    with store.mutate() as data:
        if data["bays"]:
            return {"message": "Bays already initialized", "bays_created": 0}
        data["bays"] = store.seed_bays()
        created = len(data["bays"])

    return {"message": "Simulator bays initialized successfully", "bays_created": created}
