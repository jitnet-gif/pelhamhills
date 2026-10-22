"""계산대 담당자 코드(`routes/cashier_code.py`).

실행: `python -m pytest backend/tests/test_cashier_code.py -q`

SQL 은 `supabase_rest.rpc_as` 자리의 가짜로, pelham-shift 는 `_lookup` 자리의 가짜로 바꾼다.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend.api.routes import cashier_code  # noqa: E402
from backend.services import supabase_rest  # noqa: E402

API = "/api/v1"
STAFF = {"Authorization": "Bearer staff"}


@pytest.fixture()
def env(monkeypatch):
    state = {"answer": {}, "asked": []}

    def fake_rpc_as(token, function, args):
        if not token:
            raise supabase_rest.RpcRefused(401, "Sign in with a pro shop account.")
        return []

    def fake_lookup(code):
        state["asked"].append(code)
        if isinstance(state["answer"], Exception):
            raise state["answer"]
        return state["answer"]

    monkeypatch.setattr(supabase_rest, "rpc_as", fake_rpc_as)
    monkeypatch.setattr(cashier_code, "_lookup", fake_lookup)
    app = FastAPI()
    app.include_router(cashier_code.router, prefix=API)
    return TestClient(app), state


def test_code_becomes_name(env):
    client, state = env
    state["answer"] = {"name": "  Josh   Kim "}
    response = client.post(f"{API}/pos/cashier-code", json={"code": "1001"}, headers=STAFF)
    assert response.status_code == 200
    assert response.json() == {"name": "Josh Kim"}
    assert state["asked"] == ["1001"]


def test_needs_staff_sign_in(env):
    client, state = env
    response = client.post(f"{API}/pos/cashier-code", json={"code": "1001"})
    assert response.status_code == 401
    assert state["asked"] == []


def test_rejects_non_codes(env):
    client, state = env
    for code in ["12", "abcd", "123456789"]:
        assert client.post(f"{API}/pos/cashier-code", json={"code": code}, headers=STAFF).status_code == 422
    assert state["asked"] == []


def test_unknown_and_ambiguous(env):
    client, state = env
    state["answer"] = {}
    assert client.post(f"{API}/pos/cashier-code", json={"code": "9999"}, headers=STAFF).status_code == 404
    state["answer"] = {"ambiguous": True}
    assert client.post(f"{API}/pos/cashier-code", json={"code": "1001"}, headers=STAFF).status_code == 409


def test_shift_down(env):
    client, state = env
    state["answer"] = HTTPException(status_code=503, detail=cashier_code.UNAVAILABLE)
    response = client.post(f"{API}/pos/cashier-code", json={"code": "1001"}, headers=STAFF)
    assert response.status_code == 503


@pytest.fixture()
def approve_env(monkeypatch):
    state = {"answer": {}, "saved": []}

    def fake_rpc_as(token, function, args):
        if not token:
            raise supabase_rest.RpcRefused(401, "Sign in with a pro shop account.")
        assert function == "pelham_staff_my_id"
        return "uid-1"

    def fake_rpc(function, args):
        assert function == "pelham_shift_approve"
        state["saved"].append(args)
        if args["p_name"] is None:
            return {"approved": False, "message": "No staff member has that Pelham Shift ID."}
        return {"approved": True, "name": args["p_name"]}

    monkeypatch.setattr(supabase_rest, "rpc_as", fake_rpc_as)
    monkeypatch.setattr(supabase_rest, "rpc", fake_rpc)
    monkeypatch.setattr(cashier_code, "_lookup", lambda code: state["answer"])
    app = FastAPI()
    app.include_router(cashier_code.router, prefix=API)
    return TestClient(app), state


def test_approve_by_shift_id(approve_env):
    client, state = approve_env
    state["answer"] = {"name": " Josh  Kim "}
    body = {"code": "1001", "action": "refund", "ref": "77"}
    response = client.post(f"{API}/pos/approve", json=body, headers=STAFF)
    assert response.status_code == 200
    assert response.json() == {"approved": True, "name": "Josh Kim"}
    assert state["saved"] == [{"p_uid": "uid-1", "p_name": "Josh Kim", "p_action": "refund", "p_ref": "77"}]


def test_approve_wrong_id_is_recorded(approve_env):
    client, state = approve_env
    state["answer"] = {}
    body = {"code": "9999", "action": "price", "ref": "b1"}
    response = client.post(f"{API}/pos/approve", json=body, headers=STAFF)
    assert response.json()["approved"] is False
    assert state["saved"][0]["p_name"] is None


def test_approve_needs_staff(approve_env):
    client, state = approve_env
    body = {"code": "1001", "action": "refund", "ref": "77"}
    assert client.post(f"{API}/pos/approve", json=body).status_code == 401
    assert state["saved"] == []
