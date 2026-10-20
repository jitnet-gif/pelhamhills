"""레인체크 전표를 손님 휴대폰으로 — 바코드 그림을 붙인 문자(MMS).

POST /rain-checks/{code}/text   {phone}   발행 창에서 직원이 번호를 넣고 누른다.

티 시트는 정적 사이트라 Twilio 키를 들 수 없어서 이 서버가 대신 보낸다. 직원 확인은 단말기와
같다 — 요청의 Supabase 토큰으로 `pelham_staff_rain_check`(0011)를 불러 코드도 같이 확인한다.
보내는 것은 코드·금액·만료일과 바코드(`/sms/barcode/RC-….png`)뿐이다. 다음에 오면 계산서 결제
칸에서 손님 휴대폰 화면의 바코드를 쏘면 종이 전표를 쏜 것과 같다.

무효·사용된 전표는 보내지 않는다(손님에게 쓸 수 없는 크레딧을 주게 된다). 만료된 것도 마찬가지.
같은 전표를 여러 번 보내도 된다 — 번호를 잘못 넣었거나 손님이 지웠을 때.
"""

from __future__ import annotations

import asyncio
from datetime import date
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from backend.api.routes import terminal
from backend.core.config import settings
from backend.services.barcode_png import BARCODE_CODE_RE, barcode_url
from backend.services.twilio_sms import normalize_phone, send_sms

router = APIRouter(prefix="/rain-checks", tags=["Rain Checks"])


class TextRequest(BaseModel):
    phone: str


def _money(cents: Any) -> str:
    return f"${int(cents or 0) / 100:,.2f}"


def _us_date(iso: str) -> str:
    try:
        return date.fromisoformat(iso).strftime("%b %-d, %Y")
    except ValueError:
        return iso


def rain_check_text(check: dict[str, Any]) -> str:
    return (
        f"Pelham Hills rain check {check['code']} for {check.get('player_name') or 'you'}: "
        f"{_money(check.get('amount'))} credit, valid through {_us_date(str(check.get('expires_on')))}. "
        f"Show this barcode at the pro shop. One use, not redeemable for cash. "
        f"Questions? Call {settings.PROSHOP_PHONE_NUMBER}."
    )


@router.post("/{code}/text")
async def text_rain_check(code: str, body: TextRequest, request: Request) -> dict[str, Any]:
    code = code.strip().upper()
    if not BARCODE_CODE_RE.fullmatch(code) or not code.startswith("RC-"):
        raise HTTPException(status_code=404, detail=f"No rain check {code}")
    phone = normalize_phone(body.phone)
    if not phone:
        raise HTTPException(status_code=422, detail="Enter a 10-digit phone number.")
    # 직원 확인과 코드 조회를 한 번에. Supabase 왕복이라 스레드에서.
    check = await asyncio.to_thread(terminal._as_staff, request, "pelham_staff_rain_check", {"p_code": code})
    if check.get("status") != "issued":
        raise HTTPException(status_code=409, detail=f"Rain check {code} is {check.get('status')} — nothing to send.")
    if check.get("expired"):
        raise HTTPException(status_code=409, detail=f"Rain check {code} has expired — nothing to send.")
    if not settings.TWILIO_ENABLED:
        raise HTTPException(status_code=503, detail="Text messages are not set up on the server yet.")

    msg = await send_sms(phone, rain_check_text(check), template="rain_check",
                         booking_ref=code, media_url=barcode_url(code))
    if msg.status in ("failed", "skipped"):
        raise HTTPException(status_code=502, detail=f"The text did not go out ({msg.error or msg.status}).")
    return {"ok": True, "to": phone, "status": msg.status, "barcode": msg.media_url is not None}
