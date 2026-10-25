"""**지켜보는 계정 알림** — proshop@ 이 어드민·계산대 화면을 열거나 파일을 내려받으면 메일을 보낸다.

왜(2026-10-24): 클럽이 proshop@pelhamhills.ca 가 앱에서 무엇을 보고 무엇을 내려받는지 analysis@ 와
jitnet57@gmail.com 이 메일로 알기를 원했다. 백업·내려받기 자체는 0102 가 막는다. 이것은 기록·알림이다.

## 순서
1. 화면(`frontend/lib/activityWatch.ts`)이 지켜보는 계정일 때만 `POST /staff/activity` 를 부른다.
2. 여기서는 그 말을 믿지 않는다 — 요청의 Supabase 토큰으로 이메일을 Supabase Auth 에 물어,
   `ACTIVITY_WATCH_EMAILS` 에 있을 때만 보낸다. 다른 계정이면 조용히 `{sent: false}`.
3. Gmail SMTP 로 보낸다. 실패해도 화면은 막지 않는다.

## 설정 (Fly 환경변수)
- `ACTIVITY_SMTP_USER`, `ACTIVITY_SMTP_PASSWORD` — 보내는 Gmail(Workspace) 계정과 앱 비밀번호. 없으면 보내지 않는다.
- `ACTIVITY_SMTP_HOST` / `ACTIVITY_SMTP_PORT` — 기본 smtp.gmail.com / 587.
- `ACTIVITY_ALERT_TO` — 받는 사람, 쉼표로. 기본 analysis@pelhamhills.ca, jitnet57@gmail.com.
- `ACTIVITY_WATCH_EMAILS` — 지켜볼 계정, 쉼표로. 기본 proshop@pelhamhills.ca.
"""

from __future__ import annotations

import logging
import os
import smtplib
from datetime import datetime
from email.mime.text import MIMEText
from zoneinfo import ZoneInfo

from fastapi import APIRouter, BackgroundTasks, HTTPException, Request
from pydantic import BaseModel, Field

from backend.services import supabase_rest

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/staff", tags=["Staff"])

CLUB_TZ = ZoneInfo("America/Toronto")


def _list(name: str, default: str) -> list[str]:
    raw = os.getenv(name) or default
    return [part.strip().lower() for part in raw.split(",") if part.strip()]


def watched() -> list[str]:
    return _list("ACTIVITY_WATCH_EMAILS", "proshop@pelhamhills.ca")


def recipients() -> list[str]:
    return _list("ACTIVITY_ALERT_TO", "analysis@pelhamhills.ca,jitnet57@gmail.com")


class ActivityIn(BaseModel):
    kind: str = Field(pattern=r"^(view|download)$")
    path: str = Field(min_length=1, max_length=300)
    title: str = Field(default="", max_length=200)
    detail: str = Field(default="", max_length=300)


def _token(request: Request) -> str:
    header = request.headers.get("authorization") or ""
    return header[7:].strip() if header.lower().startswith("bearer ") else ""


def _clean(value: str) -> str:
    return " ".join(value.split())


def _send(email: str, body: ActivityIn, ip: str) -> None:
    user = (os.getenv("ACTIVITY_SMTP_USER") or "").strip()
    password = (os.getenv("ACTIVITY_SMTP_PASSWORD") or "").replace(" ", "")
    to = recipients()
    if not user or not password or not to:
        logger.warning("activity alert not sent: ACTIVITY_SMTP_USER/PASSWORD not set")
        return
    at = datetime.now(CLUB_TZ).strftime("%Y-%m-%d %H:%M:%S")
    what = "downloaded a file" if body.kind == "download" else "opened a screen"
    title = _clean(body.title)
    detail = _clean(body.detail)
    lines = [
        f"{email} {what} in the Pelham Hills app.",
        "",
        f"When:   {at} (Toronto)",
        f"Screen: {title + '  ' if title else ''}{_clean(body.path)}",
    ]
    if detail:
        lines.append(f"{'File' if body.kind == 'download' else 'Detail'}:   {detail}")
    if ip:
        lines.append(f"IP:     {ip}")
    msg = MIMEText("\n".join(lines) + "\n", "plain", "utf-8")
    subject_what = f"downloaded {detail}" if body.kind == "download" and detail else f"opened {title or _clean(body.path)}"
    msg["Subject"] = f"[Pelham] {email} {subject_what}"[:200]
    msg["From"] = user
    msg["To"] = ", ".join(to)
    try:
        with smtplib.SMTP(os.getenv("ACTIVITY_SMTP_HOST") or "smtp.gmail.com",
                          int(os.getenv("ACTIVITY_SMTP_PORT") or "587"), timeout=20) as server:
            server.starttls()
            server.login(user, password)
            server.sendmail(user, to, msg.as_string())
    except Exception as exc:
        logger.warning("activity alert 메일 실패: %s", type(exc).__name__)


@router.post("/activity")
def activity(body: ActivityIn, request: Request, background: BackgroundTasks) -> dict:
    try:
        email = supabase_rest.auth_email(_token(request))
    except supabase_rest.RpcRefused as exc:
        raise HTTPException(status_code=exc.status, detail=exc.message) from None
    except supabase_rest.SupabaseUnavailable:
        raise HTTPException(status_code=503, detail="Can't check the sign-in right now.") from None
    if email not in watched():
        return {"sent": False}
    forwarded = (request.headers.get("fly-client-ip") or request.headers.get("x-forwarded-for") or "").split(",")[0].strip()
    ip = forwarded or (request.client.host if request.client else "")
    background.add_task(_send, email, body, ip)
    return {"sent": True}
