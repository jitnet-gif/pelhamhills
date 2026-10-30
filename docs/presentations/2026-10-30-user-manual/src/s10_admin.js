CURCH = 9;
add("acct", ["계정 설정", "Account Setup"], ["누가 어떤 화면을 볼지 정합니다", "Decide who sees which screens"],
  () => win("Account Setup", "/admin/accounts", `${btns(btn("New account", "m"), btn("Edit"), btn("Delete", "r"))}${rw("proshop@", pill("Staff"))}${rw("Screens", "")}${g3(btn("☑ Reports"), btn("☐ Dynamic Pricing"), btn("☐ Events"), btn("☑ Promotions"), btn("☑ Calls & SMS"), btn("☐ Marketing"), btn("☑ Gift Cards"))}`),
  [["계정 관리자만 열 수 있습니다", "Account managers only"], ["비밀번호 <b>8자 이상</b>, 바꾸면 다른 기기는 로그아웃", "Passwords are <b>8+ characters</b>. Changing one signs out other devices"], ["체크한 화면만 메뉴에 나타납니다", "Only ticked screens show in the menu"]],
  "어카운트 셋업은 계정 관리자만 엽니다. 계정을 만들고, 어떤 화면을 볼지 체크합니다. 비밀번호를 바꾸면 다른 기기에서는 로그아웃됩니다.",
  "Account Setup is for account managers. Create accounts and tick the screens each one can see. Changing a password signs that person out on other devices.");
add("backup", ["데이터 백업", "Data Backup"], ["매일 자동, 필요할 때 직접", "Automatic daily, or whenever you need"],
  () => win("Data Backup", "/admin/backup", `${btns(btn("Back up now", "m"))}${rw("pelhamhills-backup-2026-10-30.zip", pill("Downloaded"))}${rw(L("사무실 Mac 매일 밤 백업", "Office Mac nightly backup"), pill(L("30일 보관", "Kept 30 days"), "n"), "PelhamBackups")}${warn("복원은 데이터를 덮어쓸 수 있습니다. 전용 계정만 Merge 또는 Replace를 고르고 RESTORE를 입력합니다.", "Restoring can overwrite data. One dedicated account chooses Merge or Replace and types RESTORE.")}`),
  [["컴퓨터마다 하루 한 번 ZIP이 내려받아집니다", "A ZIP downloads once a day per computer"], ["밤에는 사무실 Mac이 백업하고 30일 보관", "The office Mac backs up nightly and keeps 30 days"], ["<b>복원은 analysis@ 전용</b>", "<b>Restore is analysis@ only</b>"]],
  "데이터 백업은 매니저가 쓰는 화면입니다. 컴퓨터마다 하루 한 번 집 파일이 저절로 내려받아지고, 밤에는 사무실 맥이 따로 백업해서 삼십 일 동안 보관합니다. 복원은 데이터를 덮어쓸 수 있어서 지정된 계정 하나만 할 수 있습니다.",
  "Data Backup is a manager screen. A ZIP file downloads by itself once a day on each computer, and the office Mac makes its own nightly backup, kept for thirty days. Restoring can overwrite data, so only one dedicated account can do it.");
add("samples", ["아직 샘플인 화면", "Screens not live yet"], ["메뉴에 있어도 저장되지 않는 화면", "In the menu, but nothing is saved"],
  () => table([["화면", "Screen"], ["상태", "Status"]], [
    ["Dynamic Pricing", pill(L("샘플, 저장 안 됨", "Sample, not saved"), "g")], ["Events", pill(L("샘플, 저장 안 됨", "Sample, not saved"), "g")], ["Tour Operators", pill(L("샘플, 저장 안 됨", "Sample, not saved"), "g")], ["Settings", pill(L("샘플, 이 브라우저에서만", "Sample, this browser only"), "g")], [["Integrations 표", "Integrations table"], pill(L("샘플", "Sample"), "g")], ["Tee Times & Pricing", pill(L("읽기 전용", "Read-only"), "n")], ["Course Map · CCTV", pill(L("GPS 앱으로 이동", "Opens in the GPS app"), "n")],
  ]),
  [["이 화면에서 바꾼 값은 실제 요금이나 예약에 반영되지 않습니다", "Changes here don't reach real prices or bookings"], ["Tee Times & Pricing은 실제 요금을 보여 주지만 바꿀 수는 없습니다", "Tee Times & Pricing shows real fees but can't change them"], ["더 볼 안내는 메뉴의 <b>Staff Guides</b>", "More help is in <b>Staff Guides</b>"]],
  "마지막으로 꼭 알아 두실 점입니다. 다이내믹 프라이싱, 이벤트, 투어 오퍼레이터, 세팅스, 인티그레이션 표는 아직 샘플 화면이라서 값을 바꿔도 실제로 저장되지 않습니다. 요금은 이 화면들로 바꿀 수 없어요. 궁금한 점은 메뉴의 스태프 가이드를 보시거나 저에게 물어봐 주세요. 사용설명서는 여기까지입니다. 감사합니다.",
  "One last thing to know. Dynamic Pricing, Events, Tour Operators, Settings and the Integrations table are still sample screens, so changes there aren't really saved. You can't change real prices from them. For more help, see Staff Guides in the menu, or just ask me. That's the end of the manual. Thank you.");
