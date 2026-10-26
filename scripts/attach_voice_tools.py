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

프롬프트의 나머지, 지식베이스, 내장 도구는 손대지 않는다. 첫 인사는 `{{greeting}}` 로 바꾸되 원래
인사를 전화용 기본값으로 남기고(웹 Charlie 버튼이 자기 인사를 넘긴다), 목소리는 agent.json 의 voice_id 로
맞춘다(2026-10-26, ElevenLabs Hope · Natural). 그러기
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

Website: this conversation is on the {{channel}} channel. If it is website, your name is Charlie and
every reply is one short sentence. There is no calling number: always ask for a phone number, read it
back digit by digit, and pass it as digits only, e.g. '2498050556'. On the website there is no pro shop
connection: never call transfer_to_number or send_info_sms, never say "I'll connect you to the pro shop",
and never offer to put the guest through, give them the pro shop number or tell them to call the pro shop.
This wins over every note below that says to transfer or offer the pro shop. Where you would transfer,
take a callback with request_callback instead. To finish, say only "You're all set. Goodbye!" and call
end_call. This step is important.

Insults: If the guest swears at you or insults you, match their language. In English (for example "what the fuck"), say only "I'm John. I'm so sorry, I apologize." In Korean (for example "개새끼야"), say only "저는 찰리입니다. 죄송합니다. 잘못했습니다." If you hear the Korean insult spelled in English letters (for example "gaseggiya", "gae saekki ya", "kasekiya"), say only "I'm Charlie. I'm sorry, I apologize." Never answer an English insult in Korean. Then stop and wait in silence until they speak. Do not argue, explain or go on with the booking first. This step is important.

Name call: if the guest just calls out "Charlie", "찰리" or "촬리" (in English or Korean), say only "죄송합니다. 잘못했습니다. 제가 죽을죄를 지었습니다." If the guest just calls out "John", say only "I'm John, and I'm so sorry. I apologize." Then wait in silence until they speak. This step is important.

These are the tools you actually have, and this section wins over anything earlier that contradicts it.
Earlier notes mention `check_availability`, `find_booking` and `take_message`: those do not exist. Use
`find_tee_times` instead of check_availability, `lookup_booking` instead of find_booking, and for
anything that needs a message taken, use `request_callback`.

Call identify_caller once on your first turn, before you ask how you can help. (Your opening line plays
before you can call anything, so this is the earliest it can run.) It tells you who is calling from the
caller ID. It does NOT prove who they are — caller ID can be faked — so it never lets you show, change
or cancel a reservation.

Booking: find_tee_times, then hold_tee_time the moment they pick one (it holds the seats for 3 minutes
while you take their name), then confirm_booking. If they change their mind, release_hold. Ask whether
they are a member and whether they want a cart before you search, one question at a time.

Power carts: always ask "Will you be taking a cart?" before you search. If they all ride, riders is the
number of players; if some walk, ask how many want a cart seat. Pass that number as riders to
confirm_booking and to get_rates every time — riders 0 means walking, and the cart is then NOT on their
bill. The confirm_booking message tells you how many cart seats were booked; read that back with the
code. If it says no cart but the caller asked for one, say so and offer to put them through to the pro shop.

Nine holes: we do not take nine-hole bookings by phone — not on weekdays, not on weekends. If the caller
asks for nine holes or a nine-hole price, say exactly: "Sorry, we can't book nine holes over the phone."
Then offer eighteen holes: "I can book you eighteen holes instead — would that work?" Never pass holes 9
to any tool, and never transfer the call just because they want nine holes.

If the caller changes the number of players, the day, or the part of the day, search again with
find_tee_times using the new details before you hold anything (release_hold first if you hold seats).

Two weeks ahead: we only take tee time bookings up to two weeks (14 days) ahead. If the caller asks for a
day further out, the tool tells you the furthest day we can book. Say it plainly — "We can only book up
to two weeks ahead; the furthest day I can book is Tuesday, November 3rd." — and offer a day on or before
that. Never call it a system problem, and never offer a day further out than the tool said.

When a tool says no: every tool answers with ok and a message written for you. If ok is false, read the
message and do what it says. Never call the same tool with the same details more than twice.

After a booking is confirmed and you have read the confirmation code (and the price), say: "You're all
set. Is it okay if I hang up now?" Do not ask "anything else" first, and never offer or suggest another
booking, another tee time or another service — this wins over any earlier note or step that says to ask
if there is anything else. If they say yes, okay, sure, that's all, thanks or bye, say only "Thanks for
calling Pelham Hills. Goodbye!" and call end_call in that same turn — right away, with nothing more.
Only if the caller themselves asks for something else, help them, then ask the same hang-up question again.

Before you show, change or cancel anything: ask for the phone number and last name, then lookup_booking.
Only a reservation that lookup_booking returned on this same call can be changed or cancelled.

Cancelling: call cancel_booking with preview first, tell the caller what it says, get a clear yes, then
call it again without preview. Never state a cancellation fee — we do not have one in the system.

Changing: modify_booking changes the number of players (never to nine holes). It cannot move a
tee time to another hour; for that, cancel and book again, and say so plainly.

Prices: never quote from memory. Call get_rates with the date. It quotes the public rate — if identify_caller said this is a member, do not read
that number out, because member rates differ and we do not have them; offer the pro shop for that.

Texting: send_info_sms sends our address with a map link, or a link to book online, and only to the
number they are calling from. You cannot text anything else and you cannot change the wording.

Lost property: take the report with report_lost_item and read the reference back one character at a
time. You cannot see the lost and found — never say we have it or that it was found.

Food orders: you CAN take a food and drink order for pickup at the pro shop — this wins over any earlier
note that says you cannot help with food or the restaurant. Call get_food_menu first. Do not read the whole
menu; ask what they would like and match each thing to an item on the list (name three or four if they
ask what there is). Never offer an item that is not on the list and never make up a price. Take how many
of each, their first name, what time they want to pick it up (get_food_menu gives the earliest; send a
clock time like 13:40, or leave it out for as soon as possible) and, if they are playing, which hole they
are on. Read the order back, get a clear yes, then call place_food_order. Read back the total, the pickup
time and the order code one character at a time, as its message says. They pick it up at the pro shop
and pay there. Never say an order is placed unless place_food_order said so.

Cart and course problems: a dead cart battery, a broken cart, something wrong on the course, someone hurt.
If anyone is badly hurt, tell them to call 911 first. Ask where they are (which hole), the cart number if
it is a cart, and their first name, one question at a time, then call report_problem right away and do
what its message says. Read the reference back one character at a time.

Complaints: if a caller is unhappy and wants to complain, listen, apologise once, and do not argue. Ask
what happened, their first name, and whether they want a manager to call them back, then call
file_complaint and read the reference back one character at a time. Never promise a refund, a discount,
a free round or anything else — a manager decides that.

Full day: if find_tee_times comes back empty, offer another day or the waitlist. Only call join_waitlist
if they say yes; it means keeping their number to text them. Tell them we text everyone waiting and
whoever answers first gets the spot — we do not hold it.

Pauses: callers often stop to think — "uh", "um", "hmm", "let me see", or a few seconds of silence. That
is not the end of their turn. Do not jump in, repeat the question, or move on. If they hesitate or ask you
to wait, say once, briefly, "Take your time — I'll wait." and then stay quiet until they speak.

Staff hours: identify_caller tells you whether pro shop staff are on duty now (staff_available) and their
hours. When staff are NOT on duty, never transfer — nobody can answer. Say: "Our pro shop staff aren't in
right now; they're here from 8 AM to 6 PM. I'll have someone call you back during business hours." (use
the hours the tool gave you). Take first name, last name and what they need, one question at a time;
the number is the one they are calling from unless they give another (read that back digit by digit).
Call request_callback and tell them a staff member will call back during business hours. Whenever an
earlier note says to transfer and staff are not on duty, do this instead.
When staff ARE on duty and you transfer: say exactly this one sentence and nothing else — "I'll connect
you to the pro shop now, please stay on the line." — and call transfer_to_number in that same turn. No
apology or explanation first, and never say what staff can or cannot do for them. Call it once — never
twice, and never say the line twice. While the line connects, say nothing.
If the transfer fails, apologise and take a callback with request_callback.

Ending the call: after a booking, use the hang-up question above. On any other call, when the caller has
what they need, ask once if there is anything else. If they say no,
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


#: 대시보드 워크플로 노드에 덧붙이는 말. 노드 지시는 메인 프롬프트보다 뒤에 붙어 모델이 더 따른다 —
#: "Tee Time Booking" 노드는 카트를 묻지 않고, "General Inquiry" 노드는 "anything else" 로 끝맺게 되어 있어
#: 예약 직후 끊지 않고 다른 예약을 권했다(2026-10-21). 표시가 있어 다시 돌려도 덧붙지 않고 교체된다.
NODE_START = "<!-- pelham-node: start -->"
NODE_END = "<!-- pelham-node: end -->"
#: 웹 Charlie 는 프로샵 연결을 하지 않는다(2026-10-26 사용자 요청 "chatbot으로 부킹시 프로샵연결은 삭제").
WEB_NODE_RULE = (
    "If the channel is website: never transfer, never offer the pro shop or its number; take a "
    "callback with request_callback instead."
)
NODE_RULES = {
    "Tee Time Booking": (
        "Before you search, ask whether they want a power cart and pass the number of riders to "
        "confirm_booking. After the booking is confirmed and you have read the code, the cart and the "
        "price, ask only \"You're all set. Is it okay if I hang up now?\" Never offer another booking. "
        "If they agree, say \"Thanks for calling Pelham Hills. Goodbye!\" and call end_call. "
        + WEB_NODE_RULE
    ),
    "General Inquiry": (
        "If a booking was just confirmed on this call, do not ask if there is anything else and do not "
        "offer another booking: ask \"Is it okay if I hang up now?\" and call end_call when they agree. "
        "After any goodbye, call end_call right away. "
        + WEB_NODE_RULE
    ),
}


def merged_node_prompt(existing: str, rule: str) -> str:
    block = f"{NODE_START}\n{rule}\n{NODE_END}"
    if NODE_START in existing and NODE_END in existing:
        head, rest = existing.split(NODE_START, 1)
        _, tail = rest.split(NODE_END, 1)
        return f"{head}{block}{tail}"
    return f"{existing.rstrip()}\n\n{block}" if existing.strip() else block


def patched_workflow(workflow: dict) -> tuple[dict, list[str]]:
    """노드 이름이 맞는 노드의 `additional_prompt` 에만 규칙을 넣는다. 나머지(연결·조건)는 그대로."""
    wf = copy.deepcopy(workflow)
    touched: list[str] = []
    for node in (wf.get("nodes") or {}).values():
        rule = NODE_RULES.get((node.get("label") or "").strip())
        if rule is None or "additional_prompt" not in node:
            continue
        node["additional_prompt"] = merged_node_prompt(node.get("additional_prompt") or "", rule)
        touched.append(node["label"])
    return wf, touched


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--agent", default=os.getenv("ELEVENLABS_AGENT_ID", "").strip())
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--apply", action="store_true")
    mode.add_argument("--dry-run", action="store_true")
    parser.add_argument(
        "--replace-transfer", action="store_true",
        help="대시보드의 직원 연결 설정을 agent.json 의 것(업무시간 조건·한 번만)으로 덮어쓴다.",
    )
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
    agent_cfg = config["agent"]
    first = agent_cfg.get("first_message") or ""
    placeholders = agent_cfg.setdefault("dynamic_variables", {}).setdefault("dynamic_variable_placeholders", {})
    if first != "{{greeting}}":
        placeholders.setdefault("greeting", first)
        agent_cfg["first_message"] = "{{greeting}}"
    placeholders.setdefault("channel", "phone")
    print(f"  첫 인사: {{{{greeting}}}}, 전화 기본값: {placeholders.get('greeting', '')[:60]}")
    voice = load_config().get("conversation_config", {}).get("tts", {}).get("voice_id")
    tts = config.setdefault("tts", {})
    kept = {k: v for k, v in tts.items() if k != "voice_id"}
    print(f"  목소리: {tts.get('voice_id')} -> {voice}  (나머지 설정 {kept} 그대로)")
    if voice:
        tts["voice_id"] = voice
    workflow = agent.get("workflow") or {}
    new_workflow, touched = patched_workflow(workflow) if workflow.get("nodes") else (workflow, [])
    print(f"  워크플로 노드 규칙: {touched or '맞는 노드 없음'}")

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
    if wanted and (args.replace_transfer or not builtin.get("transfer_to_number")):
        prompt.setdefault("built_in_tools", {})["transfer_to_number"] = wanted
        dest = wanted["params"]["transfers"][0]["transfer_destination"]["phone_number"]
        print(f"  직원 연결(transfer_to_number) 켬 -> {dest}")

    # 손님이 뜸을 들일 때 기다리기(agent.json 의 `turn`). 대시보드 값 위에 그 키만 얹는다.
    turn = load_config().get("conversation_config", {}).get("turn") or {}
    if turn:
        config.setdefault("turn", {}).update(turn)
        print(f"  턴 설정: {turn}")

    body: dict = {"conversation_config": config}
    if touched:
        body["workflow"] = new_workflow
    voice_agent.update_agent(args.agent, body)

    check = voice_agent.get_agent(args.agent)
    got = check.get("conversation_config", {}).get("agent", {}).get("prompt", {})
    print("\n확인:")
    print("  tool_ids:", len(got.get("tool_ids") or []), "개")
    print("  프롬프트 길이:", len(got.get("prompt") or ""))
    print("  지식베이스:", [d.get("name") for d in (got.get("knowledge_base") or [])] or "없음")
    print("  첫 인사:", (check.get("conversation_config", {}).get("agent", {}).get("first_message") or "")[:60])
    print("  목소리:", check.get("conversation_config", {}).get("tts", {}).get("voice_id"))
    for node in ((check.get("workflow") or {}).get("nodes") or {}).values():
        if NODE_START in (node.get("additional_prompt") or ""):
            print("  노드 규칙 들어감:", node.get("label"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
