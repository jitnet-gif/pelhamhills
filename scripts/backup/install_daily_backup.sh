#!/bin/zsh
# 매일 밤 자동 백업을 이 맥에 건다(launchd). 다시 돌려도 안전하다 — 스크립트를 새로 복사하고 작업을 다시 건다.
#
#   zsh scripts/backup/install_daily_backup.sh          매일 23:30 (클럽 시간 = 이 맥의 시간)
#   zsh scripts/backup/install_daily_backup.sh 02:15    시각을 바꿀 때
#   zsh scripts/backup/install_daily_backup.sh --remove 끄기
#
# 맥이 잠자고 있으면 깨어날 때 한 번 돈다. 꺼져 있던 날은 건너뛴다.
# 스크립트는 ~/.pelham-backup/ 에 복사해서 돌린다 — 저장소를 옮기거나 브랜치를 바꿔도 밤 작업이 깨지지 않게.

set -euo pipefail

LABEL="ca.pelhamhills.backup"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
APP_DIR="$HOME/.pelham-backup"
ENV_FILE="$HOME/.pelham-backup.env"
HERE="${0:A:h}"

if [[ "${1:-}" == "--remove" ]]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "Daily backup removed. Backups already saved are kept."
  exit 0
fi

AT="${1:-23:30}"
if [[ ! "$AT" =~ '^([01]?[0-9]|2[0-3]):[0-5][0-9]$' ]]; then
  echo "Time must look like 23:30" >&2
  exit 2
fi
HOUR=$((10#${AT%%:*}))
MINUTE=$((10#${AT##*:}))

NODE="$(command -v node || true)"
if [[ -z "$NODE" ]]; then
  echo "node is not installed. Install Node.js 18 or newer first." >&2
  exit 1
fi

mkdir -p "$APP_DIR" "$HOME/Library/LaunchAgents"
cp "$HERE/lib.mjs" "$HERE/pelham_backup.mjs" "$HERE/pelham_restore.mjs" "$APP_DIR/"

if [[ ! -f "$ENV_FILE" ]]; then
  cat > "$ENV_FILE" <<'EOF'
# Pelham Hills daily backup. Use a manager (Reports) account or the account manager.
PELHAM_BACKUP_EMAIL=
PELHAM_BACKUP_PASSWORD=
# PELHAM_BACKUP_DIR=~/PelhamBackups
# PELHAM_BACKUP_KEEP_DAYS=30
EOF
  echo "Made $ENV_FILE — put the manager email and password in it."
fi
chmod 600 "$ENV_FILE"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$APP_DIR/pelham_backup.mjs</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>$HOUR</integer>
    <key>Minute</key><integer>$MINUTE</integer>
  </dict>
  <key>StandardOutPath</key><string>$APP_DIR/backup.log</string>
  <key>StandardErrorPath</key><string>$APP_DIR/backup.log</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"

printf 'Daily backup is on: every day at %02d:%02d.\n' "$HOUR" "$MINUTE"
echo "Log: $APP_DIR/backup.log"
echo "Try it now: node $APP_DIR/pelham_backup.mjs --manual"
