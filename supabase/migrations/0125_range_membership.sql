-- 연습장 회원권(비회원)과 회원 연습장 이용권 — 2027 Early Bird 요금표 PDF(v3) 1쪽 "ADDITIONAL GOLF SERVICES".
--
-- 왜(2026-10-27): 요금표의 추가 서비스 중 카트 패키지와 회원 연습장 이용권($395.50)은 온라인 신청서에만 있었고,
-- 비회원 연습장 회원권(DRIVING RANGE MEMBERSHIP – NON MEMBERS, $450 + HST = $508.50)은 어디에도 없었다.
--
-- 바꾸는 것:
-- - 회원권 종류에 'range'(Driving Range Membership, Non-member)를 더한다. 개인 전용, 카트 패키지·연습장 이용권 없음.
-- - `pelham_membership_price`: range = 508.50.
-- - 종류 검사: 온라인 신청(0042 `pelham_membership_apply`), Memberships 화면(0040 `pelham_staff_membership_save`),
--   레지스터 판매(0072 `pelham_staff_bill_add_membership`). 고객 폼(`pelham_staff_customer_save`)은 그대로 —
--   연습장 회원권은 Sell membership 이나 Memberships 화면에서 판다.
-- - 레지스터 판매가 회원 연습장 이용권(range_pass)을 받는다. 줄 이름 끝에 " + Range Pass".
-- - **연습장 회원은 골프 회원이 아니다.** 회원으로 읽는 곳에서 range 를 뺀다: 회원 로그인(0112), 웹 회원 이름 찾기(0109),
--   티 시트 회원 요금 동기화(0069), 직원 고객 검색(0069). 레지스터 판매는 명부의 is_member·player_type 을 바꾸지 않는다.
--   회원 요금제 이름(`pelham_membership_rate_plan`, 0053)은 range 에 빈 값을 주므로 회원 그린피·카트 요금(0122)도 받지 않는다.
--
-- 함수 본문은 위 마이그레이션의 최신 정의를 그대로 옮기고 위 줄들만 바꿨다.
-- 전제: 0040, 0042, 0053, 0069, 0072, 0109, 0112. 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다.

do $$
declare
  c record;
begin
  if to_regprocedure('public.pelham_staff_bill_add_membership(bigint, jsonb)') is null then
    raise exception '0125 needs 0072 first (pelham_staff_bill_add_membership is missing).';
  end if;
  if to_regprocedure('public.pelham_member_live_membership(public.pelham_member_logins, date)') is null then
    raise exception '0125 needs 0111/0112 first (pelham_member_live_membership is missing).';
  end if;
  if to_regprocedure('public.pelham_tee_member_lookup(text)') is null then
    raise exception '0125 needs 0109 first (pelham_tee_member_lookup is missing).';
  end if;
  -- 0040 의 이름 없는 check(membership_type in (...))를 지우고 이름을 붙여 다시 만든다.
  for c in
    select con.conname from pg_constraint con
     where con.conrelid = 'public.pelham_memberships'::regclass and con.contype = 'c'
       and pg_get_constraintdef(con.oid) ilike '%membership_type%'
  loop
    execute format('alter table public.pelham_memberships drop constraint %I', c.conname);
  end loop;
end;
$$;

alter table public.pelham_memberships
  add constraint pelham_memberships_membership_type_check
  check (membership_type in ('full', 'weekday', 'intermediate', 'nine_hole', 'twilight', 'junior', 'range'));

-- ===== 요금 ==============================================================

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
      when 'range'        then 508.50
    end
    + case when p_type = 'range' then 0
           else case p_cart when 'unlimited_7day' then 1850.00 when 'unlimited_weekday' then 1350.00 else 0 end end
    + case when coalesce(p_range, false) and p_type not in ('full', 'range') then 395.50 else 0 end
  ) * case when coalesce(p_card, false) then 1.03 else 1 end, 2)
$$;

-- ===== 종류 검사 =========================================================

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
  if v_type is null or v_type not in ('full', 'weekday', 'intermediate', 'nine_hole', 'twilight', 'junior', 'range') then
    perform public.pelham_fail('422', 'Pick a membership category.');
  end if;
  if v_plan not in ('single', 'spousal') then
    perform public.pelham_fail('422', 'Pick single or spousal.');
  end if;
  if v_plan = 'spousal' and v_type in ('intermediate', 'junior', 'range') then
    perform public.pelham_fail('422', 'That membership is for one person only.');
  end if;
  if v_plan = 'spousal' and public.pelham_membership_text(p, 'spouse_name') is null then
    perform public.pelham_fail('422', 'Enter your spouse''s name.');
  end if;
  if v_cart is not null and v_cart not in ('unlimited_7day', 'unlimited_weekday') then
    perform public.pelham_fail('422', 'Pick a cart package.');
  end if;
  -- 연습장 회원권(0125)은 골프 회원권이 아니다: 카트 패키지(회원 전용)도, 연습장 이용권(이미 연습장)도 없다.
  if v_type = 'range' then
    v_cart := null;
    v_range := false;
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
    v_type not in ('full', 'range') and v_range,
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

  if t is not null and t not in ('full', 'weekday', 'intermediate', 'nine_hole', 'twilight', 'junior', 'range') then
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
      season, customer_ref, member_name, phone, email, member_number, address, postal_code, membership_type, plan,
      spouse_name, cart_package, range_pass, amount_due, amount_paid, paid_on, payment_method,
      status, sim_hours_used, notes
    ) values (
      coalesce((p->>'season')::integer, extract(year from now())::integer + 1),
      public.pelham_membership_text(p, 'customer_ref'),
      public.pelham_membership_text(p, 'member_name'),
      public.pelham_membership_text(p, 'phone'),
      public.pelham_membership_text(p, 'email'),
      public.pelham_membership_text(p, 'member_number'),
      public.pelham_membership_text(p, 'address'),
      upper(public.pelham_membership_text(p, 'postal_code')),
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
         address         = case when p ? 'address' then public.pelham_membership_text(p, 'address') else address end,
         postal_code     = case when p ? 'postal_code' then upper(public.pelham_membership_text(p, 'postal_code')) else postal_code end,
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

create or replace function public.pelham_staff_bill_add_membership(p_bill bigint, p jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_ref text := nullif(btrim(coalesce(p->>'customer_ref', '')), '');
  v_type text := nullif(btrim(coalesce(p->>'membership_type', '')), '');
  v_plan text := coalesce(nullif(btrim(coalesce(p->>'plan', '')), ''), 'single');
  v_cart text := nullif(btrim(coalesce(p->>'cart_package', '')), '');
  -- 회원 연습장 이용권(0125). Full 은 연습장 포함, 연습장 회원권은 그 자체가 연습장이라 없다.
  v_range boolean := coalesce(p->>'range_pass', '') = 'true';
  v_season integer;
  v_expires date;
  v_starts date;
  v_card boolean := coalesce(p->>'card_fee', '') = 'true';
  v_c public.pelham_customers;
  v_row public.pelham_memberships;
  v_name text;
  v_price integer;
  v_label text;
begin
  perform public.pelham_require_staff();
  perform public.pelham_pos_lock_open(p_bill);
  p := coalesce(p, '{}'::jsonb);

  select * into v_c from public.pelham_customers c where c.customer_ref = v_ref;
  if v_c.customer_ref is null then
    perform public.pelham_fail('404', format('Customer %s was not found.', coalesce(v_ref, '')));
  end if;
  if coalesce(p->>'season', '') !~ '^\d{4}$' then
    perform public.pelham_fail('422', 'Pick a membership season.');
  end if;
  v_season := (p->>'season')::integer;
  if v_type is null or v_type not in ('full', 'weekday', 'intermediate', 'nine_hole', 'twilight', 'junior', 'range') then
    perform public.pelham_fail('422', 'Pick a membership.');
  end if;
  if v_plan not in ('single', 'spousal') then
    perform public.pelham_fail('422', format('''%s'' is not a plan.', v_plan));
  end if;
  if v_type in ('intermediate', 'junior', 'range') then
    v_plan := 'single';
  end if;
  if v_type = 'range' then
    v_cart := null;
  end if;
  if v_type in ('full', 'range') then
    v_range := false;
  end if;
  if v_cart is not null and v_cart not in ('unlimited_7day', 'unlimited_weekday') then
    perform public.pelham_fail('422', format('''%s'' is not a cart package.', v_cart));
  end if;
  if coalesce(p->>'expires_on', '') <> '' then
    if p->>'expires_on' !~ '^\d{4}-\d{2}-\d{2}$' then
      perform public.pelham_fail('422', format('''%s'' is not a date.', p->>'expires_on'));
    end if;
    v_expires := (p->>'expires_on')::date;
    if v_expires < public.pelham_local_now()::date then
      perform public.pelham_fail('422', 'The end date is already past.');
    end if;
  end if;
  -- 시작일. 비우면 오늘(클럽 날짜).
  if coalesce(p->>'starts_on', '') <> '' then
    if p->>'starts_on' !~ '^\d{4}-\d{2}-\d{2}$' then
      perform public.pelham_fail('422', format('''%s'' is not a date.', p->>'starts_on'));
    end if;
    v_starts := (p->>'starts_on')::date;
  else
    v_starts := public.pelham_local_now()::date;
  end if;
  if v_expires is not null and v_starts > v_expires then
    perform public.pelham_fail('422', 'The start date is after the end date.');
  end if;

  v_name := coalesce(nullif(btrim(v_c.display_name), ''), btrim(concat_ws(' ', v_c.first_name, v_c.last_name)));

  select * into v_row from public.pelham_memberships m
   where m.customer_ref = v_ref and m.season = v_season
   for update;

  if v_row.id is null then
    insert into public.pelham_memberships (
      season, customer_ref, member_name, phone, email, member_number, address, postal_code,
      membership_type, plan, cart_package, range_pass, amount_due, status, starts_on, expires_on, source)
    values (
      v_season, v_ref, v_name, v_c.phone, v_c.email, v_c.member_number,
      nullif(concat_ws(', ', v_c.address_line1, v_c.city), ''), v_c.postal_code,
      v_type, v_plan, v_cart, v_range,
      coalesce(public.pelham_membership_price(v_type, v_plan, v_cart, v_range, false), 0),
      'pending', v_starts, v_expires, 'staff')
    returning * into v_row;
  else
    -- 이미 돈을 받은 회원권의 종류를 레지스터에서 바꾸지 않는다(차액 계산은 Memberships 화면에서).
    if v_row.status <> 'cancelled' and v_row.amount_paid > 0
       and (v_row.membership_type is distinct from v_type or v_row.plan is distinct from v_plan
            or v_row.cart_package is distinct from v_cart or v_row.range_pass is distinct from v_range) then
      perform public.pelham_fail('409', format(
        '%s already paid %s toward a different %s membership. Change it on Memberships.',
        v_name, to_char(v_row.amount_paid, 'FM$999,990.00'), v_season));
    end if;
    update public.pelham_memberships m
       set membership_type = v_type,
           plan = v_plan,
           cart_package = v_cart,
           range_pass = v_range,
           amount_due = case
                          when m.membership_type is distinct from v_type or m.plan is distinct from v_plan
                            or m.cart_package is distinct from v_cart or m.range_pass is distinct from v_range
                            or m.status = 'cancelled'
                          then coalesce(public.pelham_membership_price(v_type, v_plan, v_cart, v_range, false),
                                        m.amount_due)
                          -- 고객 폼에서 'Credit card' 로 넣어 3% 가 이미 붙은 채 안 낸 회원권: 수수료는 줄이 정한다.
                          when m.amount_paid = 0 and m.payment_method = 'Credit card'
                            and m.amount_due = public.pelham_membership_price(v_type, v_plan, v_cart, v_range, true)
                          then coalesce(public.pelham_membership_price(v_type, v_plan, v_cart, v_range, false),
                                        m.amount_due)
                          else m.amount_due
                        end,
           amount_paid = case when m.status = 'cancelled' then 0 else m.amount_paid end,
           status = case when m.status = 'cancelled' then 'pending' else m.status end,
           starts_on = v_starts,
           expires_on = coalesce(v_expires, m.expires_on),
           updated_at = now()
     where m.id = v_row.id
    returning * into v_row;
  end if;

  v_price := public.pelham_pos_membership_line_price(v_row.id, v_card);
  if v_price is null then
    perform public.pelham_fail('409', format('%s''s %s membership is already paid in full.', v_name, v_season));
  end if;

  if v_type = 'range' then
    v_label := format('%s Driving Range Membership (Non-member)', v_season);
  else
    v_label := format('%s %s %s Membership%s%s',
      v_season,
      case v_type when 'full' then 'Full' when 'weekday' then 'Weekday' when 'intermediate' then 'Intermediate'
                  when 'nine_hole' then '9 Hole' when 'twilight' then 'Twilight' else 'Junior' end,
      case v_plan when 'spousal' then 'Spousal' else 'Single' end,
      case v_cart when 'unlimited_7day' then ' with 7 Day Cart' when 'unlimited_weekday' then ' with Weekday Cart' else '' end,
      case when v_range then ' + Range Pass' else '' end);
  end if;

  -- 같은 회원권을 다시 담으면 줄을 새로 쓴다(종류를 바꿨을 수 있다).
  delete from public.pelham_bill_lines where bill_id = p_bill and kind = 'membership' and membership_id = v_row.id;
  insert into public.pelham_bill_lines (bill_id, kind, sku, name, category, quantity, unit_price, line_total, membership_id)
  values (p_bill, 'membership', case when v_card then 'MEMBERSHIP-CC' else 'MEMBERSHIP' end, left(format('%s · %s', v_label, v_name), 120), 'Memberships',
          1, v_price, v_price, v_row.id);

  -- 명부의 회원 표시를 맞춘다(0070 customer_save 와 같다). 티시트 검색(0053)이 읽는다.
  update public.pelham_customers c
     set is_member = true,
         player_type = coalesce(public.pelham_membership_rate_plan(v_type, v_cart), c.player_type)
   where c.customer_ref = v_ref
     and v_type <> 'range'  -- 연습장 회원은 골프 회원이 아니다(0125).
     and v_season >= coalesce((select max(m.season) from public.pelham_memberships m
                                where m.customer_ref = v_ref and m.status <> 'cancelled'
                                  and m.membership_type <> 'range'), v_season);

  perform public.pelham_pos_recalc(p_bill);
  return public.pelham_pos_bill_json(p_bill);
end;
$$;

-- ===== 회원 판정: 연습장 회원권은 빼고 ======================================

create or replace function public.pelham_member_live_membership(p_login public.pelham_member_logins, p_on date)
returns public.pelham_memberships
language sql
stable
security definer
set search_path = ''
as $$
  select m.*
    from public.pelham_memberships m
   where p_login.kind = 'member'
     and m.status <> 'cancelled'
     and m.membership_type <> 'range'
     and (m.expires_on is null or m.expires_on >= p_on)
     and (case when p_login.customer_ref is not null
               then m.customer_ref = p_login.customer_ref
               else m.customer_ref is null and lower(btrim(m.member_name)) = lower(btrim(p_login.member_name)) end
          or m.id = p_login.membership_id)
   order by m.season desc, m.created_at desc
   limit 1;
$$;

create or replace function public.pelham_tee_member_lookup(p_query text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_q text := lower(btrim(coalesce(p_query, '')));
  v_words text[];
  v_today date := public.pelham_local_now()::date;
begin
  if length(v_q) < 3 or length(v_q) > 80 then
    return '[]'::jsonb;
  end if;
  v_words := regexp_split_to_array(v_q, '\s+');

  return coalesce((
    with live as (
      -- 사람마다(명부 번호, 없으면 이름) 가장 최근 시즌 회원권 하나. 0053 검색과 같은 줄을 고른다.
      select distinct on (coalesce(m.customer_ref, lower(btrim(m.member_name))))
             m.id, m.season, m.membership_type, m.expires_on,
             coalesce(nullif(btrim(c.display_name), ''),
                      nullif(btrim(concat_ws(' ', c.first_name, c.last_name)), ''),
                      btrim(m.member_name)) as name,
             lower(concat_ws(' ', m.member_name, c.display_name, c.first_name, c.last_name)) as haystack
        from public.pelham_memberships m
        left join public.pelham_customers c on c.customer_ref = m.customer_ref
       where m.status <> 'cancelled' and m.membership_type <> 'range'
       order by coalesce(m.customer_ref, lower(btrim(m.member_name))), m.season desc, m.created_at desc
    ),
    hits as (
      select l.*
        from live l
       where (l.expires_on is null or l.expires_on >= v_today)
         and (select bool_and(l.haystack like '%' || w || '%') from unnest(v_words) w)
       order by lower(l.name)
       limit 6
    )
    select jsonb_agg(jsonb_build_object(
             'ref', h.id,
             'name', h.name,
             'membershipType', h.membership_type,
             'season', h.season
           ) order by lower(h.name))
      from hits h
  ), '[]'::jsonb);
end;
$$;

create or replace function public.pelham_tee_sync_member(p_ref text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_today date := public.pelham_local_now()::date;
  v_m public.pelham_memberships;
  r record;
  v_players jsonb;
  pl jsonb;
  v_plan text;
  v_want text;
begin
  if nullif(btrim(coalesce(p_ref, '')), '') is null then
    return;
  end if;
  -- 0053 검색과 같은 줄: 가장 최근 시즌 회원권(취소 제외).
  select * into v_m from public.pelham_memberships m
   where m.customer_ref = p_ref and m.status <> 'cancelled' and m.membership_type <> 'range'
   order by m.season desc, m.created_at desc
   limit 1;

  for r in
    select t.id, t.booking_date, t.doc from public.pelham_tee_bookings t
     where t.booking_date >= v_today
       and coalesce(t.status, '') not in ('cancelled', 'blocked')
       and jsonb_typeof(t.doc->'players') = 'array'
       and exists (select 1 from jsonb_array_elements(t.doc->'players') x where x.value->>'customerRef' = p_ref)
     for update
  loop
    v_want := case
                when v_m.id is not null and (v_m.expires_on is null or v_m.expires_on >= r.booking_date)
                then nullif(public.pelham_membership_rate_plan(v_m.membership_type, v_m.cart_package), '')
              end;
    v_players := '[]'::jsonb;
    for pl in select value from jsonb_array_elements(r.doc->'players') loop
      if pl->>'customerRef' = p_ref
         and not coalesce((pl->>'paid')::boolean, false)
         and not coalesce((pl->>'cancelled')::boolean, false) then
        v_plan := btrim(coalesce(pl->>'ratePlan', ''));
        if v_want is not null then
          pl := pl || jsonb_build_object('ratePlan', v_want);
        elsif v_plan ilike '%member%' then
          pl := pl || jsonb_build_object('ratePlan', 'Public');
        end if;
      end if;
      v_players := v_players || jsonb_build_array(pl);
    end loop;

    if v_players is distinct from r.doc->'players' then
      update public.pelham_tee_bookings t
         set doc = jsonb_set(t.doc, '{players}', v_players),
             synced_at = now()
       where t.id = r.id;
    end if;
  end loop;
end;
$$;

create or replace function public.pelham_staff_customer_search(p_query text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_q text := lower(btrim(coalesce(p_query, '')));
  v_words text[];
  v_digits text := regexp_replace(coalesce(p_query, ''), '\D', '', 'g');
begin
  perform public.pelham_require_staff();
  if length(v_q) < 2 then
    return '[]'::jsonb;
  end if;
  v_words := regexp_split_to_array(v_q, '\s+');

  return coalesce((
    with people as (
      -- 고객 명부 + 가장 최근 시즌 회원권(취소 제외).
      select c.customer_ref,
             coalesce(nullif(btrim(c.first_name), ''), '') as first_name,
             coalesce(nullif(btrim(c.last_name), ''), '') as last_name,
             coalesce(nullif(btrim(c.display_name), ''), btrim(concat_ws(' ', c.first_name, c.last_name))) as name,
             coalesce(c.email, '') as email,
             coalesce(c.phone, '') as phone,
             coalesce(nullif(btrim(m.member_number), ''), nullif(btrim(c.member_number), ''), '') as member_number,
             case when m.expires_on < public.pelham_local_now()::date then false
                  else (c.is_member or m.id is not null) end as is_member,
             m.season,
             m.membership_type,
             m.status as membership_status,
             m.expires_on,
             case when m.expires_on < public.pelham_local_now()::date then ''
                  else coalesce(nullif(public.pelham_membership_rate_plan(m.membership_type, m.cart_package), ''),
                                case when c.is_member and c.player_type ilike '%member%' then btrim(c.player_type) end,
                                '') end as rate_plan,
             coalesce(c.rounds_booked_played, 0) as rounds
        from public.pelham_customers c
        left join lateral (
          select x.* from public.pelham_memberships x
           where x.customer_ref = c.customer_ref and x.status <> 'cancelled' and x.membership_type <> 'range'
           order by x.season desc, x.created_at desc
           limit 1
        ) m on true
      union all
      -- 명부에 아직 없는 새 회원(회원권 줄만 있다). 이름 하나를 첫 단어 / 나머지로 나눈다.
      select null,
             split_part(btrim(m.member_name), ' ', 1),
             btrim(substr(btrim(m.member_name), length(split_part(btrim(m.member_name), ' ', 1)) + 1)),
             btrim(m.member_name),
             coalesce(m.email, ''),
             coalesce(m.phone, ''),
             coalesce(nullif(btrim(m.member_number), ''), ''),
             coalesce(m.expires_on >= public.pelham_local_now()::date, true),
             m.season,
             m.membership_type,
             m.status,
             m.expires_on,
             case when m.expires_on < public.pelham_local_now()::date then ''
                  else public.pelham_membership_rate_plan(m.membership_type, m.cart_package) end,
             0
        from (
          select distinct on (lower(btrim(x.member_name))) x.*
            from public.pelham_memberships x
           where x.customer_ref is null and x.status <> 'cancelled' and x.membership_type <> 'range'
           order by lower(btrim(x.member_name)), x.season desc, x.created_at desc
        ) m
    ),
    hits as (
      select p.*
        from people p
       where (
               -- 모든 단어가 이름 어딘가에 들어 있다("park kw" → Kwangseob Park).
               (select bool_and(lower(concat_ws(' ', p.name, p.first_name, p.last_name)) like '%' || w || '%')
                  from unnest(v_words) w)
               or lower(p.member_number) = v_q
               or (length(v_digits) >= 4 and v_digits = v_q
                   and regexp_replace(p.phone, '\D', '', 'g') like '%' || v_digits)
             )
       order by p.is_member desc, p.rounds desc, lower(p.last_name), lower(p.first_name)
       limit 10
    )
    select jsonb_agg(jsonb_build_object(
             'customerRef', h.customer_ref,
             'name', h.name,
             'firstName', h.first_name,
             'lastName', h.last_name,
             'email', h.email,
             'phone', h.phone,
             'memberNumber', h.member_number,
             'isMember', h.is_member,
             'season', h.season,
             'membershipType', h.membership_type,
             'membershipStatus', h.membership_status,
             'ratePlan', h.rate_plan,
             'expiresOn', h.expires_on,
             'rounds', h.rounds
           ))
      from hits h
  ), '[]'::jsonb);
end;
$$;

notify pgrst, 'reload schema';
