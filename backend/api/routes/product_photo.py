"""계산대 카메라 **사진으로 상품 찾기**.

바코드가 없는 물건(로고 셔츠·스낵바 음식·렌탈)은 상품마다 사진을 한 장 찍어 둔다(0068 `photo_url`).
계산대 카메라에서 셔터를 누르면 그 프레임이 여기로 오고, Claude 가 상품 사진들과 비교해 어느 상품인지 고른다.

## 순서
1. `pelham_staff_pos_products` 를 **직원의 토큰으로** 부른다 — 직원 확인과 상품 목록을 한 번에(0005).
2. 사진이 있는 활성 상품의 사진을 내려받는다. 주소마다 한 번만(주소에 uuid 가 있어 내용이 바뀌지 않는다).
3. 상품 사진 전부(id 순 — 같은 앞부분이라 프롬프트 캐시가 맞는다) + 찍은 사진을 Claude 에 보낸다.
4. Claude 가 고른 후보를 돌려준다. **담는 것은 화면이 한다** — 확신이 높은 후보가 하나면 바로 담고,
   아니면 직원이 후보 중에서 누른다. 가격·재고는 이 서버가 정하지 않는다(계산서 SQL 이 정한다).

## 한도
Messages API 는 요청 하나에 그림 100장까지라 상품 사진은 `MAX_REFERENCES` 장까지만 보낸다.
바코드가 있는 물건은 바코드로 찍으면 되므로 사진은 바코드 없는 물건에만 찍어 두는 것이 맞다.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import json
import logging
import os
from typing import Any, Literal, Optional

import httpx
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from backend.core.config import settings
from backend.services import supabase_rest

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/pos", tags=["Retail"])

MODEL = os.getenv("PHOTO_MATCH_MODEL", "claude-opus-5-5").strip()
#: 요청 하나의 그림 한도(100) 안에서 찍은 사진 한 장 자리를 남긴다.
MAX_REFERENCES = 90
#: 찍은 사진(base64 JPEG). 화면이 1024px 로 줄여 보내므로 보통 200KB 안팎이다.
MAX_PHOTO_CHARS = 4_000_000
#: 상품 사진 한 장(화면이 800px 로 줄여 올린다). 이보다 크면 건너뛴다.
MAX_REFERENCE_BYTES = 2 * 1024 * 1024
MEDIA_TYPES = {"image/jpeg", "image/png", "image/webp"}

UNAVAILABLE = "Photo matching is not available right now. Pick the item by hand."

SYSTEM_PROMPT = (
    "You identify products at a golf club pro shop and snack bar register. "
    "You get one reference photo per product, each labelled with its product id and name, "
    "and then a photo the cashier just took of the item being bought. "
    "Decide which reference product the item is. Compare shape, colour, logo, packaging and printed text. "
    "Different colours or sizes of the same item are different products when they have separate references. "
    "Return up to 3 candidates, best first, using only product ids from the references. "
    "Use confidence 'high' only when you are sure it is that exact product; "
    "'medium' when it is likely but a similar product could also fit; 'low' otherwise. "
    "Return no candidates when the photo shows none of the products (or nothing recognisable). "
    "Put a short reason for the cashier in 'note' (one sentence, English)."
)

OUTPUT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "candidates": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "product_id": {"type": "integer"},
                    "confidence": {"type": "string", "enum": ["high", "medium", "low"]},
                },
                "required": ["product_id", "confidence"],
                "additionalProperties": False,
            },
        },
        "note": {"type": "string"},
    },
    "required": ["candidates", "note"],
    "additionalProperties": False,
}


class PhotoMatchIn(BaseModel):
    #: base64 그림(앞의 `data:image/jpeg;base64,` 는 있어도 된다).
    image: str = Field(min_length=100, max_length=MAX_PHOTO_CHARS + 100)
    media_type: str = "image/jpeg"


class Candidate(BaseModel):
    product_id: int
    confidence: Literal["high", "medium", "low"]


class PhotoMatchOut(BaseModel):
    #: match = 확신이 높은 후보 하나(화면이 바로 담는다). choices = 직원이 고른다. none = 못 찾았다.
    status: Literal["match", "choices", "none"]
    candidates: list[Candidate]
    note: str = ""
    #: 비교한 상품 사진 수. 0 이면 사진이 있는 상품이 없다.
    compared: int
    #: 한도(`MAX_REFERENCES`)를 넘어서 비교하지 못한 상품 사진 수.
    skipped: int = 0


# ===== 상품 사진 =========================================================

#: 주소 → (media_type, base64). 주소에 uuid 가 있어 같은 주소의 내용은 바뀌지 않는다.
_photo_cache: dict[str, tuple[str, str]] = {}


def _media_type(url: str, header: str) -> Optional[str]:
    kind = (header or "").split(";")[0].strip().lower()
    if kind in MEDIA_TYPES:
        return kind
    lower = url.lower().split("?")[0]
    if lower.endswith(".png"):
        return "image/png"
    if lower.endswith(".webp"):
        return "image/webp"
    if lower.endswith((".jpg", ".jpeg")):
        return "image/jpeg"
    return None


def _fetch_photo(client: httpx.Client, url: str) -> Optional[tuple[str, str]]:
    cached = _photo_cache.get(url)
    if cached:
        return cached
    try:
        res = client.get(url)
    except Exception as exc:
        logger.warning("상품 사진을 못 읽었다: %s", type(exc).__name__)
        return None
    if not res.is_success or len(res.content) > MAX_REFERENCE_BYTES:
        return None
    kind = _media_type(url, res.headers.get("content-type", ""))
    if not kind:
        return None
    value = (kind, base64.b64encode(res.content).decode("ascii"))
    _photo_cache[url] = value
    return value


def _references(products: list[dict[str, Any]]) -> tuple[list[tuple[dict[str, Any], str, str]], int]:
    """사진이 있는 활성 상품의 사진. id 순(프롬프트 캐시가 맞도록 늘 같은 순서)."""
    pictured = sorted(
        (item for item in products if item.get("is_active") and item.get("photo_url")),
        key=lambda item: int(item["id"]),
    )
    skipped = max(0, len(pictured) - MAX_REFERENCES)
    out: list[tuple[dict[str, Any], str, str]] = []
    with httpx.Client(timeout=10.0, follow_redirects=True) as client:
        for item in pictured[:MAX_REFERENCES]:
            photo = _fetch_photo(client, str(item["photo_url"]))
            if photo:
                out.append((item, photo[0], photo[1]))
    return out, skipped


# ===== Claude ============================================================

def _make_client() -> Any:
    from anthropic import AsyncAnthropic

    return AsyncAnthropic(api_key=settings.ANTHROPIC_API_KEY, timeout=45.0, max_retries=1)


_client: Any = None


def _get_client() -> Any:
    global _client
    if _client is None:
        _client = _make_client()
    return _client


def _label(item: dict[str, Any]) -> str:
    group = f" · {item['menu_group']}" if item.get("menu_group") else ""
    return f"Product id {int(item['id'])}: {item.get('name', '')} ({item.get('category', '')}{group})"


def _content(refs: list[tuple[dict[str, Any], str, str]], media_type: str, photo: str) -> list[dict[str, Any]]:
    blocks: list[dict[str, Any]] = [{"type": "text", "text": "Reference products:"}]
    for item, kind, data in refs:
        blocks.append({"type": "text", "text": _label(item)})
        blocks.append({"type": "image", "source": {"type": "base64", "media_type": kind, "data": data}})
    # 상품 사진까지가 매번 같은 앞부분이다. 여기까지 캐시한다(사진이 적으면 최소 길이에 못 미쳐 그냥 안 된다).
    blocks[-1]["cache_control"] = {"type": "ephemeral"}
    blocks.append({"type": "text", "text": "Photo the cashier just took:"})
    blocks.append({"type": "image", "source": {"type": "base64", "media_type": media_type, "data": photo}})
    blocks.append({"type": "text", "text": "Which product is this?"})
    return blocks


async def _ask(refs: list[tuple[dict[str, Any], str, str]], media_type: str, photo: str) -> dict[str, Any]:
    response = await _get_client().beta.messages.create(
        model=MODEL,
        max_tokens=4000,
        system=SYSTEM_PROMPT,
        messages=[{"role": "user", "content": _content(refs, media_type, photo)}],
        output_config={"effort": "low", "format": {"type": "json_schema", "schema": OUTPUT_SCHEMA}},
        # 안전 분류기가 거절하면 서버가 권장 모델로 다시 돌린다(sms_agent 와 같다).
        betas=["server-side-fallback-2026-07-01"],
        extra_body={"fallbacks": "default"},
    )
    if response.stop_reason == "refusal":
        logger.warning("사진 찾기 거절: %s", getattr(response, "stop_details", None))
        return {"candidates": [], "note": "The photo could not be checked. Pick the item by hand."}
    text = next((block.text for block in response.content if getattr(block, "type", "") == "text"), "")
    try:
        return json.loads(text)
    except (TypeError, ValueError):
        logger.warning("사진 찾기 응답이 JSON 이 아니다 (stop_reason %s)", response.stop_reason)
        return {"candidates": [], "note": ""}


def _decide(answer: dict[str, Any], known: set[int]) -> tuple[str, list[Candidate]]:
    seen: set[int] = set()
    candidates: list[Candidate] = []
    for raw in answer.get("candidates") or []:
        try:
            pid = int(raw.get("product_id"))
        except (TypeError, ValueError, AttributeError):
            continue
        confidence = raw.get("confidence")
        # 모델이 목록에 없는 id 를 지어내면 버린다.
        if pid not in known or pid in seen or confidence not in ("high", "medium", "low"):
            continue
        seen.add(pid)
        candidates.append(Candidate(product_id=pid, confidence=confidence))
    candidates = candidates[:3]
    if not candidates:
        return "none", []
    highs = [c for c in candidates if c.confidence == "high"]
    # 바로 담는 것은 "확실한 것이 딱 하나" 일 때뿐이다. 둘이 다 확실하다면 직원이 고른다.
    if len(highs) == 1 and candidates[0].confidence == "high":
        return "match", candidates
    return "choices", candidates


# ===== 경로 ==============================================================

def _token(request: Request) -> str:
    header = request.headers.get("authorization") or ""
    return header[7:].strip() if header.lower().startswith("bearer ") else ""


def _staff_products(request: Request) -> list[dict[str, Any]]:
    try:
        rows = supabase_rest.rpc_as(_token(request), "pelham_staff_pos_products", {"p_active": True})
    except supabase_rest.RpcRefused as exc:
        raise HTTPException(status_code=exc.status, detail=exc.message) from None
    except supabase_rest.SupabaseUnavailable:
        raise HTTPException(status_code=503, detail=UNAVAILABLE) from None
    return rows if isinstance(rows, list) else []


def _clean_photo(body: PhotoMatchIn) -> tuple[str, str]:
    data = body.image.strip()
    media_type = body.media_type.strip().lower()
    if data.startswith("data:"):
        head, _, data = data.partition(",")
        media_type = head[5:].split(";")[0].strip().lower() or media_type
    if media_type not in MEDIA_TYPES:
        raise HTTPException(status_code=422, detail="Send the photo as JPEG, PNG or WebP.")
    if len(data) > MAX_PHOTO_CHARS:
        raise HTTPException(status_code=413, detail="The photo is too large.")
    try:
        base64.b64decode(data, validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(status_code=422, detail="The photo is not valid base64.") from None
    return media_type, data


@router.post("/photo-match", response_model=PhotoMatchOut)
async def photo_match(body: PhotoMatchIn, request: Request) -> PhotoMatchOut:
    media_type, photo = _clean_photo(body)
    products = await asyncio.to_thread(_staff_products, request)
    if not settings.ANTHROPIC_API_KEY:
        raise HTTPException(status_code=503, detail="Photo matching is not set up on the server yet.")

    refs, skipped = await asyncio.to_thread(_references, products)
    if not refs:
        return PhotoMatchOut(status="none", candidates=[], compared=0, skipped=skipped,
                             note="No product has a photo yet. Add photos on the Products tab.")
    try:
        answer = await _ask(refs, media_type, photo)
    except Exception as exc:
        logger.warning("사진 찾기 실패: %s", type(exc).__name__)
        raise HTTPException(status_code=503, detail=UNAVAILABLE) from None

    status, candidates = _decide(answer, {int(item["id"]) for item, _, _ in refs})
    note = str(answer.get("note") or "")[:300]
    return PhotoMatchOut(status=status, candidates=candidates, note=note, compared=len(refs), skipped=skipped)
