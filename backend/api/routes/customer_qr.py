"""손님 개인 QR(0084)을 문자로 보낸다.

신분증으로 등록한 손님마다 QR 이 하나 있다(`pelham_customers.qr_token`). QR 에는 GPS 앱 주소
`https://<GPS 앱>/me?c=PHC-XXXXXXXXXX` 가 들어 있다 — 카운터 스캐너로 찍으면 티 시트가 체크인하고,
손님이 휴대폰으로 열면 GPS 앱이 생년월일을 확인해 계정에 잇는다.

  POST /pos/customer-qr/text   직원: 그 손님 휴대폰으로 QR 그림 + 주소를 보낸다(MMS)
  GET  /sms/qr/{code}.png      Twilio 가 받아 가는 QR 그림 (공개)
  GET  /sms/app-qr.png         영수증 문자·메일의 앱 QR 그림 (공개, 앱 첫 화면 주소뿐)

그림 주소가 공개인 까닭은 확정 문자의 바코드(`sms.barcode_png`)와 같다 — 그림에는 주소의 무작위 토큰뿐이고
이름·번호가 없다. 그 토큰으로 할 수 있는 것은 직원 화면의 체크인과, 생년월일까지 맞을 때의 계정 잇기뿐이다.

번호는 화면이 아니라 서버가 손님 기록에서 읽는다(`pelham_staff_customer_qr`, 직원 토큰으로) — 화면이 아무 번호에나
보내지 못하게. STOP 으로 답한 번호에는 보내지 않는다.
"""

from __future__ import annotations

import io
import logging
import re
from functools import lru_cache

import segno
from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, Field

from backend.services import supabase_rest
from backend.services.twilio_sms import is_opted_out, normalize_phone, public_api_base, send_sms

logger = logging.getLogger(__name__)

router = APIRouter()

GPS_APP_ORIGIN = "https://golf-gps-pelhamhills-seven.vercel.app"

#: SQL `pelham_customer_qr_parse` 와 같은 꼴 — 헷갈리는 글자(0 O 1 I L U)가 없는 10자.
QR_CODE_RE = re.compile(r"PHC-[2-9A-HJKMNP-TV-Z]{10}")

UNAVAILABLE = "Can't reach the database right now. Try again in a moment."


class TextQrIn(BaseModel):
    customer_ref: str = Field(min_length=1, max_length=40)


def qr_link(code: str) -> str:
    return f"{GPS_APP_ORIGIN}/me?c={code}"


def qr_png(code: str) -> bytes:
    """QR 그림. 휴대폰 화면을 카운터 스캐너로 읽기 넉넉한 크기(칸 하나 8px)."""
    out = io.BytesIO()
    segno.make(qr_link(code), error="m").save(out, kind="png", scale=8, border=4)
    return out.getvalue()


@lru_cache(maxsize=1)
def app_qr_png() -> bytes:
    """영수증 문자·메일에 붙는 앱 QR. 누구에게나 같은 앱 주소라 토큰이 없다."""
    out = io.BytesIO()
    segno.make(GPS_APP_ORIGIN, error="m").save(out, kind="png", scale=8, border=4)
    return out.getvalue()


def app_qr_image_url() -> str | None:
    """Twilio·메일 프로그램이 받아 갈 주소. 공개 https 주소가 없으면(로컬 개발) None — 링크만 간다."""
    base = public_api_base()
    return f"{base}/sms/app-qr.png" if base.startswith("https://") else None


def qr_image_url(code: str) -> str | None:
    """Twilio 가 받아 갈 주소. 공개 https 주소가 없으면(로컬 개발) None — 그림 없이 글만 간다."""
    base = public_api_base()
    if not QR_CODE_RE.fullmatch(code) or not base.startswith("https://"):
        return None
    return f"{base}/sms/qr/{code}.png"


def _token(request: Request) -> str:
    header = request.headers.get("authorization") or ""
    return header[7:].strip() if header.lower().startswith("bearer ") else ""


@router.get("/sms/app-qr.png")
def app_qr_image() -> Response:
    return Response(content=app_qr_png(), media_type="image/png",
                    headers={"Cache-Control": "public, max-age=86400"})


@router.get("/sms/qr/{code}.png")
def qr_image(code: str) -> Response:
    if not QR_CODE_RE.fullmatch(code):
        raise HTTPException(status_code=404, detail="Not Found")
    return Response(
        content=qr_png(code),
        media_type="image/png",
        headers={"Cache-Control": "public, max-age=31536000, immutable"},
    )


@router.post("/pos/customer-qr/text")
async def text_qr(body: TextQrIn, request: Request) -> dict:
    try:
        card = supabase_rest.rpc_as(_token(request), "pelham_staff_customer_qr", {"p_ref": body.customer_ref})
    except supabase_rest.RpcRefused as exc:
        raise HTTPException(status_code=exc.status, detail=exc.message) from None
    except supabase_rest.SupabaseUnavailable:
        raise HTTPException(status_code=503, detail=UNAVAILABLE) from None
    if not isinstance(card, dict):
        raise HTTPException(status_code=404, detail="Customer not found.")

    code = str(card.get("qrCode") or "")
    phone = normalize_phone(card.get("phone"))
    if not QR_CODE_RE.fullmatch(code):
        raise HTTPException(status_code=409, detail="This customer has no QR code yet.")
    if not phone:
        raise HTTPException(status_code=422, detail="Add a mobile number to the customer first.")
    if is_opted_out(phone):
        raise HTTPException(status_code=409, detail="This number replied STOP, so texts are turned off.")

    first = str(card.get("firstName") or card.get("name") or "").split(" ")[0]
    message = (
        f"Pelham Hills Golf: Hi {first}, here is your check-in QR code. Show it at the pro shop to check in. "
        f"Open it to add it to the Pelham Hills GPS app: {qr_link(code)}"
    ).replace("Hi , ", "Hi, ")
    msg = await send_sms(phone, message, template="customer_qr", booking_ref=body.customer_ref,
                         media_url=qr_image_url(code))
    if msg.status == "failed":
        logger.warning("customer QR text failed for %s: %s", body.customer_ref, msg.error)
        raise HTTPException(status_code=502, detail="The text didn't go through. Check the number and try again.")
    return {"last4": phone[-4:]}
