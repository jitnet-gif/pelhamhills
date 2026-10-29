-- 고객 마케팅 문자 — 받는 번호를 손으로 쳐 넣기(2026-10-29 클럽 요청: "문자발송 직접 입력칸").
--
-- 왜: "2. Who gets it" 는 고객 목록(pelham_customers)에서만 골랐다. 목록에 없는 번호(647-618-4410 같은)는
-- 검색해도 0 명이라 보낼 길이 없었다.
--
-- 바꾸는 것: pelham_marketing_campaign_create(p) (0047) — p 에 두 키가 더해진다. 비우면 예전과 같다.
--   phones      : 손으로 친 번호 배열 ["6476184410", "905-555-1234"]. 10자리(앞의 1 은 뗀다)만 받는다. 문자만.
--   phones_only : true 면 그룹·필터는 무시하고 친 번호에만 보낸다.
-- 친 번호도 수신거부(pelham_marketing_optouts) 목록에 있으면 빠진다. 고객 목록에 있는 번호면 그 이름이 붙는다.
-- 캠페인 audience 에 typed(넣은 번호 수)·phones_only 가 남는다.
--
-- 전제: 0047. 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다.

do $$
begin
  if to_regprocedure('public.pelham_marketing_candidates(jsonb)') is null then
    raise exception '0132 needs 0047 first (pelham_marketing_candidates is missing).';
  end if;
end;
$$;

create or replace function public.pelham_marketing_campaign_create(p jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_channel text := p->>'channel';
  v_name text := btrim(coalesce(p->>'name', ''));
  v_message text := btrim(coalesce(p->>'message', ''));
  v_audience jsonb := coalesce(p->'audience', '{}'::jsonb) || jsonb_build_object('channel', p->>'channel');
  v_refs text[];
  v_phones text[];
  v_only boolean := coalesce((p->>'phones_only')::boolean, false);
  v_by text;
  v_id bigint;
  v_count integer;
begin
  perform public.pelham_require_marketing_viewer();
  if v_channel not in ('sms', 'call') then
    perform public.pelham_fail('422', 'channel must be sms or call.');
  end if;
  if v_name = '' then
    perform public.pelham_fail('422', 'Give the campaign a name.');
  end if;
  if v_message = '' then
    perform public.pelham_fail('422', 'Write the message.');
  end if;
  if v_channel = 'sms' and length(v_message) > 320 then
    perform public.pelham_fail('422', 'Keep the text under 320 characters (the opt-out line is added after it).');
  end if;
  if v_channel = 'call' and length(v_message) > 1000 then
    perform public.pelham_fail('422', 'Keep the call offer under 1000 characters.');
  end if;
  if jsonb_typeof(p->'customer_refs') = 'array' then
    select array_agg(x) into v_refs from jsonb_array_elements_text(p->'customer_refs') x;
  end if;
  if jsonb_typeof(p->'phones') = 'array' then
    select array_agg(distinct public.pelham_marketing_phone(x)) filter (where public.pelham_marketing_phone(x) is not null)
      into v_phones
      from jsonb_array_elements_text(p->'phones') x;
  end if;
  if v_phones is not null and v_channel <> 'sms' then
    perform public.pelham_fail('422', 'Typed phone numbers are for texts only.');
  end if;
  if v_only and v_phones is null then
    perform public.pelham_fail('422', 'Type at least one 10-digit phone number.');
  end if;
  select lower(u.email) into v_by from auth.users u where u.id = auth.uid();

  insert into public.pelham_marketing_campaigns (channel, name, message, audience, created_by)
  values (v_channel, v_name, v_message,
          v_audience
            || case when v_refs is null or v_only then '{}'::jsonb
                    else jsonb_build_object('picked', cardinality(v_refs)) end
            || case when v_phones is null then '{}'::jsonb
                    else jsonb_build_object('typed', cardinality(v_phones), 'phones_only', v_only) end,
          v_by)
  returning id into v_id;

  -- 같은 번호는 한 번만 — 회원·라운드가 많은 사람의 이름으로.
  if not v_only then
    insert into public.pelham_marketing_sends (campaign_id, customer_ref, name, phone)
    select distinct on (c.phone) v_id, c.customer_ref, c.name, c.phone
      from public.pelham_marketing_candidates(v_audience) c
     where c.ok and (v_refs is null or c.customer_ref = any(v_refs))
     order by c.phone, c.is_member desc, c.rounds desc;
  end if;

  -- 손으로 친 번호. 수신거부만 뺀다. 위에서 이미 들어간 번호는 그대로 둔다.
  if v_phones is not null then
    insert into public.pelham_marketing_sends (campaign_id, customer_ref, name, phone)
    select v_id, k.customer_ref, k.name, t.phone
      from unnest(v_phones) t(phone)
      left join lateral (
        select c.customer_ref,
               coalesce(nullif(btrim(c.display_name), ''), btrim(concat_ws(' ', c.first_name, c.last_name))) as name
          from public.pelham_customers c
         where public.pelham_marketing_phone(c.phone) = t.phone
         order by c.is_member desc, c.rounds_booked_played desc
         limit 1
      ) k on true
     where not exists (select 1 from public.pelham_marketing_optouts o
                        where o.phone = t.phone and o.channel = 'sms')
    on conflict (campaign_id, phone) do nothing;
  end if;

  select count(*) into v_count from public.pelham_marketing_sends s where s.campaign_id = v_id;

  if v_count = 0 then
    perform public.pelham_fail('422', 'Nobody in this audience can receive this campaign.');
  end if;
  if v_channel = 'call' and v_count > 300 then
    perform public.pelham_fail('422', format('%s people is too many for one call campaign (max 300). Narrow the audience.', v_count));
  end if;
  return public.pelham_marketing_campaign_json(v_id, false);
end;
$$;

revoke all on function public.pelham_marketing_campaign_create(jsonb) from public, anon, authenticated;
grant execute on function public.pelham_marketing_campaign_create(jsonb) to authenticated;

notify pgrst, 'reload schema';
