-- 계산대 마감 기록 리포트 — Reports 의 "Register closes" 탭.
--
-- 왜(2026-10-21): 마감(0023, 0062 부터 서랍 하나)은 Close Register 화면에서 그 날 하나씩만 보였다. 지난 마감을
-- 한 눈에 — 언제 누가 닫았는지, 센 돈이 마감 순간의 기대 금액과 얼마나 달랐는지, 마감 뒤에 결제·환불이 더
-- 들어와 다시 세야 하는지, 매출이 있는데 아무도 닫지 않은 날이 있는지 — 볼 곳이 없었다.
--
-- 한 줄 = (영업일, 서랍). 서랍은 0062 `pelham_register_drawer` 가 정한다: 2026-10-21 부터 하루 한 줄(프로 샵 서랍,
-- 네 화면 전부), 그 전은 화면마다. 마감했거나 결제가 있었던 서랍만 나온다.
--
-- 숫자(센트):
--   expected = 마감 순간의 Total Remaining(현금은 시작 잔돈 포함) — 마감하지 않았으면 지금 값.
--   now      = 지금 다시 센 Total Remaining. expected 와 다르면 `stale`(마감 뒤 결제·환불).
--   counted  = 센 돈(현금은 잔돈 포함). 셀 실물이 없는 수단(회원 계정·기프트카드·레인체크)은 null.
--   diff     = counted − expected. +면 남고 −면 모자람.
-- 현금은 현금 리포트 계정(0046)만 본다 — 아니면 현금 줄을 통째로 뺀다(블라인드 카운트와 같은 울타리).
--
-- 전제: 0023, 0046, 0062. 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다.

do $$
begin
  if to_regprocedure('public.pelham_register_drawer(date, text)') is null then
    raise exception '0065 needs 0062 first (pelham_register_drawer is missing).';
  end if;
  if to_regprocedure('public.pelham_is_cash_viewer()') is null then
    raise exception '0065 needs 0046 first (pelham_is_cash_viewer is missing).';
  end if;
end;
$$;

-- {from, to, cash, rows: [{business_date, drawer, stations, closed, closed_at, closed_by, note, stale, has_sales,
--   lines: [{method, countable, expected, now, counted, diff}]}]} — 최근 날짜 먼저.
create or replace function public.pelham_staff_register_close_history(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_cash boolean;
  v_rows jsonb;
begin
  perform public.pelham_require_staff();
  if p_from is null or p_to is null then
    perform public.pelham_fail('422', '''from'' and ''to'' must be ISO dates (YYYY-MM-DD)');
  end if;
  if p_from > p_to then
    perform public.pelham_fail('422', '''from'' must be on or before ''to''.');
  end if;
  if p_to - p_from > 92 then
    perform public.pelham_fail('422', 'Pick 93 days or fewer.');
  end if;
  v_cash := public.pelham_is_cash_viewer();

  with dr as (
    select distinct d::date as business_date,
           public.pelham_register_drawer(d::date, s.station) as drawer
      from generate_series(p_from, p_to, interval '1 day') as d
     cross join unnest(array['pro_shop', 'snack_bar', 'tee_sheet', 'simulator']) as s(station)
  ), cur as (
    select dr.business_date, dr.drawer, e.method, e.payments,
           e.payments + case when e.method = 'cash' then public.pelham_register_float(dr.drawer) else 0 end as remaining
      from dr
     cross join lateral public.pelham_register_expected(dr.business_date, dr.drawer) e
  ), one as (
    select dr.business_date, dr.drawer, c.id as close_id, c.expected as snap, c.counted, c.note, c.closed_at,
           (select u.email from auth.users u where u.id = c.closed_by) as closed_by,
           (select jsonb_object_agg(x.method, x.remaining) from cur x
             where x.business_date = dr.business_date and x.drawer = dr.drawer) as now,
           exists (select 1 from cur x
                    where x.business_date = dr.business_date and x.drawer = dr.drawer and x.payments <> 0) as has_sales
      from dr
      left join public.pelham_register_closes c on c.business_date = dr.business_date and c.station = dr.drawer
  )
  select jsonb_agg(jsonb_build_object(
           'business_date', to_char(o.business_date, 'YYYY-MM-DD'),
           'drawer', o.drawer,
           'stations', (select jsonb_agg(s order by k)
                          from unnest(array['tee_sheet', 'pro_shop', 'snack_bar', 'simulator']) with ordinality as t(s, k)
                         where public.pelham_register_drawer(o.business_date, s) = o.drawer),
           'closed', o.close_id is not null,
           'closed_at', public.pelham_iso(o.closed_at),
           'closed_by', o.closed_by,
           'note', o.note,
           -- 현금을 못 보는 계정에는 현금이 달라졌다는 사실도 알리지 않는다 — 나머지 수단만 비교한다.
           'stale', o.close_id is not null and
                    case when v_cash then o.snap is distinct from o.now
                         else (o.snap - 'cash') is distinct from (o.now - 'cash') end,
           'has_sales', o.has_sales,
           'lines', (
             select jsonb_agg(jsonb_build_object(
                      'method', m.method,
                      'countable', m.method in ('cash', 'card', 'debit'),
                      'expected', coalesce((o.snap->>m.method)::integer, (o.now->>m.method)::integer),
                      'now', (o.now->>m.method)::integer,
                      'counted', case when o.close_id is not null and m.method in ('cash', 'card', 'debit')
                                      then (o.counted->>m.method)::integer end,
                      'diff', case when o.close_id is not null and m.method in ('cash', 'card', 'debit')
                                   then (o.counted->>m.method)::integer - (o.snap->>m.method)::integer end
                    ) order by m.ord)
               from unnest(public.pelham_register_methods()) with ordinality as m(method, ord)
              where v_cash or m.method <> 'cash'
           )
         ) order by o.business_date desc, o.drawer)
    into v_rows
    from one o
   where o.close_id is not null or o.has_sales;

  return jsonb_build_object(
    'from', to_char(p_from, 'YYYY-MM-DD'),
    'to', to_char(p_to, 'YYYY-MM-DD'),
    'cash', v_cash,
    'rows', coalesce(v_rows, '[]'::jsonb)
  );
end;
$$;

revoke all on function public.pelham_staff_register_close_history(date, date) from public, anon, authenticated;
grant execute on function public.pelham_staff_register_close_history(date, date) to authenticated;

notify pgrst, 'reload schema';
