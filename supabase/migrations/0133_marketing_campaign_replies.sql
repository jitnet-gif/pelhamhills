-- 고객 마케팅 Campaigns 상세 — 받은 사람이 그 뒤 연락해 온 비율(2026-10-29 클럽 요청).
--
-- 왜: "그들이 웹사이트나 전화 문자로 연락이 오는 성공률도 반영해줘". 캠페인 상세에는 도착·실패·수신거부만
-- 있었다. 문자를 받고 실제로 움직였는지 볼 길이 없었다.
--
-- 세는 법: 이 캠페인을 받은(sent·delivered) 번호마다, 캠페인이 시작된 때부터 14일 안에
--   web   웹사이트 — 온라인 티 예약(source web, 선수 전화번호), 온라인 실내 골프 예약, 온라인 회원 신청서
--   call  전화 — 전화 비서가 잡은 티·실내 골프 예약(voice·voice_ai), 콜백 요청(말한 번호·발신 번호)
--   text  문자 — 그 번호에서 온 답장. STOP·START 같은 수신거부·재동의 말은 빼고 센다.
-- 가 하나라도 있으면 "연락 옴". 한 사람이 둘 다 했으면 양쪽에 다 센다(합계는 사람 수).
-- 번호는 pelham_marketing_phone(0047) 으로 10자리로 맞춰 비교한다.
--
-- 바꾸는 것: pelham_marketing_campaign_json(0118) — 상세(sends 포함)일 때만
--   replies : {days, until, reached, responded, web, call, text}
--   sends[].replied : ["web","call","text"] 중 해당하는 것(없으면 빈 배열)
--   sends[].customer : 받은 사람이 어떤 사람인지 — {is_member, rounds, city, new}. 지금 고객 명부 기준
--                      (new = 최근 12개월 안에 만든 계정). 명부에 없는 번호(손으로 친 번호)면 null.
-- 목록(Campaigns 왼쪽)은 예전 그대로 — 캠페인마다 예약 표를 훑지 않게.
--
-- 전제: 0047, 0059, 0116, 0118. 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다.

do $$
begin
  if to_regprocedure('public.pelham_marketing_weather_candidates(date)') is null then
    raise exception '0133 needs 0118 first (pelham_marketing_weather_candidates is missing).';
  end if;
  if to_regclass('public.pelham_callback_requests') is null then
    raise exception '0133 needs 0059 first (pelham_callback_requests is missing).';
  end if;
end;
$$;

-- 캠페인 하나의 받은 번호별 연락 경로. 아직 시작 안 한 캠페인이면 빈 결과.
create or replace function public.pelham_marketing_campaign_replies(p_id bigint)
returns table (phone text, web boolean, call boolean, text boolean)
language sql
stable
security definer
set search_path = ''
as $$
  with c as (
    select c.id, c.started_at as t0, c.started_at + interval '14 days' as t1
      from public.pelham_marketing_campaigns c
     where c.id = p_id and c.started_at is not null
  ),
  got as (
    select distinct s.phone
      from public.pelham_marketing_sends s
      join c on c.id = s.campaign_id
     where s.status in ('sent', 'delivered')
  ),
  tee as (
    select b.source, public.pelham_marketing_phone(e->>'phone') as phone
      from c
      join public.pelham_tee_bookings b on b.created_at >= c.t0 and b.created_at < c.t1
     cross join lateral jsonb_array_elements(
             case when jsonb_typeof(b.doc->'players') = 'array' then b.doc->'players' else '[]'::jsonb end) e
     where b.source in ('web', 'voice', 'voice_hold')
  ),
  hits as (
    select 'web' as kind, t.phone from tee t where t.source = 'web'
    union all
    select 'call', t.phone from tee t where t.source in ('voice', 'voice_hold')
    union all
    select case when r.source = 'voice_ai' then 'call' else 'web' end, public.pelham_marketing_phone(r.phone)
      from c join public.pelham_sim_reservations r on r.created_at >= c.t0 and r.created_at < c.t1
     where r.source in ('online', 'voice_ai')
    union all
    select 'web', public.pelham_marketing_phone(m.phone)
      from c join public.pelham_memberships m on m.created_at >= c.t0 and m.created_at < c.t1
     where m.source = 'online'
    union all
    select 'call', public.pelham_marketing_phone(x.n)
      from c join public.pelham_callback_requests r on r.created_at >= c.t0 and r.created_at < c.t1
     cross join lateral (values (r.phone), (r.caller_number)) x(n)
    union all
    select 'text', public.pelham_marketing_phone(m.phone)
      from c join public.pelham_sms_messages m on m.created_at >= c.t0 and m.created_at < c.t1
     where m.direction = 'in'
       and upper(split_part(btrim(m.body), ' ', 1))
           not in ('STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'OPTOUT', 'REVOKE',
                   'START', 'UNSTOP', 'OPTIN', '')
  )
  select g.phone,
         bool_or(h.kind = 'web') is true,
         bool_or(h.kind = 'call') is true,
         bool_or(h.kind = 'text') is true
    from got g
    left join hits h on h.phone = g.phone
   group by g.phone
$$;

create or replace function public.pelham_marketing_campaign_json(p_id bigint, p_with_sends boolean)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select to_jsonb(c)
         || jsonb_build_object('counts', (
              select coalesce(jsonb_object_agg(s.status, s.n), '{}'::jsonb)
                from (select x.status, count(*) as n from public.pelham_marketing_sends x
                       where x.campaign_id = c.id group by x.status) s))
         || jsonb_build_object('opted_out_after', (
              select count(distinct x.phone)
                from public.pelham_marketing_sends x
                join public.pelham_marketing_optouts o on o.phone = x.phone and o.channel = c.channel
               where x.campaign_id = c.id and x.status in ('sent', 'delivered')
                 and o.created_at >= coalesce(c.started_at, c.created_at)))
         || case when p_with_sends then jsonb_build_object(
              'replies', (
                select jsonb_build_object(
                         'days', 14,
                         'until', c.started_at + interval '14 days',
                         'reached', count(*),
                         'responded', count(*) filter (where r.web or r.call or r.text),
                         'web', count(*) filter (where r.web),
                         'call', count(*) filter (where r.call),
                         'text', count(*) filter (where r.text))
                  from public.pelham_marketing_campaign_replies(c.id) r),
              'sends', (
              select coalesce(jsonb_agg(jsonb_build_object(
                       'id', s.id, 'customer_ref', s.customer_ref, 'name', s.name, 'phone', s.phone,
                       'status', s.status, 'provider_ref', s.provider_ref, 'error', s.error,
                       'updated_at', s.updated_at, 'tee_time', s.tee_time,
                       'optout', case when o.phone is null then null else jsonb_build_object(
                         'created_at', o.created_at, 'source', o.source,
                         'after_send', s.status in ('sent', 'delivered')
                                       and o.created_at >= coalesce(c.started_at, c.created_at)) end,
                       'replied', to_jsonb(array_remove(array[
                         case when r.web then 'web' end,
                         case when r.call then 'call' end,
                         case when r.text then 'text' end], null)),
                       'customer', case when cu.customer_ref is null then null else jsonb_build_object(
                         'is_member', cu.is_member, 'rounds', cu.rounds_booked_played,
                         'city', nullif(initcap(lower(btrim(coalesce(cu.city, '')))), ''),
                         'new', cu.user_created_on >= (current_date - 365)) end)
                     order by s.id), '[]'::jsonb)
                from public.pelham_marketing_sends s
                left join public.pelham_marketing_optouts o on o.phone = s.phone and o.channel = c.channel
                left join public.pelham_marketing_campaign_replies(c.id) r
                       on r.phone = s.phone and s.status in ('sent', 'delivered')
                left join public.pelham_customers cu on cu.customer_ref = s.customer_ref
               where s.campaign_id = c.id))
            else '{}'::jsonb end
    from public.pelham_marketing_campaigns c
   where c.id = p_id
$$;

revoke all on function public.pelham_marketing_campaign_replies(bigint) from public, anon, authenticated;
revoke all on function public.pelham_marketing_campaign_json(bigint, boolean) from public, anon, authenticated;

notify pgrst, 'reload schema';

-- ===== 확인 ============================================================
-- 최근 캠페인 다섯 개의 연락 온 수.

select c.id, c.name, public.pelham_marketing_campaign_json(c.id, true)->'replies' as replies
  from public.pelham_marketing_campaigns c
 order by c.created_at desc
 limit 5;
