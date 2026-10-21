-- 고객 편집 폼(`/admin/customers`)에서 회원권까지 같이 넣는다. 매니저 PIN 은 0054 그대로.
--
-- 왜(2026-10-21): 편집 폼이 이름·주소를 빈칸으로 열었다(옛 명부는 이름이 display_name 에만 있는 사람이 많다),
-- 그리고 회원권을 넣을 곳이 없었다. 티시트는 회원권 줄(0040)로 회원 요금제를 고른다(0053
-- `pelham_staff_customer_search` 의 ratePlan) — 고객 파일에서 회원권을 넣어야 티시트가 회원 요금을 안다.
--
-- 바뀌는 것:
--   - `pelham_staff_customers` — membership 에 id·cart_package·member_number·member_name·phone·email·
--     address·postal_code·amount_due·amount_paid 를 더한다. 폼이 빈 칸을 이것으로 채운다.
--   - `pelham_staff_customer_save(p_ref, p)` — p 에 `membership` 키가 있으면 그 시즌 회원권을 넣거나 고친다.
--       p.membership: {season, membership_type, plan, cart_package, status}
--       membership_type 이 '' 이면 그 시즌 회원권을 취소(cancelled)한다.
--     금액(amount_due)은 0042 요금표로 새로 셈한다 — 낸 돈(amount_paid)은 건드리지 않는다.
--     고객 명부의 is_member·player_type(티시트 요금제 이름)도 맞춘다.
--     `membership` 키가 없으면 회원권은 그대로다(연락처만 고칠 때 옛 회원이 풀리지 않게).
--
-- 전제: 0040, 0042, 0053, 0054. 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다.

do $$
begin
  if to_regprocedure('public.pelham_staff_customer_save(text, jsonb)') is null then
    raise exception '0063 needs 0054 first (pelham_staff_customer_save is missing).';
  end if;
  if to_regprocedure('public.pelham_membership_price(text, text, text, boolean, boolean)') is null then
    raise exception '0063 needs 0042 first (pelham_membership_price is missing).';
  end if;
  if to_regprocedure('public.pelham_membership_rate_plan(text, text)') is null then
    raise exception '0063 needs 0053 first (pelham_membership_rate_plan is missing).';
  end if;
end;
$$;

-- ===== 명부 읽기 (0054 + 회원권 칸) ========================================

create or replace function public.pelham_staff_customers()
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
             'first_name', c.first_name,
             'last_name', c.last_name,
             'phone', c.phone,
             'email', c.email,
             'address', concat_ws(', ', nullif(c.address_line1, ''), nullif(c.city, '')),
             'address_line1', c.address_line1,
             'city', c.city,
             'postal_code', c.postal_code,
             'is_member', c.is_member,
             'player_type', c.player_type,
             'member_number', c.member_number,
             'scoring_factor', c.scoring_factor,
             'activation_state', c.activation_state,
             'has_credit_card', c.has_credit_card,
             'rounds', c.rounds_booked_played,
             'user_created_on', c.user_created_on,
             'needs_review', c.needs_review,
             'review_reasons', c.review_reasons,
             'possible_duplicate_of', c.possible_duplicate_of,
             'membership', (
               select jsonb_build_object('id', m.id, 'season', m.season, 'membership_type', m.membership_type,
                                         'plan', m.plan, 'status', m.status, 'cart_package', m.cart_package,
                                         'member_name', m.member_name, 'member_number', m.member_number,
                                         'phone', m.phone, 'email', m.email,
                                         'address', m.address, 'postal_code', m.postal_code,
                                         'amount_due', m.amount_due, 'amount_paid', m.amount_paid,
                                         'rate_plan', public.pelham_membership_rate_plan(m.membership_type, m.cart_package))
                 from public.pelham_memberships m
                where m.customer_ref = c.customer_ref and m.status <> 'cancelled'
                order by m.season desc
                limit 1
             )
           ) order by c.rounds_booked_played desc, lower(c.last_name), lower(c.first_name))
      from public.pelham_customers c
  ), '[]'::jsonb);
end;
$$;

-- ===== 추가·수정 (0054 + 회원권) ===========================================

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
    if v_type is not null and v_type not in ('full', 'weekday', 'intermediate', 'nine_hole', 'twilight', 'junior') then
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
    -- 개인 전용 회원권(Intermediate·Junior)은 spousal 이 없다.
    if v_type in ('intermediate', 'junior') then
      v_plan := 'single';
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
        membership_type, plan, cart_package, amount_due, status)
      values (
        v_season, v_ref, v_name, v_phone, v_email, v_number,
        nullif(concat_ws(', ', v_address, v_city), ''), v_postal,
        v_type, v_plan, v_cart,
        coalesce(public.pelham_membership_price(v_type, v_plan, v_cart, false, false), 0),
        v_status);
    else
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
             -- 종류·플랜·카트가 바뀌었을 때만 요금표로 다시 센다(직원이 고친 금액을 지키려고).
             amount_due = case
                            when m.membership_type is distinct from v_type or m.plan is distinct from v_plan
                              or m.cart_package is distinct from v_cart or m.status = 'cancelled'
                            then coalesce(public.pelham_membership_price(v_type, v_plan, v_cart, m.range_pass,
                                                                         m.payment_method = 'Credit card'), m.amount_due)
                            else m.amount_due
                          end,
             status = v_status,
             updated_at = now()
       where m.id = v_row.id;
    end if;

    -- 명부의 회원 표시를 맞춘다. 티시트 검색(0053)은 player_type 을 요금제 이름으로도 읽는다.
    update public.pelham_customers c
       set is_member = exists (select 1 from public.pelham_memberships m
                                where m.customer_ref = c.customer_ref and m.status <> 'cancelled'),
           player_type = coalesce(
             (select public.pelham_membership_rate_plan(m.membership_type, m.cart_package)
                from public.pelham_memberships m
               where m.customer_ref = c.customer_ref and m.status <> 'cancelled'
               order by m.season desc limit 1),
             c.player_type)
     where c.customer_ref = v_ref;
  end if;

  return jsonb_build_object('customer_ref', v_ref);
end;
$$;

revoke all on function public.pelham_staff_customers() from public, anon, authenticated;
revoke all on function public.pelham_staff_customer_save(text, jsonb) from public, anon, authenticated;
grant execute on function public.pelham_staff_customers() to authenticated;
grant execute on function public.pelham_staff_customer_save(text, jsonb) to authenticated;

notify pgrst, 'reload schema';
