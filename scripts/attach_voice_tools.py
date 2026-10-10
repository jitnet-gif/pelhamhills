"""기존 ElevenLabs 에이전트에 이 저장소의 도구만 붙인다.

`elevenlabs_sync_agent.py` 와 무엇이 다른가
-------------------------------------------
그 스크립트는 `ops/elevenlabs/agent.json` 을 **진실**로 보고 에이전트 설정을 통째로
밀어 넣는다. 대시보드에서 손으로 만든 프롬프트·목소리·지식베이스가 있는 계정에서는
그게 파괴적이다 (PELHAMHILLS PROSHOP 에이전트는 프롬프트 8천 자에 지식베이스 문서
두 개를 갖고 있다).

이 스크립트는 **더하기만 한다**:
  1. `agent.json` 의 도구를 이름으로 upsert 한다 (URL·시크릿은 .env 로 치환).
  2. 에이전트의 `tool_ids` 를 그 도구들로 설정한다.
  3. 프롬프트 끝에 도구 사용 규칙 블록을 넣는다 (경계 표시가 있어 다시 돌려도
     덧붙지 않고 교체된다).

프롬프트의 나머지, 첫 인사, 목소리, 지식베이스, 내장 도구는 손대지 않는다. 그러기
위해 기존 `conversation_config` 를 **통째로 읽어 와서** 프롬프트만 고쳐 되돌려 보낸다.
PATCH 가 중첩 객체를 얕게 덮어써도 잃는 것이 없게 하기 위해서다.

    python scripts/attach_voice_tools.py --dry-run
    python scripts/attach_voice_tools.py --apply
"""
from __future__ import annotations

import argparse
import copy
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.services import voice_agent  # noqa: E402
from scripts.elevenlabs_sync_agent import load_config  # noqa: E402

START = "<!-- pelham-tools: start -->"
END = "<!-- pelham-tools: end -->"

RULES = """# Using the booking tools

These are the tools you actually have, and this section wins over anything earlier that contradicts it.
Earlier notes mention `check_availability`, `find_booking` and `take_message`: those do not exist. Use
`find_tee_times` instead of check_availability, `lookup_booking` instead of find_booking, and for
anything that needs a message taken, transfer to the pro shop.

Call identify_caller once on your first turn, before you ask how you can help. (Your opening line plays
before you can call anything, so this is the earliest it can run.) It tells you who is calling from the
caller ID. It does NOT prove who they are — caller ID can be faked — so it never lets you show, change
or cancel a reservation.

Booking: find_tee_times, then hold_tee_time the moment they pick one (it holds the seats for 3 minutes
while you take their name), then confirm_booking. If they change their mind, release_hold.

Before you show, change or cancel anything: ask for the phone number and last name, then lookup_booking.
Only a reservation that lookup_booking returned on this same call can be changed or cancelled.

Cancelling: call cancel_booking with preview first, tell the caller what it says, get a clear yes, then
call it again without preview. Never state a cancellation fee — we do not have one in the system.

Changing: modify_booking changes the number of players or nine versus eighteen holes. It cannot move a
tee time to another hour; for that, cancel and book again, and say so plainly.

Prices: never quote from memory. Call get_rates with the date. It quotes the public rate — if
identify_caller said this is a member, do not read that number out, because member rates differ and we
do not have them. Nine-hole pricing is not in the rate table either; offer the pro shop for both.

Texting: send_info_sms sends our address with a map link, or a link to book online, and only to the
number they are calling from. You cannot text anything else and you cannot change the wording.

Lost property: take the report with report_lost_item and read the reference back one character at a
time. You cannot see the lost and found — never say we have it or that it was found.

Full day: if find_tee_times comes back empty, offer another day or the waitlist. Only call join_waitlist
if they say yes; it means keeping their number to text them. Tell them we text everyone waiting and
whoever answers first gets the spot — we do not hold it.

Ending the call: when the caller has what they need, ask once if there is anything else. If they say no,
say a short goodbye ("Thanks for calling Pelham Hills, have a great day. Goodbye!") and call end_call in
that same turn. Once you have said goodbye, whatever the caller says next — yes, okay, bye, thanks, you
too — call end_call right away and say nothing more. Do not ask another question or say goodbye twice.
If the caller says goodbye first, give one short goodbye and call end_call."""


def merged_prompt(existing: str) -> str:
    """규칙 블록을 넣거나 갈아 끼운다. 나머지 글자는 건드리지 않는다."""
    block = f"{START}\n{RULES}\n{END}"
    if START in existing and END in existing:
        head, rest = existing.split(START, 1)
        _, tail = rest.split(END, 1)
        return f"{head}{block}{tail}"
    return f"{existing.rstrip()}\n\n{block}\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--agent", default=os.getenv("ELEVENLABS_AGENT_ID", "").strip())
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--apply", action="store_true")
    mode.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    if not args.agent:
        raise SystemExit("--agent <id> 가 필요하다 (또는 .env 의 ELEVENLABS_AGENT_ID).")

    tools = load_config().get("tools", [])
    print(f"도구 {len(tools)}개: {', '.join(t['name'] for t in tools)}")

    agent = voice_agent.get_agent(args.agent)
    config = copy.deepcopy(agent.get("conversation_config", {}))
    prompt = config.setdefault("agent", {}).setdefault("prompt", {})
    before = prompt.get("prompt") or ""
    after = merged_prompt(before)

    print(f"에이전트: {agent.get('name')}")
    print(f"  프롬프트 {len(before)}자 -> {len(after)}자 (규칙 블록 {'교체' if START in before else '추가'})")
    print(f"  기존 tool_ids: {prompt.get('tool_ids') or '없음'}")
    print(f"  지식베이스: {[d.get('name') for d in (prompt.get('knowledge_base') or [])] or '없음'}")
    print(f"  목소리: {config.get('tts', {}).get('voice_id')}  (건드리지 않는다)")

    if not args.apply:
        print("\ndry-run 이다. 실제로 붙이려면 --apply 를 붙인다.")
        return 0

    existing = voice_agent.list_tools()
    tool_ids: list[str] = []
    for tool in tools:
        tool_id, created = voice_agent.upsert_tool(tool, existing)
        tool_ids.append(tool_id)
        print(f"  {'만듦' if created else '갱신'}: {tool['name']} -> {tool_id}")

    prompt["prompt"] = after
    prompt["tool_ids"] = tool_ids

    # API 는 `tools` 와 `tool_ids` 를 동시에 받지 않는다 (400 both_tools_and_tool_ids_provided).
    # 이 에이전트의 인라인 `tools` 는 system 도구 두 개(end_call, language_detection)뿐이고,
    # 둘 다 `built_in_tools` 에서 이미 켜져 있다 — 중복이라 떼어 내도 기능이 그대로다.
    # 웹훅 도구가 들어 있다면 그건 다른 이야기이므로 멈춘다.
    # 다시 돌릴 때는 지난번에 붙인 우리 도구가 인라인으로 펼쳐져 돌아온다. 그것은
    # 같은 이름으로 다시 매다니 지워도 된다. **우리 것이 아닌** 웹훅 도구만 멈춘다 —
    # 대시보드에서 손으로 만든 도구를 말없이 떼어 내면 안 된다.
    ours = {t["name"] for t in tools}
    inline = prompt.pop("tools", None) or []
    strangers = [
        t.get("name") for t in inline
        if t.get("type") != "system" and t.get("name") not in ours
    ]
    if strangers:
        raise SystemExit(f"우리 것이 아닌 웹훅 도구가 있다: {strangers}. 지우기 전에 사람이 봐야 한다.")
    builtin = prompt.get("built_in_tools") or {}
    for t in inline:
        if t.get("type") != "system":
            continue  # 웹훅 도구는 위에서 걸렀다. 여기서는 내장 기능만 본다.
        name = t.get("name")
        if name and not builtin.get(name):
            raise SystemExit(f"인라인 system 도구 {name} 이 built_in_tools 에 없다. 지우면 기능이 사라진다.")

    # 직원 연결. agent.json 이 번호와 조건을 들고 있고, 꺼져 있을 때만 켠다 —
    # 대시보드에서 손으로 설정해 둔 것이 있으면 덮어쓰지 않는다.
    wanted = (
        load_config()
        .get("conversation_config", {}).get("agent", {}).get("prompt", {})
        .get("built_in_tools", {}).get("transfer_to_number")
    )
    if wanted and not builtin.get("transfer_to_number"):
        prompt.setdefault("built_in_tools", {})["transfer_to_number"] = wanted
        dest = wanted["params"]["transfers"][0]["transfer_destination"]["phone_number"]
        print(f"  직원 연결(transfer_to_number) 켬 -> {dest}")

    voice_agent.update_agent(args.agent, {"conversation_config": config})

    check = voice_agent.get_agent(args.agent)
    got = check.get("conversation_config", {}).get("agent", {}).get("prompt", {})
    print("\n확인:")
    print("  tool_ids:", len(got.get("tool_ids") or []), "개")
    print("  프롬프트 길이:", len(got.get("prompt") or ""))
    print("  지식베이스:", [d.get("name") for d in (got.get("knowledge_base") or [])] or "없음")
    print("  첫 인사:", (check.get("conversation_config", {}).get("agent", {}).get("first_message") or "")[:60])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
