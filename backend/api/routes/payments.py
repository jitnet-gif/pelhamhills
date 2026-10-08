"""손님 온라인 결제(Authorize.net Accept Hosted): 견적 / 결제 폼 열기 / 결과 확인 / 취소 환불 / 웹훅.

예약 사이트(`/book/*`)는 정적 export 라 비밀 키를 들 곳이 없다. 그래서 이 라우터만 카드사 키를 들고,
예약·장부는 전부 SQL 함수(`supabase/migrations/0020_online_payments.sql`, service_role 전용)가 정한다.
여기서 하는 일은 "SQL 이 정한 금액으로 결제 폼을 열고, 결과를 Authorize.net 에 다시 물어 SQL 에 넘기는"
것뿐이다. 금액을 여기서 계산하지 않는다.

## 본인 확인
예약 조회(0012)와 같다: **확인 코드 + 예약 때 쓴 이메일**. 결과 화면(`/book/pay?invoice=`)은 invoice 만
들고 오는데, invoice 는 16진수 12자 무작위이고 돌려주는 것도 상태·금액·카드 끝 4자리뿐이다.

## 결과는 두 길로 온다
1. 웹훅 `net.authorize.payment.authcapture.created` — 손님이 결제 후 창을 닫아도 온다.
2. 결과 화면의 `/status/{invoice}` — pending 이면 Authorize.net 의 미정산 거래에서 invoice 로 찾는다.
   웹훅이 늦거나 아직 설정되지 않았어도 손님은 바로 결과를 본다.
둘 다 거래 상세를 다시 조회한 값으로 `pelham_online_pay_complete` 를 부르고, SQL 이 한 번만 기록한다.

## 되돌림
SQL 이 "기록할 수 없다"(`needs_reversal`)고 하면 — 그사이 예약이 취소됐거나, 프로 샵에서 먼저 받았거나,
가격이 바뀌었으면 — 그 거래를 곧바로 void/refund 한다. 돈만 받고 장부에 없는 상태를 남기지 않는다.
"""

from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from backend.core.config import settings
from backend.services import authorize_net as anet
from backend.services import supabase_rest

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/payments/online", tags=["Online Payments"])

DEFAULT_SITE = "https://pelhamhills.vercel.app"
UNAVAILABLE = "Online payment is not available right now. You can pay at the pro shop when you arrive."
# 결과 화면이 pending 일 때 Authorize.net 을 다시 뒤지는 기간. 그보다 오래된 시도는 버려진 것이다.
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
    아무 Origin 이나 믿으면 결제 폼의 '돌아가기' 가 남의 사이트로 갈 수 있다."""
    origin = (request.headers.get("origin") or "").rstrip("/")
    if origin and origin in settings.BACKEND_CORS_ORIGINS:
        return origin
    return (os.getenv("PUBLIC_SITE_URL", "").strip() or DEFAULT_SITE).rstrip("/")


def _split_name(full: str | None) -> tuple[str, str]:
    parts = (full or "").strip().split()
    if not parts:
        return "", ""
    return " ".join(parts[:-1]) if len(parts) > 1 else parts[0], parts[-1] if len(parts) > 1 else ""


def _settle(txn: anet.Transaction, invoice: str | None = None) -> dict[str, Any]:
    """확인한 거래 하나를 기록하고, SQL 이 되돌리라고 하면 되돌린다."""
    result = _rpc("pelham_online_pay_complete", {"p": txn.complete_args(invoice)})
    if result and result.get("needs_reversal"):
        target = str(result.get("reversal_trans_id") or txn.trans_id)
        try:
            kind, new_id = anet.reverse(target, txn.amount_cents)
        except anet.GatewayError as exc:
            # 돈은 받았는데 장부에 없다. 사람이 봐야 한다 — 로그에 남기고 손님에게는 전화 안내.
            logger.error("되돌림 실패: invoice=%s trans=%s (%s)", result.get("invoice"), target, exc.message)
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
    if not anet.configured():
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
    """결제 폼 토큰. 브라우저는 `form_url` 로 `token` 을 POST 한다(Authorize.net 결제 폼으로 이동)."""
    if not anet.configured():
        raise HTTPException(status_code=503, detail=UNAVAILABLE)
    started = _rpc("pelham_online_pay_start", {"p_code": body.code, "p_email": body.email})
    invoice = started["invoice"]
    site = _site_base(request)
    first, last = _split_name(started.get("customer_name"))
    try:
        token = anet.hosted_payment_token(
            invoice=invoice,
            amount_cents=int(started["amount"]),
            description=str(started.get("description") or "Pelham Hills booking"),
            email=started.get("email"),
            first_name=first,
            last_name=last,
            return_url=f"{site}/book/pay?invoice={quote(invoice)}",
            cancel_url=f"{site}/book/pay?invoice={quote(invoice)}&cancelled=1",
        )
    except anet.GatewayError as exc:
        logger.warning("결제 폼 토큰 실패: invoice=%s (%s)", invoice, exc.message)
        raise HTTPException(status_code=502, detail=UNAVAILABLE) from None
    return {"form_url": anet.form_url(), "token": token, "invoice": invoice, "amount": started["amount"]}


@router.get("/status/{invoice}")
def payment_status(invoice: str) -> dict[str, Any]:
    """결과 화면. pending 이면 Authorize.net 에 직접 물어 기록까지 한다."""
    invoice = invoice.strip().upper()
    if not invoice.startswith("PHW") or len(invoice) != 15:
        raise HTTPException(status_code=404, detail="Payment not found.")
    payment = _rpc("pelham_online_payment", {"p": {"invoice": invoice}})
    if not payment:
        raise HTTPException(status_code=404, detail="Payment not found.")

    if payment.get("status") == "pending" and anet.configured() and _recent(payment.get("created_at")):
        try:
            for trans_id in anet.find_unsettled(invoice):
                txn = anet.transaction_details(trans_id)
                if txn.invoice.upper() == invoice:
                    payment = _settle(txn, invoice)
                    if payment.get("status") == "approved":
                        break
        except anet.GatewayError as exc:
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
    if not anet.configured():
        raise HTTPException(status_code=503, detail=UNAVAILABLE)
    begun = _rpc("pelham_online_refund_begin", {"p_code": body.code, "p_email": body.email})
    invoice, trans_id, amount = begun["invoice"], str(begun["trans_id"]), int(begun["amount_cents"])
    try:
        kind, new_id = anet.reverse(trans_id, amount)
    except anet.GatewayError as exc:
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
        # 카드는 이미 돌려줬다. 웹훅(void/refund.created)이 refund_pending 을 보고 같은 정리를 다시 한다.
        logger.error("환불 뒤 기록 실패: invoice=%s (%s) — 웹훅이 마무리한다", invoice, type(exc).__name__)
        return {"status": "refunded" if kind == "refund" else "voided", "refund_kind": kind,
                "amount": amount, "booking_cancelled": False}
    return {**(_public(done) or {}), "booking_cancelled": True}


# ===== 웹훅 ============================================================

@router.post("/webhook")
async def authorize_net_webhook(request: Request) -> dict[str, Any]:
    """Authorize.net → 우리. 서명이 맞지 않으면 401. 처리 중 DB 가 안 닿으면 503(Authorize.net 이 다시 보낸다)."""
    raw = await request.body()
    if not anet.verify_webhook(raw, request.headers.get("x-anet-signature")):
        raise HTTPException(status_code=401, detail="Bad signature")
    try:
        event = json.loads(raw.decode("utf-8-sig"))
    except Exception:
        raise HTTPException(status_code=400, detail="Bad JSON") from None
    event_type = str(event.get("eventType") or "")
    trans_id = str((event.get("payload") or {}).get("id") or "")
    if not trans_id.isdigit():
        return {"ok": True, "ignored": "no transaction id"}

    try:
        if event_type in ("net.authorize.payment.authcapture.created", "net.authorize.payment.fraud.approved"):
            txn = anet.transaction_details(trans_id)
            if not txn.invoice.upper().startswith("PHW"):
                return {"ok": True, "ignored": "not an online booking payment"}
            result = _settle(txn)
            return {"ok": True, "status": result.get("status")}

        if event_type in ("net.authorize.payment.refund.created", "net.authorize.payment.void.created"):
            txn = anet.transaction_details(trans_id)
            if event_type.endswith("refund.created"):
                original, kind, new_id = txn.ref_trans_id, "refund", txn.trans_id
            else:
                original, kind, new_id = txn.trans_id, "void", txn.trans_id
            if not original:
                return {"ok": True, "ignored": "no original transaction"}
            payment = supabase_rest.rpc("pelham_online_payment", {"p": {"trans_id": original}})
            if not payment:
                return {"ok": True, "ignored": "not an online booking payment"}
            done = supabase_rest.rpc("pelham_online_refund_finish", {"p": {
                "trans_id": original, "refund_kind": kind, "refund_trans_id": new_id,
                # 손님 취소가 카드사까지 갔다가 기록 전에 끊긴 경우만 예약도 취소한다.
                "cancel_booking": bool(payment.get("refund_pending")),
                "reason": "Refunded in Authorize.net" if not payment.get("refund_pending") else "Guest cancelled online",
            }})
            return {"ok": True, "status": (done or {}).get("status")}
    except HTTPException as exc:
        if exc.status_code == 503:
            raise
        logger.warning("웹훅 처리 거절: %s %s (%s)", event_type, trans_id, exc.detail)
        return {"ok": True, "refused": exc.detail}
    except supabase_rest.RpcRefused as exc:
        logger.warning("웹훅 처리 거절: %s %s (%s)", event_type, trans_id, exc.message)
        return {"ok": True, "refused": exc.message}
    except supabase_rest.SupabaseUnavailable:
        raise HTTPException(status_code=503, detail="Try again later") from None
    except anet.GatewayError as exc:
        logger.warning("웹훅 거래 조회 실패: %s %s (%s)", event_type, trans_id, exc.message)
        raise HTTPException(status_code=503, detail="Try again later") from None

    return {"ok": True, "ignored": event_type}


@router.get("/config")
def payment_config() -> dict[str, Any]:
    """화면이 Pay 버튼을 보일지 정한다. 키는 내보내지 않는다."""
    return {"enabled": anet.configured(), "environment": anet.environment()}

