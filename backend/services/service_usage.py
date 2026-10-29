"""바깥 서비스 사용량·잔액 — 어드민 "Calls & SMS" 의 Usage 탭과 마케팅 캠페인 비용.

- Twilio: 계정 잔액(Balance), 이번 달 사용 기록(Usage Records ThisMonth), 문자 한 통의 실제 요금(Message.price).
  요금은 문자가 나간 뒤 몇 초~몇 분 지나야 붙는다. 그전에는 price 가 비어 "pending" 으로 센다.
- ElevenLabs: 구독(`/v1/user/subscription`) — 등급, 이번 주기 크레딧 사용·한도, 다음 리셋, 다음 청구.
  키에 `user_read` 권한이 있어야 한다. 없으면 그 이유를 그대로 화면에 보여 준다.
  통화 한 건의 비용은 대화 상세의 `metadata.cost`(크레딧).
- Fly: 조직의 결제 상태·크레딧(GraphQL)과 앱별 머신 상태·크기(Machines API). 달러 사용액은 Fly 가 API 로
  주지 않아서 대시보드 링크로 보낸다. 서버에 `FLY_API_TOKEN`(읽기 전용 조직 토큰)이 있어야 한다.

한 서비스가 실패해도 나머지는 보인다 — 서비스마다 {"ok": False, "error": "..."} 로 돌려준다.
"""

from __future__ import annotations

import asyncio
import logging
import os
from datetime import date, timedelta
from typing import Any, Iterable

import httpx

from backend.core.config import settings
from backend.services import voice_agent

logger = logging.getLogger(__name__)

TWILIO_API = "https://api.twilio.com/2010-04-01"
FLY_GRAPHQL = "https://api.fly.io/graphql"
FLY_MACHINES = "https://api.machines.dev/v1"
TIMEOUT = 15.0

#: 이번 달 사용 기록에서 화면에 보일 Twilio 항목. 나머지(0 원짜리 세부 항목)는 버린다.
TWILIO_CATEGORIES: dict[str, str] = {
    "sms-outbound": "Texts sent",
    "sms-inbound": "Texts received",
    "mms-outbound": "Picture texts sent (MMS)",
    "mms-inbound": "Picture texts received",
    "calls": "Phone calls",
    "phonenumbers": "Phone numbers",
    "sms-messages-carrierfees": "Carrier fees",
    "a2p-registration-fees": "A2P registration",
}

#: 값이 있으면 다시 묻지 않는다 — 한 번 붙은 요금은 바뀌지 않는다.
_twilio_prices: dict[str, dict[str, Any]] = {}
_call_costs: dict[str, float] = {}


def _money(value: Any) -> float | None:
    """Twilio 는 요금을 음수 문자열("-0.00830")로 준다. 양수로 바꾼다."""
    if value in (None, ""):
        return None
    try:
        return abs(float(value))
    except (TypeError, ValueError):
        return None


def _twilio_auth() -> tuple[str, str]:
    return settings.TWILIO_ACCOUNT_SID, settings.TWILIO_AUTH_TOKEN


def _twilio_ready() -> bool:
    return bool(settings.TWILIO_ACCOUNT_SID and settings.TWILIO_AUTH_TOKEN)


def _account_url(path: str) -> str:
    return f"{TWILIO_API}/Accounts/{settings.TWILIO_ACCOUNT_SID}{path}"


# ===== 캠페인 비용 =======================================================

async def twilio_message_prices(sids: Iterable[str], since: date, until: date) -> dict[str, dict[str, Any]]:
    """문자 sid → {price, unit, segments}. 요금이 아직 안 붙은 문자는 빠진다.

    한 통씩 묻지 않고 그 기간에 보낸 문자 목록을 1000 통씩 읽어 맞춘다(캠페인 500 명이면 요청 한두 번).
    """
    wanted = {sid for sid in sids if sid and sid not in _twilio_prices}
    if wanted and _twilio_ready():
        params: dict[str, Any] | None = {
            "DateSent>": since.isoformat(),
            "DateSent<": (until + timedelta(days=1)).isoformat(),
            "PageSize": 1000,
        }
        url: str | None = _account_url("/Messages.json")
        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            for _ in range(20):
                if not url or not wanted:
                    break
                res = await client.get(url, params=params, auth=_twilio_auth())
                res.raise_for_status()
                page = res.json()
                for item in page.get("messages") or []:
                    sid = item.get("sid")
                    price = _money(item.get("price"))
                    if sid in wanted and price is not None:
                        _twilio_prices[sid] = {
                            "price": price,
                            "unit": (item.get("price_unit") or "USD").upper(),
                            "segments": int(item.get("num_segments") or 1),
                        }
                        wanted.discard(sid)
                next_uri = page.get("next_page_uri")
                url = f"https://api.twilio.com{next_uri}" if next_uri else None
                params = None  # 다음 쪽 주소에 조건이 이미 들어 있다.
    return {sid: _twilio_prices[sid] for sid in sids if sid in _twilio_prices}


async def call_costs(conversation_ids: Iterable[str]) -> dict[str, float]:
    """ElevenLabs 대화 id → 크레딧. 통화가 아직 안 끝났거나 못 읽은 건 빠진다."""
    ids = [cid for cid in conversation_ids if cid]
    todo = [cid for cid in ids if cid not in _call_costs]
    gate = asyncio.Semaphore(5)

    async def one(cid: str) -> None:
        async with gate:
            try:
                detail = await voice_agent.get_conversation(cid)
            except voice_agent.VoiceAgentError:
                return
        metadata = detail.get("metadata") or {}
        cost = metadata.get("cost")
        if detail.get("status") == "done" and isinstance(cost, (int, float)):
            _call_costs[cid] = float(cost)

    await asyncio.gather(*(one(cid) for cid in todo))
    return {cid: _call_costs[cid] for cid in ids if cid in _call_costs}


# ===== Usage 탭 ==========================================================

async def twilio_usage() -> dict[str, Any]:
    if not _twilio_ready():
        return {"ok": False, "error": "Twilio is not set up on the server (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)."}
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        balance_res, month_res = await asyncio.gather(
            client.get(_account_url("/Balance.json"), auth=_twilio_auth()),
            client.get(_account_url("/Usage/Records/ThisMonth.json"), params={"PageSize": 1000},
                       auth=_twilio_auth()),
        )
    if balance_res.status_code >= 400 and month_res.status_code >= 400:
        return {"ok": False, "error": f"Twilio refused ({month_res.status_code}): "
                                      f"{(month_res.json() or {}).get('message', '')}"}
    balance = balance_res.json() if balance_res.status_code < 400 else {}
    records = (month_res.json() or {}).get("usage_records") or [] if month_res.status_code < 400 else []
    by_category = {r.get("category"): r for r in records}
    rows = []
    for category, label in TWILIO_CATEGORIES.items():
        r = by_category.get(category)
        if not r or (not _money(r.get("price")) and not float(r.get("count") or 0)):
            continue
        rows.append({
            "category": category,
            "label": label,
            "count": int(float(r.get("count") or 0)),
            "usage": float(r.get("usage") or 0),
            "usage_unit": r.get("usage_unit") or "",
            "price": _money(r.get("price")) or 0.0,
        })
    total = by_category.get("totalprice") or {}
    return {
        "ok": True,
        # 잔액이라 음수면 빚이다. 요금처럼 abs 하지 않는다.
        "balance": float(balance["balance"]) if balance.get("balance") is not None else None,
        "currency": (balance.get("currency") or total.get("price_unit") or "USD").upper(),
        "month_start": total.get("start_date"),
        "month_total": _money(total.get("price")) or 0.0,
        "month_unit": (total.get("price_unit") or "USD").upper(),
        "rows": rows,
        "console": "https://console.twilio.com/us1/billing/manage-billing/billing-overview",
    }


async def elevenlabs_usage() -> dict[str, Any]:
    key = voice_agent.api_key()
    if not key:
        return {"ok": False, "error": "ElevenLabs is not set up on the server (ELEVENLABS_API_KEY)."}
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        res = await client.get(f"{voice_agent.API_ROOT}/user/subscription", headers={"xi-api-key": key})
    if res.status_code >= 400:
        detail = (res.json() or {}).get("detail") if res.content else None
        message = detail.get("message") if isinstance(detail, dict) else str(detail or "")
        if "user_read" in (message or ""):
            return {"ok": False, "needs_permission": "user_read",
                    "error": "The ElevenLabs API key cannot read the subscription. In ElevenLabs → Developers → "
                             "API Keys, edit the key and turn on User → Read."}
        return {"ok": False, "error": f"ElevenLabs refused ({res.status_code}): {message}"[:300]}
    sub = res.json()
    invoice = sub.get("next_invoice") or {}
    return {
        "ok": True,
        "tier": sub.get("tier"),
        "status": sub.get("status"),
        "used": int(sub.get("character_count") or 0),
        "limit": int(sub.get("character_limit") or 0),
        "resets_at": sub.get("next_character_count_reset_unix"),
        "billing_period": sub.get("billing_period"),
        "currency": (sub.get("currency") or "usd").upper(),
        "next_invoice_cents": invoice.get("amount_due_cents"),
        "next_invoice_at": invoice.get("next_payment_attempt_unix"),
        "can_extend": bool(sub.get("can_extend_character_limit")),
        "console": "https://elevenlabs.io/app/subscription",
    }


def fly_org() -> str:
    return os.getenv("FLY_ORG", "smeag-kenneth-smeag-kenneth").strip()


async def fly_usage() -> dict[str, Any]:
    token = os.getenv("FLY_API_TOKEN", "").strip()
    if not token:
        return {"ok": False, "error": "Fly is not linked yet (FLY_API_TOKEN secret on pelham-hills-api)."}
    # 조직 토큰("FlyV1 ...")은 그대로, 사용자 토큰은 Bearer 로.
    auth = token if token.startswith("FlyV1 ") else f"Bearer {token}"
    headers = {"Authorization": auth}
    query = ("query($slug: String!) { organization(slug: $slug) { name billable billingStatus creditBalance "
             "isCreditCardSaved paidPlan apps { nodes { name status } } } }")
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        res = await client.post(FLY_GRAPHQL, json={"query": query, "variables": {"slug": fly_org()}},
                                headers=headers)
        body = res.json() if res.content else {}
        org = (body.get("data") or {}).get("organization")
        if res.status_code >= 400 or not org:
            errors = body.get("errors") or [{}]
            return {"ok": False, "error": f"Fly refused ({res.status_code}): {errors[0].get('message', '')}"[:300]}
        app_names = [a["name"] for a in (org.get("apps") or {}).get("nodes") or []]
        machine_lists = await asyncio.gather(
            *(client.get(f"{FLY_MACHINES}/apps/{name}/machines", headers=headers) for name in app_names),
            return_exceptions=True,
        )
    apps = []
    statuses = {a["name"]: a.get("status") for a in (org.get("apps") or {}).get("nodes") or []}
    for name, listed in zip(app_names, machine_lists):
        machines = []
        if isinstance(listed, httpx.Response) and listed.status_code < 400:
            for m in listed.json() or []:
                guest = (m.get("config") or {}).get("guest") or {}
                machines.append({
                    "id": m.get("id"),
                    "state": m.get("state"),
                    "region": m.get("region"),
                    "cpu_kind": guest.get("cpu_kind"),
                    "cpus": guest.get("cpus"),
                    "memory_mb": guest.get("memory_mb"),
                    "updated_at": m.get("updated_at"),
                })
        apps.append({"name": name, "status": statuses.get(name), "machines": machines})
    return {
        "ok": True,
        "org": org.get("name"),
        "billing_status": org.get("billingStatus"),
        # Fly 는 크레딧을 센트로 준다.
        "credit": (org.get("creditBalance") or 0) / 100,
        "card_saved": bool(org.get("isCreditCardSaved")),
        "paid_plan": bool(org.get("paidPlan")),
        "apps": apps,
        "console": f"https://fly.io/dashboard/{fly_org()}/billing",
    }


async def _safe(name: str, job: Any) -> dict[str, Any]:
    try:
        return await job
    except Exception as exc:  # 바깥 서비스가 잠시 꺼짐·응답 모양이 바뀜
        logger.warning("%s 사용량 읽기 실패: %s", name, exc)
        return {"ok": False, "error": f"Could not reach {name}. Try again in a moment."}


async def overview() -> dict[str, Any]:
    eleven, twilio, fly = await asyncio.gather(
        _safe("ElevenLabs", elevenlabs_usage()),
        _safe("Twilio", twilio_usage()),
        _safe("Fly", fly_usage()),
    )
    return {"elevenlabs": eleven, "twilio": twilio, "fly": fly}
