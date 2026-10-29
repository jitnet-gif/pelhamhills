"""**시스템 멈춤 알림** — 앱·서버·DB 가 응답하지 않으면 문자와 이메일을 보낸다.

왜(2026-10-28): 클럽이 시스템이 멈추면 문자와 이메일로 알기를 원했다. 감시하는 쪽이 감시받는
쪽 안에 있으면 같이 멈추므로, 이 스크립트는 Fly·Vercel·Supabase 어디에도 없이 GitHub Actions
(`.github/workflows/uptime.yml`)에서 5분마다 돈다. 문자는 Fly 서버를 거치지 않고 Twilio 로 바로,
이메일은 Gmail SMTP 로 바로 보낸다.

## 판정
- 대상마다 3번 묻는다(15초 간격). 3번 다 실패해야 멈춤이다 — 한 번 끊긴 것으로 깨우지 않는다.
- 멈춤이 처음 보이면 알림, 계속 멈춰 있으면 `UPTIME_REPEAT_MIN`(기본 60)분마다 다시, 돌아오면 복구 알림.
- 지난 상태는 `UPTIME_STATE` 파일(JSON)에 둔다. 워크플로가 실행 사이에 캐시로 이어 준다.

## 설정 (GitHub Actions secrets — `scripts/set_uptime_secrets.sh` 가 Fly 에서 옮겨 준다)
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER` — Fly 와 같은 값.
- `UPTIME_SMS_TO` — 문자 받을 번호, 쉼표로(+1905…).
- `UPTIME_SMTP_USER`, `UPTIME_SMTP_PASSWORD` — 보내는 Gmail 과 앱 비밀번호(영수증 메일과 같은 계정).
- `UPTIME_EMAIL_TO` — 받는 메일, 쉼표로. 기본 analysis@pelhamhills.ca, jitnet57@gmail.com.

    python scripts/uptime_watch.py           # 한 번 확인하고 필요하면 알린다
    python scripts/uptime_watch.py --test    # 확인 없이 시험 알림 하나를 보낸다
    UPTIME_DRY_RUN=1 python scripts/uptime_watch.py   # 보내지 않고 화면에만
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import smtplib
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from email.mime.text import MIMEText
from pathlib import Path
from zoneinfo import ZoneInfo

CLUB_TZ = ZoneInfo("America/Toronto")
SUPABASE = "https://yxpiwwgquyaxjubovzmi.supabase.co"
# 화면이 쓰는 공개 키(frontend 에도 들어 있다). auth 헬스 체크에 apikey 가 있어야 한다.
SUPABASE_PUBLISHABLE = "sb_publishable_oMJG_-xpWr6AI5o3KnrU_A_kJENaKSY"


@dataclass(frozen=True)
class Target:
    key: str
    name: str
    url: str
    headers: tuple[tuple[str, str], ...] = ()
    expect: str = ""  # 응답 본문에 있어야 하는 글자. 비면 200 이면 된다.


TARGETS = (
    Target("app", "Pro shop app (tee sheet / POS)", "https://pelhamhills-golf.vercel.app/teesheet"),
    Target("api", "Phone & text server (Fly)", "https://pelham-hills-api.fly.dev/", expect='"online"'),
    Target("db", "Database (Supabase)", f"{SUPABASE}/auth/v1/health",
           headers=(("apikey", SUPABASE_PUBLISHABLE),)),
    Target("gps", "GPS cart app", "https://golf-gps-pelhamhills-seven.vercel.app/"),
)


def _list(name: str, default: str = "") -> list[str]:
    return [p.strip() for p in (os.getenv(name) or default).split(",") if p.strip()]


def check_once(t: Target, timeout: float = 15) -> str | None:
    """정상이면 None, 아니면 짧은 이유."""
    req = urllib.request.Request(t.url, headers={"User-Agent": "pelham-uptime/1", **dict(t.headers)})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read(4096).decode("utf-8", "replace")
            if resp.status != 200:
                return f"HTTP {resp.status}"
            if t.expect and t.expect not in body:
                return "unexpected reply"
            return None
    except urllib.error.HTTPError as exc:
        return f"HTTP {exc.code}"
    except Exception as exc:  # 시간 초과, DNS, 연결 거부
        return type(exc).__name__


def check(t: Target, tries: int = 3, gap: float = 15) -> str | None:
    reason = None
    for i in range(tries):
        reason = check_once(t)
        if reason is None:
            return None
        if i < tries - 1:
            time.sleep(gap)
    return reason


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat(timespec="seconds")


def _parse(s: str) -> datetime:
    return datetime.fromisoformat(s)


def _clock(dt: datetime) -> str:
    return dt.astimezone(CLUB_TZ).strftime("%b %d %H:%M")


def _span(delta: timedelta) -> str:
    mins = max(1, int(delta.total_seconds() // 60))
    return f"{mins} min" if mins < 60 else f"{mins // 60} h {mins % 60} min"


def decide(state: dict, results: dict[str, str | None], now: datetime, repeat_min: int) -> list[str]:
    """상태를 고치고 보낼 알림 줄을 돌려준다(대상마다 한 줄)."""
    lines: list[str] = []
    for t in TARGETS:
        if t.key not in results:
            continue
        reason = results[t.key]
        prev = state.get(t.key)
        if reason is None:
            if prev:
                lines.append(f"BACK UP: {t.name} is working again (was down {_span(now - _parse(prev['down_since']))}).")
                state.pop(t.key, None)
            continue
        if not prev:
            state[t.key] = {"down_since": _iso(now), "last_alert": _iso(now)}
            lines.append(f"DOWN: {t.name} is not responding ({reason}) since {_clock(now)}.")
        elif now - _parse(prev["last_alert"]) >= timedelta(minutes=repeat_min):
            prev["last_alert"] = _iso(now)
            lines.append(f"STILL DOWN: {t.name} ({reason}) for {_span(now - _parse(prev['down_since']))}.")
    return lines


def send_sms(text: str) -> bool:
    sid = os.getenv("TWILIO_ACCOUNT_SID", "").strip()
    token = os.getenv("TWILIO_AUTH_TOKEN", "").strip()
    sender = os.getenv("TWILIO_PHONE_NUMBER", "").strip()
    to = _list("UPTIME_SMS_TO")
    if not (sid and token and sender and to):
        print("sms skipped: Twilio secrets or UPTIME_SMS_TO missing", file=sys.stderr)
        return False
    auth = base64.b64encode(f"{sid}:{token}".encode()).decode()
    ok = True
    for number in to:
        data = urllib.parse.urlencode({"From": sender, "To": number, "Body": text[:1500]}).encode()
        req = urllib.request.Request(
            f"https://api.twilio.com/2010-04-01/Accounts/{sid}/Messages.json",
            data=data, headers={"Authorization": f"Basic {auth}"})
        try:
            urllib.request.urlopen(req, timeout=20).close()
        except Exception as exc:
            ok = False
            print(f"sms to …{number[-4:]} failed: {exc}", file=sys.stderr)
    return ok


def send_email(subject: str, text: str) -> bool:
    user = os.getenv("UPTIME_SMTP_USER", "").strip()
    password = os.getenv("UPTIME_SMTP_PASSWORD", "").replace(" ", "")
    to = _list("UPTIME_EMAIL_TO", "analysis@pelhamhills.ca,jitnet57@gmail.com")
    if not (user and password and to):
        print("email skipped: UPTIME_SMTP_USER/PASSWORD missing", file=sys.stderr)
        return False
    msg = MIMEText(text + "\n", "plain", "utf-8")
    msg["Subject"] = subject
    msg["From"] = user
    msg["To"] = ", ".join(to)
    try:
        with smtplib.SMTP("smtp.gmail.com", 587, timeout=20) as server:
            server.starttls()
            server.login(user, password)
            server.sendmail(user, to, msg.as_string())
        return True
    except Exception as exc:
        print(f"email failed: {type(exc).__name__}", file=sys.stderr)
        return False


def notify(lines: list[str]) -> bool:
    if lines[0].startswith("TEST"):
        subject = "[Pelham] Test alert"
    elif any(line.startswith(("DOWN", "STILL DOWN")) for line in lines):
        subject = "[Pelham] System DOWN"
    else:
        subject = "[Pelham] System back up"
    sms = "Pelham Hills: " + " ".join(lines)
    email = "\n".join(lines) + "\n\nChecked from GitHub Actions every 5 minutes."
    if os.getenv("UPTIME_DRY_RUN"):
        print(f"[dry run] {subject}\n{sms}")
        return True
    # 둘 다 실패하면 실행을 실패로 끝내 GitHub 이 저장소 주인에게 메일을 보내게 한다.
    sms_ok = send_sms(sms)
    email_ok = send_email(subject, email)
    return sms_ok or email_ok


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--test", action="store_true", help="send one test alert and exit")
    args = ap.parse_args()
    if args.test:
        ok = notify([f"TEST: system alerts are set up ({_clock(datetime.now(timezone.utc))}). No action needed."])
        return 0 if ok else 1

    path = Path(os.getenv("UPTIME_STATE", ".uptime/state.json"))
    try:
        state = json.loads(path.read_text())
    except (OSError, ValueError):
        state = {}
    results = {t.key: check(t) for t in TARGETS}
    for t in TARGETS:
        print(f"{t.key:4} {results[t.key] or 'ok'}")
    lines = decide(state, results, datetime.now(timezone.utc), int(os.getenv("UPTIME_REPEAT_MIN") or 60))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(state))
    if lines and not notify(lines):
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
