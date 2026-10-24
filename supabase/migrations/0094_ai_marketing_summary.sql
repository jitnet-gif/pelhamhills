-- AI Manager Marketing Strategies(`/admin/ai-marketing`) — 1단계: 보기 명단 + 기간 집계.
--
-- 왜(2026-10-24): Business Intelligence 화면은 코드에 적어 둔 예시 숫자뿐이었다. 클럽이 그 자리를
-- 마케팅 전략 화면으로 바꾸자고 했다 — 주중·주말, 회원·퍼블릭 등 고객층, 그린피·카트·프로샵·스낵바
-- 매출을 실제 데이터로 보고, 다음 단계에서 예상 매출과 Claude 의 사실 정리·마케팅 믹스를 붙인다.
--
-- 보는 사람: 매니저(Reports 명단 `pelham_cash_viewers`, 0046)와 아래 명단(Emmeline admin@, proshop@,
-- analysis@). 명단 밖 계정에는 PT403. 명단은 SQL editor 에서 바꾼다:
--   insert into public.pelham_ai_marketing_viewers (email) values ('someone@pelhamhills.ca') on conflict do nothing;
--   delete from public.pelham_ai_marketing_viewers where email = 'someone@pelhamhills.ca';
--
-- 숫자를 어디서 읽나(새 표 없음):
--   라운드   pelham_tee_bookings 의 doc.players — 취소된 예약·선수, 음성 홀드는 뺀다. 노쇼는 따로 센다.
--   고객층   선수의 ratePlan(대소문자 무시, 먼저 맞는 것): golfnow → staff/employee → league → tour →
--            member → junior/senior → public. 예약 color 가 blue 인 퍼블릭은 golfnow(일간 시트 톤과 같다).
--   주말     토·일과 pelham_tee_holidays. 시간대: 오전(<12시) · 오후(12–15시) · 트와일라잇(15시~).
--   매출     결제된(paid) 계산서의 줄, 세전. 티 줄 하나는 그린피+카트+추가품목 합이라(pelham_pos_tee_price)
--            예약 doc 의 선수 값으로 나눈다: 그린피 = greenFee(없으면 예약 rate), 카트 = cart 면 cartFee,
--            나머지 = 추가품목. 줄 금액(할인 뒤)을 넘지 않게 앞에서부터 채운다.
--            상품 줄은 스낵바 계산대(station snack_bar)면 스낵바, 나머지는 프로샵.
--            상품 매출을 고객층에 붙일 때는 같은 계산서의 티 선수에게 똑같이 나눈다. 티 선수가 없는
--            계산서는 'no_golfer'.
--   계산서 할인(프로모 코드 등, bill.discount)은 줄 밖이라 따로 bill_discount 로 낸다.
--
-- 웹 유입 경로는 0067 이 있을 때만 센다(없으면 빈 목록 — 0067 을 나중에 실행하면 그때부터 채워진다).
--
-- 전제: 0004, 0005, 0046, 0078. 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다.

do $$
begin
  if to_regprocedure('public.pelham_is_cash_viewer()') is null then
    raise exception '0094 needs 0046 first (pelham_is_cash_viewer is missing).';
  end if;
  if to_regclass('public.pelham_promo_uses') is null then
    raise exception '0094 needs 0078 first (pelham_promo_uses is missing).';
  end if;
end;
$$;

-- ===== 명단 ============================================================

create table if not exists public.pelham_ai_marketing_viewers (
  email       text primary key check (email = lower(btrim(email)) and email <> ''),
  created_at  timestamptz not null default now()
);

insert into public.pelham_ai_marketing_viewers (email) values
  ('admin@pelhamhills.ca'),
  ('proshop@pelhamhills.ca'),
  ('analysis@pelhamhills.ca')
on conflict do nothing;

alter table public.pelham_ai_marketing_viewers enable row level security;
revoke all on public.pelham_ai_marketing_viewers from anon, authenticated;

create or replace function public.pelham_is_ai_marketing_viewer()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.pelham_is_staff()
     and (public.pelham_is_cash_viewer()
          or exists (select 1
                       from auth.users u
                       join public.pelham_ai_marketing_viewers v on v.email = lower(u.email)
                      where u.id = auth.uid()))
$$;

create or replace function public.pelham_require_ai_marketing_viewer()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.pelham_require_staff();
  if not public.pelham_is_ai_marketing_viewer() then
    perform public.pelham_fail('403', 'Only managers and the marketing accounts can open AI Manager.');
  end if;
end;
$$;

-- 메뉴를 보일지. 명단 밖이면 false(에러 아님).
create or replace function public.pelham_staff_ai_marketing_access()
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.pelham_require_staff();
  return public.pelham_is_ai_marketing_viewer();
end;
$$;

-- ===== 분류 ============================================================

create or replace function public.pelham_ai_segment(p_plan text, p_color text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when v like '%golfnow%' or v like '%golf now%' then 'golfnow'
    when v like '%staff%' or v like '%employee%' then 'staff'
    when v like '%league%' then 'league'
    when v like '%tour%' then 'tour'
    when v like '%member%' then 'member'
    when v like '%junior%' or v like '%senior%' then 'junior_senior'
    when coalesce(p_color, '') = 'blue' then 'golfnow'
    else 'public'
  end
  from (select lower(btrim(coalesce(p_plan, ''))) as v) s
$$;

-- '6:58 AM' → 6, '3:10 PM' → 15. 꼴이 다르면 null.
create or replace function public.pelham_ai_hour(p_slot text)
returns integer
language sql
immutable
set search_path = ''
as $$
  select case when p_slot ~* '^\s*\d{1,2}:\d{2}\s*(AM|PM)\s*$'
              then (substring(p_slot from '^\s*(\d{1,2})')::integer % 12)
                   + case when p_slot ~* 'PM' then 12 else 0 end
         end
$$;

create or replace function public.pelham_ai_daypart(p_slot text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when h is null then 'unknown'
    when h < 12 then 'am'
    when h < 15 then 'pm'
    else 'twilight'
  end
  from (select public.pelham_ai_hour(p_slot) as h) s
$$;

create or replace function public.pelham_ai_daytype(p_date date)
returns text
language sql
stable
set search_path = ''
as $$
  select case when extract(isodow from p_date) >= 6
                or exists (select 1 from public.pelham_tee_holidays h where h.holiday_date = p_date)
              then 'weekend' else 'weekday' end
$$;

-- ===== 집계 ============================================================

-- 금액은 모두 센트, 세전. 기간은 양 끝 포함, 최대 400일.
create or replace function public.pelham_staff_ai_marketing_summary(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_web jsonb := '[]'::jsonb;
begin
  perform public.pelham_require_ai_marketing_viewer();
  if p_from is null or p_to is null or p_from > p_to then
    perform public.pelham_fail('400', 'Pick a start date on or before the end date.');
  end if;
  if p_to - p_from > 400 then
    perform public.pelham_fail('400', 'Pick a period of 400 days or less.');
  end if;

  -- 웹 유입 경로(0067). 0067 을 실행하기 전이면 표가 없으므로 동적으로 부른다.
  if to_regclass('public.pelham_booking_attribution') is not null
     and to_regprocedure('public.pelham_visit_label(text, text, text, text)') is not null then
    execute $q$
      select coalesce(jsonb_agg(jsonb_build_object('label', label, 'bookings', n) order by n desc, label), '[]'::jsonb)
        from (select public.pelham_visit_label(a.referrer_host, a.utm_source, a.utm_medium, a.click_id) as label,
                     count(*) as n
                from public.pelham_booking_attribution a
                join public.pelham_tee_bookings b on b.id = a.booking_ref
               where a.kind = 'tee'
                 and b.booking_date between $1 and $2
                 and coalesce(b.status, '') not in ('cancelled', 'blocked')
               group by 1) s
    $q$ into v_web using p_from, p_to;
  end if;

  return (
    with pl as (
      select b.id as booking_id,
             b.booking_date as d,
             public.pelham_ai_daytype(b.booking_date) as daytype,
             public.pelham_ai_daypart(coalesce(b.tee_time, b.doc->>'time')) as daypart,
             public.pelham_ai_segment(p.value->>'ratePlan', b.doc->>'color') as seg,
             (coalesce(b.status, '') = 'no_show'
              or coalesce((p.value->>'no_show')::boolean, false)) as no_show,
             nullif(btrim(p.value->>'customerRef'), '') as cref
        from public.pelham_tee_bookings b
        cross join lateral jsonb_array_elements(
               case when jsonb_typeof(b.doc->'players') = 'array' then b.doc->'players' else '[]'::jsonb end) p
       where b.booking_date between p_from and p_to
         and coalesce(b.status, '') not in ('cancelled', 'blocked')
         and coalesce(b.source, '') <> 'voice_hold'
         and not coalesce((p.value->>'cancelled')::boolean, false)
    ), played as (
      select * from pl where not no_show
    ), bills as (
      select * from public.pelham_bills
       where business_date between p_from and p_to and status = 'paid'
    ), lines as (
      select li.*, b.station, b.business_date
        from public.pelham_bill_lines li
        join bills b on b.id = li.bill_id
       where li.active
    ), tee as (
      select l.bill_id, l.business_date,
             greatest(l.line_total, 0) as amt,
             public.pelham_ai_segment(pp.value->>'ratePlan', bk.doc->>'color') as seg,
             greatest(round(coalesce(case when jsonb_typeof(pp.value->'greenFee') = 'number'
                                          then (pp.value->>'greenFee')::numeric end,
                                     (bk.doc->>'rate')::numeric, 0) * 100), 0)::integer as green_c,
             case when coalesce((pp.value->>'cart')::boolean, false)
                  then greatest(round(coalesce((pp.value->>'cartFee')::numeric, 0) * 100), 0)::integer
                  else 0 end as cart_c
        from lines l
        left join public.pelham_tee_bookings bk on bk.id = l.booking_id
        left join lateral (
          select e.value
            from jsonb_array_elements(
                   case when jsonb_typeof(bk.doc->'players') = 'array' then bk.doc->'players' else '[]'::jsonb end) e
           where e.value->>'id' = l.player_id
           limit 1
        ) pp on true
       where l.kind = 'tee_player'
    ), tee_split as (
      select bill_id, business_date, seg, amt,
             least(amt, green_c) as green,
             least(amt - least(amt, green_c), cart_c) as cart
        from tee
    ), tee_parts as (
      select bill_id, business_date, seg, green, cart, amt - green - cart as extras from tee_split
    ), shop as (
      select bill_id, business_date,
             sum(case when station = 'snack_bar' then 0 else line_total end) as shop,
             sum(case when station = 'snack_bar' then line_total else 0 end) as snack
        from lines
       where kind = 'product'
       group by bill_id, business_date
    ), bill_players as (
      select bill_id, count(*) as n from tee_parts group by bill_id
    ), shop_by_seg as (
      -- 상품 매출을 같은 계산서의 티 선수에게 똑같이 나눈다. 선수가 없으면 no_golfer.
      select coalesce(t.seg, 'no_golfer') as seg, s.business_date,
             s.shop::numeric / coalesce(bp.n, 1) as shop,
             s.snack::numeric / coalesce(bp.n, 1) as snack
        from shop s
        left join bill_players bp on bp.bill_id = s.bill_id
        left join tee_parts t on t.bill_id = s.bill_id
    ), seg_sales as (
      select seg, sum(players) as players, sum(green) as green, sum(cart) as cart, sum(extras) as extras,
             round(sum(shop))::bigint as shop, round(sum(snack))::bigint as snack
        from (
          select seg, 1 as players, green, cart, extras, 0::numeric as shop, 0::numeric as snack from tee_parts
          union all
          select seg, 0, 0, 0, 0, shop, snack from shop_by_seg
        ) u
       group by seg
    ), day_sales as (
      select public.pelham_ai_daytype(business_date) as daytype,
             sum(green) as green, sum(cart) as cart, sum(extras) as extras,
             round(sum(shop))::bigint as shop, round(sum(snack))::bigint as snack
        from (
          select business_date, green, cart, extras, 0::numeric as shop, 0::numeric as snack from tee_parts
          union all
          select business_date, 0, 0, 0, shop, snack from shop_by_seg
        ) u
       group by 1
    ), linked as (
      select cref, count(distinct d) as visits from played where cref is not null group by cref
    )
    select jsonb_build_object(
      'from', to_char(p_from, 'YYYY-MM-DD'),
      'to', to_char(p_to, 'YYYY-MM-DD'),
      'days', (select jsonb_build_object(
                 'weekday', count(*) filter (where public.pelham_ai_daytype(g::date) = 'weekday'),
                 'weekend', count(*) filter (where public.pelham_ai_daytype(g::date) = 'weekend'))
                 from generate_series(p_from, p_to, interval '1 day') g),
      'rounds', (select count(*) from played),
      'no_shows', (select count(*) from pl where no_show),
      'bookings', (select count(distinct booking_id) from played),
      'linked_rounds', (select count(*) from played where cref is not null),
      'linked_golfers', (select count(*) from linked),
      'repeat_golfers', (select count(*) from linked where visits >= 2),
      'grid', coalesce((
        select jsonb_agg(jsonb_build_object('seg', seg, 'daytype', daytype, 'daypart', daypart, 'rounds', n)
                         order by seg, daytype, daypart)
          from (select seg, daytype, daypart, count(*) as n from played group by 1, 2, 3) s
      ), '[]'::jsonb),
      'by_date', coalesce((
        select jsonb_agg(jsonb_build_object('date', to_char(d, 'YYYY-MM-DD'), 'rounds', n, 'no_shows', ns) order by d)
          from (select d, count(*) filter (where not no_show) as n, count(*) filter (where no_show) as ns
                  from pl group by d) s
      ), '[]'::jsonb),
      'sales_by_seg', coalesce((
        select jsonb_agg(jsonb_build_object('seg', seg, 'players', players, 'green', green, 'cart', cart,
                                            'extras', extras, 'shop', shop, 'snack', snack) order by seg)
          from seg_sales
      ), '[]'::jsonb),
      'sales_by_daytype', coalesce((
        select jsonb_agg(jsonb_build_object('daytype', daytype, 'green', green, 'cart', cart,
                                            'extras', extras, 'shop', shop, 'snack', snack) order by daytype)
          from day_sales
      ), '[]'::jsonb),
      'paid_bills', (select count(*) from bills),
      'net_sales', (select coalesce(sum(subtotal - discount), 0) from bills),
      'bill_discount', (select coalesce(sum(discount), 0) from bills),
      'promo', coalesce((
        select jsonb_agg(jsonb_build_object('code', code, 'name', name, 'uses', n, 'amount', amt) order by n desc, code)
          from (select pr.code, pr.name, count(*) as n, sum(u.amount) as amt
                  from public.pelham_promo_uses u
                  join bills b on b.id = u.bill_id
                  join public.pelham_promotions pr on pr.id = u.promo_id
                 group by pr.code, pr.name) s
      ), '[]'::jsonb),
      'web_sources', v_web,
      'members', coalesce((
        select jsonb_agg(jsonb_build_object('type', membership_type, 'count', n) order by n desc, membership_type)
          from (select membership_type, count(*) as n from public.pelham_memberships
                 where status = 'active' and season = extract(year from p_to)::integer
                 group by membership_type) s
      ), '[]'::jsonb),
      'reach', jsonb_build_object(
        'customers', (select count(*) from public.pelham_customers),
        'with_email', (select count(*) from public.pelham_customers where nullif(btrim(email), '') is not null),
        'with_phone', (select count(*) from public.pelham_customers where nullif(btrim(phone), '') is not null),
        'sms_ok', (select count(*) from public.pelham_marketing_prefs where sms_ok),
        'call_ok', (select count(*) from public.pelham_marketing_prefs where call_ok),
        'opted_out', (select count(*) from public.pelham_marketing_optouts)
      )
    )
  );
end;
$$;

-- ===== 권한 ============================================================

revoke all on function public.pelham_is_ai_marketing_viewer() from public, anon, authenticated;
revoke all on function public.pelham_require_ai_marketing_viewer() from public, anon, authenticated;
revoke all on function public.pelham_ai_segment(text, text) from public, anon, authenticated;
revoke all on function public.pelham_ai_hour(text) from public, anon, authenticated;
revoke all on function public.pelham_ai_daypart(text) from public, anon, authenticated;
revoke all on function public.pelham_ai_daytype(date) from public, anon, authenticated;
revoke all on function public.pelham_staff_ai_marketing_access() from public, anon, authenticated;
revoke all on function public.pelham_staff_ai_marketing_summary(date, date) from public, anon, authenticated;

grant execute on function public.pelham_staff_ai_marketing_access() to authenticated;
grant execute on function public.pelham_staff_ai_marketing_summary(date, date) to authenticated;

notify pgrst, 'reload schema';

-- ===== 확인 ============================================================

select public.pelham_ai_segment('Twilight Member - Single', null) as twilight_member,  -- member
       public.pelham_ai_segment('Public', 'blue') as golfnow_public,                    -- golfnow
       public.pelham_ai_daypart('3:10 PM') as daypart,                                  -- twilight
       (select count(*) from public.pelham_ai_marketing_viewers) as viewers;            -- 3 이상
