-- 웹 예약이 어디서 왔는지(유입 경로)를 남긴다 — Google 검색, Google 광고, Facebook, 이메일·문자 링크, 직접 입력 등.
--
-- 왜(2026-10-21): Reports 의 Bookings 탭을 실시간 예약 현황으로 바꾸면서, 웹으로 들어온 예약이 검색 결과 링크를
-- 타고 왔는지 광고로 왔는지 알고 싶다는 요청. 예약 장부(`pelham_tee_bookings`·`pelham_sim_reservations`)와
-- 예약 함수는 그대로 두고, 예약이 끝난 직후 브라우저가 따로 이 표에 한 줄을 붙인다.
--
-- 브라우저가 적는 것(`frontend/lib/booking/attribution.ts`):
--   - 이번 방문의 입구: 리퍼러의 호스트(밖의 사이트일 때만), 처음 연 페이지, utm_source·medium·campaign·term,
--     광고 클릭 표시(gclid·gbraid·wbraid → google, msclkid → microsoft, fbclid → facebook).
--   - 처음 온 날의 입구(30일 동안 기억): `first_touch` jsonb 에 같은 칸.
-- 이름표(`label`)는 여기 `pelham_visit_label` 한 곳에서 정한다 — 리포트가 따로 판정하지 않는다.
--
-- 한계: Google 검색 결과와 Google 지도·비즈니스 프로필에서 누른 링크는 리퍼러가 둘 다 google.com 이라 구분되지
-- 않는다. 비즈니스 프로필의 웹사이트 링크에 `?utm_source=google&utm_medium=maps` 를 붙이면 "Google Maps" 로 나뉜다.
--
-- 붙이는 함수(anon)는 확인 코드가 맞고, 웹에서 만든 예약이고, 만든 지 30분 안일 때만 받는다. 한 예약에 한 줄.
-- 전제: 0007, 0012. 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다.

do $$
begin
  if to_regclass('public.pelham_sim_reservations') is null then
    raise exception '0067 needs 0007 (indoor bays) first.';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'pelham_tee_bookings'
                    and column_name = 'confirmation_code') then
    raise exception '0067 needs 0012 (confirmation codes) first.';
  end if;
end;
$$;

create table if not exists public.pelham_booking_attribution (
  id             bigint generated always as identity primary key,
  kind           text not null check (kind in ('tee', 'bay')),
  booking_ref    text not null,                 -- 티: pelham_tee_bookings.id, 베이: pelham_sim_reservations.id
  referrer_host  text,                          -- 예: www.google.com. 비면 직접 입력·북마크·앱
  landing        text,                          -- 처음 연 경로, 예: /golf
  utm_source     text,
  utm_medium     text,
  utm_campaign   text,
  utm_term       text,
  click_id       text check (click_id is null or click_id in ('google', 'microsoft', 'facebook')),
  first_touch    jsonb,
  user_agent     text,
  created_at     timestamptz not null default now(),
  unique (kind, booking_ref)
);

alter table public.pelham_booking_attribution enable row level security;
revoke all on public.pelham_booking_attribution from public, anon, authenticated;

-- 유입 경로 이름표. 위에서 먼저 맞는 것이 이긴다.
create or replace function public.pelham_visit_label(p_host text, p_source text, p_medium text, p_click text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_click = 'google' then 'Google Ads'
    when p_click = 'microsoft' then 'Microsoft Ads'
    when lower(coalesce(p_medium, '')) in ('cpc', 'ppc', 'paid', 'paid_search', 'paid_social', 'display', 'ad', 'ads')
      then 'Paid · ' || coalesce(nullif(p_source, ''), 'unknown')
    when lower(coalesce(p_source, '')) = 'google' and lower(coalesce(p_medium, '')) in ('maps', 'gbp', 'local', 'business')
      then 'Google Maps'
    when lower(coalesce(p_medium, '')) in ('email', 'e-mail', 'newsletter') then 'Email'
    when lower(coalesce(p_medium, '')) in ('sms', 'text') then 'Text message'
    when nullif(p_source, '') is not null
      then initcap(p_source) || coalesce(' · ' || nullif(p_medium, ''), '')
    when p_click = 'facebook' then 'Facebook / Instagram'
    when nullif(p_host, '') is null then 'Direct'
    when p_host ~* '(^|\.)google\.[a-z.]+$' then 'Google search'
    when p_host ~* '(^|\.)bing\.com$' then 'Bing search'
    when p_host ~* '(^|\.)(duckduckgo\.com|search\.yahoo\.com|yahoo\.com|ecosia\.org|search\.brave\.com)$' then 'Other search'
    when p_host ~* '(^|\.)(facebook\.com|fb\.com|instagram\.com|messenger\.com)$' then 'Facebook / Instagram'
    when p_host ~* '(^|\.)(t\.co|twitter\.com|x\.com|tiktok\.com|reddit\.com|youtube\.com|linkedin\.com)$' then 'Social'
    when p_host ~* '(^|\.)(mail\.google\.com|outlook\.live\.com|outlook\.office\.com|mail\.yahoo\.com)$' then 'Email'
    when p_host ~* '(^|\.)(golfnow\.com|chronogolf\.com|tripadvisor\.[a-z.]+|yelp\.[a-z.]+)$' then 'Golf / review site · ' || p_host
    else 'Other site · ' || p_host
  end
$$;

-- 예약 직후 브라우저가 부른다(anon). 맞지 않으면 조용히 false — 손님 화면에 오류를 띄울 일이 아니다.
-- p: {referrer_host, landing, utm_source, utm_medium, utm_campaign, utm_term, click_id, first_touch, user_agent}
create or replace function public.pelham_booking_attribution_save(p_kind text, p_code text, p jsonb)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_ref text;
  v_code text := upper(btrim(coalesce(p_code, '')));
  v_host text := lower(left(nullif(btrim(coalesce(p->>'referrer_host', '')), ''), 120));
  v_click text := nullif(p->>'click_id', '');
  v_first jsonb := case when jsonb_typeof(p->'first_touch') = 'object' then p->'first_touch' end;
begin
  if v_code = '' then
    return false;
  end if;
  if p_kind = 'tee' then
    select t.id into v_ref from public.pelham_tee_bookings t
     where t.confirmation_code = v_code and t.source = 'web' and t.created_at > now() - interval '30 minutes';
  elsif p_kind = 'bay' then
    select r.id::text into v_ref from public.pelham_sim_reservations r
     where r.confirmation_code = v_code and r.source = 'online' and r.created_at > now() - interval '30 minutes';
  end if;
  if v_ref is null then
    return false;
  end if;
  if v_host is not null and v_host !~ '^[a-z0-9.-]+$' then
    v_host := null;
  end if;
  if v_click not in ('google', 'microsoft', 'facebook') then
    v_click := null;
  end if;
  -- 처음 온 날의 입구는 이름표까지 만들어 둔다. 칸은 아는 것만, 길이는 잘라서.
  if v_first is not null then
    v_first := jsonb_build_object(
      'referrer_host', lower(left(nullif(v_first->>'referrer_host', ''), 120)),
      'landing', left(nullif(v_first->>'landing', ''), 200),
      'utm_source', left(nullif(v_first->>'utm_source', ''), 80),
      'utm_medium', left(nullif(v_first->>'utm_medium', ''), 80),
      'utm_campaign', left(nullif(v_first->>'utm_campaign', ''), 120),
      'click_id', case when v_first->>'click_id' in ('google', 'microsoft', 'facebook') then v_first->>'click_id' end,
      'at', left(nullif(v_first->>'at', ''), 40));
    v_first := v_first || jsonb_build_object('label', public.pelham_visit_label(
      v_first->>'referrer_host', v_first->>'utm_source', v_first->>'utm_medium', v_first->>'click_id'));
  end if;

  insert into public.pelham_booking_attribution
    (kind, booking_ref, referrer_host, landing, utm_source, utm_medium, utm_campaign, utm_term, click_id,
     first_touch, user_agent)
  values (p_kind, v_ref, v_host,
          left(nullif(btrim(coalesce(p->>'landing', '')), ''), 200),
          left(nullif(btrim(coalesce(p->>'utm_source', '')), ''), 80),
          left(nullif(btrim(coalesce(p->>'utm_medium', '')), ''), 80),
          left(nullif(btrim(coalesce(p->>'utm_campaign', '')), ''), 120),
          left(nullif(btrim(coalesce(p->>'utm_term', '')), ''), 120),
          v_click, v_first,
          left(nullif(btrim(coalesce(p->>'user_agent', '')), ''), 300))
  on conflict (kind, booking_ref) do nothing;
  return true;
end;
$$;

-- 플레이 날짜 기간 안의 웹 예약 유입 경로(직원). 리포트가 예약 목록과 `kind`+`bookingRef` 로 맞춘다.
create or replace function public.pelham_staff_booking_attribution(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.pelham_require_staff();
  if p_from is null or p_to is null or p_to < p_from then
    perform public.pelham_fail('422', 'Give a date range.');
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'kind', a.kind,
             'bookingRef', a.booking_ref,
             'label', public.pelham_visit_label(a.referrer_host, a.utm_source, a.utm_medium, a.click_id),
             'referrerHost', a.referrer_host,
             'landing', a.landing,
             'utmSource', a.utm_source,
             'utmMedium', a.utm_medium,
             'utmCampaign', a.utm_campaign,
             'utmTerm', a.utm_term,
             'device', case when a.user_agent ~* '(iphone|android.*mobile|mobile safari)' then 'phone'
                            when a.user_agent ~* '(ipad|tablet|android)' then 'tablet'
                            when a.user_agent is not null then 'computer' end,
             'firstLabel', a.first_touch->>'label',
             'firstAt', a.first_touch->>'at',
             'recordedAt', public.pelham_iso(a.created_at)
           ) order by a.id)
      from public.pelham_booking_attribution a
     where (a.kind = 'tee' and exists (select 1 from public.pelham_tee_bookings t
                                        where t.id = a.booking_ref and t.booking_date between p_from and p_to))
        or (a.kind = 'bay' and exists (select 1 from public.pelham_sim_reservations r
                                        where r.id::text = a.booking_ref and r.booking_date between p_from and p_to))
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.pelham_visit_label(text, text, text, text) from public, anon, authenticated;
revoke all on function public.pelham_booking_attribution_save(text, text, jsonb) from public, anon, authenticated;
revoke all on function public.pelham_staff_booking_attribution(date, date) from public, anon, authenticated;
grant execute on function public.pelham_booking_attribution_save(text, text, jsonb) to anon, authenticated;
grant execute on function public.pelham_staff_booking_attribution(date, date) to authenticated;

notify pgrst, 'reload schema';
