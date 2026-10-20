-- 현금 리포트는 정해진 계정만 본다(2026-10-19 클럽 결정: Emmeline 혼자).
--
-- 왜: 프로 샵 계정이면 누구나 Reports 에서 그날 현금 합계·서랍에 있어야 할 현금·담당자별로 센 현금을
-- 볼 수 있었다. 이제 현금이 들어간 리포트는 `/admin/reports/cash/` 한 곳에서, 아래 명단의 계정만 본다.
-- 화면이 아니라 **서버**가 막는다 — 함수를 직접 불러도 현금 숫자는 나오지 않는다.
--
-- 바뀌는 것:
--   pelham_staff_pos_report_daily  — 명단 밖 계정에는 by_payment 에서 cash 줄을 뺀다(나머지는 그대로).
--   pelham_staff_closeout_report / _save / _reopen (0010 담당자별 마감·팁 나누기)
--                                  — 명단 밖 계정은 PT403 으로 거절한다. 마감 화면 전체가 현금 대사라서다.
--   pelham_staff_cash_access()     — 새 함수. 지금 계정이 현금 리포트를 볼 수 있는가(화면이 링크를 띄울지 정한다).
-- 바뀌지 않는 것: 계산대 마감(0023, 계산대 홈의 Close Register), 계산서 하나하나의 결제 수단.
--
-- 명단은 SQL editor 에서 바꾼다(화면이 없다). 계정은 Supabase Auth 의 이메일로 적는다:
--   insert into public.pelham_cash_viewers (email) values ('someone@example.com') on conflict do nothing;
--   delete from public.pelham_cash_viewers where email = 'someone@example.com';
--   select * from public.pelham_cash_viewers;
-- 명단에 있어도 직원(0004 의 pelham_is_staff)이어야 한다.
--
-- 구현: 0024·0026 과 같이 원래 함수를 `<이름>_base` 로 옮기고 같은 이름·같은 인자의 얇은 함수를 둔다.
-- **0005·0010 을 다시 실행하면 잠금이 풀린다** — 그 뒤엔 이 파일을 다시 실행하면 된다.
--
-- 전제: 0004, 0005, 0010. 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다.

do $$
begin
  if to_regprocedure('public.pelham_require_staff()') is null then
    raise exception '0046 needs 0004 first (pelham_require_staff is missing).';
  end if;
  if to_regprocedure('public.pelham_staff_pos_report_daily(date)') is null then
    raise exception '0046 needs 0005 first (pelham_staff_pos_report_daily is missing).';
  end if;
  if to_regprocedure('public.pelham_staff_closeout_report(date)') is null then
    raise exception '0046 needs 0010 first (pelham_staff_closeout_report is missing).';
  end if;
end;
$$;

-- ===== 명단 ============================================================

create table if not exists public.pelham_cash_viewers (
  email       text primary key check (email = lower(btrim(email)) and email <> ''),
  created_at  timestamptz not null default now()
);

alter table public.pelham_cash_viewers enable row level security;
revoke all on public.pelham_cash_viewers from anon, authenticated;

insert into public.pelham_cash_viewers (email) values ('admin@pelhamhills.ca') on conflict do nothing;

-- ===== 판정 ============================================================

-- 직원이면서 명단에 있는가. 이메일은 토큰이 아니라 auth.users 에서 읽는다.
create or replace function public.pelham_is_cash_viewer()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.pelham_is_staff()
     and exists (select 1
                   from auth.users u
                   join public.pelham_cash_viewers v on v.email = lower(u.email)
                  where u.id = auth.uid())
$$;

create or replace function public.pelham_require_cash_viewer()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.pelham_require_staff();
  if not public.pelham_is_cash_viewer() then
    perform public.pelham_fail('403', 'Only the cash report account can see cash figures.');
  end if;
end;
$$;

-- ===== 감싸기 ==========================================================
-- 0026 과 같은 방식: 지금 이름의 본문이 감싼 것이 아니면(0005·0010 을 다시 돌림) 옛 _base 를 버리고 다시 옮긴다.

do $$
declare
  v_sig record;
  v_src text;
begin
  for v_sig in
    select * from (values
      ('pelham_staff_pos_report_daily', 'date'),
      ('pelham_staff_closeout_report', 'date'),
      ('pelham_staff_closeout_save', 'date, jsonb'),
      ('pelham_staff_closeout_reopen', 'date, text')
    ) as t(fn, args)
  loop
    select p.prosrc into v_src from pg_proc p
     where p.oid = to_regprocedure(format('public.%s(%s)', v_sig.fn, v_sig.args));
    if v_src like '%_base(%' then
      continue;
    end if;
    if to_regprocedure(format('public.%s_base(%s)', v_sig.fn, v_sig.args)) is not null then
      execute format('drop function public.%s_base(%s)', v_sig.fn, v_sig.args);
    end if;
    execute format('alter function public.%s(%s) rename to %s_base', v_sig.fn, v_sig.args, v_sig.fn);
  end loop;
end;
$$;

-- 일 마감 리포트. 명단 밖 계정에는 현금 줄만 빠진다 — 카드·체크카드·회원 계정 등은 그대로 보인다.
create or replace function public.pelham_staff_pos_report_daily(p_date date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_report jsonb := public.pelham_staff_pos_report_daily_base(p_date);
begin
  if public.pelham_is_cash_viewer() then
    return v_report;
  end if;
  return v_report || jsonb_build_object(
    'by_payment', coalesce((
      select jsonb_agg(e.value order by e.ordinality)
        from jsonb_array_elements(v_report->'by_payment') with ordinality as e(value, ordinality)
       where e.value->>'method' <> 'cash'
    ), '[]'::jsonb),
    'cash_hidden', true
  );
end;
$$;

create or replace function public.pelham_staff_closeout_report(p_date date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.pelham_require_cash_viewer();
  return public.pelham_staff_closeout_report_base(p_date);
end;
$$;

create or replace function public.pelham_staff_closeout_save(p_date date, p jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform public.pelham_require_cash_viewer();
  return public.pelham_staff_closeout_save_base(p_date, p);
end;
$$;

create or replace function public.pelham_staff_closeout_reopen(p_date date, p_staff_key text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform public.pelham_require_cash_viewer();
  return public.pelham_staff_closeout_reopen_base(p_date, p_staff_key);
end;
$$;

-- 지금 계정이 현금 리포트를 볼 수 있는가. 직원이 아니면 다른 직원 함수와 같이 PT401.
create or replace function public.pelham_staff_cash_access()
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.pelham_require_staff();
  return public.pelham_is_cash_viewer();
end;
$$;

-- ===== 권한 ============================================================
-- 이름을 바꿔도 권한은 따라간다. 옛 함수(_base)에 남은 authenticated 실행 권한을 반드시 걷는다.

revoke all on function public.pelham_is_cash_viewer() from public, anon, authenticated;
revoke all on function public.pelham_require_cash_viewer() from public, anon, authenticated;
revoke all on function public.pelham_staff_pos_report_daily_base(date) from public, anon, authenticated;
revoke all on function public.pelham_staff_closeout_report_base(date) from public, anon, authenticated;
revoke all on function public.pelham_staff_closeout_save_base(date, jsonb) from public, anon, authenticated;
revoke all on function public.pelham_staff_closeout_reopen_base(date, text) from public, anon, authenticated;

revoke all on function public.pelham_staff_pos_report_daily(date) from public, anon, authenticated;
revoke all on function public.pelham_staff_closeout_report(date) from public, anon, authenticated;
revoke all on function public.pelham_staff_closeout_save(date, jsonb) from public, anon, authenticated;
revoke all on function public.pelham_staff_closeout_reopen(date, text) from public, anon, authenticated;
revoke all on function public.pelham_staff_cash_access() from public, anon, authenticated;

grant execute on function public.pelham_staff_pos_report_daily(date) to authenticated;
grant execute on function public.pelham_staff_closeout_report(date) to authenticated;
grant execute on function public.pelham_staff_closeout_save(date, jsonb) to authenticated;
grant execute on function public.pelham_staff_closeout_reopen(date, text) to authenticated;
grant execute on function public.pelham_staff_cash_access() to authenticated;

notify pgrst, 'reload schema';
