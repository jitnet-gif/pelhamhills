#!/bin/sh
# 시스템 멈춤 감시 앱(pelham-hills-uptime)의 Fly secrets 를 넣는다.
# Twilio·Gmail 값과 문자 받을 번호(STAFF_ALERT_NUMBERS)는 메인 서버(pelham-hills-api)에 있는 것을
# 그대로 옮긴다 — 화면에 찍지 않는다. 저장소 루트에서:
#
#   sh ops/uptime/set_secrets.sh
#
# 받는 사람을 바꾸려면:
#   fly secrets set -a pelham-hills-uptime UPTIME_SMS_TO="+19055551234,+19055555678"
#   fly secrets set -a pelham-hills-uptime UPTIME_EMAIL_TO="a@x.ca,b@y.com"
set -eu
FROM=pelham-hills-api
TO=pelham-hills-uptime

# 메인 서버의 printenv 를 감시 앱 이름으로 바꿔 secrets import 로 넘긴다(값은 파이프로만 지나간다).
fly ssh console -q -a "$FROM" -C 'sh -c "
  echo TWILIO_ACCOUNT_SID=\$TWILIO_ACCOUNT_SID
  echo TWILIO_AUTH_TOKEN=\$TWILIO_AUTH_TOKEN
  echo TWILIO_PHONE_NUMBER=\$TWILIO_PHONE_NUMBER
  echo UPTIME_SMS_TO=\$STAFF_ALERT_NUMBERS
  echo UPTIME_SMTP_USER=\$RECEIPT_SMTP_USER
  echo UPTIME_SMTP_PASSWORD=\$RECEIPT_SMTP_PASSWORD
"' | tr -d '\r' | grep -v '=$' | fly secrets import -a "$TO"

fly secrets list -a "$TO"
echo "Sending a test alert…"
fly ssh console -q -a "$TO" -C "python uptime_watch.py --test"
