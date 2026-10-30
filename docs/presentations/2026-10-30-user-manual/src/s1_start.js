CURCH = 0;
add("map", ["전체 지도", "The big picture"], ["사이트 셋, 앱 하나, 전화 하나", "Three sites, one app, one phone line"],
  () => cols(
    [["공개 사이트", "Public site"], ["/ · 클럽 소개, 요금, 회원권", "/ · About, rates, memberships"]],
    [["예약 사이트", "Booking site"], ["/book · 티타임, 시뮬레이터, 내 예약", "/book · Tee times, simulator, my booking"]],
    [["어드민", "Admin"], ["/admin · 직원과 매니저의 작업 화면", "/admin · Staff and manager screens"], "a"],
    [["GPS 앱", "GPS app"], ["손님 휴대폰: 코스 거리, 음식 주문, 지갑", "Guest phone: distances, food, wallet"]],
    [["전화 비서", "Phone assistant"], ["전화로 예약, 음식 주문, 문제 접수", "Booking, food orders and problem reports by phone"]],
    [["Charlie", "Charlie"], ["웹사이트의 음성 예약 도우미", "Voice helper on the website"]],
  ),
  [["직원은 <b>/admin</b>에서 일합니다", "Staff work in <b>/admin</b>"], ["손님은 웹, 앱, 전화 중 편한 곳을 씁니다", "Guests use the web, the app or the phone"], ["모두 같은 예약과 고객 정보를 봅니다", "All of them share the same bookings and customers"]],
  "펠럼 힐스 전체 사용설명서입니다. 저는 호프예요. 시스템은 크게 공개 사이트, 예약 사이트, 직원용 어드민으로 나뉘고, 여기에 손님용 지피에스 앱과 전화 비서가 붙어 있습니다. 어디서 예약하든 같은 티시트에 들어갑니다.",
  "This is the full Pelham Hills user manual. I'm Hope. The system has a public site, a booking site and an admin area for staff, plus a GPS app for guests and a phone assistant. Wherever a guest books, it lands on the same tee sheet.");
add("login", ["로그인·잠금", "Sign-in & lock"], ["직원은 숫자판, 매니저는 이메일", "Staff use the keypad, managers use email"],
  () => g2(win("Staff ID", "/admin", `<div style="text-align:center;font:700 22px var(--mono);letter-spacing:.3em">• • • •</div>${g3(btn("1"), btn("2"), btn("3"), btn("4"), btn("5"), btn("6"), btn("7"), btn("8"), btn("9"), btn("⌫"), btn("0"), btn("OK", "m"))}<small style="color:var(--muted)">Manager sign in</small>`),
    win("Screen locked", "", `<p style="margin:0">${L("잠깐 자리를 비우면 화면이 잠깁니다. 작업은 뒤에 그대로 있습니다.", "The screen locks when idle. Your work stays open underneath.")}</p>${fld("Staff ID", "• • • •")}${btns(btn("Sign out"))}`)),
  [["Shift ID <b>4~8자리</b>를 누릅니다. 4자리면 저절로 확인", "Enter a <b>4–8 digit</b> Shift ID. Four digits check automatically"], ["긴 ID는 이어서 누르고 <b>OK</b>", "For longer IDs, keep going and press <b>OK</b>"], ["매니저는 <b>Manager sign in</b>", "Managers use <b>Manager sign in</b>"], ["기본 <b>2분</b> 동안 쓰지 않으면 잠김, 새로고침으로 못 풉니다", "Locks after <b>2 idle minutes</b> by default. Refresh won't unlock it"]],
  "어드민을 열면 숫자판이 나옵니다. 시프트 아이디 네 자리를 누르면 바로 들어가고, 더 긴 아이디는 끝까지 누른 뒤 오케이를 누르세요. 매니저는 매니저 사인 인에서 이메일로 로그인합니다. 기본으로 이 분 동안 쓰지 않으면 화면이 잠기는데, 하던 작업은 그대로 있으니 직원 아이디만 다시 넣으면 됩니다.",
  "Open admin and you get a number pad. Type your four digit Shift ID and you're in. Longer IDs need the OK key. Managers use Manager sign in with email and password. By default the screen locks after two idle minutes. Your work stays open, so just enter a staff ID again.");
add("lang", ["EN / 한 전환", "EN / 한 switch"], ["단추 하나로 영어와 한국어", "One button for English and Korean"],
  () => win("Pelham Hills", "/admin", `${btns(btn("EN / 한", "m"))}${table([["영어 화면", "English"], ["한국어 화면", "Korean"]], [["Tee Sheet", "티 시트"], ["Reports", "보고서"]])}<small style="color:var(--muted)">${L("번역 표에 있는 글자만 바뀝니다. 위 한글은 예시입니다.", "Only words in the dictionary change. The Korean above is an example.")}</small>`),
  [["<b>EN / 한</b> 단추는 사이드바, 머리글, 로그인 카드에 있습니다", "The <b>EN / 한</b> button is in the sidebar, header and login cards"], ["누를 때마다 바뀌고 기기별로 기억합니다", "Each press switches it, and each browser remembers"], ["이름, 금액, 입력한 내용은 그대로", "Names, amounts and what you typed stay as they are"], ["번역 표에 없는 글자는 원문으로 남습니다", "Words missing from the dictionary stay in the original"], ["이 설명서도 위쪽 <b>가 / Aa</b>로 글과 목소리가 함께 바뀝니다", "This manual's <b>가 / Aa</b> buttons switch both text and voice"]],
  "이 앤 한 단추를 누르면 화면이 영어와 한국어로 바뀝니다. 이 브라우저는 고른 언어를 기억합니다. 이름이나 금액처럼 입력된 값은 바뀌지 않고, 번역 표에 없는 글자는 원래 글자로 남습니다. 이 설명서도 위쪽 언어 단추를 누르면 글과 제 목소리가 함께 바뀝니다.",
  "The E N slash Han button switches the screen between English and Korean, and the browser remembers your choice. Names, amounts and anything typed stay the same, and words missing from the dictionary stay in the original language. In this manual, the language buttons at the top switch both the text and my voice.");
add("menu", ["메뉴 세 갈래", "Three menus"], ["왼쪽 메뉴는 부서별로 세 가지", "The left menu has three divisions"],
  () => cols(
    [["Golf", "Golf"], ["Tee Sheet, ProShop Sale, Customers, Memberships, Promotions, Gift Cards, Calls & SMS, Marketing, Reports, Account Setup", "Tee Sheet, ProShop Sale, Customers, Memberships, Promotions, Gift Cards, Calls & SMS, Marketing, Reports, Account Setup"], "a"],
    [["Snack Bar & Retail", "Snack Bar & Retail"], ["Snack Bar / Bev Cart, Pro Shop Retail, Camera Scan, Gift Cards, Reports", "Snack Bar / Bev Cart, Pro Shop Retail, Camera Scan, Gift Cards, Reports"]],
    [["Indoor Golf Simulator", "Indoor Golf Simulator"], ["Bay Sheet, Online Booking, Customers, Calls & SMS, Reports", "Bay Sheet, Online Booking, Customers, Calls & SMS, Reports"]],
  ),
  [["위쪽 드롭다운으로 부서를 바꿉니다", "Switch divisions with the dropdown at the top"], ["계정마다 보이는 메뉴가 다릅니다", "Each account sees different items"], ["없는 메뉴는 Account Setup에서 켜 달라고 요청하세요", "If something is missing, ask for it in Account Setup"], ["휴대폰에서는 아래쪽 탭 네 개: Tee Sheet, Customers, Promotions, Reports", "On phones, four bottom tabs: Tee Sheet, Customers, Promotions, Reports"]],
  "왼쪽 메뉴는 골프, 스낵바와 리테일, 실내 시뮬레이터 세 갈래입니다. 위쪽 드롭다운으로 바꿀 수 있어요. 계정마다 권한에 따라 보이는 항목이 다릅니다. 필요한 메뉴가 보이지 않으면 관리자에게 어카운트 셋업에서 켜 달라고 요청하세요.",
  "The left menu has three divisions: Golf, Snack Bar and Retail, and Indoor Golf Simulator. Use the dropdown at the top to switch. Each account sees different items. If you need a screen you can't see, ask an admin to turn it on in Account Setup.");
