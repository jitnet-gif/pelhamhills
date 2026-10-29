"""바깥 서비스 사용량 — 어드민 "Calls & SMS" 의 Usage 탭.

GET /usage    ElevenLabs 구독·크레딧, Twilio 잔액·이번 달 사용, Fly 결제 상태·머신

잔액과 청구 금액이라 매니저·마케팅 명단 계정만 본다(`pelham_staff_marketing_access`, 0047).
읽는 일은 `backend/services/service_usage.py` 가 한다. 바깥 API 를 매번 세 곳 부르지 않게 1분 담아 둔다.
"""

from __future__ import annotations

import asyncio
import time
from typing import Any

from fastapi import APIRouter, HTTPException, Request

from backend.api.routes import terminal
from backend.services import service_usage

router = APIRouter(prefix="/usage", tags=["Usage"])

CACHE_SECONDS = 60
_cache: dict[str, Any] = {"at": 0.0, "value": None}


@router.get("")
async def usage(request: Request, fresh: bool = False) -> dict[str, Any]:
    allowed = await asyncio.to_thread(terminal._as_staff, request, "pelham_staff_marketing_access", {})
    if not allowed:
        raise HTTPException(status_code=403, detail="Only the manager and marketing accounts can see usage and bills.")
    if fresh or not _cache["value"] or time.monotonic() - _cache["at"] > CACHE_SECONDS:
        _cache["value"] = await service_usage.overview()
        _cache["at"] = time.monotonic()
    return {**_cache["value"], "checked_at": int(time.time() - (time.monotonic() - _cache["at"]))}
