-- AI Manager Marketing Strategies — Claude 가 전략을 쓸 때 **문자(Twilio)·전화(ElevenLabs)** 숫자도 본다.
--
-- 왜(2026-10-25): 사용자 요청 "일레븐랩스와 트윌리오의 데이터를 가지고도 마케팅 전략을". 지금까지 Claude 는
-- 티 시트·계산서 요약(0094)만 받았다.
--
-- `pelham_staff_ai_marketing_channels(p_from, p_to)` 이 기간의 집계 하나를 돌려준다. Fly 가 0094 요약과 함께
-- Claude 에 보낸다. ElevenLabs 통화 목록(통화 수·길이·결과·주제)은 이 SQL 이 아니라 Fly 가 ElevenLabs API 에서
-- 직접 받아 붙인다.
--
--   sms           보낸·받은 문자 수, 템플릿별 보낸 수, 실패 수, STOP 답장 수, 답장한 번호 수 (0058)
--   campaigns     기간에 시작한 문자·AI 전화 캠페인마다 이름·문구·보낸/도착/실패/건너뜀 수 (0047)
--   optouts       기간에 새로 수신거부한 수(문자·전화) (0047)
--   callbacks     전화 비서가 남긴 콜백 요청 수와 이유(번호·이메일은 지운다) (0059)
--   phone_reports 전화로 들어온 문제·불만 종류별 수 (0099)
--   bookings      예약 경로별 수: 전화 비서(voice) · 웹 · 직원, 주중·주말 (0002)
--
-- 이름·전화번호·이메일은 내보내지 않는다(이유 글의 숫자 7자리 이상과 이메일 모양은 지운다).
-- 표가 아직 없는 곳(예: 0099 를 실행하지 않은 DB)은 그 칸을 빈 값으로 둔다.
--
-- 전제: 0094. 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다.

do $$
begin
  if to_regprocedure('public.pelham_require_ai_marketing_viewer()') is null then
    raise exception '0114 needs 0094 first (pelham_require_ai_marketing_viewer is missing).';
  end if;
end;
$$;

-- 글에서 전화번호(숫자 7자리 이상, 사이 기호 포함)와 이메일을 지운다.
create or replace function public.pelham_ai_scrub(p text)
returns text
language sql
immutable
set search_path = ''
as $$
  select left(btrim(regexp_replace(regexp_replace(coalesce(p, ''),
           '[^\s@]+@[^\s@]+\.[^\s@]+', '[email]', 'g'),
           '\+?\d[\d\s().-]{5,}\d', '[number]', 'g')), 160)
$$;

create or replace function public.pelham_staff_ai_marketing_channels(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_start timestamptz;
  v_end timestamptz;
  v_out jsonb := '{}'::jsonb;
  v jsonb;
begin
  perform public.pelham_require_ai_marketing_viewer();
  if p_from is null or p_to is null or p_from > p_to then
    perform public.pelham_fail('400', 'Pick a start date on or before the end date.');
  end if;
  -- 클럽 현지 날짜의 처음과 끝.
  v_start := (p_from::timestamp) at time zone 'America/Toronto';
  v_end := ((p_to + 1)::timestamp) at time zone 'America/Toronto';

  if to_regclass('public.pelham_sms_messages') is not null then
    execute $q$
      select jsonb_build_object(
        'sent', count(*) filter (where direction = 'out'),
        'failed', count(*) filter (where direction = 'out' and status in ('failed', 'undelivered')),
        'received', count(*) filter (where direction = 'in'),
        'replying_numbers', count(distinct phone) filter (where direction = 'in'),
        'stop_replies', count(*) filter (where direction = 'in' and body ~* '^\s*(stop|unsubscribe|cancel|end|quit)\s*$'),
        'by_template', coalesce((
          select jsonb_agg(jsonb_build_object('template', t.template, 'sent', t.n) order by t.n desc)
            from (select coalesce(nullif(template, ''), 'other') as template, count(*) as n
                    from public.pelham_sms_messages
                   where direction = 'out' and created_at >= $1 and created_at < $2
                   group by 1 order by 2 desc limit 12) t), '[]'::jsonb))
        from public.pelham_sms_messages
       where created_at >= $1 and created_at < $2
    $q$ into v using v_start, v_end;
    v_out := v_out || jsonb_build_object('sms', v);
  end if;

  if to_regclass('public.pelham_marketing_campaigns') is not null and to_regclass('public.pelham_marketing_sends') is not null then
    execute $q$
      select coalesce(jsonb_agg(jsonb_build_object(
               'channel', c.channel, 'name', c.name, 'message', left(c.message, 300), 'status', c.status,
               'started', (coalesce(c.started_at, c.created_at) at time zone 'America/Toronto')::date,
               'recipients', s.total, 'sent', s.sent, 'delivered', s.delivered, 'failed', s.failed, 'skipped', s.skipped)
             order by coalesce(c.started_at, c.created_at)), '[]'::jsonb)
        from public.pelham_marketing_campaigns c
        left join lateral (
          select count(*) as total,
                 count(*) filter (where status in ('sent', 'delivered')) as sent,
                 count(*) filter (where status = 'delivered') as delivered,
                 count(*) filter (where status = 'failed') as failed,
                 count(*) filter (where status = 'skipped') as skipped
            from public.pelham_marketing_sends x where x.campaign_id = c.id) s on true
       where coalesce(c.started_at, c.created_at) >= $1 and coalesce(c.started_at, c.created_at) < $2
    $q$ into v using v_start, v_end;
    v_out := v_out || jsonb_build_object('campaigns', v);
  end if;

  if to_regclass('public.pelham_marketing_optouts') is not null then
    execute $q$
      select jsonb_build_object(
        'sms', count(*) filter (where channel = 'sms'),
        'call', count(*) filter (where channel = 'call'),
        'total_ever', (select count(distinct phone) from public.pelham_marketing_optouts))
        from public.pelham_marketing_optouts
       where created_at >= $1 and created_at < $2
    $q$ into v using v_start, v_end;
    v_out := v_out || jsonb_build_object('optouts', v);
  end if;

  if to_regclass('public.pelham_callback_requests') is not null then
    execute $q$
      select jsonb_build_object(
        'requests', count(*),
        'still_open', count(*) filter (where status = 'open'),
        'reasons', coalesce((
          select jsonb_agg(r.reason)
            from (select public.pelham_ai_scrub(reason) as reason
                    from public.pelham_callback_requests
                   where created_at >= $1 and created_at < $2
                   order by created_at desc limit 40) r), '[]'::jsonb))
        from public.pelham_callback_requests
       where created_at >= $1 and created_at < $2
    $q$ into v using v_start, v_end;
    v_out := v_out || jsonb_build_object('callbacks', v);
  end if;

  if to_regclass('public.pelham_phone_reports') is not null then
    execute $q$
      select coalesce(jsonb_agg(jsonb_build_object('kind', kind, 'category', category, 'count', n) order by n desc), '[]'::jsonb)
        from (select kind, category, count(*) as n
                from public.pelham_phone_reports
               where created_at >= $1 and created_at < $2
               group by 1, 2) t
    $q$ into v using v_start, v_end;
    v_out := v_out || jsonb_build_object('phone_reports', v);
  end if;

  -- 예약 경로: 예약을 **만든** 날 기준(언제 손님이 연락했나). voice_hold 는 통화 중 잠깐 잡아 둔 자리라 뺀다.
  select coalesce(jsonb_agg(jsonb_build_object('source', t.source, 'daytype', t.daytype, 'bookings', t.n)
                            order by t.source, t.daytype), '[]'::jsonb)
    into v
    from (select case when coalesce(b.source, '') = 'voice' then 'phone_assistant'
                      when coalesce(b.source, '') = 'web' then 'website'
                      when coalesce(b.source, '') = '' then 'unknown'
                      else b.source end as source,
                 public.pelham_ai_daytype(b.booking_date) as daytype,
                 count(*) as n
            from public.pelham_tee_bookings b
           where b.created_at >= v_start and b.created_at < v_end
             and coalesce(b.source, '') <> 'voice_hold'
             and coalesce(b.status, '') not in ('blocked')
           group by 1, 2) t;
  v_out := v_out || jsonb_build_object('bookings_by_source', v);

  return v_out;
end;
$$;

revoke all on function public.pelham_ai_scrub(text) from public, anon, authenticated;
revoke all on function public.pelham_staff_ai_marketing_channels(date, date) from public, anon;
grant execute on function public.pelham_staff_ai_marketing_channels(date, date) to authenticated;

notify pgrst, 'reload schema';
