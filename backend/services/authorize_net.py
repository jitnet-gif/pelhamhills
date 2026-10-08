"""Authorize.net 클라이언트: 결제 폼 토큰(Accept Hosted), 거래 조회, void/refund, 웹훅 서명.

손님 카드는 **Authorize.net 이 호스팅하는 결제 폼**에서만 입력된다. 우리 서버는 토큰을 받아
브라우저에 넘기고, 결과는 거래 ID 로 Authorize.net 에 **다시 물어서** 확인한다 — 브라우저가 들고
오는 값(돌아온 주소의 쿼리 등)은 믿지 않는다. 그래서 PCI 범위는 SAQ A 다.

설정 (전부 `fly secrets`):
- AUTHORIZE_NET_API_LOGIN_ID, AUTHORIZE_NET_TRANSACTION_KEY — API 인증.
- AUTHORIZE_NET_SIGNATURE_KEY — 웹훅 서명(HMAC-SHA512). 없으면 웹훅을 받지 않는다.
- AUTHORIZE_NET_ENV — `sandbox`(기본) 또는 `production`.

설정은 호출할 때마다 환경변수에서 읽는다(`voice.py` 와 같다). 키를 바꾸면 재시작만 하면 되고,
테스트는 monkeypatch.setenv 로 끈다.

API 문서: https://developer.authorize.net/api/reference/
- JSON 요청도 **요소 순서가 XML 스키마 순서**여야 한다. dict 를 만드는 순서를 바꾸지 말 것.
- JSON 응답은 앞에 BOM 이 붙어 온다(`utf-8-sig`).
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal
from typing import Any, Optional

import httpx

logger = logging.getLogger(__name__)

API_URLS = {
    "sandbox": "https://apitest.authorize.net/xml/v1/request.api",
    "production": "https://api.authorize.net/xml/v1/request.api",
}
FORM_URLS = {
    "sandbox": "https://test.authorize.net/payment/payment",
    "production": "https://accept.authorize.net/payment/payment",
}

MERCHANT_NAME = "Pelham Hills Golf Club"

# 테스트가 바꿔 끼운다(`tee_sheet_supabase._transport` 와 같은 방식). None 이면 진짜 네트워크.
_transport: Optional[httpx.BaseTransport] = None

# 정산 전 상태 — 이때는 refund 가 안 되고 void 해야 한다.
_VOIDABLE = {
    "authorizedPendingCapture",
    "capturedPendingSettlement",
    "FDSPendingReview",
    "FDSAuthorizedPendingReview",
}
_SETTLED = {"settledSuccessfully"}
_ALREADY_REVERSED = {"voided", "refundSettledSuccessfully", "refundPendingSettlement"}


class GatewayError(RuntimeError):
    """Authorize.net 이 거절했거나 닿지 않았다. `.code` 는 E00027 같은 메시지 코드(없으면 "")."""

    def __init__(self, message: str, code: str = "") -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class Transaction:
    """거래 상세에서 우리가 쓰는 칸만."""

    trans_id: str
    ref_trans_id: str
    transaction_type: str
    status: str            # transactionStatus (settledSuccessfully, capturedPendingSettlement, voided …)
    response_code: str     # "1" 승인 / "2" 거절 / "3" 오류 / "4" 보류
    response_text: str
    auth_code: str
    amount_cents: int      # authAmount
    invoice: str
    card_brand: str
    card_last4: str

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


# ===== 설정 ============================================================

def _env(name: str) -> str:
    return os.getenv(name, "").strip()


def environment() -> str:
    return "production" if _env("AUTHORIZE_NET_ENV").lower() == "production" else "sandbox"


def configured() -> bool:
    return bool(_env("AUTHORIZE_NET_API_LOGIN_ID") and _env("AUTHORIZE_NET_TRANSACTION_KEY"))


def form_url() -> str:
    return FORM_URLS[environment()]


def _auth() -> dict[str, str]:
    return {
        "name": _env("AUTHORIZE_NET_API_LOGIN_ID"),
        "transactionKey": _env("AUTHORIZE_NET_TRANSACTION_KEY"),
    }


# ===== 금액 ============================================================

def dollars(cents: int) -> str:
    """1234 → "12.34". Authorize.net 은 소수 둘째 자리 문자열을 받는다."""
    return f"{Decimal(cents) / 100:.2f}"


def to_cents(value: Any) -> int:
    try:
        return int((Decimal(str(value)) * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP))
    except Exception:
        return -1


# ===== 호출 ============================================================

def _post(payload: dict[str, Any]) -> dict[str, Any]:
    if not configured():
        raise GatewayError("Online payments are not configured.")
    try:
        with httpx.Client(transport=_transport, timeout=20.0) as client:
            res = client.post(
                API_URLS[environment()],
                content=json.dumps(payload),
                headers={"Content-Type": "application/json"},
            )
    except Exception as exc:
        logger.warning("Authorize.net 호출 실패: %s", type(exc).__name__)
        raise GatewayError("The card processor could not be reached.") from exc
    if not res.is_success:
        logger.warning("Authorize.net HTTP %s", res.status_code)
        raise GatewayError(f"The card processor returned HTTP {res.status_code}.")
    try:
        body = json.loads(res.content.decode("utf-8-sig"))
    except Exception as exc:
        raise GatewayError("The card processor sent an unreadable reply.") from exc

    messages = body.get("messages") or {}
    if messages.get("resultCode") != "Ok":
        first = (messages.get("message") or [{}])[0]
        code, text = str(first.get("code") or ""), str(first.get("text") or "Request failed.")
        # 거래 응답 안의 오류가 더 구체적이다(예: "The referenced transaction does not meet the criteria").
        errors = (body.get("transactionResponse") or {}).get("errors") or []
        if errors:
            text = str(errors[0].get("errorText") or text)
        logger.warning("Authorize.net 거절: %s %s", code, text)
        raise GatewayError(text, code)
    return body


def hosted_payment_token(
    *,
    invoice: str,
    amount_cents: int,
    description: str,
    email: str | None,
    first_name: str | None,
    last_name: str | None,
    return_url: str,
    cancel_url: str,
) -> str:
    """결제 폼 토큰(15분 유효). 브라우저가 이것을 `form_url()` 로 POST 한다."""
    transaction: dict[str, Any] = {
        "transactionType": "authCaptureTransaction",
        "amount": dollars(amount_cents),
        "order": {"invoiceNumber": invoice, "description": description[:255]},
    }
    if email:
        transaction["customer"] = {"email": email[:255]}
    if first_name or last_name:
        transaction["billTo"] = {"firstName": (first_name or "")[:50], "lastName": (last_name or "")[:50]}

    def setting(name: str, value: dict[str, Any]) -> dict[str, str]:
        return {"settingName": name, "settingValue": json.dumps(value)}

    body = _post({
        "getHostedPaymentPageRequest": {
            "merchantAuthentication": _auth(),
            "refId": invoice,
            "transactionRequest": transaction,
            "hostedPaymentSettings": {
                "setting": [
                    setting("hostedPaymentReturnOptions", {
                        "showReceipt": True,
                        "url": return_url,
                        "urlText": "Back to Pelham Hills",
                        "cancelUrl": cancel_url,
                        "cancelUrlText": "Cancel",
                    }),
                    setting("hostedPaymentButtonOptions", {"text": f"Pay ${dollars(amount_cents)}"}),
                    setting("hostedPaymentPaymentOptions", {
                        "cardCodeRequired": True, "showCreditCard": True, "showBankAccount": False,
                    }),
                    setting("hostedPaymentOrderOptions", {"show": True, "merchantName": MERCHANT_NAME}),
                    setting("hostedPaymentBillingAddressOptions", {"show": True, "required": False}),
                    setting("hostedPaymentShippingAddressOptions", {"show": False, "required": False}),
                    setting("hostedPaymentCustomerOptions", {
                        "showEmail": False, "requiredEmail": False, "addPaymentProfile": False,
                    }),
                ]
            },
        }
    })
    token = body.get("token")
    if not token:
        raise GatewayError("The card processor did not return a payment form.")
    return str(token)


def transaction_details(trans_id: str) -> Transaction:
    body = _post({
        "getTransactionDetailsRequest": {"merchantAuthentication": _auth(), "transId": str(trans_id)}
    })
    t = body.get("transaction") or {}
    card = ((t.get("payment") or {}).get("creditCard") or {})
    digits = "".join(ch for ch in str(card.get("cardNumber") or "") if ch.isdigit())
    return Transaction(
        trans_id=str(t.get("transId") or trans_id),
        ref_trans_id=str(t.get("refTransId") or ""),
        transaction_type=str(t.get("transactionType") or ""),
        status=str(t.get("transactionStatus") or ""),
        response_code=str(t.get("responseCode") or ""),
        response_text=str(t.get("responseReasonDescription") or ""),
        auth_code=str(t.get("authCode") or ""),
        amount_cents=to_cents(t.get("authAmount", t.get("settleAmount", 0))),
        invoice=str((t.get("order") or {}).get("invoiceNumber") or ""),
        card_brand=str(card.get("cardType") or ""),
        card_last4=digits[-4:] if len(digits) >= 4 else "",
    )


def find_unsettled(invoice: str, limit: int = 100) -> list[str]:
    """정산 전 거래 목록에서 이 invoice 의 거래 ID 들(최신순). 돌아온 화면의 상태 확인이 쓴다 —
    웹훅이 아직 안 왔거나 설정되지 않았어도 결과를 찾을 수 있게."""
    body = _post({
        "getUnsettledTransactionListRequest": {
            "merchantAuthentication": _auth(),
            "sorting": {"orderBy": "submitTimeUTC", "orderDescending": True},
            "paging": {"limit": str(limit), "offset": "1"},
        }
    })
    return [
        str(t.get("transId"))
        for t in body.get("transactions") or []
        if str(t.get("invoiceNumber") or "").upper() == invoice.upper() and t.get("transId")
    ]


def authenticate_test() -> None:
    """키가 맞는지만 확인한다(`authenticateTestRequest`, Getting Started). 틀리면 GatewayError(E00007 등)."""
    _post({"authenticateTestRequest": {"merchantAuthentication": _auth()}})


def _transact(request: dict[str, Any], ref_id: str | None = None) -> str:
    """createTransactionRequest. 성공 = 최상위 resultCode Ok **그리고** transactionResponse.responseCode "1".
    refId(20자 이내)는 응답에 그대로 돌아온다 — 우리 invoice 를 넣어 로그에서 짝을 맞춘다."""
    payload: dict[str, Any] = {"merchantAuthentication": _auth()}
    if ref_id:
        payload["refId"] = ref_id[:20]
    payload["transactionRequest"] = request
    body = _post({"createTransactionRequest": payload})
    if ref_id and body.get("refId") not in (None, ref_id[:20]):
        logger.warning("Authorize.net refId 불일치: 보낸 %s, 받은 %s", ref_id[:20], body.get("refId"))
    tr = body.get("transactionResponse") or {}
    if str(tr.get("responseCode")) != "1":
        errors = tr.get("errors") or [{}]
        raise GatewayError(str(errors[0].get("errorText") or "The card processor declined the request."),
                           str(errors[0].get("errorCode") or ""))
    return str(tr.get("transId") or "")


def reverse(trans_id: str, amount_cents: int, ref_id: str | None = None) -> tuple[str, str]:
    """거래를 카드에 되돌린다. 정산 전이면 void, 정산 뒤면 전액 refund.
    반환: (kind 'void'|'refund', 새 거래 ID — void 는 원거래 ID 그대로). ref_id 는 보통 우리 invoice."""
    t = transaction_details(trans_id)
    ref_id = ref_id or t.invoice or None
    if t.status in _ALREADY_REVERSED:
        return ("void" if t.status == "voided" else "refund", t.trans_id)
    if t.status in _VOIDABLE:
        _transact({"transactionType": "voidTransaction", "refTransId": t.trans_id}, ref_id)
        return "void", t.trans_id
    if t.status in _SETTLED:
        if not t.card_last4:
            raise GatewayError("The card number on the original payment is not available for a refund.")
        new_id = _transact({
            "transactionType": "refundTransaction",
            "amount": dollars(amount_cents),
            "payment": {"creditCard": {"cardNumber": t.card_last4, "expirationDate": "XXXX"}},
            "refTransId": t.trans_id,
        }, ref_id)
        return "refund", new_id
    raise GatewayError(f"This payment cannot be reversed automatically (status {t.status or 'unknown'}).")


# ===== 웹훅 ============================================================

def verify_webhook(raw: bytes, header: str | None) -> bool:
    """`X-ANET-Signature: sha512=<HEX>` — 본문의 HMAC-SHA512(서명 키). 대소문자는 가리지 않는다."""
    key = _env("AUTHORIZE_NET_SIGNATURE_KEY")
    if not key or not header:
        return False
    provided = header.strip()
    if provided.lower().startswith("sha512="):
        provided = provided[len("sha512="):]
    expected = hmac.new(key.encode("utf-8"), raw, hashlib.sha512).hexdigest()
    return hmac.compare_digest(expected.upper(), provided.strip().upper())
