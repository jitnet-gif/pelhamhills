-- Change log 비밀번호를 없앤다(2026-10-22 클럽 요청).
--
-- 왜: Reports 는 이제 Reports 명단(0046 의 pelham_cash_viewers — 지금은 Emmeline 의 admin@pelhamhills.ca)에 있는
-- 계정만 연다. 같은 사람에게 비밀번호를 한 번 더 묻는 것은 막는 것이 없다.
-- 대신 서버도 같은 명단으로 막는다 — 0057 은 직원이면 누구나 비밀번호만 맞으면 열 수 있었다.
--
-- 바뀌는 것:
--   pelham_staff_change_log(from, to, table, search, before_id) — p_password 가 빠졌다. Reports 명단 계정만.
--   옛 pelham_staff_change_log(password, ...) 와 pelham_change_log_password_set(text) 는 지운다.
--   pelham_change_log_access(비밀번호 해시)는 비운다. pelham_change_log_attempts 는 그대로 —
--   누가 언제 장부를 열었는지(ok=true)는 계속 적는다. 장부(pelham_change_log)와 트리거는 그대로다.
--
-- 전제: 0046, 0057. 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다.

do $$
begin
  if to_regclass('public.pelham_change_log') is null then
    raise exception '0075 needs 0057 first (pelham_change_log is missing).';
  end if;
  if to_regprocedure('public.pelham_is_cash_viewer()') is null then
    raise exception '0075 needs 0046 first (pelham_is_cash_viewer is missing).';
  end if;
end;
$$;

drop function if exists public.pelham_staff_change_log(text, date, date, text, text, bigint);
drop function if exists public.pelham_change_log_password_set(text);
delete from public.pelham_change_log_access;

create or replace function public.pelham_staff_change_log(
  p_from date,
  p_to date,
  p_table text default null,
  p_search text default null,
  p_before_id bigint default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_email text;
  v_search text := nullif(btrim(coalesce(p_search, '')), '');
  v_limit integer := 200;
  v_rows jsonb;
begin
  perform public.pelham_require_staff();
  if not public.pelham_is_cash_viewer() then
    perform public.pelham_fail('403', 'Only the Reports account can see the change log.');
  end if;
  select u.email into v_email from auth.users u where u.id = v_uid;

  -- 열 때(첫 페이지)만 적는다 — 누가 언제 장부를 봤는지.
  if p_before_id is null then
    insert into public.pelham_change_log_attempts (ok, requested_by, email) values (true, v_uid, v_email);
  end if;

  if p_from is null or p_to is null or p_to < p_from then
    perform public.pelham_fail('422', 'Give a date range.');
  end if;
  if p_to - p_from > 92 then
    perform public.pelham_fail('422', 'Pick 92 days or fewer.');
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', c.id,
           'at', public.pelham_iso(c.at),
           'table', c.table_name,
           'rowKey', c.row_key,
           'op', c.op,
           'label', c.label,
           'before', c.before_row,
           'after', c.after_row,
           'changed', to_jsonb(c.changed),
           'actor', coalesce(c.actor_email, case when c.actor_id is null then 'system' else 'unknown' end)
         ) order by c.id desc), '[]'::jsonb)
    into v_rows
    from (select * from public.pelham_change_log c
           where c.at >= (p_from::timestamp at time zone 'America/Toronto')
             and c.at < ((p_to + 1)::timestamp at time zone 'America/Toronto')
             and (p_table is null or p_table = '' or c.table_name = p_table)
             and (p_before_id is null or c.id < p_before_id)
             and (v_search is null
                  or c.label ilike '%' || v_search || '%'
                  or c.row_key ilike '%' || v_search || '%'
                  or c.actor_email ilike '%' || v_search || '%'
                  or c.before_row::text ilike '%' || v_search || '%'
                  or c.after_row::text ilike '%' || v_search || '%')
           order by c.id desc
           limit v_limit + 1) c;

  -- 한 장에 200줄. 하나 더 읽어 다음 장이 있는지 안다(내림차순이라 덧 읽은 줄은 맨 끝).
  if jsonb_array_length(v_rows) > v_limit then
    return jsonb_build_object('ok', true, 'rows', v_rows - v_limit, 'more', true);
  end if;
  return jsonb_build_object('ok', true, 'rows', v_rows, 'more', false);
end;
$$;

revoke all on function public.pelham_staff_change_log(date, date, text, text, bigint) from public, anon, authenticated;
grant execute on function public.pelham_staff_change_log(date, date, text, text, bigint) to authenticated;

notify pgrst, 'reload schema';
