"""Stripe 대사 리포트 — Reports 의 "Stripe check" 탭.

GET /payments/reconcile?from=YYYY-MM-DD&to=YYYY-MM-DD (영업일, America/Toronto, 최대 31일)

1. 직원인가(요청의 Supabase 토큰 → SQL). Stripe 를 부르기 전에 본다.
2. Stripe: 그 기간에 만든 PaymentIntent 와 환불을 전부 읽는다.
3. 우리: `pelham_staff_stripe_records`(0027)에 기간과 Stripe 에서 본 id 들을 넘긴다.
4. 한쪽에만 있는 PaymentIntent(자정에 걸친 것, 지난 결제의 오늘 환불)는 Stripe 에 하나씩 다시 묻는다.
5. 결정 기록(0089 `pelham_staff_reconcile_decisions`) — 상세 창에서 매출로 반영·환불·그대로 둠을 정한 것.
6. `stripe_reconcile.reconcile` 이 짝을 맞추고 문제를 적는다.

읽기만 한다. 고치는 일은 상세 창(`ReconcileDetail.tsx`)이 SQL·단말기 환불로 한다.

GET /payments/stripe-fees?from=…&to=… (최대 92일) — 영업일별 Stripe 수수료. Daily close 의 Total in Bank
(카드 매출 − 수수료)와 회계 통합 문서의 For Bookkeeper 시트가 쓴다(2026-10-28).
"""

from __future__ import annotations

import logging
from datetime import date, datetime, time, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

from fastapi import APIRouter, HTTPException, Query, Request

from backend.api.routes import terminal
from backend.services import stripe_gateway as sg
from backend.services import stripe_reconcile

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/payments", tags=["Card Terminal"])

CLUB_TZ = ZoneInfo("America/Toronto")
MAX_DAYS = 31
# 기간 밖의 PaymentIntent 를 하나씩 물어보는 최대 수. 넘으면 `unchecked` 로 알린다.
MAX_LOOKUPS = 150


def _day(value: str, name: str) -> date:
    try:
        return date.fromisoformat(value)
    except ValueError:
        raise HTTPException(status_code=422, detail=f"'{name}' must be a date (YYYY-MM-DD).") from None


def _window(start: date, end: date) -> tuple[datetime, datetime]:
    """영업일 [start, end] → UTC [시작, 끝). 서머타임이 바뀌는 날도 그 날의 자정을 쓴다."""
    lo = datetime.combine(start, time.min, CLUB_TZ).astimezone(timezone.utc)
    hi = datetime.combine(end + timedelta(days=1), time.min, CLUB_TZ).astimezone(timezone.utc)
    return lo, hi


def _decisions(request: Request, by_pi: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """PaymentIntent 별 마지막 결정. 0089 를 아직 돌리지 않았으면(함수 없음) 결정 없이 맞춘다."""
    if not by_pi:
        return {}
    try:
        found = terminal._as_staff(request, "pelham_staff_reconcile_decisions", {"p_ids": sorted(by_pi)})
    except HTTPException as exc:
        if exc.status_code in (401, 403):
            raise
        logger.info("대사 결정 기록을 읽지 못함 (%s): %s", exc.status_code, exc.detail)
        return {}
    return found if isinstance(found, dict) else {}


@router.get("/reconcile")
def reconcile(
    request: Request,
    date_from: str = Query(alias="from"),
    date_to: str = Query(alias="to"),
) -> dict[str, Any]:
    start, end = _day(date_from, "from"), _day(date_to, "to")
    if end < start:
        raise HTTPException(status_code=422, detail="'to' is before 'from'.")
    if (end - start).days + 1 > MAX_DAYS:
        raise HTTPException(status_code=422, detail=f"Pick {MAX_DAYS} days or fewer.")
    terminal._require_stripe()
    terminal._require_staff(request)

    lo, hi = _window(start, end)
    window = (int(lo.timestamp()), int(hi.timestamp()))
    try:
        intents, more_intents = sg.payment_intents_created(*window)
        refunds, more_refunds = sg.refunds_created(*window)
    except sg.StripeError as exc:
        raise HTTPException(status_code=502, detail=f"Stripe: {exc.message}") from None

    by_pi = {str(pi.get("id")): pi for pi in intents if pi.get("id")}
    ids: set[str] = set(by_pi)
    for pi in intents:
        meta = pi.get("metadata") or {}
        if meta.get("invoice"):
            ids.add(str(meta["invoice"]).upper())
    for r in refunds:
        if r.get("id"):
            ids.add(str(r["id"]))
        if r.get("payment_intent"):
            ids.add(str(r["payment_intent"]))

    records = terminal._as_staff(request, "pelham_staff_stripe_records", {
        "p_from": lo.isoformat(), "p_to": hi.isoformat(), "p_ids": sorted(ids)}) or {}

    # 기간 밖에서 만든 PaymentIntent: 오늘 환불한 지난 결제, 자정 근처에 걸친 판매.
    wanted: list[str] = []
    for r in refunds:
        if r.get("payment_intent"):
            wanted.append(str(r["payment_intent"]))
    for t in records.get("terminal") or []:
        if t.get("kind") == "sale" and t.get("payment_intent"):
            wanted.append(str(t["payment_intent"]))
    for o in records.get("online") or []:
        if str(o.get("trans_id") or "").startswith("pi_"):
            wanted.append(str(o["trans_id"]))
    missing = [pi for pi in dict.fromkeys(wanted) if pi not in by_pi]
    unchecked = max(0, len(missing) - MAX_LOOKUPS)
    for pi_id in missing[:MAX_LOOKUPS]:
        try:
            by_pi[pi_id] = sg.payment_intent_raw(pi_id)
        except sg.StripeError as exc:
            if exc.status == 404:
                continue  # Stripe 에 없다 → 우리 쪽만 있는 기록으로 남는다.
            raise HTTPException(status_code=502, detail=f"Stripe: {exc.message}") from None

    result = stripe_reconcile.reconcile(list(by_pi.values()), records, window, _decisions(request, by_pi))
    keyed = records.get("keyed") or {"count": 0, "amount": 0}
    return {
        "environment": sg.environment(),
        "from": start.isoformat(),
        "to": end.isoformat(),
        "window": {"from": lo.isoformat().replace("+00:00", "Z"), "to": hi.isoformat().replace("+00:00", "Z")},
        "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "summary": result["summary"],
        "rows": result["rows"],
        "attempts": result["attempts"],
        "keyed": keyed,
        # 다 읽지 못했다(2,000 건 넘음 또는 하나씩 묻는 한도). 화면이 기간을 줄이라고 알린다.
        "truncated": bool(more_intents or more_refunds or unchecked),
        "unchecked": unchecked,
    }


FEES_MAX_DAYS = 92


@router.get("/stripe-fees")
def stripe_fees(
    request: Request,
    date_from: str = Query(alias="from"),
    date_to: str = Query(alias="to"),
) -> dict[str, Any]:
    start, end = _day(date_from, "from"), _day(date_to, "to")
    if end < start:
        raise HTTPException(status_code=422, detail="'to' is before 'from'.")
    if (end - start).days + 1 > FEES_MAX_DAYS:
        raise HTTPException(status_code=422, detail=f"Pick {FEES_MAX_DAYS} days or fewer.")
    terminal._require_stripe()
    terminal._require_staff(request)

    lo, hi = _window(start, end)
    try:
        txns, more = sg.balance_transactions_created(int(lo.timestamp()), int(hi.timestamp()))
    except sg.StripeError as exc:
        raise HTTPException(status_code=502, detail=f"Stripe: {exc.message}") from None
    return {
        "environment": sg.environment(),
        "from": start.isoformat(),
        "to": end.isoformat(),
        "fees": stripe_reconcile.fees_by_day(txns, CLUB_TZ),
        # 2,000 건을 넘어 다 읽지 못했다 — 수수료가 모자라게 나온다. 화면이 알린다.
        "truncated": more,
    }
