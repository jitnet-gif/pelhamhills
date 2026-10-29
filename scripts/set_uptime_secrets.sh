#!/bin/sh
# 시스템 멈춤 알림(`.github/workflows/uptime.yml`)의 GitHub secrets 를 넣는다.
# Twilio 와 Gmail 값은 Fly 서버(pelham-hills-api)에 있는 것을 그대로 옮긴다 — 화면에 찍지 않는다.
#
#   sh scripts/set_uptime_secrets.sh "+19055551234,+19055555678"   # 문자 받을 번호
#   sh scripts/set_uptime_secrets.sh                                # 번호를 비우면 Fly 의 STAFF_ALERT_NUMBERS
#
# 받는 메일을 바꾸려면: gh secret set UPTIME_EMAIL_TO -R jitnet-gif/pelhamhills --body "a@x.ca,b@y.com"
set -eu
APP=pelham-hills-api
REPO=jitnet-gif/pelhamhills

fly_env() {
  fly ssh console -q -a "$APP" -C "printenv $1" | tr -d '\r\n'
}

copy() {  # copy <GitHub 이름> <Fly 이름>
  value=$(fly_env "$2")
  if [ -z "$value" ]; then
    echo "  ! $2 is empty on Fly — $1 not set"
    return
  fi
  printf %s "$value" | gh secret set "$1" -R "$REPO"
  echo "  ✓ $1"
}

copy TWILIO_ACCOUNT_SID TWILIO_ACCOUNT_SID
copy TWILIO_AUTH_TOKEN TWILIO_AUTH_TOKEN
copy TWILIO_PHONE_NUMBER TWILIO_PHONE_NUMBER
copy UPTIME_SMTP_USER RECEIPT_SMTP_USER
copy UPTIME_SMTP_PASSWORD RECEIPT_SMTP_PASSWORD

if [ -n "${1:-}" ]; then
  printf %s "$1" | gh secret set UPTIME_SMS_TO -R "$REPO"
  echo "  ✓ UPTIME_SMS_TO"
else
  copy UPTIME_SMS_TO STAFF_ALERT_NUMBERS
fi

echo "Sending a test alert…"
gh workflow run uptime.yml -R "$REPO" -f test=true
echo "Done. Watch it at https://github.com/$REPO/actions/workflows/uptime.yml"
