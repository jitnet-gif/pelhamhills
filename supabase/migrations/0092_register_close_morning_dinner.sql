-- 계산대 마감을 하루 두 번 — Morning(모닝) · Dinner(디너).
--
-- 왜(2026-10-24 클럽 요청): 서랍 하나(0062)를 모닝 캐셔와 디너 캐셔가 차례로 쓴다. 마감은 하루 한 줄이라
-- 모닝 캐셔가 넘긴 현금과 디너 캐셔가 넘긴 현금을 가를 수 없었다. 각 근무가 자기 시간의 현금을 세어
-- 시작 잔돈($200)만 남기고 넘긴다.
--
-- 규칙
-- - 한 줄 = (영업일, 서랍, 근무). 근무는 'morning' | 'dinner'. 옛 마감은 전부 'dinner' 가 된다.
-- - 경계 = 모닝 마감의 근무 끝 시각(shift_end, 그 분까지 모닝). 계산서는 결제 시각(paid_at)으로 가른다.
--     Morning = 경계 전, Dinner = 경계부터.
--   모닝 마감이 없으면 경계가 없다 — Dinner 가 하루 전체를 센다(0092 전과 같다, 서랍엔 하루 돈이 다 있다).
--   모닝을 다시 세며 끝 시각을 고치면 경계가 움직이고, 이미 센 디너는 Recount 로 뜬다.
-- - 근무마다 시작 잔돈 $200 — Total Remaining = $200 + 그 근무의 현금 결제.
-- - 블라인드 카운트(0046)·캐셔는 현금만(0090)은 그대로.
--
-- 바뀌는 것
-- 1. `pelham_register_closes.shift`, 유일 키 (business_date, station, shift).
-- 2. `pelham_register_cutoff` · `pelham_register_shift_expected` — 근무의 결제수단별 합.
-- 3. `pelham_staff_register_close_report(date, text, shift)` — 근무를 받는다(없으면 'dinner'). 0023·0046·0062·0081·0090 을
--    한 함수로 합쳤다. `window`(근무의 결제 시각 범위)와 `shifts`(두 근무의 마감 여부·담당자)를 더한다.
-- 4. `pelham_staff_register_close_save` — p.shift. 없으면(옛 화면) 'dinner'.
-- 5. `pelham_staff_register_close_history` — 근무마다 한 줄(모닝은 마감했을 때만), shift·window 를 더한다.
-- 6. `pelham_staff_cash_reconcile` — 계산대 줄이 근무마다. 센 현금(잔돈 뺀 값)을 근무별로 더한다.
--
-- **0023·0046·0062·0065·0081·0090 을 다시 실행하면 3~6 이 옛 모양(하루 한 마감)으로 돌아간다** — 그 뒤엔 이 파일을 다시 실행.
--
-- 전제: 0062, 0081, 0085, 0090. 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다.

do $$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'pelham_register_closes'
                    and column_name = 'cashier') then
    raise exception '0092 needs 0081 first (pelham_register_closes.cashier is missing).';
  end if;
  if to_regprocedure('public.pelham_register_drawer(date, text)') is null
     or to_regprocedure('public.pelham_is_cash_viewer()') is null then
    raise exception '0092 needs 0046 and 0062 first.';
  end if;
end;
$$;

-- ===== 테이블 ==========================================================

alter table public.pelham_register_closes add column if not exists shift text;
update public.pelham_register_closes set shift = 'dinner' where shift is null;
alter table public.pelham_register_closes alter column shift set default 'dinner';
alter table public.pelham_register_closes alter column shift set not null;

do $$
declare
  v_name text;
begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.pelham_register_closes'::regclass
                    and conname = 'pelham_register_closes_shift_check') then
    alter table public.pelham_register_closes
      add constraint pelham_register_closes_shift_check check (shift in ('morning', 'dinner'));
  end if;
  -- 0023 의 (business_date, station) 유일 키를 근무까지 넓힌다.
  for v_name in
    select c.conname from pg_constraint c
     where c.conrelid = 'public.pelham_register_closes'::regclass and c.contype = 'u'
       and (select array_agg(a.attname::text order by a.attname)
              from pg_attribute a
             where a.attrelid = c.conrelid and a.attnum = any (c.conkey)) = array['business_date', 'station']
  loop
    execute format('alter table public.pelham_register_closes drop constraint %I', v_name);
  end loop;
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.pelham_register_closes'::regclass
                    and conname = 'pelham_register_closes_day_shift_key') then
    alter table public.pelham_register_closes
      add constraint pelham_register_closes_day_shift_key unique (business_date, station, shift);
  end if;
end;
$$;

-- ===== 근무 경계 ========================================================

-- 모닝이 끝나는 순간(그 분 끝). 모닝 마감이 없으면 null — 경계가 없다.
create or replace function public.pelham_register_cutoff(p_date date, p_drawer text)
returns timestamptz
language sql
stable
set search_path = ''
as $$
  select ((p_date + c.shift_end) + interval '1 minute') at time zone 'America/Toronto'
    from public.pelham_register_closes c
   where c.business_date = p_date and c.station = p_drawer and c.shift = 'morning' and c.shift_end is not null
$$;

-- 한 근무의 결제수단별 결제(amount + tip). `pelham_register_expected`(0062)를 결제 시각으로 자른 것.
create or replace function public.pelham_register_shift_expected(p_date date, p_station text, p_shift text)
returns table (method text, payments integer, payment_count integer)
language sql
stable
set search_path = ''
as $$
  with cut as (
    select public.pelham_register_cutoff(p_date, public.pelham_register_drawer(p_date, p_station)) as at
  )
  select m.method,
         coalesce(sum(pp.amount + pp.tip), 0)::integer,
         count(pp.id)::integer
    from unnest(public.pelham_register_methods()) as m(method)
    left join public.pelham_bill_payments pp
      on pp.method = m.method
     and pp.bill_id in (select b.id from public.pelham_bills b cross join cut
                         where b.business_date = p_date and b.status = 'paid'
                           and b.station in ('pro_shop', 'snack_bar', 'tee_sheet', 'simulator')
                           and public.pelham_register_drawer(p_date, b.station) = public.pelham_register_drawer(p_date, p_station)
                           and (cut.at is null
                                or (p_shift = 'morning' and coalesce(b.paid_at, b.opened_at) < cut.at)
                                or (p_shift = 'dinner' and coalesce(b.paid_at, b.opened_at) >= cut.at)))
   group by m.method
$$;

-- 근무의 결제 시각 범위 {from, to}(ISO, null = 끝 없음). 화면이 같은 범위로 계산서를 거른다.
create or replace function public.pelham_register_shift_window(p_date date, p_drawer text, p_shift text)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
           'from', case when p_shift = 'dinner' then public.pelham_iso(x.at) end,
           'to', case when p_shift = 'morning' then public.pelham_iso(x.at) end)
    from (select public.pelham_register_cutoff(p_date, p_drawer) as at) x
$$;

-- ===== 마감 표 ===========================================================

drop function if exists public.pelham_staff_register_close_report(date, text);

create or replace function public.pelham_staff_register_close_report(p_date date, p_station text, p_shift text default 'dinner')
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_shift text := coalesce(nullif(btrim(p_shift), ''), 'dinner');
  v_drawer text;
  v_float integer;
  v_close public.pelham_register_closes%rowtype;
  v_rows jsonb;
  v_now jsonb;
  v_report jsonb;
begin
  perform public.pelham_require_staff();
  if p_date is null then
    perform public.pelham_fail('422', '''date'' must be an ISO date (YYYY-MM-DD)');
  end if;
  if p_station is null or p_station not in ('pro_shop', 'snack_bar', 'tee_sheet', 'simulator') then
    perform public.pelham_fail('422', format('''%s'' is not a register', p_station));
  end if;
  if v_shift not in ('morning', 'dinner') then
    perform public.pelham_fail('422', 'Pick the Morning or Dinner shift.');
  end if;
  v_drawer := public.pelham_register_drawer(p_date, p_station);
  v_float := public.pelham_register_float(v_drawer);

  select * into v_close from public.pelham_register_closes
   where business_date = p_date and station = v_drawer and shift = v_shift;

  select jsonb_agg(jsonb_build_object(
           'method', e.method,
           'countable', e.method in ('cash', 'card', 'debit'),
           'start', case when e.method = 'cash' then v_float else 0 end,
           'payments', e.payments,
           'payment_count', e.payment_count,
           'withdraws', 0,
           'remaining', e.payments + case when e.method = 'cash' then v_float else 0 end,
           'counted', case when v_close.id is null then null else (v_close.counted->>e.method)::integer end
         ) order by array_position(public.pelham_register_methods(), e.method)),
         jsonb_object_agg(e.method, e.payments + case when e.method = 'cash' then v_float else 0 end)
    into v_rows, v_now
    from public.pelham_register_shift_expected(p_date, v_drawer, v_shift) e;

  v_report := jsonb_build_object(
    'business_date', to_char(p_date, 'YYYY-MM-DD'),
    'station', v_drawer,
    'shift', v_shift,
    'window', public.pelham_register_shift_window(p_date, v_drawer, v_shift),
    'shifts', (
      select jsonb_agg(jsonb_build_object(
               'shift', s.shift,
               'closed', c.id is not null,
               'cashier', c.cashier,
               'shift_start', to_char(c.shift_start, 'HH24:MI'),
               'shift_end', to_char(c.shift_end, 'HH24:MI'),
               'closed_at', public.pelham_iso(c.closed_at)
             ) order by s.ord)
        from (values ('morning', 1), ('dinner', 2)) as s(shift, ord)
        left join public.pelham_register_closes c
          on c.business_date = p_date and c.station = v_drawer and c.shift = s.shift),
    'stations', (select jsonb_agg(s order by o)
                   from unnest(array['tee_sheet', 'pro_shop', 'snack_bar', 'simulator']) with ordinality as t(s, o)
                  where public.pelham_register_drawer(p_date, s) = v_drawer),
    'open_bills', case when p_date = public.pelham_pos_today() then (
        select count(*)::integer from public.pelham_bills b
         where b.status = 'open'
           and b.station in ('pro_shop', 'snack_bar', 'tee_sheet', 'simulator')
           and public.pelham_register_drawer(p_date, b.station) = v_drawer
           and exists (select 1 from public.pelham_bill_lines li where li.bill_id = b.id and li.active))
      else 0 end,
    'rows', coalesce(v_rows, '[]'::jsonb),
    'close', case when v_close.id is null then null else jsonb_build_object(
      'opening_float', v_close.opening_float,
      'expected', v_close.expected,
      'counted', v_close.counted,
      'cash_counts', v_close.cash_counts,
      'note', v_close.note,
      'closed_at', public.pelham_iso(v_close.closed_at),
      'cashier', v_close.cashier,
      'shift_start', to_char(v_close.shift_start, 'HH24:MI'),
      'shift_end', to_char(v_close.shift_end, 'HH24:MI'),
      'stale', v_close.expected is distinct from v_now
    ) end
  );

  if public.pelham_is_cash_viewer() then
    return v_report;
  end if;
  -- 0090: 현금 줄 하나만, 기대 금액 없이(0046).
  return v_report || jsonb_build_object(
    'rows', coalesce((
      select jsonb_agg(e.value || jsonb_build_object('payments', null, 'payment_count', null, 'remaining', null))
        from jsonb_array_elements(v_report->'rows') e(value)
       where e.value->>'method' = 'cash'
    ), '[]'::jsonb),
    'close', case when jsonb_typeof(v_report->'close') = 'object'
                  then (v_report->'close') || jsonb_build_object(
                         'expected', '{}'::jsonb,
                         'counted', jsonb_strip_nulls(jsonb_build_object('cash', v_report->'close'->'counted'->'cash')))
                  else v_report->'close' end,
    'cash_blind', true,
    'cash_only', true
  );
end;
$$;

-- ===== 저장 ============================================================

-- p: {shift, counted: {cash, card?, debit?}, cash_counts, note?, cashier?, shift_start?, shift_end?}
create or replace function public.pelham_staff_register_close_save(p_date date, p_station text, p jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_shift text;
  v_drawer text;
  v_float integer;
  v_cashier text;
  v_prev public.pelham_register_closes%rowtype;
  v_counted jsonb := '{}'::jsonb;
  v_counts jsonb := '{}'::jsonb;
  v_expected jsonb;
  v_method text;
  v_key text;
  v_value integer;
begin
  perform public.pelham_require_staff();
  p := coalesce(p, '{}'::jsonb);
  v_shift := coalesce(nullif(btrim(p->>'shift'), ''), 'dinner');
  v_cashier := nullif(regexp_replace(btrim(coalesce(p->>'cashier', '')), '\s+', ' ', 'g'), '');
  if p_date is null then
    perform public.pelham_fail('422', '''date'' must be an ISO date (YYYY-MM-DD)');
  end if;
  if p_date > public.pelham_pos_today() then
    perform public.pelham_fail('422', 'You cannot close a register for a day that has not started.');
  end if;
  if p_station is null or p_station not in ('pro_shop', 'snack_bar', 'tee_sheet', 'simulator') then
    perform public.pelham_fail('422', format('''%s'' is not a register', p_station));
  end if;
  if v_shift not in ('morning', 'dinner') then
    perform public.pelham_fail('422', 'Pick the Morning or Dinner shift.');
  end if;
  if p ? 'cashier' and (v_cashier is null or length(v_cashier) > 60) then
    perform public.pelham_fail('422', 'Enter the cashier (Pelham Shift ID or name).');
  end if;
  if p ? 'shift_start' and coalesce(p->>'shift_start', '') !~ '^([01]\d|2[0-3]):[0-5]\d$' then
    perform public.pelham_fail('422', 'Enter the shift start time.');
  end if;
  if p ? 'shift_end' and coalesce(p->>'shift_end', '') !~ '^([01]\d|2[0-3]):[0-5]\d$' then
    perform public.pelham_fail('422', 'Enter the shift end time.');
  end if;

  v_drawer := public.pelham_register_drawer(p_date, p_station);
  v_float := public.pelham_register_float(v_drawer);
  select * into v_prev from public.pelham_register_closes
   where business_date = p_date and station = v_drawer and shift = v_shift;

  -- 모닝의 끝 시각이 디너와의 경계다 — 없으면 나눌 수 없다.
  if v_shift = 'morning' and not (p ? 'shift_end') and v_prev.shift_end is null then
    perform public.pelham_fail('422', 'Enter the shift end time — it splits Morning from Dinner.');
  end if;

  foreach v_method in array array['cash', 'card', 'debit'] loop
    begin
      v_value := coalesce(nullif(p->'counted'->>v_method, '')::integer, 0);
    exception when others then
      perform public.pelham_fail('422', 'Counts must be whole numbers of cents.');
    end;
    if v_value < 0 then
      perform public.pelham_fail('422', 'Counts cannot be negative.');
    end if;
    v_counted := v_counted || jsonb_build_object(v_method, v_value);
  end loop;
  -- 0090: 캐셔는 카드를 세지 않는다 — 매니저가 세어 둔 값은 그대로, 없으면 "안 셈"(키 없음).
  if not public.pelham_is_cash_viewer() then
    v_counted := jsonb_build_object('cash', v_counted->'cash')
                 || coalesce(jsonb_strip_nulls(jsonb_build_object('card', v_prev.counted->'card',
                                                                  'debit', v_prev.counted->'debit')), '{}'::jsonb);
  end if;

  foreach v_key in array array['10000', '5000', '2000', '1000', '500', '200', '100', '25', '10', '5', '1', 'extra'] loop
    begin
      v_value := coalesce(nullif(p->'cash_counts'->>v_key, '')::integer, 0);
    exception when others then
      perform public.pelham_fail('422', 'Cash counts must be whole numbers.');
    end;
    if v_value < 0 then
      perform public.pelham_fail('422', 'Cash counts cannot be negative.');
    end if;
    v_counts := v_counts || jsonb_build_object(v_key, v_value);
  end loop;

  -- 근무 시각을 먼저 적는다 — 모닝의 끝 시각이 바로 아래 기대 금액의 경계다.
  insert into public.pelham_register_closes as c
    (business_date, station, shift, opening_float, expected, counted, cash_counts, note, closed_by, closed_at,
     cashier, shift_start, shift_end)
  values (p_date, v_drawer, v_shift, v_float, '{}'::jsonb, v_counted, v_counts,
          nullif(btrim(coalesce(p->>'note', '')), ''), auth.uid(), now(),
          v_cashier, (p->>'shift_start')::time, (p->>'shift_end')::time)
  on conflict (business_date, station, shift) do update
    set opening_float = excluded.opening_float, counted = excluded.counted, cash_counts = excluded.cash_counts,
        note = excluded.note, closed_by = excluded.closed_by, closed_at = excluded.closed_at,
        cashier = case when p ? 'cashier' then excluded.cashier else c.cashier end,
        shift_start = case when p ? 'shift_start' then excluded.shift_start else c.shift_start end,
        shift_end = case when p ? 'shift_end' then excluded.shift_end else c.shift_end end;

  select jsonb_object_agg(e.method, e.payments + case when e.method = 'cash' then v_float else 0 end)
    into v_expected
    from public.pelham_register_shift_expected(p_date, v_drawer, v_shift) e;

  update public.pelham_register_closes
     set expected = v_expected
   where business_date = p_date and station = v_drawer and shift = v_shift;

  return public.pelham_staff_register_close_report(p_date, p_station, v_shift);
end;
$$;

-- ===== 마감 기록 (0081 + 근무) ==============================================

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
  ), sh as (
    select dr.business_date, dr.drawer, s.shift, s.ord
      from dr
     cross join (values ('morning', 1), ('dinner', 2)) as s(shift, ord)
  ), cur as (
    select sh.business_date, sh.drawer, sh.shift, e.method, e.payments,
           e.payments + case when e.method = 'cash' then public.pelham_register_float(sh.drawer) else 0 end as remaining
      from sh
     cross join lateral public.pelham_register_shift_expected(sh.business_date, sh.drawer, sh.shift) e
  ), one as (
    select sh.business_date, sh.drawer, sh.shift, sh.ord, c.id as close_id, c.expected as snap, c.counted, c.note,
           c.closed_at, c.cashier, c.shift_start, c.shift_end,
           (select u.email from auth.users u where u.id = c.closed_by) as closed_by,
           (select jsonb_object_agg(x.method, x.remaining) from cur x
             where x.business_date = sh.business_date and x.drawer = sh.drawer and x.shift = sh.shift) as now,
           exists (select 1 from cur x
                    where x.business_date = sh.business_date and x.drawer = sh.drawer and x.shift = sh.shift
                      and x.payments <> 0) as has_sales
      from sh
      left join public.pelham_register_closes c
        on c.business_date = sh.business_date and c.station = sh.drawer and c.shift = sh.shift
  )
  select jsonb_agg(jsonb_build_object(
           'business_date', to_char(o.business_date, 'YYYY-MM-DD'),
           'drawer', o.drawer,
           'shift', o.shift,
           'window', public.pelham_register_shift_window(o.business_date, o.drawer, o.shift),
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
         ) order by o.business_date desc, o.drawer, o.ord)
    into v_rows
    from one o
   -- 모닝은 마감했을 때만 줄이 있다. 모닝 마감이 없으면 디너가 하루 전체다.
   where o.close_id is not null or (o.shift = 'dinner' and o.has_sales);

  return jsonb_build_object(
    'from', to_char(p_from, 'YYYY-MM-DD'),
    'to', to_char(p_to, 'YYYY-MM-DD'),
    'cash', v_cash,
    'rows', coalesce(v_rows, '[]'::jsonb)
  );
end;
$$;

-- ===== 대사표 (0062 + 근무) ===============================================

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

  -- 계산대 줄 = 서랍 × 근무. 모닝은 마감했을 때만(아니면 디너가 하루 전체를 센다).
  with st as (
    select s.station, s.ord, sh.shift, sh.sord, c.id is not null as closed, c.opening_float, c.counted, c.expected as snap,
           (select jsonb_object_agg(e.method, e.payments)
              from public.pelham_register_shift_expected(p_date, s.station, sh.shift) e) as pay
      from unnest(array['pro_shop', 'snack_bar', 'tee_sheet', 'simulator']) with ordinality as s(station, ord)
     cross join (values ('morning', 1), ('dinner', 2)) as sh(shift, sord)
      left join public.pelham_register_closes c
        on c.business_date = p_date and c.station = s.station and c.shift = sh.shift
     where public.pelham_register_drawer(p_date, s.station) = s.station
       and (sh.shift = 'dinner' or c.id is not null)
  )
  select jsonb_agg(jsonb_build_object(
           'station', st.station,
           'shift', st.shift,
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
         ) order by st.ord, st.sord)
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
    'registers', coalesce(v_regs, '[]'::jsonb),
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
            from jsonb_array_elements(coalesce(v_regs, '[]'::jsonb)) e
        ) g
    )
  );
end;
$$;

-- ===== 권한 ============================================================

revoke all on function public.pelham_register_cutoff(date, text) from public, anon, authenticated;
revoke all on function public.pelham_register_shift_expected(date, text, text) from public, anon, authenticated;
revoke all on function public.pelham_register_shift_window(date, text, text) from public, anon, authenticated;
revoke all on function public.pelham_staff_register_close_report(date, text, text) from public, anon, authenticated;
revoke all on function public.pelham_staff_register_close_save(date, text, jsonb) from public, anon, authenticated;
revoke all on function public.pelham_staff_register_close_history(date, date) from public, anon, authenticated;
revoke all on function public.pelham_staff_cash_reconcile(date) from public, anon, authenticated;

grant execute on function public.pelham_staff_register_close_report(date, text, text) to authenticated;
grant execute on function public.pelham_staff_register_close_save(date, text, jsonb) to authenticated;
grant execute on function public.pelham_staff_register_close_history(date, date) to authenticated;
grant execute on function public.pelham_staff_cash_reconcile(date) to authenticated;

notify pgrst, 'reload schema';

-- ===== 확인 ============================================================

-- 오늘 서랍의 두 근무 — 모닝을 닫기 전엔 모닝 줄이 없고 디너가 하루 전체다.
select c.shift, c.cashier, c.shift_start, c.shift_end, c.counted->'cash' as counted_cash, c.closed_at
  from public.pelham_register_closes c
 where c.business_date = public.pelham_pos_today()
 order by c.shift;
