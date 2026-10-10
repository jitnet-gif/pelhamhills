-- 티 시트 예약 상세가 그 예약의 결제·환불 기록을 보여 준다.
--
-- 왜(2026-10-10): 환불(계산대 Reports 든 손님 온라인 취소든)은 플레이어의 paid·paidAt 을 지우고 계산서 줄을
-- 무효로 한다. 그래서 취소된 예약을 열면 "Cancelled" 만 남고, 받은 돈·영수증 번호·환불 시각·사유를 볼 길이
-- 없었다(감사 기록 한 줄뿐). 계산서는 지워지지 않으므로(status = 'refunded'), 예약 id 로 다시 찾으면 된다.
--
-- pelham_staff_tee_bills(p_booking): 이 예약의 그린피 줄이 실렸던 결제·환불 계산서(최신순).
-- 각 계산서는 pelham_pos_bill_json 그대로이고, 온라인으로 낸 것이면 `online` 이 붙는다
-- ({invoice, status, refund_kind, card_brand}). 아니면 null.
--
-- 전제: 0005(계산서), 0020(온라인 결제). 실행: SQL editor 에 붙여 한 번. 다시 실행해도 안전하다.

-- 예약 id 로 계산서 줄을 찾는다(지금은 bill_id 색인뿐이다).
create index if not exists pelham_bill_lines_booking_idx
  on public.pelham_bill_lines (booking_id) where booking_id is not null;

create or replace function public.pelham_staff_tee_bills(p_booking text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  perform public.pelham_require_staff();
  select coalesce(jsonb_agg(
           public.pelham_pos_bill_json(b.id) || jsonb_build_object('online', (
             select jsonb_build_object('invoice', o.invoice, 'status', o.status, 'refund_kind', o.refund_kind,
                                       'card_brand', o.card_brand)
               from public.pelham_online_payments o
              where o.bill_id = b.id
              order by o.id desc
              limit 1))
           order by b.paid_at desc nulls last, b.id desc), '[]'::jsonb)
    into v_result
    from public.pelham_bills b
   where b.status in ('paid', 'refunded')
     and exists (select 1 from public.pelham_bill_lines li
                  where li.bill_id = b.id and li.kind = 'tee_player'
                    and li.booking_id = btrim(coalesce(p_booking, '')));
  return v_result;
end;
$$;

revoke all on function public.pelham_staff_tee_bills(text) from public, anon, authenticated;
grant execute on function public.pelham_staff_tee_bills(text) to authenticated;
