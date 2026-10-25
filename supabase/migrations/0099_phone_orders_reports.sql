-- 전화 비서가 받는 세 가지 — 스낵바 음식 주문, 현장 문제(카트 배터리 방전 등), 컴플레인.
--
-- 왜(2026-10-24 클럽 요청): 전화 비서는 예약·취소·분실물·콜백만 받았다. 음식 주문, "7번 홀에서 카트가 섰다",
-- 불만 접수도 전화로 들어온다. 비서가 받아 적고(`backend/services/phone_requests.py`), 직원은 화면에서 처리한다:
--
--   pelham_food_orders      — 음식 주문. 스낵바 화면(Snack Bar / Bev Cart) 위에 뜬다. 픽업은 스낵바, 결제는 픽업 때
--                             계산대에서(이 표는 계산서가 아니다 — 돈은 계산대가 받는다).
--   pelham_phone_reports    — kind = problem(현장 문제) · complaint(컴플레인). Calls & SMS 의 두 탭.
--                             문제는 접수 즉시 직원 번호로 문자가 간다(Fly secret `STAFF_ALERT_NUMBERS`, 있으면).
--
-- 메뉴는 따로 두지 않는다: 계산대의 상품 중 분류 'Food & Beverage' 이고 판매 중인 것(0005)을 비서가 읽어 준다.
-- 가격도 거기서 온다. 주문 줄에는 그때 이름·값을 복사해 둔다(나중에 상품 값이 바뀌어도 주문은 그대로).
--
-- 표는 service_role(전화 비서)만 쓴다. 직원은 아래 함수로만 본다·바꾼다.
--   pelham_staff_food_orders(p_status)              — 목록. 처리 안 된 것이 위, 최근 300건.
--   pelham_staff_food_order_update(id, p)            — status(new · ready · picked_up · cancelled)·staff_notes.
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

-- ===== 음식 주문 ==========================================================

create sequence if not exists public.pelham_food_order_seq start 101;

create table if not exists public.pelham_food_orders (
  id               uuid primary key default gen_random_uuid(),
  -- 손님과 직원이 부르는 번호. `FO-0101` 꼴.
  ticket           text not null unique
                   default ('FO-' || lpad(nextval('public.pelham_food_order_seq')::text, 4, '0')),
  first_name       text not null default '',
  last_name        text not null default '',
  phone            text not null,
  caller_number    text,
  -- [{product_id, sku, name, quantity, unit_price, note}] — 값은 센트, 주문할 때의 값.
  items            jsonb not null check (jsonb_typeof(items) = 'array' and jsonb_array_length(items) > 0),
  subtotal         integer not null check (subtotal >= 0),
  tax              integer not null check (tax >= 0),
  total            integer not null check (total >= 0),
  pickup_time      text,                   -- "at the turn", "in 20 minutes" — 손님이 말한 그대로
  notes            text,                   -- 손님 요청(알레르기 등)
  conversation_id  text,
  -- new: 접수 · ready: 준비됨 · picked_up: 가져감 · cancelled: 취소
  status           text not null default 'new' check (status in ('new', 'ready', 'picked_up', 'cancelled')),
  staff_notes      text,
  handled_at       timestamptz,
  handled_by       text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists pelham_food_orders_open_idx
  on public.pelham_food_orders (created_at) where status in ('new', 'ready');

alter table public.pelham_food_orders enable row level security;
revoke all on public.pelham_food_orders from anon, authenticated;

comment on table public.pelham_food_orders is
  '전화 음식 주문(0099). 접수는 전화 비서(service_role), 처리는 직원 함수.';

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

-- ===== 직원 함수: 음식 주문 ================================================

create or replace function public.pelham_food_order_json(r public.pelham_food_orders)
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
    'items', r.items,
    'subtotal', r.subtotal,
    'tax', r.tax,
    'total', r.total,
    'pickup_time', r.pickup_time,
    'notes', r.notes,
    'conversation_id', r.conversation_id,
    'status', r.status,
    'staff_notes', r.staff_notes,
    'handled_at', r.handled_at,
    'handled_by', r.handled_by,
    'created_at', r.created_at,
    'updated_at', r.updated_at
  )
$$;

-- 목록. 처리 안 된 것(new·ready)이 위, 그다음 최근 것. `p_status` 가 비면 전부(최근 300건),
-- 'active' 면 new·ready 만(스낵바 화면).
create or replace function public.pelham_staff_food_orders(p_status text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.pelham_require_staff();
  return coalesce((
    select jsonb_agg(public.pelham_food_order_json(r)
                     order by (r.status in ('new', 'ready')) desc, r.created_at desc)
      from (
        select * from public.pelham_food_orders o
         where p_status is null or btrim(p_status) = ''
            or (p_status = 'active' and o.status in ('new', 'ready'))
            or o.status = p_status
         order by o.created_at desc
         limit 300
      ) r
  ), '[]'::jsonb);
end;
$$;

create or replace function public.pelham_staff_food_order_update(p_id uuid, p jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  r public.pelham_food_orders;
  v_status text := nullif(btrim(coalesce(p->>'status', '')), '');
  v_email text;
begin
  perform public.pelham_require_staff();
  if v_status is not null and v_status not in ('new', 'ready', 'picked_up', 'cancelled') then
    perform public.pelham_fail('422', format('''%s'' is not a food order status', v_status));
  end if;

  select * into r from public.pelham_food_orders where id = p_id for update;
  if r.id is null then
    perform public.pelham_fail('404', 'No such food order');
  end if;

  select u.email into v_email from auth.users u where u.id = auth.uid();

  update public.pelham_food_orders
     set status      = coalesce(v_status, status),
         staff_notes = case when p ? 'staff_notes' then nullif(btrim(coalesce(p->>'staff_notes', '')), '') else staff_notes end,
         handled_at  = case when v_status is null or v_status = status then handled_at
                            when v_status = 'new' then null else now() end,
         handled_by  = case when v_status is null or v_status = status then handled_by
                            when v_status = 'new' then null else v_email end,
         updated_at  = now()
   where id = p_id
  returning * into r;
  return public.pelham_food_order_json(r);
end;
$$;

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
    drop trigger if exists pelham_change_log on public.pelham_food_orders;
    create trigger pelham_change_log after insert or update or delete on public.pelham_food_orders
      for each row execute function public.pelham_change_log_capture('id');
    drop trigger if exists pelham_change_log on public.pelham_phone_reports;
    create trigger pelham_change_log after insert or update or delete on public.pelham_phone_reports
      for each row execute function public.pelham_change_log_capture('id');
  end if;
end;
$$;

-- ===== 권한 ==============================================================

revoke all on function public.pelham_phone_report_ticket() from public, anon, authenticated;
revoke all on function public.pelham_food_order_json(public.pelham_food_orders) from public, anon, authenticated;
revoke all on function public.pelham_staff_food_orders(text) from public, anon, authenticated;
revoke all on function public.pelham_staff_food_order_update(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.pelham_phone_report_json(public.pelham_phone_reports) from public, anon, authenticated;
revoke all on function public.pelham_staff_phone_reports(text, text) from public, anon, authenticated;
revoke all on function public.pelham_staff_phone_report_update(uuid, jsonb) from public, anon, authenticated;

grant execute on function public.pelham_staff_food_orders(text) to authenticated;
grant execute on function public.pelham_staff_food_order_update(uuid, jsonb) to authenticated;
grant execute on function public.pelham_staff_phone_reports(text, text) to authenticated;
grant execute on function public.pelham_staff_phone_report_update(uuid, jsonb) to authenticated;

notify pgrst, 'reload schema';

-- ===== 확인 ============================================================

-- 전화 비서가 읽어 줄 메뉴. 비어 있으면 Snack Bar 계산대에 Food & Beverage 상품을 먼저 넣는다.
select id, name, price / 100.0 as price
  from public.pelham_retail_products
 where category = 'Food & Beverage' and is_active
 order by name;
