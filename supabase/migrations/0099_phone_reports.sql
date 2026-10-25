-- 전화 비서가 받는 현장 문제(카트 배터리 방전 등)와 컴플레인.
--
-- 왜(2026-10-24 클럽 요청): 전화 비서는 예약·취소·분실물·콜백만 받았다. "7번 홀에서 카트가 섰다", 불만 접수도
-- 전화로 들어온다. 비서가 받아 적고(`backend/services/phone_requests.py`), 직원은 Calls & SMS 의 두 탭에서 처리한다.
--
--   pelham_phone_reports — kind = problem(현장 문제) · complaint(컴플레인).
--                          문제는 접수 즉시 직원 번호로 문자가 간다(Fly secret `STAFF_ALERT_NUMBERS`, 있으면).
--
-- 음식 주문은 여기 없다: 전화 주문도 GPS 앱의 주문(golf-gps-pelhamhills-seven 0012 의 `menu_items`·
--
-- 표는 service_role(전화 비서)만 쓴다. 직원은 아래 함수로만 본다·바꾼다.
--   pelham_staff_phone_reports(p_kind, p_status)     — 목록. 열린 것이 위, 최근 300건.
--   pelham_staff_phone_report_update(id, p)          — status(open · in_progress · resolved · closed)·staff_notes.
--
-- 전제: 0004(pelham_require_staff·pelham_fail), 0057(있으면 변경 기록에 붙인다).
-- 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다.

do $$
begin
  if to_regprocedure('public.pelham_require_staff()') is null then
    raise exception '0099 needs 0004 first (pelham_require_staff is missing).';
  end if;
end;
$$;

-- ===== 현장 문제 · 컴플레인 =================================================

create sequence if not exists public.pelham_phone_report_seq start 101;

create table if not exists public.pelham_phone_reports (
  id               uuid primary key default gen_random_uuid(),
  -- `PB-0101`(문제) · `CP-0101`(컴플레인). 아래 트리거가 채운다.
  ticket           text not null unique,
  kind             text not null check (kind in ('problem', 'complaint')),
  -- problem: cart_battery · cart_broken · course · injury · other / complaint: 손님이 말한 주제 한두 마디
  category         text not null default 'other',
  location         text,                   -- "hole 7", "parking lot"
  cart_number      text,
  details          text not null,
  first_name       text not null default '',
  last_name        text not null default '',
  phone            text not null,
  caller_number    text,
  wants_callback   boolean not null default false,
  staff_alerted_at timestamptz,            -- 직원 번호로 문자를 보낸 때
  conversation_id  text,
  -- open: 접수 · in_progress: 처리 중 · resolved: 해결 · closed: 필요 없어짐
  status           text not null default 'open' check (status in ('open', 'in_progress', 'resolved', 'closed')),
  staff_notes      text,
  handled_at       timestamptz,
  handled_by       text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists pelham_phone_reports_open_idx
  on public.pelham_phone_reports (kind, created_at) where status in ('open', 'in_progress');

alter table public.pelham_phone_reports enable row level security;
revoke all on public.pelham_phone_reports from anon, authenticated;

comment on table public.pelham_phone_reports is
  '전화로 받은 현장 문제·컴플레인(0099). 접수는 전화 비서(service_role), 처리는 직원 함수.';

create or replace function public.pelham_phone_report_ticket()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.ticket is null or btrim(new.ticket) = '' then
    new.ticket := (case new.kind when 'complaint' then 'CP-' else 'PB-' end)
                  || lpad(nextval('public.pelham_phone_report_seq')::text, 4, '0');
  end if;
  return new;
end;
$$;

drop trigger if exists pelham_phone_report_ticket on public.pelham_phone_reports;
create trigger pelham_phone_report_ticket before insert on public.pelham_phone_reports
  for each row execute function public.pelham_phone_report_ticket();

-- ===== 직원 함수: 문제 · 컴플레인 ==========================================

create or replace function public.pelham_phone_report_json(r public.pelham_phone_reports)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', r.id,
    'ticket', r.ticket,
    'kind', r.kind,
    'category', r.category,
    'location', r.location,
    'cart_number', r.cart_number,
    'details', r.details,
    'first_name', r.first_name,
    'last_name', r.last_name,
    'phone', r.phone,
    'caller_number', r.caller_number,
    'wants_callback', r.wants_callback,
    'staff_alerted_at', r.staff_alerted_at,
    'conversation_id', r.conversation_id,
    'status', r.status,
    'staff_notes', r.staff_notes,
    'handled_at', r.handled_at,
    'handled_by', r.handled_by,
    'created_at', r.created_at,
    'updated_at', r.updated_at
  )
$$;

-- 목록. `p_kind` 는 problem · complaint(비면 둘 다), `p_status` 가 비면 전부(최근 300건).
create or replace function public.pelham_staff_phone_reports(p_kind text default null, p_status text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.pelham_require_staff();
  return coalesce((
    select jsonb_agg(public.pelham_phone_report_json(r)
                     order by (r.status in ('open', 'in_progress')) desc, r.created_at desc)
      from (
        select * from public.pelham_phone_reports x
         where (p_kind is null or btrim(p_kind) = '' or x.kind = p_kind)
           and (p_status is null or btrim(p_status) = '' or x.status = p_status)
         order by x.created_at desc
         limit 300
      ) r
  ), '[]'::jsonb);
end;
$$;

create or replace function public.pelham_staff_phone_report_update(p_id uuid, p jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  r public.pelham_phone_reports;
  v_status text := nullif(btrim(coalesce(p->>'status', '')), '');
  v_email text;
begin
  perform public.pelham_require_staff();
  if v_status is not null and v_status not in ('open', 'in_progress', 'resolved', 'closed') then
    perform public.pelham_fail('422', format('''%s'' is not a report status', v_status));
  end if;

  select * into r from public.pelham_phone_reports where id = p_id for update;
  if r.id is null then
    perform public.pelham_fail('404', 'No such report');
  end if;

  select u.email into v_email from auth.users u where u.id = auth.uid();

  update public.pelham_phone_reports
     set status      = coalesce(v_status, status),
         staff_notes = case when p ? 'staff_notes' then nullif(btrim(coalesce(p->>'staff_notes', '')), '') else staff_notes end,
         handled_at  = case when v_status is null or v_status = status then handled_at
                            when v_status = 'open' then null else now() end,
         handled_by  = case when v_status is null or v_status = status then handled_by
                            when v_status = 'open' then null else v_email end,
         updated_at  = now()
   where id = p_id
  returning * into r;
  return public.pelham_phone_report_json(r);
end;
$$;

-- ===== 변경 기록(0057) — 있으면 붙인다 ==================================

do $$
begin
  if to_regprocedure('public.pelham_change_log_capture()') is not null then
    drop trigger if exists pelham_change_log on public.pelham_phone_reports;
    create trigger pelham_change_log after insert or update or delete on public.pelham_phone_reports
      for each row execute function public.pelham_change_log_capture('id');
  end if;
end;
$$;

-- ===== 권한 ==============================================================

revoke all on function public.pelham_phone_report_ticket() from public, anon, authenticated;
revoke all on function public.pelham_phone_report_json(public.pelham_phone_reports) from public, anon, authenticated;
revoke all on function public.pelham_staff_phone_reports(text, text) from public, anon, authenticated;
revoke all on function public.pelham_staff_phone_report_update(uuid, jsonb) from public, anon, authenticated;

grant execute on function public.pelham_staff_phone_reports(text, text) to authenticated;
grant execute on function public.pelham_staff_phone_report_update(uuid, jsonb) to authenticated;

notify pgrst, 'reload schema';

-- ===== 확인 ============================================================

-- 비어 있는 목록(접수 0건)이 나오면 정상이다.
select public.pelham_phone_report_json(r) from public.pelham_phone_reports r limit 5;
