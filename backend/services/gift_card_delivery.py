"""온라인으로 산 기프트카드(0144)를 손님에게 — 메일로 상품권, 문자로 바코드, 산 사람에게 영수증.

Gift Cards 화면의 Send email·Send message 와 같은 글·같은 양식이다(`routes/gift_cards.py`). 차이는 직원이 없다는 것뿐이다:
승인을 기록한 곳이 깨우면 바로, 놓쳤으면 1분마다 SQL 에 묻는다(`payment_texts` 와 같다).

- 받는 곳: 산 사람의 이메일·휴대폰은 늘, 받는 사람의 이메일·휴대폰은 적었으면. 같은 주소는 한 번만.
- 한 주문에 한 번: SQL 이 보내기 **전에** 줄을 집는다. 실패해도 다시 가지 않는다. 결과 화면에 바코드가 있고,
  직원이 Gift Cards 화면에서 다시 보낼 수 있다.
- 받는 사람에게 가는 것에는 보낸 사람 이름을 적는다. 모르는 번호로 온 바코드 문자는 스팸처럼 보인다.
"""

from __future__ import annotations

import asyncio
import html
import logging
from typing import Any, Optional

from backend.api.routes import receipts
from backend.core.config import settings
from backend.services import supabase_rest
from backend.services.barcode_png import barcode_url
from backend.services.twilio_sms import normalize_phone, send_sms

logger = logging.getLogger(__name__)

#: 다시 훑는 간격(초). `payment_texts` 와 같다.
SWEEP_SECONDS = 60

_lock = asyncio.Lock()
_wake: Optional[asyncio.Event] = None
_loop: Optional[asyncio.AbstractEventLoop] = None


def _details(row: dict[str, Any]) -> list[tuple[str, str]]:
    card = row.get("card") or {}
    paid_with = receipts._payment_label({"method": "card", **row})
    out = [("Gift card", str(card.get("code") or "")), ("Value", receipts._money(row.get("amount")))]
    if card.get("recipient") and card.get("recipient") != row.get("buyer_name"):
        out.append(("For", str(card["recipient"])))
    out += [("Paid", f"{receipts._money(row.get('amount'))} on {paid_with}"), ("Order", str(row.get("invoice") or ""))]
    return out


def receipt_text(row: dict[str, Any]) -> str:
    out = [receipts.CLUB_NAME, *receipts.CLUB_ADDRESS, "", "Gift card receipt",
           receipts._when({"paid_at": row.get("approved_at")}), ""]
    out += [f"{label}: {value}" for label, value in _details(row)]
    out += ["", "No HST on a gift card: tax is charged when it is spent.",
            f"Questions? Call {settings.PROSHOP_PHONE_NUMBER}."]
    return "\n".join(out) + "\n"


def receipt_html(row: dict[str, Any]) -> str:
    esc = html.escape
    rows = "".join(
        f'<tr><td style="padding:4px 0;color:#6b7280">{esc(label)}</td>'
        f'<td style="padding:4px 0;text-align:right;font-weight:bold">{esc(value)}</td></tr>'
        for label, value in _details(row))
    address = "<br>".join(esc(part) for part in receipts.CLUB_ADDRESS)
    when = esc(receipts._when({"paid_at": row.get("approved_at")}))
    return f"""<!doctype html>
<html><body style="margin:0;background:#f4f4f5;font-family:Arial,Helvetica,sans-serif;color:#18181b">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:24px 12px">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:440px;background:#ffffff;padding:24px;font-size:14px">
<tr><td colspan="2" style="text-align:center;padding-bottom:16px">
<div style="font-size:18px;font-weight:bold;color:#1f4d2b">{esc(receipts.CLUB_NAME)}</div>
<div style="color:#6b7280;font-size:12px;padding-top:4px">{address}</div>
<div style="font-size:16px;font-weight:bold;padding-top:16px">Gift card receipt</div>
<div style="color:#6b7280;font-size:12px">{when}</div>
</td></tr>
{rows}
<tr><td colspan="2" style="text-align:center;padding-top:20px;color:#6b7280;font-size:12px">
No HST on a gift card: tax is charged when it is spent.<br>Questions? Call {esc(settings.PROSHOP_PHONE_NUMBER)}.</td></tr>
</table>
</td></tr></table>
</body></html>"""


def targets(row: dict[str, Any]) -> tuple[list[tuple[str, bool]], list[tuple[str, bool]]]:
    """(이메일, 받는 사람인가) 목록과 (휴대폰, 받는 사람인가) 목록. 산 사람이 먼저, 겹치면 한 번만."""
    buyer_email = str(row.get("buyer_email") or "").lower()
    emails = [(buyer_email, False)] if buyer_email else []
    other_email = str(row.get("recipient_email") or "").lower()
    if other_email and other_email != buyer_email:
        emails.append((other_email, True))

    buyer_phone = normalize_phone(row.get("buyer_phone"))
    phones = [(buyer_phone, False)] if buyer_phone else []
    other_phone = normalize_phone(row.get("recipient_phone"))
    if other_phone and other_phone != buyer_phone:
        phones.append((other_phone, True))
    return emails, phones


async def deliver(row: dict[str, Any]) -> tuple[str, str | None]:
    """한 주문을 보낸다. 하나가 실패해도 나머지는 보낸다. (sent·partial·failed, 오류)."""
    # 순환 import 를 피한다: terminal → gift_orders → 이 파일, gift_cards → terminal.
    from backend.api.routes import gift_cards

    card = row["card"]
    code = card["code"]
    gift = {**card, "from_name": row.get("buyer_name")}
    emails, phones = targets(row)
    sent, errors = 0, []

    async def attempt(label: str, job) -> None:
        nonlocal sent
        try:
            await job()
            sent += 1
        except Exception as exc:
            logger.warning("기프트카드 %s 실패: %s (%s)", label, row.get("invoice"), type(exc).__name__)
            errors.append(f"{label}: {type(exc).__name__}")

    async def text(phone: str, for_someone: bool) -> None:
        msg = await send_sms(phone, gift_cards.gift_card_text(gift if for_someone else card), template="gift_card",
                             booking_ref=code, media_url=barcode_url(code))
        if msg.status in ("failed", "skipped"):
            raise RuntimeError(msg.error or msg.status)

    if receipts.email_enabled():
        await attempt("receipt", lambda: asyncio.to_thread(
            receipts.send_mail, row["buyer_email"], f"Your Pelham Hills gift card receipt {row.get('invoice') or ''}".strip(),
            receipt_text(row), receipt_html(row)))
        for email, for_someone in emails:
            await attempt("email", lambda e=email, s=for_someone: asyncio.to_thread(
                gift_cards._send_certificate, e, gift if s else card))
    else:
        errors.append("email is not set up")
    if settings.TWILIO_ENABLED:
        for phone, for_someone in phones:
            await attempt("text", lambda p=phone, s=for_someone: text(p, s))
    else:
        errors.append("texts are not set up")

    status = "sent" if not errors else "partial" if sent else "failed"
    return status, "; ".join(errors)[:300] or None


def _claim() -> list[dict[str, Any]]:
    return supabase_rest.rpc("pelham_gift_order_deliveries_claim", {"p_limit": 20}) or []


def _record(order_id: str, status: str, error: str | None) -> None:
    supabase_rest.rpc("pelham_gift_order_delivery_result", {"p_id": order_id, "p_status": status, "p_error": error})


async def run() -> None:
    """한 패스. 오류는 삼킨다 — 주문 하나가 다른 주문을 막으면 안 된다."""
    if not receipts.email_enabled() and not settings.TWILIO_ENABLED:
        return
    from starlette.concurrency import run_in_threadpool

    async with _lock:
        try:
            outbox = await run_in_threadpool(_claim)
        except supabase_rest.RpcRefused as exc:
            if exc.status != 404:  # 404 = 0144 를 아직 안 돌렸다.
                logger.error("기프트카드 발송 패스 실패: %s", exc.message)
            return
        except supabase_rest.SupabaseUnavailable:
            return
        except Exception as exc:
            logger.error("기프트카드 발송 패스 실패: %s", exc)
            return
        for row in outbox:
            try:
                status, error = await deliver(row)
            except Exception as exc:
                logger.warning("기프트카드 발송 실패: %s (%s)", row.get("invoice"), type(exc).__name__)
                status, error = "failed", f"{type(exc).__name__}: {exc}"[:300]
            try:
                await run_in_threadpool(_record, str(row["id"]), status, error)
            except Exception as exc:
                logger.warning("기프트카드 발송 결과를 적지 못함 (%s): %s", status, exc)


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
