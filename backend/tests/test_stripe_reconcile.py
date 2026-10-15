"""Stripe 대사(Reports → Stripe check) 테스트.

실행: `python -m pytest backend/tests/test_stripe_reconcile.py -q`

`stripe_reconcile.reconcile` 은 순수 함수라 dict 로 바로 본다. 라우트는 Stripe 목록 HTTP 를 가짜
transport 로, SQL(0027)을 `rpc_as` 자리의 가짜로 바꿔 본다.
"""

from __future__ import annotations

from typing import Any
from urllib.parse import parse_qsl

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.api.routes import reconcile as route
from backend.services import stripe_gateway as sg
from backend.services import stripe_reconcile as rc
from backend.services import supabase_rest

T0 = 1_791_993_600  # 2026-10-14 12:00 UTC — 라우트 시험의 기간 안
WINDOW = (T0 - 3600, T0 + 3600)


def pi(pid: str, amount: int, *, status: str = "succeeded", refunded: int = 0, created: int = T0,
       meta: dict[str, Any] | None = None, disputed: bool = False) -> dict[str, Any]:
    return {"id": pid, "status": status, "created": created, "amount": amount,
            "amount_received": amount if status == "succeeded" else 0, "metadata": meta or {},
            "latest_charge": {"id": "ch_" + pid[3:], "amount_refunded": refunded, "disputed": disputed,
                              "payment_method_details": {"type": "card_present",
                                                         "card_present": {"brand": "visa", "last4": "4242"}}}}


def sale(tid: int, pid: str | None, amount: int, *, bill_status: str = "paid", on_bill: bool = True,
         approved: bool = True, result: str = "succeeded", voided: bool = False,
         pay_amount: int | None = None) -> dict[str, Any]:
    return {"id": tid, "kind": "sale", "result": result, "approved": approved, "payment_intent": pid,
            "transaction_id": "ch_x", "total_amount": amount if approved else 0, "tip": 0,
            "bill_payment_id": 900 + tid if on_bill else None, "voided_at": "2026-10-14T12:00:00Z" if voided else None,
            "created_at": "2026-10-14T12:00:00Z", "bill_id": 50 + tid, "bill_status": bill_status,
            "receipt_no": f"PH-20261014-{tid:04d}", "pay_amount": (pay_amount if pay_amount is not None else amount)
            if on_bill else None, "pay_tip": 0 if on_bill else None}


def refund_row(tid: int, of: int, pid: str, amount: int, *, result: str = "succeeded") -> dict[str, Any]:
    return {"id": tid, "kind": "refund", "result": result, "approved": result == "succeeded",
            "payment_intent": pid, "transaction_id": f"re_{tid}", "total_amount": amount, "refund_of": of,
            "created_at": "2026-10-14T13:00:00Z"}


def online(oid: int, pid: str | None, amount: int, status: str = "approved", *, bill_status: str = "paid",
           invoice: str = "PHW0000000000AA", refund_kind: str | None = None) -> dict[str, Any]:
    return {"id": oid, "invoice": invoice, "kind": "tee", "status": status, "amount": amount, "trans_id": pid,
            "refund_kind": refund_kind, "refund_trans_id": "re_on" if status == "refunded" else None,
            "created_at": "2026-10-14T11:00:00Z", "bill_id": 70 + oid, "bill_status": bill_status,
            "confirmation_code": "T4E7858394"}


def run(intents, terminal=(), onl=()):
    return rc.reconcile(list(intents), {"terminal": list(terminal), "online": list(onl)}, WINDOW)


def codes(result) -> dict[str, list[str]]:
    return {r["key"]: [i["code"] for i in r["issues"]] for r in result["rows"]}


# ===== 대조 규칙 =======================================================

def test_matching_records_are_ok():
    res = run([pi("pi_1", 1130), pi("pi_2", 10801)], [sale(1, "pi_1", 1130)], [online(1, "pi_2", 10801)])
    assert [r["level"] for r in res["rows"]] == ["ok", "ok"]
    s = res["summary"]
    assert s["stripe_net"] == s["ours_net"] == 11931 and s["difference"] == 0 and s["errors"] == 0


def test_declined_and_abandoned_attempts_are_left_out():
    res = run([pi("pi_1", 1130, status="canceled"), pi("pi_2", 500, status="requires_payment_method")],
              [sale(1, "pi_1", 1130, approved=False, result="canceled", on_bill=False)])
    assert res["rows"] == []


def test_charge_only_in_stripe():
    res = run([pi("pi_9", 2500)])
    assert codes(res) == {"pi_9": ["stripe_only"]}
    assert res["summary"]["difference"] == 2500


def test_stripe_charge_matched_by_metadata_when_pi_never_written():
    # PaymentIntent 를 만든 뒤 우리 줄에 적기 전에 끊겼다. 우리 줄은 실패로 끝났다.
    res = run([pi("pi_5", 1130, meta={"terminal_txn": "7"})],
              [sale(7, None, 1130, approved=False, result="failed", on_bill=False)])
    assert codes(res) == {"pi_5": ["not_recorded"]}


def test_recorded_paid_but_not_in_stripe():
    res = run([], [sale(1, "pi_404", 1130)])
    assert codes(res) == {"terminal-1": ["ours_only"]}


def test_amount_differs():
    res = run([pi("pi_1", 1500)], [sale(1, "pi_1", 1130)])
    assert "amount" in codes(res)["pi_1"]


def test_refund_in_stripe_dashboard_not_recorded():
    res = run([pi("pi_1", 1130, refunded=1130)], [sale(1, "pi_1", 1130)])
    assert codes(res)["pi_1"] == ["refund_stripe_only", "card_refunded_bill_paid"]


def test_recorded_refund_matches_stripe():
    res = run([pi("pi_1", 1130, refunded=1130)],
              [sale(1, "pi_1", 1130, bill_status="refunded"), refund_row(2, 1, "pi_1", 1130)])
    assert res["rows"][0]["level"] == "ok"
    assert res["summary"]["stripe_net"] == res["summary"]["ours_net"] == 0


def test_bill_refunded_but_card_not():
    res = run([pi("pi_1", 1130)], [sale(1, "pi_1", 1130, bill_status="refunded")])
    assert codes(res)["pi_1"] == ["bill_refunded_card_not"]


def test_approved_but_not_on_a_bill():
    res = run([pi("pi_1", 1130), pi("pi_2", 900)],
              [sale(1, "pi_1", 1130, on_bill=False, bill_status="paid"),
               sale(2, "pi_2", 900, on_bill=False, bill_status="open")])
    assert codes(res) == {"pi_1": ["not_on_bill"], "pi_2": ["bill_open"]}
    assert [r["level"] for r in res["rows"]] == ["error", "warn"]


def test_payment_line_deleted_before_charge_is_fine():
    res = run([pi("pi_1", 1130, refunded=1130)],
              [sale(1, "pi_1", 1130, on_bill=False, voided=True, bill_status="open"),
               refund_row(2, 1, "pi_1", 1130)])
    assert res["rows"][0]["level"] == "ok"


def test_bill_line_differs_from_charge():
    res = run([pi("pi_1", 1330)], [sale(1, "pi_1", 1330, pay_amount=1130)])
    assert codes(res)["pi_1"] == ["bill_line"]


def test_online_orphaned_and_dispute():
    res = run([pi("pi_1", 10801), pi("pi_2", 5000, disputed=True)],
              [], [online(1, "pi_1", 10801, "orphaned", bill_status=None),
                   online(2, "pi_2", 5000, invoice="PHW0000000000BB")])
    assert codes(res) == {"pi_1": ["orphaned"], "pi_2": ["disputed"]}


def test_online_refund_and_void():
    res = run([pi("pi_1", 10801, refunded=10801), pi("pi_2", 5000, status="canceled")],
              [], [online(1, "pi_1", 10801, "refunded", bill_status="refunded"),
                   online(2, "pi_2", 5000, "voided", bill_status="refunded", invoice="PHW0000000000BB",
                          refund_kind="void")])
    assert [r["level"] for r in res["rows"]] == ["ok"]


def test_online_paid_in_stripe_but_webhook_missed():
    res = run([pi("pi_1", 10801, meta={"invoice": "PHW0000000000AA"})], [], [online(1, None, 10801, "pending")])
    assert codes(res) == {"pi_1": ["not_recorded"]}


# ===== 라우트 ==========================================================

class FakeStripe:
    def __init__(self, intents: list[dict[str, Any]], refunds: list[dict[str, Any]],
                 others: dict[str, dict[str, Any]] | None = None) -> None:
        self.intents, self.refunds, self.others = intents, refunds, others or {}
        self.paths: list[tuple[str, dict[str, str]]] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path.removeprefix("/v1")
        query = dict(parse_qsl(request.url.query.decode()))
        self.paths.append((path, query))
        if path == "/payment_intents":
            return httpx.Response(200, json={"data": self.intents, "has_more": False})
        if path == "/refunds":
            return httpx.Response(200, json={"data": self.refunds, "has_more": False})
        if path.startswith("/payment_intents/"):
            found = self.others.get(path.rsplit("/", 1)[1])
            if found:
                return httpx.Response(200, json=found)
            return httpx.Response(404, json={"error": {"code": "resource_missing", "message": "No such"}})
        raise AssertionError(path)


@pytest.fixture()
def client(monkeypatch):
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_test_123")
    calls: list[tuple[str, dict[str, Any]]] = []
    records: dict[str, Any] = {"terminal": [], "online": [], "keyed": {"count": 2, "amount": 4000}}

    def as_user(token: str, function: str, args: dict[str, Any]) -> Any:
        if token != "staff-token":
            raise supabase_rest.RpcRefused(401, "Sign in with a pro shop account.")
        calls.append((function, args))
        return records if function == "pelham_staff_stripe_records" else []

    monkeypatch.setattr(supabase_rest, "rpc_as", as_user)
    app = FastAPI()
    app.include_router(route.router, prefix="/api/v1")
    return TestClient(app), calls, records, monkeypatch


AUTH = {"Authorization": "Bearer staff-token"}


def test_route_needs_staff_before_stripe(client):
    c, calls, _, mp = client
    gw = FakeStripe([], [])
    mp.setattr(sg, "_transport", httpx.MockTransport(gw))
    res = c.get("/api/v1/payments/reconcile?from=2026-10-14&to=2026-10-14")
    assert res.status_code == 401 and gw.paths == []


def test_route_validates_range(client):
    c, *_ = client
    assert c.get("/api/v1/payments/reconcile?from=2026-10-14&to=2026-10-13", headers=AUTH).status_code == 422
    assert c.get("/api/v1/payments/reconcile?from=2026-09-01&to=2026-10-14", headers=AUTH).status_code == 422
    assert c.get("/api/v1/payments/reconcile?from=oct&to=2026-10-14", headers=AUTH).status_code == 422


def test_route_toronto_window_and_lookups(client):
    c, calls, records, mp = client
    old = pi("pi_old", 2000, refunded=2000, created=T0 - 86400 * 5)
    gw = FakeStripe([pi("pi_1", 1130)], [{"id": "re_1", "payment_intent": "pi_old", "amount": 2000,
                                          "status": "succeeded"}], {"pi_old": old})
    mp.setattr(sg, "_transport", httpx.MockTransport(gw))
    records["terminal"] = [sale(1, "pi_1", 1130), sale(2, "pi_gone", 700),
                           sale(3, "pi_old", 2000, bill_status="refunded"), refund_row(4, 3, "pi_old", 2000)]
    res = c.get("/api/v1/payments/reconcile?from=2026-10-14&to=2026-10-14", headers=AUTH)
    assert res.status_code == 200, res.text
    body = res.json()
    # EDT(UTC−4): 10월 14일 00:00 토론토 = 04:00 UTC.
    assert body["window"] == {"from": "2026-10-14T04:00:00Z", "to": "2026-10-15T04:00:00Z"}
    listing = dict(gw.paths)["/payment_intents"]
    assert listing["created[gte]"] == "1791950400" and listing["created[lt]"] == "1792036800"
    args = dict(calls)["pelham_staff_stripe_records"]
    assert {"pi_1", "re_1", "pi_old"} <= set(args["p_ids"])
    looked_up = [p for p, _ in gw.paths if p.startswith("/payment_intents/")]
    assert sorted(looked_up) == ["/payment_intents/pi_gone", "/payment_intents/pi_old"]
    levels = {r["key"]: r["level"] for r in body["rows"]}
    assert levels == {"pi_1": "ok", "pi_old": "ok", "terminal-2": "error"}
    assert body["keyed"] == {"count": 2, "amount": 4000}
    assert body["summary"]["outside_window"] == 1 and body["truncated"] is False


def test_route_stripe_failure_is_502(client):
    c, _, _, mp = client
    mp.setattr(sg, "_transport", httpx.MockTransport(
        lambda r: httpx.Response(401, json={"error": {"message": "Invalid API Key"}})))
    res = c.get("/api/v1/payments/reconcile?from=2026-10-14&to=2026-10-14", headers=AUTH)
    assert res.status_code == 502 and "Invalid API Key" in res.json()["detail"]
