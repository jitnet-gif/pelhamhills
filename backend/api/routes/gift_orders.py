"""기프트카드 온라인 판매(Stripe Checkout): 결제 페이지 열기 / 결과 확인.

웹사이트 `/gift-cards` 의 손님이 금액·연락처를 넣으면 이 경로로 결제 페이지를 연다. 회원권 결제
(`membership_payments.py`)와 같은 규칙이다:

- 주문과 금액 검사는 SQL(`pelham_gift_order_start`, 0144)이 한다. 여기서 계산하지 않는다.
- 결과는 두 길로 온다. 웹훅(`terminal.py` 의 `/payments/stripe/webhook`, invoice 가 `PHG` 면 여기의 `settle`)과
  결과 화면의 `/status/{invoice}`. 둘 다 Stripe 에서 다시 읽은 결제로 SQL 에 넘기고, SQL 이 카드를 한 장만 만든다.
- SQL 이 기록할 수 없다고 하면(`needs_reversal` — 금액 불일치, 두 번 결제) 곧바로 환불한다.
- 승인되면 `gift_card_delivery` 를 깨운다. 문자·메일은 그쪽이 보낸다.

## 본인 확인
결과 화면은 invoice(무작위 12자)만 들고 온다. Stripe 가 돌려보낸 사람만 아는 값이라 카드 코드를 돌려준다 —
문자·메일이 늦거나 번호를 잘못 넣어도 손님이 바코드를 받는다.
"""

from __future__ import annotations

import logging
from typing import Any
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from backend.api.routes.payments import UNAVAILABLE, _recent, _rpc, _site_base
from backend.services import gift_card_delivery
from backend.services import stripe_gateway as sg

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/payments/gift-card", tags=["Online Payments"])

INVOICE_PREFIX = "PHG"


class GiftOrder(BaseModel):
    amount: int
    buyer_name: str = Field(max_length=120)
    buyer_email: str = Field(max_length=254)
    buyer_phone: str = Field(max_length=40)
    recipient: str = Field(default="", max_length=120)
    recipient_email: str = Field(default="", max_length=254)
    recipient_phone: str = Field(default="", max_length=40)


def settle(payment: sg.Payment, invoice: str | None = None) -> dict[str, Any]:
    """확인한 결제 하나를 기록하고, SQL 이 되돌리라고 하면 되돌린다. 웹훅도 이것을 쓴다."""
    result = _rpc("pelham_gift_order_complete", {"p": payment.complete_args(invoice)})
    if result and result.get("needs_reversal"):
        target = str(result.get("reversal_trans_id") or payment.trans_id)
        try:
            kind, new_id = sg.refund(target, metadata={"invoice": result.get("invoice") or ""},
                                     idempotency_key=f"reverse-{target}")
        except sg.StripeError as exc:
            logger.error("기프트카드 되돌림 실패: invoice=%s pi=%s (%s)", result.get("invoice"), target, exc.message)
            return {**result, "reversal_failed": True}
        # 두 번째 결제를 돌려줬으면 첫 주문은 approved 그대로다. orphaned 일 때만 주문이 환불로 닫힌다.
        finished = _rpc("pelham_gift_order_refund_finish", {"p_trans": target, "p_refund": new_id}) \
            if target == result.get("trans_id") else None
        return {**(finished or result), "reversed": kind}
    if result and result.get("status") == "approved":
        gift_card_delivery.kick()
    return result


def _public(order: dict[str, Any] | None) -> dict[str, Any] | None:
    if not order:
        return None
    keys = ("invoice", "amount", "status", "card_brand", "card_last4", "approved_at", "refunded_at",
            "recipient", "code", "reversed", "reversal_failed")
    return {k: order.get(k) for k in keys if k in order}


@router.post("/checkout")
def start_checkout(body: GiftOrder, request: Request) -> dict[str, Any]:
    """주문을 만들고 Stripe Checkout 세션을 열어 그 주소를 준다. 브라우저는 `url` 로 넘어간다."""
    if not sg.configured():
        raise HTTPException(status_code=503, detail=UNAVAILABLE)
    started = _rpc("pelham_gift_order_start", {"p": body.model_dump()})
    invoice = started["invoice"]
    back = f"{_site_base(request)}/gift-cards/paid?invoice={quote(invoice)}"
    try:
        session_id, url = sg.create_checkout(
            invoice=invoice,
            amount_cents=int(started["amount"]),
            description=str(started.get("description") or "Pelham Hills gift card"),
            email=started.get("email"),
            success_url=back,
            cancel_url=f"{back}&cancelled=1",
        )
    except sg.StripeError as exc:
        logger.warning("기프트카드 Checkout 세션 실패: invoice=%s (%s)", invoice, exc.message)
        raise HTTPException(status_code=502, detail=UNAVAILABLE) from None
    if not url:
        raise HTTPException(status_code=502, detail=UNAVAILABLE)
    _rpc("pelham_gift_order_session", {"p_invoice": invoice, "p_session": session_id})
    return {"url": url, "invoice": invoice, "amount": started["amount"]}


@router.get("/status/{invoice}")
def order_status(invoice: str) -> dict[str, Any]:
    """결과 화면. pending 이면 Stripe 에 직접 물어 기록까지 한다."""
    invoice = invoice.strip().upper()
    if not invoice.startswith(INVOICE_PREFIX) or len(invoice) != 15:
        raise HTTPException(status_code=404, detail="Order not found.")
    order = _rpc("pelham_gift_order", {"p": {"invoice": invoice}})
    if not order:
        raise HTTPException(status_code=404, detail="Order not found.")

    session_id = str(order.get("gateway_session") or "")
    if (order.get("status") == "pending" and session_id and sg.configured()
            and _recent(order.get("created_at"))):
        try:
            session_invoice, paid = sg.checkout_payment(session_id)
            if paid and session_invoice.upper() == invoice:
                order = settle(paid, invoice)
        except sg.StripeError as exc:
            logger.info("기프트카드 상태 확인 실패: invoice=%s (%s)", invoice, exc.message)
    return _public(order) or {}
