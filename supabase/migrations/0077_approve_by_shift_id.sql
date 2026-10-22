-- 승인(0024)을 매니저 PIN 대신 그 직원의 Pelham Shift ID 로 한다(2026-10-22 클럽 요청).
--
-- 왜: 매니저 PIN 하나(모두가 아는 번호)로는 누가 바꿨는지 남지 않는다. Charge 처럼(28df2a2) 그 자리의 직원이
-- 자기 Pelham Shift ID 를 치면 그 이름으로 승인이 남는다.
--
-- 흐름(0024 와 같고 2)만 바뀐다):
--   1) 막힌 일 → PT428 `[approval:<action>:<ref>]`.
--   2) 화면이 Shift ID 창을 띄우고 FastAPI `POST /pos/approve {code, action, ref}` 를 부른다.
--      FastAPI 가 `pelham_staff_my_id()` 로 직원 확인 → pelham-shift 에 번호의 이름을 묻고 →
--      service_role 로 `pelham_shift_approve(uid, name, action, ref)` 를 부른다(이름이 없으면 null = 틀린 번호).
--   3) 같은 직원 계정·같은 일·같은 대상에 10분 유효(0024 그대로). 화면이 원래 요청을 다시 보낸다.
--
-- 번호 확인은 pelham-shift 만 할 수 있어서 SQL 이 아니라 FastAPI 가 한다. 그래서 `pelham_shift_approve` 는
-- 브라우저(authenticated)가 부를 수 없다 — 부를 수 있으면 아무 이름으로나 승인을 만들 수 있다.
--
-- 바뀌는 것:
--   pelham_manager_approvals.staff_name — 새 칸. 승인한 직원 이름(Pelham Shift).
--   pelham_staff_my_id()                — 직원이면 auth.uid(). FastAPI 가 직원 확인과 uid 를 한 번에 얻는다.
--   pelham_shift_approve(...)           — 새 승인 함수. service_role 만.
--   pelham_require_manager(...)         — 거절 문장만 "Enter a Pelham Shift ID to approve …".
--   pelham_staff_manager_approve(pin…)  — 지운다. 매니저 PIN(pelham_managers)으로는 더 이상 승인되지 않는다.
--                                         pelham_managers 표와 옛 승인 기록은 그대로 둔다.
--
-- 틀린 번호는 0024 처럼 10분에 5번이면 그 직원 계정이 10분 동안 막힌다.
--
-- 전제: 0024, 0054. 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다.
-- **0024·0054 를 다시 실행하면 PIN 승인 함수가 되살아난다** — 그 뒤엔 이 파일을 다시 실행하면 된다.

do $$
begin
  if to_regclass('public.pelham_manager_approvals') is null then
    raise exception '0077 needs 0024 first (pelham_manager_approvals is missing).';
  end if;
end;
$$;

alter table public.pelham_manager_approvals add column if not exists staff_name text;

-- ===== 직원 확인 =======================================================

create or replace function public.pelham_staff_my_id()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.pelham_require_staff();
  return auth.uid();
end;
$$;

-- ===== 승인 ============================================================

-- FastAPI 만 부른다. p_name 이 null 이면 틀린 번호로 적는다.
create or replace function public.pelham_shift_approve(p_uid uuid, p_name text, p_action text, p_ref text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_name text := nullif(left(regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g'), 80), '');
  v_at timestamptz := now();
begin
  if p_uid is null then
    perform public.pelham_fail('401', 'Sign in with a pro shop account.');
  end if;
  if p_action is null or p_action not in ('refund', 'rain_check', 'remove_player', 'mark_unpaid', 'price', 'customer') then
    perform public.pelham_fail('422', 'Unknown approval.');
  end if;
  if coalesce(btrim(p_ref), '') = '' then
    perform public.pelham_fail('422', 'Nothing to approve.');
  end if;
  if (select count(*) from public.pelham_manager_approvals a
       where not a.ok and a.requested_by = p_uid
         and a.created_at > now() - interval '10 minutes') >= 5 then
    perform public.pelham_fail('429', 'Too many wrong IDs. Wait 10 minutes and try again.');
  end if;

  insert into public.pelham_manager_approvals (ok, staff_name, action, ref, requested_by, created_at)
  values (v_name is not null, v_name, p_action, btrim(p_ref), p_uid, v_at);

  if v_name is null then
    -- 실패 기록은 남아야 한다 — 예외로 끝내면 위 insert 가 같이 되돌려진다. 그래서 값으로 알린다.
    return jsonb_build_object('approved', false, 'message', 'No staff member has that Pelham Shift ID.');
  end if;
  return jsonb_build_object(
    'approved', true,
    'name', v_name,
    'action', p_action,
    'ref', btrim(p_ref),
    'expires_at', public.pelham_iso(v_at + interval '10 minutes'));
end;
$$;

-- 0024 와 같고 문장만 바뀐다. 꼬리표 모양은 그대로(화면이 읽는다).
create or replace function public.pelham_require_manager(p_action text, p_ref text, p_what text)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from public.pelham_manager_approvals a
              where a.ok and a.requested_by is not distinct from auth.uid()
                and a.action = p_action and a.ref = p_ref
                and a.created_at > now() - interval '10 minutes') then
    return;
  end if;
  perform public.pelham_fail('428', format('Enter a Pelham Shift ID to approve %s. [approval:%s:%s]', p_what, p_action, p_ref));
end;
$$;

drop function if exists public.pelham_staff_manager_approve(text, text, text);

-- ===== 권한 ============================================================

revoke all on function public.pelham_staff_my_id() from public, anon, authenticated;
revoke all on function public.pelham_shift_approve(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.pelham_require_manager(text, text, text) from public, anon, authenticated;
grant execute on function public.pelham_staff_my_id() to authenticated;
grant execute on function public.pelham_shift_approve(uuid, text, text, text) to service_role;

notify pgrst, 'reload schema';
