# Pelham Starter — 1번 티 폰 앱

회사 Android 폰 한 대로 1번 티에서 **티시트 보기 · 찾기 · 체크인 · 탭 결제 · 영수증**을 한다.

- 화면은 전부 웹(`https://pelhamhills-golf.vercel.app/teesheet/mobile`, 소스 `frontend/components/starter/StarterTeeSheet.tsx`).
  웹을 고쳐 배포하면 앱을 다시 설치하지 않아도 바로 바뀐다.
- 이 앱은 브라우저가 못 하는 두 가지만 한다.
  - **탭 결제**: Stripe Terminal SDK 의 Tap to Pay — 폰이 카드 리더가 된다(`TapPayments.kt`).
  - **영수증 인쇄**: 페어링한 블루투스 프린터(SPP) 또는 와이파이 TM-m30III(TCP 9100)에 계산대와 같은 ESC/POS 를 보낸다(`Printers.kt`).
- 웹과 앱의 약속은 `frontend/lib/starter/bridge.ts` 머리말과 `WebBridge.kt` 에 있다.

## 돈의 흐름 (계산대 S700 과 같다)

1. 예약 카드에서 선수를 고르고 **Tap to pay** → 웹이 계산서를 연다(`pelham_staff_bill_open` + `add_tee`). 합계는 계산서 SQL 이 정한다.
2. 웹 → Fly `POST /payments/terminal/phone/sale` — 직원 확인, 단말기 장부에 pending 한 줄(0021), PaymentIntent. `client_secret` 을 돌려준다.
3. 앱이 그 PaymentIntent 로 카드를 읽고 확정한다. 웹은 결과를 **서버 기록으로** 다시 확인한다(`/terminal/txn/{id}`, 웹훅도 같은 일).
4. 승인된 기록(`terminal_txn`)으로 계산서를 결제한다 → 마감·Stripe check·승인 문자(0028)가 계산대와 똑같이 잡힌다.
5. 장부 줄에 `reader_id` 가 없는 판매 = 폰 결제. 5분 안에 끝나지 않으면 서버가 PaymentIntent 를 취소한다.

## 빌드

Android Studio 로 이 폴더(`android/starter`)를 열고 Run. 또는:

```sh
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
./gradlew assembleDebug          # app/build/outputs/apk/debug/app-debug.apk
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

로컬 웹으로 시험하려면 `app/build.gradle.kts` 의 `START_URL` 을 바꾼다.

## 폰 준비 (한 번)

1. **폰 조건**: NFC 가 있고 Android 11 이상, 루팅·개발자용 OS 아님. 화면 잠금(PIN) 필수 — Tap to Pay 규칙.
2. APK 설치 → 처음 열 때 **위치 · 근처 기기(블루투스)** 허용, QR 버튼을 처음 누를 때 **카메라** 허용.
3. 직원 계정으로 로그인(데스크톱과 같은 계정).
4. 설정 → 블루투스에서 영수증 프린터를 **페어링** → 앱 아래 🖨 버튼 → 프린터 고르기 → *Print a test receipt*.
   와이파이 TM-m30III 는 IP 를 넣고 *Use*.
5. 설정 → NFC 켜기.

## 테스트 → 실제 결제

- Fly 의 Stripe 키가 `sk_test_…` 이면 앱은 **가상 리더**로 붙는다: 카드 없이 결제 화면이 지나가고 테스트 카드로 승인된다.
  장부·계산서·마감에는 진짜처럼 기록되니, 시험한 계산서는 끝나고 환불·정리한다.
- 실제 키로 바꾸면 같은 앱이 진짜 카드를 받는다. 앱을 다시 만들 필요 없다.
- 영수증이 80mm(48자) 기준이다. 58mm 휴대용 프린터면 줄이 넘친다 — 모델을 알려 주면 폭을 맞춘다.
