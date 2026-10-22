-- 계산대 마감에 담당자·근무 시작·끝 시각을 남긴다 — Close Register 화면.
--
-- 왜(2026-10-22): 마감(0023, 0062 부터 서랍 하나)에는 "누가 몇 시부터 몇 시까지 맡은 서랍인가" 가 없었다.
-- 닫은 사람은 공용 로그인 이메일(closed_by)뿐이라 사람을 가를 수 없었다. 클럽이 마감할 때 캐셔 번호(4자리)와
-- 시작·끝 시각을 넣고, 그 시간대 합계를 영수증 프린터로 뽑게 해 달라고 했다.
--
-- 바뀌는 것
-- 1. `pelham_register_closes` 에 cashier(이름), shift_start, shift_end(현지 시각) 칸.
--    캐셔 번호(Pelham Shift ID)는 화면이 이름으로 바꿔서 보낸다 — 번호는 로그인 비밀번호이기도 해서 저장하지 않는다
--    (계산서의 Cashier 칸과 같은 규칙, `lib/pos/cashierCode.ts`).
-- 2. `pelham_staff_register_close_save`(0062 의 감싸기) — p 에 {cashier, shift_start: 'HH:MM', shift_end: 'HH:MM'} 를
--    더 받는다. 키가 없으면(옛 화면) 건드리지 않는다. 끝이 시작보다 이르면 자정을 넘긴 근무다.
-- 3. `pelham_staff_register_close_report`(0062) — close 에 cashier·shift_start·shift_end 를 더한다.
-- 4. `pelham_staff_register_close_history`(0065) — 줄마다 cashier·shift_start·shift_end 를 더한다.
--
-- **0062 나 0065 를 다시 실행하면 2~4 가 옛 모양으로 돌아간다** — 그 뒤엔 이 파일을 다시 실행하면 된다.
--
-- 전제: 0023, 0046, 0062 (0065 는 이 파일이 대신한다 — 운영 DB 에 0065 가 안 돌아 있었다, 2026-10-22). 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다.

do $$
begin
  if to_regprocedure('public.pelham_staff_register_close_save_base(date, text, jsonb)') is null
     or to_regprocedure('public.pelham_register_drawer(date, text)') is null then
    raise exception '0081 needs 0062 first (pelham_staff_register_close_save_base / pelham_register_drawer is missing).';
  end if;
  -- 0065 는 없어도 된다 — 마감 기록 함수를 아래에서 통째로 정의한다(0065 + 담당자·시각).
  if to_regprocedure('public.pelham_is_cash_viewer()') is null then
    raise exception '0081 needs 0046 first (pelham_is_cash_viewer is missing).';
  end if;
end;
$$;

-- ===== 테이블 ==========================================================

alter table public.pelham_register_closes add column if not exists cashier text;
alter table public.pelham_register_closes add column if not exists shift_start time;
alter table public.pelham_register_closes add column if not exists shift_end time;

-- ===== 저장 ============================================================

create or replace function public.pelham_staff_register_close_save(p_date date, p_station text, p jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_drawer text := public.pelham_register_drawer(p_date, p_station);
  v_cashier text := nullif(regexp_replace(btrim(coalesce(p->>'cashier', '')), '\s+', ' ', 'g'), '');
begin
  p := coalesce(p, '{}'::jsonb);
  -- 먼저 확인한다. 기본 저장이 끝난 뒤에 거절하면 센 돈은 들어가고 담당자만 빠진 마감이 남는다.
  if p ? 'cashier' and (v_cashier is null or length(v_cashier) > 60) then
    perform public.pelham_fail('422', 'Enter the cashier (Pelham Shift ID or name).');
  end if;
  if p ? 'shift_start' and coalesce(p->>'shift_start', '') !~ '^([01]\d|2[0-3]):[0-5]\d$' then
    perform public.pelham_fail('422', 'Enter the shift start time.');
  end if;
  if p ? 'shift_end' and coalesce(p->>'shift_end', '') !~ '^([01]\d|2[0-3]):[0-5]\d$' then
    perform public.pelham_fail('422', 'Enter the shift end time.');
  end if;

  perform public.pelham_staff_register_close_save_base(p_date, v_drawer, p);

  update public.pelham_register_closes c
     set cashier = case when p ? 'cashier' then v_cashier else c.cashier end,
         shift_start = case when p ? 'shift_start' then (p->>'shift_start')::time else c.shift_start end,
         shift_end = case when p ? 'shift_end' then (p->>'shift_end')::time else c.shift_end end
   where c.business_date = p_date and c.station = v_drawer;

  return public.pelham_staff_register_close_report(p_date, p_station);
end;
$$;

-- ===== 마감 표 (0062 + 담당자·시각) =========================================

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
  -- 0081: 담당자와 근무 시각.
  if jsonb_typeof(v_report->'close') = 'object' then
    v_report := jsonb_set(v_report, '{close}', (v_report->'close') || (
      select jsonb_build_object('cashier', c.cashier,
                                'shift_start', to_char(c.shift_start, 'HH24:MI'),
                                'shift_end', to_char(c.shift_end, 'HH24:MI'))
        from public.pelham_register_closes c
       where c.business_date = p_date and c.station = v_drawer));
  end if;
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

-- ===== 마감 기록 (0065 + 담당자·시각) =======================================

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
           c.cashier, c.shift_start, c.shift_end,
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
           'cashier', o.cashier,
           'shift_start', to_char(o.shift_start, 'HH24:MI'),
           'shift_end', to_char(o.shift_end, 'HH24:MI'),
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

-- ===== 권한 ============================================================

revoke all on function public.pelham_staff_register_close_save(date, text, jsonb) from public, anon, authenticated;
revoke all on function public.pelham_staff_register_close_report(date, text) from public, anon, authenticated;
revoke all on function public.pelham_staff_register_close_history(date, date) from public, anon, authenticated;
grant execute on function public.pelham_staff_register_close_save(date, text, jsonb) to authenticated;
grant execute on function public.pelham_staff_register_close_report(date, text) to authenticated;
grant execute on function public.pelham_staff_register_close_history(date, date) to authenticated;

notify pgrst, 'reload schema';
