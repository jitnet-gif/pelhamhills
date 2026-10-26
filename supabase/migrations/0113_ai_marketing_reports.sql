-- AI Manager Marketing Strategies — **전략 보고서 보관함**. Claude 가 쓴 전략을 영구 보관하고 "Strategy reports"
-- 탭에서 다시 연다(프레젠테이션 · 전체 글).
--
-- 왜(2026-10-25): 결과가 브라우저(localStorage)에만 있어서 기기를 바꾸거나 기록을 지우면 사라졌다.
-- 사용자 요청: "저장해 줘, 삭제하지 말고, 기존에 했던 것도 찾아서 저장해 줘".
--
-- 바꾸는 것:
-- - `pelham_ai_marketing_reports`: 보고서 한 건 = 기간·언어·요청 문구·모델·누가·언제 + 결과(doc). 같은 결과(doc)는 한 번만.
-- - **지우지 못한다**: 삭제 함수가 없고, delete 를 막는 트리거가 있다(SQL editor 에서도 막힌다).
-- - `pelham_staff_ai_marketing_report_save(...)`: Fly 가 결과를 받자마자 직원 토큰으로 저장한다.
--   화면은 이 브라우저에 남아 있던 옛 결과(source 'browser')를 찾아서 같은 함수로 올린다.
-- - `pelham_staff_ai_marketing_reports()` 목록, `pelham_staff_ai_marketing_report(id)` 한 건.
-- - **공유 링크**: `pelham_staff_ai_marketing_report_share(id, on)` 이 추측할 수 없는 토큰을 만든다(끄면 지운다).
--   그 링크(/strategy?t=토큰)는 로그인 없이 `pelham_ai_marketing_shared_report(token)` 으로 보고서만 읽는다 —
--   누가 만들었는지(이메일)는 내보내지 않는다. 보고서 자체는 공유를 꺼도 그대로 남는다.
-- - 숫자(2222)로 들어오는 열람 계정 reports-view@ 도 명단에 넣는다 — /strategy 에서 대표님이 보관함을 연다.
-- - 2026-10-25 Claude Code 가 화면 숫자로 만든 예시 제안(한국어·영어)을 source 'example' 로 넣어 둔다.
--
-- 명단은 0094 와 같다(매니저 + pelham_ai_marketing_viewers). 전제: 0094. 실행: SQL editor 에 이 파일 전체를
-- 붙여 한 번. 다시 실행해도 안전하다.

do $$
begin
  if to_regprocedure('public.pelham_require_ai_marketing_viewer()') is null then
    raise exception '0113 needs 0094 first (pelham_require_ai_marketing_viewer is missing).';
  end if;
end;
$$;

create table if not exists public.pelham_ai_marketing_reports (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  created_by text not null default '',
  period_from date not null,
  period_to date not null,
  lang text not null check (lang in ('en', 'ko')),
  focus text not null default '',
  model text not null default '',
  source text not null default 'claude' check (source in ('claude', 'browser', 'example')),
  doc jsonb not null,
  doc_hash text not null unique
);

alter table public.pelham_ai_marketing_reports add column if not exists share_token text unique;
alter table public.pelham_ai_marketing_reports add column if not exists shared_at timestamptz;
alter table public.pelham_ai_marketing_reports add column if not exists shared_by text;

create index if not exists pelham_ai_marketing_reports_created on public.pelham_ai_marketing_reports (created_at desc);

alter table public.pelham_ai_marketing_reports enable row level security;
revoke all on public.pelham_ai_marketing_reports from public, anon, authenticated;

-- 지우지 않는다. 내용(doc)도 바꾸지 않는다 — 바뀌는 것은 공유 칸뿐이다.
-- 고칠 일이 있으면 이 트리거를 먼저 drop 해야 한다(일부러 번거롭게).
create or replace function public.pelham_ai_marketing_reports_keep()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    if new.doc is distinct from old.doc or new.doc_hash is distinct from old.doc_hash
       or new.created_at is distinct from old.created_at or new.period_from is distinct from old.period_from
       or new.period_to is distinct from old.period_to or new.lang is distinct from old.lang then
      raise exception 'A saved strategy report cannot be changed. Ask Claude again for a new one.';
    end if;
    return new;
  end if;
  raise exception 'Strategy reports are kept for good and cannot be deleted.';
end;
$$;

drop trigger if exists pelham_ai_marketing_reports_keep on public.pelham_ai_marketing_reports;
create trigger pelham_ai_marketing_reports_keep
  before delete or truncate on public.pelham_ai_marketing_reports
  for each statement execute function public.pelham_ai_marketing_reports_keep();
drop trigger if exists pelham_ai_marketing_reports_frozen on public.pelham_ai_marketing_reports;
create trigger pelham_ai_marketing_reports_frozen
  before update on public.pelham_ai_marketing_reports
  for each row execute function public.pelham_ai_marketing_reports_keep();

-- ===== 저장 ============================================================

create or replace function public.pelham_staff_ai_marketing_report_save(
  p_from date, p_to date, p_lang text, p_focus text, p_doc jsonb, p_source text default 'claude')
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_hash text;
  v_id uuid;
  v_email text;
begin
  perform public.pelham_require_ai_marketing_viewer();
  if p_doc is null or jsonb_typeof(p_doc) <> 'object' or not (p_doc ? 'headline') or not (p_doc ? 'strategies') then
    perform public.pelham_fail('400', 'That is not a strategy report.');
  end if;
  if p_lang not in ('en', 'ko') or coalesce(p_source, '') not in ('claude', 'browser') then
    perform public.pelham_fail('400', 'Unknown language or source.');
  end if;
  if p_from is null or p_to is null or p_from > p_to then
    perform public.pelham_fail('400', 'Pick a valid period.');
  end if;

  v_hash := md5(p_doc::text);
  select id into v_id from public.pelham_ai_marketing_reports where doc_hash = v_hash;
  if v_id is not null then
    return jsonb_build_object('id', v_id, 'saved', false);
  end if;

  select lower(u.email) into v_email from auth.users u where u.id = auth.uid();
  insert into public.pelham_ai_marketing_reports
    (created_by, period_from, period_to, lang, focus, model, source, doc, doc_hash)
  values
    (coalesce(v_email, ''), p_from, p_to, p_lang, left(btrim(coalesce(p_focus, '')), 500),
     coalesce(p_doc->>'model', ''), p_source, p_doc, v_hash)
  on conflict (doc_hash) do nothing
  returning id into v_id;
  if v_id is null then
    select id into v_id from public.pelham_ai_marketing_reports where doc_hash = v_hash;
    return jsonb_build_object('id', v_id, 'saved', false);
  end if;
  return jsonb_build_object('id', v_id, 'saved', true);
end;
$$;

-- ===== 읽기 ============================================================

create or replace function public.pelham_staff_ai_marketing_reports()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.pelham_require_ai_marketing_viewer();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', r.id,
             'created_at', public.pelham_iso(r.created_at),
             'created_by', r.created_by,
             'from', r.period_from,
             'to', r.period_to,
             'lang', r.lang,
             'focus', r.focus,
             'model', r.model,
             'source', r.source,
             'headline', r.doc->>'headline',
             'strategies', jsonb_array_length(coalesce(r.doc->'strategies', '[]'::jsonb)),
             'share_token', r.share_token)
           order by r.created_at desc)
      from public.pelham_ai_marketing_reports r), '[]'::jsonb);
end;
$$;

create or replace function public.pelham_staff_ai_marketing_report(p_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_doc jsonb;
begin
  perform public.pelham_require_ai_marketing_viewer();
  select r.doc into v_doc from public.pelham_ai_marketing_reports r where r.id = p_id;
  if v_doc is null then
    perform public.pelham_fail('404', 'That report is not in the archive.');
  end if;
  return v_doc;
end;
$$;

-- ===== 공유 =============================================================

create or replace function public.pelham_staff_ai_marketing_report_share(p_id uuid, p_on boolean)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_token text;
  v_email text;
begin
  perform public.pelham_require_ai_marketing_viewer();
  if not exists (select 1 from public.pelham_ai_marketing_reports where id = p_id) then
    perform public.pelham_fail('404', 'That report is not in the archive.');
  end if;
  if p_on then
    select lower(u.email) into v_email from auth.users u where u.id = auth.uid();
    update public.pelham_ai_marketing_reports
       set share_token = coalesce(share_token, encode(extensions.gen_random_bytes(18), 'hex')),
           shared_at = coalesce(shared_at, now()),
           shared_by = coalesce(shared_by, v_email)
     where id = p_id
     returning share_token into v_token;
  else
    update public.pelham_ai_marketing_reports
       set share_token = null, shared_at = null, shared_by = null
     where id = p_id;
  end if;
  return jsonb_build_object('id', p_id, 'share_token', v_token);
end;
$$;

-- 공개: 링크의 토큰으로 보고서 한 건. 만든 사람 이메일은 내보내지 않는다.
create or replace function public.pelham_ai_marketing_shared_report(p_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_r public.pelham_ai_marketing_reports;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{36}$' then
    perform public.pelham_fail('404', 'This strategy link is not valid or is no longer shared.');
  end if;
  select * into v_r from public.pelham_ai_marketing_reports where share_token = p_token;
  if v_r.id is null then
    perform public.pelham_fail('404', 'This strategy link is not valid or is no longer shared.');
  end if;
  return jsonb_build_object(
    'doc', v_r.doc, 'lang', v_r.lang, 'from', v_r.period_from, 'to', v_r.period_to,
    'created_at', public.pelham_iso(v_r.created_at), 'source', v_r.source);
end;
$$;

-- ===== 예시 제안 (2026-10-25, 화면 숫자 기준) ==============================

insert into public.pelham_ai_marketing_reports
  (created_at, created_by, period_from, period_to, lang, focus, model, source, doc, doc_hash)
select '2026-10-25 18:30:00-04'::timestamptz, 'claude code', '2026-09-26', '2026-10-25', v.lang, '',
       'example · Claude Code', 'example', v.doc, md5(v.doc::text)
  from (values
  ('{"headline": "주말 오전은 꽉 차고 평일 오후는 비어 있다 — 빈 시간을 이웃·학생·해밀턴 경계로 채우고, 주말 손님은 직접 예약으로 옮긴다.", "facts": [{"fact": "30일 동안 1,016 라운드, 예약 408건.", "evidence": "rounds, bookings"}, {"fact": "주말 오전이 가장 붐빈다: 일반 하루 10.7, 골프나우 8.2 라운드.", "evidence": "grid weekend am"}, {"fact": "평일 12시 이후는 세 그룹 합계 하루 약 6 라운드뿐.", "evidence": "grid weekday pm + twilight"}, {"fact": "회원은 평일 오전에 몰린다(하루 7.8).", "evidence": "grid member weekday am"}, {"fact": "골퍼 1인 매출 $54.20 (결제 골퍼 373명).", "evidence": "sales_by_seg"}, {"fact": "고객 기록에 연결된 라운드 0% — 재방문율을 잴 수 없다.", "evidence": "linked_rounds"}], "strategies": [{"title": "평일 오후 채우기 — 이웃과 학생", "target_group": "일반", "time_slot": "평일 12시 이후", "area": "웰랜드·펠햄, 나이아가라 칼리지", "why": "평일 12–3시와 3시 이후가 하루 약 6 라운드로 거의 비어 있다.", "offer": "평일 12시 이후 전용 요금 (코드 PROMO-WKPM)", "channels": ["문자(동의자)", "웹사이트 팝업", "칼리지 게시판"], "steps": ["프로모 코드 만들기", "명단 10%는 비교군으로 남기기", "문자·팝업 시작", "2주 뒤 결과 보기"], "kpi": "평일 12–3·3시+ 라운드, 코드 사용 수", "budget": "low", "narration": "첫 번째 전략은 평일 오후 채우기입니다. 웰랜드와 펠햄 이웃, 나이아가라 칼리지 학생에게 평일 열두 시 이후 전용 요금을 프로모 코드로 알립니다. 문자 동의한 사람에게만 보내고, 명단의 십 퍼센트는 비교군으로 남깁니다. 성과는 그 시간대 라운드 수와 코드 사용 수로 잽니다.", "launch": {"sms": "Pelham Hills: weekday afternoons are wide open. Tee off after 12 PM Mon-Fri at our after-noon rate with code PROMO-WKPM. Book at pelhamhills.com - offer ends Nov 8.", "call": "Hi, this is Pelham Hills Golf Club. Weekday afternoons are quiet right now, so we have a special after-noon rate Monday to Friday. Would you like me to book you a tee time?", "segment": "non_members", "popup_title": "Weekday afternoon rate", "popup_body": "Tee off after 12 PM, Monday to Friday, at our after-noon rate. Use code PROMO-WKPM when you book.", "popup_link_label": "Book a tee time", "popup_link": "/book/tee-time", "days": 14}}, {"title": "주말 오전은 골프나우 대신 직접 예약으로", "target_group": "골프나우 손님", "time_slot": "주말 오전", "area": "나이아가라 전역", "why": "주말 오전 손님의 약 40%가 골프나우로 들어온다.", "offer": "직접 예약 시 카트 또는 스낵바 혜택", "channels": ["체크인 안내", "/book/login", "영수증 문구"], "steps": ["체크인 때 가입 권유", "혜택 코드 만들기", "주말 오전 골프나우 비율 매주 확인"], "kpi": "주말 오전 골프나우 비율, 웹 예약 수", "budget": "low", "narration": "두 번째 전략은 주말 오전을 골프나우에서 직접 예약으로 옮기는 것입니다. 주말 오전 손님의 약 사십 퍼센트가 골프나우로 들어옵니다. 체크인할 때 웹사이트 가입을 권하고, 직접 예약하면 카트나 스낵 혜택을 줍니다. 목표는 주말 오전의 골프나우 비율을 낮추는 것입니다.", "launch": {"sms": "", "call": "", "segment": "all", "popup_title": "Book direct and save", "popup_body": "Book your weekend tee time here instead of a booking app and get a free snack bar coffee. Sign up once for faster booking.", "popup_link_label": "Sign up", "popup_link": "/book/login", "days": 30}}, {"title": "해밀턴 경계 니치 — 트와일라잇 + 와인 투어", "target_group": "일반", "time_slot": "주말 3시 이후", "area": "스토니크릭·빈브룩·마운트호프, 그림스비·웨스트링컨", "why": "35–45분 거리, 젊은 가족이 빠르게 느는 지역. 가까운 코스를 지나쳐 올 이유가 필요하다.", "offer": "주말 트와일라잇 요금 + 나이아가라 와인 하루 여행", "channels": ["지역 타깃 광고", "웹사이트 팝업"], "steps": ["전용 코드 만들기", "광고 반경 설정", "4주 운영 후 비교"], "kpi": "전용 코드 사용 수", "budget": "medium", "narration": "세 번째는 해밀턴 경계 니치입니다. 스토니크릭, 빈브룩, 마운트호프는 클럽에서 삼십오 분에서 사십오 분 거리이고, 젊은 가족이 빠르게 늘고 있습니다. 집 근처 코스보다 나은 이유가 있어야 하므로, 주말 트와일라잇 요금과 나이아가라 와인 투어를 묶은 하루 여행 상품을 제안합니다. 그림스비와 웨스트링컨은 가는 길목입니다.", "launch": {"sms": "Pelham Hills: make it a Niagara day. Weekend twilight golf after 3 PM plus wine country nearby. Use code PROMO-HAMTW at pelhamhills.com - ends Nov 8.", "call": "", "segment": "all", "popup_title": "Weekend twilight + wine country", "popup_body": "Play after 3 PM on weekends at our twilight rate, then enjoy Niagara wine country. Code PROMO-HAMTW.", "popup_link_label": "Book twilight", "popup_link": "/book/tee-time", "days": 14}}], "niche_markets": [{"area": "웰랜드·펠햄", "population": "약 56,000 · 18,000", "drive": "5–15분", "why": "가장 가까운 이웃", "hook": "평일 오후 요금, 동네 리그"}, {"area": "나이아가라 칼리지·브록대", "population": "학생 약 19,000(브록)", "drive": "5–25분", "why": "수업 뒤 오후 시간", "hook": "학생 트와일라잇"}, {"area": "나이아가라폴스", "population": "약 94,000", "drive": "25분", "why": "관광업 교대 근무자는 평일에 쉰다", "hook": "평일 오전·오후 요금"}, {"area": "해밀턴 동·남쪽 경계", "population": "해밀턴 약 570,000", "drive": "35–45분", "why": "젊은 가족 급증", "hook": "트와일라잇 + 와인 투어"}, {"area": "포트콜본·나이아가라온더레이크", "population": "약 20,000 · 19,000", "drive": "20–30분", "why": "은퇴자가 많다", "hook": "평일 회원권"}, {"area": "버펄로", "population": "광역 약 110만", "drive": "약 45분", "why": "환율 이점", "hook": "주말 패키지"}], "plan": [{"window": "30", "actions": ["평일 오후 마감 할인", "2027 얼리버드 회원권 열기", "체크인 때 고객 연결"]}, {"window": "60", "actions": ["연말 기프트카드", "회원 갱신 안내", "해밀턴 경계 기프트카드 광고"]}, {"window": "90", "actions": ["리그·단체 행사 예약", "개장일 사전 판매", "웹사이트 직접 예약 홍보"]}], "cautions": ["고객 연결 0% — 재방문 전략은 연결을 늘린 뒤에", "문자·이메일은 CASL 동의자에게만", "인구·운전 시간은 대략(2021 인구조사)", "Claude Code가 화면 숫자로 만든 예시 — 버튼으로 받은 결과가 아님"], "narration": {"intro": "지난 삼십 일 동안 천십육 라운드가 있었습니다. 주말 오전이 가장 붐빕니다. 일반 손님이 하루 십 점 칠, 골프나우가 팔 점 이 라운드입니다. 반대로 평일 열두 시 이후는 거의 비어 있습니다. 회원은 평일 오전에 몰리고, 고객 기록에 연결된 라운드는 아직 영 퍼센트입니다.", "niches": "지역별로 보면 가장 큰 시장은 세인트캐서린스 약 십삼만 칠천 명과 해밀턴 약 오십칠만 명입니다. 가장 가까운 시장은 웰랜드 약 오만 육천 명과 펠햄 약 만 팔천 명입니다. 나이아가라폴스의 관광 업계 교대 근무자는 평일에 쉬기 때문에 평일 오후 손님이 되기 좋습니다. 인구는 이천이십일년 인구조사 기준 대략의 숫자입니다.", "plan": "지금은 시즌 막바지입니다. 앞으로 삼십 일은 평일 오후 마감 할인과 이천이십칠년 얼리버드 회원권을 엽니다. 육십 일 안에는 연말 기프트카드를 팔고, 구십 일 안에는 리그와 단체 행사 예약과 개장일 사전 판매를 시작합니다. 그동안 체크인 때 고객 연결을 꼭 해 두어야 재방문율을 잴 수 있습니다.", "close": "기능은 배포까지 끝났습니다. 서버 경로는 로그인하지 않은 요청을 거절하는 것까지 확인했습니다. 실제 로그인해서 버튼을 눌러 보는 것은 아직 하지 않았습니다. 오늘 보신 전략은 화면 숫자로 만든 예시이고, 버튼을 누르면 Claude가 그 기간의 숫자로 새로 씁니다."}, "model": "example · Claude Code", "period": {"from": "2026-09-26", "to": "2026-10-25"}}'::jsonb, 'ko'),
  ('{"headline": "Weekend mornings are full and weekday afternoons are empty — fill the gaps with neighbours, students and the Hamilton boundary, and move weekend golfers to direct booking.", "facts": [{"fact": "1,016 rounds and 408 bookings in 30 days.", "evidence": "rounds, bookings"}, {"fact": "Weekend mornings are busiest: public 10.7 and GolfNow 8.2 rounds a day.", "evidence": "grid weekend am"}, {"fact": "Weekday after noon has only about 6 rounds a day across the three groups.", "evidence": "grid weekday pm + twilight"}, {"fact": "Members cluster on weekday mornings (7.8 a day).", "evidence": "grid member weekday am"}, {"fact": "Sales per golfer $54.20 (373 paid golfers).", "evidence": "sales_by_seg"}, {"fact": "0% of rounds are linked to a customer record — no repeat rate yet.", "evidence": "linked_rounds"}], "strategies": [{"title": "Fill weekday afternoons — neighbours and students", "target_group": "Public", "time_slot": "Weekday after noon", "area": "Welland, Pelham, Niagara College", "why": "Weekday 12–3 and 3 PM+ carry only about 6 rounds a day.", "offer": "Weekday after-noon rate (code PROMO-WKPM)", "channels": ["Texts (consented)", "Website pop-up", "College notice boards"], "steps": ["Create the promo code", "Hold back 10% of the list", "Start texts and pop-up", "Review after two weeks"], "kpi": "Weekday 12–3 and 3 PM+ rounds, code uses", "budget": "low", "narration": "Strategy one: fill weekday afternoons. Offer a weekday after-noon rate with its own promo code to Welland and Pelham neighbours and Niagara College students. Text only people who agreed to texts, and hold back ten percent of the list as a comparison group. Measure rounds in that slot and code uses.", "launch": {"sms": "Pelham Hills: weekday afternoons are wide open. Tee off after 12 PM Mon-Fri at our after-noon rate with code PROMO-WKPM. Book at pelhamhills.com - offer ends Nov 8.", "call": "Hi, this is Pelham Hills Golf Club. Weekday afternoons are quiet right now, so we have a special after-noon rate Monday to Friday. Would you like me to book you a tee time?", "segment": "non_members", "popup_title": "Weekday afternoon rate", "popup_body": "Tee off after 12 PM, Monday to Friday, at our after-noon rate. Use code PROMO-WKPM when you book.", "popup_link_label": "Book a tee time", "popup_link": "/book/tee-time", "days": 14}}, {"title": "Move weekend mornings from GolfNow to direct", "target_group": "GolfNow golfers", "time_slot": "Weekend AM", "area": "All of Niagara", "why": "About 40% of weekend morning golfers come through GolfNow.", "offer": "Cart or snack bar perk for booking direct", "channels": ["Check-in invite", "/book/login", "Receipt line"], "steps": ["Invite sign-up at check-in", "Create the perk code", "Check GolfNow share weekly"], "kpi": "GolfNow share of weekend AM, website bookings", "budget": "low", "narration": "Strategy two: move weekend mornings from GolfNow to direct booking. About forty percent of weekend morning golfers come through GolfNow. Invite them to sign up on the website at check-in, and give a cart or snack bar perk for booking direct. The goal is a lower GolfNow share on weekend mornings.", "launch": {"sms": "", "call": "", "segment": "all", "popup_title": "Book direct and save", "popup_body": "Book your weekend tee time here instead of a booking app and get a free snack bar coffee. Sign up once for faster booking.", "popup_link_label": "Sign up", "popup_link": "/book/login", "days": 30}}, {"title": "Hamilton boundary — twilight + wine country", "target_group": "Public", "time_slot": "Weekend 3 PM+", "area": "Stoney Creek, Binbrook, Mount Hope, Grimsby, West Lincoln", "why": "35–45 minutes away and growing fast; they need a reason to drive past closer courses.", "offer": "Weekend twilight rate + Niagara wine country day trip", "channels": ["Geo-targeted ads", "Website pop-up"], "steps": ["Create its own code", "Set the ad radius", "Run four weeks, then compare"], "kpi": "Own promo code uses", "budget": "medium", "narration": "Strategy three: the Hamilton boundary. Stoney Creek, Binbrook and Mount Hope are thirty-five to forty-five minutes away and growing fast with young families. They need a reason to drive past closer courses, so offer weekend twilight rates bundled with a Niagara wine country day trip. Grimsby and West Lincoln sit on the way.", "launch": {"sms": "Pelham Hills: make it a Niagara day. Weekend twilight golf after 3 PM plus wine country nearby. Use code PROMO-HAMTW at pelhamhills.com - ends Nov 8.", "call": "", "segment": "all", "popup_title": "Weekend twilight + wine country", "popup_body": "Play after 3 PM on weekends at our twilight rate, then enjoy Niagara wine country. Code PROMO-HAMTW.", "popup_link_label": "Book twilight", "popup_link": "/book/tee-time", "days": 14}}], "niche_markets": [{"area": "Welland · Pelham", "population": "about 56,000 · 18,000", "drive": "5–15 min", "why": "Closest neighbours", "hook": "Weekday afternoon rate, neighbourhood league"}, {"area": "Niagara College · Brock", "population": "about 19,000 students (Brock)", "drive": "5–25 min", "why": "Free afternoons", "hook": "Student twilight"}, {"area": "Niagara Falls", "population": "about 94,000", "drive": "25 min", "why": "Tourism shift workers have weekdays off", "hook": "Weekday rates"}, {"area": "Hamilton east and south edge", "population": "Hamilton about 570,000", "drive": "35–45 min", "why": "Fast-growing young families", "hook": "Twilight + wine day trip"}, {"area": "Port Colborne · Niagara-on-the-Lake", "population": "about 20,000 · 19,000", "drive": "20–30 min", "why": "Many retirees", "hook": "Weekday membership"}, {"area": "Buffalo", "population": "metro about 1.1 million", "drive": "about 45 min", "why": "Exchange rate", "hook": "Weekend package"}], "plan": [{"window": "30", "actions": ["Weekday afternoon close-out offer", "Open 2027 early-bird memberships", "Link golfers at check-in"]}, {"window": "60", "actions": ["Holiday gift cards", "Membership renewal notices", "Gift card ads at the Hamilton edge"]}, {"window": "90", "actions": ["League and outing bookings", "Opening day pre-sale", "Promote direct website booking"]}], "cautions": ["0% linked — repeat-visit ideas after linking improves", "Texts and email only to people who agreed (CASL)", "Population and drive times are approximate (2021 Census)", "An example written by Claude Code from the screen numbers, not a button result"], "narration": {"intro": "The last 30 days had 1,016 rounds. Weekend mornings are the busiest: public golfers at 10.7 rounds a day and GolfNow at 8.2. Weekday afternoons after noon are nearly empty. Members cluster on weekday mornings, and so far zero percent of rounds are linked to a customer record.", "niches": "By area, the biggest markets are St. Catharines at about 137,000 people and Hamilton at about 570,000. The closest are Welland at about 56,000 and Pelham at about 18,000. Tourism shift workers in Niagara Falls have weekdays off, which makes them good weekday afternoon golfers. Populations are approximate, from the 2021 Census.", "plan": "It''s the end of the season. In the next 30 days, run weekday afternoon close-out offers and open 2027 early-bird memberships. Within 60 days, sell holiday gift cards. Within 90 days, start league and outing bookings and an opening day pre-sale. Meanwhile, link golfers to customer records at check-in so the repeat rate can be measured.", "close": "The feature is deployed. The server route refuses requests without a sign-in, and that is confirmed. A real signed-in test of the button has not been done yet. The strategy you saw today is an example built from the numbers on screen. When you press the button, Claude writes a fresh one from that period''s numbers."}, "model": "example · Claude Code", "period": {"from": "2026-09-26", "to": "2026-10-25"}}'::jsonb, 'en')
  ) as v(doc, lang)
on conflict (doc_hash) do nothing;

-- ===== /view·/strategy 숫자(2222) 계정 =====================================
-- 대표님 보고용(2026-10-25): 숫자로 들어오는 열람 계정(reports-view@, 0103)도 AI 마케팅 명단에 넣는다.
-- 0104 를 아직 안 돌렸어도 /strategy 가 열리게. 그 계정이 없으면 건너뛴다.
do $$
begin
  if exists (select 1 from auth.users where lower(email) = 'reports-view@pelhamhills.ca')
     and to_regclass('public.pelham_ai_marketing_viewers') is not null then
    insert into public.pelham_ai_marketing_viewers (email) values ('reports-view@pelhamhills.ca') on conflict do nothing;
  end if;
end;
$$;

-- ===== 권한 ============================================================

revoke all on function public.pelham_ai_marketing_reports_keep() from public, anon, authenticated;
revoke all on function public.pelham_staff_ai_marketing_report_save(date, date, text, text, jsonb, text) from public, anon;
revoke all on function public.pelham_staff_ai_marketing_reports() from public, anon;
revoke all on function public.pelham_staff_ai_marketing_report(uuid) from public, anon;
revoke all on function public.pelham_staff_ai_marketing_report_share(uuid, boolean) from public, anon;
revoke all on function public.pelham_ai_marketing_shared_report(text) from public;
grant execute on function public.pelham_staff_ai_marketing_report_share(uuid, boolean) to authenticated;
grant execute on function public.pelham_ai_marketing_shared_report(text) to anon, authenticated;
grant execute on function public.pelham_staff_ai_marketing_report_save(date, date, text, text, jsonb, text) to authenticated;
grant execute on function public.pelham_staff_ai_marketing_reports() to authenticated;
grant execute on function public.pelham_staff_ai_marketing_report(uuid) to authenticated;

notify pgrst, 'reload schema';
