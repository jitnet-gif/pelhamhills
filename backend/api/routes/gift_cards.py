"""기프트카드를 손님에게 — 휴대폰으로는 바코드 문자(MMS), 이메일로는 종이 상품권(Gift Certificate).

POST /gift-cards/{code}/text    {phone}   Gift Cards 화면에서 발행할 때, 또는 Send message 를 누를 때.
POST /gift-cards/{code}/email   {email}   발행할 때 이메일을 적었으면, 또는 Send email 을 누를 때(2026-10-29).

어드민은 정적 사이트라 Twilio 키를 들 수 없어서 이 서버가 대신 보낸다. 직원 확인은 레인체크와 같다 —
요청의 Supabase 토큰으로 `pelham_staff_gift_card`(0120)를 불러 코드도 같이 확인한다.
보내는 것은 코드·잔액과 바코드(`/sms/barcode/GIFT-….png`)뿐이다. 계산서 결제 칸에서 손님 휴대폰 화면의
바코드를 쏘면 종이 카드를 쏜 것과 같다.

이메일은 `giftCertificate.ts` 의 인쇄 양식을 메일 표(table)로 옮긴 것이다 — 메일 앱은 grid·SVG 를 못 그린다.
로고와 바코드는 링크가 아니라 메일 안에 붙인 그림(cid)이라 손님 메일 앱이 그림을 막아도 열면 보이고, 인쇄해 와도 된다.
SMTP 설정은 영수증 메일(`receipts._smtp`)과 같다.

무효·잔액 없는·만료된(0139) 카드는 보내지 않는다. 같은 카드를 여러 번 보내도 된다 — 번호를 잘못 넣었거나 손님이 지웠을 때.
"""

from __future__ import annotations

import asyncio
from datetime import date
import html
import logging
import os
import smtplib
from email.mime.image import MIMEImage
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.utils import formataddr
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from backend.api.routes import receipts, terminal
from backend.core.config import settings
from backend.services.barcode_png import BARCODE_CODE_RE, MODULE_PX, barcode_url, code128_png
from backend.services.twilio_sms import normalize_phone, send_sms

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/gift-cards", tags=["Gift Cards"])

#: 프론트 `public/pelham-hills/gift-certificate-logo.png` 와 같은 그림(이미지에는 backend/ 만 들어간다).
LOGO_PNG = Path(__file__).resolve().parents[2] / "assets" / "gift-certificate-logo.png"


class TextRequest(BaseModel):
    phone: str


class EmailRequest(BaseModel):
    email: str


def _money(cents: Any) -> str:
    return f"${int(cents or 0) / 100:,.2f}"


def expiry_text(card: dict[str, Any]) -> str:
    """`Dec 31, 2027`, 없으면 `No expiry`(`giftCard.ts` 의 expiryText 와 같다)."""
    if not card.get("expires_on"):
        return "No expiry"
    day = date.fromisoformat(card["expires_on"])
    return f"{day:%b} {day.day}, {day.year}"


def gift_card_text(card: dict[str, Any]) -> str:
    who = f" for {card['recipient']}" if card.get("recipient") else ""
    expiry = f"Expires {expiry_text(card)}" if card.get("expires_on") else "No expiry"
    return (
        f"Pelham Hills gift card{who}: {_money(card.get('balance'))} to spend on green fees, "
        f"the pro shop and the snack bar. Show this barcode at the counter. Card {card['code']}. "
        f"{expiry}, not redeemable for cash. Anyone with this barcode can spend it, so keep it to yourself. "
        f"Questions? Call {settings.PROSHOP_PHONE_NUMBER}."
    )


def certificate_value(card: dict[str, Any]) -> int:
    """상품권에 적는 금액 — 쓴 적이 있으면 남은 잔액, 아니면 발행 금액(`giftCertificate.ts` 와 같다)."""
    return int(card.get("balance") or 0) if int(card.get("used") or 0) > 0 else int(card.get("amount") or 0)


def certificate_email_text(card: dict[str, Any]) -> str:
    who = f"To: {card['recipient']}\n" if card.get("recipient") else ""
    return (
        f"Pelham Hills Golf Club — Gift Certificate\n\n"
        f"This certificate entitles {_money(certificate_value(card))} — green fees, pro shop & snack bar.\n"
        f"{who}Certificate {card['code']}\nExpires: {expiry_text(card)}\n\n"
        f"Show the barcode in this email (on your phone or printed) at the counter.\n"
        f"Not redeemable for cash. Anyone with this barcode can spend it, so keep it to yourself.\n\n"
        f"Pelham Hills Golf Club, 196 Webber Road, Pelham, ON L3B 5N8 · 905-735-6768 · www.pelhamhills.ca\n"
    )


def barcode_png_width(code: str) -> int:
    """`code128_png` 그림의 폭(px). PNG 머리(IHDR)의 첫 4바이트."""
    return int.from_bytes(code128_png(code)[16:20], "big")


def certificate_email_html(card: dict[str, Any]) -> str:
    esc = html.escape
    serif = "font-family:'Times New Roman',Times,Georgia,serif"
    line = "border-bottom:1px solid #111;padding:0 6px 2px;font-size:20px;font-weight:bold"
    recipient = esc(card.get("recipient") or "") or "&nbsp;"
    # 막대 한 칸 = 화면 2px. 정수 배가 아니면 막대가 뭉개져 스캐너가 못 읽는다(2026-10-28, `code128ScreenWidth`).
    width = barcode_png_width(card["code"]) // (MODULE_PX // 2)
    return f"""<!doctype html><html><body style="margin:0;padding:16px;background:#e5e5e5">
<table role="presentation" align="center" cellpadding="0" cellspacing="0" width="100%"
 style="max-width:680px;background:#fff;color:#111;{serif};border:1px solid #c9c9c9">
<tr><td colspan="2" style="padding:10px 18px 0;text-align:right;font-size:14px;font-weight:bold;letter-spacing:.5px">{esc(card['code'])}</td></tr>
<tr><td colspan="2" style="padding:0 18px;text-align:center;font-size:48px;font-weight:bold;letter-spacing:2px;color:#7c9a6b;line-height:1.05">Gift Certificate</td></tr>
<tr>
<td width="200" valign="bottom" style="padding:12px 10px 16px 18px;text-align:center;font-size:14px;line-height:1.2">
<img src="cid:logo" width="180" alt="Pelham Hills Golf Club" style="display:block;margin:0 auto 4px;width:180px;max-width:100%">
196 Webber Road,<br>Pelham, ON L3B 5N8<br><b style="font-size:15px">905-735-6768</b></td>
<td valign="top" style="padding:14px 18px 16px 6px;font-size:17px">
<table role="presentation" cellpadding="0" cellspacing="0" width="100%">
<tr><td style="padding:6px 0;white-space:nowrap" width="1">This certificate entitles&nbsp;</td>
<td style="{line}">{esc(_money(certificate_value(card)))} <span style="font-size:12px;font-weight:normal;white-space:nowrap">— green fees, pro shop &amp; snack bar</span></td></tr>
<tr><td style="padding:14px 0 6px 28px;white-space:nowrap" width="1">To&nbsp;</td><td style="{line}">{recipient}</td></tr>
<tr><td colspan="2" style="text-align:right;font-size:10px;padding-top:2px">*not redeemable for cash</td></tr>
<tr><td style="padding:10px 0 6px 28px;white-space:nowrap" width="1">Expires on&nbsp;</td><td style="{line};font-size:16px">{esc(expiry_text(card))}</td></tr>
</table>
<div style="margin-top:14px;text-align:right;font-size:18px">www.pelhamhills.ca</div>
</td></tr>
<tr><td colspan="2" style="padding:0 18px 16px;text-align:center">
<img src="cid:barcode" width="{width}" height="80" alt="{esc(card['code'])}" style="display:inline-block;width:{width}px;max-width:100%;height:80px">
<div style="font:13px Menlo,Consolas,monospace;letter-spacing:1px;padding-top:2px">{esc(card['code'])}</div>
</td></tr></table>
<p style="max-width:680px;margin:12px auto 0;font:13px/1.45 system-ui,Arial,sans-serif;color:#333">
Show the barcode above at the counter — on your phone or printed. It works for green fees, the pro shop and the snack bar,
and any amount left stays on the card. Anyone with this barcode can spend it, so keep it to yourself.
Questions? Call {esc(settings.PROSHOP_PHONE_NUMBER)}.</p>
</body></html>"""


def _send_certificate(to: str, card: dict[str, Any]) -> None:
    user, password = receipts._smtp()
    msg = MIMEMultipart("related")
    msg["Subject"] = f"Your Pelham Hills gift certificate — {_money(certificate_value(card))}"
    msg["From"] = formataddr((receipts.CLUB_NAME, user))
    msg["To"] = to
    msg["Reply-To"] = os.getenv("RECEIPT_REPLY_TO") or "info@pelhamhills.ca"
    body = MIMEMultipart("alternative")
    body.attach(MIMEText(certificate_email_text(card), "plain", "utf-8"))
    body.attach(MIMEText(certificate_email_html(card), "html", "utf-8"))
    msg.attach(body)
    for cid, data in (("logo", LOGO_PNG.read_bytes()), ("barcode", code128_png(card["code"]))):
        image = MIMEImage(data, "png")
        image.add_header("Content-ID", f"<{cid}>")
        image.add_header("Content-Disposition", "inline", filename=f"{cid}.png")
        msg.attach(image)
    with smtplib.SMTP(os.getenv("RECEIPT_SMTP_HOST") or "smtp.gmail.com",
                      int(os.getenv("RECEIPT_SMTP_PORT") or "587"), timeout=20) as server:
        server.starttls()
        server.login(user, password)
        server.sendmail(user, [to], msg.as_string())


def _clean_code(code: str) -> str:
    code = code.strip().upper()
    if not BARCODE_CODE_RE.fullmatch(code) or not code.startswith("GIFT-"):
        raise HTTPException(status_code=404, detail=f"No gift card {code}")
    return code


async def _usable_card(request: Request, code: str) -> dict[str, Any]:
    card = await asyncio.to_thread(terminal._as_staff, request, "pelham_staff_gift_card", {"p_code": code})
    if card.get("status") != "active":
        raise HTTPException(status_code=409, detail=f"Gift card {code} was voided — nothing to send.")
    if int(card.get("balance") or 0) <= 0:
        raise HTTPException(status_code=409, detail=f"Gift card {code} has nothing left — nothing to send.")
    if card.get("expired"):
        raise HTTPException(status_code=409, detail=f"Gift card {code} has expired — nothing to send.")
    return card


@router.post("/{code}/text")
async def text_gift_card(code: str, body: TextRequest, request: Request) -> dict[str, Any]:
    code = _clean_code(code)
    phone = normalize_phone(body.phone)
    if not phone:
        raise HTTPException(status_code=422, detail="Enter a 10-digit phone number.")
    card = await _usable_card(request, code)
    if not settings.TWILIO_ENABLED:
        raise HTTPException(status_code=503, detail="Text messages are not set up on the server yet.")

    msg = await send_sms(phone, gift_card_text(card), template="gift_card",
                         booking_ref=code, media_url=barcode_url(code))
    if msg.status in ("failed", "skipped"):
        raise HTTPException(status_code=502, detail=f"The text did not go out ({msg.error or msg.status}).")
    return {"ok": True, "to": phone, "status": msg.status, "barcode": msg.media_url is not None}


@router.post("/{code}/email")
async def email_gift_card(code: str, body: EmailRequest, request: Request) -> dict[str, Any]:
    code = _clean_code(code)
    email = body.email.strip()
    if not receipts.EMAIL_RE.fullmatch(email):
        raise HTTPException(status_code=422, detail="That email address doesn't look right.")
    card = await _usable_card(request, code)
    if not receipts.email_enabled():
        raise HTTPException(status_code=503, detail="Email is not set up on the server yet.")
    try:
        await asyncio.to_thread(_send_certificate, email, card)
    except Exception as exc:
        logger.warning("상품권 메일 실패: %s (%s)", code, type(exc).__name__)
        raise HTTPException(status_code=502, detail="The email did not go out.") from exc
    return {"ok": True, "to": email}
