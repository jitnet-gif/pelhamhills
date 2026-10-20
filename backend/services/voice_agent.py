"""ElevenLabs Agents Platform 클라이언트.

`backend/services/tts.py` 는 텍스트를 음성으로 바꾸는 단방향 API 였다. 이 파일은
그것과 다른 제품을 다룬다 — 손님과 말을 주고받으며 **우리 서버의 도구를 호출하는**
대화형 에이전트다. 예약과 취소가 실제로 일어나는 곳은 `api/routes/voice.py` 이고,
여기는 그 에이전트를 만들고, 고치고, 브라우저가 붙을 티켓을 끊어 주는 일만 한다.

HTTP 를 직접 쓰는 이유: 백엔드에 이미 `httpx` 가 있고(`tts.py`), `elevenlabs`
파이썬 SDK 를 requirements 에 더 얹으면 배포 이미지가 커진다. 우리가 쓰는
엔드포인트는 다섯 개뿐이다.
"""

from __future__ import annotations

import logging
import os
from typing import Any

import httpx

logger = logging.getLogger(__name__)

API_ROOT = "https://api.elevenlabs.io/v1"
TIMEOUT_SECONDS = 30.0

#: `tts.py` 가 쓰는 것과 같은 자리표시자. 이 값이면 키가 없는 것으로 친다.
_PLACEHOLDER_KEYS = {"", "your-elevenlabs-key", "sk_your_key_here"}


class VoiceAgentError(RuntimeError):
    """ElevenLabs 가 거절했다. 메시지에 API 응답 본문을 그대로 담는다.

    에이전트 설정 페이로드는 필드가 많고 스키마가 자주 바뀐다. 우리 쪽에서
    "요청 실패" 로 뭉개면 무엇이 틀렸는지 알 길이 없어, 응답을 그대로 올린다.
    """


def api_key() -> str:
    key = os.getenv("ELEVENLABS_API_KEY", "").strip()
    return "" if key in _PLACEHOLDER_KEYS else key


def agent_id() -> str:
    return os.getenv("ELEVENLABS_AGENT_ID", "").strip()


def require_api_key() -> str:
    key = api_key()
    if not key:
        raise VoiceAgentError(
            "ELEVENLABS_API_KEY is not set. Put it in the repo-root .env (which is gitignored)."
        )
    return key


def _headers() -> dict[str, str]:
    return {"xi-api-key": require_api_key(), "Content-Type": "application/json"}


def _raise_for_status(response: httpx.Response, what: str) -> None:
    if response.is_success:
        return
    raise VoiceAgentError(f"{what} failed: {response.status_code} {response.text}")


# ===== 동기 호출 (스크립트용) =========================================
# 에이전트 동기화는 `scripts/elevenlabs_sync_agent.py` 가 CLI 로 돌린다.
# 이벤트 루프를 띄울 이유가 없어 동기 클라이언트를 쓴다.

def _sync_request(method: str, path: str, **kwargs: Any) -> Any:
    with httpx.Client(timeout=TIMEOUT_SECONDS) as client:
        response = client.request(method, f"{API_ROOT}{path}", headers=_headers(), **kwargs)
    _raise_for_status(response, f"{method} {path}")
    return response.json() if response.content else {}


def list_tools() -> list[dict[str, Any]]:
    """계정에 등록된 도구 전부. 이름으로 기존 도구를 찾아 덮어쓰기 위해 쓴다."""
    payload = _sync_request("GET", "/convai/tools")
    tools = payload.get("tools", payload) if isinstance(payload, dict) else payload
    return tools if isinstance(tools, list) else []


def create_tool(tool_config: dict[str, Any]) -> str:
    payload = _sync_request("POST", "/convai/tools", json={"tool_config": tool_config})
    tool_id = payload.get("id") or payload.get("tool_id")
    if not tool_id:
        raise VoiceAgentError(f"Tool was created but no id came back: {payload}")
    return str(tool_id)


def update_tool(tool_id: str, tool_config: dict[str, Any]) -> str:
    _sync_request("PATCH", f"/convai/tools/{tool_id}", json={"tool_config": tool_config})
    return tool_id


def upsert_tool(tool_config: dict[str, Any], existing: list[dict[str, Any]]) -> tuple[str, bool]:
    """이름이 같은 도구가 있으면 고치고, 없으면 만든다. `(tool_id, created)`.

    이름으로 짝을 맞추는 이유는 이 저장소가 tool_id 를 보관하지 않기 때문이다.
    `ops/elevenlabs/agent.json` 이 유일한 원본이고, 계정 쪽은 그 사본이다.
    """
    name = tool_config["name"]
    for tool in existing:
        config = tool.get("tool_config") or tool
        if config.get("name") == name:
            found = tool.get("id") or tool.get("tool_id")
            if found:
                return update_tool(str(found), tool_config), False
    return create_tool(tool_config), True


def create_agent(body: dict[str, Any]) -> str:
    payload = _sync_request("POST", "/convai/agents/create", json=body)
    new_id = payload.get("agent_id") or payload.get("id")
    if not new_id:
        raise VoiceAgentError(f"Agent was created but no agent_id came back: {payload}")
    return str(new_id)


def update_agent(existing_agent_id: str, body: dict[str, Any]) -> str:
    _sync_request("PATCH", f"/convai/agents/{existing_agent_id}", json=body)
    return existing_agent_id


def get_agent(existing_agent_id: str) -> dict[str, Any]:
    return _sync_request("GET", f"/convai/agents/{existing_agent_id}")


def assign_phone_number(phone_number_id: str, target_agent_id: str) -> dict[str, Any]:
    """구매해 둔 전화번호를 이 에이전트에 연결한다.

    번호 자체는 Twilio 에서 사고 ElevenLabs 에 등록해야 한다 — 그 부분은 이
    저장소 밖의 계정 작업이다. 여기서는 "이미 등록된 번호를 어느 에이전트에
    붙일지" 만 정한다.
    """
    return _sync_request(
        "PATCH", f"/convai/phone-numbers/{phone_number_id}", json={"agent_id": target_agent_id}
    )


def list_phone_numbers() -> list[dict[str, Any]]:
    payload = _sync_request("GET", "/convai/phone-numbers")
    return payload if isinstance(payload, list) else payload.get("phone_numbers", [])


# ===== 비동기 호출 (요청 처리용) ======================================

async def signed_url(target_agent_id: str) -> str:
    """브라우저가 이 에이전트에 붙을 때 쓰는 일회용 주소.

    이게 있어야 API 키를 프론트엔드로 내보내지 않고도 위젯이 대화를 시작할 수 있다.
    """
    async with httpx.AsyncClient(timeout=TIMEOUT_SECONDS) as client:
        response = await client.get(
            f"{API_ROOT}/convai/conversation/get-signed-url",
            params={"agent_id": target_agent_id},
            headers={"xi-api-key": require_api_key()},
        )
    _raise_for_status(response, "get-signed-url")

    payload = response.json()
    url = payload.get("signed_url") or payload.get("signedUrl")
    if not url:
        raise VoiceAgentError(f"No signed_url in the response: {payload}")
    return str(url)


# ===== 통화 기록 (Calls & SMS 화면) ====================================
# 키에 `convai_read` 권한이 있어야 한다. 없으면 ElevenLabs 가 401 을 돌려주고
# 그 본문이 VoiceAgentError 에 그대로 실린다.

async def list_conversations(cursor: str | None = None, page_size: int = 30) -> dict[str, Any]:
    """이 에이전트의 통화 목록(최근 것부터). 요약과 쓴 도구 이름까지 받는다."""
    params: dict[str, Any] = {"page_size": page_size, "summary_mode": "include"}
    if agent_id():
        params["agent_id"] = agent_id()
    if cursor:
        params["cursor"] = cursor
    async with httpx.AsyncClient(timeout=TIMEOUT_SECONDS) as client:
        response = await client.get(
            f"{API_ROOT}/convai/conversations", params=params,
            headers={"xi-api-key": require_api_key()},
        )
    _raise_for_status(response, "list conversations")
    return response.json()


async def get_conversation(conversation_id: str) -> dict[str, Any]:
    """통화 한 건 — 녹취(도구 호출·결과 포함), 메타데이터, 분석."""
    async with httpx.AsyncClient(timeout=TIMEOUT_SECONDS) as client:
        response = await client.get(
            f"{API_ROOT}/convai/conversations/{conversation_id}",
            headers={"xi-api-key": require_api_key()},
        )
    _raise_for_status(response, "get conversation")
    return response.json()


async def conversation_audio(conversation_id: str) -> tuple[bytes, str]:
    """통화 녹음 `(본문, content-type)`. 몇 분짜리 mp3 라 통째로 받아 넘긴다."""
    async with httpx.AsyncClient(timeout=60.0) as client:
        response = await client.get(
            f"{API_ROOT}/convai/conversations/{conversation_id}/audio",
            headers={"xi-api-key": require_api_key()},
        )
    _raise_for_status(response, "get conversation audio")
    return response.content, response.headers.get("content-type", "audio/mpeg")


# ===== 발신 전화 (마케팅) ==============================================
# 고객 마케팅(`api/routes/marketing.py`)이 프로모션 전화를 건다. 에이전트의 Twilio 번호로
# ElevenLabs 가 직접 걸고, 손님이 받으면 에이전트가 말한다.

def marketing_agent_id() -> str:
    """프로모션 전화를 거는 에이전트. 예약 에이전트로 대신하지 않는다 — 그 에이전트는 "전화 주셔서
    감사합니다"로 시작하고 프로모션 내용({{promo_message}})도 수신거부 도구도 모른다. 없으면 전화가 꺼진다."""
    return os.getenv("ELEVENLABS_MARKETING_AGENT_ID", "").strip()


def outbound_phone_number_id() -> str:
    """발신에 쓸 ElevenLabs 전화번호 id (`scripts/elevenlabs_sync_agent.py --phones` 로 확인)."""
    return os.getenv("ELEVENLABS_PHONE_NUMBER_ID", "").strip()


async def outbound_call(to_number: str, dynamic_variables: dict[str, Any]) -> dict[str, Any]:
    """전화를 건다. `{conversation_id, callSid}` — 걸리기만 하면 성공이고, 받았는지는 통화 기록에 남는다.

    `dynamic_variables` 는 에이전트 프롬프트의 `{{이름}}` 자리에 들어간다
    (`ops/elevenlabs/marketing_agent_prompt.md`).
    """
    body = {
        "agent_id": marketing_agent_id(),
        "agent_phone_number_id": outbound_phone_number_id(),
        "to_number": to_number,
        "conversation_initiation_client_data": {"dynamic_variables": dynamic_variables},
    }
    async with httpx.AsyncClient(timeout=TIMEOUT_SECONDS) as client:
        response = await client.post(
            f"{API_ROOT}/convai/twilio/outbound-call", json=body, headers=_headers(),
        )
    _raise_for_status(response, "outbound call")
    payload = response.json() if response.content else {}
    if payload.get("success") is False:
        raise VoiceAgentError(f"outbound call refused: {payload.get('message')}")
    return payload
