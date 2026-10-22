"""계산대 사진으로 상품 찾기(`routes/product_photo.py`).

실행: `python -m pytest backend/tests/test_product_photo.py -q`

SQL 은 `supabase_rest.rpc_as` 자리의 가짜로, 사진 내려받기는 `_fetch_photo` 자리의 가짜로,
Claude 는 `_ask` 자리의 가짜로 바꾼다.
"""

from __future__ import annotations

import base64
import sys
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend.api.routes import product_photo  # noqa: E402
from backend.services import supabase_rest  # noqa: E402

API = "/api/v1"
PHOTO = base64.b64encode(b"\xff\xd8\xff" + b"0" * 200).decode("ascii")
PRODUCTS = [
    {"id": 7, "name": "Logo Polo Navy L", "category": "Apparel", "menu_group": "Men's Shirts",
     "is_active": True, "photo_url": "https://x.supabase.co/storage/v1/object/public/product-photos/7.webp"},
    {"id": 3, "name": "Hot Dog", "category": "Food & Beverage", "menu_group": None,
     "is_active": True, "photo_url": "https://x.supabase.co/storage/v1/object/public/product-photos/3.webp"},
    {"id": 9, "name": "Pro V1", "category": "Balls", "is_active": True, "photo_url": None},
]


@pytest.fixture()
def env(monkeypatch):
    monkeypatch.setattr(product_photo.settings, "ANTHROPIC_API_KEY", "sk-test")
    state = {"answer": {"candidates": [], "note": ""}, "asked": [], "token": None}

    def fake_rpc_as(token, function, args):
        state["token"] = token
        if not token:
            raise supabase_rest.RpcRefused(401, "Sign in with a pro shop account.")
        assert function == "pelham_staff_pos_products"
        return PRODUCTS

    async def fake_ask(refs, media_type, photo):
        state["asked"].append([item["id"] for item, _, _ in refs])
        return state["answer"]

    monkeypatch.setattr(supabase_rest, "rpc_as", fake_rpc_as)
    monkeypatch.setattr(product_photo, "_fetch_photo", lambda client, url: ("image/webp", "AAAA"))
    monkeypatch.setattr(product_photo, "_ask", fake_ask)
    app = FastAPI()
    app.include_router(product_photo.router, prefix=API)
    return TestClient(app), state


def post(client, body=None, token="staff-token"):
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    return client.post(f"{API}/pos/photo-match", json=body or {"image": PHOTO}, headers=headers)


def test_needs_staff_sign_in(env):
    client, _ = env
    assert post(client, token="").status_code == 401


def test_one_sure_candidate_is_a_match(env):
    client, state = env
    state["answer"] = {"candidates": [{"product_id": 7, "confidence": "high"},
                                      {"product_id": 3, "confidence": "low"}], "note": "Navy polo with club logo."}
    res = post(client)
    assert res.status_code == 200
    data = res.json()
    assert data["status"] == "match"
    assert data["candidates"][0] == {"product_id": 7, "confidence": "high"}
    assert data["compared"] == 2
    # 사진 없는 상품은 보내지 않고, 늘 id 순으로 보낸다(프롬프트 캐시).
    assert state["asked"] == [[3, 7]]


def test_unsure_or_two_sure_candidates_ask_the_cashier(env):
    client, state = env
    state["answer"] = {"candidates": [{"product_id": 7, "confidence": "medium"}], "note": ""}
    assert post(client).json()["status"] == "choices"
    state["answer"] = {"candidates": [{"product_id": 7, "confidence": "high"},
                                      {"product_id": 3, "confidence": "high"}], "note": ""}
    assert post(client).json()["status"] == "choices"


def test_made_up_ids_are_dropped(env):
    client, state = env
    state["answer"] = {"candidates": [{"product_id": 999, "confidence": "high"},
                                      {"product_id": 9, "confidence": "high"}], "note": ""}
    data = post(client).json()
    assert data["status"] == "none"
    assert data["candidates"] == []


def test_no_photos_yet(env, monkeypatch):
    client, state = env
    monkeypatch.setattr(supabase_rest, "rpc_as", lambda token, fn, args: [PRODUCTS[2]])
    data = post(client).json()
    assert data["status"] == "none" and data["compared"] == 0
    assert state["asked"] == []


def test_data_url_prefix_and_bad_photo(env):
    client, _ = env
    assert post(client, {"image": f"data:image/jpeg;base64,{PHOTO}"}).status_code == 200
    assert post(client, {"image": "not base64 !!" * 20}).status_code == 422
    assert post(client, {"image": PHOTO, "media_type": "image/gif"}).status_code == 422


def test_server_without_claude_key(env, monkeypatch):
    client, _ = env
    monkeypatch.setattr(product_photo.settings, "ANTHROPIC_API_KEY", "")
    assert post(client).status_code == 503


def test_reference_order_and_cap(monkeypatch):
    many = [{"id": i, "name": f"P{i}", "category": "Apparel", "is_active": True,
             "photo_url": f"https://x/{i}.jpg"} for i in range(120, 0, -1)]
    monkeypatch.setattr(product_photo, "_fetch_photo", lambda client, url: ("image/jpeg", "AAAA"))
    refs, skipped = product_photo._references(many)
    assert [item["id"] for item, _, _ in refs] == list(range(1, product_photo.MAX_REFERENCES + 1))
    assert skipped == 120 - product_photo.MAX_REFERENCES
    blocks = product_photo._content(refs, "image/jpeg", PHOTO)
    images = [b for b in blocks if b["type"] == "image"]
    assert len(images) == product_photo.MAX_REFERENCES + 1
    assert sum(1 for b in blocks if "cache_control" in b) == 1
