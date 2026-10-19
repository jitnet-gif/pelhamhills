-- 온라인 회원권 신청(`/memberships/application`). 손님이 낸 신청서가 0040 명부에 `pending` 으로 들어가고,
-- 프로 샵이 `/admin/memberships` 에서 보고 전화해 결제를 받는다.
--
-- 손님은 공개(publishable) 키로 이 함수 하나만 부른다. 명부 표는 여전히 읽을 수 없다 —
-- 돌려주는 것은 신청 번호·이름·금액뿐이다.
--
-- 금액(`amount_due`)은 화면이 요금표로 계산해 보낸 **견적**이다. 손님이 고칠 수 있는 값이라
-- 직원이 결제를 받기 전에 다시 본다(관리자 화면이 요금표 금액과 다르면 표시한다).
--
-- 전제: 0040. 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다.

-- staff: 프로 샵이 직접 넣음 · online: 손님이 온라인으로 신청
alter table public.pelham_memberships
  add column if not exists source text not null default 'staff' check (source in ('staff', 'online'));

-- 명부 JSON 에 source 를 싣는다(0040 의 함수를 그대로 다시 정의하고 한 줄 더한다).
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
    'address', r.address,
    'postal_code', r.postal_code,
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
    'source', r.source,
    'created_at', r.created_at,
    'updated_at', r.updated_at
  )
$$;

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
  v_season integer := coalesce(nullif(p->>'season', '')::integer, extract(year from now())::integer + 1);
  v_due numeric := coalesce(nullif(p->>'amount_due', '')::numeric, 0);
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
  -- 이번 시즌 또는 다음 시즌만 받는다.
  if v_season not between extract(year from now())::integer and extract(year from now())::integer + 1 then
    perform public.pelham_fail('422', 'Applications are open for the upcoming season only.');
  end if;
  if v_due < 0 or v_due > 20000 then
    v_due := 0;
  end if;

  -- 같은 시즌에 같은 이메일·전화로 이미 낸 신청(취소 제외)이 있으면 두 번 넣지 않는다.
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
    v_type <> 'full' and coalesce((p->>'range_pass')::boolean, false),
    round(v_due, 2), v_method, 'pending', 'online',
    left(public.pelham_membership_text(p, 'notes'), 1000)
  )
  returning * into r;

  return jsonb_build_object(
    'reference', upper(left(r.id::text, 8)),
    'member_name', r.member_name,
    'season', r.season,
    'amount_due', r.amount_due
  );
end;
$$;

revoke all on function public.pelham_membership_apply(jsonb) from public;
grant execute on function public.pelham_membership_apply(jsonb) to anon, authenticated;

notify pgrst, 'reload schema';
