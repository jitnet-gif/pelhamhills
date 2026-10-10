"""손님 온라인 결제(Stripe Checkout): 견적 / 결제 페이지 열기 / 결과 확인 / 취소 환불 / 키 확인.

예약 사이트(`/book/*`)는 정적 export 라 비밀 키를 들 곳이 없다. 그래서 이 라우터만 카드사 키를 들고,
예약·장부는 전부 SQL 함수(`supabase/migrations/0020_online_payments.sql`, 0021, service_role 전용)가 정한다.
여기서 하는 일은 "SQL 이 정한 금액으로 결제 페이지를 열고, 결과를 Stripe 에 다시 물어 SQL 에 넘기는"
것뿐이다. 금액을 여기서 계산하지 않는다.

## 본인 확인
예약 조회(0012)와 같다: **확인 코드 + 예약 때 쓴 이메일**. 결과 화면(`/book/pay?invoice=`)은 invoice 만
들고 오는데, invoice 는 16진수 12자 무작위이고 돌려주는 것도 상태·금액·카드 끝 4자리뿐이다.

## 결과는 두 길로 온다
1. 웹훅 `checkout.session.completed` (`terminal.py` 의 `/payments/stripe/webhook`) — 손님이 결제 후 창을
   닫아도 온다.
2. 결과 화면의 `/status/{invoice}` — pending 이면 그 invoice 의 Checkout 세션(0021 `gateway_session`)을
   Stripe 에 직접 묻는다. 웹훅이 늦거나 아직 설정되지 않았어도 손님은 바로 결과를 본다.
둘 다 Stripe 에서 다시 읽은 PaymentIntent 로 `pelham_online_pay_complete` 를 부르고, SQL 이 한 번만 기록한다.

## 되돌림
SQL 이 "기록할 수 없다"(`needs_reversal`)고 하면 — 그사이 예약이 취소됐거나, 프로 샵에서 먼저 받았거나,
가격이 바뀌었으면 — 그 결제를 곧바로 환불한다. 돈만 받고 장부에 없는 상태를 남기지 않는다.
"""

from __future__ import annotations

import logging
import os
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from backend.core.config import settings
from backend.services import stripe_gateway as sg
from backend.services import supabase_rest

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/payments/online", tags=["Online Payments"])

DEFAULT_SITE = "https://pelhamhills.vercel.app"
UNAVAILABLE = "Online payment is not available right now. You can pay at the pro shop when you arrive."
# 결과 화면이 pending 일 때 Stripe 에 다시 묻는 기간. 그보다 오래된 시도는 버려진 것이다(세션은 31분이면 끝난다).
RECONCILE_WINDOW = timedelta(hours=3)


class GuestCredentials(BaseModel):
    code: str = Field(min_length=1, max_length=40)
    email: str = Field(min_length=3, max_length=254)


# ===== 공통 ============================================================

def _rpc(function: str, args: dict[str, Any]) -> Any:
    """SQL 거절은 그 상태·문장 그대로, 연결 실패는 503."""
    try:
        return supabase_rest.rpc(function, args)
    except supabase_rest.RpcRefused as exc:
        raise HTTPException(status_code=exc.status, detail=exc.message) from None
    except supabase_rest.SupabaseUnavailable:
        raise HTTPException(status_code=503, detail=UNAVAILABLE) from None


def _site_base(request: Request) -> str:
    """결제 뒤 돌아올 사이트. 부른 페이지의 출처가 CORS 허용 목록에 있으면 그곳, 아니면 기본 사이트.
    아무 Origin 이나 믿으면 결제 페이지의 '돌아가기' 가 남의 사이트로 갈 수 있다."""
    origin = (request.headers.get("origin") or "").rstrip("/")
    if origin and origin in settings.BACKEND_CORS_ORIGINS:
        return origin
    return (os.getenv("PUBLIC_SITE_URL", "").strip() or DEFAULT_SITE).rstrip("/")


def settle(payment: sg.Payment, invoice: str | None = None) -> dict[str, Any]:
    """확인한 결제 하나를 기록하고, SQL 이 되돌리라고 하면 되돌린다. 웹훅도 이것을 쓴다."""
    result = _rpc("pelham_online_pay_complete", {"p": payment.complete_args(invoice)})
    if result and result.get("needs_reversal"):
        target = str(result.get("reversal_trans_id") or payment.trans_id)
        try:
            kind, new_id = sg.refund(target, metadata={"invoice": result.get("invoice") or ""},
                                     idempotency_key=f"reverse-{target}")
        except sg.StripeError as exc:
            # 돈은 받았는데 장부에 없다. 사람이 봐야 한다 — 로그에 남기고 손님에게는 전화 안내.
            logger.error("되돌림 실패: invoice=%s pi=%s (%s)", result.get("invoice"), target, exc.message)
            return {**result, "reversal_failed": True}
        finished = _rpc("pelham_online_refund_finish", {"p": {
            "trans_id": target, "refund_kind": kind, "refund_trans_id": new_id,
            "reason": "Reversed automatically: the payment could not be applied to the booking.",
        }}) if target == result.get("trans_id") else None
        return {**(finished or result), "reversed": kind}
    return result


def _public(payment: dict[str, Any] | None) -> dict[str, Any] | None:
    """결과 화면에 내보내는 칸만."""
    if not payment:
        return None
    keys = ("invoice", "kind", "confirmation_code", "description", "subtotal", "tax", "amount", "status",
            "card_brand", "card_last4", "receipt_no", "refund_kind", "refund_pending", "approved_at",
            "refunded_at", "reversed", "reversal_failed")
    return {k: payment.get(k) for k in keys if k in payment}


# ===== 손님 ============================================================

@router.post("/quote")
def quote_payment(body: GuestCredentials) -> dict[str, Any]:
    """낼 수 있는가, 얼마인가, 이미 낸 결제, 온라인 취소 환불이 되는가."""
    if not sg.configured():
        return {"enabled": False}
    result = _rpc("pelham_online_pay_quote", {"p_code": body.code, "p_email": body.email})
    payment = result.get("payment") or None
    return {
        "enabled": True,
        "kind": result.get("kind"),
        "confirmation_code": result.get("confirmation_code"),
        "description": result.get("description"),
        "payable": bool(result.get("payable")),
        "reason": result.get("reason"),
        "lines": result.get("lines") or [],
        "subtotal": result.get("subtotal"),
        "tax": result.get("tax"),
        "total": result.get("total"),
        "payment": _public(payment),
        "cancel_refund": result.get("cancel_refund"),
    }


@router.post("/checkout")
def start_checkout(body: GuestCredentials, request: Request) -> dict[str, Any]:
    """Stripe Checkout 세션을 열고 그 주소를 준다. 브라우저는 `url` 로 넘어간다."""
    if not sg.configured():
        raise HTTPException(status_code=503, detail=UNAVAILABLE)
    started = _rpc("pelham_online_pay_start", {"p_code": body.code, "p_email": body.email})
    invoice = started["invoice"]
    site = _site_base(request)
    back = f"{site}/book/pay?invoice={quote(invoice)}"
    try:
        session_id, url = sg.create_checkout(
            invoice=invoice,
            amount_cents=int(started["amount"]),
            description=str(started.get("description") or "Pelham Hills booking"),
            email=started.get("email"),
            success_url=back,
            cancel_url=f"{back}&cancelled=1",
        )
    except sg.StripeError as exc:
        logger.warning("Checkout 세션 실패: invoice=%s (%s)", invoice, exc.message)
        raise HTTPException(status_code=502, detail=UNAVAILABLE) from None
    if not url:
        raise HTTPException(status_code=502, detail=UNAVAILABLE)
    _rpc("pelham_online_pay_session", {"p_invoice": invoice, "p_session": session_id})
    return {"url": url, "invoice": invoice, "amount": started["amount"]}


@router.get("/status/{invoice}")
def payment_status(invoice: str) -> dict[str, Any]:
    """결과 화면. pending 이면 Stripe 에 직접 물어 기록까지 한다."""
    invoice = invoice.strip().upper()
    if not invoice.startswith("PHW") or len(invoice) != 15:
        raise HTTPException(status_code=404, detail="Payment not found.")
    payment = _rpc("pelham_online_payment", {"p": {"invoice": invoice}})
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
            # 확인을 못 했을 뿐이다. 화면은 "확인 중" 으로 다시 묻는다.
            logger.info("상태 확인 실패: invoice=%s (%s)", invoice, exc.message)
    return _public(payment) or {}


def _recent(iso: str | None) -> bool:
    try:
        created = datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
    except Exception:
        return False
    return datetime.now(timezone.utc) - created < RECONCILE_WINDOW


@router.post("/cancel")
def cancel_and_refund(body: GuestCredentials) -> dict[str, Any]:
    """온라인으로 낸 예약을 취소하고 카드에 돌려준다(마감 전). 카드사가 실패하면 예약은 그대로 둔다."""
    if not sg.configured():
        raise HTTPException(status_code=503, detail=UNAVAILABLE)
    begun = _rpc("pelham_online_refund_begin", {"p_code": body.code, "p_email": body.email})
    invoice, trans_id = begun["invoice"], str(begun["trans_id"])
    try:
        kind, new_id = sg.refund(trans_id, metadata={"invoice": invoice}, idempotency_key=f"cancel-{invoice}")
    except sg.StripeError as exc:
        logger.warning("취소 환불 실패: invoice=%s (%s)", invoice, exc.message)
        try:
            supabase_rest.rpc("pelham_online_refund_abort", {"p_invoice": invoice, "p_message": exc.message})
        except Exception:
            pass
        raise HTTPException(
            status_code=502,
            detail=("We could not refund your card automatically, so your booking is still active. "
                    f"Please call the pro shop at {settings.PROSHOP_PHONE_NUMBER}."),
        ) from None
    try:
        done = supabase_rest.rpc("pelham_online_refund_finish", {"p": {
            "invoice": invoice, "refund_kind": kind, "refund_trans_id": new_id,
            "cancel_booking": True, "reason": "Guest cancelled online",
        }})
    except Exception as exc:
        # 카드는 이미 돌려줬다. 웹훅(charge.refunded)이 refund_pending 을 보고 같은 정리를 다시 한다.
        logger.error("환불 뒤 기록 실패: invoice=%s (%s) — 웹훅이 마무리한다", invoice, type(exc).__name__)
        return {"status": "refunded" if kind == "refund" else "voided", "refund_kind": kind,
                "amount": begun.get("amount_cents"), "booking_cancelled": False}
    return {**(_public(done) or {}), "booking_cancelled": True}


# ===== 키 확인 =========================================================

# 키 확인 결과를 잠깐 기억한다. 화면마다 Stripe 를 두드리지 않게.
_CREDENTIAL_TTL = timedelta(minutes=10)
_credential_check: dict[str, Any] = {"at": None, "result": None, "env": None}


def credentials_status() -> str:
    """"ok" · "rejected"(키가 틀림) · "unreachable"(Stripe 가 안 닿음) · "missing"(키 없음)."""
    if not sg.configured():
        return "missing"
    now = datetime.now(timezone.utc)
    cached = _credential_check
    if cached["at"] and cached["env"] == sg.environment() and now - cached["at"] < _CREDENTIAL_TTL:
        return cached["result"]
    try:
        sg.check_key()
        result = "ok"
    except sg.StripeError as exc:
        result = "rejected" if exc.status in (401, 403) else "unreachable"
        logger.warning("Stripe 키 확인 실패: HTTP %s %s", exc.status, exc.message)
    cached.update(at=now, result=result, env=sg.environment())
    return result


@router.get("/config")
def payment_config() -> dict[str, Any]:
    """결제가 켜져 있는가(키가 있다), 키가 Stripe 에서 통하는가, 웹훅 서명 키가 있는가. 키 값은 내보내지 않는다.
    `credentials` 는 배포 확인용이다 — 키를 넣고 이 주소를 열면 바로 맞는지 안다."""
    return {
        "enabled": sg.configured(),
        "environment": sg.environment(),
        "credentials": credentials_status(),
        "webhook": bool((os.getenv("STRIPE_WEBHOOK_SECRET") or "").strip()),
    }
