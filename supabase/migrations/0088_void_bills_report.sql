-- 하루 동안 void 한 계산서 목록 — Daily close 의 Cancels & voids 칸(2026-10-23).
--
-- 왜: 마감 리포트(`pelham_staff_bills`, `pelham_staff_pos_report_daily`)는 paid·refunded 만 본다. void 한 계산서는
-- 영수증 번호도 영업일도 없어서(결제 전이다) 어디에도 나오지 않았다. 계산대에서 담았다가 지운 판매를 매니저가
-- 볼 수 있게, void 한 시각(클럽 현지 날짜)으로 하루치를 돌려준다.
--
-- pelham_staff_void_bills(p_date): [{id, label, station, cashier, note, opened_at, voided_at,
--   subtotal, discount, tax, total, lines: [{name, quantity, line_total}]}] — void 시각 순.
-- void 하면 줄이 모두 active = false 가 되므로(0005 `pelham_staff_bill_void`) 줄은 active 를 보지 않고 다 싣는다.
-- 금액은 void 직전 계산서에 남아 있던 값이다.
--
-- 전제: 0005. 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다.

do $$
begin
  if to_regprocedure('public.pelham_require_staff()') is null or to_regclass('public.pelham_bills') is null then
    raise exception '0088 needs 0004 and 0005 first.';
  end if;
end;
$$;

create index if not exists pelham_bills_voided_idx
  on public.pelham_bills (voided_at) where status = 'void';

create or replace function public.pelham_staff_void_bills(p_date date)
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
             'id', b.id,
             'label', b.label,
             'station', b.station,
             'cashier', b.cashier,
             'note', b.note,
             'opened_at', public.pelham_iso(b.opened_at),
             'voided_at', public.pelham_iso(b.voided_at),
             'subtotal', b.subtotal,
             'discount', b.discount,
             'tax', b.tax,
             'total', b.total,
             'lines', coalesce((
               select jsonb_agg(jsonb_build_object('name', li.name, 'quantity', li.quantity,
                                                   'line_total', li.line_total) order by li.id)
                 from public.pelham_bill_lines li
                where li.bill_id = b.id
             ), '[]'::jsonb))
           order by b.voided_at, b.id)
      from public.pelham_bills b
     where b.status = 'void'
       and b.voided_at >= (p_date::timestamp at time zone 'America/Toronto')
       and b.voided_at < ((p_date + 1)::timestamp at time zone 'America/Toronto')
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.pelham_staff_void_bills(date) from public, anon, authenticated;
grant execute on function public.pelham_staff_void_bills(date) to authenticated;

notify pgrst, 'reload schema';
