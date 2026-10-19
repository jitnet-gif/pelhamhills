-- 회원권 명부(`/admin/memberships`). 시즌마다 회원 한 사람(또는 부부 한 쌍)이 한 줄이다.
--
-- 왜 `pelham_customers.is_member` 로 끝내지 않나: 그 칸은 Lightspeed 내보내기에서 온
-- "지난 시즌에 회원 요금으로 쳤다" 는 흔적일 뿐, 몇 년도 회원권인지·얼마를 냈는지·카트
-- 패키지가 있는지를 담지 않는다. 그래서 그 표는 손대지 않고(임포터가 다시 덮어쓴다),
-- 시즌별 회원권은 이 표에 따로 적는다. 고객 명부에 있는 사람이면 `customer_ref` 로 잇는다.
--
-- 함수 셋:
--   pelham_staff_memberships(season)          명부
--   pelham_staff_membership_save(id, p)       새로 넣기(id 가 null) · 고치기(p 에 있는 키만)
--   pelham_staff_membership_renewals(season)  고객 명부의 회원 중 그 시즌 회원권이 아직 없는 사람
--
-- 요금은 DB 가 정하지 않는다. 화면이 `/memberships` 요금표대로 `amount_due` 를 채워 넣고
-- 직원이 고칠 수 있다 — 부부 카트 두 대, 중간 가입 할인 같은 예외를 DB 가 다 알 수 없다.

create table if not exists public.pelham_memberships (
  id              uuid primary key default gen_random_uuid(),
  season          integer not null check (season between 2020 and 2100),

  -- 고객 명부와의 연결. 명부에 없는 새 회원은 비워 둔다.
  customer_ref    text references public.pelham_customers (customer_ref) on delete set null,

  member_name     text not null,
  phone           text,
  email           text,
  member_number   text,

  -- full · weekday · intermediate · nine_hole · twilight · junior
  membership_type text not null
                  check (membership_type in ('full', 'weekday', 'intermediate', 'nine_hole', 'twilight', 'junior')),
  -- single · spousal. spousal 이면 배우자 이름을 받는다.
  plan            text not null default 'single' check (plan in ('single', 'spousal')),
  spouse_name     text,

  -- 카트 패키지(회원 전용). 비어 있으면 없음.
  cart_package    text check (cart_package in ('unlimited_7day', 'unlimited_weekday')),
  range_pass      boolean not null default false,

  amount_due      numeric(10, 2) not null default 0 check (amount_due >= 0),
  amount_paid     numeric(10, 2) not null default 0 check (amount_paid >= 0),
  paid_on         date,
  payment_method  text,

  -- pending: 신청만 받음 · active: 회원 · cancelled: 취소
  status          text not null default 'pending' check (status in ('pending', 'active', 'cancelled')),

  -- Early Bird 실내 골프 쿠폰을 쓴 시간. 받은 시간은 회원권 종류로 정해진다(화면 참고).
  sim_hours_used  numeric(4, 1) not null default 0 check (sim_hours_used >= 0),

  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- 한 사람이 같은 시즌에 두 줄 생기지 않게. 명부에 없는 회원(customer_ref 비어 있음)은 막지 않는다.
create unique index if not exists pelham_memberships_customer_season_uq
  on public.pelham_memberships (season, customer_ref) where customer_ref is not null;
create index if not exists pelham_memberships_season_idx
  on public.pelham_memberships (season, status);

-- 개인정보(이름·전화·이메일)가 들어 있다. anon 키로 읽히면 안 된다.
alter table public.pelham_memberships enable row level security;

comment on table public.pelham_memberships is
  '시즌별 회원권. 직원 함수(pelham_staff_membership*)로만 읽고 쓴다.';

-- ===== 헬퍼 ==============================================================

create or replace function public.pelham_membership_json(r public.pelham_memberships)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', r.id,
    'season', r.season,
    'customer_ref', r.customer_ref,
    'member_name', r.member_name,
    'phone', r.phone,
    'email', r.email,
    'member_number', r.member_number,
    'membership_type', r.membership_type,
    'plan', r.plan,
    'spouse_name', r.spouse_name,
    'cart_package', r.cart_package,
    'range_pass', r.range_pass,
    'amount_due', r.amount_due,
    'amount_paid', r.amount_paid,
    'paid_on', r.paid_on,
    'payment_method', r.payment_method,
    'status', r.status,
    'sim_hours_used', r.sim_hours_used,
    'notes', r.notes,
    'created_at', r.created_at,
    'updated_at', r.updated_at
  )
$$;

-- 빈 문자열은 null 로.
create or replace function public.pelham_membership_text(p jsonb, k text)
returns text
language sql
immutable
set search_path = ''
as $$
  select nullif(btrim(coalesce(p->>k, '')), '')
$$;

-- ===== 직원 함수 =========================================================

create or replace function public.pelham_staff_memberships(p_season integer)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.pelham_require_staff();
  return coalesce((
    select jsonb_agg(public.pelham_membership_json(m) order by lower(m.member_name))
      from public.pelham_memberships m
     where m.season = p_season
  ), '[]'::jsonb);
end;
$$;

-- 넣기·고치기. `p_id` 가 null 이면 새 줄(member_name · membership_type · season 필수).
-- 고칠 때는 `p` 에 들어 있는 키만 바꾼다 — 빈 문자열은 "지운다" 는 뜻이다.
create or replace function public.pelham_staff_membership_save(p_id uuid, p jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  r public.pelham_memberships;
  t text := public.pelham_membership_text(p, 'membership_type');
  v_plan text := public.pelham_membership_text(p, 'plan');
  v_status text := public.pelham_membership_text(p, 'status');
  v_cart text := public.pelham_membership_text(p, 'cart_package');
begin
  perform public.pelham_require_staff();

  if t is not null and t not in ('full', 'weekday', 'intermediate', 'nine_hole', 'twilight', 'junior') then
    perform public.pelham_fail('422', format('''%s'' is not a membership type', t));
  end if;
  if v_plan is not null and v_plan not in ('single', 'spousal') then
    perform public.pelham_fail('422', format('''%s'' is not a plan', v_plan));
  end if;
  if v_status is not null and v_status not in ('pending', 'active', 'cancelled') then
    perform public.pelham_fail('422', format('''%s'' is not a membership status', v_status));
  end if;
  if v_cart is not null and v_cart not in ('unlimited_7day', 'unlimited_weekday') then
    perform public.pelham_fail('422', format('''%s'' is not a cart package', v_cart));
  end if;
  if p ? 'member_name' and public.pelham_membership_text(p, 'member_name') is null then
    perform public.pelham_fail('422', 'Enter the member''s name.');
  end if;

  if p_id is null then
    if public.pelham_membership_text(p, 'member_name') is null then
      perform public.pelham_fail('422', 'Enter the member''s name.');
    end if;
    if t is null then
      perform public.pelham_fail('422', 'Pick a membership type.');
    end if;
    if public.pelham_membership_text(p, 'customer_ref') is not null and exists (
      select 1 from public.pelham_memberships
       where season = (p->>'season')::integer and customer_ref = p->>'customer_ref'
    ) then
      perform public.pelham_fail('409', 'This customer already has a membership for that season.');
    end if;

    insert into public.pelham_memberships (
      season, customer_ref, member_name, phone, email, member_number, membership_type, plan,
      spouse_name, cart_package, range_pass, amount_due, amount_paid, paid_on, payment_method,
      status, sim_hours_used, notes
    ) values (
      coalesce((p->>'season')::integer, extract(year from now())::integer + 1),
      public.pelham_membership_text(p, 'customer_ref'),
      public.pelham_membership_text(p, 'member_name'),
      public.pelham_membership_text(p, 'phone'),
      public.pelham_membership_text(p, 'email'),
      public.pelham_membership_text(p, 'member_number'),
      t,
      coalesce(v_plan, 'single'),
      public.pelham_membership_text(p, 'spouse_name'),
      v_cart,
      coalesce((p->>'range_pass')::boolean, false),
      coalesce(nullif(p->>'amount_due', '')::numeric, 0),
      coalesce(nullif(p->>'amount_paid', '')::numeric, 0),
      public.pelham_membership_text(p, 'paid_on')::date,
      public.pelham_membership_text(p, 'payment_method'),
      coalesce(v_status, 'pending'),
      coalesce(nullif(p->>'sim_hours_used', '')::numeric, 0),
      public.pelham_membership_text(p, 'notes')
    )
    returning * into r;
    return public.pelham_membership_json(r);
  end if;

  select * into r from public.pelham_memberships where id = p_id for update;
  if r.id is null then
    perform public.pelham_fail('404', 'No such membership');
  end if;

  update public.pelham_memberships
     set member_name     = case when p ? 'member_name' then public.pelham_membership_text(p, 'member_name') else member_name end,
         phone           = case when p ? 'phone' then public.pelham_membership_text(p, 'phone') else phone end,
         email           = case when p ? 'email' then public.pelham_membership_text(p, 'email') else email end,
         member_number   = case when p ? 'member_number' then public.pelham_membership_text(p, 'member_number') else member_number end,
         membership_type = coalesce(t, membership_type),
         plan            = coalesce(v_plan, plan),
         spouse_name     = case when p ? 'spouse_name' then public.pelham_membership_text(p, 'spouse_name') else spouse_name end,
         cart_package    = case when p ? 'cart_package' then v_cart else cart_package end,
         range_pass      = case when p ? 'range_pass' then coalesce((p->>'range_pass')::boolean, false) else range_pass end,
         amount_due      = case when p ? 'amount_due' then coalesce(nullif(p->>'amount_due', '')::numeric, 0) else amount_due end,
         amount_paid     = case when p ? 'amount_paid' then coalesce(nullif(p->>'amount_paid', '')::numeric, 0) else amount_paid end,
         paid_on         = case when p ? 'paid_on' then public.pelham_membership_text(p, 'paid_on')::date else paid_on end,
         payment_method  = case when p ? 'payment_method' then public.pelham_membership_text(p, 'payment_method') else payment_method end,
         status          = coalesce(v_status, status),
         sim_hours_used  = case when p ? 'sim_hours_used' then coalesce(nullif(p->>'sim_hours_used', '')::numeric, 0) else sim_hours_used end,
         notes           = case when p ? 'notes' then public.pelham_membership_text(p, 'notes') else notes end,
         updated_at      = now()
   where id = p_id
  returning * into r;
  return public.pelham_membership_json(r);
end;
$$;

-- 갱신 대상: 고객 명부에서 회원으로 표시된 사람 중 그 시즌 회원권 줄이 없는 사람.
-- Early Bird 마감 전에 전화를 돌리는 목록이다. `player_type` 은 지난 요금제 이름 그대로
-- ("Weekday Member - Single with Weekday Cart") — 화면이 그것으로 새 회원권을 미리 채운다.
create or replace function public.pelham_staff_membership_renewals(p_season integer)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.pelham_require_staff();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'customer_ref', c.customer_ref,
             'name', coalesce(nullif(btrim(c.display_name), ''), btrim(concat_ws(' ', c.first_name, c.last_name))),
             'phone', c.phone,
             'email', c.email,
             'member_number', c.member_number,
             'player_type', c.player_type,
             'rounds', c.rounds_booked_played
           ) order by lower(c.last_name), lower(c.first_name))
      from public.pelham_customers c
     where c.is_member
       and not exists (
         select 1 from public.pelham_memberships m
          where m.season = p_season and m.customer_ref = c.customer_ref
       )
  ), '[]'::jsonb);
end;
$$;

-- ===== 권한 ==============================================================

revoke all on function public.pelham_membership_json(public.pelham_memberships) from public, anon, authenticated;
revoke all on function public.pelham_membership_text(jsonb, text) from public, anon, authenticated;

revoke all on function public.pelham_staff_memberships(integer) from public, anon, authenticated;
revoke all on function public.pelham_staff_membership_save(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.pelham_staff_membership_renewals(integer) from public, anon, authenticated;

grant execute on function public.pelham_staff_memberships(integer) to authenticated;
grant execute on function public.pelham_staff_membership_save(uuid, jsonb) to authenticated;
grant execute on function public.pelham_staff_membership_renewals(integer) to authenticated;

notify pgrst, 'reload schema';
