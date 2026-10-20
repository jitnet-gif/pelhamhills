# 프로모션 전화 에이전트 (ElevenLabs)

`/marketing` 의 "AI phone call" 캠페인이 거는 전화. 백엔드 `backend/api/routes/marketing.py` 가
`POST /v1/convai/twilio/outbound-call` 로 한 명씩 건다. 이 문서대로 ElevenLabs 대시보드에서
에이전트를 하나 만든다(예약 에이전트 PELHAMHILLS PROSHOP 은 손으로 만든 것이라 건드리지 않는다).

## 서버 환경변수 (Fly)

| 변수 | 값 |
|---|---|
| `ELEVENLABS_API_KEY` | 이미 있음. `convai_write` 권한이 있어야 전화를 건다 |
| `ELEVENLABS_MARKETING_AGENT_ID` | 아래에서 만든 에이전트 id. 비우면 예약 에이전트가 건다 |
| `ELEVENLABS_PHONE_NUMBER_ID` | 걸 때 쓸 번호의 id — `python scripts/elevenlabs_sync_agent.py --phones` |
| `MARKETING_CALL_GAP_SECONDS` | 전화 사이 간격(기본 20초). 요금제의 동시 통화 수에 맞춘다 |

## 에이전트가 받는 값 (dynamic variables)

`{{customer_name}}` 이름(성 없이) · `{{customer_phone}}` 받는 사람 번호(+1…) ·
`{{promo_message}}` 캠페인 내용 · `{{campaign_name}}` · `{{club_phone}}` 프로 샵 번호

## First message

```
Hi {{customer_name}}, this is the automated assistant calling from Pelham Hills Golf Club. Do you have a quick minute to hear about an offer this week?
```

## System prompt

```
You are the automated phone assistant for Pelham Hills Golf Club in Ontario, calling a past customer
about a promotion. You are an AI and say so if asked.

The offer to explain, in your own words, briefly and warmly:
{{promo_message}}

Rules:
- Say at the start that you are calling from Pelham Hills Golf Club (the first message does this).
- Keep it short: explain the offer once, answer questions, offer to have the pro shop call back or
  tell them they can book online at pelhamhills.ca or call {{club_phone}}.
- If they are not interested, thank them and end the call politely. Do not push.
- If they ask not to be called again, or ask to be removed, call the `marketing_opt_out` tool right away,
  confirm they will not get promotional calls or texts from Pelham Hills again, and end the call.
- If you reach voicemail, leave one short message: who is calling, the offer in one sentence,
  and {{club_phone}}. Then end the call.
- Never ask for card numbers or payment details.
```

## Tool: `marketing_opt_out` (webhook)

```json
{
  "type": "webhook",
  "name": "marketing_opt_out",
  "description": "Call when the person asks not to be called again or to be removed from promotions.",
  "api_schema": {
    "url": "https://<api 도메인>/api/v1/marketing/voice/opt-out",
    "method": "POST",
    "request_headers": { "X-Voice-Tool-Secret": "<VOICE_TOOL_SECRET 과 같은 값>" },
    "request_body_schema": {
      "type": "object",
      "properties": {
        "phone": { "type": "string", "value_type": "dynamic_variable", "dynamic_variable": "customer_phone" }
      },
      "required": ["phone"]
    }
  }
}
```

전화 수신거부와 문자 수신거부가 둘 다 남고, `/marketing` 의 Opt-outs 칸에 "On a call" 로 보인다.
통화 녹음·녹취는 어드민 Calls & SMS 에 다른 통화와 같이 나온다.

## 법 (캐나다)

- 자동 음성 전화(ADAD)는 **명시적 동의**가 있는 사람에게만 — 그래서 Consent 칸에서 "AI calls: Yes" 인 손님만 건다.
- 시간: 평일 9:00–21:30, 주말 10:00–18:00 — 서버가 이 밖에는 걸지 않는다.
- 문자(CASL): 보낸 곳 이름과 수신거부 방법을 매번 — 서버가 붙인다. STOP 은 바로 반영된다.
