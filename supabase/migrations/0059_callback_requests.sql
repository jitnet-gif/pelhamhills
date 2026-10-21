-- 전화 상담 콜백 명단. 업무시간 밖에 전화한 손님에게 직원이 업무시간에 전화한다.
--
-- 왜(2026-10-20 클럽 결정): 업무시간 밖에는 프로 샵으로 연결해도 받을 사람이 없다. 전화 비서는 연결하지 않고
-- "업무시간에 직원이 전화드리겠습니다" 라고 말한 뒤 이 표에 적는다(`request_callback` 도구,
-- `backend/services/callbacks.py`). 업무시간은 백엔드의 `PRO_SHOP_HOURS`(기본 08:00-18:00, 매일)다.
--
-- 직원은 Reports → Phone callbacks 탭에서 목록을 보고, 전화한 뒤 "Called" 로 바꾼다. 누가 언제 바꿨는지 남는다.
--
--   pelham_callback_requests          — 명단. service_role(전화 비서)만 쓴다. 직원은 아래 함수로만.
--   pelham_staff_callbacks(p_status)  — 목록. 열린 것이 위, 최근 300건.
--   pelham_staff_callback_update(id, p) — status(open · called · closed)·notes.
--
-- 전제: 0004(pelham_require_staff·pelham_fail), 0057(있으면 변경 기록에 붙인다).
-- 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다.

do $$
begin
  if to_regprocedure('public.pelham_require_staff()') is null then
    raise exception '0059 needs 0004 first (pelham_require_staff is missing).';
  end if;
end;
$$;

create sequence if not exists public.pelham_callback_seq start 101;

create table if not exists public.pelham_callback_requests (
  id               uuid primary key default gen_random_uuid(),
  -- 직원끼리 부르는 번호. `CB-0101` 꼴.
  ticket           text not null unique
                   default ('CB-' || lpad(nextval('public.pelham_callback_seq')::text, 4, '0')),
  first_name       text not null default '',
  last_name        text not null default '',
  phone            text not null,          -- 전화할 번호(손님이 다른 번호를 말했으면 그 번호)
  caller_number    text,                   -- 전화선이 준 발신번호
  reason           text not null,          -- "Wants a tee time for six players on Nov 7"
  preferred_time   text,                   -- "after 3 PM", 손님이 말했을 때만
  conversation_id  text,                   -- ElevenLabs 통화 id(통화 기록과 맞춰 볼 때)
  -- open: 아직 전화 안 함 · called: 전화함 · closed: 필요 없어짐(손님이 다시 전화함 등)
  status           text not null default 'open' check (status in ('open', 'called', 'closed')),
  notes            text,
  handled_at       timestamptz,
  handled_by       text,                   -- 바꾼 직원 계정 이메일
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists pelham_callback_requests_open_idx
  on public.pelham_callback_requests (created_at) where status = 'open';

-- 이름·전화가 들어 있다. anon·authenticated 로는 읽을 수 없다.
alter table public.pelham_callback_requests enable row level security;
revoke all on public.pelham_callback_requests from anon, authenticated;

comment on table public.pelham_callback_requests is
  '전화 상담 콜백 명단(0059). 접수는 전화 비서(service_role), 처리는 직원 함수.';

-- ===== 직원 함수 =========================================================

create or replace function public.pelham_callback_json(r public.pelham_callback_requests)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', r.id,
    'ticket', r.ticket,
    'first_name', r.first_name,
    'last_name', r.last_name,
    'phone', r.phone,
    'caller_number', r.caller_number,
    'reason', r.reason,
    'preferred_time', r.preferred_time,
    'conversation_id', r.conversation_id,
    'status', r.status,
    'notes', r.notes,
    'handled_at', r.handled_at,
    'handled_by', r.handled_by,
    'created_at', r.created_at,
    'updated_at', r.updated_at
  )
$$;

-- 목록. 열린 것이 위, 그다음 최근 것. `p_status` 가 비면 전부(최근 300건).
create or replace function public.pelham_staff_callbacks(p_status text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.pelham_require_staff();
  return coalesce((
    select jsonb_agg(public.pelham_callback_json(r)
                     order by (r.status = 'open') desc, r.created_at desc)
      from (
        select * from public.pelham_callback_requests c
         where p_status is null or btrim(p_status) = '' or c.status = p_status
         order by c.created_at desc
         limit 300
      ) r
  ), '[]'::jsonb);
end;
$$;

-- 상태·메모 바꾸기. `p` 에 있는 키만 바꾼다.
create or replace function public.pelham_staff_callback_update(p_id uuid, p jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  r public.pelham_callback_requests;
  v_status text := nullif(btrim(coalesce(p->>'status', '')), '');
  v_email text;
begin
  perform public.pelham_require_staff();
  if v_status is not null and v_status not in ('open', 'called', 'closed') then
    perform public.pelham_fail('422', format('''%s'' is not a callback status', v_status));
  end if;

  select * into r from public.pelham_callback_requests where id = p_id for update;
  if r.id is null then
    perform public.pelham_fail('404', 'No such callback request');
  end if;

  select u.email into v_email from auth.users u where u.id = auth.uid();

  update public.pelham_callback_requests
     set status     = coalesce(v_status, status),
         notes      = case when p ? 'notes' then nullif(btrim(coalesce(p->>'notes', '')), '') else notes end,
         handled_at = case when v_status is null or v_status = status then handled_at
                           when v_status = 'open' then null else now() end,
         handled_by = case when v_status is null or v_status = status then handled_by
                           when v_status = 'open' then null else v_email end,
         updated_at = now()
   where id = p_id
  returning * into r;
  return public.pelham_callback_json(r);
end;
$$;

-- ===== 변경 기록(0057) — 있으면 붙인다 ==================================

do $$
begin
  if to_regprocedure('public.pelham_change_log_capture()') is not null then
    drop trigger if exists pelham_change_log on public.pelham_callback_requests;
    create trigger pelham_change_log after insert or update or delete on public.pelham_callback_requests
      for each row execute function public.pelham_change_log_capture('id');
  end if;
end;
$$;

-- ===== 권한 ==============================================================

revoke all on function public.pelham_callback_json(public.pelham_callback_requests) from public, anon, authenticated;
revoke all on function public.pelham_staff_callbacks(text) from public, anon, authenticated;
revoke all on function public.pelham_staff_callback_update(uuid, jsonb) from public, anon, authenticated;

grant execute on function public.pelham_staff_callbacks(text) to authenticated;
grant execute on function public.pelham_staff_callback_update(uuid, jsonb) to authenticated;

notify pgrst, 'reload schema';
