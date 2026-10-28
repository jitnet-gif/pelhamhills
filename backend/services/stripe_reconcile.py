"""Stripe 대사: Stripe 가 받은·돌려준 카드 돈과 우리 기록(0027 `pelham_staff_stripe_records`)을 맞춘다.

한 줄 = PaymentIntent(`pi_…`) 하나. 짝을 찾는 순서:
  1) pi_ 가 같다 (단말기 `payment_intent`, 온라인 `trans_id`).
  2) Stripe metadata 로 — 단말기 `terminal_txn`(우리 줄 id), 온라인 `invoice`(PHW…).
     PaymentIntent 를 만든 뒤 우리 줄에 적기 전에 끊긴 경우가 여기서 잡힌다.

본다(돈이 있는 것만): Stripe 가 받은 금액 = 우리가 받았다고 적은 금액, Stripe 환불 합계 = 우리 환불 합계,
그리고 계산서 상태 — 카드는 그대로인데 전산에서는 환불됨, 승인됐는데 어느 계산서에도 안 붙음 같은 것.

수준: error = 돈이 어긋났다(누가 손을 봐야 한다). warn = 돈은 맞지만 기록이 덜 끝났거나 직접 확인할 것.
금액은 모두 센트. 여기는 네트워크를 쓰지 않는다 — 라우트(`routes/reconcile.py`)가 모아서 넘긴다.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional

# Stripe 에 돈이 들어온 상태. requires_capture 는 승인만 된 것(우리는 자동 캡처라 보통 지나간다).
MONEY_STATUSES = {"succeeded", "requires_capture"}
# 온라인 결제 중 카드에서 돈이 빠져나간 적이 있는 상태.
ONLINE_CHARGED = {"approved", "refunded", "orphaned"}
REFUND_OK = {"succeeded", "pending"}


def money(cents: int) -> str:
    sign = "-" if cents < 0 else ""
    return f"{sign}${abs(cents) / 100:,.2f}"


def _charge(pi: dict[str, Any]) -> dict[str, Any]:
    charge = pi.get("latest_charge")
    return charge if isinstance(charge, dict) else {}


def _stripe_side(pi: dict[str, Any]) -> dict[str, Any]:
    charge = _charge(pi)
    details = charge.get("payment_method_details") or {}
    kind = str(details.get("type") or "")
    method = details.get(kind) or {}
    status = str(pi.get("status") or "")
    received = int(pi.get("amount_received") or 0)
    if status == "requires_capture":
        received = int(pi.get("amount_capturable") or pi.get("amount") or 0)
    return {
        "payment_intent": str(pi.get("id") or ""),
        "charge": str(charge.get("id") or ""),
        "status": status,
        "created": int(pi.get("created") or 0),
        "amount": received if status in MONEY_STATUSES else 0,
        "refunded": int(charge.get("amount_refunded") or 0),
        "disputed": bool(charge.get("disputed")),
        "method": kind,
        "card_brand": str(method.get("brand") or ("interac" if kind == "interac_present" else "")),
        "card_last4": str(method.get("last4") or ""),
        "description": str(pi.get("description") or ""),
        "metadata": dict(pi.get("metadata") or {}),
    }


def _issue(level: str, code: str, message: str) -> dict[str, str]:
    return {"level": level, "code": code, "message": message}


def _terminal_ours(sale: dict[str, Any], refunds: list[dict[str, Any]]) -> dict[str, Any]:
    ok_refunds = [r for r in refunds if r.get("approved")]
    return {
        "source": "terminal",
        "id": sale.get("id"),
        "status": sale.get("result"),
        "approved": bool(sale.get("approved")),
        "amount": int(sale.get("total_amount") or 0) if sale.get("approved") else 0,
        "tip": int(sale.get("tip") or 0) if sale.get("approved") else 0,
        "refunded": sum(int(r.get("total_amount") or 0) for r in ok_refunds),
        "refund_ids": [r.get("transaction_id") for r in ok_refunds if r.get("transaction_id")],
        "pending_refunds": sum(1 for r in refunds if r.get("result") == "pending"),
        "created_at": sale.get("created_at"),
        "bill_id": sale.get("bill_id"),
        "bill_status": sale.get("bill_status"),
        "receipt_no": sale.get("receipt_no"),
        "business_date": sale.get("business_date"),
        "station": sale.get("station"),
        "card_brand": sale.get("card_brand"),
        "card_last4": sale.get("card_last4"),
        "card_type": sale.get("card_type"),
        "on_bill": sale.get("bill_payment_id") is not None,
        "voided": sale.get("voided_at") is not None,
        "pay_total": (int(sale.get("pay_amount") or 0) + int(sale.get("pay_tip") or 0))
                     if sale.get("pay_amount") is not None else None,
        "label": f"Register sale #{sale.get('id')}",
    }


def _online_ours(row: dict[str, Any]) -> dict[str, Any]:
    status = str(row.get("status") or "")
    amount = int(row.get("amount") or 0)
    return {
        "source": "online",
        "id": row.get("id"),
        "invoice": row.get("invoice"),
        "status": status,
        "approved": status in ONLINE_CHARGED,
        "amount": amount if status in ONLINE_CHARGED else 0,
        "refunded": amount if status == "refunded" and row.get("refund_kind") != "void" else 0,
        "refund_ids": [row["refund_trans_id"]] if row.get("refund_trans_id") else [],
        "pending_refunds": 0,
        "created_at": row.get("created_at"),
        "bill_id": row.get("bill_id"),
        "bill_status": row.get("bill_status"),
        "receipt_no": row.get("receipt_no"),
        "business_date": row.get("business_date"),
        "station": "online",
        "card_brand": row.get("card_brand"),
        "card_last4": row.get("card_last4"),
        "customer_name": row.get("customer_name"),
        "confirmation_code": row.get("confirmation_code"),
        "label": f"Online {row.get('kind') or ''} {row.get('confirmation_code') or row.get('invoice') or ''}".strip(),
    }


def _check(stripe: Optional[dict[str, Any]], ours: Optional[dict[str, Any]]) -> list[dict[str, str]]:
    issues: list[dict[str, str]] = []
    s_amount = stripe["amount"] if stripe else 0
    s_refunded = stripe["refunded"] if stripe else 0
    o_amount = ours["amount"] if ours else 0
    o_refunded = ours["refunded"] if ours else 0

    if s_amount and not ours:
        issues.append(_issue("error", "stripe_only",
                             f"Stripe charged {money(s_amount)} but there is no matching record here."))
    elif s_amount and not o_amount:
        issues.append(_issue("error", "not_recorded",
                             f"Stripe charged {money(s_amount)} but this is '{ours['status']}' here."))
    elif o_amount and not s_amount:
        why = "Stripe has no such payment" if not stripe else f"Stripe shows it as '{stripe['status']}'"
        issues.append(_issue("error", "ours_only",
                             f"Recorded as paid {money(o_amount)} here, but {why}."))
    elif s_amount != o_amount:
        issues.append(_issue("error", "amount",
                             f"Amount differs: Stripe {money(s_amount)}, ours {money(o_amount)}."))

    if (s_amount or o_amount) and s_refunded != o_refunded:
        if s_refunded > o_refunded:
            issues.append(_issue("error", "refund_stripe_only",
                                 f"Stripe refunded {money(s_refunded)} but our records show {money(o_refunded)}."))
        else:
            issues.append(_issue("error", "refund_ours_only",
                                 f"Our records show {money(o_refunded)} refunded but Stripe refunded {money(s_refunded)}."))

    if stripe and stripe["disputed"]:
        issues.append(_issue("error", "disputed", "The customer disputed this charge (chargeback). Check Stripe."))

    if not ours or not o_amount:
        return issues

    net = (s_amount or o_amount) - max(s_refunded, o_refunded)
    bill = ours.get("bill_status")
    if ours["source"] == "terminal":
        if ours.get("pending_refunds"):
            issues.append(_issue("warn", "refund_pending",
                                 "A refund on the reader is still pending. Open the bill to finish it."))
        if not ours["on_bill"] and not ours["voided"] and net > 0:
            if bill == "open":
                issues.append(_issue("warn", "bill_open",
                                     f"Card charged {money(net)} but the bill is still open (not finished)."))
            else:
                issues.append(_issue("error", "not_on_bill",
                                     f"Card charged {money(net)} but it is not a payment on any bill."))
        if ours["on_bill"] and ours.get("pay_total") is not None and ours["pay_total"] != o_amount:
            issues.append(_issue("warn", "bill_line",
                                 f"The bill payment line is {money(ours['pay_total'])} but the card charge "
                                 f"was {money(o_amount)}."))
    elif ours["status"] == "orphaned":
        issues.append(_issue("error", "orphaned",
                             "Paid online but could not be booked. It must be refunded to the guest."))

    if bill == "refunded" and net > 0 and (ours["source"] == "online" or ours["on_bill"]):
        issues.append(_issue("error", "bill_refunded_card_not",
                             f"The bill was refunded here, but {money(net)} is still on the card in Stripe."))
    if bill == "paid" and net <= 0 and (ours["source"] == "online" or ours["on_bill"]):
        issues.append(_issue("warn", "card_refunded_bill_paid",
                             "The card was refunded in full, but the bill still shows paid."))
    return issues


def reconcile(
    intents: list[dict[str, Any]],
    records: dict[str, Any],
    window: tuple[int, int],
    decisions: Optional[dict[str, dict[str, Any]]] = None,
) -> dict[str, Any]:
    """intents: Stripe PaymentIntent(latest_charge 펼친 것). records: 0027 의 결과. window: [시작, 끝) epoch.
    decisions: PaymentIntent 별 마지막 결정(0089). 'note'(그대로 둠)로 정한 줄은 Reviewed — 문제 수에서 빠진다.

    돌려주는 것: {rows, summary, attempts}. rows 는 문제 있는 것부터(error → warn → ok), 같은 수준에서는 시간순.
    """
    decisions = decisions or {}
    terminal = list(records.get("terminal") or [])
    online = list(records.get("online") or [])

    sales_by_pi: dict[str, dict[str, Any]] = {}
    sales_by_id: dict[str, dict[str, Any]] = {}
    refunds_by_sale: dict[Any, list[dict[str, Any]]] = {}
    for t in terminal:
        if t.get("kind") == "sale":
            if t.get("payment_intent"):
                sales_by_pi[str(t["payment_intent"])] = t
            sales_by_id[str(t.get("id"))] = t
        elif t.get("kind") == "refund":
            refunds_by_sale.setdefault(t.get("refund_of"), []).append(t)
    online_by_pi = {str(o["trans_id"]): o for o in online if o.get("trans_id")}
    online_by_invoice = {str(o["invoice"]): o for o in online if o.get("invoice")}

    used_sales: set[str] = set()
    used_online: set[str] = set()
    rows: list[dict[str, Any]] = []
    attempts: list[dict[str, Any]] = []

    def ours_for(pi_id: str, meta: dict[str, Any]) -> Optional[dict[str, Any]]:
        sale = sales_by_pi.get(pi_id) or sales_by_id.get(str(meta.get("terminal_txn") or ""))
        if sale and str(sale.get("id")) not in used_sales:
            used_sales.add(str(sale.get("id")))
            return _terminal_ours(sale, refunds_by_sale.get(sale.get("id"), []))
        row = online_by_pi.get(pi_id) or online_by_invoice.get(str(meta.get("invoice") or "").upper())
        if row and str(row.get("id")) not in used_online:
            used_online.add(str(row.get("id")))
            return _online_ours(row)
        return None

    for pi in intents:
        stripe = _stripe_side(pi)
        if not stripe["payment_intent"]:
            continue
        ours = ours_for(stripe["payment_intent"], stripe["metadata"])
        if not stripe["amount"] and not stripe["refunded"] and not (ours and ours["amount"]):
            # 돈이 오가지 않은 시도(거절·취소·버려진 Checkout). Stripe 대시보드에 Canceled·Incomplete 로 보이므로
            # 대사에는 넣지 않고 따로 돌려준다.
            if window[0] <= stripe["created"] < window[1]:
                attempts.append(_attempt(pi, stripe, ours))
            continue
        rows.append(_row(stripe, ours, decisions.get(stripe["payment_intent"])))

    # Stripe 에서 찾지 못한 우리 기록.
    for sale in sales_by_id.values():
        if str(sale.get("id")) in used_sales:
            continue
        ours = _terminal_ours(sale, refunds_by_sale.get(sale.get("id"), []))
        if ours["amount"] or sale.get("result") == "pending":
            rows.append(_row(None, ours))
    for row in online:
        if str(row.get("id")) in used_online:
            continue
        ours = _online_ours(row)
        if ours["amount"]:
            rows.append(_row(None, ours))

    order = {"error": 0, "warn": 1, "ok": 2}
    rows.sort(key=lambda r: (order[r["level"]], r["at"] or ""))

    start, end = window
    summary = {
        "stripe_charged": sum(r["stripe"]["amount"] for r in rows if r["stripe"]),
        "stripe_refunded": sum(r["stripe"]["refunded"] for r in rows if r["stripe"]),
        "ours_charged": sum(r["ours"]["amount"] for r in rows if r["ours"]),
        "ours_refunded": sum(r["ours"]["refunded"] for r in rows if r["ours"]),
        "errors": sum(1 for r in rows if r["level"] == "error"),
        "warnings": sum(1 for r in rows if r["level"] == "warn"),
        "matched": sum(1 for r in rows if r["level"] == "ok" and not r["reviewed"]),
        "reviewed": sum(1 for r in rows if r["reviewed"]),
        "rows": len(rows),
        "outside_window": sum(1 for r in rows if r["stripe"] and not start <= r["stripe"]["created"] < end),
    }
    summary["attempts"] = len(attempts)
    summary["attempts_amount"] = sum(a["amount"] for a in attempts)
    voided = [r for r in rows if r["ours"] and r["ours"].get("voided")]
    summary["voided"] = len(voided)
    summary["voided_amount"] = sum(r["stripe"]["amount"] if r["stripe"] else r["ours"]["amount"] for r in voided)
    summary["stripe_net"] = summary["stripe_charged"] - summary["stripe_refunded"]
    summary["ours_net"] = summary["ours_charged"] - summary["ours_refunded"]
    summary["difference"] = summary["stripe_net"] - summary["ours_net"]
    attempts.sort(key=lambda a: a["created"])
    return {"rows": rows, "summary": summary, "attempts": attempts}


# 카드에서 돈이 빠지지 않은 PaymentIntent 상태 → 사람이 읽는 이름.
ATTEMPT_LABELS = {
    "canceled": "Canceled",
    "requires_payment_method": "Declined / not finished",
    "requires_confirmation": "Not finished",
    "requires_action": "Not finished",
    "processing": "Processing",
}


def _attempt(pi: dict[str, Any], stripe: dict[str, Any], ours: Optional[dict[str, Any]]) -> dict[str, Any]:
    error = pi.get("last_payment_error") or {}
    meta = stripe.get("metadata") or {}
    return {
        "payment_intent": stripe["payment_intent"],
        "created": stripe["created"],
        "at": datetime.fromtimestamp(stripe["created"], tz=timezone.utc).isoformat().replace("+00:00", "Z"),
        "status": stripe["status"],
        "status_label": ATTEMPT_LABELS.get(stripe["status"], stripe["status"] or "Unknown"),
        "amount": int(pi.get("amount") or 0),
        "reason": str(pi.get("cancellation_reason") or error.get("decline_code") or error.get("code") or ""),
        "message": str(error.get("message") or ""),
        "source": ours["source"] if ours else ("terminal" if meta.get("terminal_txn") else
                                               "online" if meta.get("invoice") else "unknown"),
        "card_brand": stripe["card_brand"],
        "card_last4": stripe["card_last4"],
        "label": ours["label"] if ours else str(pi.get("description") or ""),
    }


def _row(stripe: Optional[dict[str, Any]], ours: Optional[dict[str, Any]],
         decision: Optional[dict[str, Any]] = None) -> dict[str, Any]:
    issues = _check(stripe, ours)
    level = "error" if any(i["level"] == "error" for i in issues) else "warn" if issues else "ok"
    # 그대로 두기로 정했다(이유와 승인한 직원이 남아 있다). 어긋남은 그대로 보이되 문제로 세지 않는다.
    reviewed = bool(issues) and bool(decision) and decision.get("decision") == "note"
    if reviewed:
        level = "ok"
    at = None
    if stripe and stripe["created"]:
        at = datetime.fromtimestamp(stripe["created"], tz=timezone.utc).isoformat().replace("+00:00", "Z")
    elif ours:
        at = ours.get("created_at")
    meta = (stripe or {}).get("metadata") or {}
    source = ours["source"] if ours else ("terminal" if meta.get("terminal_txn") else
                                          "online" if meta.get("invoice") else "unknown")
    return {
        "key": (stripe or {}).get("payment_intent") or f"{ours['source']}-{ours['id']}",
        "source": source,
        "at": at,
        "level": level,
        "issues": issues,
        "stripe": stripe,
        "ours": ours,
        "decision": decision,
        "reviewed": reviewed,
    }


# ===== 수수료 (Daily close 의 Total in Bank, 회계 For Bookkeeper) ==============

def fees_by_day(txns: list[dict[str, Any]], tz: Any) -> dict[str, int]:
    """잔액 거래 → 영업일(클럽 시간대)별 Stripe 수수료 합계(센트). 정산(payout)은 돈이 옮겨 갈 뿐이라 뺀다."""
    out: dict[str, int] = {}
    for txn in txns:
        if txn.get("type") == "payout":
            continue
        fee = int(txn.get("fee") or 0)
        if not fee:
            continue
        day = datetime.fromtimestamp(int(txn.get("created") or 0), tz=timezone.utc).astimezone(tz).date().isoformat()
        out[day] = out.get(day, 0) + fee
    return out
