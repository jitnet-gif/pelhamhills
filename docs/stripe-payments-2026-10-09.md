# 결제 — Stripe (온라인 Checkout + 계산대 Terminal) — 2026-10-09

온라인은 Authorize.net, 계산대는 DX8000(J.P. Morgan PTA)으로 만들었던 것을 **Stripe 하나**로 바꿨다.
장부 규칙(금액은 SQL 이 정한다, 승인은 Charge 전에 남는다, 기록할 수 없는 승인은 곧바로 돌려준다)은 그대로다.
바뀐 것은 카드사와 말하는 쪽뿐이다.

| 코드 | 역할 |
|---|---|
| `supabase/migrations/0021_stripe_payments.sql` | 0019·0020 위에: Stripe id 허용, Checkout 세션, 단말기 begin/settle, 브라우저 기록 경로 회수 |
| `backend/services/stripe_gateway.py` | Stripe REST: Checkout, PaymentIntent, 환불, 리더(처리·취소·환불·가상 탭), 웹훅 서명 |
| `backend/api/routes/payments.py` | 손님 `/payments/online/{quote,checkout,status,cancel,config}` |
| `backend/api/routes/terminal.py` | 계산대 `/payments/terminal/*`, 웹훅 `/payments/stripe/webhook` |
| `frontend/lib/pos/terminal.ts` | 계산대 → FastAPI(직원 토큰) → Stripe → 리더 |
| `frontend/components/pos/BillPanel.tsx` | Send to reader, 취소, 결제 줄 삭제 = 환불, 리더 고르기·등록, 테스트 탭 |
| `frontend/components/reports/SalesReport.tsx` | 환불 화면의 Refund to card / Refund on reader |

## 온라인 (예약 사이트)

```
손님 → POST /payments/online/checkout → SQL(0020) 이 금액·invoice PHW… 결정
     → Stripe Checkout 세션(cs_…) 생성, SQL 에 세션 기록(0021) → 손님은 Stripe 페이지에서 카드 입력
     → /book/pay?invoice=… 로 돌아옴 → /status 가 세션을 Stripe 에 다시 물어 기록
     (웹훅 checkout.session.completed 도 같은 기록 — 창을 닫아도 남는다)
```

- 카드 번호는 우리 사이트·서버·DB 를 지나지 않는다(PCI SAQ A).
- 취소(24시간 전까지) = Stripe 전액 환불 + 예약 취소. Stripe Dashboard 에서 직원이 환불하면 웹훅
  `charge.refunded` 가 계산서를 환불 처리하고 플레이어를 미결제로 돌린다(예약은 그대로).

## 계산대 (Stripe Terminal, 서버 주도)

```
계산대 브라우저 ─(직원 토큰)→ FastAPI ─→ SQL pelham_staff_terminal_begin (직원 확인 + pending 한 줄)
                                    ─→ Stripe PaymentIntent(card_present + interac_present, CAD)
                                    ─→ 리더 process_payment_intent → 손님이 탭/삽입
브라우저가 1.5초마다 /terminal/txn/{id} → FastAPI 가 Stripe 에 물어 결과를 pelham_terminal_settle(service_role)
```

- 브라우저는 리더에 직접 닿지 않는다. 매장 LAN·인증서·IP 설정이 필요 없다(리더는 인터넷만 있으면 된다).
- 결과는 Stripe 에 확인한 서버만 쓴다. 0019 의 `pelham_staff_terminal_record`(브라우저가 결과를 써 넣던 길)는
  0021 이 직원 권한을 거뒀다.
- 결제 줄 삭제·환불: 신용카드는 Stripe 환불(카드 필요 없음), Interac 은 리더에서 손님이 카드를 다시 댄다.
- 화면이 닫혀도: 웹훅 `payment_intent.*`·`terminal.reader.action_*` 이 기록하고, 계산서를 다시 열면
  `/terminal/bill/{id}/sync` 가 남은 것을 마무리한 뒤 승인된 줄을 결제 줄로 되살린다.
- 단말기가 안 되면 *Terminal not working? Enter the approval code by hand* (예전 keyed 방식) 그대로.

## 켜는 순서 (사람이 할 일)

1. **Supabase**: SQL Editor 에서 `0020_online_payments.sql` (아직 안 돌렸으면) → `0021_stripe_payments.sql`.
   둘 다 다시 실행해도 안전하다.
2. **Stripe 계정**: 가입하면 테스트 키는 바로 나온다(사업자 인증 전에도). Dashboard → Developers → API keys 의
   Secret key(`sk_test_…`).
3. **Fly 시크릿** (키 값은 채팅에 붙이지 말 것):
   ```
   flyctl secrets set -a pelham-hills-api STRIPE_SECRET_KEY=sk_test_...
   ```
   확인: `https://pelham-hills-api.fly.dev/api/v1/payments/online/config` 가
   `{"enabled":true,"environment":"test","credentials":"ok",...}` 이면 맞다.
4. **웹훅**: Dashboard → Developers → Webhooks → Add endpoint
   `https://pelham-hills-api.fly.dev/api/v1/payments/stripe/webhook`, 이벤트
   `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `charge.refunded`,
   `payment_intent.succeeded`, `payment_intent.payment_failed`, `payment_intent.canceled`,
   `terminal.reader.action_succeeded`, `terminal.reader.action_failed`.
   나온 Signing secret 을 `flyctl secrets set -a pelham-hills-api STRIPE_WEBHOOK_SECRET=whsec_...`.
5. **계산대 PC 마다**: `/pos` → 계산서 아래 **Card terminal** → Mode = *Linked* → 리더 고르기 → *Test connection*.
   테스트 키에서는 *Add a simulated reader* 로 가상 S700 을 만든다. 진짜 리더는 리더 화면의 등록 코드를
   *Register a new reader* 에 넣는다.
6. **운영 전환**: 사업자 인증이 끝나면 `sk_live_…` 와 운영 웹훅의 `whsec_…` 로 바꾼다. 리더는 운영 모드에서 다시
   등록한다(테스트·운영 리더는 따로다). Location 주소는 Dashboard 에서 클럽 주소로 만들고
   `STRIPE_TERMINAL_LOCATION=tml_…` 로 지정한다.

## 시험 방법

- 백엔드: `python -m pytest backend/tests/test_payments.py -q` (37개, 네트워크 없음 — Stripe·SQL 가짜).
- SQL: 0019·0020 위에 0021 을 두 번 올리고, 단말기 시나리오(리더 없음·합계 초과·pending 으로 결제 거절·승인·
  중복 settle 무시·Charge 전 환불 → voided·이중 환불 거절·Interac 은 리더 필요·keyed 그대로·권한)를 확인했다.
- 온라인(테스트 모드): Pay now → Stripe 페이지에서 `4242 4242 4242 4242`, 미래 날짜, CVC 아무 3자리 →
  `/book/pay` 에 "Payment received" → 티 시트 paid, Reports 에 station online 영수증 → `/book/lookup` 에서
  Cancel and refund → Stripe 에 환불. 거절은 `4000 0000 0000 0002`.
- 계산대(테스트 모드): 가상 리더를 고르고 카드 결제 → *Simulate card tap*(신용) 또는 *Simulate Interac*(체크) →
  결제 줄 생김 → 줄 × = 환불(Interac 은 다시 *Simulate Interac*) → Charge → Reports 에서 Refund.

## 아직 모르는 것

- 실제 S700 에서 `card_present` 승인번호가 `receipt.authorization_code` 로 오는지. 없으면 승인번호 자리에
  charge id(`ch_…`)가 들어간다(기록·환불에는 지장 없다).
- 리더의 팁 화면은 Stripe Dashboard 의 Terminal 설정(Configuration → Tipping)으로 켠다. 켜면 팁이
  `amount_details.tip` 으로 와서 결제 줄의 팁이 된다.
- 영수증의 EMV 필수 항목(AID·애플리케이션 이름 등)은 아직 인쇄하지 않는다.
