-- 회원권 온라인 카드 거래를 `/admin/memberships` 편집 창에서 본다(2026-10-30 클럽 요청).
--
-- 왜: 온라인 결제 장부(0042 pelham_membership_payments)는 service_role 전용이라 직원 화면이 읽지 못했다.
-- 그래서 명부에는 합계와 메모 한 줄뿐이었고, 거래 시각·카드·Stripe 번호를 보려면 Stripe 에 들어가야 했다.
--
-- 바뀌는 것: 읽기 함수 하나를 더한다. 장부 표의 권한은 그대로다.
-- 결제를 시작만 하고 끝내지 않은 pending 줄은 거래가 아니므로 뺀다.
--
-- 전제: 0042. 실행: SQL editor 에 이 파일 전체를 붙여 한 번. Vercel 배포보다 먼저. 다시 실행해도 안전하다.

do $$
begin
  if to_regclass('public.pelham_membership_payments') is null then
    raise exception '0146 needs 0042 first (pelham_membership_payments is missing).';
  end if;
end;
$$;

create or replace function public.pelham_staff_membership_transactions(p_membership uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.pelham_require_staff();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'invoice', o.invoice,
             'amount', o.amount,
             'status', o.status,
             'card_brand', o.card_brand,
             'card_last4', o.card_last4,
             'trans_id', o.trans_id,
             'response_text', o.response_text,
             -- 승인되지 않은 줄에는 approved_at 이 없다. 결과를 기록한 때가 거래 시각이다.
             'transacted_at', coalesce(o.approved_at, o.updated_at),
             'refunded_at', o.refunded_at
           ) order by coalesce(o.approved_at, o.updated_at) desc)
      from public.pelham_membership_payments o
     where o.membership_id = p_membership and o.status <> 'pending'
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.pelham_staff_membership_transactions(uuid) from public, anon, authenticated;
grant execute on function public.pelham_staff_membership_transactions(uuid) to authenticated;

notify pgrst, 'reload schema';
