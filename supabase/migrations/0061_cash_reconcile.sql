-- 대사표 — 매출 리포트 · 계산대 마감 · 담당자 마감을 한 영업일로 나란히 놓고 차이를 센다.
--
-- 왜(2026-10-21): 세 장표는 같은 장부(0005 계산서)를 읽지만 숫자가 그대로 같지 않다.
--   - 매출 리포트의 결제 수단별 금액은 팁을 뺀다(0005). 두 마감은 팁을 더한다(0010·0023).
--   - 계산대 마감 현금에는 시작 잔돈($200)이 들어 있다(0023).
--   - 온라인 결제(station 'online')는 매출 리포트 카드 줄에는 있지만 마감할 계산대가 없다.
-- 그래서 현금 리포트 계정이 손으로 식을 맞춰야 했다. 이 함수가 그 식을 서버에서 계산한다:
--   현금  리포트 = Cash + 현금 팁
--         계산대 = Σ(센 현금 − 시작 잔돈)                    → 차이 = 계산대 − 리포트
--         담당자 = Σ 센 현금 + Unassigned(이름 없는 계산서 현금) → 차이 = 담당자 − 리포트
--   카드·체크카드  리포트 = 금액 + 팁,  계산대 = Σ 센 금액 + 온라인 → 차이 = 계산대 − 리포트
-- 아직 닫지 않은 계산대·사람, 닫은 뒤 숫자가 바뀐 것(stale)을 같이 알려 준다. 그것이 남아 있으면
-- 차이는 "아직 맞출 수 없음" 이다(`complete = false`).
--
-- 바꾸는 것 없음 — 읽기만 한다. 현금 숫자라 0046 명단 계정만 부른다.
-- 전제: 0010, 0023, 0046. 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다.

do $$
begin
  if to_regprocedure('public.pelham_closeout_figures(date)') is null then
    raise exception '0061 needs 0010 first (pelham_closeout_figures is missing).';
  end if;
  if to_regprocedure('public.pelham_register_expected(date, text)') is null then
    raise exception '0061 needs 0023 first (pelham_register_expected is missing).';
  end if;
  if to_regprocedure('public.pelham_require_cash_viewer()') is null then
    raise exception '0061 needs 0046 first (pelham_require_cash_viewer is missing).';
  end if;
end;
$$;

-- {business_date,
--  registers: [{station, has_sales, closed, stale, cash|card|debit: {expected, counted}}],   (counted 현금은 시작 잔돈 뺀 값)
--  staff: {closed, unassigned_cash, missing: [이름], stale: [이름]},
--  lines: [{method, report: {amount, tip, total}, online,
--           registers: {counted, diff, complete}, staff: {counted, unassigned, diff, complete} (현금만)}]}
create or replace function public.pelham_staff_cash_reconcile(p_date date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_regs jsonb;
  v_report jsonb;
  v_staff jsonb;
begin
  perform public.pelham_require_cash_viewer();
  if p_date is null then
    perform public.pelham_fail('422', '''date'' must be an ISO date (YYYY-MM-DD)');
  end if;

  -- 계산대 넷. 기대 금액은 결제(amount + tip)만 — 시작 잔돈은 센 현금에서 뺀다.
  with st as (
    select s.station, s.ord, c.id is not null as closed, c.opening_float, c.counted, c.expected as snap,
           (select jsonb_object_agg(e.method, e.payments) from public.pelham_register_expected(p_date, s.station) e) as pay
      from unnest(array['pro_shop', 'snack_bar', 'tee_sheet', 'simulator']) with ordinality as s(station, ord)
      left join public.pelham_register_closes c on c.business_date = p_date and c.station = s.station
  )
  select jsonb_agg(jsonb_build_object(
           'station', st.station,
           'has_sales', exists (select 1 from jsonb_each_text(st.pay) j where j.value::integer <> 0),
           'closed', st.closed,
           -- 0023 의 stale 과 같은 비교(마감 순간의 Total Remaining ↔ 지금).
           'stale', st.closed and st.snap is distinct from
                    (st.pay || jsonb_build_object('cash', (st.pay->>'cash')::integer + public.pelham_register_float(st.station))),
           'cash', jsonb_build_object('expected', (st.pay->>'cash')::integer,
                                      'counted', case when st.closed then (st.counted->>'cash')::integer - st.opening_float end),
           'card', jsonb_build_object('expected', (st.pay->>'card')::integer,
                                      'counted', case when st.closed then (st.counted->>'card')::integer end),
           'debit', jsonb_build_object('expected', (st.pay->>'debit')::integer,
                                       'counted', case when st.closed then (st.counted->>'debit')::integer end)
         ) order by st.ord)
    into v_regs
    from st;

  -- 매출 리포트와 같은 범위(그날 결제된 계산서). 팁은 따로, 온라인은 amount + tip.
  select jsonb_object_agg(x.method, jsonb_build_object('amount', x.amount, 'tip', x.tip, 'online', x.online))
    into v_report
    from (
      select m.method,
             coalesce(sum(p.amount), 0)::integer as amount,
             coalesce(sum(p.tip), 0)::integer as tip,
             coalesce(sum(p.amount + p.tip) filter (where p.station = 'online'), 0)::integer as online
        from unnest(array['cash', 'card', 'debit']) as m(method)
        left join (
          select pp.method, pp.amount, pp.tip, b.station
            from public.pelham_bill_payments pp
            join public.pelham_bills b on b.id = pp.bill_id
           where b.business_date = p_date and b.status = 'paid'
        ) p on p.method = m.method
       group by m.method
    ) x;

  -- 담당자. stale 은 0010 리포트와 같은 비교.
  with fig as (
    select * from public.pelham_closeout_figures(p_date)
  ), co as (
    select * from public.pelham_staff_closeouts where business_date = p_date
  )
  select jsonb_build_object(
           'closed', (select count(*)::integer from co),
           'counted', (select coalesce(sum(co.counted_cash), 0)::integer from co),
           'unassigned_cash', coalesce((select f.expected_cash from fig f where f.staff_key = ''), 0),
           -- 현금을 받았는데 닫지 않았거나, 닫으면서 센 현금을 비워 둔 사람.
           'missing', coalesce((
             select jsonb_agg(f.staff_name order by f.staff_name)
               from fig f
               left join co c on c.staff_key = f.staff_key
              where f.staff_key <> '' and f.expected_cash > 0 and (c.id is null or c.counted_cash is null)
           ), '[]'::jsonb),
           'stale', coalesce((
             select jsonb_agg(c.staff_name order by c.staff_name)
               from co c
               left join fig f on f.staff_key = c.staff_key
              where (c.sale_count, c.net, c.expected_cash, c.tips_taken)
                    is distinct from (coalesce(f.sale_count, 0), coalesce(f.net, 0),
                                      coalesce(f.expected_cash, 0), coalesce(f.tips, 0))
           ), '[]'::jsonb)
         )
    into v_staff;

  return jsonb_build_object(
    'business_date', to_char(p_date, 'YYYY-MM-DD'),
    'registers', v_regs,
    'staff', v_staff - 'counted',
    'lines', (
      select jsonb_agg(jsonb_build_object(
               'method', m.method,
               'report', jsonb_build_object('amount', (r->>'amount')::integer, 'tip', (r->>'tip')::integer,
                                            'total', (r->>'amount')::integer + (r->>'tip')::integer),
               'online', (r->>'online')::integer,
               'registers', jsonb_build_object(
                 'counted', g.counted,
                 'diff', g.counted + (r->>'online')::integer - (r->>'amount')::integer - (r->>'tip')::integer,
                 -- 결제가 있는 계산대가 모두 닫혔고, 닫은 뒤 바뀐 것이 없다.
                 'complete', g.complete),
               'staff', case when m.method = 'cash' then jsonb_build_object(
                 'counted', (v_staff->>'counted')::integer,
                 'unassigned', (v_staff->>'unassigned_cash')::integer,
                 'diff', (v_staff->>'counted')::integer + (v_staff->>'unassigned_cash')::integer
                         - (r->>'amount')::integer - (r->>'tip')::integer,
                 'complete', jsonb_array_length(v_staff->'missing') = 0 and jsonb_array_length(v_staff->'stale') = 0)
               end
             ) order by m.ord)
        from unnest(array['cash', 'card', 'debit']) with ordinality as m(method, ord)
        cross join lateral (select v_report->m.method as r) rr
        cross join lateral (
          select coalesce(sum((e->m.method->>'counted')::integer), 0)::integer as counted,
                 coalesce(bool_and(((e->>'closed')::boolean or not (e->>'has_sales')::boolean)
                                   and not (e->>'stale')::boolean), true) as complete
            from jsonb_array_elements(v_regs) e
        ) g
    )
  );
end;
$$;

revoke all on function public.pelham_staff_cash_reconcile(date) from public, anon, authenticated;
grant execute on function public.pelham_staff_cash_reconcile(date) to authenticated;

notify pgrst, 'reload schema';
