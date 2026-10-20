"""Twilio 문자 웹훅: 손님 답장, 전달 상태, 그리고 티타임 리마인더.

  POST /sms/inbound   손님 문자 — STOP/START, "C <코드>" 로 취소(티타임·시뮬레이터), 대기자 제안에 YES/NO,
                      "book"/"reservation" 첫 문자에는 예약 양식, 그 밖은 문자 예약 비서
  POST /sms/status    Twilio 전달 상태 콜백
  GET  /sms/messages  최근 발송·수신 기록 (Calls & SMS 화면용, 직원만 — 0058)
  GET  /sms/opt-outs  STOP 으로 답한 번호 (같은 화면, 직원만 — 0047)
  GET  /sms/barcode/{code}.png  확정 문자(MMS)에 붙는 확인 번호 바코드

확인 문자는 음성 예약이 확정될 때 `voice.py` 가 보낸다. 여기서는 그 뒤의 일을 한다.

## 왜 답장 취소에 코드를 요구하나

음성 도구의 취소는 "전화번호 **와** 성" 두 열쇠를 요구한다 (`voice.cancel_booking`).
문자의 발신 번호는 하나의 열쇠일 뿐이고 위조도 가능하므로, 확인 문자에 실어 보낸
6자리 코드를 두 번째 열쇠로 받는다. 번호만으로 취소되면 번호를 아는 누구나 남의
라운드를 지울 수 있다. 티오프 직전 취소 금지(`CANCEL_CUTOFF_MINUTES`)도 전화와 같다.
"""

from __future__ import annotations

import logging
import re
from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qsl
from xml.sax.saxutils import escape

from fastapi import APIRouter, BackgroundTasks, HTTPException, Request, Response

from backend.api.routes import tee_sheet as ts
from backend.api.routes import marketing, voice, voice_sim
from backend.core.config import settings
from backend.services import sms_agent, waitlist_offers
from backend.services.barcode_png import BARCODE_CODE_RE, barcode_url, code128_png
from backend.services.tee_sheet_store import Scope
from backend.services import supabase_rest
from backend.services.twilio_sms import (
    OPTOUT_TABLE,
    SMS_TABLE,
    SmsMessage,
    is_opted_out,
    normalize_phone,
    opted_out,
    remember_inbound,
    save_message,
    save_status,
    send_sms,
    sms_messages,
    update_status,
    validate_twilio_signature,
)

logger = logging.getLogger(__name__)
router = APIRouter()

STOP_WORDS = {"STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT", "OPTOUT", "REVOKE"}
START_WORDS = {"START", "UNSTOP", "YES", "OPTIN"}

#: 문장 첫머리에 와도 수신 거부로 읽는 단어. CANCEL·END·QUIT 는 빠졌다 — "Cancel my
#: 9am", "End time?" 처럼 평범한 뜻으로 문장을 시작하기 때문이다.
STOP_FIRST_WORDS = {"STOP", "STOPALL", "UNSUBSCRIBE", "OPTOUT", "REVOKE"}

#: 확인 코드 꼴 (`voice._confirmation_code` 6자리 숫자, 옛 영숫자 코드도). "C u saturday"
#: 같은 문장을 취소로 읽지 않게.
CODE_RE = re.compile(r"[A-Z0-9]{6}")
#: 시뮬레이터 예약 코드 (웹 예약은 16진수 10자, 전화·문자 예약은 0018 부터 숫자 10자리).
#: 티타임 코드와 길이로 갈린다.
SIM_CODE_RE = re.compile(r"[0-9A-F]{10}")
#: 확정 문자 속 확인 번호 (`voice.confirmation_text`). 대기자 YES 답장에 바코드를 붙일 때 쓴다.
BOOKED_CODE_RE = re.compile(r"Confirmation #(\d{6})\b")

#: 리마인더 두 번. (감사 로그 표시, 보낼 시각을 티타임으로부터 구하는 함수, 문구)
#: 감사 로그에 남기는 이유: 서버가 재시작돼도 같은 문자를 두 번 보내지 않는다.
REMINDER_DAY_BEFORE = "Reminder text sent (day before)."
REMINDER_TWO_HOURS = "Reminder text sent (2 hours before)."


async def _twilio_params(request: Request) -> dict[str, str]:
    raw = (await request.body()).decode()
    params = dict(parse_qsl(raw, keep_blank_values=True))
    path = request.url.path + (f"?{request.url.query}" if request.url.query else "")
    if not validate_twilio_signature(path, params, request.headers.get("X-Twilio-Signature")):
        raise HTTPException(status_code=403, detail="invalid Twilio signature")
    return params


def _twiml(message: str | None = None, media_url: str | None = None) -> Response:
    inner = f"<Message>{escape(message)}</Message>" if message else ""
    if message and media_url:
        inner = f"<Message><Body>{escape(message)}</Body><Media>{escape(media_url)}</Media></Message>"
    return Response(
        content=f'<?xml version="1.0" encoding="UTF-8"?><Response>{inner}</Response>',
        media_type="application/xml",
    )


def _live(booking: ts.TeeBooking, now: datetime) -> bool:
    """손님 입장에서 "아직 살아 있는 예약" 인가. 홀드·취소·막아 둔 칸은 아니다."""
    if booking.status in (ts.BookingStatus.CANCELLED, ts.BookingStatus.BLOCKED, ts.BookingStatus.NO_SHOW):
        return False
    return booking.source != ts.BookingSource.VOICE_HOLD and not ts.hold_expired(booking, now)


def cancel_by_reply(sender: str, code: str) -> str:
    """"C <코드>" 답장 처리. 손님에게 돌려줄 문장을 반환한다."""
    wanted_phone = voice.normalize_phone(sender)
    code = code.strip().upper()
    if not code:
        return voice.not_cancelled_text("Reply C and the code from your confirmation text, e.g. C 482915.")

    today = voice.today_iso()
    now = datetime.now(timezone.utc)
    candidates = [
        booking.id
        for booking in ts.read_bookings(Scope(date_from=today))
        if booking.date >= today
        and _live(booking, now)
        # 옛 영숫자 코드도 받는다 — 바뀌기 전에 확인 문자를 받은 손님이 아직 있다.
        and code in (voice._confirmation_code(booking.id), voice._legacy_confirmation_code(booking.id))
        and any(not p.cancelled and voice.normalize_phone(p.phone) == wanted_phone for p in booking.players)
    ]
    if not candidates:
        return voice.not_cancelled_text(f"There is no upcoming booking with code {code} for this number.")

    with ts.bookings_tx(Scope(ids=set(candidates))) as bookings:
        booking = next((b for b in bookings if b.id in candidates and _live(b, now)), None)
        if booking is None:
            return "Pelham Hills: that booking is already cancelled. There is nothing else to do."
        at = voice.slot_datetime(booking.date, booking.time)
        if at is not None and (at - voice.club_now()).total_seconds() / 60 < voice.CANCEL_CUTOFF_MINUTES:
            return voice.not_cancelled_text(
                f"Your tee time is less than {voice.CANCEL_CUTOFF_MINUTES // 60} hours away, "
                "so it can only be cancelled by the pro shop."
            )
        message = ts._apply_status(booking, ts.BookingStatus.CANCELLED, "Cancelled by text reply")
        ts._audit(booking, message)
        when = f"{voice.spoken_date(booking.date)} at {booking.time}"

    return f"Pelham Hills: cancelled your tee time, {when}. Hope to see you soon."


def _keyword(body: str) -> str:
    """문자 **전체**가 한 단어일 때 그 단어. 그 밖에는 분명한 수신 거부 단어로 시작할 때만.

    예전에는 모든 키워드를 첫 단어로 봤다. 손님이 자유롭게 문자를 보내기 시작하면
    "Cancel my 9am" 이 수신 거부(CANCEL)로, 비서 질문에 답한 "Yes" 가 수신 재개(YES)로
    먹혀 답장이 오지 않는다. 반대로 문자 전체만 보면 "Stop texting me" 가 수신 거부가
    안 된다 — 그만 보내 달라는 사람에게 리마인더가 계속 간다.
    """
    words = re.sub(r"[^\w\s]", "", body).upper().split()
    if len(words) == 1:
        return words[0]
    if words and words[0] in STOP_FIRST_WORDS:
        return words[0]
    return ""


@router.post("/sms/inbound")
async def inbound(request: Request, background: BackgroundTasks) -> Response:
    params = await _twilio_params(request)
    sender = normalize_phone(params.get("From")) or params.get("From", "")
    body = (params.get("Body") or "").strip()
    received = SmsMessage(
        direction="in",
        to_e164=params.get("To", ""),
        from_e164=sender,
        body=body,
        status="received",
        twilio_sid=params.get("MessageSid"),
    )
    remember_inbound(received)
    background.add_task(save_message, received)
    reply = await _handle_inbound(sender, body, background)
    # 바로 돌려주는 답장(TwiML)도 기록에 남긴다. Twilio 가 따로 sid 를 주지 않으므로 상태는 'sent'.
    if reply.message:
        background.add_task(save_message, SmsMessage(
            direction="out", to_e164=sender, from_e164=params.get("To", ""), body=reply.message,
            template="reply", media_url=reply.media_url, status="sent",
        ))
    return _twiml(reply.message, reply.media_url)


class _Reply:
    def __init__(self, message: str | None = None, media_url: str | None = None) -> None:
        self.message = message
        self.media_url = media_url


async def _handle_inbound(sender: str, body: str, background: BackgroundTasks) -> _Reply:
    from starlette.concurrency import run_in_threadpool

    # 다른 머신이 받은 STOP/START 도 따르게 DB 에 묻는다 (`is_opted_out` 이 메모리도 맞춘다).
    was_opted_out = await run_in_threadpool(is_opted_out, sender)

    keyword = _keyword(body)
    words = body.upper().split()

    if keyword in STOP_WORDS:
        opted_out.add(sender)
        # 수신 거부의 진실은 DB(0047)다 — 이 집합은 재시작하면 비고, 머신마다 따로다.
        # 응답 전에 남긴다: 바로 다음 문자(리마인더 등)가 다른 머신에서 나갈 수 있다.
        await run_in_threadpool(marketing.record_sms_reply, sender, True)
        return _Reply()
    # "YES" 는 수신 거부한 사람에게만 수신 재개다. 그 밖에는 비서에게 하는 대답이다.
    if keyword in START_WORDS and (keyword != "YES" or was_opted_out):
        opted_out.discard(sender)
        await run_in_threadpool(marketing.record_sms_reply, sender, False)
        return _Reply()

    if words and words[0] == "C" and len(words) == 2 and SIM_CODE_RE.fullmatch(words[1]):
        # 시뮬레이터는 Supabase 에 있다 — 발신번호와 코드가 둘 다 맞아야 한다 (`voice_sim`).
        reply = await run_in_threadpool(voice_sim.cancel_by_code, sender, words[1])
        return _Reply(reply)

    if words and words[0] == "C" and (len(words) == 1 or (len(words) == 2 and CODE_RE.fullmatch(words[1]))):
        reply = await run_in_threadpool(cancel_by_reply, sender, "".join(words[1:]))
        # 자리가 비었으면 대기자에게 바로 건다 (1분 루프를 기다리지 않게).
        background.add_task(waitlist_offers.run)
        return _Reply(reply)

    # 대기자 제안에 대한 YES/NO. 이 번호에 걸린 제안이 있을 때만 가로챈다 — 아니면
    # 문자 비서에게 "Yes" 라고 답한 손님의 대화를 뺏게 된다.
    if waitlist_offers.reply_word(body):
        reply = await run_in_threadpool(waitlist_offers.handle_reply, sender, body)
        if reply is not None:
            background.add_task(waitlist_offers.run)  # NO 면 다음 사람에게 바로
            # YES 로 예약이 됐으면 답장이 곧 확정 문자다 — 다른 확정처럼 바코드를 붙인다.
            booked = BOOKED_CODE_RE.search(reply)
            return _Reply(reply, barcode_url(booked.group(1)) if booked else None)

    # 수신 거부한 번호에는 비서를 돌리지 않는다. 예약은 되는데 확인 문자도 답장도
    # 못 받는 일이 생긴다.
    if sms_agent.enabled() and body and not was_opted_out:
        # "book"·"reservation" 으로 처음 연락한 손님에게는 채워 보낼 양식을 준다.
        # 채운 답장은 아래 비서가 읽고 예약한다.
        if sms_agent.wants_booking_form(sender, body):
            return _Reply(sms_agent.start_booking_form(sender, body))
        # 답장은 응답이 나간 뒤 REST 로 보낸다 (`sms_agent.handle_text` 참고).
        background.add_task(sms_agent.handle_text, sender, body)
        return _Reply()

    return _Reply(
        f"Pelham Hills: reply C and your code to cancel. For anything else call {settings.PROSHOP_PHONE_NUMBER}."
    )


@router.get("/sms/barcode/{code}.png")
def barcode_png(code: str) -> Response:
    """확정 문자(MMS)에 붙는 바코드. Twilio 가 내려받아 손님 휴대폰으로 보낸다.

    공개 경로다 — 그림에는 주소에 이미 있는 숫자 말고 아무 정보도 없다 (`barcode_png`).
    """
    if not BARCODE_CODE_RE.fullmatch(code):
        raise HTTPException(status_code=404, detail="Not Found")
    return Response(
        content=code128_png(code),
        media_type="image/png",
        headers={"Cache-Control": "public, max-age=31536000, immutable"},
    )


@router.post("/sms/status")
async def status(request: Request, background: BackgroundTasks) -> Response:
    params = await _twilio_params(request)
    sid = params.get("MessageSid") or params.get("SmsSid")
    if sid:
        state = params.get("MessageStatus") or params.get("SmsStatus") or "unknown"
        update_status(sid, state, params.get("ErrorCode"))
        background.add_task(save_status, sid, state, params.get("ErrorCode"))
        # 프로모션 문자의 전달 결과는 캠페인 기록(0047)에. 끝난 상태만 — 중간 상태마다 DB 를 두드리지 않는다.
        if state in ("delivered", "failed", "undelivered"):
            background.add_task(marketing.record_sms_status, sid, state, params.get("ErrorCode"))
    return Response(status_code=204)


def _require_staff(request: Request) -> None:
    """직원인가. `/calls` 와 같은 확인 — 요청의 Supabase 토큰으로 SQL 이 본다(단말기 0021).

    목록에는 손님 번호와 문자 본문이 그대로 있다. 예전에는 인증이 없어서 공개 배포에서 숨겼다.
    """
    from backend.api.routes import terminal  # 순환 임포트를 피해 여기서

    terminal._require_staff(request)


def _message_json(m: SmsMessage) -> dict:
    return {
        "id": m.id,
        "direction": m.direction,
        "phone": m.to_e164 if m.direction == "out" else m.from_e164,
        "to": m.to_e164,
        "from": m.from_e164,
        "body": m.body,
        "template": m.template,
        "booking_ref": m.booking_ref,
        "media_url": m.media_url,
        "status": m.status,
        "error": m.error,
        "created_at": m.created_at.isoformat(),
    }


def _row_json(r: dict) -> dict:
    return {
        "id": r.get("id"),
        "direction": r.get("direction"),
        "phone": r.get("phone") or "",
        "to": r.get("to_phone") or "",
        "from": r.get("from_phone") or "",
        "body": r.get("body") or "",
        "template": r.get("template"),
        "booking_ref": r.get("booking_ref"),
        "media_url": r.get("media_url"),
        "status": r.get("status"),
        "error": r.get("error"),
        "created_at": r.get("created_at"),
    }


@router.get("/sms/messages")
def list_messages(
    request: Request,
    phone: str | None = None,
    booking_ref: str | None = None,
    before: str | None = None,
    limit: int = 100,
) -> dict:
    """최근 문자(새것부터). `phone` 이면 그 번호와 주고받은 것만, `before`(created_at)로 다음 쪽.

    DB(0058)에서 읽는다. 0058 전이거나 Supabase 가 안 되면 이 프로세스의 기억으로 답하고 `source` 로 알린다.
    """
    _require_staff(request)
    limit = max(1, min(limit, 200))
    wanted = normalize_phone(phone) if phone else None
    params = {"select": "*", "order": "created_at.desc", "limit": str(limit + 1)}
    if wanted:
        params["phone"] = f"eq.{wanted}"
    if booking_ref:
        params["booking_ref"] = f"eq.{booking_ref}"
    if before:
        params["created_at"] = f"lt.{before}"
    try:
        rows = supabase_rest.select(SMS_TABLE, params)
        source = "db"
        items = [_row_json(r) for r in rows]
    except supabase_rest.SupabaseUnavailable:
        source = "memory"
        items = [
            _message_json(m) for m in sms_messages
            if (not wanted or wanted in (m.to_e164, m.from_e164))
            and (not booking_ref or m.booking_ref == booking_ref)
            and (not before or m.created_at.isoformat() < before)
        ][: limit + 1]
    return {"messages": items[:limit], "has_more": len(items) > limit, "source": source}


@router.get("/sms/opt-outs")
def list_opt_outs(request: Request) -> dict:
    """STOP 으로 답한 번호 (0047, source='reply'). 이 번호들에는 어떤 문자도 나가지 않는다."""
    _require_staff(request)
    try:
        rows = supabase_rest.select(OPTOUT_TABLE, {
            "select": "phone,created_at", "channel": "eq.sms", "source": "eq.reply", "order": "created_at.desc",
        })
        return {"opt_outs": [{"phone": f"+1{r['phone']}", "created_at": r.get("created_at")} for r in rows],
                "source": "db"}
    except supabase_rest.SupabaseUnavailable:
        return {"opt_outs": [{"phone": p, "created_at": None} for p in sorted(opted_out)], "source": "memory"}


# ===== 리마인더 ========================================================

def _due_reminders() -> list[tuple[str, str]]:
    """지금 보내야 할 리마인더를 골라 감사 로그에 먼저 표시하고 (전화번호, 문구) 를 돌려준다.

    표시를 먼저 하는 이유: 발송은 트랜잭션 밖(`await`)에서 한다. 보낸 뒤에 표시하면
    그 사이 서버가 죽었을 때 다음 패스가 같은 문자를 또 보낸다. 한 통 빠지는 쪽이
    두 통 가는 쪽보다 낫다.

    확인 문자를 받은 손님(음성 예약)에게만 보낸다 — 문자를 받겠다고 한 적 없는
    웹·직원 예약 손님에게 갑자기 문자가 가면 안 된다.
    """
    now_local = voice.club_now()
    now_utc = datetime.now(timezone.utc)
    today = now_local.date().isoformat()
    tomorrow = (now_local.date() + timedelta(days=1)).isoformat()
    due: list[tuple[str, str]] = []

    with ts.bookings_tx(Scope(date_from=today, date_to=tomorrow)) as bookings:
        for booking in bookings:
            if booking.source != ts.BookingSource.VOICE or not _live(booking, now_utc):
                continue
            if booking.status != ts.BookingStatus.RESERVED:
                continue
            phone = next((p.phone for p in booking.players if p.phone and not p.cancelled), "")
            tee_at = voice.slot_datetime(booking.date, booking.time)
            if not phone or tee_at is None:
                continue
            sent = {entry.message for entry in booking.audit}
            created = booking.createdAt.astimezone(voice.CLUB_TIMEZONE)

            day_before = (tee_at - timedelta(days=1)).replace(hour=18, minute=0)
            if (
                REMINDER_DAY_BEFORE not in sent
                and created < day_before <= now_local < tee_at - timedelta(hours=3)
            ):
                ts._audit(booking, REMINDER_DAY_BEFORE)
                due.append((phone, f"Pelham Hills: see you tomorrow at {booking.time}! "
                                   f"Reply C {voice._confirmation_code(booking.id)} to cancel."))

            two_hours = tee_at - timedelta(hours=2)
            if REMINDER_TWO_HOURS not in sent and created < two_hours <= now_local < tee_at:
                ts._audit(booking, REMINDER_TWO_HOURS)
                due.append((phone, f"Pelham Hills: your tee time is at {booking.time}. "
                                   "Please check in at the pro shop 15 minutes early."))
    return due


async def run_reminders() -> None:
    """1분마다 `main.py` 가 부른다. Twilio 가 설정돼 있을 때만 돈다."""
    from starlette.concurrency import run_in_threadpool

    for phone, text in await run_in_threadpool(_due_reminders):
        await send_sms(phone, text, template="reminder")
