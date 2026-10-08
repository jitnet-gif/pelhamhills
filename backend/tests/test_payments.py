"""온라인 결제(Authorize.net) 라우터와 클라이언트 테스트.

실행: `python -m pytest backend/tests/test_payments.py -q`

네트워크는 쓰지 않는다. Authorize.net 은 `authorize_net._transport` 에 끼운 가짜(`FakeGateway`)가,
SQL 함수(0020)는 `supabase_rest.rpc` 자리에 끼운 가짜(`FakeSql`)가 대신한다. SQL 의 규칙(금액·마감·
계산서)은 0020 을 로컬 Postgres 에 올려 따로 확인했다. 여기서 보는 것은 **파이썬이 지키는 선**이다:
금액은 SQL 이 정한 그대로 카드사에 간다, 결과는 거래 상세를 다시 물어 기록한다, 기록할 수 없는 승인은
곧바로 되돌린다, 정산 전엔 void·뒤엔 refund, 카드사가 실패하면 예약은 그대로, 웹훅 서명.
"""

from __future__ import annotations

import hashlib
import hmac
import json
from datetime import datetime, timezone
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.api.routes import payments
from backend.services import authorize_net as anet
from backend.services import supabase_rest

API = "/api/v1/payments/online"
CODE, EMAIL = "T4E7858394", "ben@example.com"
SIG_KEY = "A1B2C3D4E5F6" * 10


class FakeGateway:
    """Authorize.net JSON API 의 꼴만. 요청을 기록하고, 거래 표를 들고 있다."""

    def __init__(self) -> None:
        self.requests: list[dict[str, Any]] = []
        self.txns: dict[str, dict[str, Any]] = {}
        self.fail: set[str] = set()
        self.next_id = 80000000001

    def add(self, invoice: str, *, amount: str = "108.01", code: int = 1,
            status: str = "capturedPendingSettlement") -> str:
        tid = str(self.next_id)
        self.next_id += 1
        self.txns[tid] = {
            "transId": tid, "transactionType": "authCaptureTransaction", "transactionStatus": status,
            "responseCode": code, "responseReasonDescription": "Approval" if code == 1 else "Declined",
            "authCode": "ABC123", "authAmount": float(amount), "order": {"invoiceNumber": invoice},
            "payment": {"creditCard": {"cardNumber": "XXXX1111", "expirationDate": "XXXX", "cardType": "Visa"}},
            "submitTimeUTC": "2026-10-09T12:00:00Z",
        }
        return tid

    def __call__(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        (kind, payload), = body.items()
        self.requests.append(body)
        assert payload["merchantAuthentication"] == {"name": "login", "transactionKey": "key"}
        if kind in self.fail:
            return self._reply({"messages": {"resultCode": "Error",
                                             "message": [{"code": "E00027", "text": "Gateway said no"}]}})
        ok = {"messages": {"resultCode": "Ok", "message": [{"code": "I00001", "text": "Successful."}]}}
        if kind == "getHostedPaymentPageRequest":
            return self._reply({**ok, "token": "TOKEN-123"})
        if kind == "getTransactionDetailsRequest":
            return self._reply({**ok, "transaction": self.txns[payload["transId"]]})
        if kind == "getUnsettledTransactionListRequest":
            rows = [{"transId": t["transId"], "invoiceNumber": t["order"]["invoiceNumber"]}
                    for t in self.txns.values() if t["transactionStatus"] != "settledSuccessfully"]
            return self._reply({**ok, "transactions": rows})
        if kind == "createTransactionRequest":
            tr = payload["transactionRequest"]
            ref = self.txns[tr["refTransId"]]
            if tr["transactionType"] == "voidTransaction":
                ref["transactionStatus"] = "voided"
                return self._reply({**ok, "transactionResponse": {"responseCode": "1", "transId": ref["transId"]}})
            new_id = str(self.next_id)
            self.next_id += 1
            self.txns[new_id] = {**ref, "transId": new_id, "transactionType": "refundTransaction",
                                 "refTransId": ref["transId"], "transactionStatus": "refundPendingSettlement"}
            return self._reply({**ok, "transactionResponse": {"responseCode": "1", "transId": new_id}})
        raise AssertionError(kind)

    @staticmethod
    def _reply(body: dict[str, Any]) -> httpx.Response:
        # 진짜 응답처럼 BOM 을 붙인다.
        return httpx.Response(200, content=b"\xef\xbb\xbf" + json.dumps(body).encode())

    def of(self, kind: str) -> list[dict[str, Any]]:
        return [r[kind] for r in self.requests if kind in r]


class FakeSql:
    """0020 함수의 꼴만. 금액은 108.01 달러 고정."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.rows: dict[str, dict[str, Any]] = {}
        self.refuse: dict[str, Exception] = {}
        self.reverse_next = False

    def __call__(self, function: str, args: dict[str, Any]) -> Any:
        self.calls.append((function, args))
        if function in self.refuse:
            raise self.refuse[function]
        if function == "pelham_online_pay_quote":
            return {"kind": "tee", "confirmation_code": CODE, "description": "Tee time Oct 15, 9:13 AM, 2 players",
                    "payable": True, "reason": None, "lines": [{"name": "Green fee", "amount": 4779}] * 2,
                    "subtotal": 9558, "tax": 1243, "total": 10801, "payment": None, "cancel_refund": None}
        if function == "pelham_online_pay_start":
            inv = f"PHW{len(self.rows):012X}"
            self.rows[inv] = {"invoice": inv, "status": "pending", "amount": 10801, "kind": "tee",
                              "description": "Tee time Oct 15", "customer_name": "Ben Lee", "email": EMAIL,
                              "created_at": datetime.now(timezone.utc).isoformat()}
            return dict(self.rows[inv])
        if function == "pelham_online_pay_complete":
            p = args["p"]
            row = self.rows[p["invoice"]]
            if self.reverse_next:
                row.update(status="orphaned", trans_id=p["trans_id"])
                return {**row, "needs_reversal": True, "reversal_trans_id": p["trans_id"]}
            if row["status"] == "pending":
                ok = p["response_code"] == "1" and p["amount"] == row["amount"]
                row.update(status="approved" if ok else "declined", trans_id=p["trans_id"],
                           card_last4=p["card_last4"], card_brand=p["card_brand"], receipt_no="PH-20261009-0001")
            return {**row, "needs_reversal": False}
        if function == "pelham_online_payment":
            p = args["p"]
            if "invoice" in p:
                row = self.rows.get(p["invoice"])
            else:
                row = next((r for r in self.rows.values() if r.get("trans_id") == p["trans_id"]), None)
            return dict(row) if row else None
        if function == "pelham_online_refund_begin":
            row = next(r for r in self.rows.values() if r["status"] == "approved")
            row["refund_pending"] = True
            return {**row, "amount_cents": row["amount"]}
        if function == "pelham_online_refund_finish":
            p = args["p"]
            row = (self.rows.get(p.get("invoice", "")) or
                   next(r for r in self.rows.values() if r.get("trans_id") == p.get("trans_id")))
            row.update(status="voided" if p["refund_kind"] == "void" else "refunded",
                       refund_kind=p["refund_kind"], refund_pending=False)
            return dict(row)
        if function == "pelham_online_refund_abort":
            for r in self.rows.values():
                r["refund_pending"] = False
            return None
        raise AssertionError(function)

    def called(self, function: str) -> list[dict[str, Any]]:
        return [a for f, a in self.calls if f == function]


@pytest.fixture()
def env(monkeypatch):
    monkeypatch.setenv("AUTHORIZE_NET_API_LOGIN_ID", "login")
    monkeypatch.setenv("AUTHORIZE_NET_TRANSACTION_KEY", "key")
    monkeypatch.setenv("AUTHORIZE_NET_SIGNATURE_KEY", SIG_KEY)
    monkeypatch.setenv("AUTHORIZE_NET_ENV", "sandbox")
    gw, sql = FakeGateway(), FakeSql()
    monkeypatch.setattr(anet, "_transport", httpx.MockTransport(gw))
    monkeypatch.setattr(supabase_rest, "rpc", sql)
    app = FastAPI()
    app.include_router(payments.router, prefix="/api/v1")
    return TestClient(app), gw, sql


def creds() -> dict[str, str]:
    return {"code": CODE, "email": EMAIL}


# ===== 설정 ============================================================

def test_disabled_without_keys(monkeypatch):
    monkeypatch.delenv("AUTHORIZE_NET_API_LOGIN_ID", raising=False)
    monkeypatch.delenv("AUTHORIZE_NET_TRANSACTION_KEY", raising=False)
    app = FastAPI()
    app.include_router(payments.router, prefix="/api/v1")
    client = TestClient(app)
    assert client.post(f"{API}/quote", json=creds()).json() == {"enabled": False}
    assert client.post(f"{API}/checkout", json=creds()).status_code == 503


def test_amount_and_environment_helpers(monkeypatch):
    assert anet.dollars(10801) == "108.01"
    assert anet.dollars(5) == "0.05"
    assert anet.to_cents(108.01) == 10801
    assert anet.to_cents("19.995") == 2000
    monkeypatch.setenv("AUTHORIZE_NET_ENV", "production")
    assert anet.form_url() == "https://accept.authorize.net/payment/payment"
    monkeypatch.setenv("AUTHORIZE_NET_ENV", "anything-else")
    assert anet.form_url() == "https://test.authorize.net/payment/payment"


# ===== 결제 폼 =========================================================

def test_checkout_sends_sql_amount_and_invoice(env):
    client, gw, sql = env
    res = client.post(f"{API}/checkout", json=creds(), headers={"Origin": "https://pelhamhills.vercel.app"})
    assert res.status_code == 200
    body = res.json()
    assert body["token"] == "TOKEN-123"
    assert body["form_url"] == "https://test.authorize.net/payment/payment"
    req = gw.of("getHostedPaymentPageRequest")[0]
    tr = req["transactionRequest"]
    assert tr["transactionType"] == "authCaptureTransaction"
    assert tr["amount"] == "108.01"
    assert tr["order"]["invoiceNumber"] == body["invoice"]
    assert tr["billTo"] == {"firstName": "Ben", "lastName": "Lee"}
    # 요소 순서가 스키마 순서여야 한다.
    assert list(tr) == ["transactionType", "amount", "order", "customer", "billTo"]
    settings = {s["settingName"]: json.loads(s["settingValue"]) for s in req["hostedPaymentSettings"]["setting"]}
    ret = settings["hostedPaymentReturnOptions"]
    assert ret["url"] == f"https://pelhamhills.vercel.app/book/pay?invoice={body['invoice']}"
    assert ret["cancelUrl"].endswith("&cancelled=1")
    assert settings["hostedPaymentPaymentOptions"]["showBankAccount"] is False


def test_checkout_return_url_ignores_unknown_origin(env):
    client, gw, _ = env
    client.post(f"{API}/checkout", json=creds(), headers={"Origin": "https://evil.example"})
    req = gw.of("getHostedPaymentPageRequest")[0]
    ret = json.loads(req["hostedPaymentSettings"]["setting"][0]["settingValue"])
    assert ret["url"].startswith("https://pelhamhills.vercel.app/book/pay?invoice=")


def test_checkout_refused_by_sql_passes_message(env):
    client, gw, sql = env
    sql.refuse["pelham_online_pay_start"] = supabase_rest.RpcRefused(409, "This booking has already been paid.")
    res = client.post(f"{API}/checkout", json=creds())
    assert res.status_code == 409
    assert res.json()["detail"] == "This booking has already been paid."
    assert gw.requests == []


def test_checkout_gateway_failure_is_502(env):
    client, gw, _ = env
    gw.fail.add("getHostedPaymentPageRequest")
    assert client.post(f"{API}/checkout", json=creds()).status_code == 502


# ===== 결과 확인 =======================================================

def test_status_reconciles_pending_from_gateway(env):
    client, gw, sql = env
    invoice = client.post(f"{API}/checkout", json=creds()).json()["invoice"]
    gw.add("PHWFFFFFFFFFFFF")          # 다른 주문 — 건드리면 안 된다
    tid = gw.add(invoice)
    res = client.get(f"{API}/status/{invoice.lower()}")
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "approved"
    assert body["card_last4"] == "1111"
    done = sql.called("pelham_online_pay_complete")
    assert len(done) == 1 and done[0]["p"]["trans_id"] == tid and done[0]["p"]["amount"] == 10801
    assert done[0]["p"]["response_code"] == "1"
    # 두 번째 조회는 카드사에 다시 묻지 않는다.
    n = len(gw.requests)
    assert client.get(f"{API}/status/{invoice}").json()["status"] == "approved"
    assert len(gw.requests) == n


def test_status_unknown_invoice(env):
    client, _, _ = env
    assert client.get(f"{API}/status/PHW000000000999").status_code == 404
    assert client.get(f"{API}/status/nope").status_code == 404


def test_unrecordable_approval_is_voided_immediately(env):
    client, gw, sql = env
    invoice = client.post(f"{API}/checkout", json=creds()).json()["invoice"]
    tid = gw.add(invoice)
    sql.reverse_next = True
    body = client.get(f"{API}/status/{invoice}").json()
    assert body["reversed"] == "void"
    assert gw.txns[tid]["transactionStatus"] == "voided"
    fin = sql.called("pelham_online_refund_finish")[0]["p"]
    assert fin["trans_id"] == tid and fin["refund_kind"] == "void" and not fin.get("cancel_booking")


# ===== 취소 환불 =======================================================

def _paid(client, gw, *, status="capturedPendingSettlement") -> tuple[str, str]:
    invoice = client.post(f"{API}/checkout", json=creds()).json()["invoice"]
    tid = gw.add(invoice)
    client.get(f"{API}/status/{invoice}")
    gw.txns[tid]["transactionStatus"] = status   # 그 뒤 밤사이 정산됐을 수 있다
    return invoice, tid


def test_cancel_before_settlement_voids(env):
    client, gw, sql = env
    invoice, tid = _paid(client, gw)
    res = client.post(f"{API}/cancel", json=creds())
    assert res.status_code == 200, res.text
    assert res.json()["booking_cancelled"] is True
    req = gw.of("createTransactionRequest")[-1]["transactionRequest"]
    assert req == {"transactionType": "voidTransaction", "refTransId": tid}
    fin = sql.called("pelham_online_refund_finish")[-1]["p"]
    assert fin["cancel_booking"] is True and fin["refund_kind"] == "void"


def test_cancel_after_settlement_refunds_full_amount(env):
    client, gw, sql = env
    invoice, tid = _paid(client, gw, status="settledSuccessfully")
    res = client.post(f"{API}/cancel", json=creds())
    assert res.status_code == 200, res.text
    req = gw.of("createTransactionRequest")[-1]["transactionRequest"]
    assert req["transactionType"] == "refundTransaction"
    assert req["amount"] == "108.01"
    assert req["payment"] == {"creditCard": {"cardNumber": "1111", "expirationDate": "XXXX"}}
    assert req["refTransId"] == tid
    assert list(req) == ["transactionType", "amount", "payment", "refTransId"]
    assert sql.called("pelham_online_refund_finish")[-1]["p"]["refund_kind"] == "refund"


def test_cancel_gateway_failure_keeps_booking(env):
    client, gw, sql = env
    _paid(client, gw)
    gw.fail.add("createTransactionRequest")
    res = client.post(f"{API}/cancel", json=creds())
    assert res.status_code == 502
    assert "still active" in res.json()["detail"]
    assert sql.called("pelham_online_refund_abort")
    assert not sql.called("pelham_online_refund_finish")


def test_cancel_not_paid_online_is_404(env):
    client, _, sql = env
    sql.refuse["pelham_online_refund_begin"] = supabase_rest.RpcRefused(404, "This booking was not paid online.")
    assert client.post(f"{API}/cancel", json=creds()).status_code == 404


# ===== 웹훅 ============================================================

def _signed(client, event: dict[str, Any], key: str = SIG_KEY):
    raw = json.dumps(event).encode()
    sig = "sha512=" + hmac.new(key.encode(), raw, hashlib.sha512).hexdigest().upper()
    return client.post(f"{API}/webhook", content=raw, headers={"X-ANET-Signature": sig})


def test_webhook_rejects_bad_signature(env):
    client, _, sql = env
    res = _signed(client, {"eventType": "net.authorize.payment.authcapture.created", "payload": {"id": "1"}},
                  key="wrong")
    assert res.status_code == 401
    assert sql.calls == []


def test_webhook_signature_is_case_insensitive(monkeypatch):
    monkeypatch.setenv("AUTHORIZE_NET_SIGNATURE_KEY", SIG_KEY)
    raw = b'{"x":1}'
    digest = hmac.new(SIG_KEY.encode(), raw, hashlib.sha512).hexdigest()
    assert anet.verify_webhook(raw, "sha512=" + digest.lower())
    assert anet.verify_webhook(raw, "SHA512=" + digest.upper())
    assert not anet.verify_webhook(raw, None)
    monkeypatch.delenv("AUTHORIZE_NET_SIGNATURE_KEY")
    assert not anet.verify_webhook(raw, "sha512=" + digest)


def test_webhook_authcapture_records_payment(env):
    client, gw, sql = env
    invoice = client.post(f"{API}/checkout", json=creds()).json()["invoice"]
    tid = gw.add(invoice)
    res = _signed(client, {"eventType": "net.authorize.payment.authcapture.created", "payload": {"id": tid}})
    assert res.status_code == 200 and res.json()["status"] == "approved"
    assert sql.rows[invoice]["trans_id"] == tid


def test_webhook_ignores_other_merchant_invoices(env):
    client, gw, sql = env
    tid = gw.add("POS-1234")
    res = _signed(client, {"eventType": "net.authorize.payment.authcapture.created", "payload": {"id": tid}})
    assert res.json()["ignored"]
    assert not sql.called("pelham_online_pay_complete")


def test_webhook_merchant_refund_unpays_without_cancelling(env):
    client, gw, sql = env
    invoice, tid = _paid(client, gw)
    gw.txns[tid]["transactionStatus"] = "settledSuccessfully"
    refund_id = str(gw.next_id)
    gw.txns[refund_id] = {**gw.txns[tid], "transId": refund_id, "transactionType": "refundTransaction",
                          "refTransId": tid}
    res = _signed(client, {"eventType": "net.authorize.payment.refund.created", "payload": {"id": refund_id}})
    assert res.status_code == 200
    fin = sql.called("pelham_online_refund_finish")[-1]["p"]
    assert fin["trans_id"] == tid and fin["refund_kind"] == "refund" and fin["cancel_booking"] is False


def test_webhook_finishes_interrupted_guest_cancel(env):
    client, gw, sql = env
    invoice, tid = _paid(client, gw)
    sql.rows[invoice]["refund_pending"] = True     # 카드사까지 갔다가 기록 전에 끊겼다
    gw.txns[tid]["transactionStatus"] = "voided"
    res = _signed(client, {"eventType": "net.authorize.payment.void.created", "payload": {"id": tid}})
    assert res.status_code == 200
    assert sql.called("pelham_online_refund_finish")[-1]["p"]["cancel_booking"] is True


def test_webhook_db_down_asks_for_retry(env):
    client, gw, sql = env
    invoice = client.post(f"{API}/checkout", json=creds()).json()["invoice"]
    tid = gw.add(invoice)
    sql.refuse["pelham_online_pay_complete"] = supabase_rest.SupabaseUnavailable("down")
    res = _signed(client, {"eventType": "net.authorize.payment.authcapture.created", "payload": {"id": tid}})
    assert res.status_code == 503
