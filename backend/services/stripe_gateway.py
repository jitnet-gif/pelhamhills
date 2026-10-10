"""Stripe 클라이언트: 온라인 결제(Checkout), 계산대 단말기(Terminal, 서버 주도), 환불, 웹훅 서명.

## 온라인 (예약 사이트)
손님 카드는 **Stripe 가 호스팅하는 Checkout 페이지**에서만 입력된다. 우리 서버는 세션을 만들어 그 주소로
보내고, 결과는 세션·PaymentIntent 를 **Stripe 에 다시 물어서** 확인한다 — 브라우저가 들고 오는 값은
믿지 않는다. PCI 범위는 SAQ A 다.

## 계산대 (Stripe Terminal, server-driven)
계산대 브라우저는 단말기에 직접 닿지 않는다. FastAPI 가 PaymentIntent 를 만들고 리더(S700 등)에
`process_payment_intent` 를 보낸다. 결과는 PaymentIntent·리더 상태를 다시 물어 확인한다.
캐나다라 `card_present` 와 `interac_present` 를 같이 받는다. Interac 환불은 카드가 있어야 해서
리더의 `refund_payment` 로 하고, 신용카드 환불은 API 로 한다(카드 필요 없음).

설정 (전부 `fly secrets`):
- STRIPE_SECRET_KEY — `sk_test_…`(테스트) 또는 `sk_live_…`. 이 값으로 환경을 안다.
- STRIPE_WEBHOOK_SECRET — 웹훅 서명(`whsec_…`). 없으면 웹훅을 받지 않는다.
- STRIPE_TERMINAL_LOCATION — 리더를 등록할 Location(`tml_…`). 없으면 첫 Location 을 쓴다.

설정은 호출할 때마다 환경변수에서 읽는다(`authorize_net.py` 때와 같다). 키를 바꾸면 재시작만 하면 된다.

API 문서: https://docs.stripe.com/api — 요청은 form-encoded, 응답은 JSON. 금액은 센트 정수.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import os
import time
from dataclasses import dataclass
from typing import Any, Optional

import httpx

logger = logging.getLogger(__name__)

API_BASE = "https://api.stripe.com/v1"
CURRENCY = "cad"
# 웹훅 서명 시각 허용 오차(초). Stripe 라이브러리 기본값과 같다.
WEBHOOK_TOLERANCE = 300

# 테스트가 바꿔 끼운다(`authorize_net._transport` 와 같은 방식). None 이면 진짜 네트워크.
_transport: Optional[httpx.BaseTransport] = None


class StripeError(RuntimeError):
    """Stripe 가 거절했거나 닿지 않았다. `.code` 는 `card_declined` 같은 오류 코드(없으면 ""),
    `.status` 는 HTTP 상태(닿지 않았으면 0)."""

    def __init__(self, message: str, code: str = "", status: int = 0) -> None:
        super().__init__(message)
        self.code = code
        self.status = status
        self.message = message


# ===== 설정 ============================================================

def _env(name: str) -> str:
    return (os.getenv(name) or "").strip()


def configured() -> bool:
    return _env("STRIPE_SECRET_KEY").startswith(("sk_", "rk_"))


def environment() -> str:
    """"test" 또는 "live". 키 앞머리로 정한다 — 키와 환경이 엇갈릴 수 없다."""
    key = _env("STRIPE_SECRET_KEY")
    return "live" if key.startswith(("sk_live_", "rk_live_")) else "test"


def is_test() -> bool:
    return environment() == "test"


# ===== 요청 ============================================================

def _flatten(params: dict[str, Any], prefix: str = "") -> list[tuple[str, str]]:
    """{"a": {"b": [1, 2]}} → [("a[b][0]", "1"), ("a[b][1]", "2")]. None 은 빼고 bool 은 소문자."""
    out: list[tuple[str, str]] = []
    for key, value in params.items():
        name = f"{prefix}[{key}]" if prefix else str(key)
        if value is None:
            continue
        if isinstance(value, dict):
            out.extend(_flatten(value, name))
        elif isinstance(value, (list, tuple)):
            for i, item in enumerate(value):
                if isinstance(item, dict):
                    out.extend(_flatten(item, f"{name}[{i}]"))
                else:
                    out.append((f"{name}[{i}]", _scalar(item)))
        else:
            out.append((name, _scalar(value)))
    return out


def _scalar(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def _request(method: str, path: str, params: dict[str, Any] | None = None,
             idempotency_key: str | None = None) -> dict[str, Any]:
    key = _env("STRIPE_SECRET_KEY")
    if not key:
        raise StripeError("Stripe is not configured")
    headers = {"Authorization": f"Bearer {key}"}
    if idempotency_key:
        headers["Idempotency-Key"] = idempotency_key
    pairs = _flatten(params or {})
    try:
        with httpx.Client(timeout=30.0, transport=_transport) as client:
            if method == "GET":
                res = client.get(f"{API_BASE}{path}", params=pairs, headers=headers)
            else:
                res = client.request(method, f"{API_BASE}{path}", data=dict(pairs) if pairs else None,
                                     headers=headers)
    except httpx.HTTPError as exc:
        raise StripeError(f"Stripe unreachable ({type(exc).__name__})") from exc
    try:
        body = res.json()
    except Exception:
        body = {}
    if res.is_success:
        return body if isinstance(body, dict) else {}
    err = body.get("error") if isinstance(body, dict) else None
    err = err if isinstance(err, dict) else {}
    message = str(err.get("message") or f"Stripe HTTP {res.status_code}")
    code = str(err.get("decline_code") or err.get("code") or "")
    raise StripeError(message, code, res.status_code)


def check_key() -> None:
    """키가 통하는가. 틀리면 StripeError(status 401)."""
    _request("GET", "/balance")


# ===== 결과 모양 =======================================================

@dataclass(frozen=True)
class Payment:
    """PaymentIntent 에서 우리가 쓰는 칸만."""

    trans_id: str          # PaymentIntent id (pi_…)
    status: str            # PaymentIntent status (succeeded, requires_payment_method, canceled …)
    response_code: str     # 0020 의 약속: "1" 승인 / "2" 거절 / "3" 오류
    response_text: str
    auth_code: str
    amount_cents: int      # amount_received (팁 포함)
    tip_cents: int
    invoice: str
    card_brand: str
    card_last4: str
    card_type: str         # credit | debit (Interac)
    entry_mode: str
    charge_id: str
    metadata: dict[str, Any]

    def complete_args(self, invoice: str | None = None) -> dict[str, Any]:
        """`pelham_online_pay_complete` 의 p."""
        return {
            "invoice": invoice or self.invoice,
            "trans_id": self.trans_id,
            "response_code": self.response_code,
            "auth_code": self.auth_code,
            "amount": self.amount_cents,
            "card_brand": self.card_brand,
            "card_last4": self.card_last4,
            "response_text": self.response_text,
        }


def _payment(pi: dict[str, Any]) -> Payment:
    charge = pi.get("latest_charge") if isinstance(pi.get("latest_charge"), dict) else {}
    details = charge.get("payment_method_details") or {}
    kind = str(details.get("type") or "")
    method = details.get(kind) or {}
    receipt = method.get("receipt") or {}
    status = str(pi.get("status") or "")
    error = pi.get("last_payment_error") or {}
    if status == "succeeded":
        code, text = "1", "Approved"
    elif error:
        code, text = "2", str(error.get("message") or "Declined")
    else:
        code, text = "3", status
    tip = ((pi.get("amount_details") or {}).get("tip") or {}).get("amount") or 0
    metadata = pi.get("metadata") or {}
    return Payment(
        trans_id=str(pi.get("id") or ""),
        status=status,
        response_code=code,
        response_text=text[:300],
        auth_code=str(method.get("authorization_code") or receipt.get("authorization_code") or ""),
        amount_cents=int(pi.get("amount_received") or 0),
        tip_cents=int(tip),
        invoice=str(metadata.get("invoice") or ""),
        card_brand=str(method.get("brand") or ("interac" if kind == "interac_present" else "")).title()[:30],
        card_last4=str(method.get("last4") or ""),
        card_type="debit" if kind == "interac_present" else "credit",
        entry_mode=str(method.get("read_method") or ("online" if kind == "card" else ""))[:20],
        charge_id=str(charge.get("id") or ""),
        metadata=dict(metadata),
    )


def payment_intent(pi_id: str) -> Payment:
    return _payment(_request("GET", f"/payment_intents/{pi_id}", {"expand": ["latest_charge"]}))


# ===== 온라인 (Checkout) ===============================================

def create_checkout(*, invoice: str, amount_cents: int, description: str, email: str | None,
                    success_url: str, cancel_url: str) -> tuple[str, str]:
    """Checkout 세션 (id, url). 같은 invoice 로 두 번 불러도 같은 세션이 온다(멱등 키)."""
    session = _request("POST", "/checkout/sessions", {
        "mode": "payment",
        "payment_method_types": ["card"],
        "line_items": [{
            "quantity": 1,
            "price_data": {
                "currency": CURRENCY,
                "unit_amount": int(amount_cents),
                "product_data": {"name": description[:250] or "Pelham Hills booking"},
            },
        }],
        "client_reference_id": invoice,
        "customer_email": email or None,
        "metadata": {"invoice": invoice},
        "payment_intent_data": {"description": description[:250], "metadata": {"invoice": invoice}},
        "success_url": success_url,
        "cancel_url": cancel_url,
        # Checkout 이 허용하는 가장 짧은 시간. 그 뒤 버려진 시도는 pending 으로 남는다.
        "expires_at": int(time.time()) + 31 * 60,
    }, idempotency_key=f"checkout-{invoice}")
    return str(session.get("id") or ""), str(session.get("url") or "")


def checkout_payment(session_id: str) -> tuple[str, Payment | None]:
    """세션의 invoice 와, 돈이 들어왔으면 그 결제. 아직(또는 끝내 안) 냈으면 None."""
    session = _request("GET", f"/checkout/sessions/{session_id}", {"expand": ["payment_intent.latest_charge"]})
    invoice = str(session.get("client_reference_id") or (session.get("metadata") or {}).get("invoice") or "")
    pi = session.get("payment_intent")
    if session.get("payment_status") != "paid" or not isinstance(pi, dict):
        return invoice, None
    return invoice, _payment(pi)


# ===== 환불 ============================================================

def refund(pi_id: str, amount_cents: int | None = None, metadata: dict[str, Any] | None = None,
           idempotency_key: str | None = None) -> tuple[str, str]:
    """카드에 돌려준다. ("refund", re_…). 아직 캡처 전이면 PaymentIntent 를 취소한다 ("void", pi_…).
    이미 환불됐으면 그 환불을 돌려준다(두 번 돌려주지 않는다)."""
    pi = _request("GET", f"/payment_intents/{pi_id}")
    if pi.get("status") == "requires_capture":
        _request("POST", f"/payment_intents/{pi_id}/cancel")
        return "void", pi_id
    try:
        res = _request("POST", "/refunds", {
            "payment_intent": pi_id,
            "amount": amount_cents,
            "metadata": metadata or None,
        }, idempotency_key=idempotency_key or f"refund-{pi_id}")
    except StripeError as exc:
        if exc.code == "charge_already_refunded":
            existing = latest_refund(pi_id)
            if existing:
                return "refund", existing
        raise
    return "refund", str(res.get("id") or "")


def latest_refund(pi_id: str) -> str:
    """이 결제의 가장 최근 환불 id(없으면 "")."""
    res = _request("GET", "/refunds", {"payment_intent": pi_id, "limit": 1})
    data = res.get("data") or []
    return str(data[0].get("id") or "") if data else ""


def refunds_for(pi_id: str) -> list[dict[str, Any]]:
    res = _request("GET", "/refunds", {"payment_intent": pi_id, "limit": 20})
    return list(res.get("data") or [])


# ===== 계산대 (Terminal) ===============================================

def create_terminal_intent(*, amount_cents: int, txn_id: int, reference: str, bill_id: int | None,
                           description: str) -> dict[str, Any]:
    """단말기로 받을 PaymentIntent. 한 기록(txn_id)에 하나 — 멱등 키로 두 번 만들지 않는다."""
    return _request("POST", "/payment_intents", {
        "amount": int(amount_cents),
        "currency": CURRENCY,
        "payment_method_types": ["card_present", "interac_present"],
        "capture_method": "automatic",
        "description": description[:250],
        "metadata": {"terminal_txn": str(txn_id), "reference": reference,
                     "bill_id": str(bill_id) if bill_id is not None else None},
    }, idempotency_key=f"terminal-sale-{txn_id}")


def process_on_reader(reader_id: str, pi_id: str) -> dict[str, Any]:
    return _request("POST", f"/terminal/readers/{reader_id}/process_payment_intent", {
        "payment_intent": pi_id,
        "process_config": {"enable_customer_cancellation": True},
    })


def refund_on_reader(reader_id: str, pi_id: str, amount_cents: int, txn_id: int) -> dict[str, Any]:
    """Interac 환불: 손님이 리더에 카드를 다시 댄다."""
    return _request("POST", f"/terminal/readers/{reader_id}/refund_payment", {
        "payment_intent": pi_id,
        "amount": int(amount_cents),
        "metadata": {"terminal_txn": str(txn_id)},
        "refund_payment_config": {"enable_customer_cancellation": True},
    })


def reader(reader_id: str) -> dict[str, Any]:
    return _request("GET", f"/terminal/readers/{reader_id}")


def cancel_reader_action(reader_id: str) -> dict[str, Any]:
    return _request("POST", f"/terminal/readers/{reader_id}/cancel_action")


def cancel_intent(pi_id: str) -> dict[str, Any]:
    return _request("POST", f"/payment_intents/{pi_id}/cancel")


def list_readers() -> list[dict[str, Any]]:
    return list(_request("GET", "/terminal/readers", {"limit": 100}).get("data") or [])


def terminal_location() -> str:
    """리더를 등록할 Location. 설정값 → 첫 Location → (테스트 모드에서만) 새로 만든다."""
    configured_location = _env("STRIPE_TERMINAL_LOCATION")
    if configured_location:
        return configured_location
    found = _request("GET", "/terminal/locations", {"limit": 1}).get("data") or []
    if found:
        return str(found[0].get("id") or "")
    if not is_test():
        raise StripeError("Create a Terminal location in the Stripe Dashboard first.")
    created = _request("POST", "/terminal/locations", {
        "display_name": "Pelham Hills Golf Club (test)",
        "address": {"line1": "Pelham Hills Golf Club", "city": "Fonthill", "state": "ON",
                    "postal_code": "L0S 1E0", "country": "CA"},
    }, idempotency_key="pelham-test-location")
    return str(created.get("id") or "")


def register_reader(registration_code: str, label: str) -> dict[str, Any]:
    """리더 등록. 테스트 모드에서는 `simulated-s700` 으로 가상 리더를 만든다."""
    return _request("POST", "/terminal/readers", {
        "registration_code": registration_code,
        "label": label[:60],
        "location": terminal_location(),
    })


def simulate_tap(reader_id: str, *, interac: bool = False, card_number: str | None = None) -> dict[str, Any]:
    """테스트 모드 전용: 손님이 가상 리더에 카드를 댄 것처럼 한다."""
    if not is_test():
        raise StripeError("Simulated taps only work with a test key.")
    params: dict[str, Any] = {"type": "interac_present" if interac else "card_present"}
    if card_number:
        params["interac_present" if interac else "card_present"] = {"number": card_number}
    return _request("POST", f"/test_helpers/terminal/readers/{reader_id}/present_payment_method", params)


# ===== 웹훅 ============================================================

def verify_webhook(raw: bytes, header: str | None, now: float | None = None) -> bool:
    """`Stripe-Signature: t=…,v1=…` — HMAC-SHA256(`{t}.{본문}`, whsec). 5분보다 오래된 것은 거절."""
    secret = _env("STRIPE_WEBHOOK_SECRET")
    if not secret or not header:
        return False
    stamp = ""
    signatures: list[str] = []
    for part in header.split(","):
        name, _, value = part.strip().partition("=")
        if name == "t":
            stamp = value
        elif name == "v1":
            signatures.append(value.strip().lower())
    if not stamp.isdigit() or not signatures:
        return False
    if abs((now if now is not None else time.time()) - int(stamp)) > WEBHOOK_TOLERANCE:
        return False
    expected = hmac.new(secret.encode(), stamp.encode() + b"." + raw, hashlib.sha256).hexdigest()
    return any(hmac.compare_digest(expected, sig) for sig in signatures)
