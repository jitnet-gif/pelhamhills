"""실내 시뮬레이터 웹 예약 → 손님 확정 메일.

웹 예약은 브라우저가 Supabase 에서 끝내므로 이 서버를 거치지 않는다. 확인 문자(`booking_texts`)처럼 1분마다
막 들어온 예약을 묻고(`supabase/migrations/0140_sim_confirmation_emails.sql`) 영수증과 같은 Gmail 로 보낸다.

- 한 예약에 한 통: SQL 이 보내기 **전에** 줄을 집는다. 실패해도 다시 가지 않는다.
- SMTP 키가 없으면 집지 않는다. 집어 두면 키를 넣은 뒤에도 가지 않는다.
"""

from __future__ import annotations

import asyncio
import html
import logging
from typing import Any

from backend.api.routes import receipts, voice, voice_sim
from backend.core.config import settings
from backend.services import supabase_rest

logger = logging.getLogger(__name__)

#: 다시 훑는 간격(초). `booking_texts` 와 같다.
SWEEP_SECONDS = 60

#: 손님이 예약을 바꾸거나 취소하는 화면(`frontend/lib/nav.ts` 의 `lookupHref`).
LOOKUP_URL = "https://www.pelhamhills.ca/book/lookup"

_lock = asyncio.Lock()


def _details(row: dict[str, Any]) -> list[tuple[str, str]]:
    minutes = int(row["start_minutes"])
    players = int(row["player_count"])
    return [
        ("Date", voice.spoken_date(str(row["date"]))),
        ("Time", voice_sim.to_label(f"{minutes // 60:02d}:{minutes % 60:02d}")),
        ("Length", voice_sim._hours_word(int(row["duration_hours"]))),
        ("Bay", str(row["bay_number"])),
        ("Players", str(players)),
        ("Price", f"${float(row['total_price']):,.2f} + HST"),
    ]


def email_text(row: dict[str, Any]) -> str:
    code = str(row["confirmation_code"])
    out = [receipts.CLUB_NAME, *receipts.CLUB_ADDRESS, "", "Your simulator bay is booked", ""]
    out += [f"{label}: {value}" for label, value in _details(row)]
    out += [
        f"Confirmation code: {code}", "",
        "Please arrive 15 minutes early. Pay online or on arrival.",
        f"Change or cancel up to 24 hours before your start time: {LOOKUP_URL}?code={code}",
        f"Questions? Call {settings.PROSHOP_PHONE_NUMBER}.",
    ]
    return "\n".join(out) + "\n"


def email_html(row: dict[str, Any]) -> str:
    """영수증 메일과 같은 꼴 — 표와 인라인 스타일만. 이름은 손님이 친 값이라 이스케이프한다."""
    esc = html.escape
    code = str(row["confirmation_code"])
    rows = "".join(
        f'<tr><td style="padding:4px 0;color:#6b7280">{esc(label)}</td>'
        f'<td style="padding:4px 0;text-align:right;font-weight:bold">{esc(value)}</td></tr>'
        for label, value in _details(row))
    address = "<br>".join(esc(part) for part in receipts.CLUB_ADDRESS)
    return f"""<!doctype html>
<html><body style="margin:0;background:#f4f4f5;font-family:Arial,Helvetica,sans-serif;color:#18181b">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:24px 12px">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:440px;background:#ffffff;padding:24px;font-size:14px">
<tr><td colspan="2" style="text-align:center;padding-bottom:16px">
<div style="font-size:18px;font-weight:bold;color:#1f4d2b">{esc(receipts.CLUB_NAME)}</div>
<div style="color:#6b7280;font-size:12px;padding-top:4px">{address}</div>
<div style="font-size:16px;font-weight:bold;padding-top:16px">Your simulator bay is booked</div>
<div style="color:#6b7280;font-size:12px">Thanks, {esc(str(row.get('name') or 'guest'))}</div>
</td></tr>
{rows}
<tr><td colspan="2" style="text-align:center;padding:16px 0;font-size:20px;font-weight:bold;letter-spacing:2px;color:#1f4d2b">
<div style="font-size:12px;font-weight:normal;letter-spacing:0;color:#6b7280">Confirmation code</div>{esc(code)}</td></tr>
<tr><td colspan="2" style="text-align:center;padding-bottom:12px">
<a href="{esc(LOOKUP_URL)}?code={esc(code)}" style="color:#1f4d2b;font-weight:bold">View, change or cancel this booking</a></td></tr>
<tr><td colspan="2" style="text-align:center;color:#6b7280;font-size:12px">
Please arrive 15 minutes early. Pay online or on arrival.<br>
You can change or cancel up to 24 hours before your start time.<br>
Questions? Call {esc(settings.PROSHOP_PHONE_NUMBER)}.</td></tr>
</table>
</td></tr></table>
</body></html>"""


def _send(row: dict[str, Any]) -> None:
    receipts.send_mail(str(row["email"]), f"Your simulator booking is confirmed ({row['confirmation_code']})",
                       email_text(row), email_html(row))


def _claim() -> list[dict[str, Any]]:
    return supabase_rest.rpc("pelham_sim_emails_claim", {"p_limit": 20}) or []


def _record(email_id: int, status: str, error: str | None) -> None:
    supabase_rest.rpc("pelham_sim_email_result", {"p_id": email_id, "p_status": status, "p_error": error})


async def run() -> None:
    """한 패스. 오류는 삼킨다 — 메일 하나가 다른 메일을 막으면 안 된다."""
    if not receipts.email_enabled():
        return
    from starlette.concurrency import run_in_threadpool

    async with _lock:
        try:
            outbox = await run_in_threadpool(_claim)
        except supabase_rest.SupabaseUnavailable:
            return
        except Exception as exc:
            logger.error("시뮬레이터 확정 메일 패스 실패: %s", exc)
            return
        for row in outbox:
            status, error = "sent", None
            try:
                if not receipts.EMAIL_RE.fullmatch(str(row.get("email") or "")):
                    raise ValueError("bad address")
                await run_in_threadpool(_send, row)
            except Exception as exc:
                logger.warning("시뮬레이터 확정 메일 실패: %s (%s)", row.get("id"), type(exc).__name__)
                status, error = "failed", f"{type(exc).__name__}: {exc}"[:300]
            try:
                await run_in_threadpool(_record, int(row["id"]), status, error)
            except Exception as exc:
                logger.warning("시뮬레이터 확정 메일 결과를 적지 못함 (%s): %s", status, exc)


async def loop() -> None:
    """`main` 이 시작할 때 띄운다. 1분마다 한 패스."""
    while True:
        await asyncio.sleep(SWEEP_SECONDS)
        await run()
