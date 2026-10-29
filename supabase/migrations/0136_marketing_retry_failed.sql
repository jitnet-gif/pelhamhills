-- 고객 마케팅 Campaigns 상세 — 실패한 사람에게 다시 보내기(2026-10-29 클럽 요청).
--
-- 왜: "실패한것 다시 보내기 기능 넣어줘". 문자·전화가 실패(failed)하면 그대로 끝났다. 같은 캠페인을
--   다시 만들면 이미 받은 사람에게도 또 간다.
--
-- 바꾸는 것: pelham_marketing_retry_failed(p_id, p_send_ids) 하나 더한다.
--   - 그 캠페인의 failed 줄(p_send_ids 를 주면 그 줄만)을 queued 로 되돌린다. error·provider_ref 는 비운다
--     (Twilio 가 실패 문자에 매긴 요금은 Cost 칩에서 빠진다 — 실패 문자는 보통 요금이 없다).
--   - 다 끝난(sent) 캠페인은 sending 으로 되돌린다 — 백엔드가 줄을 다시 돌고 끝나면 sent 로 닫는다.
--   - 취소된 캠페인은 거절한다. 지금 수신거부한 번호는 다시 집을 때 claim(0118)이 skipped 로 뺀다.
--   - 돌려준 값: 상세 json(pelham_marketing_campaign) + retried(되돌린 수).
-- 보내기 자체는 백엔드 POST /marketing/campaigns/{id}/retry 가 이 함수를 부른 뒤 시작한다.
--
-- 전제: 0047, 0118. 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다.

create or replace function public.pelham_marketing_retry_failed(p_id bigint, p_send_ids bigint[] default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_status text;
  v_count integer;
begin
  perform public.pelham_require_marketing_viewer();
  select c.status into v_status from public.pelham_marketing_campaigns c where c.id = p_id for update;
  if v_status is null then
    perform public.pelham_fail('404', 'No such campaign.');
  end if;
  if v_status = 'cancelled' then
    perform public.pelham_fail('409', 'This campaign was stopped. Make a new one to send again.');
  end if;

  update public.pelham_marketing_sends s
     set status = 'queued', error = null, provider_ref = null, updated_at = now()
   where s.campaign_id = p_id and s.status = 'failed'
     and (p_send_ids is null or s.id = any(p_send_ids));
  get diagnostics v_count = row_count;

  if v_count > 0 then
    update public.pelham_marketing_campaigns c
       set status = 'sending', started_at = coalesce(c.started_at, now())
     where c.id = p_id and c.status in ('ready', 'sent');
  end if;

  return public.pelham_marketing_campaign(p_id) || jsonb_build_object('retried', v_count);
end;
$$;

revoke all on function public.pelham_marketing_retry_failed(bigint, bigint[]) from public, anon, authenticated;
grant execute on function public.pelham_marketing_retry_failed(bigint, bigint[]) to authenticated;

notify pgrst, 'reload schema';

-- ===== 확인 ============================================================
-- 함수가 있어야 한다(한 줄).
select proname from pg_proc where proname = 'pelham_marketing_retry_failed';
