-- GPS 앱 **지갑** — 매니저가 GPS 관리 화면(쿠폰·기프트카드 탭)에서 손님 앱 계정으로 기프트카드와 개인 쿠폰을
-- 발행하고, 손님은 GPS 앱의 쿠폰 화면(지갑)에서 바코드를 꺼내 프로샵 계산서에서 쓴다.
--
-- 왜(2026-10-26): 운영안 "GPS 앱 쿠폰·기프트카드 발행"(docs/presentations/2026-10-26-gps-coupons-gift-cards).
-- 결정: 개인 쿠폰을 넣는다, 회원은 할인 쿠폰에서 뺀다(도장과 같은 규칙). 기프트카드는 회원도 받는다.
--
-- **장부는 하나다.** 새 표를 만들지 않는다:
--   - 기프트카드 = `pelham_gift_cards`(0120)에 받은 계정(owner_id)만 더한다. 발행·무효는 0120 함수 그대로다.
--   - 개인 쿠폰 = `pelham_promotions`(0078)의 한 줄. owner_id 가 있으면 개인 쿠폰이다: 한 번만(usage_limit 1),
--     만료일 필수, 계산서당 한 장, 그린피 할인. 저장 코드는 `CPN` + 16진 10자, 바코드는 `CPN-` + 16진 10자.
--     계산서에서 찍으면 0078/0080 의 프로모션 적용 그대로 간다(pelham_promo_code 가 CPN- 를 알아듣는다).
--   - 캠페인 쿠폰 = 지금의 프로모션 코드(PROMO-). GPS 화면도 0078 의 pelham_staff_promotion_save 를 그대로 부른다.
--
-- 바뀌는 것
--   - pelham_gift_cards.owner_id, pelham_promotions.owner_id · issue_note · void_reason
--   - pelham_promo_code      'CPN-1A2B…' → 'CPN1A2B…' (PROMO- 는 그대로)
--   - pelham_promo_json      개인 쿠폰의 barcode 는 CPN-…
--   - pelham_staff_promotions  Promotions 화면 목록에서 개인 쿠폰을 뺀다(손님 한 명 것이라 목록이 넘친다)
--   - pelham_promo_amount_for  개인 쿠폰의 % 할인은 **한 사람** 그린피에만(넷이 와도 한 장은 한 사람 몫)
--   - 새 함수: gps_wallet_access, gps_wallet_find_guests, gps_wallet_issue, gps_wallet_void, gps_wallet_issued, my_wallet
--
-- 권한: 발행·무효·명단은 0120 의 기프트카드 매니저(pelham_is_gift_card_manager — 계정 관리자 또는 Reports 명단,
-- proshop@ 공용 계정 제외). my_wallet 은 로그인한 손님이 **자기 것만** 읽는다. 번호는 무작위라 옆 번호를 못 쓴다.
--
-- 전제: pelhamhills 0078 · 0080 · 0120, GPS 앱 0023 · 0026(coupon_books, coupon_is_member). 같은 Supabase 프로젝트.
-- 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다.

do $$
declare
  v_missing text[] := '{}';
begin
  if to_regclass('public.pelham_gift_cards') is null then v_missing := v_missing || '0120 (pelham_gift_cards)'::text; end if;
  if to_regprocedure('public.pelham_promo_amount_for(bigint)') is null then v_missing := v_missing || '0080 (pelham_promo_amount_for)'::text; end if;
  if to_regprocedure('public.pelham_staff_gift_card_issue(jsonb)') is null then v_missing := v_missing || '0120 (pelham_staff_gift_card_issue)'::text; end if;
  if to_regclass('public.coupon_books') is null then v_missing := v_missing || 'GPS 0023 (coupon_books)'::text; end if;
  if to_regprocedure('public.coupon_is_member(uuid)') is null then v_missing := v_missing || 'GPS 0026 (coupon_is_member)'::text; end if;
  if cardinality(v_missing) > 0 then
    raise exception '0121 needs these first: %', array_to_string(v_missing, ', ');
  end if;
end;
$$;

-- ===== 표에 더하는 칸 ====================================================

alter table public.pelham_gift_cards
  add column if not exists owner_id uuid references auth.users (id) on delete set null;
create index if not exists pelham_gift_cards_owner_idx on public.pelham_gift_cards (owner_id) where owner_id is not null;

alter table public.pelham_promotions
  add column if not exists owner_id uuid references auth.users (id) on delete set null;
alter table public.pelham_promotions add column if not exists issue_note text;
alter table public.pelham_promotions add column if not exists void_reason text;
create index if not exists pelham_promotions_owner_idx on public.pelham_promotions (owner_id) where owner_id is not null;

-- 개인 쿠폰은 한 번, 만료일 있음, 계산서당 한 번 금액(per_player 아님).
alter table public.pelham_promotions drop constraint if exists pelham_promotions_personal_check;
alter table public.pelham_promotions add constraint pelham_promotions_personal_check
  check (owner_id is null or (usage_limit = 1 and expires_on is not null and not per_player));

-- ===== 코드 · 바코드 =====================================================

-- 'PROMO-FALL18' → 'FALL18', 'CPN-1A2B3C4D5E' → 'CPN1A2B3C4D5E', ' fall18 ' → 'FALL18'
create or replace function public.pelham_promo_code(p_raw text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
           when v ~ '^CPN-[0-9A-F]{10}$' then 'CPN' || substr(v, 5)
           else regexp_replace(v, '^PROMO-', '')
         end
    from (select upper(btrim(coalesce(p_raw, ''))) as v) s
$$;

create or replace function public.pelham_promo_barcode(p_code text, p_owner uuid)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when p_owner is not null then 'CPN-' || substr(p_code, 4) else 'PROMO-' || p_code end
$$;

-- 0078 과 같고 barcode 만 개인 쿠폰을 안다.
create or replace function public.pelham_promo_json(p_id bigint)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select to_jsonb(p)
         || jsonb_build_object(
              'barcode', public.pelham_promo_barcode(p.code, p.owner_id),
              'used', u.used,
              'held', u.held,
              'state', case
                when not p.active then 'paused'
                when p.expires_on is not null and p.expires_on < public.pelham_pos_today() then 'expired'
                when p.starts_on is not null and p.starts_on > public.pelham_pos_today() then 'scheduled'
                when p.usage_limit is not null and u.used >= p.usage_limit then 'used_up'
                else 'active'
              end)
    from public.pelham_promotions p
    cross join lateral (
      select count(*) filter (where b.status = 'paid') as used,
             count(*) filter (where b.status = 'open') as held
        from public.pelham_promo_uses x
        join public.pelham_bills b on b.id = x.bill_id
       where x.promo_id = p.id
    ) u
   where p.id = p_id
$$;

-- Promotions 화면 목록 = 캠페인 쿠폰만. 개인 쿠폰은 GPS 쿠폰·기프트카드 탭이 보여 준다.
create or replace function public.pelham_staff_promotions()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.pelham_require_staff();
  return coalesce((
    select jsonb_agg(public.pelham_promo_json(p.id) order by p.active desc, p.created_at desc)
      from public.pelham_promotions p
     where p.owner_id is null
  ), '[]'::jsonb);
end;
$$;

-- 0080 과 같고, 개인 쿠폰의 % 는 한 사람 그린피(평균)에만 붙는다.
create or replace function public.pelham_promo_amount_for(p_bill bigint)
returns integer
language sql
stable
set search_path = ''
as $$
  select coalesce((
    select least(
             case
               when p.kind = 'percent' and p.owner_id is not null and f.players > 0
                 then round((f.fees::numeric / f.players) * p.value / 100.0)::integer
               when p.kind = 'percent' then round(f.fees * p.value / 100.0)::integer
               when p.per_player then p.value * f.players
               else case when f.players > 0 then p.value else 0 end
             end,
             f.fees)
      from public.pelham_promo_uses x
      join public.pelham_promotions p on p.id = x.promo_id
      cross join lateral (
        select coalesce(sum(l.quantity), 0)::integer as players,
               greatest(coalesce(sum(l.line_total), 0), 0)::integer as fees
          from public.pelham_bill_lines l
         where l.bill_id = p_bill and l.active and l.kind = 'tee_player'
      ) f
     where x.bill_id = p_bill
  ), 0)
$$;

-- ===== 지갑 한 칸(JSON) ==================================================

-- 기프트카드 → 지갑 칸. 발행 사유(note)·연락처는 손님에게 보내지 않는다.
create or replace function public.gps_wallet_gift_json(g public.pelham_gift_cards)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'type', 'gift',
    'code', g.code,
    'barcode', g.code,
    'amount', g.amount,
    'balance', g.amount - public.pelham_gc_used(g.id),
    'kind', g.kind,
    'status', g.status,
    'issued_on', to_char(g.issued_on, 'YYYY-MM-DD'),
    'state', case
      when g.status = 'void' then 'void'
      when g.amount - public.pelham_gc_used(g.id) <= 0 then 'spent'
      else 'active'
    end)
$$;

-- 개인 쿠폰 → 지갑 칸.
create or replace function public.gps_wallet_coupon_json(p_id bigint)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'type', 'coupon',
    'code', j->>'code',
    'barcode', j->>'barcode',
    'name', j->>'name',
    'discount_kind', j->>'kind',
    'value', (j->>'value')::integer,
    'issued_on', to_char((j->>'created_at')::timestamptz at time zone 'America/Toronto', 'YYYY-MM-DD'),
    'expires_on', j->>'expires_on',
    'state', case j->>'state'
      when 'paused' then 'void'
      when 'used_up' then 'used'
      when 'expired' then 'expired'
      else 'active'
    end)
    from (select public.pelham_promo_json(p_id) as j) s
$$;

-- ===== 매니저 ===========================================================

-- GPS 관리 화면이 탭을 보일지. 오류 대신 false — 직원이 아닌 계정도 그냥 탭이 안 보인다.
create or replace function public.gps_wallet_access()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null and public.pelham_is_staff() and public.pelham_is_gift_card_manager()
$$;

-- 앱 계정 찾기: 이메일 · 쿠폰북 코드(6자) · 고객 명부 이름. 15명까지.
create or replace function public.gps_wallet_find_guests(p_query text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_q text := lower(btrim(coalesce(p_query, '')));
begin
  perform public.pelham_require_gift_card_manager();
  if length(v_q) < 2 then
    return '[]'::jsonb;
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'owner_id', s.id,
             'email', s.email,
             'name', s.name,
             'coupon_code', (select b.code from public.coupon_books b where b.owner_id = s.id),
             'is_member', public.coupon_is_member(s.id)) order by s.email)
      from (
        select u.id, lower(u.email) as email,
               (select nullif(btrim(coalesce(c.display_name, concat_ws(' ', c.first_name, c.last_name))), '')
                  from public.pelham_customers c
                 where c.gps_user_id = u.id
                    or (u.email is not null and lower(btrim(coalesce(c.email, ''))) = lower(u.email))
                 order by (c.gps_user_id = u.id) desc
                 limit 1) as name
          from auth.users u
         where lower(coalesce(u.email, '')) like '%' || v_q || '%'
            or exists (select 1 from public.coupon_books b
                        where b.owner_id = u.id and lower(b.code) = replace(v_q, ' ', ''))
            or exists (select 1 from public.pelham_customers c
                        where (c.gps_user_id = u.id
                               or (u.email is not null and lower(btrim(coalesce(c.email, ''))) = lower(u.email)))
                          and lower(concat_ws(' ', c.display_name, c.first_name, c.last_name)) like '%' || v_q || '%')
         limit 15
      ) s
  ), '[]'::jsonb);
end;
$$;

-- p: {type: 'gift', owner_id, amount(센트), kind: sold|complimentary, note}
--    {type: 'coupon', owner_id, name, discount_kind: amount|percent, value, days(1–365, 기본 60), note}
create or replace function public.gps_wallet_issue(p jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_type text := coalesce(p->>'type', '');
  v_owner uuid;
  v_email text;
  v_name text;
  v_note text := btrim(coalesce(p->>'note', ''));
  v_card jsonb;
  g public.pelham_gift_cards;
  v_kind text := coalesce(p->>'discount_kind', '');
  v_value integer;
  v_days integer;
  v_code text;
  v_by text;
  v_id bigint;
begin
  perform public.pelham_require_gift_card_manager();
  begin
    v_owner := (p->>'owner_id')::uuid;
  exception when others then
    perform public.pelham_fail('422', 'Pick the guest''s app account.');
  end;
  select lower(u.email) into v_email from auth.users u where u.id = v_owner;
  if v_owner is null or v_email is null then
    perform public.pelham_fail('404', 'No app account for that guest.');
  end if;
  if v_note = '' then
    perform public.pelham_fail('422', 'Write why it is issued (who paid and how, or what it is for).');
  end if;
  select nullif(btrim(coalesce(c.display_name, concat_ws(' ', c.first_name, c.last_name))), '') into v_name
    from public.pelham_customers c
   where c.gps_user_id = v_owner or lower(btrim(coalesce(c.email, ''))) = v_email
   order by (c.gps_user_id = v_owner) desc
   limit 1;

  if v_type = 'gift' then
    -- 0120 의 발행 함수 그대로(금액 한도 · 사유 · 번호). 받은 계정만 더한다.
    v_card := public.pelham_staff_gift_card_issue(jsonb_build_object(
      'amount', p->'amount', 'kind', p->>'kind', 'note', v_note,
      'recipient', coalesce(v_name, v_email), 'email', v_email));
    update public.pelham_gift_cards set owner_id = v_owner where id = (v_card->>'id')::bigint
    returning * into g;
    return public.gps_wallet_gift_json(g) || jsonb_build_object('owner_email', v_email, 'owner_name', v_name);
  end if;

  if v_type <> 'coupon' then
    perform public.pelham_fail('422', 'type must be gift or coupon.');
  end if;
  -- 회원은 할인 쿠폰에서 뺀다(도장과 같은 규칙, GPS 0026). 기프트카드는 위에서 이미 끝났다.
  if public.coupon_is_member(v_owner) then
    perform public.pelham_fail('409', 'Members play on their membership, so they do not get discount coupons. A gift card is fine.');
  end if;
  if v_kind not in ('amount', 'percent') then
    perform public.pelham_fail('422', 'Choose dollars off or percent off.');
  end if;
  begin
    v_value := (p->>'value')::integer;
    v_days := coalesce(nullif(p->>'days', '')::integer, 60);
  exception when others then
    perform public.pelham_fail('422', 'The discount and the days must be whole numbers.');
  end;
  if v_value is null or v_value <= 0 or (v_kind = 'percent' and v_value > 100) or (v_kind = 'amount' and v_value > 50000) then
    perform public.pelham_fail('422', 'Enter the discount: up to $500.00 off, or 1 to 100 percent.');
  end if;
  if v_days < 1 or v_days > 365 then
    perform public.pelham_fail('422', 'A coupon runs 1 to 365 days.');
  end if;

  loop
    v_code := 'CPN' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));
    exit when not exists (select 1 from public.pelham_promotions x where x.code = v_code);
  end loop;
  select lower(u.email) into v_by from auth.users u where u.id = auth.uid();
  insert into public.pelham_promotions
    (code, name, kind, value, per_player, conditions, starts_on, expires_on, usage_limit, active, created_by,
     owner_id, issue_note)
  values
    (v_code,
     coalesce(nullif(btrim(p->>'name'), ''), case when v_kind = 'percent' then v_value || '% off a green fee'
                                                  else '$' || to_char(v_value / 100.0, 'FM999990.00') || ' off a green fee' end),
     v_kind, v_value, false,
     'Personal coupon for ' || coalesce(v_name, v_email) || ' — one use, one green fee',
     public.pelham_pos_today(), public.pelham_pos_today() + v_days, 1, true, v_by, v_owner, v_note)
  returning id into v_id;
  return public.gps_wallet_coupon_json(v_id) || jsonb_build_object('owner_email', v_email, 'owner_name', v_name);
end;
$$;

-- 무효: 기프트카드는 0120 그대로, 개인 쿠폰은 멈추고 사유를 남긴다(지우지 않는다).
create or replace function public.gps_wallet_void(p_type text, p_code text, p_reason text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id bigint;
begin
  perform public.pelham_require_gift_card_manager();
  if p_type = 'gift' then
    perform public.pelham_staff_gift_card_void(p_code, p_reason);
    return (select public.gps_wallet_gift_json(g) from public.pelham_gift_cards g where g.code = upper(btrim(p_code)));
  end if;
  if length(btrim(coalesce(p_reason, ''))) = 0 then
    perform public.pelham_fail('422', 'Give a reason for voiding the coupon.');
  end if;
  update public.pelham_promotions x
     set active = false, void_reason = btrim(p_reason), updated_at = now()
   where x.code = public.pelham_promo_code(p_code) and x.owner_id is not null and x.active
  returning x.id into v_id;
  if v_id is null then
    perform public.pelham_fail('404', format('No active personal coupon %s', coalesce(p_code, '')));
  end if;
  return public.gps_wallet_coupon_json(v_id);
end;
$$;

-- 앱 계정으로 발행한 것들, 최근 것부터(GPS 탭의 목록).
create or replace function public.gps_wallet_issued(p_limit integer default 100)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.pelham_require_gift_card_manager();
  return coalesce((
    select jsonb_agg(item order by at desc)
      from (
        select g.issued_at as at,
               public.gps_wallet_gift_json(g)
               || jsonb_build_object('owner_email', lower(u.email), 'note', g.note, 'issued_by', g.issued_email,
                                     'void_reason', g.void_reason) as item
          from public.pelham_gift_cards g
          left join auth.users u on u.id = g.owner_id
         where g.owner_id is not null
        union all
        select x.created_at as at,
               public.gps_wallet_coupon_json(x.id)
               || jsonb_build_object('owner_email', lower(u.email), 'note', x.issue_note, 'issued_by', x.created_by,
                                     'void_reason', x.void_reason) as item
          from public.pelham_promotions x
          left join auth.users u on u.id = x.owner_id
         where x.owner_id is not null
        order by 1 desc
        limit least(greatest(coalesce(p_limit, 100), 1), 500)
      ) s
  ), '[]'::jsonb);
end;
$$;

-- ===== 손님 ============================================================

-- 내 지갑: 기프트카드 → 개인 쿠폰 → 도장(쿠폰북). 자기 계정 것만.
create or replace function public.my_wallet()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null then
    raise exception '로그인이 필요합니다.' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'gift_cards', coalesce((
      select jsonb_agg(public.gps_wallet_gift_json(g) order by g.issued_at desc)
        from public.pelham_gift_cards g where g.owner_id = v_me), '[]'::jsonb),
    'coupons', coalesce((
      select jsonb_agg(public.gps_wallet_coupon_json(x.id) order by x.expires_on, x.id)
        from public.pelham_promotions x where x.owner_id = v_me), '[]'::jsonb),
    -- 쿠폰북을 처음 여는 계정이면 여기서 코드가 생긴다(0023 과 같다).
    'book', public.my_coupon_book());
end;
$$;

-- ===== 권한 ============================================================

revoke all on function public.pelham_promo_barcode(text, uuid) from public, anon, authenticated;
revoke all on function public.pelham_promo_amount_for(bigint) from public, anon, authenticated;
revoke all on function public.gps_wallet_gift_json(public.pelham_gift_cards) from public, anon, authenticated;
revoke all on function public.gps_wallet_coupon_json(bigint) from public, anon, authenticated;

revoke all on function public.gps_wallet_access() from public, anon;
revoke all on function public.gps_wallet_find_guests(text) from public, anon;
revoke all on function public.gps_wallet_issue(jsonb) from public, anon;
revoke all on function public.gps_wallet_void(text, text, text) from public, anon;
revoke all on function public.gps_wallet_issued(integer) from public, anon;
revoke all on function public.my_wallet() from public, anon;
grant execute on function public.gps_wallet_access() to authenticated;
grant execute on function public.gps_wallet_find_guests(text) to authenticated;
grant execute on function public.gps_wallet_issue(jsonb) to authenticated;
grant execute on function public.gps_wallet_void(text, text, text) to authenticated;
grant execute on function public.gps_wallet_issued(integer) to authenticated;
grant execute on function public.my_wallet() to authenticated;

notify pgrst, 'reload schema';
