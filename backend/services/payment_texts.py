"""카드 결제 승인 → 손님 휴대폰 문자.

계산대 단말기(Stripe Terminal)든 온라인(Stripe Checkout)이든, 승인이 장부에 기록되면 손님에게
"얼마가 어느 카드로 승인됐다" 를 보낸다. 무엇을 누구에게 보낼지는 SQL 이 정한다
(`supabase/migrations/0028_payment_texts.sql` 의 `pelham_payment_texts_claim`) — 여기서는 문장을 만들고 보낸다.

- 한 결제에 한 번: SQL 이 보내기 **전에** 줄을 집는다. 웹훅과 화면 확인이 겹쳐도, 실패해도 다시 가지 않는다.
- 빨리 보내려고, 승인을 기록하는 곳(`terminal._final`, `payments.settle`)이 `kick()` 으로 깨운다.
  깨움을 놓쳐도 1분마다 다시 훑는다(`loop`).
- 결제 문자는 손님이 방금 한 일에 대한 답이라 밤에도 보낸다(분실물·대기자 문자와 다르다).
- Twilio 키가 없으면 집지 않는다. 집어 두면 키를 넣은 뒤에도 가지 않는다.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime
from typing import Any

from backend.api.routes import customer_qr, voice
from backend.core.config import settings
from backend.services import supabase_rest
from backend.services.twilio_sms import send_sms

logger = logging.getLogger(__name__)

#: 깨움이 없을 때 다시 훑는 간격(초).
SWEEP_SECONDS = 60

_lock = asyncio.Lock()
_wake: asyncio.Event | None = None
_loop: asyncio.AbstractEventLoop | None = None


def _money(cents: Any) -> str:
    return f"${int(cents or 0) / 100:,.2f}"


def _when(iso: str | None) -> str:
    try:
        at = datetime.fromisoformat(str(iso).replace("Z", "+00:00")).astimezone(voice.CLUB_TIMEZONE)
    except Exception:
        at = voice.club_now()
    return at.strftime("%b %-d, %-I:%M %p")


def receipt_text(row: dict[str, Any]) -> str:
    brand = str(row.get("card_brand") or "card").strip()
    brand = brand.upper() if brand.lower() in ("amex", "jcb") else brand.title()
    card = f"{brand} ending {row['card_last4']}" if row.get("card_last4") else brand
    tip = int(row.get("tip") or 0)
    amount = _money(row.get("amount"))
    if tip > 0:
        amount = f"{amount} (incl. {_money(tip)} tip)"
    parts = [f"Pelham Hills: payment approved — {amount} on {card}, {_when(row.get('approved_at'))}."]
    if row.get("source") == "online":
        what = str(row.get("description") or "").strip()
        if what:
            parts.append(f"For {what}.")
        if row.get("confirmation_code"):
            parts.append(f"Booking {row['confirmation_code']}.")
    if row.get("receipt_no"):
        parts.append(f"Receipt {row['receipt_no']}.")
    parts.append(f"Pelham Hills app: {customer_qr.GPS_APP_ORIGIN}")
    parts.append(f"Questions? Call {settings.PROSHOP_PHONE_NUMBER}. Reply STOP to opt out.")
    return " ".join(parts)


def _claim() -> list[dict[str, Any]]:
    return supabase_rest.rpc("pelham_payment_texts_claim", {"p_limit": 20}) or []


def _record(text_id: int, status: str, error: str | None, sid: str | None) -> None:
    supabase_rest.rpc("pelham_payment_text_result",
                      {"p_id": text_id, "p_status": status, "p_error": error, "p_sid": sid})


async def run() -> None:
    """한 패스. 오류는 삼킨다 — 결제나 리마인더를 망치면 안 된다."""
    if not settings.TWILIO_ENABLED:
        return
    from starlette.concurrency import run_in_threadpool

    async with _lock:
        try:
            outbox = await run_in_threadpool(_claim)
        except supabase_rest.SupabaseUnavailable:
            return
        except Exception as exc:
            logger.error("결제 문자 패스 실패: %s", exc)
            return
        for row in outbox:
            msg = await send_sms(str(row["phone"]), receipt_text(row), template="payment_approved",
                                 booking_ref=row.get("confirmation_code") or row.get("receipt_no"),
                                 media_url=customer_qr.app_qr_image_url())
            status = msg.status if msg.status in ("failed", "skipped") else "sent"
            try:
                await run_in_threadpool(_record, int(row["id"]), status, msg.error, msg.twilio_sid)
            except Exception as exc:
                logger.warning("결제 문자 결과를 적지 못함 (%s): %s", status, exc)


def kick() -> None:
    """승인을 기록한 직후 부른다. 어느 스레드에서 불러도 된다. 루프가 없으면(테스트·키 없음) 아무것도 안 한다."""
    if _loop is None or _wake is None:
        return
    try:
        _loop.call_soon_threadsafe(_wake.set)
    except RuntimeError:
        pass  # 루프가 닫혔다(종료 중).


async def loop() -> None:
    """`main` 이 시작할 때 띄운다. 깨우면 바로, 아니면 1분마다 한 패스."""
    global _wake, _loop
    _loop = asyncio.get_running_loop()
    _wake = asyncio.Event()
    while True:
        try:
            await asyncio.wait_for(_wake.wait(), timeout=SWEEP_SECONDS)
        except asyncio.TimeoutError:
            pass
        _wake.clear()
        await run()
