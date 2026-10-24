-- 계산대 마감은 현금만 — 캐셔에게 카드 매출을 보이지 않는다.
--
-- 왜(2026-10-23 클럽 결정): 캐셔의 마감은 현금 서랍을 세서 시작 잔돈만 남기고 넘기는 일이다(0046 블라인드 카운트).
-- 그런데 마감 표에는 Credit Card·Debit Card 줄의 Payments·Total Remaining·과부족이 그대로 보여, 캐셔가 카드 매출을
-- 알 수 있었다. 카드·체크카드는 현금 리포트 계정(매니저)이 Stripe 화면·Daily close 에서 맞춘다.
--
-- 바뀌는 것(현금 리포트 계정이 아닐 때만 — 매니저는 그대로 다 본다)
-- 1. `pelham_staff_register_close_report`(0081) — rows 는 현금 줄 하나(기대 금액은 0046 처럼 null), totals 는 없다.
--    close 의 expected 는 비우고 counted 는 현금만.
-- 2. `pelham_staff_register_close_save`(0081) — 캐셔가 저장해도 카드·체크카드 센 값은 바뀌지 않는다.
--    매니저가 이미 세어 둔 값이 있으면 그대로, 없으면 "안 셈"(키 없음)으로 남는다 — 0 으로 적으면 short 로 보인다.
--
-- **0081 을 다시 실행하면 1·2 가 옛 모양으로 돌아간다** — 그 뒤엔 이 파일을 다시 실행하면 된다.
--
-- 전제: 0046, 0062, 0081. 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다.

do $$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'pelham_register_closes'
                    and column_name = 'cashier') then
    raise exception '0090 needs 0081 first (pelham_register_closes.cashier is missing).';
  end if;
end;
$$;

-- ===== 저장 (0081 + 카드 칸 지키기) ========================================

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
  v_cards jsonb;
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

  -- 0090: 캐셔는 카드를 세지 않는다. 저장 전의 카드·체크카드 센 값(있는 키만)을 들고 있다가 되돌린다.
  if not public.pelham_is_cash_viewer() then
    select coalesce(jsonb_strip_nulls(jsonb_build_object('card', c.counted->'card', 'debit', c.counted->'debit')), '{}'::jsonb)
      into v_cards
      from public.pelham_register_closes c
     where c.business_date = p_date and c.station = v_drawer;
    v_cards := coalesce(v_cards, '{}'::jsonb);
  end if;

  perform public.pelham_staff_register_close_save_base(p_date, v_drawer, p);

  update public.pelham_register_closes c
     set cashier = case when p ? 'cashier' then v_cashier else c.cashier end,
         shift_start = case when p ? 'shift_start' then (p->>'shift_start')::time else c.shift_start end,
         shift_end = case when p ? 'shift_end' then (p->>'shift_end')::time else c.shift_end end,
         counted = case when v_cards is null then c.counted else (c.counted - 'card' - 'debit') || v_cards end
   where c.business_date = p_date and c.station = v_drawer;

  return public.pelham_staff_register_close_report(p_date, p_station);
end;
$$;

-- ===== 마감 표 (0081 + 캐셔는 현금 줄만) ====================================

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
  -- 0090: 현금 줄 하나만, 기대 금액 없이(0046). 다른 결제수단은 줄째 뺀다 — 합계도 보내지 않는다.
  return (v_report - 'totals') || jsonb_build_object(
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

-- ===== 권한 ============================================================

revoke all on function public.pelham_staff_register_close_save(date, text, jsonb) from public, anon, authenticated;
revoke all on function public.pelham_staff_register_close_report(date, text) from public, anon, authenticated;
grant execute on function public.pelham_staff_register_close_save(date, text, jsonb) to authenticated;
grant execute on function public.pelham_staff_register_close_report(date, text) to authenticated;

notify pgrst, 'reload schema';
