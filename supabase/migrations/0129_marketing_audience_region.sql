-- 고객 마케팅 "2. Who gets it" — 지역(도시·전화 지역번호)과 라운드 수 범위로 고르기(2026-10-29 클럽 요청).
--
-- 왜: "검색된 번호 또는 라운드수 몇번 이상 또는 지역별 검색도 되도록". 이름·번호 검색과 최소 라운드 수는
-- 0047 에 있었다. 지역으로 고를 길이 없었다.
--
-- 바꾸는 것(0047 의 받는 사람 함수 두 개):
-- - pelham_marketing_candidates(p) — p 에 세 키가 더해진다. 비우면 예전과 같다.
--     max_rounds : 라운드 수 이만큼 이하. 0 이하·빈 값 = 제한 없음.
--     city       : 고객 주소의 도시(대소문자·앞뒤 공백 무시). 여러 개면 배열 ["Fonthill","Welland"].
--     area_code  : 전화 지역번호 세 자리(905·289·416 …). 여러 개면 배열.
--   돌려주는 줄에 city 가 더해진다(그래서 drop 후 다시 만든다).
-- - pelham_marketing_audience(p) — cities·area_codes(이름과 사람 수)를 같이 돌려준다. 그 숫자는 지금 그룹·
--   라운드·검색 조건 안에서 세고, 도시·지역번호 조건은 빼고 센다(고르기 전에 몇 명인지 보이게).
--
-- 캠페인을 만들 때(0047 campaign_create)도 같은 함수를 쓰므로 고른 지역이 그대로 받는 사람이 된다.
--
-- 전제: 0047. 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다.

do $$
begin
  if to_regprocedure('public.pelham_marketing_phone(text)') is null then
    raise exception '0129 needs 0047 first (pelham_marketing_phone is missing).';
  end if;
end;
$$;

-- 도시 표기를 하나로: "  FONTHILL " → "Fonthill".
create or replace function public.pelham_marketing_city(p_raw text)
returns text
language sql
immutable
set search_path = ''
as $$
  select nullif(initcap(lower(regexp_replace(btrim(coalesce(p_raw, '')), '\s+', ' ', 'g'))), '')
$$;

-- 문자열 하나 또는 배열 → text[]. 빈 값은 빼고, 아무것도 없으면 null(= 거르지 않음).
create or replace function public.pelham_marketing_list(p jsonb)
returns text[]
language sql
immutable
set search_path = ''
as $$
  select nullif(array_agg(lower(btrim(x))) filter (where btrim(x) <> ''), '{}')
    from (
      select jsonb_array_elements_text(p) as x where jsonb_typeof(p) = 'array'
      union all
      select p #>> '{}' where jsonb_typeof(p) = 'string'
    ) v
$$;

drop function if exists public.pelham_marketing_candidates(jsonb);

-- p: {channel: sms|call, segment: all|members|non_members|regulars|new, min_rounds, max_rounds, search,
--     city: text|text[], area_code: text|text[]}
create function public.pelham_marketing_candidates(p jsonb)
returns table (customer_ref text, name text, phone text, is_member boolean, rounds integer,
               sms_ok boolean, call_ok boolean, ok boolean, reason text, city text)
language sql
stable
security definer
set search_path = ''
as $$
  with args as (
    select case when p->>'channel' = 'call' then 'call' else 'sms' end as channel,
           coalesce(nullif(p->>'segment', ''), 'all') as segment,
           coalesce(nullif(p->>'min_rounds', '')::integer, 0) as min_rounds,
           coalesce(nullif(p->>'max_rounds', '')::integer, 0) as max_rounds,
           lower(btrim(coalesce(p->>'search', ''))) as search,
           public.pelham_marketing_list(p->'city') as cities,
           public.pelham_marketing_list(p->'area_code') as area_codes
  ),
  base as (
    select c.customer_ref,
           coalesce(nullif(btrim(c.display_name), ''), btrim(concat_ws(' ', c.first_name, c.last_name))) as name,
           public.pelham_marketing_phone(c.phone) as phone,
           c.is_member,
           c.rounds_booked_played as rounds,
           c.user_created_on,
           public.pelham_marketing_city(c.city) as city,
           pr.sms_ok,
           pr.call_ok
      from public.pelham_customers c
      left join public.pelham_marketing_prefs pr on pr.customer_ref = c.customer_ref
  )
  select b.customer_ref, b.name, b.phone, b.is_member, b.rounds, b.sms_ok, b.call_ok,
         r.reason is null as ok, r.reason, b.city
    from base b
   cross join args a
   cross join lateral (
     select case
       when b.phone is null then 'no_phone'
       when exists (select 1 from public.pelham_marketing_optouts o
                     where o.phone = b.phone and o.channel = a.channel) then 'opted_out'
       when a.channel = 'call' and b.call_ok is distinct from true then 'no_consent'
       when a.channel = 'sms' and (b.sms_ok = false
                                   or (b.sms_ok is null and not b.is_member and b.rounds <= 0)) then 'no_consent'
       else null
     end as reason
   ) r
   where case a.segment
           when 'members' then b.is_member
           when 'non_members' then not b.is_member
           when 'regulars' then b.rounds >= 5
           when 'new' then b.user_created_on >= (current_date - 365)
           else true
         end
     and b.rounds >= a.min_rounds
     and (a.max_rounds <= 0 or b.rounds <= a.max_rounds)
     and (a.cities is null or lower(b.city) = any(a.cities))
     and (a.area_codes is null or left(b.phone, 3) = any(a.area_codes))
     and (a.search = ''
          or lower(coalesce(b.name, '')) like '%' || a.search || '%'
          or coalesce(b.phone, '') like '%' || regexp_replace(a.search, '\D', '', 'g') || '%'
             and regexp_replace(a.search, '\D', '', 'g') <> '')
$$;

create or replace function public.pelham_marketing_audience(p jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_p jsonb := coalesce(p, '{}'::jsonb);
begin
  perform public.pelham_require_marketing_viewer();
  return (
    with c as (select * from public.pelham_marketing_candidates(v_p)),
    -- 고르기 칸의 숫자: 도시·지역번호 조건만 빼고 센다. 보낼 수 있는 사람만.
    wide as (select * from public.pelham_marketing_candidates(v_p - 'city' - 'area_code') w where w.ok)
    select jsonb_build_object(
      'total', count(*),
      'eligible', count(*) filter (where c.ok),
      'phones', count(distinct c.phone) filter (where c.ok),
      'no_phone', count(*) filter (where c.reason = 'no_phone'),
      'opted_out', count(*) filter (where c.reason = 'opted_out'),
      'no_consent', count(*) filter (where c.reason = 'no_consent'),
      'customers', coalesce(jsonb_agg(jsonb_build_object(
          'customer_ref', c.customer_ref, 'name', c.name, 'phone', c.phone, 'city', c.city,
          'is_member', c.is_member, 'rounds', c.rounds,
          'sms_ok', c.sms_ok, 'call_ok', c.call_ok, 'ok', c.ok, 'reason', c.reason
        ) order by c.ok desc, c.rounds desc, lower(c.name)), '[]'::jsonb),
      'cities', (select coalesce(jsonb_agg(jsonb_build_object('name', x.city, 'count', x.n)
                                           order by x.n desc, x.city), '[]'::jsonb)
                   from (select w.city, count(*) as n from wide w where w.city is not null group by w.city) x),
      'area_codes', (select coalesce(jsonb_agg(jsonb_build_object('code', x.code, 'count', x.n)
                                               order by x.n desc, x.code), '[]'::jsonb)
                       from (select left(w.phone, 3) as code, count(*) as n from wide w group by 1) x)
    )
    from c
  );
end;
$$;

revoke all on function public.pelham_marketing_city(text) from public, anon, authenticated;
revoke all on function public.pelham_marketing_list(jsonb) from public, anon, authenticated;
revoke all on function public.pelham_marketing_candidates(jsonb) from public, anon, authenticated;
revoke all on function public.pelham_marketing_audience(jsonb) from public, anon, authenticated;
grant execute on function public.pelham_marketing_audience(jsonb) to authenticated;

notify pgrst, 'reload schema';

-- ===== 확인 ============================================================
-- 도시별 고객 수(주소가 있는 사람). 위쪽 몇 개가 화면의 Region 목록 맨 위에 온다.

select public.pelham_marketing_city(city) as city, count(*)
  from public.pelham_customers
 group by 1
 order by 2 desc
 limit 15;
