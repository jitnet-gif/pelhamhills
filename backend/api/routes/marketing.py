"""고객 마케팅 — 프로모션 문자(Twilio)·AI 전화(ElevenLabs) 발송. 화면은 `/marketing`.

GET  /marketing/status                  문자·전화가 켜져 있나, 지금 보낼 수 있는 시각인가
POST /marketing/campaigns/{id}/send     캠페인 보내기(멈췄던 캠페인은 이어서)
GET  /marketing/campaigns/{id}/cost     보낸 캠페인 비용(문자 = Twilio 요금, 전화 = ElevenLabs 크레딧)
POST /marketing/voice/opt-out           (에이전트 도구) 통화 중 "다시 걸지 마라" → 전화 수신거부

받는 사람·동의·수신거부는 전부 SQL(0047)이 정한다. 이 서버는 키를 들고 한 명씩 보낼 뿐이다.
직원 확인은 단말기와 같다 — 요청의 Supabase 토큰으로 `pelham_marketing_campaign` 를 부르면
명단(`pelham_marketing_viewers`) 밖 계정은 SQL 이 PT403 으로 거절한다.

보내는 시각: CRTC 텔레마케팅 규칙(평일 9:00–21:30, 주말 10:00–18:00, 클럽 현지 시각)을 문자에도 같이
적용한다. 보내는 도중 그 시각을 넘기면 남은 사람은 줄에 그대로 두고 멈춘다 — 다음 날 "보내기"를 다시
누르면 이어서 나간다. 같은 캠페인을 두 번 눌러도 한 줄만 돈다.

문자 끝에는 언제나 보낸 곳과 수신거부 방법을 붙인다(CASL). 손님이 STOP 으로 답하면 `/sms/inbound` 가
`pelham_marketing_optout_record` 로 남기고, 다음 캠페인부터 빠진다.

날씨 알림(Weather alert 탭, 0118 — audience.kind = 'weather'): 그날 티 시트 손님에게 서리 지연·비·번개
같은 돌발상황을 알리는 **거래 메시지**다. 프로모션이 아니라 수신거부 문구를 붙이지 않고, 문자 안 {name}·{time}
을 그 사람의 첫 이름·티 타임으로 바꾼다. 보내는 시각도 따로 — 매일 6:00–22:00 (첫 티 타임 전 서리 지연).
지난 날짜의 알림은 보내지 않는다.
"""

from __future__ import annotations

import asyncio
import logging
import os
from datetime import date, datetime
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from backend.api.routes import terminal
from backend.api.routes.voice import CLUB_TIMEZONE, require_tool_secret
from backend.core.config import settings
from backend.services import service_usage, supabase_rest, voice_agent
from backend.services.barcode_png import barcode_url
from backend.services.twilio_sms import normalize_phone, send_sms

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/marketing", tags=["Marketing"])
# 에이전트 도구는 공유 시크릿으로 막는다(`voice.py` 와 같다). 브라우저가 부르는 router 와 인증이 달라 따로 둔다.
tools_router = APIRouter(dependencies=[Depends(require_tool_secret)])

SMS_FOOTER = "Reply STOP to opt out."
SMS_SENDER = "Pelham Hills Golf"
#: 한 번에 집는 사람 수와 사이 간격. Twilio 일반 번호는 초당 1건이 안전하다.
CLAIM_BATCH = 10
SMS_GAP_SECONDS = 1.0


def _call_gap_seconds() -> float:
    """전화 사이 간격. ElevenLabs 동시 통화 한도를 넘지 않게 넉넉히."""
    try:
        return max(float(os.getenv("MARKETING_CALL_GAP_SECONDS", "20")), 1.0)
    except ValueError:
        return 20.0


#: 지금 돌고 있는 캠페인. 같은 캠페인을 두 번 눌러도 한 줄만 돈다.
_running: set[int] = set()
#: 돌고 있는 작업을 붙잡아 둔다 — asyncio 는 작업을 약하게만 참조해서, 안 잡으면 도중에 사라질 수 있다.
_tasks: set[asyncio.Task[None]] = set()


# ===== 보내는 시각 =======================================================

def window_open(now: datetime | None = None) -> bool:
    """CRTC: 평일 9:00–21:30, 토·일 10:00–18:00 (클럽 현지 시각)."""
    local = (now or datetime.now(CLUB_TIMEZONE)).astimezone(CLUB_TIMEZONE)
    minutes = local.hour * 60 + local.minute
    if local.weekday() >= 5:
        return 10 * 60 <= minutes < 18 * 60
    return 9 * 60 <= minutes < 21 * 60 + 30


WINDOW_TEXT = "Weekdays 9:00 AM–9:30 PM, weekends 10:00 AM–6:00 PM"


def alert_window_open(now: datetime | None = None) -> bool:
    """날씨 알림: 매일 6:00–22:00 (클럽 현지 시각). 예약 손님에게 그날 일을 알리는 문자라 텔레마케팅 시각이 아니다."""
    local = (now or datetime.now(CLUB_TIMEZONE)).astimezone(CLUB_TIMEZONE)
    return 6 <= local.hour < 22


ALERT_WINDOW_TEXT = "Every day 6:00 AM–10:00 PM"


def is_weather_alert(campaign: dict[str, Any]) -> bool:
    return (campaign.get("audience") or {}).get("kind") == "weather"


def _window_for(campaign: dict[str, Any]):
    return alert_window_open if is_weather_alert(campaign) else window_open


def alert_expired(campaign: dict[str, Any], today: date | None = None) -> bool:
    """그날이 지난 날씨 알림 — 어제 서리 지연을 오늘 보내지 않는다."""
    raw = str((campaign.get("audience") or {}).get("date") or "")
    try:
        day = date.fromisoformat(raw[:10])
    except ValueError:
        return False
    return day < (today or datetime.now(CLUB_TIMEZONE).date())


def campaign_barcode_url(campaign: dict[str, Any]) -> Optional[str]:
    """프로모션 화면의 Text it 으로 만든 캠페인은 audience.barcode 에 PROMO-코드가 있다(0078).
    그 바코드 그림을 MMS 로 붙여, 손님이 휴대폰 화면을 내밀면 프로 샵이 찍을 수 있게 한다."""
    code = str((campaign.get("audience") or {}).get("barcode") or "").strip().upper()
    return barcode_url(code) if code.startswith("PROMO-") else None


def sms_body(message: str) -> str:
    text = message.strip()
    if not text.lower().startswith("pelham hills"):
        text = f"{SMS_SENDER}: {text}"
    return f"{text} {SMS_FOOTER}"


def alert_body(message: str, name: str | None, tee_time: str | None) -> str:
    """날씨 알림 한 통. {name}·{time} 을 바꾸고 보낸 곳만 앞에 붙인다(거래 메시지라 수신거부 문구 없음)."""
    first = _first_name(name)
    text = message.strip().replace("{name}", "there" if first.lower() == "guest" else first)
    # 티 타임을 모르면 "your {time} tee time" → "your tee time".
    text = " ".join(text.replace("{time}", (tee_time or "").strip()).split())
    if not text.lower().startswith("pelham hills"):
        text = f"{SMS_SENDER}: {text}"
    return text


def calls_ready() -> bool:
    return bool(voice_agent.api_key() and voice_agent.marketing_agent_id() and voice_agent.outbound_phone_number_id())


def _first_name(name: str | None) -> str:
    parts = (name or "").split()
    return parts[0] if parts else "there"


# ===== 한 명씩 ============================================================

def _service(function: str, args: dict[str, Any]) -> Any:
    return supabase_rest.rpc(function, args)


async def _record(send_id: int, status: str, provider_ref: str | None = None, error: str | None = None) -> None:
    await asyncio.to_thread(_service, "pelham_marketing_send_result", {"p": {
        "id": send_id, "status": status, "provider_ref": provider_ref, "error": error,
    }})


async def _send_one(channel: str, campaign: dict[str, Any], send: dict[str, Any]) -> None:
    phone = normalize_phone(send.get("phone"))
    if not phone:
        await _record(send["id"], "skipped", error="bad phone number")
        return
    if channel == "sms":
        if is_weather_alert(campaign):
            msg = await send_sms(phone, alert_body(campaign["message"], send.get("name"), send.get("tee_time")),
                                 template="weather_alert", booking_ref=f"MK-{campaign['id']}")
        else:
            msg = await send_sms(phone, sms_body(campaign["message"]), template="marketing",
                                 booking_ref=f"MK-{campaign['id']}", media_url=campaign_barcode_url(campaign))
        if msg.status == "failed":
            await _record(send["id"], "failed", msg.twilio_sid, msg.error)
        elif msg.status == "skipped":
            await _record(send["id"], "skipped", None, msg.error)
        else:
            await _record(send["id"], "sent", msg.twilio_sid)
        return

    try:
        result = await voice_agent.outbound_call(phone, {
            "customer_name": _first_name(send.get("name")),
            "customer_phone": phone,
            "promo_message": campaign["message"],
            "campaign_name": campaign["name"],
            "club_phone": settings.PROSHOP_PHONE_NUMBER,
        })
    except voice_agent.VoiceAgentError as exc:
        await _record(send["id"], "failed", None, str(exc)[:300])
        return
    await _record(send["id"], "sent", result.get("conversation_id") or result.get("callSid"))


async def run_campaign(campaign: dict[str, Any]) -> None:
    """줄이 빌 때까지, 또는 보내는 시각이 끝날 때까지 보낸다."""
    campaign_id = int(campaign["id"])
    channel = campaign["channel"]
    gap = SMS_GAP_SECONDS if channel == "sms" else _call_gap_seconds()
    open_now = _window_for(campaign)
    try:
        await asyncio.to_thread(_service, "pelham_marketing_requeue_stuck", {"p_campaign": campaign_id})
        while True:
            if not open_now():
                logger.info("마케팅 %s: 보내는 시각이 끝나 멈춤", campaign_id)
                return
            batch = await asyncio.to_thread(_service, "pelham_marketing_claim",
                                            {"p_campaign": campaign_id, "p_limit": 1 if channel == "call" else CLAIM_BATCH})
            sends = batch.get("sends") or []
            if not sends:
                break
            for index, send in enumerate(sends):
                if not open_now():
                    # 집었지만 못 보낸 사람은 다시 줄로.
                    for rest in sends[index:]:
                        await _record(rest["id"], "queued")
                    return
                await _send_one(channel, campaign, send)
                await asyncio.sleep(gap)
        await asyncio.to_thread(_service, "pelham_marketing_finish", {"p_campaign": campaign_id})
    except Exception:
        logger.exception("마케팅 캠페인 %s 발송 중 오류", campaign_id)
    finally:
        _running.discard(campaign_id)


# ===== 화면이 부르는 것 ===================================================

@router.get("/status")
async def marketing_status(request: Request) -> dict[str, Any]:
    allowed = await asyncio.to_thread(terminal._as_staff, request, "pelham_staff_marketing_access", {})
    if not allowed:
        raise HTTPException(status_code=403, detail="Only the manager and marketing accounts can open marketing.")
    return {
        "sms": settings.TWILIO_ENABLED,
        "call": calls_ready(),
        "window_open": window_open(),
        "window": WINDOW_TEXT,
        "alert_window_open": alert_window_open(),
        "alert_window": ALERT_WINDOW_TEXT,
        "sms_footer": SMS_FOOTER,
        "sms_sender": SMS_SENDER,
        "running": sorted(_running),
    }


@router.post("/campaigns/{campaign_id}/send")
async def send_campaign(campaign_id: int, request: Request) -> dict[str, Any]:
    # 명단 확인과 캠페인 조회를 한 번에.
    campaign = await asyncio.to_thread(terminal._as_staff, request, "pelham_marketing_campaign",
                                       {"p_id": campaign_id})
    if campaign.get("status") in ("sent", "cancelled"):
        raise HTTPException(status_code=409, detail=f"This campaign is already {campaign.get('status')}.")
    if campaign["channel"] == "sms" and not settings.TWILIO_ENABLED:
        raise HTTPException(status_code=503, detail="Text messages are not set up on the server yet (Twilio).")
    if campaign["channel"] == "call" and not calls_ready():
        raise HTTPException(
            status_code=503,
            detail="AI calls are not set up on the server yet "
                   "(ELEVENLABS_API_KEY, ELEVENLABS_PHONE_NUMBER_ID, agent id).",
        )
    if is_weather_alert(campaign):
        if alert_expired(campaign):
            raise HTTPException(status_code=409, detail="This weather alert was for a day that has passed.")
        if not alert_window_open():
            raise HTTPException(status_code=409,
                                detail=f"Weather alerts can only go out {ALERT_WINDOW_TEXT} (club time).")
    elif not window_open():
        raise HTTPException(status_code=409, detail=f"Promotions can only go out {WINDOW_TEXT} (club time).")
    if campaign_id in _running:
        return {"ok": True, "already_running": True}
    _running.add(campaign_id)
    _start(campaign)
    return {"ok": True, "already_running": False}


@router.get("/campaigns/{campaign_id}/cost")
async def campaign_cost(campaign_id: int, request: Request) -> dict[str, Any]:
    """보낸 캠페인이 실제로 얼마 들었나. 문자는 Twilio 의 한 통당 요금, 전화는 ElevenLabs 크레딧.

    요금은 문자가 나가고 조금 지나야 붙는다 — 그전 문자는 pending 으로 센다.
    """
    campaign = await asyncio.to_thread(terminal._as_staff, request, "pelham_marketing_campaign",
                                       {"p_id": campaign_id})
    sends = [s for s in campaign.get("sends") or [] if s.get("provider_ref")]
    refs = [str(s["provider_ref"]) for s in sends]
    if campaign["channel"] == "call":
        try:
            costs = await service_usage.call_costs(refs)
        except Exception:
            raise HTTPException(status_code=502, detail="ElevenLabs did not answer. Try again in a moment.") from None
        return {"channel": "call", "unit": "credits", "total": round(sum(costs.values()), 2),
                "priced": len(costs), "pending": len(refs) - len(costs), "segments": None}
    if not settings.TWILIO_ENABLED:
        raise HTTPException(status_code=503, detail="Text messages are not set up on the server yet (Twilio).")
    since = _day(campaign.get("started_at") or campaign.get("created_at")) or datetime.now(CLUB_TIMEZONE).date()
    until = _day(campaign.get("finished_at")) or datetime.now(CLUB_TIMEZONE).date()
    try:
        prices = await service_usage.twilio_message_prices(refs, since, until)
    except Exception:
        raise HTTPException(status_code=502, detail="Twilio did not answer. Try again in a moment.") from None
    units = {p["unit"] for p in prices.values()}
    return {
        "channel": "sms",
        "unit": units.pop() if len(units) == 1 else "USD",
        "total": round(sum(p["price"] for p in prices.values()), 4),
        "priced": len(prices),
        "pending": len(refs) - len(prices),
        "segments": sum(p["segments"] for p in prices.values()),
    }


def _day(value: Any) -> Optional[date]:
    """타임스탬프의 UTC 날짜. Twilio 의 DateSent 조건도 UTC 날짜다."""
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).date()
    except ValueError:
        return None


def _start(campaign: dict[str, Any]) -> None:
    """응답을 기다리게 하지 않고 뒤에서 보낸다. 전화 캠페인은 몇 시간이 걸릴 수 있다."""
    task = asyncio.get_running_loop().create_task(run_campaign(campaign))
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)


# ===== 에이전트 도구 ======================================================

class OptOutRequest(BaseModel):
    phone: Optional[str] = None
    caller_phone: Optional[str] = None


@tools_router.post("/voice/opt-out")
async def voice_opt_out(body: OptOutRequest) -> dict[str, Any]:
    """통화 중 손님이 다시 걸지 말라고 하면 에이전트가 부른다. 전화·문자 둘 다 뺀다."""
    phone = normalize_phone(body.phone or body.caller_phone)
    if not phone:
        return {"ok": False, "message": "I could not read the phone number."}
    for channel in ("call", "sms"):
        await asyncio.to_thread(_service, "pelham_marketing_optout_record",
                                {"p_phone": phone, "p_channel": channel, "p_source": "call"})
    return {"ok": True, "message": "Removed from Pelham Hills promotional calls and texts."}


def record_sms_reply(sender: str, stop: bool) -> None:
    """`/sms/inbound` 의 STOP/START 를 마케팅 수신거부에 남긴다. 실패해도 답장은 막지 않는다."""
    try:
        if stop:
            _service("pelham_marketing_optout_record", {"p_phone": sender, "p_channel": "sms", "p_source": "reply"})
        else:
            _service("pelham_marketing_optin_record", {"p_phone": sender})
    except Exception as exc:  # 0047 전이거나 Supabase 가 잠시 꺼짐
        logger.warning("마케팅 수신거부 기록 실패: %s", type(exc).__name__)


def record_sms_status(sid: str, status: str, error: str | None) -> None:
    try:
        _service("pelham_marketing_status_by_ref", {"p_ref": sid, "p_status": status, "p_error": error})
    except Exception as exc:
        logger.warning("마케팅 전달 상태 기록 실패: %s", type(exc).__name__)


router.include_router(tools_router)
