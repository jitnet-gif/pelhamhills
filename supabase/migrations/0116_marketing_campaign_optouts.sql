-- 고객 마케팅(`/marketing`) Campaigns 탭 — 보낸 문자·전화마다 **수신거부**를 보여 준다.
--
-- 왜(2026-10-25): 사용자 요청 "마케팅 타일에 고객문자송신 내용 중에 문자수신거부 내용을 반영". 지금까지
-- 캠페인 상세에는 보냄·도착·실패만 있고, 받은 손님이 STOP 으로 답했는지(또는 전화에서 그만 걸라 했는지,
-- 직원이 손으로 뺐는지)는 Opt-outs 탭에 따로만 있었다.
--
-- `pelham_marketing_campaign_json` 을 다시 만든다(0047 과 같은 모양 + 아래 칸).
--   opted_out_after   이 캠페인을 받은(보냄·도착) 번호 중, 캠페인이 시작된 뒤 같은 채널에서 수신거부한 수
--   sends[].optout    지금 그 번호가 같은 채널에서 수신거부 상태면 {created_at, source, after_send}
--                     after_send = 이 캠페인이 시작된 뒤에 거부했나(= 이 문자·전화를 받고 거부했을 가능성)
--
-- 보내기 자체는 이미 수신거부를 지킨다(0047 `pelham_marketing_claim` 이 집는 순간 다시 보고 'skipped').
-- 이 파일은 보여 주기만 바꾼다.
--
-- 전제: 0047. 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다.

do $$
begin
  if to_regclass('public.pelham_marketing_optouts') is null then
    raise exception '0116 needs 0047 first (pelham_marketing_optouts is missing).';
  end if;
end;
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
         || case when p_with_sends then jsonb_build_object('sends', (
              select coalesce(jsonb_agg(jsonb_build_object(
                       'id', s.id, 'customer_ref', s.customer_ref, 'name', s.name, 'phone', s.phone,
                       'status', s.status, 'provider_ref', s.provider_ref, 'error', s.error,
                       'updated_at', s.updated_at,
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

revoke all on function public.pelham_marketing_campaign_json(bigint, boolean) from public, anon, authenticated;

notify pgrst, 'reload schema';
