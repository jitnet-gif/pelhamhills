"""계산대 카드 단말기(Stripe Terminal, 서버 주도)와 Stripe 웹훅.

## 왜 서버가 단말기와 말하는가
Stripe 의 스마트 리더(S700 등)는 인터넷으로 Stripe 에 붙어 있고, 우리는 Stripe API 로 "이 PaymentIntent 를
받아라"(`process_payment_intent`)를 보낸다. 계산대 브라우저는 리더에 직접 닿지 않는다 — 매장 LAN·인증서
설정이 필요 없고, 비밀 키는 이 서버에만 있다.

## 순서 (돈을 잃지 않게)
1. `pelham_staff_terminal_begin` 을 **직원의 토큰으로** 부른다 — 직원 확인과 pending 한 줄(0021).
2. PaymentIntent 를 만들고(멱등 키 = 그 줄 id) 줄에 적은 뒤 리더로 보낸다.
3. 화면이 `/terminal/txn/{id}` 를 몇 초마다 묻는다. 그때마다 PaymentIntent·리더 상태를 **Stripe 에 다시 물어**
   결과가 나왔으면 `pelham_terminal_settle`(service_role)로 한 번만 기록한다. 웹훅도 같은 일을 한다 —
   화면이 닫혀도 결과가 남는다. 화면을 다시 열면 `/terminal/bill/{id}/sync` 가 남은 것을 마무리한다.
4. 결제 줄 삭제·환불: 신용카드는 API 환불(카드 필요 없음), Interac 은 리더에서 카드를 다시 댄다.

## 직원 확인
요청의 `Authorization: Bearer <Supabase 액세스 토큰>` 을 그대로 SQL 에 넘긴다(`supabase_rest.rpc_as`).
`pelham_staff_*` 가 직원인지 본다. 이 서버는 토큰을 해석하지 않는다.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from backend.api.routes import payments as online
from backend.services import stripe_gateway as sg
from backend.services import supabase_rest

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/payments", tags=["Card Terminal"])

UNAVAILABLE = "The card terminal service is not available right now. Enter the approval code by hand."
# PaymentIntent 를 적지 못한 채 이만큼 지나면 리더로 가지 않은 것으로 본다(초).
NOT_SENT_AFTER = 60
# 리더가 우리 거래를 더 이상 들고 있지 않은데 결과도 없으면, 이만큼 지난 뒤 취소된 것으로 본다(초).
VANISHED_AFTER = 20


# ===== 공통 ============================================================

def _token(request: Request) -> str:
    header = request.headers.get("authorization") or ""
    return header[7:].strip() if header.lower().startswith("bearer ") else ""


def _as_staff(request: Request, function: str, args: dict[str, Any]) -> Any:
    try:
        return supabase_rest.rpc_as(_token(request), function, args)
    except supabase_rest.RpcRefused as exc:
        raise HTTPException(status_code=exc.status, detail=exc.message) from None
    except supabase_rest.SupabaseUnavailable:
        raise HTTPException(status_code=503, detail=UNAVAILABLE) from None


def _service(function: str, args: dict[str, Any]) -> Any:
    try:
        return supabase_rest.rpc(function, args)
    except supabase_rest.RpcRefused as exc:
        raise HTTPException(status_code=exc.status, detail=exc.message) from None
    except supabase_rest.SupabaseUnavailable:
        raise HTTPException(status_code=503, detail=UNAVAILABLE) from None


def _require_stripe() -> None:
    if not sg.configured():
        raise HTTPException(status_code=503, detail="Stripe is not set up on the server yet.")


def _require_staff(request: Request) -> None:
    """직원인가. 줄이 없는 계산서(-1)의 진행 중 목록을 물어 SQL 의 직원 확인만 탄다."""
    _as_staff(request, "pelham_staff_terminal_in_flight", {"p_bill": -1})


def _age_seconds(row: dict[str, Any]) -> float:
    try:
        created = datetime.fromisoformat(str(row.get("created_at")).replace("Z", "+00:00"))
    except Exception:
        return 0.0
    return (datetime.now(timezone.utc) - created).total_seconds()


def _final(row: dict[str, Any], *, approved: bool, result: str, message: str = "", code: str = "",
           **fields: Any) -> dict[str, Any]:
    return _service("pelham_terminal_settle", {"p": {
        "id": row["id"], "final": True, "approved": approved, "result": result,
        "host_message": message[:200] or None, "response_code": code[:10] or None, **fields,
    }})


def _final_from_payment(row: dict[str, Any], p: sg.Payment) -> dict[str, Any]:
    note = ""
    if p.amount_cents - p.tip_cents != int(row.get("requested_amount") or 0):
        note = f"Reader charged {p.amount_cents} incl. tip {p.tip_cents}; asked {row.get('requested_amount')}."
    return _final(
        row, approved=True, result="succeeded", message=note,
        payment_intent=p.trans_id,
        auth_code=p.auth_code or p.charge_id or p.trans_id,
        transaction_id=p.charge_id or p.trans_id,
        card_brand=p.card_brand, card_last4=p.card_last4, card_type=p.card_type, entry_mode=p.entry_mode,
        tip=p.tip_cents, total_amount=p.amount_cents,
    )


def _reader_action(reader_id: str | None) -> dict[str, Any]:
    if not reader_id:
        return {}
    return sg.reader(reader_id).get("action") or {}


def _try_cancel_intent(pi: str) -> bool:
    """취소됐으면 True. 이미 승인돼서 취소가 안 되면 False."""
    try:
        sg.cancel_intent(pi)
        return True
    except sg.StripeError as exc:
        logger.info("PaymentIntent 취소 안 됨: %s (%s)", pi, exc.message)
        return False


# ===== 결과 확인 =======================================================

def refresh(row: dict[str, Any]) -> dict[str, Any]:
    """pending 이면 Stripe 에 물어 결과가 나왔는지 본다. 나왔으면 기록한 줄, 아니면 그대로."""
    if not row or not row.get("pending"):
        return row
    if row.get("kind") == "sale":
        return _refresh_sale(row)
    return _refresh_refund(row)


def _refresh_sale(row: dict[str, Any]) -> dict[str, Any]:
    pi = row.get("payment_intent")
    if not pi:
        if _age_seconds(row) > NOT_SENT_AFTER:
            return _final(row, approved=False, result="failed", message="It never reached the reader. Try again.")
        return row
    p = sg.payment_intent(pi)
    if p.status == "succeeded":
        return _final_from_payment(row, p)
    if p.status == "canceled":
        return _final(row, approved=False, result="canceled", message="Cancelled.")
    action = _reader_action(row.get("reader_id"))
    mine = (action.get("type") == "process_payment_intent"
            and (action.get("process_payment_intent") or {}).get("payment_intent") == pi)
    if mine and action.get("status") == "in_progress":
        return row
    if mine and action.get("status") == "succeeded":
        # 리더는 끝났다고 하는데 위에서 읽은 PaymentIntent 가 한발 늦었다. 다시 읽는다.
        p = sg.payment_intent(pi)
        return _final_from_payment(row, p) if p.status == "succeeded" else row
    if mine and action.get("status") == "failed":
        message = str(action.get("failure_message") or p.response_text or "Declined.")
        if _try_cancel_intent(pi):
            return _final(row, approved=False, result="failed", message=message,
                          code=str(action.get("failure_code") or ""))
        p = sg.payment_intent(pi)
        return _final_from_payment(row, p) if p.status == "succeeded" else row
    # 리더가 우리 거래를 들고 있지 않다(손님이 취소했거나, 시간이 지났거나, 다른 계산대가 리더를 썼다).
    if _age_seconds(row) > VANISHED_AFTER:
        if _try_cancel_intent(pi):
            return _final(row, approved=False, result="canceled",
                          message=str(p.response_text if p.response_code == "2" else "Cancelled on the reader."))
        p = sg.payment_intent(pi)
        return _final_from_payment(row, p) if p.status == "succeeded" else row
    return row


def _refund_found(row: dict[str, Any]) -> dict[str, Any] | None:
    for refund in sg.refunds_for(str(row["payment_intent"])):
        if str((refund.get("metadata") or {}).get("terminal_txn") or "") != str(row["id"]):
            continue
        status = refund.get("status")
        if status in ("succeeded", "pending"):
            return refund
        if status in ("failed", "canceled"):
            return {"failed": True, **refund}
    return None


def _refresh_refund(row: dict[str, Any]) -> dict[str, Any]:
    found = _refund_found(row)
    if found and not found.get("failed"):
        return _final(row, approved=True, result="succeeded", transaction_id=str(found.get("id") or ""),
                      total_amount=int(found.get("amount") or row.get("requested_amount") or 0))
    if found:
        return _final(row, approved=False, result="failed", message="The refund failed at the card network.")
    if not row.get("reader_id"):
        # API 환불을 보내고 기록하기 전에 끊겼다. 같은 멱등 키로 다시 보내면 같은 환불이 온다.
        return _api_refund(row)
    action = _reader_action(row.get("reader_id"))
    mine = action.get("type") == "refund_payment" and (
        (action.get("refund_payment") or {}).get("payment_intent") == row["payment_intent"])
    if mine and action.get("status") == "failed":
        return _final(row, approved=False, result="failed",
                      message=str(action.get("failure_message") or "The refund did not go through."),
                      code=str(action.get("failure_code") or ""))
    if mine and action.get("status") == "in_progress":
        return row
    if not mine and _age_seconds(row) > VANISHED_AFTER:
        return _final(row, approved=False, result="canceled", message="Cancelled on the reader.")
    return row


def _api_refund(row: dict[str, Any]) -> dict[str, Any]:
    try:
        _, refund_id = sg.refund(str(row["payment_intent"]), int(row["requested_amount"]),
                                 metadata={"terminal_txn": str(row["id"])},
                                 idempotency_key=f"terminal-refund-{row['id']}")
    except sg.StripeError as exc:
        return _final(row, approved=False, result="failed", message=exc.message, code=exc.code)
    return _final(row, approved=True, result="succeeded", transaction_id=refund_id,
                  total_amount=int(row["requested_amount"]))


def _safe_refresh(row: dict[str, Any]) -> dict[str, Any]:
    try:
        return refresh(row)
    except sg.StripeError as exc:
        # 확인을 못 했을 뿐이다. 화면은 다시 묻는다.
        logger.info("단말기 거래 확인 실패: id=%s (%s)", row.get("id"), exc.message)
        return row


# ===== 계산대 ==========================================================

class SaleBody(BaseModel):
    bill_id: int
    amount: int = Field(gt=0)
    reader_id: str = Field(min_length=4, max_length=64)


class RefundBody(BaseModel):
    bill_id: int
    refund_of: int
    amount: Optional[int] = Field(default=None, gt=0)
    reader_id: Optional[str] = Field(default=None, max_length=64)


class SimulateBody(BaseModel):
    interac: bool = False
    card_number: Optional[str] = Field(default=None, max_length=19)


class RegisterBody(BaseModel):
    registration_code: str = Field(min_length=3, max_length=60)
    label: str = Field(default="Pro shop", max_length=60)


@router.get("/terminal/config")
def terminal_config() -> dict[str, Any]:
    """계산대 화면이 연동 칸을 보일지 정한다. 키 값은 내보내지 않는다."""
    return {"enabled": sg.configured(), "environment": sg.environment()}


@router.get("/terminal/readers")
def readers(request: Request) -> dict[str, Any]:
    """등록된 리더 목록(계산대 설정 화면의 고르기)."""
    _require_stripe()
    _require_staff(request)
    try:
        found = sg.list_readers()
    except sg.StripeError as exc:
        raise HTTPException(status_code=502, detail=exc.message) from None
    return {
        "environment": sg.environment(),
        "readers": [{
            "id": r.get("id"),
            "label": r.get("label") or r.get("serial_number") or r.get("id"),
            "device_type": r.get("device_type"),
            "status": r.get("status"),
            "simulated": str(r.get("device_type") or "").startswith("simulated"),
        } for r in found],
    }


@router.post("/terminal/readers")
def register(body: RegisterBody, request: Request) -> dict[str, Any]:
    """리더 등록. 진짜 리더는 화면에 뜬 등록 코드, 테스트 모드에서는 `simulated-s700`."""
    _require_stripe()
    _require_staff(request)
    try:
        r = sg.register_reader(body.registration_code.strip(), body.label.strip() or "Pro shop")
    except sg.StripeError as exc:
        raise HTTPException(status_code=422 if exc.status == 400 else 502, detail=exc.message) from None
    return {"id": r.get("id"), "label": r.get("label"), "device_type": r.get("device_type"),
            "status": r.get("status")}


@router.post("/terminal/sale")
def sale(body: SaleBody, request: Request) -> dict[str, Any]:
    """판매: 리더에 금액을 띄운다. 돌려주는 줄은 pending — 화면이 `/terminal/txn/{id}` 로 결과를 묻는다."""
    _require_stripe()
    row = _as_staff(request, "pelham_staff_terminal_begin", {"p": {
        "kind": "sale", "bill_id": body.bill_id, "amount": body.amount, "reader_id": body.reader_id}})
    pi_id = ""
    try:
        pi = sg.create_terminal_intent(amount_cents=body.amount, txn_id=int(row["id"]),
                                       reference=str(row["reference"]), bill_id=body.bill_id,
                                       description=f"Pelham Hills POS bill {body.bill_id}")
        pi_id = str(pi.get("id") or "")
        row = _service("pelham_terminal_settle", {"p": {"id": row["id"], "payment_intent": pi_id}})
        sg.process_on_reader(body.reader_id, pi_id)
    except sg.StripeError as exc:
        if pi_id:
            _try_cancel_intent(pi_id)
        message = exc.message
        if exc.code == "terminal_reader_busy":
            message = "The reader is busy with another payment. Finish or cancel that one first."
        elif exc.code == "terminal_reader_offline":
            message = "The reader is offline. Check that it is on and connected to the internet."
        return _final(row, approved=False, result="failed", message=message, code=exc.code)
    return row


@router.get("/terminal/txn/{txn_id}")
def transaction(txn_id: int, request: Request) -> dict[str, Any]:
    row = _as_staff(request, "pelham_staff_terminal_get", {"p_id": txn_id})
    return _safe_refresh(row) if sg.configured() else row


@router.post("/terminal/txn/{txn_id}/cancel")
def cancel(txn_id: int, request: Request) -> dict[str, Any]:
    """계산대에서 취소. 손님이 이미 승인을 받았으면 취소되지 않고 승인된 줄이 온다."""
    _require_stripe()
    row = _as_staff(request, "pelham_staff_terminal_get", {"p_id": txn_id})
    if not row.get("pending"):
        return row
    if row.get("reader_id"):
        try:
            sg.cancel_reader_action(str(row["reader_id"]))
        except sg.StripeError as exc:
            logger.info("리더 취소 실패: %s (%s)", row.get("reader_id"), exc.message)
    try:
        if row.get("kind") == "sale" and row.get("payment_intent"):
            if _try_cancel_intent(str(row["payment_intent"])):
                return _final(row, approved=False, result="canceled", message="Cancelled from the register.")
        elif row.get("kind") == "sale":
            return _final(row, approved=False, result="canceled", message="Cancelled from the register.")
        return refresh(row)
    except sg.StripeError as exc:
        raise HTTPException(status_code=502, detail=exc.message) from None


@router.post("/terminal/txn/{txn_id}/simulate")
def simulate(txn_id: int, body: SimulateBody, request: Request) -> dict[str, Any]:
    """테스트 모드: 가상 리더에 손님이 카드를 댄 것처럼 한다. 실제 키에서는 거절한다."""
    _require_stripe()
    if not sg.is_test():
        raise HTTPException(status_code=403, detail="Simulated taps only work in Stripe test mode.")
    row = _as_staff(request, "pelham_staff_terminal_get", {"p_id": txn_id})
    if not row.get("pending") or not row.get("reader_id"):
        return row
    try:
        sg.simulate_tap(str(row["reader_id"]), interac=body.interac, card_number=body.card_number)
    except sg.StripeError as exc:
        raise HTTPException(status_code=422, detail=exc.message) from None
    return _safe_refresh(row)


@router.post("/terminal/refund")
def refund(body: RefundBody, request: Request) -> dict[str, Any]:
    """결제 줄 삭제(Charge 전)·환불(Charge 뒤). 신용카드는 바로 끝나고, Interac 은 리더에서 카드를 다시 댄다
    (pending 이 오면 화면이 `/terminal/txn/{id}` 로 결과를 묻는다)."""
    _require_stripe()
    row = _as_staff(request, "pelham_staff_terminal_begin", {"p": {
        "kind": "refund", "bill_id": body.bill_id, "refund_of": body.refund_of,
        "amount": body.amount, "reader_id": body.reader_id}})
    if not row.get("reader_id"):
        return _api_refund(row)
    try:
        sg.refund_on_reader(str(row["reader_id"]), str(row["payment_intent"]), int(row["requested_amount"]),
                            int(row["id"]))
    except sg.StripeError as exc:
        return _final(row, approved=False, result="failed", message=exc.message, code=exc.code)
    return row


@router.post("/terminal/bill/{bill_id}/sync")
def sync_bill(bill_id: int, request: Request) -> dict[str, Any]:
    """계산서를 다시 열었을 때: 결과를 모르는 거래를 Stripe 에 물어 마무리한다."""
    rows = _as_staff(request, "pelham_staff_terminal_in_flight", {"p_bill": bill_id}) or []
    if not sg.configured():
        return {"transactions": rows}
    return {"transactions": [_safe_refresh(row) for row in rows]}


# ===== 웹훅 ============================================================

@router.post("/stripe/webhook")
async def stripe_webhook(request: Request) -> dict[str, Any]:
    """Stripe → 우리. 서명이 맞지 않으면 400. 처리 중 DB·Stripe 가 안 닿으면 503(Stripe 가 다시 보낸다)."""
    raw = await request.body()
    if not sg.verify_webhook(raw, request.headers.get("stripe-signature")):
        raise HTTPException(status_code=400, detail="Bad signature")
    try:
        event = json.loads(raw.decode("utf-8"))
    except Exception:
        raise HTTPException(status_code=400, detail="Bad JSON") from None
    event_type = str(event.get("type") or "")
    obj = (event.get("data") or {}).get("object") or {}

    try:
        if event_type in ("checkout.session.completed", "checkout.session.async_payment_succeeded"):
            return _on_checkout(obj)
        if event_type == "charge.refunded":
            return _on_refund(obj)
        if event_type.startswith("payment_intent."):
            txn = str((obj.get("metadata") or {}).get("terminal_txn") or "")
            return _on_terminal(txn, "")
        if event_type.startswith("terminal.reader.action_"):
            action = obj.get("action") or {}
            pi = str(((action.get("process_payment_intent") or action.get("refund_payment") or {})
                      .get("payment_intent")) or "")
            return _on_terminal("", pi)
    except HTTPException as exc:
        if exc.status_code == 503:
            raise
        logger.warning("웹훅 처리 거절: %s (%s)", event_type, exc.detail)
        return {"ok": True, "refused": exc.detail}
    except supabase_rest.RpcRefused as exc:
        logger.warning("웹훅 처리 거절: %s (%s)", event_type, exc.message)
        return {"ok": True, "refused": exc.message}
    except supabase_rest.SupabaseUnavailable:
        raise HTTPException(status_code=503, detail="Try again later") from None
    except sg.StripeError as exc:
        logger.warning("웹훅 조회 실패: %s (%s)", event_type, exc.message)
        raise HTTPException(status_code=503, detail="Try again later") from None
    return {"ok": True, "ignored": event_type}


def _on_checkout(session: dict[str, Any]) -> dict[str, Any]:
    invoice = str(session.get("client_reference_id") or "").upper()
    if not invoice.startswith("PHW") or not session.get("id"):
        return {"ok": True, "ignored": "not an online booking payment"}
    session_invoice, paid = sg.checkout_payment(str(session["id"]))
    if not paid or session_invoice.upper() != invoice:
        return {"ok": True, "ignored": "not paid yet"}
    result = online.settle(paid, invoice)
    return {"ok": True, "status": result.get("status")}


def _on_refund(charge: dict[str, Any]) -> dict[str, Any]:
    pi = str(charge.get("payment_intent") or "")
    if not pi:
        return {"ok": True, "ignored": "no payment intent"}
    payment = supabase_rest.rpc("pelham_online_payment", {"p": {"trans_id": pi}})
    if payment:
        done = supabase_rest.rpc("pelham_online_refund_finish", {"p": {
            "trans_id": pi, "refund_kind": "refund", "refund_trans_id": sg.latest_refund(pi) or None,
            # 손님 취소가 Stripe 까지 갔다가 기록 전에 끊긴 경우만 예약도 취소한다.
            "cancel_booking": bool(payment.get("refund_pending")),
            "reason": "Guest cancelled online" if payment.get("refund_pending") else "Refunded in Stripe",
        }})
        return {"ok": True, "status": (done or {}).get("status")}
    sale_row = supabase_rest.rpc("pelham_terminal_find", {"p": {"payment_intent": pi}})
    if sale_row:
        pending = supabase_rest.rpc("pelham_terminal_pending_refunds", {"p_refund_of": sale_row["id"]}) or []
        for row in pending:
            refresh(row)
        return {"ok": True, "terminal_refunds": len(pending)}
    return {"ok": True, "ignored": "unknown payment"}


def _on_terminal(txn_id: str, pi: str) -> dict[str, Any]:
    if txn_id.isdigit():
        row = supabase_rest.rpc("pelham_terminal_find", {"p": {"id": int(txn_id)}})
    elif pi:
        row = supabase_rest.rpc("pelham_terminal_find", {"p": {"payment_intent": pi}})
    else:
        return {"ok": True, "ignored": "not a terminal payment"}
    if not row:
        return {"ok": True, "ignored": "unknown terminal payment"}
    if row.get("pending"):
        row = refresh(row)
    else:
        # 판매는 끝났고, 이 리더 알림은 그 판매의 Interac 환불일 수 있다.
        for pending in supabase_rest.rpc("pelham_terminal_pending_refunds", {"p_refund_of": row["id"]}) or []:
            refresh(pending)
    return {"ok": True, "result": row.get("result")}
