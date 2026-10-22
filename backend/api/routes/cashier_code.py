"""계산대 **담당자(Cashier) 코드** — pelham-shift 직원 ID 로 누가 받는지 정한다.

계산대의 Cashier 칸에 이름 대신 pelham-shift 의 직원 ID(출퇴근 단말에 치는 숫자 4~8자리)를 치면,
그 번호의 직원 이름이 담당자로 들어간다. 담당자별 마감과 팁 나누기는 지금처럼 그 이름으로 묶인다(0010).

## 순서
1. 직원인지 본다 — 요청의 Supabase 토큰을 그대로 SQL 에 넘긴다(`terminal.py` 와 같은 확인).
   로그인하지 않은 사람이 번호를 넣어 보며 직원 이름을 캐지 못하게.
2. pelham-shift 의 `GET /api/birth-login?id=<번호>` 에 묻는다. 정확히 한 명일 때만 `{name}` 이 온다.
   같은 번호가 여러 팀에 있으면 `{ambiguous: true}` — 이때는 `PELHAM_SHIFT_TEAM` 으로 팀을 정해 둔다.

브라우저가 pelham-shift 에 직접 묻지 않는 것은 그쪽이 CORS 를 열어 두지 않았기 때문이다.

## 설정 (Fly 환경변수, 둘 다 선택)
- `PELHAM_SHIFT_URL`  — 기본 https://pelham-shift.vercel.app
- `PELHAM_SHIFT_TEAM` — pelham-shift 워크스페이스 id. 비우면 모든 팀에서 찾는다.

## 승인 (0077)
환불·가격 변경 같은 막힌 일(0024)도 매니저 PIN 대신 그 직원의 ID 로 승인한다 — `POST /pos/approve`.
번호 확인은 여기서만 할 수 있어서, 승인 줄은 service_role 로 `pelham_shift_approve` 가 남긴다
(브라우저는 그 함수를 부를 수 없다). 틀린 번호도 적어 10분에 5번이면 막는다.
"""

from __future__ import annotations

import logging
import os

import httpx
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from backend.services import supabase_rest

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/pos", tags=["Retail"])

SHIFT_URL = (os.getenv("PELHAM_SHIFT_URL") or "https://pelham-shift.vercel.app").strip().rstrip("/")
SHIFT_TEAM = (os.getenv("PELHAM_SHIFT_TEAM") or "").strip()

UNAVAILABLE = "Can't reach Pelham Shift right now. Type your name instead."


class CashierCodeIn(BaseModel):
    code: str = Field(pattern=r"^\d{4,8}$")


class CashierCodeOut(BaseModel):
    name: str


class ApproveIn(BaseModel):
    code: str = Field(pattern=r"^\d{4,8}$")
    action: str = Field(min_length=1, max_length=40)
    ref: str = Field(min_length=1, max_length=200)


def _token(request: Request) -> str:
    header = request.headers.get("authorization") or ""
    return header[7:].strip() if header.lower().startswith("bearer ") else ""


def _require_staff(request: Request) -> None:
    """직원인가. 줄이 없는 계산서(-1)의 단말 진행 목록을 물어 SQL 의 직원 확인만 탄다."""
    try:
        supabase_rest.rpc_as(_token(request), "pelham_staff_terminal_in_flight", {"p_bill": -1})
    except supabase_rest.RpcRefused as exc:
        raise HTTPException(status_code=exc.status, detail=exc.message) from None
    except supabase_rest.SupabaseUnavailable:
        raise HTTPException(status_code=503, detail=UNAVAILABLE) from None


def _lookup(code: str) -> dict:
    params = {"id": code}
    if SHIFT_TEAM:
        params["team"] = SHIFT_TEAM
    try:
        response = httpx.get(f"{SHIFT_URL}/api/birth-login", params=params, timeout=8.0)
        response.raise_for_status()
        body = response.json()
    except (httpx.HTTPError, ValueError) as exc:
        logger.warning("pelham-shift lookup failed: %s", type(exc).__name__)
        raise HTTPException(status_code=503, detail=UNAVAILABLE) from None
    return body if isinstance(body, dict) else {}


@router.post("/cashier-code", response_model=CashierCodeOut)
def cashier_code(body: CashierCodeIn, request: Request) -> CashierCodeOut:
    _require_staff(request)
    found = _lookup(body.code)
    if found.get("ambiguous"):
        raise HTTPException(
            status_code=409,
            detail="More than one Pelham Shift team uses this ID. Ask a manager to set PELHAM_SHIFT_TEAM.",
        )
    name = " ".join(str(found.get("name") or "").split())
    if not name:
        raise HTTPException(status_code=404, detail="No staff member has that Pelham Shift ID.")
    return CashierCodeOut(name=name[:80])


def _staff_id(request: Request) -> str:
    """직원 확인과 그 계정의 uid 를 한 번에."""
    try:
        uid = supabase_rest.rpc_as(_token(request), "pelham_staff_my_id", {})
    except supabase_rest.RpcRefused as exc:
        raise HTTPException(status_code=exc.status, detail=exc.message) from None
    except supabase_rest.SupabaseUnavailable:
        raise HTTPException(status_code=503, detail=UNAVAILABLE) from None
    if not isinstance(uid, str) or not uid:
        raise HTTPException(status_code=401, detail="Sign in with a pro shop account.")
    return uid


@router.post("/approve")
def approve(body: ApproveIn, request: Request) -> dict:
    uid = _staff_id(request)
    found = _lookup(body.code)
    if found.get("ambiguous"):
        raise HTTPException(
            status_code=409,
            detail="More than one Pelham Shift team uses this ID. Ask a manager to set PELHAM_SHIFT_TEAM.",
        )
    name = " ".join(str(found.get("name") or "").split())[:80] or None
    try:
        result = supabase_rest.rpc(
            "pelham_shift_approve",
            {"p_uid": uid, "p_name": name, "p_action": body.action, "p_ref": body.ref},
        )
    except supabase_rest.RpcRefused as exc:
        raise HTTPException(status_code=exc.status, detail=exc.message) from None
    except supabase_rest.SupabaseUnavailable:
        raise HTTPException(status_code=503, detail="Can't save the approval right now. Try again.") from None
    return result if isinstance(result, dict) else {"approved": False, "message": "Try again."}
