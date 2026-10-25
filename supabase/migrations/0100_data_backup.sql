-- 데이터 백업·복원 — 클럽 표(public.pelham_*)를 CSV 로 내려받고, 그 CSV 로 되살린다.
--
-- 왜(2026-10-24): 클럽이 Supabase 데이터를 매일 로컬(사무실 맥)에 CSV 로 받아 두고, 필요하면 그 파일로 되돌리고
-- 싶다고 했다. 쓰는 사람은 매니저 이상 — Reports 명단(0046)과 계정 관리자(0074).
--
-- 어디서 부르나:
--   어드민 Data Backup 화면(/admin/backup)  "Back up now" 로 폴더에 CSV 를 쓰고, 폴더를 골라 복원한다.
--   scripts/backup/pelham_backup.mjs        매니저 계정으로 로그인해 매일 밤 ~/PelhamBackups/<날짜>/ 에 쓴다(launchd).
--   scripts/backup/pelham_restore.mjs       그 폴더로 복원한다.
--
-- 범위: public 스키마의 pelham_* 표만. 이 DB 는 GPS·스코어카드 앱과 같이 쓰므로 남의 표(scorecard_*, auth.*)는
-- 건드리지 않는다. 로그인 계정(auth.users)과 비밀번호도 백업에 들어가지 않는다.
--
-- 값은 전부 Postgres 의 글자 모양(::text)으로 나간다. 복원은 그 글자를 지금 열의 형으로 다시 바꾼다
-- (jsonb·배열·시간 모두 왕복된다). NULL 과 빈 글자는 CSV 에서 다르게 적는다 — 스크립트·화면이 맡는다.
--
-- 복원:
--   merge   백업의 줄을 되살린다(기본 키가 같으면 백업 값으로 덮는다). 백업 뒤에 생긴 줄은 그대로 둔다.
--   replace 위에 더해, 백업에 없는 줄을 지운다(pelham_backup_prune). 표가 백업 시점과 똑같아진다.
--   복원하는 동안 그 표의 사용자 트리거(변경 기록 0057 등)는 끈다 — 되살리는 줄이 "새로 고친 것" 으로 남지 않게.
--   외래 키는 그대로 지켜진다. 그래서 부모 표부터 넣고(order), 지울 때는 자식 표부터 지운다.
--   권한 명단(*_viewers, *_admins, 매니저 PIN, 변경 기록)은 계정 관리자만 복원할 수 있다 — 매니저가 CSV 를 고쳐
--   자기 권한을 올리지 못하게.
--
-- 전제: 0004, 0046, 0074. 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다.

do $$
begin
  if to_regprocedure('public.pelham_is_cash_viewer()') is null then
    raise exception '0100 needs 0046 first (pelham_is_cash_viewer is missing).';
  end if;
  if to_regprocedure('public.pelham_is_account_admin()') is null then
    raise exception '0100 needs 0074 first (pelham_is_account_admin is missing).';
  end if;
end;
$$;

-- ===== 기록 ============================================================

create table if not exists public.pelham_backup_runs (
  id          bigint generated always as identity primary key,
  kind        text not null check (kind in ('backup', 'restore')),
  source      text not null check (source in ('web', 'daily', 'script')),
  email       text not null,
  tables      integer not null default 0,
  rows        bigint not null default 0,
  note        text,
  created_at  timestamptz not null default now()
);

alter table public.pelham_backup_runs enable row level security;
revoke all on public.pelham_backup_runs from anon, authenticated;

-- ===== 판정 ============================================================

create or replace function public.pelham_is_backup_manager()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.pelham_is_cash_viewer() or public.pelham_is_account_admin()
$$;

create or replace function public.pelham_require_backup_manager()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.pelham_require_staff();
  if not public.pelham_is_backup_manager() then
    perform public.pelham_fail('403', 'Data Backup is for managers and the account manager only.');
  end if;
end;
$$;

-- 메뉴를 가린다.
create or replace function public.pelham_backup_access()
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.pelham_require_staff();
  return public.pelham_is_backup_manager();
end;
$$;

-- 계정 관리자만 복원하는 표.
create or replace function public.pelham_backup_is_protected(p_table text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_table like '%\_viewers' or p_table like '%\_admins'
      or p_table in ('pelham_managers', 'pelham_manager_approvals', 'pelham_change_log',
                     'pelham_change_log_access', 'pelham_change_log_attempts')
$$;

-- 백업할 수 있는 표인가. 아니면 거절한다. 돌려주는 값은 그 표의 oid.
create or replace function public.pelham_backup_table_oid(p_table text)
returns oid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_oid oid;
begin
  select c.oid into v_oid
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = p_table and c.relkind in ('r', 'p')
     and c.relname like 'pelham\_%';
  if v_oid is null then
    perform public.pelham_fail('404', format('Not a club table: %s', coalesce(p_table, '(none)')));
  end if;
  return v_oid;
end;
$$;

-- 기본 키 열(순서대로). 없으면 빈 배열.
create or replace function public.pelham_backup_key_of(p_oid oid)
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(a.attname::text order by k.ord), '{}')
    from pg_catalog.pg_constraint con
    cross join lateral unnest(con.conkey) with ordinality k(attnum, ord)
    join pg_catalog.pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum
   where con.conrelid = p_oid and con.contype = 'p'
$$;

-- ===== 목록 ============================================================

-- 표마다 이름·순서(부모가 먼저)·기본 키·열·줄 수·복원 제한. 순서대로.
create or replace function public.pelham_backup_tables()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_out jsonb;
begin
  perform public.pelham_require_backup_manager();

  with recursive t as (
    select c.oid, c.relname::text as name
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r', 'p') and c.relname like 'pelham\_%'
  ),
  e as (
    select distinct con.conrelid as child, con.confrelid as parent
      from pg_catalog.pg_constraint con
     where con.contype = 'f' and con.conrelid <> con.confrelid
       and con.conrelid in (select oid from t) and con.confrelid in (select oid from t)
  ),
  walk(oid, depth) as (
    select oid, 0 from t
    union all
    select e.child, w.depth + 1 from walk w join e on e.parent = w.oid where w.depth < 30
  ),
  ord as (
    select oid, max(depth) as depth from walk group by oid
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'table', t.name,
           'order', o.depth,
           'key', to_jsonb(public.pelham_backup_key_of(t.oid)),
           'columns', (select coalesce(jsonb_agg(jsonb_build_object(
                                 'name', a.attname,
                                 'type', pg_catalog.format_type(a.atttypid, a.atttypmod),
                                 'generated', a.attgenerated <> '') order by a.attnum), '[]'::jsonb)
                         from pg_catalog.pg_attribute a
                        where a.attrelid = t.oid and a.attnum > 0 and not a.attisdropped),
           'rows', (xpath('/row/c/text()',
                          query_to_xml(format('select count(*) as c from public.%I', t.name), false, true, '')))[1]::text::bigint,
           'protected', public.pelham_backup_is_protected(t.name))
         order by o.depth, t.name), '[]'::jsonb)
    into v_out
    from t join ord o using (oid);

  return v_out;
end;
$$;

-- 최근 백업·복원 기록 30줄.
create or replace function public.pelham_backup_runs_list()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.pelham_require_backup_manager();
  return coalesce((
    select jsonb_agg(to_jsonb(r) order by r.created_at desc)
      from (select id, kind, source, email, tables, rows, note, created_at
              from public.pelham_backup_runs
             order by created_at desc
             limit 30) r
  ), '[]'::jsonb);
end;
$$;

-- 백업·복원을 마쳤을 때 한 줄 남긴다.
create or replace function public.pelham_backup_log(p_kind text, p_source text, p_tables integer, p_rows bigint, p_note text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform public.pelham_require_backup_manager();
  insert into public.pelham_backup_runs (kind, source, email, tables, rows, note)
  select p_kind, coalesce(p_source, 'web'), lower(u.email), greatest(coalesce(p_tables, 0), 0),
         greatest(coalesce(p_rows, 0), 0), nullif(left(btrim(coalesce(p_note, '')), 500), '')
    from auth.users u
   where u.id = auth.uid();
end;
$$;

-- ===== 내보내기 =========================================================

-- 한 표의 줄을 기본 키 순서로 p_limit 줄씩. {columns: [...], rows: [[글자|null, ...], ...]}.
create or replace function public.pelham_backup_export(p_table text, p_offset integer, p_limit integer)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_oid oid;
  v_cols text[];
  v_key text[];
  v_order text;
  v_values text;
  v_rows jsonb;
begin
  perform public.pelham_require_backup_manager();
  v_oid := public.pelham_backup_table_oid(p_table);
  v_key := public.pelham_backup_key_of(v_oid);

  select array_agg(a.attname::text order by a.attnum) into v_cols
    from pg_catalog.pg_attribute a
   where a.attrelid = v_oid and a.attnum > 0 and not a.attisdropped;

  -- 기본 키가 없으면 모든 열로 줄을 세운다 — 쪽을 나눠 읽어도 줄이 겹치거나 빠지지 않게.
  select string_agg(format('%I', c), ', ') into v_order
    from unnest(case when cardinality(v_key) > 0 then v_key else v_cols end) c;
  select string_agg(format('x.%I::text', c), ', ') into v_values from unnest(v_cols) c;

  execute format(
    'select coalesce(jsonb_agg(to_jsonb(array[%s]::text[]) order by %s), ''[]''::jsonb)
       from (select * from public.%I order by %s offset $1 limit $2) x',
    v_values,
    (select string_agg(format('x.%I', c), ', ')
       from unnest(case when cardinality(v_key) > 0 then v_key else v_cols end) c),
    p_table, v_order)
    into v_rows
    using greatest(coalesce(p_offset, 0), 0), least(greatest(coalesce(p_limit, 1000), 1), 5000);

  return jsonb_build_object('columns', to_jsonb(v_cols), 'rows', v_rows);
end;
$$;

-- ===== 복원 ============================================================

-- 지금 계정이 이 표를 복원해도 되는가. 아니면 거절한다.
create or replace function public.pelham_backup_require_restorable(p_table text)
returns oid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_oid oid;
begin
  perform public.pelham_require_backup_manager();
  v_oid := public.pelham_backup_table_oid(p_table);
  if p_table = 'pelham_backup_runs' then
    perform public.pelham_fail('422', 'The backup history is not restored.');
  end if;
  if public.pelham_backup_is_protected(p_table) and not public.pelham_is_account_admin() then
    perform public.pelham_fail('403', format('Only the account manager can restore %s.', p_table));
  end if;
  return v_oid;
end;
$$;

-- 사용자 트리거를 끈다. 표 주인이 아니어서 못 끄면 켠 채로 둔다(되살리기는 된다). 끝나면 같은 트랜잭션에서 다시 켠다.
create or replace function public.pelham_backup_triggers(p_table text, p_enable boolean)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  execute format('alter table public.%I %s trigger user', p_table, case when p_enable then 'enable' else 'disable' end);
  return true;
exception when insufficient_privilege then
  return false;
end;
$$;

-- 줄을 되살린다. p_columns 는 CSV 머리줄, p_rows 는 [[글자|null, ...], ...]. 넣거나 덮은 줄 수를 돌려준다.
-- 지금 표에 없는 열과 계산 열(generated)은 건너뛴다. 기본 키 열은 반드시 있어야 한다.
create or replace function public.pelham_backup_restore(p_table text, p_columns text[], p_rows jsonb)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_oid oid;
  v_key text[];
  v_cols text[] := '{}';
  v_exprs text[] := '{}';
  v_identity boolean := false;
  v_missing text;
  v_set text;
  v_conflict text;
  v_off boolean;
  v_count integer;
  r record;
begin
  v_oid := public.pelham_backup_require_restorable(p_table);
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    perform public.pelham_fail('422', 'Rows must be a list.');
  end if;
  if jsonb_array_length(p_rows) = 0 then
    return 0;
  end if;
  v_key := public.pelham_backup_key_of(v_oid);

  for r in
    select a.attname::text as name, pg_catalog.format_type(a.atttypid, a.atttypmod) as type,
           a.attidentity = 'a' as always_identity, i.ord - 1 as idx
      from pg_catalog.pg_attribute a
      join unnest(p_columns) with ordinality i(name, ord) on i.name = a.attname::text
     where a.attrelid = v_oid and a.attnum > 0 and not a.attisdropped and a.attgenerated = ''
     order by a.attnum
  loop
    v_cols := v_cols || r.name;
    v_exprs := v_exprs || format('(r->>%s)::%s', r.idx, r.type);
    v_identity := v_identity or r.always_identity;
  end loop;

  if cardinality(v_cols) = 0 then
    perform public.pelham_fail('422', format('No matching columns for %s.', p_table));
  end if;
  select k into v_missing from unnest(v_key) k where k <> all (v_cols) limit 1;
  if v_missing is not null then
    perform public.pelham_fail('422', format('%s: the backup has no %s column.', p_table, v_missing));
  end if;

  if cardinality(v_key) = 0 then
    -- 기본 키가 없으면 같은 줄을 알아볼 수 없다. replace 로 비운 뒤 넣는 것만 맞다 — 화면·스크립트가 그렇게 한다.
    v_conflict := '';
  else
    select string_agg(format('%I = excluded.%I', c, c), ', ') into v_set
      from unnest(v_cols) c where c <> all (v_key);
    v_conflict := format(' on conflict (%s) do %s',
                         (select string_agg(format('%I', k), ', ') from unnest(v_key) k),
                         case when v_set is null then 'nothing' else 'update set ' || v_set end);
  end if;

  v_off := public.pelham_backup_triggers(p_table, false);
  execute format('insert into public.%I (%s) %s select %s from jsonb_array_elements($1) r%s',
                 p_table,
                 (select string_agg(format('%I', c), ', ') from unnest(v_cols) c),
                 case when v_identity then 'overriding system value' else '' end,
                 array_to_string(v_exprs, ', '),
                 v_conflict)
    using p_rows;
  get diagnostics v_count = row_count;
  if v_off then
    perform public.pelham_backup_triggers(p_table, true);
  end if;

  -- identity 열에 옛 번호를 넣었으면 다음 번호가 겹치지 않게 시퀀스를 끝으로 옮긴다.
  for r in
    select a.attname::text as name, pg_catalog.pg_get_serial_sequence(format('public.%I', p_table), a.attname) as seq
      from pg_catalog.pg_attribute a
     where a.attrelid = v_oid and a.attnum > 0 and not a.attisdropped and a.attname::text = any (v_cols)
       and pg_catalog.pg_get_serial_sequence(format('public.%I', p_table), a.attname) is not null
  loop
    execute format('select pg_catalog.setval(%L, greatest((select max(%I) from public.%I), 1))', r.seq, r.name, p_table);
  end loop;

  return v_count;
end;
$$;

-- replace: 백업에 없는 줄을 지운다. p_keys 는 기본 키 값 [[글자, ...], ...] (기본 키 열 순서). 지운 줄 수.
-- 기본 키가 없는 표는 p_keys 와 상관없이 다 비운다(그 뒤 restore 가 백업의 줄을 넣는다).
create or replace function public.pelham_backup_prune(p_table text, p_keys jsonb)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_oid oid;
  v_key text[];
  v_match text;
  v_off boolean;
  v_count integer;
begin
  v_oid := public.pelham_backup_require_restorable(p_table);
  if p_keys is null or jsonb_typeof(p_keys) <> 'array' then
    perform public.pelham_fail('422', 'Keys must be a list.');
  end if;
  v_key := public.pelham_backup_key_of(v_oid);

  v_off := public.pelham_backup_triggers(p_table, false);
  if cardinality(v_key) = 0 then
    execute format('delete from public.%I', p_table);
  else
    select string_agg(format('t.%I::text = k->>%s', c, o - 1), ' and ') into v_match
      from unnest(v_key) with ordinality u(c, o);
    execute format('delete from public.%I t where not exists (select 1 from jsonb_array_elements($1) k where %s)',
                   p_table, v_match)
      using p_keys;
  end if;
  get diagnostics v_count = row_count;
  if v_off then
    perform public.pelham_backup_triggers(p_table, true);
  end if;
  return v_count;
end;
$$;

-- ===== 권한 ============================================================

revoke all on function public.pelham_is_backup_manager() from public, anon, authenticated;
revoke all on function public.pelham_require_backup_manager() from public, anon, authenticated;
revoke all on function public.pelham_backup_is_protected(text) from public, anon, authenticated;
revoke all on function public.pelham_backup_table_oid(text) from public, anon, authenticated;
revoke all on function public.pelham_backup_key_of(oid) from public, anon, authenticated;
revoke all on function public.pelham_backup_require_restorable(text) from public, anon, authenticated;
revoke all on function public.pelham_backup_triggers(text, boolean) from public, anon, authenticated;
revoke all on function public.pelham_backup_access() from public, anon, authenticated;
revoke all on function public.pelham_backup_tables() from public, anon, authenticated;
revoke all on function public.pelham_backup_runs_list() from public, anon, authenticated;
revoke all on function public.pelham_backup_log(text, text, integer, bigint, text) from public, anon, authenticated;
revoke all on function public.pelham_backup_export(text, integer, integer) from public, anon, authenticated;
revoke all on function public.pelham_backup_restore(text, text[], jsonb) from public, anon, authenticated;
revoke all on function public.pelham_backup_prune(text, jsonb) from public, anon, authenticated;

grant execute on function public.pelham_backup_access() to authenticated;
grant execute on function public.pelham_backup_tables() to authenticated;
grant execute on function public.pelham_backup_runs_list() to authenticated;
grant execute on function public.pelham_backup_log(text, text, integer, bigint, text) to authenticated;
grant execute on function public.pelham_backup_export(text, integer, integer) to authenticated;
grant execute on function public.pelham_backup_restore(text, text[], jsonb) to authenticated;
grant execute on function public.pelham_backup_prune(text, jsonb) to authenticated;

notify pgrst, 'reload schema';

-- ===== 확인 ============================================================

-- 백업할 수 있는 계정(매니저 + 계정 관리자).
select email, 'manager (Reports)' as why from public.pelham_cash_viewers
union all
select email, 'account manager' from public.pelham_account_admins
order by 1;
