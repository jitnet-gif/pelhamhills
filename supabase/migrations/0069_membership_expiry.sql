-- 회원권 만료일. 고객 편집 폼(`/admin/customers`)에서 넣고, 지난 회원권은 티시트가 회원 요금을 주지 않는다.
--
-- 왜(2026-10-22): 회원권은 시즌(연도)만 있고 언제 끝나는지 적을 곳이 없었다.
--
-- 바뀌는 것:
--   - `pelham_memberships.expires_on date` — 비우면 만료일 없음(시즌 동안 유효).
--   - `pelham_staff_customers` — membership 에 expires_on·expired(오늘 클럽 날짜보다 앞이면 참)를 더한다.
--   - `pelham_staff_customer_save` — p.membership.expires_on('YYYY-MM-DD' 또는 '') 을 그대로 적는다.
--   - `pelham_staff_customer_search`(0053) — 가장 최근 회원권이 만료됐으면 isMember 거짓·ratePlan '' 로 준다
--     (옛 명부의 player_type 으로도 회원 요금이 붙지 않게). expiresOn 을 더한다.
--   - 회원권 → 티시트: 회원권 줄이 바뀌면(고객 폼·Memberships 화면·결제 어디서든) 트리거가
--     그 고객(customerRef)이 연결된 오늘 이후 예약의 선수 요금제(ratePlan)를 맞춘다.
--       살아 있는 회원권(취소 아님, 그 예약 날짜에 만료 전) → 회원권의 요금제 이름.
--       없거나 만료 → 회원 요금제였던 선수만 'Public' 으로. (Senior 같은 다른 요금제는 그대로.)
--     결제된 선수·취소된 선수·취소/막힌 예약은 건드리지 않는다. 그린피·카트비는 0055 트리거가 다시 매긴다.
--
-- 전제: 0053, 0055, 0063. 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다.

do $$
begin
  if to_regprocedure('public.pelham_staff_customer_search(text)') is null then
    raise exception '0069 needs 0053 first (pelham_staff_customer_search is missing).';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'pelham_memberships' and column_name = 'postal_code') then
    raise exception '0069 needs 0040 first (pelham_memberships is missing).';
  end if;
end;
$$;

alter table public.pelham_memberships add column if not exists expires_on date;

-- ===== 명부 읽기 (0063 + 만료일) ===========================================

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
                                         'expires_on', m.expires_on,
                                         'expired', coalesce(m.expires_on < public.pelham_local_now()::date, false),
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

-- ===== 추가·수정 (0063 + 만료일) ===========================================

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
    -- 만료일. 빈칸이면 만료일 없음(null).
    if coalesce(v_m->>'expires_on', '') <> '' then
      if v_m->>'expires_on' !~ '^\d{4}-\d{2}-\d{2}$' then
        perform public.pelham_fail('422', format('''%s'' is not a date.', v_m->>'expires_on'));
      end if;
      v_expires := (v_m->>'expires_on')::date;
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
        membership_type, plan, cart_package, amount_due, status, expires_on)
      values (
        v_season, v_ref, v_name, v_phone, v_email, v_number,
        nullif(concat_ws(', ', v_address, v_city), ''), v_postal,
        v_type, v_plan, v_cart,
        coalesce(public.pelham_membership_price(v_type, v_plan, v_cart, false, false), 0),
        v_status, v_expires);
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
             expires_on = v_expires,
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

-- ===== 티시트 회원 검색 (0053 + 만료) ========================================

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
           where x.customer_ref = c.customer_ref and x.status <> 'cancelled'
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
           where x.customer_ref is null and x.status <> 'cancelled'
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

-- ===== 회원권 → 티시트 예약 요금제 ==========================================

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
   where m.customer_ref = p_ref and m.status <> 'cancelled'
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

create or replace function public.pelham_memberships_tee_sync()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op in ('INSERT', 'UPDATE') then
    perform public.pelham_tee_sync_member(new.customer_ref);
  end if;
  if tg_op = 'DELETE' or (tg_op = 'UPDATE' and old.customer_ref is distinct from new.customer_ref) then
    perform public.pelham_tee_sync_member(old.customer_ref);
  end if;
  return null;
end;
$$;

drop trigger if exists pelham_memberships_tee_sync on public.pelham_memberships;
create trigger pelham_memberships_tee_sync
  after insert or update or delete on public.pelham_memberships
  for each row execute function public.pelham_memberships_tee_sync();

-- ===== 권한 ============================================================

revoke all on function public.pelham_tee_sync_member(text) from public, anon, authenticated;
revoke all on function public.pelham_memberships_tee_sync() from public, anon, authenticated;

revoke all on function public.pelham_staff_customers() from public, anon, authenticated;
revoke all on function public.pelham_staff_customer_save(text, jsonb) from public, anon, authenticated;
revoke all on function public.pelham_staff_customer_search(text) from public, anon, authenticated;
grant execute on function public.pelham_staff_customers() to authenticated;
grant execute on function public.pelham_staff_customer_save(text, jsonb) to authenticated;
grant execute on function public.pelham_staff_customer_search(text) to authenticated;

notify pgrst, 'reload schema';
