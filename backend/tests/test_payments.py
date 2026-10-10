"""온라인 결제(Stripe Checkout)·계산대 단말기(Stripe Terminal)·Stripe 웹훅 테스트.

실행: `python -m pytest backend/tests/test_payments.py -q`

네트워크는 쓰지 않는다. Stripe 는 `stripe_gateway._transport` 에 끼운 가짜(`FakeStripe`)가, SQL 함수
(0020·0021)는 `supabase_rest.rpc`·`rpc_as` 자리에 끼운 가짜(`FakeSql`)가 대신한다. SQL 의 규칙(금액·마감·
계산서·단말기 줄)은 0021 을 로컬 Postgres 에 올려 따로 확인했다. 여기서 보는 것은 **파이썬이 지키는 선**이다:
금액은 SQL 이 정한 그대로 Stripe 에 간다, 결과는 Stripe 에 다시 물어 기록한다, 기록할 수 없는 승인은 곧바로
환불한다, 카드사가 실패하면 예약은 그대로, 직원 토큰 없이는 단말기를 못 쓴다, 웹훅 서명.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import time
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import parse_qsl

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.api.routes import payments, terminal
from backend.services import stripe_gateway as sg
from backend.services import supabase_rest

API = "/api/v1/payments/online"
TERM = "/api/v1/payments/terminal"
HOOK = "/api/v1/payments/stripe/webhook"
CODE, EMAIL = "T4E7858394", "ben@example.com"
WHSEC = "whsec_test_secret"
STAFF = {"Authorization": "Bearer staff-token"}
READER = "tmr_TEST123"


def _now_iso(seconds_ago: float = 0) -> str:
    return (datetime.now(timezone.utc) - timedelta(seconds=seconds_ago)).isoformat()


class FakeStripe:
    """Stripe REST 의 꼴만. 요청을 기록하고 세션·PaymentIntent·환불·리더를 들고 있다."""

    def __init__(self) -> None:
        self.requests: list[tuple[str, str, dict[str, str], dict[str, str]]] = []
        self.sessions: dict[str, dict[str, Any]] = {}
        self.intents: dict[str, dict[str, Any]] = {}
        self.refunds: list[dict[str, Any]] = []
        self.readers: dict[str, dict[str, Any]] = {READER: {"id": READER, "label": "Pro shop",
                                                            "device_type": "simulated_stripe_s700",
                                                            "status": "online", "action": None}}
        self.fail: dict[str, tuple[int, str, str]] = {}
        self.n = 0

    def _id(self, prefix: str) -> str:
        self.n += 1
        return f"{prefix}_{self.n:06d}"

    # --- 시험이 결과를 만든다 ---
    def pay_session(self, session_id: str, *, amount: int | None = None) -> str:
        s = self.sessions[session_id]
        pi = self._intent(amount if amount is not None else s["amount_total"], {"invoice": s["client_reference_id"]},
                          "card", status="succeeded")
        s.update(payment_status="paid", status="complete", payment_intent=pi["id"])
        return pi["id"]

    def _intent(self, amount: int, metadata: dict[str, Any], kind: str, status: str = "requires_payment_method",
                tip: int = 0) -> dict[str, Any]:
        pid = self._id("pi")
        self.intents[pid] = {"id": pid, "object": "payment_intent", "amount": amount, "status": status,
                             "amount_received": amount if status == "succeeded" else 0, "metadata": metadata,
                             "kind": kind, "tip": tip, "last_payment_error": None}
        return self.intents[pid]

    def succeed(self, pid: str, *, interac: bool = False, tip: int = 0) -> None:
        pi = self.intents[pid]
        pi.update(status="succeeded", amount_received=pi["amount"] + tip, tip=tip,
                  kind="interac_present" if interac else "card_present")
        for r in self.readers.values():
            if (r.get("action") or {}).get("process_payment_intent", {}).get("payment_intent") == pid:
                r["action"]["status"] = "succeeded"

    def _expand(self, pi: dict[str, Any]) -> dict[str, Any]:
        out = {k: v for k, v in pi.items() if k not in ("kind", "tip")}
        if pi["tip"]:
            out["amount_details"] = {"tip": {"amount": pi["tip"]}}
        if pi["status"] == "succeeded":
            kind = pi["kind"]
            method = ({"brand": "visa", "last4": "4242", "read_method": "contactless_emv",
                       "receipt": {"authorization_code": "123456"}} if kind == "card_present" else
                      {"brand": "interac", "last4": "1933", "read_method": "contact_emv",
                       "receipt": {"authorization_code": "654321"}} if kind == "interac_present" else
                      {"brand": "visa", "last4": "4242"})
            out["latest_charge"] = {"id": "ch_" + pi["id"][3:], "payment_method_details": {"type": kind, kind: method}}
        return out

    # --- HTTP ---
    def __call__(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path.removeprefix("/v1")
        query = dict(parse_qsl(request.url.query.decode()))
        form = dict(parse_qsl(request.content.decode())) if request.content else {}
        self.requests.append((request.method, path, form, query))
        assert request.headers["authorization"] == "Bearer sk_test_123"
        # 계정 기본 버전(endive~)은 payment_method_types 를 거절한다. 늘 고정 버전으로 보낸다.
        assert request.headers["stripe-version"] == sg.API_VERSION
        for key, (status, code, message) in self.fail.items():
            if path.startswith(key):
                return httpx.Response(status, json={"error": {"code": code, "message": message}})
        m = request.method

        if path == "/balance":
            return httpx.Response(200, json={"object": "balance"})
        if m == "POST" and path == "/checkout/sessions":
            sid = self._id("cs_test")
            self.sessions[sid] = {"id": sid, "url": f"https://checkout.stripe.com/c/pay/{sid}",
                                  "client_reference_id": form["client_reference_id"],
                                  "metadata": {"invoice": form["metadata[invoice]"]},
                                  "amount_total": int(form["line_items[0][price_data][unit_amount]"]),
                                  "payment_status": "unpaid", "status": "open", "payment_intent": None,
                                  "form": form}
            return httpx.Response(200, json=self.sessions[sid])
        if m == "GET" and path.startswith("/checkout/sessions/"):
            s = dict(self.sessions[path.rsplit("/", 1)[1]])
            if s["payment_intent"]:
                s["payment_intent"] = self._expand(self.intents[s["payment_intent"]])
            return httpx.Response(200, json=s)
        if m == "POST" and path == "/payment_intents":
            meta = {k[9:-1]: v for k, v in form.items() if k.startswith("metadata[")}
            pi = self._intent(int(form["amount"]), meta, "card_present")
            return httpx.Response(200, json=self._expand(pi))
        if path.startswith("/payment_intents/"):
            parts = path.split("/")
            pi = self.intents[parts[2]]
            if m == "POST" and parts[-1] == "cancel":
                if pi["status"] == "succeeded":
                    return httpx.Response(400, json={"error": {"code": "payment_intent_unexpected_state",
                                                               "message": "already succeeded"}})
                pi["status"] = "canceled"
            return httpx.Response(200, json=self._expand(pi))
        if path == "/refunds":
            if m == "GET":
                rows = [r for r in self.refunds if r["payment_intent"] == query["payment_intent"]]
                return httpx.Response(200, json={"data": list(reversed(rows))})
            pi = self.intents[form["payment_intent"]]
            done = sum(r["amount"] for r in self.refunds if r["payment_intent"] == pi["id"])
            if done >= pi["amount_received"]:
                return httpx.Response(400, json={"error": {"code": "charge_already_refunded", "message": "refunded"}})
            meta = {k[9:-1]: v for k, v in form.items() if k.startswith("metadata[")}
            refund = {"id": self._id("re"), "payment_intent": pi["id"], "status": "succeeded",
                      "amount": int(form.get("amount") or pi["amount_received"]), "metadata": meta}
            self.refunds.append(refund)
            return httpx.Response(200, json=refund)
        if path.startswith("/terminal/readers/"):
            parts = path.split("/")
            r = self.readers[parts[3]]
            if m == "GET":
                return httpx.Response(200, json=r)
            action = parts[4]
            if action == "process_payment_intent":
                r["action"] = {"type": action, "status": "in_progress",
                               "process_payment_intent": {"payment_intent": form["payment_intent"]}}
            elif action == "refund_payment":
                r["action"] = {"type": action, "status": "in_progress",
                               "refund_payment": {"payment_intent": form["payment_intent"]},
                               "metadata": form.get("metadata[terminal_txn]")}
            elif action == "cancel_action":
                r["action"] = None
            return httpx.Response(200, json=r)
        if path == "/terminal/readers" and m == "GET":
            return httpx.Response(200, json={"data": list(self.readers.values())})
        if path.startswith("/test_helpers/terminal/readers/"):
            r = self.readers[path.split("/")[4]]
            act = r["action"]
            if act["type"] == "process_payment_intent":
                self.succeed(act["process_payment_intent"]["payment_intent"],
                             interac=form.get("type") == "interac_present")
            else:
                pid = act["refund_payment"]["payment_intent"]
                self.refunds.append({"id": self._id("re"), "payment_intent": pid, "status": "succeeded",
                                     "amount": self.intents[pid]["amount_received"],
                                     "metadata": {"terminal_txn": act["metadata"]}})
                act["status"] = "succeeded"
            return httpx.Response(200, json=r)
        raise AssertionError(f"{m} {path}")

    def posts(self, path: str) -> list[dict[str, str]]:
        return [form for m, p, form, _ in self.requests if m == "POST" and p == path]


class FakeSql:
    """0020·0021 함수의 꼴만. 온라인 금액은 108.01 달러 고정."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, Any], str | None]] = []
        self.rows: dict[str, dict[str, Any]] = {}
        self.txns: dict[int, dict[str, Any]] = {}
        self.refuse: dict[str, Exception] = {}
        self.reverse_next = False

    # supabase_rest.rpc
    def __call__(self, function: str, args: dict[str, Any]) -> Any:
        return self.run(function, args, None)

    # supabase_rest.rpc_as
    def as_user(self, token: str, function: str, args: dict[str, Any]) -> Any:
        if token != "staff-token":
            raise supabase_rest.RpcRefused(401, "Sign in with a pro shop account to open the tee sheet.")
        return self.run(function, args, token)

    def run(self, function: str, args: dict[str, Any], token: str | None) -> Any:
        self.calls.append((function, args, token))
        if function in self.refuse:
            raise self.refuse[function]
        if function.startswith("pelham_staff_"):
            assert token == "staff-token", f"{function} must run as staff"
        else:
            assert token is None, f"{function} must run as service_role"
        handler = getattr(self, function, None)
        if handler is None:
            raise AssertionError(function)
        return handler(args)

    # ----- 온라인 -----
    def pelham_online_pay_quote(self, args):
        return {"kind": "tee", "confirmation_code": CODE, "description": "Tee time Oct 15, 9:13 AM, 2 players",
                "payable": True, "reason": None, "lines": [{"name": "Green fee", "amount": 4779}] * 2,
                "subtotal": 9558, "tax": 1243, "total": 10801, "payment": None, "cancel_refund": None}

    def pelham_online_pay_start(self, args):
        inv = f"PHW{len(self.rows):012X}"
        self.rows[inv] = {"invoice": inv, "status": "pending", "amount": 10801, "kind": "tee",
                          "description": "Tee time Oct 15", "customer_name": "Ben Lee", "email": EMAIL,
                          "created_at": _now_iso()}
        return dict(self.rows[inv])

    def pelham_online_pay_session(self, args):
        self.rows[args["p_invoice"]]["gateway_session"] = args["p_session"]
        return dict(self.rows[args["p_invoice"]])

    def pelham_online_pay_complete(self, args):
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

    def pelham_online_payment(self, args):
        p = args["p"]
        if "invoice" in p:
            row = self.rows.get(p["invoice"])
        else:
            row = next((r for r in self.rows.values() if r.get("trans_id") == p["trans_id"]), None)
        return dict(row) if row else None

    def pelham_online_refund_begin(self, args):
        row = next(r for r in self.rows.values() if r["status"] == "approved")
        row["refund_pending"] = True
        return {**row, "amount_cents": row["amount"]}

    def pelham_online_refund_finish(self, args):
        p = args["p"]
        row = (self.rows.get(p.get("invoice", "")) or
               next(r for r in self.rows.values() if r.get("trans_id") == p.get("trans_id")))
        row.update(status="voided" if p["refund_kind"] == "void" else "refunded",
                   refund_kind=p["refund_kind"], refund_trans_id=p.get("refund_trans_id"), refund_pending=False)
        return dict(row)

    def pelham_online_refund_abort(self, args):
        for r in self.rows.values():
            r["refund_pending"] = False
        return None

    # ----- 단말기 -----
    def _json(self, t):
        return {**t, "pending": t["result"] == "pending"}

    def pelham_staff_terminal_begin(self, args):
        p = args["p"]
        tid = len(self.txns) + 1
        if p["kind"] == "sale":
            row = {"id": tid, "kind": "sale", "bill_id": p["bill_id"], "reference": f"REF{tid:09d}",
                   "result": "pending", "approved": False, "requested_amount": p["amount"], "tip": 0,
                   "total_amount": 0, "payment_intent": None, "reader_id": p["reader_id"],
                   "card_type": None, "created_at": _now_iso()}
        else:
            o = self.txns[p["refund_of"]]
            if any(t.get("refund_of") == o["id"] and (t["approved"] or t["result"] == "pending")
                   for t in self.txns.values()):
                raise supabase_rest.RpcRefused(409, "That payment is already refunded.")
            row = {"id": tid, "kind": "refund", "bill_id": p["bill_id"], "reference": f"REF{tid:09d}",
                   "result": "pending", "approved": False,
                   "requested_amount": p.get("amount") or o["total_amount"], "tip": 0, "total_amount": 0,
                   "payment_intent": o["payment_intent"], "refund_of": o["id"],
                   "reader_id": p.get("reader_id") if o["card_type"] == "debit" else None,
                   "card_type": o["card_type"], "created_at": _now_iso()}
        self.txns[tid] = row
        return self._json(row)

    def pelham_staff_terminal_get(self, args):
        return self._json(self.txns[args["p_id"]])

    def pelham_staff_terminal_in_flight(self, args):
        return [self._json(t) for t in self.txns.values()
                if t["bill_id"] == args["p_bill"] and t["result"] == "pending"]

    def pelham_terminal_settle(self, args):
        p = args["p"]
        row = self.txns[p["id"]]
        if row["result"] != "pending":
            return self._json(row)
        if not p.get("final"):
            row["payment_intent"] = p.get("payment_intent") or row["payment_intent"]
            return self._json(row)
        row.update({k: v for k, v in p.items() if k not in ("id", "final") and v is not None})
        row["approved"] = bool(p.get("approved"))
        return self._json(row)

    def pelham_terminal_find(self, args):
        p = args["p"]
        for t in self.txns.values():
            if ("id" in p and t["id"] == p["id"]) or (
                    t["kind"] == "sale" and p.get("payment_intent") and t["payment_intent"] == p["payment_intent"]):
                return self._json(t)
        return None

    def pelham_terminal_pending_refunds(self, args):
        return [self._json(t) for t in self.txns.values()
                if t.get("refund_of") == args["p_refund_of"] and t["result"] == "pending"]

    def called(self, function: str) -> list[dict[str, Any]]:
        return [a for f, a, _ in self.calls if f == function]


@pytest.fixture()
def env(monkeypatch):
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_test_123")
    monkeypatch.setenv("STRIPE_WEBHOOK_SECRET", WHSEC)
    gw, sql = FakeStripe(), FakeSql()
    monkeypatch.setattr(sg, "_transport", httpx.MockTransport(gw))
    monkeypatch.setattr(supabase_rest, "rpc", sql)
    monkeypatch.setattr(supabase_rest, "rpc_as", sql.as_user)
    monkeypatch.setattr(payments, "_credential_check", {"at": None, "result": None, "env": None})
    app = FastAPI()
    app.include_router(payments.router, prefix="/api/v1")
    app.include_router(terminal.router, prefix="/api/v1")
    return TestClient(app), gw, sql


def creds() -> dict[str, str]:
    return {"code": CODE, "email": EMAIL}


# ===== 설정 ============================================================

def test_disabled_without_keys(monkeypatch):
    monkeypatch.delenv("STRIPE_SECRET_KEY", raising=False)
    app = FastAPI()
    app.include_router(payments.router, prefix="/api/v1")
    client = TestClient(app)
    assert client.post(f"{API}/quote", json=creds()).json() == {"enabled": False}
    assert client.post(f"{API}/checkout", json=creds()).status_code == 503


def test_environment_follows_key(monkeypatch):
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_live_abc")
    assert sg.environment() == "live" and not sg.is_test()
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_test_abc")
    assert sg.environment() == "test"
    monkeypatch.setenv("STRIPE_SECRET_KEY", "pk_test_abc")    # 공개 키를 잘못 넣었다
    assert not sg.configured()


def test_form_encoding_nests_like_stripe():
    assert sg._flatten({"a": {"b": [1, {"c": True}]}, "skip": None}) == [("a[b][0]", "1"), ("a[b][1][c]", "true")]


# ===== 결제 페이지 =====================================================

def test_checkout_sends_sql_amount_and_invoice(env):
    client, gw, sql = env
    res = client.post(f"{API}/checkout", json=creds(), headers={"Origin": "https://pelhamhills.vercel.app"})
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["url"].startswith("https://checkout.stripe.com/")
    form = gw.posts("/checkout/sessions")[0]
    assert form["line_items[0][price_data][unit_amount]"] == "10801"
    assert form["line_items[0][price_data][currency]"] == "cad"
    assert form["client_reference_id"] == body["invoice"]
    assert form["payment_intent_data[metadata][invoice]"] == body["invoice"]
    assert form["customer_email"] == EMAIL
    assert form["success_url"] == f"https://pelhamhills.vercel.app/book/pay?invoice={body['invoice']}"
    assert form["cancel_url"].endswith("&cancelled=1")
    # 결과 화면이 다시 물을 수 있게 세션을 SQL 에 적는다.
    assert sql.rows[body["invoice"]]["gateway_session"].startswith("cs_test_")
    # 같은 invoice 로 두 번 만들지 않게 멱등 키를 보낸다.
    assert any(p == "/checkout/sessions" for m, p, _, _ in gw.requests)


def test_checkout_return_url_ignores_unknown_origin(env):
    client, gw, _ = env
    client.post(f"{API}/checkout", json=creds(), headers={"Origin": "https://evil.example"})
    assert gw.posts("/checkout/sessions")[0]["success_url"].startswith("https://pelhamhills-golf.vercel.app/book/pay?")


def test_checkout_refused_by_sql_passes_message(env):
    client, gw, sql = env
    sql.refuse["pelham_online_pay_start"] = supabase_rest.RpcRefused(409, "This booking has already been paid.")
    res = client.post(f"{API}/checkout", json=creds())
    assert res.status_code == 409
    assert res.json()["detail"] == "This booking has already been paid."
    assert gw.requests == []


def test_checkout_gateway_failure_is_502(env):
    client, gw, _ = env
    gw.fail["/checkout/sessions"] = (500, "api_error", "boom")
    assert client.post(f"{API}/checkout", json=creds()).status_code == 502


# ===== 결과 확인 =======================================================

def _checkout(client, sql) -> tuple[str, str]:
    invoice = client.post(f"{API}/checkout", json=creds()).json()["invoice"]
    return invoice, sql.rows[invoice]["gateway_session"]


def test_status_reconciles_pending_from_stripe(env):
    client, gw, sql = env
    invoice, session = _checkout(client, sql)
    assert client.get(f"{API}/status/{invoice}").json()["status"] == "pending"     # 아직 안 냈다
    pid = gw.pay_session(session)
    body = client.get(f"{API}/status/{invoice.lower()}").json()
    assert body["status"] == "approved" and body["card_last4"] == "4242"
    done = sql.called("pelham_online_pay_complete")
    assert len(done) == 1 and done[0]["p"]["trans_id"] == pid and done[0]["p"]["amount"] == 10801
    assert done[0]["p"]["response_code"] == "1"
    # 두 번째 조회는 Stripe 에 다시 묻지 않는다.
    n = len(gw.requests)
    assert client.get(f"{API}/status/{invoice}").json()["status"] == "approved"
    assert len(gw.requests) == n


def test_status_unknown_invoice(env):
    client, _, _ = env
    assert client.get(f"{API}/status/PHW000000000999").status_code == 404
    assert client.get(f"{API}/status/nope").status_code == 404


def test_unrecordable_approval_is_refunded_immediately(env):
    client, gw, sql = env
    invoice, session = _checkout(client, sql)
    pid = gw.pay_session(session)
    sql.reverse_next = True
    body = client.get(f"{API}/status/{invoice}").json()
    assert body["reversed"] == "refund"
    assert gw.refunds[-1]["payment_intent"] == pid
    fin = sql.called("pelham_online_refund_finish")[0]["p"]
    assert fin["trans_id"] == pid and fin["refund_kind"] == "refund" and not fin.get("cancel_booking")


# ===== 취소 환불 =======================================================

def _paid(client, gw, sql) -> tuple[str, str]:
    invoice, session = _checkout(client, sql)
    pid = gw.pay_session(session)
    client.get(f"{API}/status/{invoice}")
    return invoice, pid


def test_cancel_refunds_full_amount(env):
    client, gw, sql = env
    invoice, pid = _paid(client, gw, sql)
    res = client.post(f"{API}/cancel", json=creds())
    assert res.status_code == 200, res.text
    assert res.json()["booking_cancelled"] is True
    form = gw.posts("/refunds")[-1]
    assert form["payment_intent"] == pid and "amount" not in form    # 전액
    assert form["metadata[invoice]"] == invoice
    fin = sql.called("pelham_online_refund_finish")[-1]["p"]
    assert fin["cancel_booking"] is True and fin["refund_kind"] == "refund"
    assert fin["refund_trans_id"].startswith("re_")


def test_cancel_gateway_failure_keeps_booking(env):
    client, gw, sql = env
    _paid(client, gw, sql)
    gw.fail["/refunds"] = (402, "insufficient_funds", "Not enough balance")
    res = client.post(f"{API}/cancel", json=creds())
    assert res.status_code == 502
    assert "still active" in res.json()["detail"]
    assert sql.called("pelham_online_refund_abort")
    assert not sql.called("pelham_online_refund_finish")


def test_cancel_not_paid_online_is_404(env):
    client, _, sql = env
    sql.refuse["pelham_online_refund_begin"] = supabase_rest.RpcRefused(404, "This booking was not paid online.")
    assert client.post(f"{API}/cancel", json=creds()).status_code == 404


def test_refund_twice_returns_existing_refund(env):
    client, gw, sql = env
    _, pid = _paid(client, gw, sql)
    first = sg.refund(pid, idempotency_key="a")
    second = sg.refund(pid, idempotency_key="b")
    assert first == second and len(gw.refunds) == 1


# ===== 웹훅 ============================================================

def _signed(client, event: dict[str, Any], secret: str = WHSEC, stamp: int | None = None):
    raw = json.dumps(event).encode()
    t = stamp if stamp is not None else int(time.time())
    sig = hmac.new(secret.encode(), f"{t}.".encode() + raw, hashlib.sha256).hexdigest()
    return client.post(HOOK, content=raw, headers={"Stripe-Signature": f"t={t},v1={sig}"})


def test_webhook_rejects_bad_or_old_signature(env):
    client, _, sql = env
    event = {"type": "checkout.session.completed", "data": {"object": {}}}
    assert _signed(client, event, secret="whsec_wrong").status_code == 400
    assert _signed(client, event, stamp=int(time.time()) - 3600).status_code == 400
    assert sql.calls == []


def test_webhook_signature_accepts_any_v1(monkeypatch):
    monkeypatch.setenv("STRIPE_WEBHOOK_SECRET", WHSEC)
    raw = b'{"x":1}'
    t = int(time.time())
    good = hmac.new(WHSEC.encode(), f"{t}.".encode() + raw, hashlib.sha256).hexdigest()
    assert sg.verify_webhook(raw, f"t={t},v1=deadbeef,v1={good}")
    assert not sg.verify_webhook(raw, None)
    monkeypatch.delenv("STRIPE_WEBHOOK_SECRET")
    assert not sg.verify_webhook(raw, f"t={t},v1={good}")


def test_webhook_checkout_completed_records_payment(env):
    client, gw, sql = env
    invoice, session = _checkout(client, sql)
    pid = gw.pay_session(session)
    res = _signed(client, {"type": "checkout.session.completed",
                           "data": {"object": {"id": session, "client_reference_id": invoice}}})
    assert res.status_code == 200 and res.json()["status"] == "approved"
    assert sql.rows[invoice]["trans_id"] == pid


def test_webhook_ignores_other_checkouts(env):
    client, _, sql = env
    res = _signed(client, {"type": "checkout.session.completed",
                           "data": {"object": {"id": "cs_other", "client_reference_id": "SHOP-1"}}})
    assert res.json()["ignored"]
    assert not sql.called("pelham_online_pay_complete")


def test_webhook_dashboard_refund_unpays_without_cancelling(env):
    client, gw, sql = env
    _, pid = _paid(client, gw, sql)
    gw.refunds.append({"id": "re_dash", "payment_intent": pid, "status": "succeeded", "amount": 10801,
                       "metadata": {}})
    res = _signed(client, {"type": "charge.refunded", "data": {"object": {"payment_intent": pid}}})
    assert res.status_code == 200
    fin = sql.called("pelham_online_refund_finish")[-1]["p"]
    assert fin["trans_id"] == pid and fin["refund_trans_id"] == "re_dash" and fin["cancel_booking"] is False


def test_webhook_finishes_interrupted_guest_cancel(env):
    client, gw, sql = env
    invoice, pid = _paid(client, gw, sql)
    sql.rows[invoice]["refund_pending"] = True     # Stripe 까지 갔다가 기록 전에 끊겼다
    res = _signed(client, {"type": "charge.refunded", "data": {"object": {"payment_intent": pid}}})
    assert res.status_code == 200
    assert sql.called("pelham_online_refund_finish")[-1]["p"]["cancel_booking"] is True


def test_webhook_db_down_asks_for_retry(env):
    client, gw, sql = env
    invoice, session = _checkout(client, sql)
    gw.pay_session(session)
    sql.refuse["pelham_online_pay_complete"] = supabase_rest.SupabaseUnavailable("down")
    res = _signed(client, {"type": "checkout.session.completed",
                           "data": {"object": {"id": session, "client_reference_id": invoice}}})
    assert res.status_code == 503


# ===== 키 확인 =========================================================

def test_config_reports_valid_credentials_and_caches(env):
    client, gw, _ = env
    body = client.get(f"{API}/config").json()
    assert body == {"enabled": True, "environment": "test", "credentials": "ok", "webhook": True}
    client.get(f"{API}/config")
    assert sum(1 for _, p, _, _ in gw.requests if p == "/balance") == 1      # 10분 동안은 다시 묻지 않는다


def test_config_reports_rejected_credentials(env):
    client, gw, _ = env
    gw.fail["/balance"] = (401, "", "Invalid API Key provided")
    assert client.get(f"{API}/config").json()["credentials"] == "rejected"


def test_config_without_keys(monkeypatch):
    monkeypatch.delenv("STRIPE_SECRET_KEY", raising=False)
    monkeypatch.setattr(payments, "_credential_check", {"at": None, "result": None, "env": None})
    app = FastAPI()
    app.include_router(payments.router, prefix="/api/v1")
    body = TestClient(app).get(f"{API}/config").json()
    assert body["enabled"] is False and body["credentials"] == "missing"


# ===== 계산대 단말기 ===================================================

def _sale(client, amount: int = 1130) -> dict[str, Any]:
    res = client.post(f"{TERM}/sale", json={"bill_id": 7, "amount": amount, "reader_id": READER}, headers=STAFF)
    assert res.status_code == 200, res.text
    return res.json()


def test_terminal_needs_staff_token(env):
    client, gw, sql = env
    res = client.post(f"{TERM}/sale", json={"bill_id": 7, "amount": 1130, "reader_id": READER})
    assert res.status_code == 401
    assert client.get(f"{TERM}/readers").status_code == 401
    assert gw.requests == []


def test_terminal_sale_sends_amount_to_reader_and_records_approval(env):
    client, gw, sql = env
    row = _sale(client)
    assert row["pending"] is True and row["payment_intent"].startswith("pi_")
    form = gw.posts("/payment_intents")[0]
    assert form["amount"] == "1130" and form["currency"] == "cad"
    assert form["payment_method_types[0]"] == "card_present" and form["payment_method_types[1]"] == "interac_present"
    assert form["metadata[terminal_txn]"] == str(row["id"])
    sent = gw.posts(f"/terminal/readers/{READER}/process_payment_intent")[0]
    assert sent["payment_intent"] == row["payment_intent"]
    # 아직 손님이 카드를 대지 않았다.
    assert client.get(f"{TERM}/txn/{row['id']}", headers=STAFF).json()["pending"] is True
    gw.succeed(row["payment_intent"], tip=200)
    done = client.get(f"{TERM}/txn/{row['id']}", headers=STAFF).json()
    assert done["approved"] is True and done["pending"] is False
    assert done["tip"] == 200 and done["total_amount"] == 1330
    assert done["auth_code"] == "123456" and done["card_last4"] == "4242" and done["card_type"] == "credit"
    # 기록은 service_role 로만 쓴다.
    assert all(token is None for f, _, token in sql.calls if f == "pelham_terminal_settle")


def test_terminal_simulated_interac_tap_is_debit(env):
    client, gw, sql = env
    row = _sale(client)
    done = client.post(f"{TERM}/txn/{row['id']}/simulate", json={"interac": True}, headers=STAFF).json()
    assert done["approved"] is True and done["card_type"] == "debit" and done["card_last4"] == "1933"


def test_terminal_simulate_refused_with_live_key(env, monkeypatch):
    client, gw, sql = env
    row = _sale(client)
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_live_123")
    assert client.post(f"{TERM}/txn/{row['id']}/simulate", json={}, headers=STAFF).status_code == 403


def test_terminal_reader_busy_fails_cleanly(env):
    client, gw, sql = env
    gw.fail[f"/terminal/readers/{READER}/process_payment_intent"] = (400, "terminal_reader_busy", "busy")
    row = _sale(client)
    assert row["pending"] is False and row["approved"] is False
    assert "busy" in row["host_message"]
    pid = row["payment_intent"]
    assert gw.intents[pid]["status"] == "canceled"     # 남은 PaymentIntent 를 치운다


def test_terminal_decline_on_reader(env):
    client, gw, sql = env
    row = _sale(client)
    gw.readers[READER]["action"].update(status="failed", failure_code="card_declined",
                                        failure_message="Your card was declined.")
    done = client.get(f"{TERM}/txn/{row['id']}", headers=STAFF).json()
    assert done["approved"] is False and done["result"] == "failed"
    assert done["host_message"] == "Your card was declined."


def test_terminal_cancel_from_register(env):
    client, gw, sql = env
    row = _sale(client)
    done = client.post(f"{TERM}/txn/{row['id']}/cancel", headers=STAFF).json()
    assert done["result"] == "canceled" and done["approved"] is False
    assert gw.posts(f"/terminal/readers/{READER}/cancel_action")
    assert gw.intents[row["payment_intent"]]["status"] == "canceled"


def test_terminal_cancel_too_late_keeps_approval(env):
    client, gw, sql = env
    row = _sale(client)
    gw.succeed(row["payment_intent"])        # 취소를 누르는 사이에 승인됐다
    done = client.post(f"{TERM}/txn/{row['id']}/cancel", headers=STAFF).json()
    assert done["approved"] is True


def test_terminal_credit_refund_needs_no_card(env):
    client, gw, sql = env
    row = _sale(client)
    gw.succeed(row["payment_intent"])
    client.get(f"{TERM}/txn/{row['id']}", headers=STAFF)
    res = client.post(f"{TERM}/refund", json={"bill_id": 7, "refund_of": row["id"]}, headers=STAFF).json()
    assert res["approved"] is True and res["transaction_id"].startswith("re_")
    form = gw.posts("/refunds")[-1]
    assert form["payment_intent"] == row["payment_intent"] and form["amount"] == "1130"
    assert form["metadata[terminal_txn]"] == str(res["id"])
    assert not gw.posts(f"/terminal/readers/{READER}/refund_payment")


def test_terminal_interac_refund_goes_through_reader(env):
    client, gw, sql = env
    row = _sale(client)
    client.post(f"{TERM}/txn/{row['id']}/simulate", json={"interac": True}, headers=STAFF)
    res = client.post(f"{TERM}/refund", json={"bill_id": 7, "refund_of": row["id"], "reader_id": READER},
                      headers=STAFF).json()
    assert res["pending"] is True
    assert gw.posts(f"/terminal/readers/{READER}/refund_payment")[0]["amount"] == "1130"
    done = client.post(f"{TERM}/txn/{res['id']}/simulate", json={"interac": True}, headers=STAFF).json()
    assert done["approved"] is True and done["transaction_id"].startswith("re_")


def test_terminal_sync_finishes_after_closed_tab(env):
    client, gw, sql = env
    row = _sale(client)
    gw.succeed(row["payment_intent"])        # 화면이 닫힌 사이에 승인됐다
    rows = client.post(f"{TERM}/bill/7/sync", headers=STAFF).json()["transactions"]
    assert rows[0]["approved"] is True


def test_terminal_webhook_records_without_register(env):
    client, gw, sql = env
    row = _sale(client)
    gw.succeed(row["payment_intent"])
    res = _signed(client, {"type": "payment_intent.succeeded",
                           "data": {"object": {"id": row["payment_intent"],
                                               "metadata": {"terminal_txn": str(row["id"])}}}})
    assert res.status_code == 200
    assert sql.txns[row["id"]]["approved"] is True


def test_terminal_readers_list(env):
    client, gw, sql = env
    body = client.get(f"{TERM}/readers", headers=STAFF).json()
    assert body["environment"] == "test"
    assert body["readers"][0] == {"id": READER, "label": "Pro shop", "device_type": "simulated_stripe_s700",
                                  "status": "online", "simulated": True}
