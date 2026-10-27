-- 고객 화면(Customers) 편집 폼의 회원권 칸에서 비회원 연습장 회원권(range, 0125)을 등록한다.
--
-- 왜(2026-10-27): 0125 는 연습장 회원권을 온라인 신청·Memberships 화면·Sell membership 에만 열었다.
-- 고객 파일에서 회원 등록하는 칸(`pelham_staff_customer_save`, 0072)은 range 를 'not a membership type' 으로 막았다.
--
-- 바꾸는 것(`pelham_staff_customer_save` — 0072 정의를 그대로 옮기고 아래만 바꿨다):
-- - 종류 검사에 'range'. range 는 개인 전용(single), 카트 패키지·회원 연습장 이용권 없음.
-- - **연습장 회원은 골프 회원이 아니다**(0125): 명부의 is_member·player_type 은 range 를 빼고 센다.
--   연습장 회원권만 있는 고객은 is_member = false, 티 시트는 일반 요금.
--
-- 전제: 0072, 0125. 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다.

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'pelham_memberships_membership_type_check'
       and pg_get_constraintdef(oid) ilike '%range%'
  ) then
    raise exception '0126 needs 0125 first (membership type ''range'' is not allowed yet).';
  end if;
end;
$$;

create or replace function public.pelham_staff_customer_save(p_ref text, p jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_ref text := nullif(btrim(coalesce(p_ref, '')), '');
  v_first text := nullif(btrim(coalesce(p->>'first_name', '')), '');
  v_last text := nullif(btrim(coalesce(p->>'last_name', '')), '');
  v_phone text := regexp_replace(coalesce(p->>'phone', ''), '\D', '', 'g');
  v_email text := nullif(lower(btrim(coalesce(p->>'email', ''))), '');
  v_address text := nullif(btrim(coalesce(p->>'address_line1', '')), '');
  v_city text := nullif(btrim(coalesce(p->>'city', '')), '');
  v_postal text := nullif(upper(regexp_replace(coalesce(p->>'postal_code', ''), '\s', '', 'g')), '');
  v_number text := nullif(btrim(coalesce(p->>'member_number', '')), '');
  v_reasons text[];
  -- 회원권
  v_has_m boolean := jsonb_typeof(p->'membership') = 'object';
  v_m jsonb := case when jsonb_typeof(p->'membership') = 'object' then p->'membership' else '{}'::jsonb end;
  v_season integer;
  v_type text := nullif(btrim(coalesce(v_m->>'membership_type', '')), '');
  v_plan text := coalesce(nullif(btrim(coalesce(v_m->>'plan', '')), ''), 'single');
  v_cart text := nullif(btrim(coalesce(v_m->>'cart_package', '')), '');
  v_status text := coalesce(nullif(btrim(coalesce(v_m->>'status', '')), ''), 'pending');
  v_expires date;
  v_has_starts boolean := v_m ? 'starts_on';
  v_starts date;
  v_has_method boolean := v_m ? 'payment_method';
  v_method text := nullif(btrim(coalesce(v_m->>'payment_method', '')), '');
  v_name text;
  v_row public.pelham_memberships;
begin
  perform public.pelham_require_staff();
  if p is null or jsonb_typeof(p) <> 'object' then
    perform public.pelham_fail('422', 'Nothing to save.');
  end if;
  if v_ref is not null and not exists (select 1 from public.pelham_customers c where c.customer_ref = v_ref) then
    perform public.pelham_fail('404', format('Customer %s was not found.', v_ref));
  end if;

  if v_first is null and v_last is null then
    perform public.pelham_fail('422', 'Give the customer a first or last name.');
  end if;
  if length(v_phone) = 11 and left(v_phone, 1) = '1' then
    v_phone := substr(v_phone, 2);
  end if;
  if v_phone = '' then
    v_phone := null;
  elsif length(v_phone) <> 10 then
    perform public.pelham_fail('422', 'A phone number has 10 digits.');
  end if;
  if v_email is not null and v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    perform public.pelham_fail('422', format('''%s'' is not an email address.', v_email));
  end if;
  if v_postal is not null then
    if v_postal ~ '^[A-Z]\d[A-Z]\d[A-Z]\d$' then
      v_postal := left(v_postal, 3) || ' ' || right(v_postal, 3);
    elsif v_postal !~ '^\d{5}(-?\d{4})?$' then
      perform public.pelham_fail('422', format('''%s'' is not a postal code.', p->>'postal_code'));
    end if;
  end if;

  if v_has_m then
    if coalesce(v_m->>'season', '') !~ '^\d{4}$' then
      perform public.pelham_fail('422', 'Pick a membership season.');
    end if;
    v_season := (v_m->>'season')::integer;
    if v_type is not null and v_type not in ('full', 'weekday', 'intermediate', 'nine_hole', 'twilight', 'junior', 'range') then
      perform public.pelham_fail('422', format('''%s'' is not a membership type.', v_type));
    end if;
    if v_plan not in ('single', 'spousal') then
      perform public.pelham_fail('422', format('''%s'' is not a plan.', v_plan));
    end if;
    if v_cart is not null and v_cart not in ('unlimited_7day', 'unlimited_weekday') then
      perform public.pelham_fail('422', format('''%s'' is not a cart package.', v_cart));
    end if;
    if v_status not in ('pending', 'active') then
      perform public.pelham_fail('422', format('''%s'' is not a membership status.', v_status));
    end if;
    -- 만료일. 빈칸이면 만료일 없음(null).
    if coalesce(v_m->>'expires_on', '') <> '' then
      if v_m->>'expires_on' !~ '^\d{4}-\d{2}-\d{2}$' then
        perform public.pelham_fail('422', format('''%s'' is not a date.', v_m->>'expires_on'));
      end if;
      v_expires := (v_m->>'expires_on')::date;
    end if;
    -- 시작일(0072). 빈칸이면 없음(null). 키가 없으면 그대로 둔다.
    if coalesce(v_m->>'starts_on', '') <> '' then
      if v_m->>'starts_on' !~ '^\d{4}-\d{2}-\d{2}$' then
        perform public.pelham_fail('422', format('''%s'' is not a date.', v_m->>'starts_on'));
      end if;
      v_starts := (v_m->>'starts_on')::date;
    end if;
    if v_starts is not null and v_expires is not null and v_starts > v_expires then
      perform public.pelham_fail('422', 'The start date is after the end date.');
    end if;
    if v_method is not null and v_method not in ('Cheque', 'Credit card', 'E-transfer', 'Cash') then
      perform public.pelham_fail('422', format('''%s'' is not a payment method.', v_method));
    end if;
    -- 개인 전용 회원권(Intermediate·Junior·연습장)은 spousal 이 없다.
    if v_type in ('intermediate', 'junior', 'range') then
      v_plan := 'single';
    end if;
    -- 연습장 회원권(0125)에는 카트 패키지(회원 전용)가 없다.
    if v_type = 'range' then
      v_cart := null;
    end if;
  end if;

  perform public.pelham_require_manager('customer', coalesce(v_ref, 'new'),
                                        case when v_ref is null then 'adding a customer' else 'editing this customer' end);

  if v_ref is null then
    loop
      v_ref := 'PH' || lpad(nextval('public.pelham_customer_ref_seq')::text, 5, '0');
      exit when not exists (select 1 from public.pelham_customers c where c.customer_ref = v_ref);
    end loop;
    insert into public.pelham_customers (
      customer_ref, first_name, last_name, display_name, email, phone, address_line1, city,
      postal_code, member_number, user_created_on, source, provenance)
    values (
      v_ref, v_first, v_last, btrim(concat_ws(' ', v_first, v_last)), v_email, v_phone, v_address, v_city,
      v_postal, v_number, public.pelham_local_now()::date, 'staff',
      jsonb_build_object('created_by', (select lower(u.email) from auth.users u where u.id = auth.uid())));
  else
    -- 고친 칸의 검토 사유만 지운다. 중복 의심·중복 계정은 남긴다.
    select array(
             select r from unnest(c.review_reasons) r
              where not (r = 'first_name_missing' and v_first is not null)
                and not (r = 'last_name_missing' and v_last is not null)
                and not (r = 'email_unparsed' and v_email is distinct from c.email)
                and not (r = 'phone_unparsed' and v_phone is distinct from c.phone)
                and not (r = 'postal_unparsed' and v_postal is distinct from c.postal_code))
      into v_reasons
      from public.pelham_customers c where c.customer_ref = v_ref;

    update public.pelham_customers c
       set first_name = v_first,
           last_name = v_last,
           display_name = btrim(concat_ws(' ', v_first, v_last)),
           email = v_email,
           phone = v_phone,
           address_line1 = v_address,
           city = v_city,
           postal_code = v_postal,
           member_number = v_number,
           review_reasons = v_reasons,
           needs_review = cardinality(v_reasons) > 0 or cardinality(c.possible_duplicate_of) > 0
     where c.customer_ref = v_ref;
  end if;

  -- ===== 회원권 =====
  if v_has_m then
    v_name := btrim(concat_ws(' ', v_first, v_last));
    select * into v_row from public.pelham_memberships m
     where m.customer_ref = v_ref and m.season = v_season
     for update;

    if v_type is null then
      if v_row.id is not null and v_row.status <> 'cancelled' then
        update public.pelham_memberships set status = 'cancelled', updated_at = now() where id = v_row.id;
      end if;
    elsif v_row.id is null then
      insert into public.pelham_memberships (
        season, customer_ref, member_name, phone, email, member_number, address, postal_code,
        membership_type, plan, cart_package, amount_due, status, starts_on, expires_on, payment_method)
      values (
        v_season, v_ref, v_name, v_phone, v_email, v_number,
        nullif(concat_ws(', ', v_address, v_city), ''), v_postal,
        v_type, v_plan, v_cart,
        coalesce(public.pelham_membership_price(v_type, v_plan, v_cart, false, coalesce(v_method = 'Credit card', false)), 0),
        v_status, v_starts, v_expires, v_method);
    else
      if not v_has_method then
        v_method := v_row.payment_method;
      end if;
      if not v_has_starts then
        v_starts := v_row.starts_on;
      end if;
      update public.pelham_memberships m
         set member_name = v_name,
             phone = v_phone,
             email = v_email,
             member_number = v_number,
             address = coalesce(nullif(concat_ws(', ', v_address, v_city), ''), m.address),
             postal_code = coalesce(v_postal, m.postal_code),
             membership_type = v_type,
             plan = v_plan,
             cart_package = v_cart,
             -- 연습장 회원권은 그 자체가 연습장이라 회원 연습장 이용권을 달지 않는다(0125).
             range_pass = case when v_type = 'range' then false else m.range_pass end,
             payment_method = v_method,
             -- 종류·플랜·카트·결제 수단이 바뀌었을 때만 요금표로 다시 센다(직원이 고친 금액을 지키려고).
             amount_due = case
                            when m.membership_type is distinct from v_type or m.plan is distinct from v_plan
                              or m.cart_package is distinct from v_cart or m.status = 'cancelled'
                              or m.payment_method is distinct from v_method
                            then coalesce(public.pelham_membership_price(v_type, v_plan, v_cart,
                                                                         v_type <> 'range' and m.range_pass,
                                                                         coalesce(v_method = 'Credit card', false)), m.amount_due)
                            else m.amount_due
                          end,
             status = v_status,
             starts_on = v_starts,
             expires_on = v_expires,
             updated_at = now()
       where m.id = v_row.id;
    end if;

    -- 명부의 회원 표시를 맞춘다. 티시트 검색(0053)은 player_type 을 요금제 이름으로도 읽는다.
    -- 연습장 회원은 골프 회원이 아니다(0125) — range 회원권은 세지 않는다.
    update public.pelham_customers c
       set is_member = exists (select 1 from public.pelham_memberships m
                                where m.customer_ref = c.customer_ref and m.status <> 'cancelled'
                                  and m.membership_type <> 'range'),
           player_type = coalesce(
             (select public.pelham_membership_rate_plan(m.membership_type, m.cart_package)
                from public.pelham_memberships m
               where m.customer_ref = c.customer_ref and m.status <> 'cancelled'
                 and m.membership_type <> 'range'
               order by m.season desc limit 1),
             c.player_type)
     where c.customer_ref = v_ref;
  end if;

  return jsonb_build_object('customer_ref', v_ref);
end;
$$;

revoke all on function public.pelham_staff_customer_save(text, jsonb) from public, anon, authenticated;
grant execute on function public.pelham_staff_customer_save(text, jsonb) to authenticated;

notify pgrst, 'reload schema';
