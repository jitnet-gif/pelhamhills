-- Stripe 대사(Stripe reconciliation) — Stripe 가 실제로 받은·돌려준 카드 돈과 우리 전산 기록을 맞춰 본다.
--
-- 왜(2026-10-14): 카드 돈은 두 곳에 남는다. Stripe(진짜 돈)와 우리 표(계산서·단말기 거래·온라인 결제).
-- 둘이 어긋나는 길이 몇 가지 있다 — 단말기에서 승인됐는데 계산서에 안 붙음, 전산에서는 환불했는데 카드는
-- 그대로, Stripe 대시보드에서 직접 환불, 웹훅을 놓친 온라인 결제, 금액이 다름. 하루 마감 숫자만 봐서는
-- 보이지 않는다. Reports 의 "Stripe check" 탭이 FastAPI(`/payments/reconcile`)를 부르고, FastAPI 가
-- Stripe 목록과 이 함수의 결과를 PaymentIntent(`pi_…`) 단위로 맞춘다(`backend/services/stripe_reconcile.py`).
--
-- 이 함수는 우리 쪽 기록만 돌려준다(읽기 전용). 고르는 기준:
--   - 단말기: 기간 안에 생긴 거래, 기간 안에 환불된 계산서의 거래, 또는 p_ids 에 든 pi_/ch_/re_ — 이것들의
--     PaymentIntent 에 딸린 줄(판매·환불) 전부.
--   - 온라인: 기간 안에 생김·승인·환불, 또는 p_ids 에 든 pi_/re_/invoice.
--   - 손으로 친 카드(keyed): Stripe 를 거치지 않으니 대조할 수 없다. 건수·금액만.
-- p_ids 는 Stripe 쪽에서 기간 안에 보인 id 들이다(자정 근처에 걸친 기록까지 짝을 찾으려고).
--
-- 규칙은 0005·0023 과 같다. 전제: 0005, 0019, 0020, 0021. 실행: SQL editor 에 이 파일 전체를 붙여 한 번.
-- 다시 실행해도 안전하다.

do $$
begin
  if to_regprocedure('public.pelham_require_staff()') is null then
    raise exception '0027 needs 0004 first (pelham_require_staff is missing).';
  end if;
  if to_regclass('public.pelham_online_payments') is null then
    raise exception '0027 needs 0020 first (pelham_online_payments is missing).';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'pelham_terminal_transactions'
                    and column_name = 'payment_intent') then
    raise exception '0027 needs 0021 first (pelham_terminal_transactions.payment_intent is missing).';
  end if;
end;
$$;

-- 기간 [p_from, p_to). 최대 32일.
-- {terminal: [...], online: [...], keyed: {count, amount}}
create or replace function public.pelham_staff_stripe_records(p_from timestamptz, p_to timestamptz, p_ids text[])
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_ids text[] := coalesce(p_ids, '{}');
begin
  perform public.pelham_require_staff();
  if p_from is null or p_to is null or p_to <= p_from then
    perform public.pelham_fail('422', 'Pick a date range.');
  end if;
  if p_to - p_from > interval '32 days' then
    perform public.pelham_fail('422', 'Pick 31 days or fewer.');
  end if;
  if cardinality(v_ids) > 5000 then
    perform public.pelham_fail('422', 'Too many Stripe ids. Pick a shorter range.');
  end if;

  return jsonb_build_object(
    'terminal', (
      with pis as (
        select distinct t.payment_intent
          from public.pelham_terminal_transactions t
          left join public.pelham_bills b on b.id = t.bill_id
         where t.payment_intent is not null
           and ((t.created_at >= p_from and t.created_at < p_to)
                or (b.refunded_at >= p_from and b.refunded_at < p_to)
                or t.payment_intent = any(v_ids)
                or t.transaction_id = any(v_ids))
      )
      select coalesce(jsonb_agg(jsonb_build_object(
               'id', t.id,
               'kind', t.kind,
               'result', t.result,
               'approved', t.approved,
               'payment_intent', t.payment_intent,
               'transaction_id', t.transaction_id,
               'requested_amount', t.requested_amount,
               'tip', t.tip,
               'total_amount', t.total_amount,
               'card_brand', t.card_brand,
               'card_last4', t.card_last4,
               'card_type', t.card_type,
               'refund_of', t.refund_of,
               'voided_at', public.pelham_iso(t.voided_at),
               'bill_payment_id', t.bill_payment_id,
               'created_at', public.pelham_iso(t.created_at),
               'bill_id', t.bill_id,
               'bill_status', b.status,
               'receipt_no', b.receipt_no,
               'business_date', to_char(b.business_date, 'YYYY-MM-DD'),
               'station', b.station,
               'bill_refunded_at', public.pelham_iso(b.refunded_at),
               'pay_amount', bp.amount,
               'pay_tip', bp.tip
             ) order by t.id), '[]'::jsonb)
        from public.pelham_terminal_transactions t
        join pis on pis.payment_intent = t.payment_intent
        left join public.pelham_bills b on b.id = t.bill_id
        left join public.pelham_bill_payments bp on bp.id = t.bill_payment_id
    ),
    'online', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'id', o.id,
               'invoice', o.invoice,
               'kind', o.kind,
               'status', o.status,
               'amount', o.amount,
               'trans_id', o.trans_id,
               'refund_kind', o.refund_kind,
               'refund_trans_id', o.refund_trans_id,
               'card_brand', o.card_brand,
               'card_last4', o.card_last4,
               'customer_name', o.customer_name,
               'confirmation_code', o.confirmation_code,
               'created_at', public.pelham_iso(o.created_at),
               'approved_at', public.pelham_iso(o.approved_at),
               'refunded_at', public.pelham_iso(o.refunded_at),
               'bill_id', o.bill_id,
               'bill_status', b.status,
               'receipt_no', b.receipt_no,
               'business_date', to_char(b.business_date, 'YYYY-MM-DD')
             ) order by o.id), '[]'::jsonb)
        from public.pelham_online_payments o
        left join public.pelham_bills b on b.id = o.bill_id
       where (o.created_at >= p_from and o.created_at < p_to)
          or (o.approved_at >= p_from and o.approved_at < p_to)
          or (o.refunded_at >= p_from and o.refunded_at < p_to)
          or o.trans_id = any(v_ids)
          or o.refund_trans_id = any(v_ids)
          or o.invoice = any(v_ids)
    ),
    'keyed', (
      select jsonb_build_object('count', count(*)::integer, 'amount', coalesce(sum(bp.amount + bp.tip), 0)::integer)
        from public.pelham_bill_payments bp
        join public.pelham_bills b on b.id = bp.bill_id
       where bp.entry = 'keyed' and b.status = 'paid'
         and b.paid_at >= p_from and b.paid_at < p_to
    )
  );
end;
$$;

-- ===== 권한 ============================================================

revoke all on function public.pelham_staff_stripe_records(timestamptz, timestamptz, text[]) from public, anon, authenticated;
grant execute on function public.pelham_staff_stripe_records(timestamptz, timestamptz, text[]) to authenticated;
