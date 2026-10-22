-- Change log 에 담당자(Cashier)도 남긴다(2026-10-22 클럽 요청).
--
-- 왜: 직원 로그인은 공용 계정 하나라 장부의 "by" 는 늘 같은 이메일이다. 누가 했는지는 계산대 담당자 이름
-- (Cashier 칸 — 0010 담당자별 마감과 같은 이름)으로만 안다.
--
-- 어떻게: 화면이 직원 함수를 부를 때마다 이 기기의 담당자 이름을 `x-pelham-cashier` 헤더로 보낸다
-- (`staffRpc.ts`, encodeURIComponent 로 감싼다). 트리거가 그 헤더를 읽어 장부의 `cashier` 칸에 적는다.
-- 헤더가 없으면(담당자를 한 번도 적지 않은 기기, SQL editor) 바뀐 줄 자신의 `cashier` 칸을 쓴다.
--
-- 이 파일 이전 기록: 장부에 칸이 없으므로 읽을 때 채운다 — 바뀐 줄의 `cashier`, 없으면 그 줄의 계산서
-- (`bill_id`)의 Cashier. 예약 변경처럼 계산서와 상관없는 옛 기록은 비어 있다.
--
-- 바뀌는 것:
--   pelham_change_log.cashier               — 새 칸.
--   pelham_request_cashier()                — 요청 헤더의 담당자 이름(없으면 null).
--   pelham_change_log_capture()             — cashier 를 같이 적는다.
--   pelham_staff_change_log(...)            — 줄마다 'cashier' 를 준다. 검색도 담당자 이름을 본다.
--
-- 전제: 0057, 0075. 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다.

do $$
begin
  if to_regprocedure('public.pelham_staff_change_log(date, date, text, text, bigint)') is null then
    raise exception '0076 needs 0075 first (pelham_staff_change_log without a password is missing).';
  end if;
end;
$$;

alter table public.pelham_change_log add column if not exists cashier text;

-- ===== 헤더 ============================================================

-- `%XX` 를 풀어 UTF-8 로 읽는다. 깨진 값이면 null.
create or replace function public.pelham_request_cashier()
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  v_raw text;
  v_name text;
begin
  v_raw := nullif(btrim(coalesce(current_setting('request.headers', true), '')), '');
  if v_raw is null then
    return null;
  end if;
  v_raw := (v_raw::json)->>'x-pelham-cashier';
  if v_raw is null or v_raw = '' then
    return null;
  end if;
  select convert_from(string_agg(
           case when m.parts[1] like '\%__' then decode(substr(m.parts[1], 2), 'hex')
                else convert_to(m.parts[1], 'UTF8') end,
           ''::bytea order by m.n), 'UTF8')
    into v_name
    from regexp_matches(v_raw, '%[0-9A-Fa-f]{2}|[^%]+|%', 'g') with ordinality as m(parts, n);
  return nullif(left(regexp_replace(btrim(v_name), '\s+', ' ', 'g'), 60), '');
exception when others then
  return null;
end;
$$;

-- ===== 적기 ============================================================

-- 0057 과 같고 cashier 만 더한다.
create or replace function public.pelham_change_log_capture()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old jsonb;
  v_new jsonb;
  v_row jsonb;
  v_key text;
  v_changed text[];
  v_uid uuid := auth.uid();
  v_email text;
  v_cashier text;
begin
  if tg_op in ('UPDATE', 'DELETE') then
    v_old := public.pelham_change_log_clean(to_jsonb(old));
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    v_new := public.pelham_change_log_clean(to_jsonb(new));
  end if;

  if tg_op = 'UPDATE' then
    select array_agg(k order by k) into v_changed
      from (select key as k from jsonb_each(v_old) union select key from jsonb_each(v_new)) keys
     where k <> 'updated_at' and (v_old->k) is distinct from (v_new->k);
    if v_changed is null then
      return null;
    end if;
  end if;

  v_row := coalesce(v_new, v_old);
  select string_agg(v_row->>btrim(c), ':') into v_key
    from unnest(string_to_array(coalesce(tg_argv[0], 'id'), ',')) c;

  if v_uid is not null then
    select u.email into v_email from auth.users u where u.id = v_uid;
  end if;

  v_cashier := coalesce(public.pelham_request_cashier(), nullif(btrim(v_row->>'cashier'), ''));

  insert into public.pelham_change_log
    (table_name, row_key, op, label, before_row, after_row, changed, actor_id, actor_email, cashier)
  values (tg_table_name, v_key, lower(tg_op), public.pelham_change_log_label(v_row),
          v_old, v_new, v_changed, v_uid, v_email, v_cashier);
  return null;
end;
$$;

-- ===== 읽기 ============================================================

-- 0075 와 같고 cashier 를 더한다.
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
           'actor', coalesce(c.actor_email, case when c.actor_id is null then 'system' else 'unknown' end),
           'cashier', c.who
         ) order by c.id desc), '[]'::jsonb)
    into v_rows
    from (select c.*, w.who
            from public.pelham_change_log c
            -- 0076 이전 기록은 칸이 비어 있다: 바뀐 줄의 cashier, 없으면 그 줄의 계산서 Cashier.
            cross join lateral (
              select coalesce(
                       c.cashier,
                       nullif(btrim(coalesce(c.after_row, c.before_row)->>'cashier'), ''),
                       (select nullif(btrim(b.cashier), '') from public.pelham_bills b
                         where coalesce(c.after_row, c.before_row)->>'bill_id' ~ '^\d+$'
                           and b.id = (coalesce(c.after_row, c.before_row)->>'bill_id')::bigint)) as who
            ) w
           where c.at >= (p_from::timestamp at time zone 'America/Toronto')
             and c.at < ((p_to + 1)::timestamp at time zone 'America/Toronto')
             and (p_table is null or p_table = '' or c.table_name = p_table)
             and (p_before_id is null or c.id < p_before_id)
             and (v_search is null
                  or c.label ilike '%' || v_search || '%'
                  or c.row_key ilike '%' || v_search || '%'
                  or c.actor_email ilike '%' || v_search || '%'
                  or w.who ilike '%' || v_search || '%'
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

revoke all on function public.pelham_request_cashier() from public, anon, authenticated;
revoke all on function public.pelham_change_log_capture() from public, anon, authenticated;
revoke all on function public.pelham_staff_change_log(date, date, text, text, bigint) from public, anon, authenticated;
grant execute on function public.pelham_staff_change_log(date, date, text, text, bigint) to authenticated;

notify pgrst, 'reload schema';
