# 온라인 결제 (Authorize.net Accept Hosted) — 2026-10-09

손님이 예약 사이트에서 티타임·실내 골프 요금을 **미리 낼 수 있다(선택)**. 예약은 지금처럼 바로 확정되고,
확정 화면과 `/book/lookup` 에 "Pay $X now" 가 생긴다. 안 내면 예전처럼 와서 낸다.

## 결정 (2026-10-09)

| 항목 | 결정 |
|---|---|
| 결제 시점 | 선택. 예약은 결제 없이 확정 |
| 대상 | 티타임(예약 전체, 그린피 + HST) · 실내 골프(베이 요금 + HST). 카트는 프로 샵에서 |
| 취소 | 시작 24시간 전까지 온라인 취소 = **자동 전액 환불**(정산 전 void, 정산 후 refund) |
| 키 보관 | Fly FastAPI(`pelham-hills-api`)의 `fly secrets` |

## 구조

```
손님 브라우저 (/book/*)
  │ 1. POST /payments/online/checkout {code, email}
  ▼
FastAPI (Fly)  ──2. pelham_online_pay_start (금액 결정, invoice PHW…)──▶ Supabase (0020)
  │ 3. getHostedPaymentPageRequest → token
  ▼
브라우저가 token 을 Authorize.net 결제 폼으로 POST — 카드 입력은 Authorize.net 페이지에서만
  │
  ├─▶ 웹훅 authcapture.created ──▶ FastAPI ─┐
  └─▶ /book/pay?invoice=… → /status/{inv} ──┤ 4. getTransactionDetails 로 다시 확인
                                            ▼
                    pelham_online_pay_complete: 계산서(station online) + 결제 줄(card, entry online)
                    → 티타임 플레이어 paid / 베이 예약 paid. 기록할 수 없으면 즉시 void/refund.
```

- 카드 번호는 우리 사이트·서버·DB 어디에도 오지 않는다(PCI SAQ A). 저장하는 것은 거래 ID, 승인번호,
  카드 브랜드, 끝 4자리.
- 금액은 SQL 이 정한다. 승인 금액이 시작할 때 금액과 다르거나, 그사이 예약이 취소·변경됐거나, 프로 샵에서
  먼저 받았으면 장부에 쓰지 않고 그 거래를 곧바로 되돌린다(`orphaned` → `voided`/`refunded`).
- 온라인으로 받은 계산서는 POS 의 Refund 로 닫을 수 없다(카드에 돈이 안 돌아가므로). 직원이 환불해야 하면
  **Authorize.net Merchant Interface 에서 Refund/Void** 한다 → 웹훅이 계산서를 환불 처리하고 플레이어를
  미결제로 돌린다(예약은 취소하지 않는다).

| 코드 | 역할 |
|---|---|
| `supabase/migrations/0020_online_payments.sql` | `pelham_online_payments` 표, service_role 전용 함수 7개, 계산서 보호 트리거 |
| `backend/services/authorize_net.py` | Authorize.net JSON API: 결제 폼 토큰, 거래 조회, 미정산 목록, void/refund, 웹훅 서명 |
| `backend/api/routes/payments.py` | `/payments/online/{quote,checkout,status,cancel,webhook,config}` |
| `frontend/components/booking/PayOnline.tsx` | 확정 화면·조회 화면의 결제 칸 |
| `frontend/app/book/pay/page.tsx` | 결제 뒤 돌아오는 화면(결과 확인·대기) |
| `frontend/app/book/lookup/page.tsx` | 온라인으로 낸 예약의 "Cancel and refund" |

## 켜는 순서 (사람이 할 일)

1. **Supabase**: SQL Editor 에 `0020_online_payments.sql` 전체를 붙여 한 번 실행(다시 실행해도 안전).
   0005·0008·0012 가 먼저 있어야 한다(없으면 무엇이 빠졌는지 말하고 멈춘다).
2. **Authorize.net 샌드박스 계정**: https://developer.authorize.net/hello_world/sandbox.html 에서 만들고
   Account → Settings → API Credentials & Keys 에서 API Login ID, Transaction Key, Signature Key 를 받는다.
3. **Fly 시크릿**:
   ```
   flyctl secrets set -a pelham-hills-api \
     AUTHORIZE_NET_API_LOGIN_ID=... AUTHORIZE_NET_TRANSACTION_KEY=... \
     AUTHORIZE_NET_SIGNATURE_KEY=... AUTHORIZE_NET_ENV=sandbox
   ```
   키가 들어가는 순간 Pay 버튼이 보인다. 빼면 다시 숨는다.
4. **웹훅**: Merchant Interface → Account → Webhooks → Add Endpoint
   `https://pelham-hills-api.fly.dev/api/v1/payments/online/webhook`, 이벤트
   `authcapture.created`, `refund.created`, `void.created`, `fraud.approved`. (없어도 결과 화면이 직접 확인하지만,
   손님이 결제 후 창을 닫는 경우와 직원 환불은 웹훅이 있어야 바로 반영된다.)
5. **운영 전환**: 실제 가맹점 계정(캐나다 CAD)으로 키를 바꾸고 `AUTHORIZE_NET_ENV=production`.
6. **CORS**: 사이트가 `pelhamhills.vercel.app` 이 아닌 도메인(예: pelhamhills.com)에서 열리면 그 출처를
   `ALLOWED_ORIGINS` 에 넣는다(`flyctl secrets set ALLOWED_ORIGINS=...`, 기본 목록 전체 + 새 도메인).

## 시험 방법

- 백엔드: `python -m pytest backend/tests/test_payments.py -q` (20개, 네트워크 없음 — Authorize.net·SQL 가짜).
- SQL: 0001–0020 을 로컬 Postgres 에 올리고 시나리오 41개(승인·거절·중복·금액 불일치·가격 변경·취소 환불·
  마감 후 취소·POS 환불 차단·실내 골프·직원 환불 웹훅). 0019 가 있든 없든 통과.
- 샌드박스 카드: Visa `4111 1111 1111 1111`, 유효기간 미래 아무 날, CVV `123`. 거절을 보려면 금액을 바꿀 수 없으니
  (금액은 서버가 정한다) 우편번호 `46282` 를 넣는다(샌드박스 거절 트리거).
- 확인할 것: Pay → Authorize.net 폼 → Pay → Continue → `/book/pay` 에 "Payment received" → 티 시트에
  플레이어 paid, Reports 에 station online 영수증 → `/book/lookup` 에서 Cancel and refund → 예약 cancelled,
  계산서 refunded, Authorize.net 에 Void.

## 아직 모르는 것

- 웹훅 서명: 문서대로 `X-ANET-Signature: sha512=<HEX>`, 키는 Signature Key 문자열 그대로 HMAC-SHA512.
  샌드박스 첫 웹훅에서 401 이 나면 키를 16진수 바이트로 풀어 쓰는 쪽을 확인한다.
- 실내 골프 요금: 예약의 `total_price`(세전)를 그대로 쓴다. 전화 예약처럼 $20/h 가 아닌 베이가 생기면 그 값을 따른다.
