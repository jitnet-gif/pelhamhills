# 카드 단말기 연동 (J.P. Morgan Payment Terminal Application) — 2026-10-09

계산대 화면이 DX8000 으로 금액을 보내고, 승인번호·카드 끝 4자리·팁을 자동으로 받아 적는다.
직원이 단말기에 금액을 치고 승인번호를 옮겨 적던 방식(`keyed`)은 그대로 남아 있다(단말기 고장 시 대비).

## 구조

```
계산대 브라우저 (pelhamhills 사이트, /pos)
   │  wss://<단말기 IP>:8443   ← 매장 LAN, JSON over WebSocket (PTA semi-integrated)
   ▼
DX8000 (J.P. Morgan PTA) ── 카드 승인 ──▶ J.P. Morgan / Chase
   │
   └─ 승인 결과 → 브라우저 → Supabase `pelham_staff_terminal_record` (0019) → Charge 때 계산서에 묶임
```

- 카드 번호·가맹점 키는 단말기에만 있다. 사이트(정적 export)에 비밀 키가 필요 없다.
- 서버(Fly/Supabase)는 단말기에 닿지 않는다. 단말기와 통신하는 것은 계산대 브라우저다.
- 승인은 **Charge 전에** 서버에 남는다. 화면을 닫았다 열어도 결제 줄이 되살아난다.
- 연결이 끊기면 `LastTransaction` 으로 결과를 다시 묻는다. 확실하지 않으면 "단말기 화면을 확인하라"고
  멈춘다 — 카드를 두 번 긁지 않게.

| 코드 | 역할 |
|---|---|
| `frontend/lib/pos/terminal.ts` | WebSocket 클라이언트, 설정(기기별), 복구, 연습 모드 |
| `frontend/components/pos/BillPanel.tsx` | "Send $X to terminal", 취소, 결제 줄 삭제 = VOID/REFUND, 단말기 설정 |
| `frontend/components/reports/SalesReport.tsx` | 환불 화면의 "Void on terminal" / "Refund on terminal" |
| `supabase/migrations/0019_terminal_payments.sql` | 단말기 거래 기록 테이블, `pelham_staff_bill_pay` 검증 |

## 켜기 전에 해야 할 일 (사람이 할 일)

1. **J.P. Morgan 온보딩.** 지금 DX8000 은 단독(standalone) Chase 앱으로 돌고 있다. 연동하려면 단말기에
   **Payment Terminal Application 을 semi-integrated 모드로** 올려야 한다. 담당 Integration Specialist 에게
   요청한다(POS 시뮬레이터 앱도 같은 사람에게 받는다). 캐나다(CAD, Interac) 가맹점이라는 것을 같이 알린다.
2. **네트워크.** 단말기와 계산대 PC 가 같은 Wi-Fi/LAN 에 있고, 단말기 IP 를 공유기에서 고정(DHCP 예약)한다.
   대기 화면이 "Waiting for POS Connection" 이면 준비된 것이다.
3. **Supabase.** SQL Editor 에 `0019_terminal_payments.sql` 전체를 붙여 한 번 실행(다시 실행해도 안전).
4. **계산대 PC 마다**(설정은 기기별):
   - `/pos` → 계산서 아래 **Card terminal** → Mode = *Linked*, IP 입력 → *Trust the terminal certificate*
     링크를 한 번 열어 인증서를 수락 → *Test connection*.
   - Chrome 이 "로컬 네트워크의 기기에 접근" 권한을 물으면 허용한다.
   - 인증서 경고를 매번 보지 않으려면 PTA 의 CSR → 인증서 가져오기 절차(문서의 Certificate handling)로
     클럽 내부 CA 인증서를 단말기에 넣고, 그 루트 CA 를 계산대 PC 에 설치한다.
5. **연습.** Mode = *Practice* 로 두면 단말기 없이 흐름을 연습한다. 금액 끝자리가 `.13` 이면 거절된다.

## 직원 화면 흐름

- 카드/체크카드 → **Send $X to terminal** → 손님이 단말기에서 카드 → 승인되면 결제 줄이 생김 → Charge.
  체크카드로 처리되면 수단이 자동으로 Debit 이 된다. 팁은 단말기 설정대로 손님이 고른다.
- 진행 중 **Cancel** — 은행과 통신을 시작한 뒤에는 단말기가 거절한다.
- Charge 전에 결제 줄 ×: 신용카드는 VOID(카드 불필요), 체크카드는 REFUND(카드 다시 탭).
- 환불(Reports → 영수증 → Refund): 연동으로 받은 결제마다 *Void on terminal*(그날 배치 마감 전) 또는
  *Refund on terminal* → 그 다음 *Confirm refund* 로 장부를 맞춘다.
- 단말기가 안 되면 *Terminal not working? Enter the approval code by hand* — 예전 방식.

## 확인된 것 / 아직 모르는 것

- 0019 는 로컬 Postgres 에서 0001–0018 위에 적용·재적용했고, 금액·팁 불일치, 수단 불일치, 승인 재사용,
  VOID 된 승인, 기존 keyed 결제 시나리오를 확인했다.
- **실제 단말기로는 아직 시험하지 않았다.** 문서에 없어서 추정한 부분 — 단말기에서 확인할 것:
  - `Status` 알림의 `context` 값(화면 문구용, 결과 판단에는 쓰지 않음).
  - 우리가 보낸 `reference` 가 응답·`LastTransaction` 의 `reference` 로 그대로 돌아오는지(복구가 이것에 의존).
  - 체크카드 `cardTypeProcessed = 2`, `tipAmount`·`totalAmount` 관계(팁 = `tipAmount`).
  - 연결 포트: 문서 예시는 8443, 시뮬레이터 안내는 8442.

문서: https://developer.payments.jpmorgan.com/docs/commerce/in-store-payments/capabilities/payment-terminal-application
