-- 고객 명부(`/customers`)에서 고객을 추가·수정한다. 매니저 PIN 이 있어야 한다.
--
-- 왜(2026-10-20): 0043 은 읽기만 했다. 클럽 요청: 프로 샵에서 손님 정보를 고치고 새 손님을 넣되,
-- 매니저가 그 자리에서 PIN 을 쳐야 한다. 0024 의 매니저 승인 흐름을 그대로 쓴다 — 서버가 PT428 로 거절하면
-- 화면이 PIN 창을 띄우고, 승인 뒤 같은 요청을 다시 보낸다.
--
--   action `customer` · ref = 고객 번호(customer_ref), 새 고객은 'new'. 승인은 0024 처럼 10분 유효.
--
-- 바뀌는 것:
--   - `pelham_staff_manager_approve` — 받는 action 에 'customer' 를 더한다(본문은 0024 그대로).
--     **0024 를 다시 실행하면 'customer' 가 빠진다** — 그 뒤엔 이 파일을 다시 실행하면 된다.
--   - `pelham_staff_customers` — 편집 폼이 쓸 칸(first_name·last_name·address_line1·city)을 더한다.
--   - 새 함수 `pelham_staff_customer_save(p_ref, p)` — p_ref 가 null 이면 추가, 아니면 수정.
--     p: {first_name, last_name, phone, email, address_line1, city, postal_code, member_number}
--     전화는 숫자 10자리로, 이메일은 소문자로 맞춘다. 고친 칸의 검토 사유(이름 누락·읽지 못한 전화 등)는 지운다.
--     중복 의심 표시는 그대로 둔다(사람이 판단한다).
--   - 새 고객 번호는 `PH00001` 꼴(시퀀스).
--
-- 전제: 0001, 0024, 0043. 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다.

do $$
begin
  if to_regprocedure('public.pelham_require_manager(text, text, text)') is null then
    raise exception '0054 needs 0024 first (pelham_require_manager is missing).';
  end if;
  if to_regprocedure('public.pelham_staff_customers()') is null then
    raise exception '0054 needs 0043 first (pelham_staff_customers is missing).';
  end if;
end;
$$;

create sequence if not exists public.pelham_customer_ref_seq;
revoke all on sequence public.pelham_customer_ref_seq from public, anon, authenticated;

-- ===== 매니저 승인: 'customer' 추가 (0024 본문 그대로) ======================

create or replace function public.pelham_staff_manager_approve(p_pin text, p_action text, p_ref text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_manager public.pelham_managers%rowtype;
  v_at timestamptz := now();
begin
  perform public.pelham_require_staff();
  if p_action is null or p_action not in ('refund', 'rain_check', 'remove_player', 'mark_unpaid', 'price', 'customer') then
    perform public.pelham_fail('422', 'Unknown approval.');
  end if;
  if coalesce(btrim(p_ref), '') = '' then
    perform public.pelham_fail('422', 'Nothing to approve.');
  end if;
  if (select count(*) from public.pelham_manager_approvals a
       where not a.ok and a.requested_by is not distinct from auth.uid()
         and a.created_at > now() - interval '10 minutes') >= 5 then
    perform public.pelham_fail('429', 'Too many wrong PINs. Wait 10 minutes and try again.');
  end if;

  select * into v_manager from public.pelham_managers m
   where m.active and m.pin_hash is not null and coalesce(p_pin, '') ~ '^[0-9]{4,8}$'
     and m.pin_hash = extensions.crypt(p_pin, m.pin_hash)
   limit 1;

  insert into public.pelham_manager_approvals (ok, manager_id, action, ref, requested_by, created_at)
  values (v_manager.id is not null, v_manager.id, p_action, btrim(p_ref), auth.uid(), v_at);

  if v_manager.id is null then
    -- 실패 기록은 남아야 한다 — 예외로 끝내면 위 insert 가 같이 되돌려진다. 그래서 값으로 알린다.
    return jsonb_build_object('approved', false, 'message', 'That PIN is not a manager PIN.');
  end if;
  return jsonb_build_object(
    'approved', true,
    'manager', v_manager.name,
    'action', p_action,
    'ref', btrim(p_ref),
    'expires_at', public.pelham_iso(v_at + interval '10 minutes'));
end;
$$;

-- ===== 명부 읽기 (0043 + 편집 칸) ==========================================

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
               select jsonb_build_object('season', m.season, 'membership_type', m.membership_type,
                                         'plan', m.plan, 'status', m.status)
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

-- ===== 추가·수정 ===========================================================

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

  return jsonb_build_object('customer_ref', v_ref);
end;
$$;

-- ===== 권한 ============================================================

revoke all on function public.pelham_staff_manager_approve(text, text, text) from public, anon, authenticated;
revoke all on function public.pelham_staff_customers() from public, anon, authenticated;
revoke all on function public.pelham_staff_customer_save(text, jsonb) from public, anon, authenticated;

grant execute on function public.pelham_staff_manager_approve(text, text, text) to authenticated;
grant execute on function public.pelham_staff_customers() to authenticated;
grant execute on function public.pelham_staff_customer_save(text, jsonb) to authenticated;

notify pgrst, 'reload schema';
