"""온라인 결제 승인 → 손님 이메일 영수증.

온라인 결제(티타임·시뮬레이터·회원권)는 직원이 결제 끝 화면에서 영수증을 보내 줄 수 없다. 승인 문자(`payment_texts`)처럼
1분마다 막 승인된 결제를 묻고(`supabase/migrations/0141_payment_emails.sql`) 영수증과 같은 Gmail 로 보낸다.

- 티타임·시뮬레이터는 계산서가 있어서 계산대 영수증 메일을 그대로 쓴다(`receipts._send_email`).
- 회원권 결제는 계산서가 없고 세금을 나눠 적지 않으므로 받은 금액만 적은 짧은 영수증을 만든다.
- 한 결제에 한 통: SQL 이 보내기 **전에** 줄을 집는다. 실패해도 다시 가지 않는다.
- SMTP 키가 없으면 집지 않는다. 집어 두면 키를 넣은 뒤에도 가지 않는다.
"""

from __future__ import annotations

import asyncio
import html
import logging
from typing import Any

from backend.api.routes import receipts
from backend.core.config import settings
from backend.services import supabase_rest

logger = logging.getLogger(__name__)

#: 다시 훑는 간격(초). `booking_emails` 와 같다.
SWEEP_SECONDS = 60

_lock = asyncio.Lock()


def _membership_details(row: dict[str, Any]) -> list[tuple[str, str]]:
    kind = str(row.get("membership_type") or "").replace("_", " ").title()
    plan = str(row.get("plan") or "").title()
    out = [
        ("Member", str(row.get("member_name") or "")),
        ("Membership", " · ".join(filter(None, [str(row.get("season") or ""), kind, plan]))),
        ("Reference", str(row.get("reference") or "")),
        ("Paid", f"{receipts._money(row.get('amount'))} on {receipts._payment_label({'method': 'card', **row})}"),
    ]
    balance = float(row.get("balance") or 0)
    if balance > 0:
        out.append(("Balance owing", f"${balance:,.2f}"))
    return out


def membership_text(row: dict[str, Any]) -> str:
    out = [receipts.CLUB_NAME, *receipts.CLUB_ADDRESS, "", "Membership payment receipt",
           receipts._when({"paid_at": row.get("approved_at")}), ""]
    out += [f"{label}: {value}" for label, value in _membership_details(row)]
    out += ["", "Thank you!", f"Questions? Call {settings.PROSHOP_PHONE_NUMBER}."]
    return "\n".join(out) + "\n"


def membership_html(row: dict[str, Any]) -> str:
    """영수증 메일과 같은 꼴. 이름은 손님이 친 값이라 이스케이프한다."""
    esc = html.escape
    rows = "".join(
        f'<tr><td style="padding:4px 0;color:#6b7280">{esc(label)}</td>'
        f'<td style="padding:4px 0;text-align:right;font-weight:bold">{esc(value)}</td></tr>'
        for label, value in _membership_details(row))
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
<div style="font-size:16px;font-weight:bold;padding-top:16px">Membership payment receipt</div>
<div style="color:#6b7280;font-size:12px">{when}</div>
</td></tr>
{rows}
<tr><td colspan="2" style="text-align:center;padding-top:20px;color:#6b7280;font-size:12px">
Thank you! Questions? Call {esc(settings.PROSHOP_PHONE_NUMBER)}.</td></tr>
</table>
</td></tr></table>
</body></html>"""


def _send(row: dict[str, Any]) -> None:
    to = str(row["email"])
    if row.get("kind") == "membership":
        receipts.send_mail(to, f"Your Pelham Hills membership receipt {row.get('reference') or ''}".strip(),
                           membership_text(row), membership_html(row))
    else:
        receipts._send_email(to, row["bill"])


def _claim() -> list[dict[str, Any]]:
    return supabase_rest.rpc("pelham_payment_emails_claim", {"p_limit": 20}) or []


def _record(email_id: int, status: str, error: str | None) -> None:
    supabase_rest.rpc("pelham_payment_email_result", {"p_id": email_id, "p_status": status, "p_error": error})


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
            logger.error("결제 영수증 메일 패스 실패: %s", exc)
            return
        for row in outbox:
            status, error = "sent", None
            try:
                if not receipts.EMAIL_RE.fullmatch(str(row.get("email") or "")):
                    raise ValueError("bad address")
                await run_in_threadpool(_send, row)
            except Exception as exc:
                logger.warning("결제 영수증 메일 실패: %s (%s)", row.get("id"), type(exc).__name__)
                status, error = "failed", f"{type(exc).__name__}: {exc}"[:300]
            try:
                await run_in_threadpool(_record, int(row["id"]), status, error)
            except Exception as exc:
                logger.warning("결제 영수증 메일 결과를 적지 못함 (%s): %s", status, exc)


async def loop() -> None:
    """`main` 이 시작할 때 띄운다. 1분마다 한 패스."""
    while True:
        await asyncio.sleep(SWEEP_SECONDS)
        await run()
