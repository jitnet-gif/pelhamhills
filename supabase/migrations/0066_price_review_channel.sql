-- Price review 줄에 예약이 들어온 경로를 붙인다 — GolfNow 로 온 예약, Chronogolf 에서 옮겨 온 예약.
--
-- 왜(2026-10-21): Daily close 의 Price review 에서 요금표보다 싸게 받은 줄 중 상당수는 GolfNow(선결제·할인가)나
-- Chronogolf 시절 예약이라 차액이 정상이다. 그런데 화면에서는 직원이 할인해 준 줄과 구별이 안 됐다.
--
-- `channel` 판정(예약 하나 단위):
--   golfnow    = 선수 요금제에 "GolfNow"/"Golf Now" 가 있거나, Chronogolf 가져오기 기록(notes 의
--                Import provenance)의 reservationSource 가 GolfNow 인 예약.
--   chronogolf = id 가 `chronogolf-` 로 시작하는 예약(0055 이전 Chronogolf 스냅샷·CSV 가져오기)이면서 GolfNow 가 아닌 것.
--   ''         = 우리 시스템에서 만든 예약.
-- `channelDetail` = 가져오기 기록의 reservationSource(있으면) — 화면에 작게 보인다.
--
-- 0055 `pelham_staff_price_review` 본문 그대로 + 위 두 필드만. 전제: 0055.
-- 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다. **0055 를 다시 실행하면 이 파일도 다시 실행.**

do $$
begin
  if to_regprocedure('public.pelham_staff_price_review(date, date)') is null then
    raise exception '0066 needs 0055 first (pelham_staff_price_review is missing).';
  end if;
end;
$$;

create or replace function public.pelham_staff_price_review(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.pelham_require_staff();
  if p_from is null or p_to is null or p_to < p_from then
    perform public.pelham_fail('422', 'Give a date range.');
  end if;
  if p_to - p_from > 62 then
    perform public.pelham_fail('422', 'Pick 62 days or fewer.');
  end if;

  return coalesce((
    with lines as (
      select t.id as booking_id,
             t.booking_date as play_date,
             coalesce(t.doc->>'time', '') as tee_time,
             public.pelham_tee_minutes(t.doc->>'time') as minutes,
             coalesce(t.doc->>'title', '') as title,
             coalesce(t.doc->>'confirmationCode', '') as code,
             case when coalesce(nullif(t.doc->>'holes', '')::integer, 18) = 9 then 9 else 18 end as holes,
             pl.value as player,
             public.pelham_tee_standard_green_fee(t.doc, pl.value) as green_standard,
             round(coalesce(case when jsonb_typeof(pl.value->'greenFee') = 'number'
                                 then (pl.value->>'greenFee')::numeric end,
                            (t.doc->>'rate')::numeric, 0), 2) as green_charged,
             case when coalesce((pl.value->>'cart')::boolean, false)
                  then round(public.pelham_tee_cart_fee_on(pl.value->>'ratePlan',
                         case when coalesce(nullif(t.doc->>'holes', '')::integer, 18) = 9 then 9 else 18 end,
                         t.booking_date), 2)
                  else 0 end as cart_standard,
             case when coalesce((pl.value->>'cart')::boolean, false)
                  then round(coalesce((pl.value->>'cartFee')::numeric, 0), 2) else 0 end as cart_charged,
             coalesce(substring(coalesce(t.doc->>'notes', '') from '"reservationSource": "([^"]*)"'), '') as import_source,
             exists (select 1 from jsonb_array_elements(
                       case when jsonb_typeof(t.doc->'players') = 'array' then t.doc->'players' else '[]'::jsonb end) p
                      where lower(coalesce(p.value->>'ratePlan', '')) ~ 'golf ?now') as golfnow_plan,
             t.id like 'chronogolf-%' as from_chronogolf
        from public.pelham_tee_bookings t
        cross join lateral jsonb_array_elements(
          case when jsonb_typeof(t.doc->'players') = 'array' then t.doc->'players' else '[]'::jsonb end) as pl(value)
       where t.booking_date between p_from and p_to
         and coalesce(t.status, '') not in ('cancelled', 'blocked')
         and not coalesce((pl.value->>'cancelled')::boolean, false)
    ),
    flagged as (
      select l.*,
             o.manager_name as ovr_manager, o.reason as ovr_reason, o.created_at as ovr_at,
             ap.manager_name as gate_manager, ap.created_at as gate_at
        from lines l
        left join public.pelham_tee_price_overrides o
          on o.booking_id = l.booking_id and o.player_id = l.player->>'id' and o.cleared_at is null
        left join lateral (
          select m.name as manager_name, a.created_at
            from public.pelham_manager_approvals a
            left join public.pelham_managers m on m.id = a.manager_id
           where a.ok and a.action = 'price' and a.ref = l.booking_id
           order by a.created_at desc
           limit 1
        ) ap on true
       where not public.pelham_same_money(l.green_standard, l.green_charged)
          or not public.pelham_same_money(l.cart_standard, l.cart_charged)
    )
    select jsonb_agg(jsonb_build_object(
             'bookingId', f.booking_id,
             'date', f.play_date,
             'time', f.tee_time,
             'title', f.title,
             'code', f.code,
             'holes', f.holes,
             'playerId', f.player->>'id',
             'player', coalesce(nullif(btrim(f.player->>'name'), ''), 'Guest'),
             'ratePlan', coalesce(f.player->>'ratePlan', ''),
             'paid', coalesce((f.player->>'paid')::boolean, false),
             'greenStandard', f.green_standard,
             'greenCharged', f.green_charged,
             'cartStandard', f.cart_standard,
             'cartCharged', f.cart_charged,
             'difference', round((f.green_charged + f.cart_charged) - (f.green_standard + f.cart_standard), 2),
             'kind', case when f.ovr_reason is not null then 'player'
                          when not public.pelham_same_money(f.green_standard, f.green_charged) then 'reservation'
                          else 'cart' end,
             'reason', coalesce(f.ovr_reason, ''),
             'manager', coalesce(f.ovr_manager, f.gate_manager, ''),
             'approvedAt', public.pelham_iso(coalesce(f.ovr_at, f.gate_at)),
             'channel', case when f.golfnow_plan or lower(f.import_source) ~ 'golf ?now' then 'golfnow'
                             when f.from_chronogolf then 'chronogolf'
                             else '' end,
             'channelDetail', f.import_source
           ) order by f.play_date, f.minutes, f.booking_id, f.player->>'id')
      from flagged f
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.pelham_staff_price_review(date, date) from public, anon, authenticated;
grant execute on function public.pelham_staff_price_review(date, date) to authenticated;

notify pgrst, 'reload schema';
