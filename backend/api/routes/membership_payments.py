"""회원권 신용카드 온라인 결제(Stripe Checkout): 결제 페이지 열기 / 결과 확인.

신청서(`/memberships/application`, SQL 0041·0042)에서 Credit card 를 고른 손님이 제출 직후 이 경로로 결제
페이지를 연다. 티타임 결제(`payments.py`)와 같은 규칙이다:

- 금액은 SQL(`pelham_membership_pay_start`)이 회원권의 남은 금액으로 정한다. 여기서 계산하지 않는다.
- 결과는 두 길로 온다. 웹훅(`terminal.py` 의 `/payments/stripe/webhook`, invoice 가 `PHM` 이면 여기의
  `settle`)과 결과 화면의 `/status/{invoice}`. 둘 다 Stripe 에서 다시 읽은 결제로 SQL 에 넘기고, SQL 이 한 번만
  기록한다.
- SQL 이 기록할 수 없다고 하면(`needs_reversal` — 취소된 회원권, 이미 완납, 금액 불일치) 곧바로 환불한다.

## 본인 확인
신청 때 받은 열쇠(`pay_key`, 무작위 uuid) + 신청 이메일. 결과 화면은 invoice(무작위 12자)만 들고 오고,
돌려주는 것은 상태·금액·카드 끝 4자리·회원권 이름뿐이다.
"""

from __future__ import annotations

import logging
from typing import Any
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from backend.api.routes.payments import UNAVAILABLE, _recent, _rpc, _site_base
from backend.services import stripe_gateway as sg

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/payments/membership", tags=["Online Payments"])

INVOICE_PREFIX = "PHM"


class MembershipCredentials(BaseModel):
    key: str = Field(min_length=36, max_length=36)
    email: str = Field(min_length=3, max_length=254)


def settle(payment: sg.Payment, invoice: str | None = None) -> dict[str, Any]:
    """확인한 결제 하나를 기록하고, SQL 이 되돌리라고 하면 되돌린다. 웹훅도 이것을 쓴다."""
    result = _rpc("pelham_membership_pay_complete", {"p": payment.complete_args(invoice)})
    if result and result.get("needs_reversal"):
        target = str(result.get("reversal_trans_id") or payment.trans_id)
        try:
            kind, new_id = sg.refund(target, metadata={"invoice": result.get("invoice") or ""},
                                     idempotency_key=f"reverse-{target}")
        except sg.StripeError as exc:
            logger.error("회원권 되돌림 실패: invoice=%s pi=%s (%s)", result.get("invoice"), target, exc.message)
            return {**result, "reversal_failed": True}
        finished = _rpc("pelham_membership_refund_finish", {"p_trans": target, "p_refund": new_id})
        return {**(finished or result), "reversed": kind}
    return result


def _public(payment: dict[str, Any] | None) -> dict[str, Any] | None:
    if not payment:
        return None
    keys = ("invoice", "amount", "status", "card_brand", "card_last4", "approved_at", "refunded_at", "reference",
            "member_name", "season", "membership_type", "plan", "membership_status", "balance", "reversed",
            "reversal_failed")
    return {k: payment.get(k) for k in keys if k in payment}


@router.post("/checkout")
def start_checkout(body: MembershipCredentials, request: Request) -> dict[str, Any]:
    """Stripe Checkout 세션을 열고 그 주소를 준다. 브라우저는 `url` 로 넘어간다."""
    if not sg.configured():
        raise HTTPException(status_code=503, detail=UNAVAILABLE)
    started = _rpc("pelham_membership_pay_start", {"p_key": body.key, "p_email": body.email})
    invoice = started["invoice"]
    back = f"{_site_base(request)}/memberships/application/paid?invoice={quote(invoice)}"
    try:
        session_id, url = sg.create_checkout(
            invoice=invoice,
            amount_cents=int(started["amount"]),
            description=str(started.get("description") or "Pelham Hills membership"),
            email=started.get("email"),
            success_url=back,
            cancel_url=f"{back}&cancelled=1",
        )
    except sg.StripeError as exc:
        logger.warning("회원권 Checkout 세션 실패: invoice=%s (%s)", invoice, exc.message)
        raise HTTPException(status_code=502, detail=UNAVAILABLE) from None
    if not url:
        raise HTTPException(status_code=502, detail=UNAVAILABLE)
    _rpc("pelham_membership_pay_session", {"p_invoice": invoice, "p_session": session_id})
    return {"url": url, "invoice": invoice, "amount": started["amount"]}


@router.get("/status/{invoice}")
def payment_status(invoice: str) -> dict[str, Any]:
    """결과 화면. pending 이면 Stripe 에 직접 물어 기록까지 한다."""
    invoice = invoice.strip().upper()
    if not invoice.startswith(INVOICE_PREFIX) or len(invoice) != 15:
        raise HTTPException(status_code=404, detail="Payment not found.")
    payment = _rpc("pelham_membership_payment", {"p": {"invoice": invoice}})
    if not payment:
        raise HTTPException(status_code=404, detail="Payment not found.")

    session_id = str(payment.get("gateway_session") or "")
    if (payment.get("status") == "pending" and session_id and sg.configured()
            and _recent(payment.get("created_at"))):
        try:
            session_invoice, paid = sg.checkout_payment(session_id)
            if paid and session_invoice.upper() == invoice:
                payment = settle(paid, invoice)
        except sg.StripeError as exc:
            logger.info("회원권 상태 확인 실패: invoice=%s (%s)", invoice, exc.message)
    return _public(payment) or {}
