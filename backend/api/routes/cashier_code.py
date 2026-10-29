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

## ID 확인 기록 (0095)
번호로 이름을 찾으면 (이름, 영업일)을 `pelham_shift_record_check` 로 적는다 — 리포트가 담당자 이름 옆에 "ID ✓" 를
붙이는 근거다. 번호는 적지 않는다. 0095 가 아직 안 돌았거나 기록이 실패해도 이름 찾기·승인은 그대로 된다.

## 승인 (0077)
환불·가격 변경 같은 막힌 일(0024)도 매니저 PIN 대신 그 직원의 ID 로 승인한다 — `POST /pos/approve`.
번호 확인은 여기서만 할 수 있어서, 승인 줄은 service_role 로 `pelham_shift_approve` 가 남긴다
(브라우저는 그 함수를 부를 수 없다). 틀린 번호도 적어 10분에 5번이면 막는다.

## 번호로 들어오기 (2026-10-28)
어드민 첫 화면은 숫자판이다 — `POST /pos/pin-login`. 맞는 Shift ID 면 이 서버가 공용 직원 계정
(0128 `pelham_staff_lock_settings.pin_email`, 기본 staff@pelhamhills.ca)의 세션을 받아 돌려준다. 매니저 이상은
첫 화면의 "Manager sign in" 으로 자기 이메일·비밀번호를 친다.
세션은 비밀번호 없이 service_role 로 받는다(로그인 링크를 만들어 바로 확인) — 그래서 그 계정의 비밀번호는
Supabase 에만 있고, Supabase 에서 바꿔도 이 서버는 손댈 것이 없다. 계정 주소도 0128 표 한 칸이라 배포 없이 바뀐다.
로그인 전에 열린 창구라 틀린 번호는 주소마다 10분에 10번이면 막는다(기계 메모리 — 재시작하면 풀린다).
"""

from __future__ import annotations

import logging
import os
import threading
import time
from collections import defaultdict, deque

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
    _record_check(name[:80])
    return CashierCodeOut(name=name[:80])


def _record_check(name: str | None) -> None:
    """그날 이 이름이 Shift ID 로 확인됐다고 적는다(0095). 실패해도 막지 않는다."""
    if not name:
        return
    try:
        supabase_rest.rpc("pelham_shift_record_check", {"p_name": name})
    except (supabase_rest.RpcRefused, supabase_rest.SupabaseUnavailable):
        logger.warning("staff id check not recorded (0095 missing?)")


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
    _record_check(name)
    return result if isinstance(result, dict) else {"approved": False, "message": "Try again."}


# ===== 번호로 들어오기 =====================================================

PIN_EMAIL = "staff@pelhamhills.ca"
PIN_WINDOW_S = 600
PIN_MAX_MISSES = 10

_misses: dict[str, deque[float]] = defaultdict(deque)
_misses_lock = threading.Lock()


class PinLoginIn(BaseModel):
    code: str = Field(pattern=r"^\d{4,8}$")


def _client_ip(request: Request) -> str:
    # Fly 앞단이 붙이는 진짜 주소. 없으면 연결 주소.
    ip = (request.headers.get("fly-client-ip") or "").strip()
    return ip or (request.client.host if request.client else "")


def _recent_misses(ip: str, now: float) -> deque[float]:
    misses = _misses[ip]
    while misses and now - misses[0] > PIN_WINDOW_S:
        misses.popleft()
    return misses


def _pin_email() -> str:
    """숫자판으로 들어갈 계정(0128). 표가 아직 없거나 못 읽으면 기본값."""
    try:
        rows = supabase_rest.select("pelham_staff_lock_settings", {"select": "pin_email", "id": "eq.true"})
    except supabase_rest.SupabaseUnavailable:
        return PIN_EMAIL
    email = str((rows[0] if rows else {}).get("pin_email") or "").strip().lower()
    return email or PIN_EMAIL


def _mint_session(email: str) -> dict:
    """그 계정의 세션을 비밀번호 없이 받는다: service_role 로 로그인 링크를 만들고(메일은 나가지 않는다)
    그 토큰을 바로 확인한다. GoTrue 의 토큰 응답을 그대로 돌려준다."""
    url, service_key = supabase_rest._config()
    public_key = (os.getenv("SUPABASE_PUBLISHABLE_KEY") or "").strip() or supabase_rest._DEFAULT_PUBLISHABLE_KEY
    if not url or not service_key:
        raise HTTPException(status_code=503, detail="Sign-in is not set up on the server.")
    try:
        link = httpx.post(
            f"{url}/auth/v1/admin/generate_link",
            json={"type": "magiclink", "email": email},
            headers={"apikey": service_key, "Authorization": f"Bearer {service_key}"},
            timeout=10.0,
        )
        if not link.is_success:
            logger.warning("staff pin link refused: HTTP %s", link.status_code)
            raise HTTPException(status_code=503, detail="The staff account can't sign in. Ask a manager.")
        body = link.json() if link.content else {}
        # GoTrue 버전에 따라 맨 위 또는 properties 안에 있다.
        token_hash = body.get("hashed_token") or (body.get("properties") or {}).get("hashed_token")
        if not token_hash:
            raise HTTPException(status_code=503, detail="The staff account can't sign in. Ask a manager.")
        verified = httpx.post(
            f"{url}/auth/v1/verify",
            json={"type": "magiclink", "token_hash": token_hash},
            headers={"apikey": public_key},
            timeout=10.0,
        )
    except httpx.HTTPError as exc:
        logger.warning("staff pin sign-in failed: %s", type(exc).__name__)
        raise HTTPException(status_code=503, detail="Can't reach the sign-in server. Try again.") from None
    if not verified.is_success:
        logger.warning("staff pin verify refused: HTTP %s", verified.status_code)
        raise HTTPException(status_code=503, detail="The staff account can't sign in. Ask a manager.")
    session = verified.json() if verified.content else {}
    return session if isinstance(session, dict) else {}


@router.post("/pin-login")
def pin_login(body: PinLoginIn, request: Request) -> dict:
    ip = _client_ip(request)
    with _misses_lock:
        if len(_recent_misses(ip, time.time())) >= PIN_MAX_MISSES:
            raise HTTPException(status_code=429, detail="Too many wrong IDs. Wait 10 minutes.")

    found = _lookup(body.code)
    if found.get("ambiguous"):
        raise HTTPException(
            status_code=409,
            detail="More than one Pelham Shift team uses this ID. Ask a manager to set PELHAM_SHIFT_TEAM.",
        )
    name = " ".join(str(found.get("name") or "").split())[:80]
    if not name:
        with _misses_lock:
            _recent_misses(ip, time.time()).append(time.time())
        raise HTTPException(status_code=404, detail="No staff member has that ID.")

    email = _pin_email()
    token = _mint_session(email)
    _record_check(name)
    return {
        "access_token": token.get("access_token"),
        "refresh_token": token.get("refresh_token"),
        "expires_in": token.get("expires_in"),
        "user": {"id": (token.get("user") or {}).get("id"), "email": email},
        "name": name,
    }
