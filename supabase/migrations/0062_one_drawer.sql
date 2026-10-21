-- 계산대 마감을 화면(station)이 아니라 실제 서랍 하나로 — 티 시트·프로 샵·스낵바·베이 매출 전부.
--
-- 왜(2026-10-21 클럽 결정): 클럽에는 현금 서랍·카드 단말기가 프로 샵 카운터에 한 세트뿐이다. 그런데 0023 마감은
-- 계산서를 연 화면(`pelham_bills.station`)별이라, 티 시트 화면에서 받은 그린피·스낵바 화면에서 받은 음식값은
-- 프로 샵 마감 표에 없었다. 같은 서랍·같은 단말기 전표를 세면서 표에는 일부만 있으니 맞을 수가 없었다.
--
-- 바뀌는 것(2026-10-21 영업일부터):
--   - 어느 화면에서 Close Register 를 열든 마감 한 줄 = 서랍 'pro_shop'. 표의 Payments 는 네 화면의 결제 전부.
--   - 온라인 결제(station 'online')는 여전히 빠진다 — 서랍에도 단말기 전표에도 없다(Stripe 화면에서 맞춘다).
--   - 대사표(0061)도 서랍 하나로 센다.
-- 바뀌지 않는 것: 그 전 영업일(이미 세어 둔 기록이 화면별이다), 매출 리포트, 담당자 마감.
--
-- 구현: `pelham_register_drawer(날짜, 화면)` 이 서랍을 정한다. `pelham_register_expected` 가 그 서랍의 화면을 모두
-- 더하고, 마감 표·저장은 들어온 화면을 서랍으로 바꿔서 부른다(저장은 0046 처럼 `_base` 로 옮겨 감싼다).
-- **0046 을 다시 실행하면 표 함수가 화면별로 돌아간다** — 그 뒤엔 이 파일을 다시 실행하면 된다.
--
-- 전제: 0023, 0046, 0061. 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다.

do $$
begin
  if to_regprocedure('public.pelham_staff_register_close_report_base(date, text)') is null then
    raise exception '0062 needs 0046 first (pelham_staff_register_close_report_base is missing).';
  end if;
  if to_regprocedure('public.pelham_staff_cash_reconcile(date)') is null then
    raise exception '0062 needs 0061 first (pelham_staff_cash_reconcile is missing).';
  end if;
end;
$$;

-- ===== 서랍 ============================================================

-- 이 화면의 결제가 들어가는 서랍. 2026-10-21 부터 네 화면 모두 프로 샵 서랍이다.
create or replace function public.pelham_register_drawer(p_date date, p_station text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when p_date >= date '2026-10-21' and p_station in ('pro_shop', 'snack_bar', 'tee_sheet', 'simulator')
              then 'pro_shop'
              else p_station end
$$;

-- 한 영업일·한 서랍의 결제수단별 결제(amount + tip). 0023 과 같은 모양 — 서랍의 화면을 모두 더한다.
create or replace function public.pelham_register_expected(p_date date, p_station text)
returns table (method text, payments integer, payment_count integer)
language sql
stable
set search_path = ''
as $$
  select m.method,
         coalesce(sum(pp.amount + pp.tip), 0)::integer,
         count(pp.id)::integer
    from unnest(public.pelham_register_methods()) as m(method)
    left join public.pelham_bill_payments pp
      on pp.method = m.method
     and pp.bill_id in (select b.id from public.pelham_bills b
                         where b.business_date = p_date and b.status = 'paid'
                           and b.station in ('pro_shop', 'snack_bar', 'tee_sheet', 'simulator')
                           and public.pelham_register_drawer(p_date, b.station) = public.pelham_register_drawer(p_date, p_station))
   group by m.method
$$;

-- ===== 저장 감싸기 ======================================================

do $$
declare
  v_src text;
begin
  select p.prosrc into v_src from pg_proc p
   where p.oid = to_regprocedure('public.pelham_staff_register_close_save(date, text, jsonb)');
  if v_src not like '%_base(%' then
    if to_regprocedure('public.pelham_staff_register_close_save_base(date, text, jsonb)') is not null then
      execute 'drop function public.pelham_staff_register_close_save_base(date, text, jsonb)';
    end if;
    execute 'alter function public.pelham_staff_register_close_save(date, text, jsonb) rename to pelham_staff_register_close_save_base';
  end if;
end;
$$;

create or replace function public.pelham_staff_register_close_save(p_date date, p_station text, p jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  return public.pelham_staff_register_close_save_base(p_date, public.pelham_register_drawer(p_date, p_station), p);
end;
$$;

-- 마감 표. 0046 의 블라인드 카운트는 그대로, 들어온 화면을 서랍으로 바꾸고 서랍에 든 화면을 알려 준다.
create or replace function public.pelham_staff_register_close_report(p_date date, p_station text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_drawer text := public.pelham_register_drawer(p_date, p_station);
  v_report jsonb := public.pelham_staff_register_close_report_base(p_date, v_drawer);
begin
  v_report := v_report || jsonb_build_object(
    'stations', (select jsonb_agg(s order by o)
                   from unnest(array['tee_sheet', 'pro_shop', 'snack_bar', 'simulator']) with ordinality as t(s, o)
                  where public.pelham_register_drawer(p_date, s) = v_drawer),
    -- 아직 결제 안 된 계산서 — 서랍의 화면 전부(오늘만).
    'open_bills', case when p_date = public.pelham_pos_today() then (
        select count(*)::integer from public.pelham_bills b
         where b.status = 'open'
           and b.station in ('pro_shop', 'snack_bar', 'tee_sheet', 'simulator')
           and public.pelham_register_drawer(p_date, b.station) = v_drawer
           and exists (select 1 from public.pelham_bill_lines li where li.bill_id = b.id and li.active))
      else 0 end
  );
  if public.pelham_is_cash_viewer() then
    return v_report;
  end if;
  return v_report || jsonb_build_object(
    'rows', coalesce((
      select jsonb_agg(case when e.value->>'method' = 'cash'
                            then e.value || jsonb_build_object('payments', null, 'payment_count', null, 'remaining', null)
                            else e.value end
                       order by e.ordinality)
        from jsonb_array_elements(v_report->'rows') with ordinality as e(value, ordinality)
    ), '[]'::jsonb),
    'close', case when jsonb_typeof(v_report->'close') = 'object'
                  then jsonb_set(v_report->'close', '{expected}', (v_report->'close'->'expected') - 'cash')
                  else v_report->'close' end,
    'cash_blind', true
  );
end;
$$;

-- ===== 대사표(0061) — 서랍 하나로 =========================================
-- 0061 과 같고, 계산대 줄이 화면 넷이 아니라 서랍(그 날짜의 서랍 화면)만이다. 안 그러면 서랍 하나를 네 번 센다.

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

  with st as (
    select s.station, s.ord, c.id is not null as closed, c.opening_float, c.counted, c.expected as snap,
           (select jsonb_object_agg(e.method, e.payments) from public.pelham_register_expected(p_date, s.station) e) as pay
      from unnest(array['pro_shop', 'snack_bar', 'tee_sheet', 'simulator']) with ordinality as s(station, ord)
      left join public.pelham_register_closes c on c.business_date = p_date and c.station = s.station
     where public.pelham_register_drawer(p_date, s.station) = s.station
  )
  select jsonb_agg(jsonb_build_object(
           'station', st.station,
           'has_sales', exists (select 1 from jsonb_each_text(st.pay) j where j.value::integer <> 0),
           'closed', st.closed,
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

  with fig as (
    select * from public.pelham_closeout_figures(p_date)
  ), co as (
    select * from public.pelham_staff_closeouts where business_date = p_date
  )
  select jsonb_build_object(
           'closed', (select count(*)::integer from co),
           'counted', (select coalesce(sum(co.counted_cash), 0)::integer from co),
           'unassigned_cash', coalesce((select f.expected_cash from fig f where f.staff_key = ''), 0),
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

-- ===== 권한 ============================================================

revoke all on function public.pelham_register_drawer(date, text) from public, anon, authenticated;
revoke all on function public.pelham_register_expected(date, text) from public, anon, authenticated;
revoke all on function public.pelham_staff_register_close_save_base(date, text, jsonb) from public, anon, authenticated;
revoke all on function public.pelham_staff_register_close_save(date, text, jsonb) from public, anon, authenticated;
revoke all on function public.pelham_staff_register_close_report(date, text) from public, anon, authenticated;
revoke all on function public.pelham_staff_cash_reconcile(date) from public, anon, authenticated;

grant execute on function public.pelham_staff_register_close_save(date, text, jsonb) to authenticated;
grant execute on function public.pelham_staff_register_close_report(date, text) to authenticated;
grant execute on function public.pelham_staff_cash_reconcile(date) to authenticated;

notify pgrst, 'reload schema';
