"""Hope(AI 매니저 대화, `/ai-marketing/chat`)와 나레이션 톤·속도.

Claude 와 Supabase 는 가짜로 바꾼다 — 도구를 부르고, 숫자를 찾아보고, 화면에 넘길 동작을 모으는지 본다.
서버가 문자·팝업을 직접 실행하지 않는 것(동작으로만 넘기는 것)도 확인한다.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from backend.api.routes import ai_marketing as ai


class FakeRequest:
    headers = {"authorization": "Bearer staff-token"}


def text_block(text):
    return SimpleNamespace(type="text", text=text)


def tool_block(name, args, block_id="t1"):
    return SimpleNamespace(type="tool_use", name=name, input=args, id=block_id)


class FakeClaude:
    def __init__(self, replies):
        self.replies = list(replies)
        self.calls = []
        self.beta = SimpleNamespace(messages=SimpleNamespace(create=self.create))

    async def create(self, **kwargs):
        # 서버는 같은 messages 목록에 계속 덧붙인다 — 부른 순간의 모습을 남긴다.
        self.calls.append({**kwargs, "messages": list(kwargs["messages"])})
        return self.replies.pop(0)


@pytest.fixture
def env(monkeypatch):
    rpcs = []

    def fake_rpc_as(token, function, args):
        rpcs.append((token, function, args))
        if function == "pelham_staff_ai_marketing_access":
            return True
        if function == "pelham_staff_ai_marketing_summary":
            return {"from": args["p_from"], "to": args["p_to"], "rounds": 84, "bookings": 30, "no_shows": 2,
                    "paid_bills": 41, "net_sales": 412345, "bill_discount": 0}
        if function == "pelham_marketing_audience":
            return {"phones": 512}
        if function == "pelham_staff_ai_manager_log_save":
            return {"id": "log-1"}
        raise AssertionError(function)

    monkeypatch.setattr(ai.supabase_rest, "rpc_as", fake_rpc_as)
    monkeypatch.setattr(ai.settings, "ANTHROPIC_API_KEY", "test-key")
    return rpcs


def run(coro):
    return asyncio.run(coro)


def test_today_question_looks_up_numbers_and_logs(env, monkeypatch):
    claude = FakeClaude([
        SimpleNamespace(stop_reason="tool_use", content=[tool_block("club_numbers", {"from": "2026-10-26", "to": "2026-10-26"})]),
        SimpleNamespace(stop_reason="end_turn", content=[text_block("오늘은 서른 팀, 여든네 명이 예약했고 매출은 약 사천백이십삼 달러예요.")]),
    ])
    monkeypatch.setattr(ai, "_client", claude)
    body = ai.ChatIn(messages=[{"role": "user", "text": "오늘 예약이랑 매출 알려 줘"}], lang="ko")

    out = run(ai.chat(body, FakeRequest()))

    assert out["reply"].startswith("오늘은")
    assert out["lookups"] == [{"from": "2026-10-26", "to": "2026-10-26", "rounds": 84, "bookings": 30, "no_shows": 2,
                               "paid_bills": 41, "net_sales": 412345, "bill_discount": 0}]
    assert out["actions"] == []
    assert out["log_id"] == "log-1"
    # 숫자는 직원 토큰으로 읽는다(명단 밖이면 SQL 이 거절).
    assert ("staff-token", "pelham_staff_ai_marketing_summary", {"p_from": "2026-10-26", "p_to": "2026-10-26"}) in env
    assert "Korean" in claude.calls[0]["system"][0]["text"]
    assert claude.calls[0]["messages"][0]["content"][0]["text"].startswith("(Today is ")


def test_send_text_is_only_proposed(env, monkeypatch):
    launch = {"report_id": "r1", "strategy": 1, "title": "Weekday twilight", "segment": "regulars",
              "sms": "Pelham Hills: twilight $35 Mon-Thu with code DUSK. Book at pelhamhills.com by Nov 9.",
              "popup": True, "popup_title": "Twilight $35", "popup_body": "Mon-Thu after 3 PM.",
              "popup_link_label": "Book a tee time", "popup_link": "/book/tee-time", "days": 14}
    claude = FakeClaude([
        SimpleNamespace(stop_reason="tool_use", content=[tool_block("text_reach", {"segment": "regulars"}, "a"),
                                                         tool_block("propose_launch", launch, "b")]),
        SimpleNamespace(stop_reason="end_turn", content=[text_block("단골 오백열두 분께 보낼까요?")]),
    ])
    monkeypatch.setattr(ai, "_client", claude)
    body = ai.ChatIn(messages=[{"role": "user", "text": "1번 전략 문자로 보내 줘"}], lang="ko")

    out = run(ai.chat(body, FakeRequest()))

    assert out["actions"] == [{"type": "launch", **launch}]
    tool_results = claude.calls[1]["messages"][-1]["content"]
    assert '"can_receive": 512' in tool_results[0]["content"]
    assert "Nothing is sent" in tool_results[1]["content"]
    # 서버는 캠페인도 팝업도 만들지 않았다.
    assert not any(name.startswith("pelham_marketing_campaign") or "site_notice" in name for _, name, _ in env)


def test_bad_tool_input_goes_back_to_claude_as_error(env, monkeypatch):
    claude = FakeClaude([
        SimpleNamespace(stop_reason="tool_use", content=[tool_block("club_numbers", {"from": "yesterday", "to": "today"})]),
        SimpleNamespace(stop_reason="end_turn", content=[text_block("Sorry, let me try that again.")]),
    ])
    monkeypatch.setattr(ai, "_client", claude)
    out = run(ai.chat(ai.ChatIn(messages=[{"role": "user", "text": "sales?"}]), FakeRequest()))
    result = claude.calls[1]["messages"][-1]["content"][0]
    assert result["is_error"] is True and "YYYY-MM-DD" in result["content"]
    assert out["lookups"] == []


def test_conversation_must_end_with_the_manager():
    with pytest.raises(HTTPException) as caught:
        ai._chat_messages([ai.ChatTurn(role="user", text="hi"), ai.ChatTurn(role="assistant", text="Hello")], "today")
    assert caught.value.status_code == 400


def test_launch_needs_a_text_or_a_popup():
    with pytest.raises(ValueError):
        ai._launch_action({"sms": "", "popup": False, "popup_title": ""})


def test_voice_settings_follow_tone_and_speed():
    assert ai._voice_settings(ai.NarrateIn(text="hi")) == {}
    assert ai._voice_settings(ai.NarrateIn(text="hi", tone="lively", speed=1.2)) == {
        "stability": 0.3, "style": 0.45, "speed": 1.2}
    with pytest.raises(ValueError):
        ai.NarrateIn(text="hi", speed=1.5)
