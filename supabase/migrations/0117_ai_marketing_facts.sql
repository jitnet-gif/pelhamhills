-- AI Manager Marketing Strategies — **매니저가 적는 팩트**("Analysis facts" 탭).
--
-- 왜(2026-10-25): 사용자 요청 "마케팅 분석 시 들어가는 팩트를 보거나 추가할 수 있는 탭", "pelham-shift 인건비도 반영해서
-- 회사 손익분기점 및 개선점". 인건비는 pelham-shift 에서 오지만, 임대료·코스 관리·장비 리스·공과금 같은 고정비와
-- 목표·행사·경쟁 상황은 어느 시스템에도 없다. 매니저가 여기 적으면 Claude 가 손익분기점과 전략에 쓴다.
--
--   pelham_ai_marketing_facts                 팩트 한 줄: 종류(cost·revenue·goal·event·note), 내용, 금액(센트, 선택),
--                                             금액의 기간(month·season·year·once), 켜짐.
--   pelham_staff_ai_marketing_facts()         목록(꺼진 것 포함).
--   pelham_staff_ai_marketing_fact_save(p)    p.id 가 있으면 고치고 없으면 새로. 지우지 않는다 — 빼려면 active=false.
--   pelham_staff_ai_marketing_facts_active()  Fly 가 Claude 에 보낼 켜진 팩트만(누가 적었는지는 빼고).
--
-- 명단은 0094 와 같다. 전제: 0094. 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다.

do $$
begin
  if to_regprocedure('public.pelham_require_ai_marketing_viewer()') is null then
    raise exception '0117 needs 0094 first (pelham_require_ai_marketing_viewer is missing).';
  end if;
end;
$$;

create table if not exists public.pelham_ai_marketing_facts (
  id uuid primary key default gen_random_uuid(),
  kind text not null default 'note' check (kind in ('cost', 'revenue', 'goal', 'event', 'note')),
  label text not null check (btrim(label) <> '' and length(label) <= 200),
  detail text not null default '' check (length(detail) <= 1000),
  amount_cents bigint,
  per text check (per in ('month', 'season', 'year', 'once')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by text not null default '',
  updated_at timestamptz not null default now(),
  updated_by text not null default ''
);

alter table public.pelham_ai_marketing_facts enable row level security;
revoke all on public.pelham_ai_marketing_facts from public, anon, authenticated;

-- 지우지 않는다(보고서와 같다). 빼려면 끈다.
create or replace function public.pelham_ai_marketing_facts_keep()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'Facts are kept. Turn one off instead of deleting it.';
end;
$$;

drop trigger if exists pelham_ai_marketing_facts_keep on public.pelham_ai_marketing_facts;
create trigger pelham_ai_marketing_facts_keep
  before delete or truncate on public.pelham_ai_marketing_facts
  for each statement execute function public.pelham_ai_marketing_facts_keep();

create or replace function public.pelham_ai_marketing_fact_json(f public.pelham_ai_marketing_facts)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', f.id, 'kind', f.kind, 'label', f.label, 'detail', f.detail,
    'amount_cents', f.amount_cents, 'per', f.per, 'active', f.active,
    'created_at', public.pelham_iso(f.created_at), 'created_by', f.created_by,
    'updated_at', public.pelham_iso(f.updated_at), 'updated_by', f.updated_by)
$$;

create or replace function public.pelham_staff_ai_marketing_facts()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.pelham_require_ai_marketing_viewer();
  return coalesce((
    select jsonb_agg(public.pelham_ai_marketing_fact_json(f) order by f.active desc, f.kind, f.created_at)
      from public.pelham_ai_marketing_facts f), '[]'::jsonb);
end;
$$;

create or replace function public.pelham_staff_ai_marketing_facts_active()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.pelham_require_ai_marketing_viewer();
  return coalesce((
    select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
             'kind', f.kind, 'label', f.label, 'detail', nullif(f.detail, ''),
             'amount_cents', f.amount_cents, 'per', f.per)) order by f.kind, f.created_at)
      from public.pelham_ai_marketing_facts f where f.active), '[]'::jsonb);
end;
$$;

create or replace function public.pelham_staff_ai_marketing_fact_save(p jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  r public.pelham_ai_marketing_facts;
  v_id uuid := nullif(btrim(coalesce(p->>'id', '')), '')::uuid;
  v_by text;
begin
  perform public.pelham_require_ai_marketing_viewer();
  select lower(u.email) into v_by from auth.users u where u.id = auth.uid();
  if p ? 'kind' and p->>'kind' not in ('cost', 'revenue', 'goal', 'event', 'note') then
    perform public.pelham_fail('422', 'Pick what kind of fact this is.');
  end if;
  if p ? 'per' and nullif(p->>'per', '') is not null and p->>'per' not in ('month', 'season', 'year', 'once') then
    perform public.pelham_fail('422', 'Pick month, season, year or once.');
  end if;
  if (v_id is null or p ? 'label') and btrim(coalesce(p->>'label', '')) = '' then
    perform public.pelham_fail('422', 'Write the fact.');
  end if;

  if v_id is null then
    insert into public.pelham_ai_marketing_facts (kind, label, detail, amount_cents, per, active, created_by, updated_by)
    values (coalesce(nullif(p->>'kind', ''), 'note'), left(btrim(p->>'label'), 200), left(coalesce(p->>'detail', ''), 1000),
            nullif(p->>'amount_cents', '')::bigint, nullif(p->>'per', ''), coalesce((p->>'active')::boolean, true),
            coalesce(v_by, ''), coalesce(v_by, ''))
    returning * into r;
  else
    update public.pelham_ai_marketing_facts
       set kind = case when p ? 'kind' then p->>'kind' else kind end,
           label = case when p ? 'label' then left(btrim(p->>'label'), 200) else label end,
           detail = case when p ? 'detail' then left(coalesce(p->>'detail', ''), 1000) else detail end,
           amount_cents = case when p ? 'amount_cents' then nullif(p->>'amount_cents', '')::bigint else amount_cents end,
           per = case when p ? 'per' then nullif(p->>'per', '') else per end,
           active = case when p ? 'active' then coalesce((p->>'active')::boolean, active) else active end,
           updated_at = now(), updated_by = coalesce(v_by, '')
     where id = v_id
    returning * into r;
    if r.id is null then
      perform public.pelham_fail('404', 'No such fact.');
    end if;
  end if;
  return public.pelham_ai_marketing_fact_json(r);
end;
$$;

revoke all on function public.pelham_ai_marketing_facts_keep() from public, anon, authenticated;
revoke all on function public.pelham_ai_marketing_fact_json(public.pelham_ai_marketing_facts) from public, anon, authenticated;
revoke all on function public.pelham_staff_ai_marketing_facts() from public, anon;
revoke all on function public.pelham_staff_ai_marketing_facts_active() from public, anon;
revoke all on function public.pelham_staff_ai_marketing_fact_save(jsonb) from public, anon;
grant execute on function public.pelham_staff_ai_marketing_facts() to authenticated;
grant execute on function public.pelham_staff_ai_marketing_facts_active() to authenticated;
grant execute on function public.pelham_staff_ai_marketing_fact_save(jsonb) to authenticated;

notify pgrst, 'reload schema';
