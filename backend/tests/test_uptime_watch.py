"""시스템 멈춤 알림(`scripts/uptime_watch.py`)의 판정: 처음 멈춤, 반복, 복구."""
from __future__ import annotations

import importlib.util
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

_spec = importlib.util.spec_from_file_location(
    "uptime_watch", Path(__file__).resolve().parents[2] / "scripts" / "uptime_watch.py")
uw = importlib.util.module_from_spec(_spec)
sys.modules["uptime_watch"] = uw  # dataclass 가 모듈을 찾는다
_spec.loader.exec_module(uw)

T0 = datetime(2026, 10, 28, 14, 0, tzinfo=timezone.utc)
ALL_OK = {t.key: None for t in uw.TARGETS}


def test_all_ok_sends_nothing():
    state: dict = {}
    assert uw.decide(state, ALL_OK, T0, 60) == []
    assert state == {}


def test_first_failure_alerts_once_then_repeats_hourly():
    state: dict = {}
    down = {**ALL_OK, "api": "HTTP 502"}
    first = uw.decide(state, down, T0, 60)
    assert len(first) == 1 and first[0].startswith("DOWN: Phone & text server") and "HTTP 502" in first[0]
    assert uw.decide(state, down, T0 + timedelta(minutes=5), 60) == []
    again = uw.decide(state, down, T0 + timedelta(minutes=60), 60)
    assert len(again) == 1 and again[0].startswith("STILL DOWN") and "1 h 0 min" in again[0]
    assert uw.decide(state, down, T0 + timedelta(minutes=65), 60) == []


def test_recovery_alerts_and_clears():
    state: dict = {}
    uw.decide(state, {**ALL_OK, "db": "TimeoutError"}, T0, 60)
    back = uw.decide(state, ALL_OK, T0 + timedelta(minutes=12), 60)
    assert back == ["BACK UP: Database (Supabase) is working again (was down 12 min)."]
    assert state == {}


def test_notify_dry_run(monkeypatch, capsys):
    monkeypatch.setenv("UPTIME_DRY_RUN", "1")
    assert uw.notify(["DOWN: x"]) is True
    assert "[Pelham] System DOWN" in capsys.readouterr().out
