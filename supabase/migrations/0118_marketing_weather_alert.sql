-- 고객 마케팅(`/marketing`) Weather alert 탭 — 날씨 돌발상황(서리 지연·비·번개·휴장·카트 패스 온리)을
-- **그날 티 시트에 예약된 손님**에게 문자로 한 번에 알린다.
--
-- 왜(2026-10-25): 사용자 요청 "마케팅 타일에 날씨관련 돌발상황 관련 당일 문자발송 탭을 만들어줘 해당일 예약
-- 시트에 대해서". 지금까지 캠페인은 고객 명부(pelham_customers)에서만 받는 사람을 골랐다 — 오늘 예약한
-- 손님(특히 회원 명부에 없는 웹·전화 예약 손님)에게는 보낼 길이 없었다.
--
-- 받는 사람: 그날 `pelham_tee_bookings` 중 취소·노쇼·막음·음성 홀드가 아닌 예약의 플레이어(취소·노쇼 빼고)
--   중 전화번호가 있는 사람. 같은 번호는 한 번만 — 가장 이른 티 타임으로.
-- 동의: 예약에 대한 안내라 CASL 의 거래 메시지(동의·수신거부 문구가 필요 없다)다. 그래도 문자 수신거부
--   (STOP)한 번호는 뺀다 — Twilio 도 그 번호로는 보내지 않는다(21610).
-- 날짜: 클럽 시각으로 오늘·내일만(내일 = 전날 저녁에 미리 알릴 때).
--
-- 기록은 보통 캠페인과 같은 표에 남는다 — audience.kind = 'weather'. Campaigns 탭에서 보이고, 멈추고, 이어 보낸다.
-- 문자 안 {name} 은 받는 사람 이름(첫 이름), {time} 은 그 사람의 티 타임으로 백엔드가 바꿔 넣는다.
-- 그래서 pelham_marketing_sends 에 tee_time 칸을 더하고, claim·campaign_json 이 그 칸을 돌려준다.
--
-- 전제: 0002, 0047. 0116 의 campaign_json(수신거부 표시)도 여기 같이 들어 있다 — 0116 을 아직 안 돌렸어도
-- 된다. 0116 을 **나중에** 돌리면 Campaigns 상세의 티 타임 칸만 빠진다(이 파일을 한 번 더 돌리면 돌아온다).
-- 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다.

do $$
begin
  if to_regclass('public.pelham_marketing_optouts') is null then
    raise exception '0118 needs 0047 first (pelham_marketing_optouts is missing).';
  end if;
  if to_regclass('public.pelham_tee_bookings') is null then
    raise exception '0118 needs 0002 first (pelham_tee_bookings is missing).';
  end if;
end;
$$;

alter table public.pelham_marketing_sends add column if not exists tee_time text;

-- ===== 받는 사람 =========================================================
-- 그날 예약의 플레이어 한 줄씩. ok = 보낼 수 있나, reason = no_phone | opted_out.

create or replace function public.pelham_marketing_weather_candidates(p_date date)
returns table (booking_id text, tee_time text, minutes integer, title text, status text,
               player_name text, phone text, ok boolean, reason text)
language sql
stable
security definer
set search_path = ''
as $$
  select b.id,
         b.tee_time,
         (extract(hour from b.tee_time::time) * 60 + extract(minute from b.tee_time::time))::integer,
         b.title,
         b.status,
         coalesce(nullif(btrim(pl.value->>'name'), ''), 'Guest'),
         public.pelham_marketing_phone(pl.value->>'phone'),
         r.reason is null,
         r.reason
    from public.pelham_tee_bookings b
   cross join lateral jsonb_array_elements(coalesce(b.doc->'players', '[]'::jsonb)) pl(value)
   cross join lateral (
     select case
       when public.pelham_marketing_phone(pl.value->>'phone') is null then 'no_phone'
       when exists (select 1 from public.pelham_marketing_optouts o
                     where o.phone = public.pelham_marketing_phone(pl.value->>'phone') and o.channel = 'sms')
         then 'opted_out'
       else null
     end as reason
   ) r
   where b.booking_date = p_date
     and coalesce(b.status, 'reserved') not in ('cancelled', 'no_show', 'blocked')
     and coalesce(b.source, '') <> 'voice_hold'
     and b.tee_time ~ '^\d{1,2}:\d{2} (AM|PM)$'
     and coalesce((pl.value->>'cancelled')::boolean, false) = false
     and coalesce((pl.value->>'no_show')::boolean, false) = false
$$;

-- p: {date: 'YYYY-MM-DD'} → 티 타임마다 플레이어와 보낼 수 있는지.
create or replace function public.pelham_marketing_weather_audience(p jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_today date := (now() at time zone 'America/Toronto')::date;
  v_date date := coalesce(nullif(p->>'date', '')::date, (now() at time zone 'America/Toronto')::date);
begin
  perform public.pelham_require_marketing_viewer();
  return (
    with c as (select * from public.pelham_marketing_weather_candidates(v_date)),
    t as (
      select c.booking_id, min(c.tee_time) as tee_time, min(c.minutes) as minutes, min(c.title) as title,
             min(c.status) as status,
             jsonb_agg(jsonb_build_object('name', c.player_name, 'phone', c.phone, 'ok', c.ok, 'reason', c.reason)
                       order by c.ok desc, c.player_name) as players
        from c group by c.booking_id
    )
    select jsonb_build_object(
      'date', v_date,
      'today', v_today,
      'now_minutes', (extract(hour from (now() at time zone 'America/Toronto')) * 60
                      + extract(minute from (now() at time zone 'America/Toronto')))::integer,
      'players', (select count(*) from c),
      'phones', (select count(distinct c.phone) from c where c.ok),
      'no_phone', (select count(*) from c where c.reason = 'no_phone'),
      'opted_out', (select count(*) from c where c.reason = 'opted_out'),
      'tee_times', coalesce((select jsonb_agg(jsonb_build_object(
          'booking_id', t.booking_id, 'time', t.tee_time, 'minutes', t.minutes, 'title', t.title,
          'status', t.status, 'players', t.players) order by t.minutes, t.booking_id) from t), '[]'::jsonb)
    )
  );
end;
$$;

-- p: {date, name, message, booking_ids: [..]} — 고른 티 타임의 손님에게 보낼 캠페인을 만든다(보내기는 백엔드).
create or replace function public.pelham_marketing_weather_create(p jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_today date := (now() at time zone 'America/Toronto')::date;
  v_date date;
  v_name text := btrim(coalesce(p->>'name', ''));
  v_message text := btrim(coalesce(p->>'message', ''));
  v_ids text[];
  v_by text;
  v_id bigint;
  v_count integer;
begin
  perform public.pelham_require_marketing_viewer();
  begin
    v_date := (p->>'date')::date;
  exception when others then
    v_date := null;
  end;
  if v_date is null or v_date < v_today or v_date > v_today + 1 then
    perform public.pelham_fail('422', 'Weather alerts go to today''s or tomorrow''s tee sheet only.');
  end if;
  if v_name = '' then
    v_name := 'Weather alert ' || to_char(v_date, 'Mon DD');
  end if;
  if v_message = '' then
    perform public.pelham_fail('422', 'Write the message.');
  end if;
  if length(v_message) > 320 then
    perform public.pelham_fail('422', 'Keep the text under 320 characters.');
  end if;
  if jsonb_typeof(p->'booking_ids') = 'array' then
    select array_agg(x) into v_ids from jsonb_array_elements_text(p->'booking_ids') x;
  end if;
  if coalesce(cardinality(v_ids), 0) = 0 then
    perform public.pelham_fail('422', 'Pick at least one tee time.');
  end if;
  select lower(u.email) into v_by from auth.users u where u.id = auth.uid();

  insert into public.pelham_marketing_campaigns (channel, name, message, audience, created_by)
  values ('sms', v_name, v_message,
          jsonb_build_object('kind', 'weather', 'channel', 'sms', 'date', v_date,
                             'tee_times', cardinality(v_ids), 'segment', 'tee_sheet'),
          v_by)
  returning id into v_id;

  -- 같은 번호는 한 번만 — 가장 이른 티 타임으로.
  insert into public.pelham_marketing_sends (campaign_id, name, phone, tee_time)
  select distinct on (c.phone) v_id, c.player_name, c.phone, c.tee_time
    from public.pelham_marketing_weather_candidates(v_date) c
   where c.ok and c.booking_id = any(v_ids)
   order by c.phone, c.minutes;
  get diagnostics v_count = row_count;

  if v_count = 0 then
    perform public.pelham_fail('422', 'Nobody on the picked tee times has a phone number that can get texts.');
  end if;
  return public.pelham_marketing_campaign_json(v_id, false);
end;
$$;

-- ===== 0047·0116 함수에 tee_time 을 더한다 ==================================

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
         || case when p_with_sends then jsonb_build_object('sends', (
              select coalesce(jsonb_agg(jsonb_build_object(
                       'id', s.id, 'customer_ref', s.customer_ref, 'name', s.name, 'phone', s.phone,
                       'status', s.status, 'provider_ref', s.provider_ref, 'error', s.error,
                       'updated_at', s.updated_at, 'tee_time', s.tee_time,
                       'optout', case when o.phone is null then null else jsonb_build_object(
                         'created_at', o.created_at, 'source', o.source,
                         'after_send', s.status in ('sent', 'delivered')
                                       and o.created_at >= coalesce(c.started_at, c.created_at)) end)
                     order by s.id), '[]'::jsonb)
                from public.pelham_marketing_sends s
                left join public.pelham_marketing_optouts o on o.phone = s.phone and o.channel = c.channel
               where s.campaign_id = c.id))
            else '{}'::jsonb end
    from public.pelham_marketing_campaigns c
   where c.id = p_id
$$;

-- 0047 과 같고, 집은 사람마다 tee_time 을 같이 돌려준다.
create or replace function public.pelham_marketing_claim(p_campaign bigint, p_limit integer)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_channel text;
  v_status text;
  v_sends jsonb;
begin
  select c.channel, c.status into v_channel, v_status
    from public.pelham_marketing_campaigns c where c.id = p_campaign for update;
  if v_channel is null then
    perform public.pelham_fail('404', 'No such campaign.');
  end if;
  if v_status = 'cancelled' then
    return jsonb_build_object('channel', v_channel, 'status', v_status, 'sends', '[]'::jsonb);
  end if;
  update public.pelham_marketing_campaigns c
     set status = 'sending', started_at = coalesce(c.started_at, now())
   where c.id = p_campaign and c.status = 'ready';

  update public.pelham_marketing_sends s
     set status = 'skipped', error = 'opted out', updated_at = now()
   where s.campaign_id = p_campaign and s.status = 'queued'
     and exists (select 1 from public.pelham_marketing_optouts o where o.phone = s.phone and o.channel = v_channel);

  with picked as (
    update public.pelham_marketing_sends s
       set status = 'sending', updated_at = now()
     where s.id in (select x.id from public.pelham_marketing_sends x
                     where x.campaign_id = p_campaign and x.status = 'queued'
                     order by x.id limit greatest(coalesce(p_limit, 1), 1)
                     for update skip locked)
    returning s.id, s.name, s.phone, s.tee_time
  )
  select jsonb_agg(jsonb_build_object('id', picked.id, 'name', picked.name, 'phone', picked.phone,
                                      'tee_time', picked.tee_time) order by picked.id)
    into v_sends
    from picked;

  return jsonb_build_object('channel', v_channel, 'status', 'sending', 'sends', coalesce(v_sends, '[]'::jsonb));
end;
$$;

-- ===== 권한 ============================================================

revoke all on function public.pelham_marketing_weather_candidates(date) from public, anon, authenticated;
revoke all on function public.pelham_marketing_campaign_json(bigint, boolean) from public, anon, authenticated;
revoke all on function public.pelham_marketing_claim(bigint, integer) from public, anon, authenticated;
grant execute on function public.pelham_marketing_claim(bigint, integer) to service_role;

revoke all on function public.pelham_marketing_weather_audience(jsonb) from public, anon, authenticated;
revoke all on function public.pelham_marketing_weather_create(jsonb) from public, anon, authenticated;
grant execute on function public.pelham_marketing_weather_audience(jsonb) to authenticated;
grant execute on function public.pelham_marketing_weather_create(jsonb) to authenticated;

notify pgrst, 'reload schema';
