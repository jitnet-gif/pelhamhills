-- 회원권 신용카드 온라인 결제(Stripe Checkout). 신청서(0041)에서 Credit card 를 고른 손님이 제출 직후
-- 결제 페이지로 넘어가 바로 낸다.
--
-- 장부의 규칙은 티타임 온라인 결제(0020·0021)와 같다:
--   - 금액은 SQL 이 정한다. 그래서 요금표를 여기로 옮긴다(`pelham_membership_price`). 신청서가 보낸 견적은
--     이제 쓰지 않는다 — 0041 의 `pelham_membership_apply` 를 다시 정의해 SQL 요금으로 `amount_due` 를 채운다.
--   - 결과는 FastAPI 가 Stripe 에 다시 물어 확인한 값만 기록한다(service_role 전용 함수).
--   - 기록할 수 없는 승인(회원권 취소됨, 이미 완납, 금액 불일치)은 `needs_reversal` 로 돌려주고 FastAPI 가 곧바로
--     환불한다. 돈만 받고 장부에 없는 상태를 남기지 않는다.
--
-- 흐름: 신청(0041) → `pelham_membership_pay_start`(pending 한 줄, invoice `PHM…`) → Checkout →
--       웹훅 또는 결과 화면(`/memberships/application/paid`)이 `pelham_membership_pay_complete`.
--
-- 요금표는 `frontend/lib/memberships.ts` 와 같은 숫자다(2027 Early Bird PDF v3, HST 포함). 바꾸면 둘 다.
--
-- 전제: 0040, 0041. 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다.

-- ===== 요금표 ============================================================

-- HST 포함 금액(달러). 카트 패키지는 한 사람 몫 하나, Full 은 연습장 포함, 신용카드면 3% 를 얹는다.
create or replace function public.pelham_membership_price(
  p_type text, p_plan text, p_cart text, p_range boolean, p_card boolean
)
returns numeric
language sql
immutable
set search_path = ''
as $$
  select round((
    case p_type
      when 'full'         then case when p_plan = 'spousal' then 5152.80 else 3051.00 end
      when 'weekday'      then case when p_plan = 'spousal' then 3955.00 else 2316.50 end
      when 'intermediate' then 2316.50
      when 'nine_hole'    then case when p_plan = 'spousal' then 2881.50 else 1638.50 end
      when 'twilight'     then case when p_plan = 'spousal' then 2881.50 else 1638.50 end
      when 'junior'       then 565.00
    end
    + case p_cart when 'unlimited_7day' then 1850.00 when 'unlimited_weekday' then 1350.00 else 0 end
    + case when coalesce(p_range, false) and p_type <> 'full' then 395.50 else 0 end
  ) * case when coalesce(p_card, false) then 1.03 else 1 end, 2)
$$;

-- ===== 신청(0041 을 다시 정의: 금액은 SQL 요금표, 결제 열쇠를 돌려준다) ============

create or replace function public.pelham_membership_apply(p jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  r public.pelham_memberships;
  v_name text := public.pelham_membership_text(p, 'member_name');
  v_phone text := public.pelham_membership_text(p, 'phone');
  v_email text := lower(public.pelham_membership_text(p, 'email'));
  v_type text := public.pelham_membership_text(p, 'membership_type');
  v_plan text := coalesce(public.pelham_membership_text(p, 'plan'), 'single');
  v_cart text := public.pelham_membership_text(p, 'cart_package');
  v_method text := public.pelham_membership_text(p, 'payment_method');
  v_range boolean := coalesce((p->>'range_pass')::boolean, false);
  v_season integer := coalesce(nullif(p->>'season', '')::integer, extract(year from now())::integer + 1);
  v_digits text;
begin
  if v_name is null or length(v_name) > 120 then
    perform public.pelham_fail('422', 'Enter your name.');
  end if;
  if v_phone is null or length(regexp_replace(v_phone, '\D', '', 'g')) < 10 then
    perform public.pelham_fail('422', 'Enter a cellphone number with area code.');
  end if;
  if v_email is null or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    perform public.pelham_fail('422', 'Enter a valid email address.');
  end if;
  if v_type is null or v_type not in ('full', 'weekday', 'intermediate', 'nine_hole', 'twilight', 'junior') then
    perform public.pelham_fail('422', 'Pick a membership category.');
  end if;
  if v_plan not in ('single', 'spousal') then
    perform public.pelham_fail('422', 'Pick single or spousal.');
  end if;
  if v_plan = 'spousal' and v_type in ('intermediate', 'junior') then
    perform public.pelham_fail('422', 'That membership is for one person only.');
  end if;
  if v_plan = 'spousal' and public.pelham_membership_text(p, 'spouse_name') is null then
    perform public.pelham_fail('422', 'Enter your spouse''s name.');
  end if;
  if v_cart is not null and v_cart not in ('unlimited_7day', 'unlimited_weekday') then
    perform public.pelham_fail('422', 'Pick a cart package.');
  end if;
  if v_method is not null and v_method not in ('Cheque', 'Credit card', 'E-transfer', 'Cash') then
    perform public.pelham_fail('422', 'Pick a payment method.');
  end if;
  if not coalesce((p->>'agreed')::boolean, false) then
    perform public.pelham_fail('422', 'Please confirm you have read the membership policies.');
  end if;
  if v_season not between extract(year from now())::integer and extract(year from now())::integer + 1 then
    perform public.pelham_fail('422', 'Applications are open for the upcoming season only.');
  end if;

  v_digits := right(regexp_replace(v_phone, '\D', '', 'g'), 10);
  if exists (
    select 1 from public.pelham_memberships m
     where m.season = v_season and m.status <> 'cancelled'
       and (lower(m.email) = v_email or right(regexp_replace(coalesce(m.phone, ''), '\D', '', 'g'), 10) = v_digits)
  ) then
    perform public.pelham_fail('409', 'We already have a membership application for you this season. The pro shop will be in touch.');
  end if;

  insert into public.pelham_memberships (
    season, member_name, phone, email, address, postal_code, membership_type, plan, spouse_name,
    cart_package, range_pass, amount_due, payment_method, status, source, notes
  ) values (
    v_season, v_name, v_phone, v_email,
    left(public.pelham_membership_text(p, 'address'), 200),
    upper(left(public.pelham_membership_text(p, 'postal_code'), 10)),
    v_type, v_plan,
    case when v_plan = 'spousal' then left(public.pelham_membership_text(p, 'spouse_name'), 120) end,
    v_cart,
    v_type <> 'full' and v_range,
    public.pelham_membership_price(v_type, v_plan, v_cart, v_range, v_method = 'Credit card'),
    v_method, 'pending', 'online',
    left(public.pelham_membership_text(p, 'notes'), 1000)
  )
  returning * into r;

  return jsonb_build_object(
    'reference', upper(left(r.id::text, 8)),
    -- 카드 결제를 여는 열쇠(무작위 uuid). 이메일과 함께 내야 결제가 열린다.
    'pay_key', r.id,
    'member_name', r.member_name,
    'season', r.season,
    'amount_due', r.amount_due,
    'payment_method', r.payment_method
  );
end;
$$;

-- ===== 결제 장부 =========================================================

create table if not exists public.pelham_membership_payments (
  id               uuid primary key default gen_random_uuid(),
  invoice          text not null unique check (invoice ~ '^PHM[0-9A-F]{12}$'),
  membership_id    uuid not null references public.pelham_memberships (id),
  amount           integer not null check (amount > 0),   -- 센트
  email            text,
  -- pending · approved · declined · error · orphaned(받았지만 기록 못 함 → 환불 대상) · refunded
  status           text not null default 'pending'
                   check (status in ('pending', 'approved', 'declined', 'error', 'orphaned', 'refunded')),
  gateway_session  text check (gateway_session is null or gateway_session ~ '^cs_[A-Za-z0-9_]{1,250}$'),
  trans_id         text check (trans_id is null or trans_id ~ '^[A-Za-z0-9_]{1,64}$'),
  refund_trans_id  text,
  auth_code        text,
  card_brand       text,
  card_last4       text,
  response_text    text,
  approved_at      timestamptz,
  refunded_at      timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists pelham_membership_payments_membership_idx
  on public.pelham_membership_payments (membership_id);
create index if not exists pelham_membership_payments_trans_idx
  on public.pelham_membership_payments (trans_id) where trans_id is not null;

alter table public.pelham_membership_payments enable row level security;

comment on table public.pelham_membership_payments is
  '회원권 온라인 카드 결제 시도. service_role(FastAPI)로만 읽고 쓴다.';

create or replace function public.pelham_membership_payment_json(o public.pelham_membership_payments)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'invoice', o.invoice,
    'amount', o.amount,
    'status', o.status,
    'card_brand', o.card_brand,
    'card_last4', o.card_last4,
    'trans_id', o.trans_id,
    'gateway_session', o.gateway_session,
    'approved_at', o.approved_at,
    'refunded_at', o.refunded_at,
    'created_at', o.created_at,
    'reference', upper(left(m.id::text, 8)),
    'member_name', m.member_name,
    'season', m.season,
    'membership_type', m.membership_type,
    'plan', m.plan,
    'membership_status', m.status,
    'balance', greatest(m.amount_due - m.amount_paid, 0)
  )
    from public.pelham_memberships m
   where m.id = o.membership_id
$$;

-- 결제 시작. 열쇠(신청 때 받은 uuid) + 신청 이메일. 남은 금액 전부를 한 번에 낸다.
create or replace function public.pelham_membership_pay_start(p_key uuid, p_email text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  m public.pelham_memberships;
  v_invoice text;
  v_cents integer;
  v_label text;
begin
  select * into m from public.pelham_memberships
   where id = p_key and lower(email) = lower(btrim(coalesce(p_email, '')))
   for update;
  if m.id is null then
    perform public.pelham_fail('404', 'We could not find that membership application.');
  end if;
  if m.status = 'cancelled' then
    perform public.pelham_fail('409', 'This membership application was cancelled. Please call the pro shop.');
  end if;
  if coalesce(m.payment_method, '') <> 'Credit card' then
    perform public.pelham_fail('409', 'This application is set to pay by ' || coalesce(m.payment_method, 'another method') || '.');
  end if;
  v_cents := round((m.amount_due - m.amount_paid) * 100)::integer;
  if v_cents <= 0 then
    perform public.pelham_fail('409', 'This membership is already paid in full.');
  end if;

  loop
    v_invoice := 'PHM' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12));
    exit when not exists (select 1 from public.pelham_membership_payments where invoice = v_invoice);
  end loop;
  insert into public.pelham_membership_payments (invoice, membership_id, amount, email)
  values (v_invoice, m.id, v_cents, m.email);

  v_label := m.season || ' ' || case m.membership_type
      when 'full' then 'Full' when 'weekday' then 'Weekday' when 'intermediate' then 'Intermediate'
      when 'nine_hole' then '9-Hole' when 'twilight' then 'Twilight' else 'Junior' end
    || ' Membership (' || initcap(m.plan) || ')';

  return jsonb_build_object(
    'invoice', v_invoice,
    'amount', v_cents,
    'email', m.email,
    'description', v_label || ' — Pelham Hills Golf Club'
  );
end;
$$;

create or replace function public.pelham_membership_pay_session(p_invoice text, p_session text)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  update public.pelham_membership_payments
     set gateway_session = p_session, updated_at = now()
   where invoice = upper(btrim(p_invoice)) and status = 'pending'
$$;

-- 한 줄: invoice 또는 PaymentIntent 로. 없으면 null.
create or replace function public.pelham_membership_payment(p jsonb)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select public.pelham_membership_payment_json(o)
    from public.pelham_membership_payments o
   where (p ? 'invoice' and o.invoice = upper(btrim(p->>'invoice')))
      or (p ? 'trans_id' and o.trans_id = p->>'trans_id')
   order by o.created_at desc
   limit 1
$$;

-- Stripe 에서 다시 읽은 결과를 기록한다. p: {invoice, trans_id, response_code('1' 승인), auth_code,
-- amount(센트), card_brand, card_last4, response_text}. 같은 결과가 두 번 와도 한 번만 반영된다.
create or replace function public.pelham_membership_pay_complete(p jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  o public.pelham_membership_payments;
  m public.pelham_memberships;
  v_trans text := nullif(btrim(coalesce(p->>'trans_id', '')), '');
  v_code text := btrim(coalesce(p->>'response_code', ''));
  v_amount integer;
  v_last4 text := nullif(right(regexp_replace(coalesce(p->>'card_last4', ''), '[^0-9]', '', 'g'), 4), '');
  v_brand text := left(nullif(btrim(coalesce(p->>'card_brand', '')), ''), 30);
  v_err text;
begin
  if v_trans is null or v_trans !~ '^[A-Za-z0-9_]{1,64}$' then
    perform public.pelham_fail('422', 'trans_id is required.');
  end if;
  begin
    v_amount := (p->>'amount')::integer;
  exception when others then
    perform public.pelham_fail('422', 'amount must be cents.');
  end;

  select * into o from public.pelham_membership_payments
   where invoice = upper(btrim(coalesce(p->>'invoice', ''))) for update;
  if o.id is null then
    perform public.pelham_fail('404', 'No membership payment with that invoice.');
  end if;

  if o.trans_id is not null and o.trans_id <> v_trans then
    return public.pelham_membership_payment_json(o) || jsonb_build_object(
      'needs_reversal', v_code = '1', 'reversal_trans_id', v_trans);
  end if;
  if o.status in ('approved', 'orphaned', 'refunded') then
    return public.pelham_membership_payment_json(o) || jsonb_build_object(
      'needs_reversal', o.status = 'orphaned', 'reversal_trans_id', case when o.status = 'orphaned' then o.trans_id end);
  end if;

  if v_code <> '1' then
    update public.pelham_membership_payments
       set status = case v_code when '2' then 'declined' else 'error' end,
           trans_id = v_trans, card_brand = v_brand, card_last4 = v_last4,
           response_text = left(p->>'response_text', 300), updated_at = now()
     where id = o.id
    returning * into o;
    return public.pelham_membership_payment_json(o) || jsonb_build_object('needs_reversal', false);
  end if;

  select * into m from public.pelham_memberships where id = o.membership_id for update;
  if v_amount is distinct from o.amount then
    v_err := format('Approved amount %s cents does not match %s.', coalesce(v_amount::text, '?'), o.amount);
  elsif m.status = 'cancelled' then
    v_err := 'The membership was cancelled.';
  elsif round((m.amount_due - m.amount_paid) * 100) < o.amount then
    -- 두 탭에서 두 번 냈거나, 그사이 프로 샵에서 받았다.
    v_err := 'The membership balance is already paid.';
  end if;

  if v_err is not null then
    update public.pelham_membership_payments
       set status = 'orphaned', trans_id = v_trans, auth_code = left(p->>'auth_code', 12),
           card_brand = v_brand, card_last4 = v_last4,
           response_text = left('Not recorded: ' || v_err, 300), updated_at = now()
     where id = o.id
    returning * into o;
    return public.pelham_membership_payment_json(o) || jsonb_build_object('needs_reversal', true, 'reversal_trans_id', v_trans);
  end if;

  update public.pelham_memberships
     set amount_paid    = amount_paid + o.amount / 100.0,
         paid_on        = (now() at time zone 'America/Toronto')::date,
         payment_method = 'Credit card',
         status         = case when amount_paid + o.amount / 100.0 >= amount_due then 'active' else status end,
         notes          = concat_ws(E'\n', notes, format('Paid online %s · %s ending %s · %s',
                            to_char(o.amount / 100.0, 'FM$999,990.00'), coalesce(v_brand, 'Card'),
                            coalesce(v_last4, '????'), o.invoice)),
         updated_at     = now()
   where id = m.id;

  update public.pelham_membership_payments
     set status = 'approved', trans_id = v_trans, auth_code = left(p->>'auth_code', 12),
         card_brand = v_brand, card_last4 = v_last4, response_text = left(p->>'response_text', 300),
         approved_at = now(), updated_at = now()
   where id = o.id
  returning * into o;
  return public.pelham_membership_payment_json(o) || jsonb_build_object('needs_reversal', false);
end;
$$;

-- 환불이 끝났다(자동 되돌림, 또는 Stripe 대시보드에서 직원이 환불 → 웹훅 charge.refunded).
-- 승인돼 회원권에 들어갔던 돈이면 회원권의 낸 금액에서 빼고, 완납이 깨지면 pending 으로 돌린다.
create or replace function public.pelham_membership_refund_finish(p_trans text, p_refund text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  o public.pelham_membership_payments;
begin
  select * into o from public.pelham_membership_payments where trans_id = p_trans for update;
  if o.id is null then
    return null;
  end if;
  if o.status = 'refunded' then
    return public.pelham_membership_payment_json(o);
  end if;
  if o.status = 'approved' then
    update public.pelham_memberships
       set amount_paid = greatest(amount_paid - o.amount / 100.0, 0),
           status      = case when status = 'active' and amount_paid - o.amount / 100.0 < amount_due then 'pending' else status end,
           notes       = concat_ws(E'\n', notes, format('Refunded %s · %s', to_char(o.amount / 100.0, 'FM$999,990.00'), o.invoice)),
           updated_at  = now()
     where id = o.membership_id;
  end if;
  update public.pelham_membership_payments
     set status = 'refunded', refund_trans_id = nullif(p_refund, ''), refunded_at = now(), updated_at = now()
   where id = o.id
  returning * into o;
  return public.pelham_membership_payment_json(o);
end;
$$;

-- ===== 권한 ==============================================================

revoke all on function public.pelham_membership_price(text, text, text, boolean, boolean) from public, anon, authenticated;
revoke all on function public.pelham_membership_payment_json(public.pelham_membership_payments) from public, anon, authenticated;
revoke all on function public.pelham_membership_pay_start(uuid, text) from public, anon, authenticated;
revoke all on function public.pelham_membership_pay_session(text, text) from public, anon, authenticated;
revoke all on function public.pelham_membership_payment(jsonb) from public, anon, authenticated;
revoke all on function public.pelham_membership_pay_complete(jsonb) from public, anon, authenticated;
revoke all on function public.pelham_membership_refund_finish(text, text) from public, anon, authenticated;

grant execute on function public.pelham_membership_pay_start(uuid, text) to service_role;
grant execute on function public.pelham_membership_pay_session(text, text) to service_role;
grant execute on function public.pelham_membership_payment(jsonb) to service_role;
grant execute on function public.pelham_membership_pay_complete(jsonb) to service_role;
grant execute on function public.pelham_membership_refund_finish(text, text) to service_role;

revoke all on function public.pelham_membership_apply(jsonb) from public;
grant execute on function public.pelham_membership_apply(jsonb) to anon, authenticated;

notify pgrst, 'reload schema';
