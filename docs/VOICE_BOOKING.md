# 음성 예약 (ElevenLabs Agents Platform)

손님이 **말로** 티타임을 예약하고 취소한다. 입구는 둘이고 뒤는 하나다.

```
 전화 (Twilio)  ─┐
                 ├─→  ElevenLabs 에이전트  ─→  /api/v1/voice/tools/*  ─→  티 시트
 웹 (/book/tee-time) ─┘                                                    (tee_sheet.json)
```

에이전트는 티 시트를 직접 만지지 않는다. 도구 여섯 개만 부를 수 있고, 정원·슬롯·
상태 전이의 규칙은 전부 `backend/api/routes/tee_sheet.py` 한 곳에 있다. 그래서
전화로 들어온 예약과 웹으로 들어온 예약이 같은 자리를 두 번 팔 수 없다.

## 파일 지도

| 파일 | 역할 |
|---|---|
| `backend/api/routes/voice.py` | 도구 12개 + 웹 세션 발급 + post-call 웹훅 |
| `backend/api/routes/voice_sim.py` | 실내 골프(시뮬레이터) 도구 4개 + 문자 `C <코드>` 의 베이 쪽 |
| `supabase/migrations/0016_phone_sim_booking.sql` | 위 도구가 부르는 service_role 전용 SQL 함수 — **아직 실행 안 됨** (0007·0008·0012 먼저) |
| `backend/services/customer_lookup.py` | 발신번호 → 고객 (인사용. 인증 아님) |
| `backend/services/lost_items.py` | 분실물 접수대장 (`pelham_lost_items`) |
| `backend/services/tee_waitlist.py` | 대기자 명단 (`pelham_tee_waitlist`) |
| `backend/services/supabase_rest.py` | 보조 표들이 쓰는 얇은 PostgREST 계층 |
| `scripts/voice_tunnel_proxy.py` | 도구 경로만 공개하는 프록시 |
| `scripts/check_voice_tools.py` | 구현·에이전트·프록시 세 곳 일치 검사 |
| `backend/services/voice_agent.py` | ElevenLabs HTTP 클라이언트 |
| `backend/api/routes/tee_sheet.py` | 홀드 개념(`BookingSource`, `holdExpiresAt`)이 사는 곳 |
| `ops/elevenlabs/agent.json` | 에이전트 프롬프트와 도구 스키마의 **원본** |
| `scripts/elevenlabs_sync_agent.py` | 위 JSON 을 계정에 밀어 넣는다 |
| `frontend/components/booking/VoiceBooking.tsx` | 웹 위젯 |
| `frontend/lib/voice/session.ts` | signed URL 을 백엔드에서 받아온다 |
| `backend/tests/test_voice_booking.py` | 58개 테스트 |
| `backend/tests/test_voice_sim.py` | 실내 골프 도구·문자 취소·문자 비서 테스트 |
| `supabase/migrations/0013_lost_items.sql` | 분실물 표 (실행됨) |
| `supabase/migrations/0014_tee_waitlist.sql` | 대기자 표 (실행됨) |
| `supabase/migrations/0015_staff_lost_items.sql` | 분실물 직원 함수 + 문자 기록 열 — **아직 실행 안 됨** |
| `frontend/app/admin/lost-items/page.tsx` | 프로 샵 분실물 화면 (Lost & Found) |
| `backend/services/lost_item_notices.py` | "Found" 로 바꾸면 1분 안에 손님에게 문자 (8 AM – 9 PM) |
| `backend/services/twilio_sms.py` | 문자 발송, E.164 정규화, Twilio 서명 검증 |
| `backend/api/routes/sms.py` | 손님 답장(C 취소, STOP), 전달 상태, 리마인더 |

## 도구 열두 개

예약 (원래 여섯):

| 도구 | 하는 일 |
|---|---|
| `find_tee_times` | 날짜·인원·시간대 → 실제로 팔 수 있는 티타임 (18홀만. 전화로는 9홀을 받지 않는다 — `PHONE_NINE_HOLES`) |
| `hold_tee_time` | 3분짜리 소프트 홀드. 이름을 받는 동안 자리를 잠근다 |
| `release_hold` | 손님이 마음을 바꾸면 즉시 반납 |
| `confirm_booking` | 홀드 → 실제 예약. `riders` 만큼 1인 카트 요금을 붙이고, 회원이라고 말하면 메모만 남긴다 |
| `lookup_booking` | 전화번호 **+** 성으로 조회 |
| `cancel_booking` | 취소 (`status=cancelled`, 삭제 아님). `preview=true` 면 가능 여부만 본다 |

그 밖 (2026-10-05 추가):

| 도구 | 하는 일 | 주의 |
|---|---|---|
| `identify_caller` | 발신번호로 이름을 찾아 **인사에만** 쓴다 | 권한을 주지 않는다 — 아래 참고 |
| `get_rates` | 그 날짜에 실제로 청구되는 금액 | 9홀 요금은 요금표에 없어 거절한다 |
| `modify_booking` | 인원·홀 수 변경 | 시간 변경은 없다 (취소 후 재예약) |
| `send_info_sms` | 주소·지도 또는 예약 링크 문자 | 발신번호로만, 고정 문구만 |
| `report_lost_item` | 분실물 접수, 티켓 번호 발급 | "찾았다" 는 절대 말하지 않는다 |
| `join_waitlist` | 대기자 등록 (손님이 요청했을 때만) | 자리가 나면 15분 잡아 두고 YES 를 기다린다 |

음식 주문 · 현장 문제 · 컴플레인 (2026-10-24 추가):

| 도구 | 하는 일 | 주의 |
|---|---|---|
| `get_food_menu` | GPS 앱 메뉴(`menu_items`, 있는 것만)와 가장 이른 픽업 시각 | 시간·켜고 끄기는 GPS 운영 관리의 주문 설정(`app_settings.food_orders`) |
| `place_food_order` | GPS 앱의 `place_food_order` 로 주문 → GPS 운영 관리 → **주문** 탭에 앱 주문과 함께 뜬다 | 값·품절·시간은 그 함수가 확인. 직원 푸시도 그 함수가 보낸다. 메모 끝에 "Phone order" |
| `report_problem` | 카트 배터리 방전·고장·코스 문제·부상 접수 (0099) | `STAFF_ALERT_NUMBERS` 가 있으면 그 번호들로 즉시 문자. 부상이면 911 먼저 |
| `file_complaint` | 컴플레인 접수 (0099) | 환불·할인·무료를 약속하지 않는다 |

음식 주문은 GPS 앱(golf-gps-pelhamhills-seven)의 표와 함수를 쓴다 — 같은 Supabase 다. 문제·컴플레인은
Calls & SMS → Problems · Complaints. Fly secret(선택): `STAFF_ALERT_NUMBERS`(쉼표로 여럿).

실내 골프 (2026-10-06 추가, `voice_sim.py`):

| 도구 | 하는 일 | 주의 |
|---|---|---|
| `find_sim_times` | 날짜·시간 수(1~5)·가장 이른 시각 → 시작할 수 있는 시각 | 베이 종류는 묻지 않는다 (3개 모두 좌우 겸용) |
| `book_sim_bay` | 이름을 받으면 바로 예약 + 코드 문자 | **홀드 없음** — 베이는 한 건이 통째로 써서, 그 사이 팔리면 409 로 다른 시각을 제안 |
| `lookup_sim_booking` | 전화번호 **+** 성으로 조회 | 세션에 `sim:<id>` 로 담는다 (티타임 id 와 안 섞이게) |
| `cancel_sim_booking` | 취소 (`status=cancelled`). `preview=true` 먼저 | 마감은 **시작 24시간 전** — 손님 웹(0012)과 같은 규칙. 티타임의 2시간이 아니다 |

시뮬레이터 예약의 원본은 Supabase `pelham_sim_reservations` 이다 (손님 웹·Bay Sheet 와 같은 표).
도구는 0016 의 SQL 함수만 부르고 옛 `routes/simulator.py`(JSON 파일)는 쓰지 않는다 — 잠금이
따로 놀면 같은 베이를 두 번 판다. 전화로 잡은 예약은 `source = 'voice_ai'`, 이메일은 비어 있다.
가격은 베이 한 대 값(시간 × 시간당 요금)에 HST, 현장 결제다. 문자 비서도 `find_sim_times`·
`book_sim_bay` 를 쓰고 티타임과 같은 하루 예약 상한(번호당 2건)을 나눠 쓴다. 대기자 명단은 없다.

자리가 비면 — 전화·문자·웹·프로 샵 어느 길로 취소됐든 — 그날 먼저 기다린 사람 중
시간대·인원이 맞는 사람에게 그 자리를 **15분 잡아 두고** 문자를 보낸다
(`backend/services/waitlist_offers.py`). YES 로 답하면 그대로 예약되고 확인 코드가 답장으로
간다. NO 거나 답이 없으면 홀드가 풀려 다음 사람에게 간다. 1분마다 빈자리를 훑고,
전화·문자 취소 직후에는 바로 한 번 더 돈다. 제안 문자는 클럽 시각 7시~21시에만 보낸다
(밤에 난 자리는 아침에). 티오프가 홀드 끝 + 2시간보다 가까운 자리는 걸지 않는다.
대기 명단은 카트를 묻지 않으므로 예약 메모에 "체크인 때 확인" 을 남긴다.

### `identify_caller` 가 권한을 주지 않는 이유

발신번호는 위조할 수 있다. 번호를 안다고 예약을 보여 주거나 취소하게 두면, 번호를
흉내 낸 사람이 남의 라운드를 지울 수 있다. 그래서 이 도구는 `_Session.revealed` 를
건드리지 않고, 다가오는 예약도 **건수만** 돌려준다. 조회·수정·취소는 여전히
`lookup_booking`(번호 **+** 성)을 거쳐야 한다.

한 번호에 고객이 둘 이상이면 이름을 부르지 않는다 — 소스에 부부가 유선 하나를 같이
쓰는 행이 여럿 있다.

### 에이전트가 말하면 안 되는 것

영업시간, 스낵바 메뉴, 주차, 분실물 보관 규정, 9홀 요금, 취소 수수료. 시연
시뮬레이터에는 나오지만 **클럽이 확인해 준 값이 아니다**. 확인 전까지 프롬프트는
이것들을 모른다고 말하고 사람에게 넘기도록 돼 있다.

취소 규정도 아직 하나로 정해지지 않았다 — 음성은 `CANCEL_CUTOFF_MINUTES`(2시간)를
쓰고, 0012 의 온라인 취소는 24시간이다. 둘 중 하나로 정해야 한다.

## 왜 홀드가 필요한가

손님이 "3시요" 라고 말하고 이름을 부르는 20초 사이에, 웹 손님이 같은 3시를 살 수
있다. 에이전트는 "예약됐습니다" 라고 말한 뒤 서버는 409 를 낸다.

그래서 홀드를 **진짜 예약 레코드**로 만든다 — `status=reserved`,
`source=voice_hold`, `holdExpiresAt=지금+3분`, 인원수만큼의 Guest 플레이어.
이러면 `tee_time_players()` 가 자동으로 그 자리를 찬 것으로 세므로 웹 손님에게
보이지 않는다. 만료되면 정원 계산에서 **즉시** 빠지고(`occupies_seat`), 레코드는
다음 정리 패스(`purge_expired_holds`)가 지운다.

## 취소를 막는 문 세 개

취소는 되돌리기 어렵다. 잘못 취소하면 남의 라운드가 날아간다.

1. **조회 없이는 취소 불가.** `cancel_booking` 은 같은 통화의 `lookup_booking` 이
   확인해 준 booking_id 만 받는다 (`_Session.revealed`). 에이전트가 id 를 지어내
   남의 예약을 취소할 수 없다. `conversation_id` 가 없으면 통화를 특정할 수 없으므로
   **그것만으로 거절한다** — "세션이 있으면 검사" 로 두면 그 필드를 빼는 것으로
   이 문을 통과할 수 있다.
2. **성이 일치해야 한다.** 조회에 이미 전화번호+성을 요구했고, 취소에서 한 번 더 본다.
3. **티오프 2시간 이내는 프로 샵.** `CANCEL_CUTOFF_MINUTES`. 카트 배정과 환불이
   걸려 있어 사람이 판단할 구간이다.

그리고 레코드를 지우지 않는다. `status=cancelled` 로만 바꾸므로 프로 샵이 티
시트에서 되돌릴 수 있다. 감사 로그에 누가 왜 취소했는지 남는다.

## 필요한 API 키 권한 ⚠️

`backend/services/tts.py` 가 쓰던 TTS 전용 키로는 **동작하지 않는다.** Agents
Platform 은 별도 권한이 필요하다. ElevenLabs 대시보드에서 키를 만들 때 다음을 켤 것:

- `convai_read` — 에이전트/도구 조회, signed URL 발급
- `convai_write` — 에이전트/도구 생성·수정
- `text_to_speech` — 기존 `tts.py` 가 계속 쓴다면

권한이 빠진 키는 401 에 `missing the permission convai_read` 가 찍힌다.

## 설정 (.env, 저장소 루트)

```
ELEVENLABS_API_KEY=sk_...            # 위 권한이 켜진 키
ELEVENLABS_AGENT_ID=                 # 최초 동기화가 찍어 준다
VOICE_TOOL_SECRET=                   # 배포에서는 반드시 채울 것
ELEVENLABS_WEBHOOK_SECRET=           # post-call 웹훅 HMAC
PUBLIC_API_BASE_URL=                 # 에이전트가 우리를 부를 **공개** 주소
CLUB_TIMEZONE=America/Toronto        # 선택. 기본값이 이것이다
```

`VOICE_TOOL_SECRET` 이 비면 도구 엔드포인트는 **인증 없이 열린다.** 로컬에서 curl
로 두드려 보라고 그렇게 뒀다. 배포에서 비워 두면 누구나 예약을 만들고 취소할 수 있다.

셸 환경변수로 덮어쓰려 하지 말 것. `backend/core/config.py` 가 `load_dotenv(...,
override=True)` 로 `.env` 를 읽으므로 **`.env` 가 항상 이긴다.** 값을 바꾸려면
`.env` 를 고쳐야 한다.

`/voice/tools/*` 만 이 시크릿으로 막힌다. `/voice/session` 은 브라우저가 부르고
`/voice/post-call` 은 ElevenLabs 가 자기 HMAC 서명으로 부르므로 둘 다 시크릿을
가질 수 없다 — 같은 라우터에 두면 시크릿을 켠 순간 웹 위젯이 조용히 죽는다.
`/voice/session` 은 대신 IP 당 분당 10회로 제한한다.

## 세우는 순서

1. **권한이 켜진 키**를 `.env` 에 넣는다.
2. 공개 주소를 만든다. ElevenLabs 서버는 localhost 에 닿지 못한다 — 이 값이
   localhost 면 도구 호출이 전부 실패한다 (스크립트가 경고한다).

   **백엔드를 터널에 직접 걸지 말 것.** `TEE_SHEET_BACKEND=supabase` 라서
   `/api/v1/tee-sheet/*` 는 실제 고객의 예약과 연락처를 돌려주는데 그쪽에는 인증이
   없다. 터널 주소가 임의의 긴 문자열이라는 건 보호가 아니다. 그래서 도구 경로만
   통과시키는 프록시를 앞에 둔다:

   ```
   python scripts/voice_tunnel_proxy.py                  # 8099 -> 8000, 허용 목록만
   cloudflared tunnel --url http://localhost:8099        # 공개 HTTPS 주소를 받는다
   # PUBLIC_API_BASE_URL=https://<주소>.trycloudflare.com/api/v1
   ```

   **2026-10-06부터는 터널이 필요 없다.** 백엔드가 Fly 에 상시 떠 있다:

   ```
   https://pelham-hills-api.fly.dev/api/v1     ← PUBLIC_API_BASE_URL
   ```

   앱: `pelham-hills-api` (조직 `smeag-kenneth-smeag-kenneth`). 옛 `pelhamhills-api` 는
   `personal` 조직에 있고 그 조직의 체험판이 끝나 **앱을 꺼내지도 못한다** —
   `apps move` 가 "failed fetching app: trial has ended" 로 거부된다. 그래서 결제가
   살아 있는 조직에 새 이름으로 만들었다. 배포는 `python scripts/fly_up.py --apply`.

   **공개 표면은 음성과 Twilio 웹훅까지다.** `fly.toml` 의 `PUBLIC_SURFACE=voice` 가
   티 시트·리테일·시뮬레이터 라우터와 `/sms/messages` 를 아예 등록하지 않는다. 전부
   인증이 없어서 공개하면 고객 이름·전화번호가 주소만 알면 읽히는데, 그 화면들은
   2026-09 에 Supabase 로 옮겨가서(0004) 이 서버가 필요 없다. 확인:
   `/api/v1/tee-sheet/bookings` 와 `/api/v1/sms/messages` 가 **404** 여야 한다.

   Fly 가 없을 때의 임시방편(개발·장애 시)은 터널이다. 백엔드·프록시·터널을 띄우고
   `.env` 와 ElevenLabs 도구 주소까지 한꺼번에 맞춰 준다:

   ```
   python scripts/voice_up.py
   ```

   터널 주소는 띄울 때마다 바뀐다. 주소가 바뀌면 등록된 도구 12개가 죽은 주소를
   가리키므로, **터널을 띄우는 일과 도구 주소를 갱신하는 일은 항상 같이** 해야 한다.
   손으로 하면 언젠가 한쪽을 빠뜨리고, 그때는 손님이 전화한 뒤에야 알게 된다.

   프록시는 도구 경로와 post-call 웹훅만 넘기고 나머지는 404 를 돌려준다
   (`/voice/session` 도 막는다 — 브라우저 위젯용이고 호출마다 대화 크레딧을 태운다).
   확인: 공개 주소로 `/api/v1/tee-sheet/bookings` 를 불러 404 가 나와야 한다.

   `trycloudflare.com` 주소는 터널을 다시 띄울 때마다 바뀐다. 바뀌면 `.env` 의
   `PUBLIC_API_BASE_URL` 을 고치고 동기화 스크립트를 다시 돌려야 에이전트가 새
   주소를 부른다.
3. 에이전트를 만든다:
   ```
   python scripts/elevenlabs_sync_agent.py --dry-run   # 페이로드 확인
   python scripts/elevenlabs_sync_agent.py             # 실제 생성
   ```
   찍힌 `ELEVENLABS_AGENT_ID` 를 `.env` 에 넣는다. 안 넣으면 다음 실행이 또 만든다.
4. 웹 위젯을 확인한다. 백엔드와 프론트를 띄우고 `/book/tee-time` 의
   "Book by voice" 를 누른다.
5. 전화선 (선택):
   ```
   python scripts/elevenlabs_sync_agent.py --phones
   python scripts/elevenlabs_sync_agent.py --assign-phone <phone_number_id>
   ```
   번호 자체는 **Twilio 에서 사서 ElevenLabs 대시보드에 등록**해야 한다. 이
   저장소 밖의 계정 작업이라 스크립트가 대신할 수 없다.

   번호는 이미 있다 — `+1 249-805-0556` (Twilio 계정 active/Full, `.env` 의
   `TWILIO_PHONE_NUMBER`). **되돌릴 지점을 먼저 적어 둔다**: 이 번호의 현재
   `voice_url` 은 TwiML Bin `EH0c606645a2f5502adf82864c62bdb086` 다. ElevenLabs 에
   연결하면 이 값이 덮어써지므로, 지금 이 번호로 들어오는 전화가 있다면 무엇을
   하고 있는지 확인한 뒤에 넘길 것. 되돌리려면 Twilio 콘솔에서 `voice_url` 을 위
   핸들러로 되돌린다. 걸려 오는 전화(인바운드)에는 Twilio 의 geo permissions
   가 상관없다 — 그 설정은 **나가는 전화**에만 걸린다.
6. post-call 웹훅을 `{PUBLIC_API_BASE_URL}/voice/post-call` 로 등록하고, 발급된
   시크릿을 `ELEVENLABS_WEBHOOK_SECRET` 에 넣는다.

   **시크릿을 먼저 넣고 프록시를 다시 띄울 것.** `_verify_webhook` 은 이 시크릿이
   비면 서명 검증을 건너뛴다. 그래서 프록시는 시크릿이 있을 때만 이 경로를 공개한다
   (없으면 404). 순서를 바꾸면 "등록은 했는데 404" 가 되고, 억지로 열면 통화의
   conversation_id 를 아는 사람이 남의 예약 감사 로그에 가짜 메모를 붙일 수 있다.

## ⚠️ 지금 쓰는 에이전트는 손으로 만든 것이다

계정의 `PELHAMHILLS PROSHOP` (`agent_6601m3hn7evjegn8v3mz8jhvw9rk`) 은 대시보드에서
만들어졌다 — 프롬프트 8천 자, 지식베이스 문서 두 개, 지정한 목소리. 이 저장소가
만든 것은 **도구 12개뿐**이다.

그래서 **`elevenlabs_sync_agent.py` 를 이 에이전트에 돌리지 말 것.** 그 스크립트는
`agent.json` 의 설정을 통째로 밀어 넣어 프롬프트와 목소리를 지운다. 지식베이스가
붙어 있으면 멈추도록 막아 뒀지만, 애초에 쓰는 스크립트가 다르다:

```
python scripts/attach_voice_tools.py --dry-run
python scripts/attach_voice_tools.py --apply
```

이쪽은 도구를 이름으로 upsert 하고 `tool_ids` 와 도구 사용 규칙 블록만 더한다.
규칙 블록은 `<!-- pelham-tools: start/end -->` 로 감싸여 있어 다시 돌려도 덧붙지 않고
교체된다. 프롬프트의 나머지, 첫 인사, 목소리, 지식베이스는 건드리지 않는다.

**도구의 스키마와 설명**은 여전히 `ops/elevenlabs/agent.json` 이 원본이다. 거기를
고치고 `attach_voice_tools.py --apply` 를 다시 돌린다. 반면 **에이전트의 말투와
사실관계**는 대시보드와 지식베이스가 원본이다 — 그쪽은 이 저장소가 관리하지 않는다.

## 테스트

```
python -m pytest backend/tests/test_voice_booking.py backend/tests/test_voice_sim.py -q
```

`test_voice_sim.py` 는 Supabase 를 부르지 않는다 (0016 함수 네 개의 가짜를 끼운다). SQL 자체는
Docker 의 Postgres 16 에 0001~0016 을 차례로 적용해 확인했다 (2026-10-06).

시간을 2026-09-08 06:00 으로 고정한다. "지나간 티타임은 팔지 않는다", "티오프
2시간 전 이후에는 취소하지 않는다" 는 지금 몇 시인지에 따라 답이 달라지므로,
실제 시계로 돌리면 밤과 아침의 결과가 달라진다.

## 전화번호와 문자 (Twilio)

```
손님 전화 → Twilio 번호 → ElevenLabs 에이전트 ─(도구)→ /api/v1/voice/tools/*
손님 문자 → Twilio → /api/v1/sms/inbound   ("C <코드>" 취소, STOP/START)
우리 서버 → Twilio Messages API            (확정 · 취소 · 리마인더)
```

- **번호 연결.** ElevenLabs 대시보드 → Phone Numbers 에서 Twilio 번호를 가져와
  에이전트에 붙인다. 기존 프로 샵 번호는 영업시간 외에만 그 번호로 착신전환하면
  "영업시간 외에만 AI 가 받는" 구성이 된다.
- **Twilio 콘솔.** 번호의 Messaging 웹훅을 `PUBLIC_API_BASE_URL` + `/sms/inbound` 로.
  서명 검증이 이 주소로 URL 을 다시 만들므로 두 값이 글자 하나까지 같아야 한다.
- **확인 문자**는 `confirm_booking` 이 응답을 돌려준 뒤 보낸다. 6자리 확인 코드가 들어
  있고, 답장 취소는 `C <코드>` 로만 된다 — 발신 번호 하나만으로는 취소하지 않는다
  (`routes/sms.py` 머리 주석). 티오프 2시간 전부터는 전화와 똑같이 프로 샵으로 넘긴다.
  실내 골프 코드는 16진수 10자라 길이로 갈린다 — `C <10자 코드>` 는 `voice_sim.cancel_by_code` 가
  발신번호와 코드가 둘 다 맞는 예약만, 시작 24시간 전까지 취소한다.
- **리마인더**는 음성 예약 손님에게만 전날 18:00 와 2시간 전에 간다. 보낸 사실을 예약의
  감사 로그에 적으므로 서버가 재시작돼도 두 번 가지 않는다.
- `TWILIO_*` 가 비어 있으면 문자는 `skipped` 로만 기록되고, 리마인더 루프는 돌지 않고,
  `/sms/*` 웹훅은 **거절한다** (서명을 확인할 수 없으므로).
- 취소 키워드가 `C` 인 이유: Twilio 표준 수신거부 키워드에 `CANCEL` 이 들어 있다.
- 수신거부(STOP) 목록과 문자 기록은 아직 메모리에만 있다. 재시작하면 사라진다.

## 알아 둘 것

- **통화 세션은 프로세스 메모리에 있다.** 백엔드를 여러 인스턴스로 띄우면 취소
  권한 검사(`_Session.revealed`)가 인스턴스마다 따로 논다. 지금은 단일
  프로세스 전제다. 수평 확장하려면 이 상태를 Redis 같은 공유 저장소로 옮겨야 한다.
- **전화번호와 통화 기록이 `tee_sheet.json` 에 평문으로 쌓인다.** 보관 기간
  정책이 아직 없다.
- `backend/api/routes/tts.py` 는 `main.py` 에 **등록돼 있지 않다** (이 작업 전부터
  그랬다). Agents Platform 이 그 역할을 대신하므로 지울지 살릴지 결정이 필요하다.

## 업무시간 · 콜백 · 거절 응답 (2026-10-20)

- **거절은 200 으로.** 전화 도구(`/voice/tools/*`)는 거절도 `200 {ok: false, status, message}` 로 돌려준다
  (`voice.ToolRoute`). 예전에는 422·409 의 `detail` 로 나가 에이전트가 이유를 읽지 못했다. 시크릿 오류(401)만 그대로다.
- **2주 규칙.** 예약은 오늘부터 14일까지(`BOOKING_WINDOW_DAYS`). 밖이면 message 가 마지막 날을 알려 주고, 프롬프트는
  "두 주까지만 예약된다" 고 말하게 한다.
- **hold 가 하루 전체를 다시 쓰지 않는다.** `bookings_tx` 는 블록이 바꾸지 않은 예약을 읽은 그대로 돌려준다
  (`tee_sheet._written_doc`). 예전에는 모델이 모르는 칸(confirmationCode 등) 때문에 전부 다시 쓰였고, 그 upsert 가
  0048·0051 일출·일몰 트리거에 새 예약처럼 걸려 hold 가 PT422 로 실패했다.
- **업무시간.** `PRO_SHOP_HOURS`(Fly secret, 기본 `08:00-18:00`, 클럽 현지·매일). `identify_caller` 가
  `staff_available` 와 문장을 돌려주고, 업무시간 밖이면 에이전트는 연결하지 않고 `request_callback` 으로 받아 둔다.
- **콜백 명단.** `pelham_callback_requests`(0059). 직원은 Reports → Phone callbacks 에서 보고 전화한 뒤 Called 로 바꾼다.
- **실제 에이전트에 반영.** 대시보드 에이전트는 `python scripts/attach_voice_tools.py --apply --replace-transfer` 로
  규칙 블록·도구·직원 연결 설정·턴 설정(`turn_eagerness: patient`)을 넣는다. convai 쓰기 권한이 있는 키가 필요하다.
