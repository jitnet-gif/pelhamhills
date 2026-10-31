"""결제한 계산서의 영수증을 손님에게 — 문자와 이메일.

왜(2026-10-26): 카드 결제는 승인 문자(0028)가 가지만 현금·수표·기프트카드 등으로 낸 손님은 종이 영수증뿐이었고,
이메일 영수증은 어느 결제에도 없었다. 결제 끝 화면("Payment complete")에서 번호·이메일을 받아 여기로 보낸다.

  GET  /pos/receipts/{bill}/contact   그룹이면 대표자, 개별이면 본인의 번호·이메일(화면이 칸을 미리 채운다)
  POST /pos/receipts/{bill}/send      {phone?, email?}  적힌 곳으로 영수증 전체를 보낸다

직원 확인은 단말기와 같다 — 요청의 Supabase 토큰으로 `pelham_staff_bill`(0005)을 불러 계산서도 같이 읽는다.
결제가 끝난(paid) 계산서만 보낸다. 같은 계산서를 여러 번 보내도 된다 — 번호를 잘못 넣었거나 손님이 다시 달라고 할 때.
STOP 으로 답한 번호에는 `send_sms` 가 보내지 않는다.

## 이메일 설정 (Fly 환경변수)
- `RECEIPT_SMTP_USER`, `RECEIPT_SMTP_PASSWORD` — 보내는 Gmail(Workspace) 계정과 앱 비밀번호.
  없으면 `ACTIVITY_SMTP_USER`/`ACTIVITY_SMTP_PASSWORD`(activity_alert)를 쓴다. 둘 다 없으면 이메일은 503.
- `RECEIPT_SMTP_HOST` / `RECEIPT_SMTP_PORT` — 기본 smtp.gmail.com / 587.
- `RECEIPT_REPLY_TO` — 손님이 답장하면 갈 곳. 기본 info@pelhamhills.ca.
"""

from __future__ import annotations

import asyncio
import html
import logging
import os
import re
import smtplib
from datetime import datetime
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.utils import formataddr
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from backend.api.routes import customer_qr, terminal, voice
from backend.core.config import settings
from backend.services import supabase_rest
from backend.services.twilio_sms import normalize_phone, send_sms

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/pos/receipts", tags=["Retail"])

CLUB_NAME = "Pelham Hills Golf Club"
CLUB_ADDRESS = ["196 Webber Road", "Welland, Ontario, L3B 5N8", "Canada"]

#: 화면의 `PAYMENT_LABELS`(frontend/lib/retail/receipt.ts)와 같은 이름.
PAYMENT_LABELS = {
    "cash": "Cash",
    "card": "Card",
    "debit": "Debit (Interac)",
    "cheque": "Cheque",
    "e_transfer": "Interac e-Transfer",
    "member_account": "Member account",
    "gift_card": "Gift card",
    "rain_check": "Rain check",
}

#: 문자에 적는 품목 수. 나머지는 "+N more" 로.
SMS_LINES = 6

EMAIL_RE = re.compile(r"[^@\s]+@[^@\s]+\.[^@\s]+")

#: 영수증 문자·메일에 함께 가는 앱 링크. 그림은 `customer_qr.app_qr_image_url()`.
APP_URL = customer_qr.GPS_APP_ORIGIN
APP_LINE = f"Pelham Hills app: {APP_URL}"


def app_html() -> str:
    """영수증 메일의 앱 QR 과 링크. 메일 프로그램이 data: 그림을 막아서 그림은 공개 주소로 건다."""
    image = customer_qr.app_qr_image_url()
    qr = (f'<a href="{APP_URL}"><img src="{html.escape(image)}" width="140" height="140" '
          'alt="QR code for the Pelham Hills app" style="display:block;margin:0 auto 6px;border:0"></a>') if image else ""
    return (f'<tr><td colspan="2" style="text-align:center;padding-top:20px;font-size:13px">'
            f'<div style="font-weight:bold;padding-bottom:8px">Scan to open the Pelham Hills app</div>{qr}'
            f'<a href="{APP_URL}" style="color:#1f4d2b;font-size:12px">{APP_URL}</a></td></tr>')


class SendRequest(BaseModel):
    phone: str = Field(default="", max_length=40)
    email: str = Field(default="", max_length=200)


def _money(cents: Any) -> str:
    return f"${int(cents or 0) / 100:,.2f}"


def _when(bill: dict[str, Any]) -> str:
    iso = bill.get("paid_at") or bill.get("created_at")
    try:
        at = datetime.fromisoformat(str(iso).replace("Z", "+00:00")).astimezone(voice.CLUB_TIMEZONE)
    except Exception:
        at = voice.club_now()
    return at.strftime("%b %-d, %Y %-I:%M %p")


def _payment_label(payment: dict[str, Any]) -> str:
    label = PAYMENT_LABELS.get(str(payment.get("method") or ""), str(payment.get("method") or "Payment"))
    if payment.get("card_last4"):
        label += f" ••••{payment['card_last4']}"
    return label


def _lines(bill: dict[str, Any]) -> list[dict[str, Any]]:
    return [line for line in bill.get("lines") or [] if line.get("active", True)]


def receipt_sms(bill: dict[str, Any]) -> str:
    out = [f"Pelham Hills receipt {bill.get('receipt_no') or ''} — {_when(bill)}"]
    lines = _lines(bill)
    for line in lines[:SMS_LINES]:
        qty = int(line.get("quantity") or 1)
        out.append(f"{line.get('name')}{f' x{qty}' if qty > 1 else ''} {_money(line.get('line_total'))}")
    if len(lines) > SMS_LINES:
        out.append(f"+{len(lines) - SMS_LINES} more")
    totals = [f"Subtotal {_money(bill.get('subtotal'))}"]
    if int(bill.get("discount") or 0) > 0:
        totals.append(f"Discount -{_money(bill.get('discount'))}")
    totals.append(f"HST {_money(bill.get('tax'))}")
    totals.append(f"Total {_money(bill.get('total'))}")
    out.append(" · ".join(totals))
    payments = bill.get("payments") or []
    if payments:
        out.append("Paid: " + ", ".join(f"{_payment_label(p)} {_money(p.get('amount'))}" for p in payments))
    if int(bill.get("tip") or 0) > 0:
        out.append(f"Tip {_money(bill.get('tip'))}")
    out.append(APP_LINE)
    out.append(f"Thank you! Questions? Call {settings.PROSHOP_PHONE_NUMBER}. Reply STOP to opt out.")
    return "\n".join(out)


def receipt_email_text(bill: dict[str, Any]) -> str:
    out = [CLUB_NAME, *CLUB_ADDRESS, "", f"Sales receipt {bill.get('receipt_no') or ''}", _when(bill), ""]
    for line in _lines(bill):
        qty = int(line.get("quantity") or 1)
        out.append(f"{line.get('name')}{f'  x{qty}' if qty > 1 else ''}  {_money(line.get('line_total'))}")
    out.append("")
    out.append(f"Subtotal  {_money(bill.get('subtotal'))}")
    if int(bill.get("discount") or 0) > 0:
        out.append(f"Discount  -{_money(bill.get('discount'))}")
    out.append(f"HST (13%)  {_money(bill.get('tax'))}")
    out.append(f"Total  {_money(bill.get('total'))}")
    out.append("")
    for payment in bill.get("payments") or []:
        out.append(f"{_payment_label(payment)}  {_money(payment.get('amount'))}")
    if int(bill.get("tip") or 0) > 0:
        out.append(f"Tip  {_money(bill.get('tip'))}")
    out += ["", "Thank you!", f"Questions? Call {settings.PROSHOP_PHONE_NUMBER}.", APP_LINE]
    return "\n".join(out) + "\n"


def receipt_email_html(bill: dict[str, Any]) -> str:
    """메일 프로그램이 CSS 를 거의 못 읽어서 표와 인라인 스타일만 쓴다. 상품명·담당자는 사람이 친 값이라 이스케이프한다."""
    esc = html.escape

    def row(label: str, amount: str, *, bold: bool = False, muted: str = "") -> str:
        weight = "font-weight:bold;" if bold else ""
        sub = f'<div style="color:#6b7280;font-size:12px">{esc(muted)}</div>' if muted else ""
        return (f'<tr><td style="padding:4px 0;{weight}">{esc(label)}{sub}</td>'
                f'<td style="padding:4px 0;text-align:right;white-space:nowrap;{weight}">{esc(amount)}</td></tr>')

    items = []
    for line in _lines(bill):
        qty = int(line.get("quantity") or 1)
        detail = f"{qty} @ {_money(line.get('unit_price'))}" if qty > 1 else ""
        if int(line.get("discount") or 0) > 0:
            detail = " · ".join(filter(None, [detail, f"Discount {_money(line.get('discount'))}"]))
        items.append(row(str(line.get("name") or ""), _money(line.get("line_total")), muted=detail))
    totals = [row("Subtotal", _money(bill.get("subtotal")))]
    if int(bill.get("discount") or 0) > 0:
        totals.append(row("Discount", f"-{_money(bill.get('discount'))}"))
    totals.append(row("HST (13%)", _money(bill.get("tax"))))
    totals.append(row("Total", _money(bill.get("total")), bold=True))
    paid = [row(_payment_label(p), _money(p.get("amount"))) for p in bill.get("payments") or []]
    if int(bill.get("tip") or 0) > 0:
        paid.append(row("Tip", _money(bill.get("tip"))))
    rule = '<tr><td colspan="2" style="border-top:1px solid #d4d4d8;padding:0"></td></tr>'
    address = "<br>".join(esc(part) for part in CLUB_ADDRESS)
    return f"""<!doctype html>
<html><body style="margin:0;background:#f4f4f5;font-family:Arial,Helvetica,sans-serif;color:#18181b">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:24px 12px">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:440px;background:#ffffff;padding:24px;font-size:14px">
<tr><td colspan="2" style="text-align:center;padding-bottom:16px">
<div style="font-size:18px;font-weight:bold;color:#1f4d2b">{esc(CLUB_NAME)}</div>
<div style="color:#6b7280;font-size:12px;padding-top:4px">{address}</div>
<div style="font-size:16px;font-weight:bold;padding-top:16px">Sales receipt</div>
<div style="color:#6b7280;font-size:12px">{esc(str(bill.get('receipt_no') or ''))} · {esc(_when(bill))}</div>
</td></tr>
{''.join(items)}
{rule}
{''.join(totals)}
{rule}
<tr><td colspan="2" style="padding:8px 0 2px;font-size:12px;font-weight:bold;color:#6b7280">PAYMENTS</td></tr>
{''.join(paid) or row('No charge', _money(0))}
{app_html()}
<tr><td colspan="2" style="text-align:center;padding-top:20px;color:#6b7280;font-size:12px">
Thank you! Questions? Call {esc(settings.PROSHOP_PHONE_NUMBER)}.</td></tr>
</table>
</td></tr></table>
</body></html>"""


def _smtp() -> tuple[str, str]:
    user = (os.getenv("RECEIPT_SMTP_USER") or os.getenv("ACTIVITY_SMTP_USER") or "").strip()
    password = (os.getenv("RECEIPT_SMTP_PASSWORD") or os.getenv("ACTIVITY_SMTP_PASSWORD") or "").replace(" ", "")
    return user, password


def email_enabled() -> bool:
    user, password = _smtp()
    return bool(user and password)


def send_mail(to: str, subject: str, text: str, body_html: str) -> None:
    """손님에게 가는 메일은 전부 여기로 나간다(영수증, `booking_emails`, `payment_emails`)."""
    user, password = _smtp()
    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"] = formataddr((CLUB_NAME, user))
    msg["To"] = to
    msg["Reply-To"] = os.getenv("RECEIPT_REPLY_TO") or "info@pelhamhills.ca"
    msg.attach(MIMEText(text, "plain", "utf-8"))
    msg.attach(MIMEText(body_html, "html", "utf-8"))
    with smtplib.SMTP(os.getenv("RECEIPT_SMTP_HOST") or "smtp.gmail.com",
                      int(os.getenv("RECEIPT_SMTP_PORT") or "587"), timeout=20) as server:
        server.starttls()
        server.login(user, password)
        server.sendmail(user, [to], msg.as_string())


def _send_email(to: str, bill: dict[str, Any]) -> None:
    send_mail(to, f"Your Pelham Hills receipt {bill.get('receipt_no') or ''}".strip(),
              receipt_email_text(bill), receipt_email_html(bill))


def _paid_bill(request: Request, bill_id: int) -> dict[str, Any]:
    bill = terminal._as_staff(request, "pelham_staff_bill", {"p_id": bill_id})
    if not isinstance(bill, dict) or bill.get("status") != "paid":
        raise HTTPException(status_code=409, detail="Only a paid bill has a receipt to send.")
    return bill


def _first(values: list[str | None]) -> str:
    return next((value.strip() for value in values if value and value.strip()), "")


def bill_contact(bill_id: int) -> dict[str, str]:
    """계산서에 담긴 예약에서 번호·이메일 하나씩.

    여러 명을 한 계산서로 내면(그룹) 예약 대표자(첫 플레이어) → 줄의 티타임 플레이어 → 그 예약의 첫 값 → 베이 예약.
    한 명만 내면(개별) 대표자를 앞세우지 않고 그 사람 값부터 쓴다.
    """
    lines = supabase_rest.select("pelham_bill_lines", {
        "bill_id": f"eq.{bill_id}", "select": "kind,booking_id,player_id,sim_reservation_id,active", "order": "id"})
    phones: list[str | None] = []
    emails: list[str | None] = []
    tee = [line for line in lines
           if line.get("kind") == "tee_player" and line.get("booking_id") and line.get("active", True)]
    if tee:
        group = len({(str(line["booking_id"]), str(line.get("player_id"))) for line in tee}) > 1
        ids = sorted({str(line["booking_id"]) for line in tee})
        quoted = ",".join('"' + i.replace('"', "") + '"' for i in ids)
        docs = {str(row["id"]): row.get("doc") or {} for row in supabase_rest.select(
            "pelham_tee_bookings", {"id": f"in.({quoted})", "select": "id,doc"})}
        for line in tee:
            players = docs.get(str(line["booking_id"]), {}).get("players") or []
            mine = [p for p in players if str(p.get("id")) == str(line.get("player_id"))]
            for player in (players[:1] if group else []) + mine + players:
                phones.append(player.get("phone"))
                emails.append(player.get("email"))
    sims = [int(line["sim_reservation_id"]) for line in lines if line.get("sim_reservation_id")]
    if sims:
        for row in supabase_rest.select("pelham_sim_reservations", {
                "id": f"in.({','.join(str(s) for s in sims)})", "select": "phone,customer_email"}):
            phones.append(row.get("phone"))
            emails.append(row.get("customer_email"))
    email = _first(emails)
    return {"phone": _first(phones), "email": email if EMAIL_RE.fullmatch(email) else ""}


@router.get("/{bill_id}/contact")
async def contact(bill_id: int, request: Request) -> dict[str, Any]:
    await asyncio.to_thread(_paid_bill, request, bill_id)
    try:
        found = await asyncio.to_thread(bill_contact, bill_id)
    except supabase_rest.SupabaseUnavailable:
        found = {"phone": "", "email": ""}
    return {**found, "can_text": settings.TWILIO_ENABLED, "can_email": email_enabled()}


@router.post("/{bill_id}/send")
async def send(bill_id: int, body: SendRequest, request: Request) -> dict[str, Any]:
    phone = normalize_phone(body.phone) if body.phone.strip() else None
    if body.phone.strip() and not phone:
        raise HTTPException(status_code=422, detail="Enter a 10-digit phone number.")
    email = body.email.strip()
    if email and not EMAIL_RE.fullmatch(email):
        raise HTTPException(status_code=422, detail="That email address doesn't look right.")
    if not phone and not email:
        raise HTTPException(status_code=422, detail="Enter a phone number or an email address.")
    if phone and not settings.TWILIO_ENABLED:
        raise HTTPException(status_code=503, detail="Text messages are not set up on the server yet.")
    if email and not email_enabled():
        raise HTTPException(status_code=503, detail="Email receipts are not set up on the server yet.")

    bill = await asyncio.to_thread(_paid_bill, request, bill_id)
    result: dict[str, Any] = {"ok": True, "text": None, "email": None}
    problems: list[str] = []
    if phone:
        msg = await send_sms(phone, receipt_sms(bill), template="bill_receipt", booking_ref=bill.get("receipt_no"),
                             media_url=customer_qr.app_qr_image_url())
        result["text"] = {"to": phone, "status": msg.status}
        if msg.status in ("failed", "skipped"):
            problems.append(f"the text did not go out ({msg.error or msg.status})")
    if email:
        try:
            await asyncio.to_thread(_send_email, email, bill)
            result["email"] = {"to": email, "status": "sent"}
        except Exception as exc:
            logger.warning("영수증 메일 실패: bill=%s (%s)", bill_id, type(exc).__name__)
            result["email"] = {"to": email, "status": "failed"}
            problems.append("the email did not go out")
    if problems:
        sent = [kind for kind in ("text", "email") if result[kind] and result[kind]["status"] not in ("failed", "skipped")]
        prefix = f"The {' and '.join(sent)} went out, but " if sent else ""
        detail = prefix + " and ".join(problems)
        raise HTTPException(status_code=502, detail=detail[0].upper() + detail[1:] + ".")
    logger.info("영수증 보냄: bill=%s text=%s email=%s", bill_id, bool(phone), bool(email))
    return result
