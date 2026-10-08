"""Twilio 문자 발송·수신 검증.

음성 예약(`backend/api/routes/voice.py`)이 확정·취소 문자를 보내고,
`backend/api/routes/sms.py` 가 손님 답장(C 로 취소, STOP)과 전달 상태를 받는다.
키가 없으면 보내지 않고 `skipped` 로만 기록한다 — 로컬 개발과 테스트가 이 경로를 탄다.
"""

import base64
import hashlib
import hmac
import logging
import os
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from urllib.parse import urlsplit
from uuid import uuid4

import httpx

from backend.core.config import settings

logger = logging.getLogger(__name__)

TWILIO_API = "https://api.twilio.com/2010-04-01"


def public_api_base() -> str:
    """Twilio 가 부를 우리 API 의 공개 주소 (`.../api/v1`). 음성 도구와 같은 변수를 쓴다."""
    return os.getenv("PUBLIC_API_BASE_URL", "http://localhost:8000/api/v1").strip().rstrip("/")


def _public_origin() -> str:
    parts = urlsplit(public_api_base())
    return f"{parts.scheme}://{parts.netloc}"


def normalize_phone(raw: str | None) -> str | None:
    """북미 번호를 E.164(+1XXXXXXXXXX)로 정규화합니다. 판별 불가면 None."""
    if not raw:
        return None
    raw = raw.strip()
    digits = re.sub(r"\D", "", raw)
    if raw.startswith("+") and 8 <= len(digits) <= 15:
        return f"+{digits}"
    if len(digits) == 10:
        return f"+1{digits}"
    if len(digits) == 11 and digits.startswith("1"):
        return f"+{digits}"
    return None


@dataclass
class SmsMessage:
    direction: str  # in / out
    to_e164: str
    from_e164: str
    body: str
    template: str | None = None
    booking_ref: str | None = None
    media_url: str | None = None
    status: str = "queued"  # queued·sent·delivered·failed·skipped·received
    twilio_sid: str | None = None
    error: str | None = None
    id: str = field(default_factory=lambda: str(uuid4()))
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))


# 인메모리 기록 (티시트와 동일하게 서버 재시작 시 초기화)
sms_messages: list[SmsMessage] = []
opted_out: set[str] = set()


def _by_sid(sid: str) -> SmsMessage | None:
    for msg in sms_messages:
        if msg.twilio_sid == sid:
            return msg
    return None


async def send_sms(
    to: str,
    body: str,
    template: str | None = None,
    booking_ref: str | None = None,
    media_url: str | None = None,
) -> SmsMessage:
    """문자를 보낸다. `media_url` 을 주면 그 그림을 붙인 MMS 가 된다 (예약 확정 바코드)."""
    to_e164 = normalize_phone(to) or to
    msg = SmsMessage(
        direction="out",
        to_e164=to_e164,
        from_e164=settings.TWILIO_PHONE_NUMBER,
        body=body,
        template=template,
        booking_ref=booking_ref,
        media_url=media_url,
    )
    sms_messages.insert(0, msg)
    del sms_messages[1000:]

    if to_e164 in opted_out:
        msg.status = "skipped"
        msg.error = "recipient opted out (STOP)"
        return msg
    if not settings.TWILIO_ENABLED:
        msg.status = "skipped"
        msg.error = "Twilio not configured"
        logger.warning("Twilio 미설정 — SMS 미발송: %s %s", to_e164, template)
        return msg

    data = {
        "To": to_e164,
        "Body": body,
        "StatusCallback": f"{public_api_base()}/sms/status",
    }
    if media_url:
        data["MediaUrl"] = media_url
    if settings.TWILIO_MESSAGING_SERVICE_SID:
        data["MessagingServiceSid"] = settings.TWILIO_MESSAGING_SERVICE_SID
    else:
        data["From"] = settings.TWILIO_PHONE_NUMBER

    url = f"{TWILIO_API}/Accounts/{settings.TWILIO_ACCOUNT_SID}/Messages.json"
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            res = await client.post(url, data=data, auth=(settings.TWILIO_ACCOUNT_SID, settings.TWILIO_AUTH_TOKEN))
        payload = res.json()
        if res.status_code >= 400:
            msg.status = "failed"
            msg.error = f"{payload.get('code')}: {payload.get('message')}"
            logger.error("Twilio SMS 실패 (%s): %s", res.status_code, msg.error)
        else:
            msg.twilio_sid = payload.get("sid")
            msg.status = payload.get("status", "queued")
    except Exception as exc:
        msg.status = "failed"
        msg.error = str(exc)
        logger.error("Twilio SMS 예외: %s", exc)
    return msg


def update_status(sid: str, status: str, error_code: str | None = None) -> None:
    msg = _by_sid(sid)
    if msg:
        msg.status = status
        if error_code:
            msg.error = error_code


def validate_twilio_signature(path_with_query: str, params: dict[str, str], signature: str | None) -> bool:
    """X-Twilio-Signature 검증. URL은 Twilio 콘솔에 등록한 공개 주소 기준으로 재구성합니다."""
    if not settings.TWILIO_AUTH_TOKEN:
        # 토큰이 없으면 서명을 확인할 방법이 없다. 이때 통과시키면 누구나 아무 번호를
        # From 에 적어 "C <코드>" 를 보내 남의 예약을 취소할 수 있다 — 닫힌 쪽으로 실패한다.
        # 토큰 없이는 어차피 문자가 오지 않으므로 로컬 개발에서 잃는 것도 없다.
        logger.warning("TWILIO_AUTH_TOKEN 미설정 — Twilio 웹훅 거절")
        return False
    if not signature:
        return False
    url = f"{_public_origin()}{path_with_query}"
    payload = url + "".join(f"{k}{params[k]}" for k in sorted(params))
    digest = hmac.new(settings.TWILIO_AUTH_TOKEN.encode(), payload.encode(), hashlib.sha1).digest()
    expected = base64.b64encode(digest).decode()
    return hmac.compare_digest(expected, signature)
