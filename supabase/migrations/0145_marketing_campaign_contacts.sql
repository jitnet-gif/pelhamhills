-- 고객 마케팅 Campaigns 상세 — "Contacted us" 숫자를 누르면 그 연락 한 건 한 건을 보여 준다(2026-10-30 클럽 요청).
--
-- 왜: 0133 은 Contacted us 1 / 337, Website 1 처럼 숫자만 준다. 누가 언제 무엇을 했는지 볼 길이 없었다.
--
-- 바뀌는 것: 새 함수 pelham_marketing_campaign_contacts(id) 하나. 기존 함수·표는 그대로다.
-- 무엇을 세는지는 pelham_marketing_campaign_replies(0133) 와 같아야 한다 — 그쪽 조건을 바꾸면 여기도 바꾼다.
--
-- 돌려주는 것: 최근 것부터 [{kind, at, phone, name, what, detail, status, ref}]
--   kind    web · call · text (0133 의 경로)
--   at      연락이 온 시각
--   what    Tee time · Simulator · Membership application · Callback request · Text message
--   detail  예약 날짜·시각 · 인원, 콜백 사유, 문자 본문
--   status  지금 상태(취소됐으면 cancelled). 문자는 null.
--   ref     확인 코드 · 콜백 표 번호. 없으면 null.
--
-- 전제: 0012, 0059, 0133. 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다.

do $$
begin
  if to_regprocedure('public.pelham_marketing_campaign_replies(bigint)') is null then
    raise exception '0145 needs 0133 first (pelham_marketing_campaign_replies is missing).';
  end if;
end;
$$;

create or replace function public.pelham_marketing_campaign_contacts(p_id bigint)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v jsonb;
begin
  perform public.pelham_require_marketing_viewer();
  if not exists (select 1 from public.pelham_marketing_campaigns c where c.id = p_id) then
    perform public.pelham_fail('404', 'No such campaign.');
  end if;

  with c as (
    select c.id, c.started_at as t0, c.started_at + interval '14 days' as t1
      from public.pelham_marketing_campaigns c
     where c.id = p_id and c.started_at is not null
  ),
  got as (
    select distinct on (s.phone) s.phone, s.name
      from public.pelham_marketing_sends s
      join c on c.id = s.campaign_id
     where s.status in ('sent', 'delivered')
     order by s.phone, s.id
  ),
  -- union 이라 같은 예약에 같은 번호가 두 줄이어도, 콜백의 두 번호가 같아도 한 줄이 된다.
  hits as (
    select case when b.source = 'web' then 'web' else 'call' end as kind,
           b.created_at as at,
           public.pelham_marketing_phone(e->>'phone') as phone,
           'Tee time' as what,
           to_char(b.booking_date, 'Dy Mon FMDD') || coalesce(', ' || b.tee_time, '')
             || ' · ' || jsonb_array_length(b.doc->'players') || ' players' as detail,
           coalesce(b.status, 'reserved') as status,
           b.confirmation_code as ref
      from c
      join public.pelham_tee_bookings b on b.created_at >= c.t0 and b.created_at < c.t1
     cross join lateral jsonb_array_elements(
             case when jsonb_typeof(b.doc->'players') = 'array' then b.doc->'players' else '[]'::jsonb end) e
     where b.source in ('web', 'voice', 'voice_hold')
    union
    select case when r.source = 'voice_ai' then 'call' else 'web' end,
           r.created_at,
           public.pelham_marketing_phone(r.phone),
           'Simulator',
           to_char(r.booking_date, 'Dy Mon FMDD') || ', '
             || to_char(timestamp '2000-01-01' + r.start_minutes * interval '1 minute', 'FMHH12:MI AM')
             || ' · ' || r.duration_hours || ' h · ' || r.player_count || ' players',
           r.status,
           r.confirmation_code
      from c join public.pelham_sim_reservations r on r.created_at >= c.t0 and r.created_at < c.t1
     where r.source in ('online', 'voice_ai')
    union
    select 'web',
           m.created_at,
           public.pelham_marketing_phone(m.phone),
           'Membership application',
           m.membership_type || ' · ' || m.plan,
           m.status,
           null
      from c join public.pelham_memberships m on m.created_at >= c.t0 and m.created_at < c.t1
     where m.source = 'online'
    union
    select 'call',
           r.created_at,
           public.pelham_marketing_phone(x.n),
           'Callback request',
           r.reason,
           r.status,
           r.ticket
      from c join public.pelham_callback_requests r on r.created_at >= c.t0 and r.created_at < c.t1
     cross join lateral (values (r.phone), (r.caller_number)) x(n)
    union
    select 'text',
           m.created_at,
           public.pelham_marketing_phone(m.phone),
           'Text message',
           m.body,
           null,
           null
      from c join public.pelham_sms_messages m on m.created_at >= c.t0 and m.created_at < c.t1
     where m.direction = 'in'
       and upper(split_part(btrim(m.body), ' ', 1))
           not in ('STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'OPTOUT', 'REVOKE',
                   'START', 'UNSTOP', 'OPTIN', '')
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'kind', h.kind, 'at', h.at, 'phone', h.phone, 'name', g.name,
           'what', h.what, 'detail', h.detail, 'status', h.status, 'ref', h.ref)
           order by h.at desc), '[]'::jsonb)
    into v
    from hits h
    join got g on g.phone = h.phone;

  return v;
end;
$$;

revoke all on function public.pelham_marketing_campaign_contacts(bigint) from public, anon, authenticated;
grant execute on function public.pelham_marketing_campaign_contacts(bigint) to authenticated;

notify pgrst, 'reload schema';
