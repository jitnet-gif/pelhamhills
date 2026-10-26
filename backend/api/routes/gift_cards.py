"""기프트카드를 손님 휴대폰으로 — 바코드 그림을 붙인 문자(MMS).

POST /gift-cards/{code}/text   {phone}   Gift Cards 화면에서 발행할 때, 또는 Text 를 누를 때.

어드민은 정적 사이트라 Twilio 키를 들 수 없어서 이 서버가 대신 보낸다. 직원 확인은 레인체크와 같다 —
요청의 Supabase 토큰으로 `pelham_staff_gift_card`(0120)를 불러 코드도 같이 확인한다.
보내는 것은 코드·잔액과 바코드(`/sms/barcode/GIFT-….png`)뿐이다. 계산서 결제 칸에서 손님 휴대폰 화면의
바코드를 쏘면 종이 카드를 쏜 것과 같다.

무효·잔액 없는 카드는 보내지 않는다. 같은 카드를 여러 번 보내도 된다 — 번호를 잘못 넣었거나 손님이 지웠을 때.
"""

from __future__ import annotations

import asyncio
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from backend.api.routes import terminal
from backend.core.config import settings
from backend.services.barcode_png import BARCODE_CODE_RE, barcode_url
from backend.services.twilio_sms import normalize_phone, send_sms

router = APIRouter(prefix="/gift-cards", tags=["Gift Cards"])


class TextRequest(BaseModel):
    phone: str


def _money(cents: Any) -> str:
    return f"${int(cents or 0) / 100:,.2f}"


def gift_card_text(card: dict[str, Any]) -> str:
    who = f" for {card['recipient']}" if card.get("recipient") else ""
    return (
        f"Pelham Hills gift card{who}: {_money(card.get('balance'))} to spend on green fees, "
        f"the pro shop and the snack bar. Show this barcode at the counter. Card {card['code']}. "
        f"No expiry, not redeemable for cash. Anyone with this barcode can spend it, so keep it to yourself. "
        f"Questions? Call {settings.PROSHOP_PHONE_NUMBER}."
    )


@router.post("/{code}/text")
async def text_gift_card(code: str, body: TextRequest, request: Request) -> dict[str, Any]:
    code = code.strip().upper()
    if not BARCODE_CODE_RE.fullmatch(code) or not code.startswith("GIFT-"):
        raise HTTPException(status_code=404, detail=f"No gift card {code}")
    phone = normalize_phone(body.phone)
    if not phone:
        raise HTTPException(status_code=422, detail="Enter a 10-digit phone number.")
    card = await asyncio.to_thread(terminal._as_staff, request, "pelham_staff_gift_card", {"p_code": code})
    if card.get("status") != "active":
        raise HTTPException(status_code=409, detail=f"Gift card {code} was voided — nothing to send.")
    if int(card.get("balance") or 0) <= 0:
        raise HTTPException(status_code=409, detail=f"Gift card {code} has nothing left — nothing to send.")
    if not settings.TWILIO_ENABLED:
        raise HTTPException(status_code=503, detail="Text messages are not set up on the server yet.")

    msg = await send_sms(phone, gift_card_text(card), template="gift_card",
                         booking_ref=code, media_url=barcode_url(code))
    if msg.status in ("failed", "skipped"):
        raise HTTPException(status_code=502, detail=f"The text did not go out ({msg.error or msg.status}).")
    return {"ok": True, "to": phone, "status": msg.status, "barcode": msg.media_url is not None}
