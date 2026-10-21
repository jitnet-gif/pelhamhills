-- 레인체크 리포트(`/admin/reports?view=rainchecks`) + 만료 기본값 180일 다시 확인.
--
-- 왜(2026-10-21): 발행한 레인체크를 한곳에서 보고 싶다 — 누구에게 얼마를, 언제까지, 썼는지·남았는지,
-- 문자(바코드)가 나갔는지. 지금은 예약마다 플레이어 카드를 열어야만 보인다.
--
--   pelham_staff_rain_check_report(p_from, p_to)  — 발행일이 기간 안인 레인체크 전부(무효 포함) + 합계.
--     각 줄은 0011 `pelham_rc_json` 그대로에 문자 기록(0058 `pelham_sms_messages`, template = 'rain_check')을 붙인다.
--     `outstanding` 은 기간과 상관없이 지금 살아 있는(발행됨·안 지난) 크레딧 전체 — 클럽이 갚아야 할 돈.
--
-- 만료 기본값: 0044 와 같은 정의(발행일 + 180일)를 여기서도 한 번 더 건다. 0044 를 빠뜨린 프로젝트에서도
-- 이 파일 하나로 180일이 되게. 이미 발행한 레인체크의 만료일은 그대로다.
--
-- 0058(문자 기록)이 없는 프로젝트에서도 돌아간다 — 그때는 문자 열이 비어 있고, 0058 을 실행하면 그때부터 채워진다.
--
-- 전제: 0011(레인체크). 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다.

do $$
begin
  if to_regclass('public.pelham_rain_checks') is null then
    raise exception '0062 needs 0011 first (pelham_rain_checks is missing).';
  end if;
  if to_regclass('public.pelham_sms_messages') is not null then
    create index if not exists pelham_sms_messages_ref_idx
      on public.pelham_sms_messages (booking_ref, created_at desc) where template = 'rain_check';
  end if;
end;
$$;

create or replace function public.pelham_rc_default_expiry(p_issued date)
returns date
language sql
immutable
set search_path = ''
as $$
  select p_issued + 180
$$;

create index if not exists pelham_rain_checks_issued_on_idx on public.pelham_rain_checks (issued_on);

create or replace function public.pelham_staff_rain_check_report(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_today date := public.pelham_pos_today();
  v_rows jsonb;
begin
  perform public.pelham_require_staff();
  if p_from is null or p_to is null or p_to < p_from then
    perform public.pelham_fail('422', 'Pick a From date on or before the To date.');
  end if;
  if p_to - p_from > 400 then
    perform public.pelham_fail('422', 'Pick 400 days or fewer.');
  end if;

  -- 문자 기록 표(0058)는 없을 수도 있다. 있으면 붙이고, 없으면 문자 열은 비운다(동적 SQL — 함수를 만들 때
  -- 표가 없어도 되게).
  execute format($q$
    select coalesce(jsonb_agg(
             public.pelham_rc_json(r) || jsonb_build_object(
               'texted_to', s.to_phone,
               'texted_at', public.pelham_iso(s.created_at),
               'text_status', s.status,
               'text_count', coalesce(s.sent, 0)
             ) order by r.issued_at desc, r.id desc), '[]'::jsonb)
      from public.pelham_rain_checks r
      left join lateral (%s) s on true
     where r.issued_on between $1 and $2
  $q$,
    case when to_regclass('public.pelham_sms_messages') is not null then $l$
      select m.to_phone, m.created_at, m.status, count(*) over () as sent
        from public.pelham_sms_messages m
       where m.template = 'rain_check' and m.direction = 'out' and m.booking_ref = r.code
       order by m.created_at desc
       limit 1
    $l$ else $l$
      select null::text as to_phone, null::timestamptz as created_at, null::text as status, 0::bigint as sent
    $l$ end)
    into v_rows
    using p_from, p_to;

  return jsonb_build_object(
    'from', to_char(p_from, 'YYYY-MM-DD'),
    'to', to_char(p_to, 'YYYY-MM-DD'),
    'today', to_char(v_today, 'YYYY-MM-DD'),
    'rows', v_rows,
    -- 기간과 상관없이 지금 쓸 수 있는 크레딧 전체.
    'outstanding', (
      select jsonb_build_object('count', count(*), 'amount', coalesce(sum(amount), 0))
        from public.pelham_rain_checks
       where status = 'issued' and expires_on >= v_today
    )
  );
end;
$$;

revoke all on function public.pelham_rc_default_expiry(date) from public, anon, authenticated;
revoke all on function public.pelham_staff_rain_check_report(date, date) from public, anon;
grant execute on function public.pelham_staff_rain_check_report(date, date) to authenticated;

notify pgrst, 'reload schema';
