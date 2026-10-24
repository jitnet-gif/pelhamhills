-- AI Manager Marketing Strategies — 회원별 라운드 수.
--
-- 왜(2026-10-24): 클럽이 회원마다 총 라운드 수를 보자고 했다 — 많이 치는 회원, 거의 안 오는 회원을
-- 한눈에 보고 재가입·이벤트 대상을 고르려고.
--
-- 회원: 이 시즌(기간 끝 날의 해)의 active 회원권(pelham_memberships, 0040).
-- 라운드: 0094 와 같은 규칙 — pelham_tee_bookings 의 doc.players 중 취소된 예약·선수, 음성 홀드, 노쇼는 뺀다.
--         선수의 customerRef 가 회원권의 customer_ref 와 같을 때만 그 회원의 라운드다.
--   rounds         고른 기간(양 끝 포함)
--   season_rounds  시즌 1월 1일 ~ 오늘(미래 예약은 아직 안 친 라운드라 뺀다)
--   last_played    가장 최근에 친 날
--   no_shows       고른 기간의 노쇼
-- 고객 명부와 연결되지 않은 회원권(customer_ref 비어 있음)은 linked=false 로 0 이 나온다.
-- unlinked_rounds: 고른 기간에 회원 요금(ratePlan member)으로 쳤는데 어느 회원권에도 연결되지 않은 라운드 수.
--
-- 보는 사람: 0094 와 같다(pelham_require_ai_marketing_viewer).
-- 전제: 0040, 0094. 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다.

do $$
begin
  if to_regprocedure('public.pelham_require_ai_marketing_viewer()') is null then
    raise exception '0097 needs 0094 first (pelham_require_ai_marketing_viewer is missing).';
  end if;
end;
$$;

create or replace function public.pelham_staff_ai_marketing_member_rounds(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_today  date := (now() at time zone 'America/Toronto')::date;
  v_season integer;
  v_start  date;
  v_end    date;
begin
  perform public.pelham_require_ai_marketing_viewer();
  if p_from is null or p_to is null or p_from > p_to then
    perform public.pelham_fail('400', 'Pick a start date on or before the end date.');
  end if;
  if p_to - p_from > 400 then
    perform public.pelham_fail('400', 'Pick a period of 400 days or less.');
  end if;

  v_season := extract(year from p_to)::integer;
  v_start := make_date(v_season, 1, 1);
  v_end := least(make_date(v_season, 12, 31), v_today);

  return (
    with m as (
      select id, customer_ref, member_name, membership_type, plan, member_number
        from public.pelham_memberships
       where status = 'active' and season = v_season
    ), pl as (
      select b.booking_date as d,
             nullif(btrim(p.value->>'customerRef'), '') as cref,
             public.pelham_ai_segment(p.value->>'ratePlan', b.doc->>'color') as seg,
             (coalesce(b.status, '') = 'no_show'
              or coalesce((p.value->>'no_show')::boolean, false)) as no_show
        from public.pelham_tee_bookings b
        cross join lateral jsonb_array_elements(
               case when jsonb_typeof(b.doc->'players') = 'array' then b.doc->'players' else '[]'::jsonb end) p
       where b.booking_date between least(p_from, v_start) and greatest(p_to, v_end)
         and coalesce(b.status, '') not in ('cancelled', 'blocked')
         and coalesce(b.source, '') <> 'voice_hold'
         and not coalesce((p.value->>'cancelled')::boolean, false)
    ), per as (
      select m.id,
             count(pl.d) filter (where not pl.no_show and pl.d between p_from and p_to) as rounds,
             count(pl.d) filter (where not pl.no_show and pl.d between v_start and v_end) as season_rounds,
             count(pl.d) filter (where pl.no_show and pl.d between p_from and p_to) as no_shows,
             max(pl.d) filter (where not pl.no_show and pl.d <= v_today) as last_played
        from m
        left join pl on pl.cref = m.customer_ref
       group by m.id
    )
    select jsonb_build_object(
      'season', v_season,
      'members', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'name', m.member_name,
                 'type', m.membership_type,
                 'plan', m.plan,
                 'member_number', m.member_number,
                 'linked', m.customer_ref is not null,
                 'rounds', per.rounds,
                 'season_rounds', per.season_rounds,
                 'no_shows', per.no_shows,
                 'last_played', to_char(per.last_played, 'YYYY-MM-DD'))
               order by per.rounds desc, per.season_rounds desc, lower(m.member_name))
          from m join per on per.id = m.id
      ), '[]'::jsonb),
      'unlinked_rounds', (
        select count(*) from pl
         where pl.seg = 'member' and not pl.no_show and pl.d between p_from and p_to
           and (pl.cref is null or not exists (select 1 from m where m.customer_ref = pl.cref))
      )
    )
  );
end;
$$;

revoke all on function public.pelham_staff_ai_marketing_member_rounds(date, date) from public, anon, authenticated;
grant execute on function public.pelham_staff_ai_marketing_member_rounds(date, date) to authenticated;

notify pgrst, 'reload schema';
