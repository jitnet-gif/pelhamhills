# 데이터 백업 (Data Backup)

클럽 표(`public.pelham_*` — 티 시트, 계산서·결제, 고객, 멤버십, 리테일, 시뮬레이터 …)를 **표마다 CSV 한 개 + `manifest.json`** 으로
받는다. 같은 DB 를 쓰는 GPS·스코어카드 앱의 표와 로그인 계정·비밀번호는 들어가지 않는다.

쓸 수 있는 계정: **매니저(Reports 체크)와 계정 관리자** — `supabase/migrations/0100_data_backup.sql`.

## 처음 한 번

1. Supabase SQL Editor 에 `0100_data_backup.sql` 전체를 붙여 실행.
2. 사무실 맥에서:

   ```sh
   zsh scripts/backup/install_daily_backup.sh        # 매일 23:30
   ```

3. 만들어진 `~/.pelham-backup.env` 에 매니저 계정 이메일·비밀번호를 적는다.
4. 바로 한 번 돌려 본다: `node ~/.pelham-backup/pelham_backup.mjs --manual`

백업은 `~/PelhamBackups/pelhamhills-backup-YYYY-MM-DD_HHMM/` 에 쌓이고 30일이 지나면 지워진다.
어드민 **Data Backup** 화면의 "Recent backups" 에 매일 밤 `Nightly` 로 한 줄씩 남는다. 하루 넘게 없으면 화면에 빨간 경고가 뜬다.

## 복원

- **화면**: Data Backup → Choose backup folder → 표 고르기 → Merge / Replace → `RESTORE` 입력.
- **터미널**:

  ```sh
  node scripts/backup/pelham_restore.mjs ~/PelhamBackups/pelhamhills-backup-2026-10-24_2330            # 미리 보기
  node scripts/backup/pelham_restore.mjs <폴더> --yes                                                  # merge
  node scripts/backup/pelham_restore.mjs <폴더> --replace --yes                                        # replace
  node scripts/backup/pelham_restore.mjs <폴더> --tables pelham_customers,pelham_memberships --yes
  ```

- **Merge**: 백업의 줄을 되살린다(같은 ID 면 백업 값으로). 백업 뒤에 생긴 줄은 남는다.
- **Replace**: 백업에 없는 줄도 지워 백업 시점과 똑같이 만든다. 그 뒤의 매출·예약은 사라진다.
- 복원 전에 지금 상태를 먼저 받아 둔다(되돌릴 수 있게).
- 권한 명단(`*_viewers`, `*_admins`, 매니저 PIN, 변경 기록)은 계정 관리자만 복원할 수 있다.

## 끄기 / 시각 바꾸기

```sh
zsh scripts/backup/install_daily_backup.sh 02:00    # 시각 바꾸기
zsh scripts/backup/install_daily_backup.sh --remove # 끄기
```

CSV 모양(값이 있으면 언제나 따옴표, NULL 은 따옴표 없는 빈칸)은 `lib.mjs` 와 `frontend/lib/backup.ts` 가 같아야 한다.
