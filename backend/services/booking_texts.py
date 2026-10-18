"""웹 예약 → 손님 확인 문자.

전화·문자 비서 예약은 확정하면서 바로 확인 문자를 보낸다(`voice.confirm_booking`, `voice_sim.book_sim_bay`).
웹 예약은 브라우저가 Supabase 에서 끝내므로 이 서버를 거치지 않는다. 그래서 1분마다 Supabase 에 막 들어온
웹 예약을 묻고(`supabase/migrations/0032_booking_texts.sql` 의 `pelham_booking_texts_claim`) 보낸다.

- 문장은 전화 예약과 같다 — 같은 확인 번호, "C <번호>" 로 취소, 티타임은 체크인 바코드.
- 한 예약에 한 번: SQL 이 보내기 **전에** 줄을 집는다. 실패해도 다시 가지 않는다.
- Twilio 키가 없으면 집지 않는다. 집어 두면 키를 넣은 뒤에도 가지 않는다.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from backend.api.routes import voice, voice_sim
from backend.core.config import settings
from backend.services import supabase_rest
from backend.services.barcode_png import barcode_url
from backend.services.twilio_sms import send_sms

logger = logging.getLogger(__name__)

#: 다시 훑는 간격(초). 웹 예약은 깨워 줄 곳이 없어 이것만으로 돈다.
SWEEP_SECONDS = 60

_lock = asyncio.Lock()


def tee_text(row: dict[str, Any]) -> tuple[str, str]:
    """티타임 확인 문자와 확인 번호. 전화 예약(`voice.confirmation_text`)과 같은 문장."""
    summary = voice.BookingSummary(
        booking_id=str(row["ref"]),
        confirmation_code=voice._confirmation_code(str(row["ref"])),
        date=str(row["date"]),
        spoken_date=voice.spoken_date(str(row["date"])),
        time=str(row["time"]),
        party_size=int(row.get("party_size") or 1),
        holes=int(row.get("holes") or 18),
        rate=float(row.get("rate") or 0),
        name=str(row.get("name") or ""),
        status=str(row.get("status") or "reserved"),
    )
    return voice.confirmation_text(summary), summary.confirmation_code


def sim_text(row: dict[str, Any]) -> tuple[str, str]:
    """실내 골프 확인 문자와 확인 번호. 전화 예약(`voice_sim.book_sim_bay`)과 같은 문장."""
    minutes = int(row["start_minutes"])
    time = voice_sim.to_label(f"{minutes // 60:02d}:{minutes % 60:02d}")
    code = str(row["confirmation_code"])
    text = (
        f"{voice.CLUB_NAME}: simulator bay booked, {voice.spoken_date(str(row['date']))} at {time} for "
        f"{voice_sim._hours_word(int(row['duration_hours']))}. Confirmation #{code}. "
        f"To cancel, reply C {code} (up to 24 hours before) or call {settings.PROSHOP_PHONE_NUMBER}. "
        "Show this barcode at the front desk when you check in."
    )
    return text, code


def _claim() -> list[dict[str, Any]]:
    return supabase_rest.rpc("pelham_booking_texts_claim", {"p_limit": 20}) or []


def _record(text_id: int, status: str, error: str | None, sid: str | None) -> None:
    supabase_rest.rpc("pelham_booking_text_result",
                      {"p_id": text_id, "p_status": status, "p_error": error, "p_sid": sid})


async def run() -> None:
    """한 패스. 오류는 삼킨다 — 예약이나 다른 문자를 망치면 안 된다."""
    if not settings.TWILIO_ENABLED:
        return
    from starlette.concurrency import run_in_threadpool

    async with _lock:
        try:
            outbox = await run_in_threadpool(_claim)
        except supabase_rest.SupabaseUnavailable:
            return
        except Exception as exc:
            logger.error("웹 예약 문자 패스 실패: %s", exc)
            return
        for row in outbox:
            try:
                text, code = tee_text(row) if row.get("kind") == "tee" else sim_text(row)
            except Exception as exc:
                logger.error("웹 예약 문자를 만들지 못함 (%s): %s", row.get("id"), exc)
                try:
                    await run_in_threadpool(_record, int(row["id"]), "failed", f"bad row: {exc}"[:300], None)
                except Exception:
                    pass
                continue
            msg = await send_sms(str(row["phone"]), text, template="confirm", booking_ref=code,
                                 media_url=barcode_url(code))
            status = msg.status if msg.status in ("failed", "skipped") else "sent"
            try:
                await run_in_threadpool(_record, int(row["id"]), status, msg.error, msg.twilio_sid)
            except Exception as exc:
                logger.warning("웹 예약 문자 결과를 적지 못함 (%s): %s", status, exc)


async def loop() -> None:
    """`main` 이 시작할 때 띄운다. 1분마다 한 패스."""
    while True:
        await asyncio.sleep(SWEEP_SECONDS)
        await run()
