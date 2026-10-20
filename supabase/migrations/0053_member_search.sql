-- 티시트 새 예약 창에서 회원 이름을 치면 고객 명부에서 찾아 고를 수 있게 한다.
--
-- 왜(2026-10-20): 직원이 회원 예약을 넣을 때 이름·전화·이메일·요금제를 매번 손으로 쳤다.
-- 요금제를 빠뜨리면 회원인데도 퍼블릭 그린피가 붙는다.
--
-- 바꾸는 것:
-- - `pelham_staff_customer_search(q)`: 이름(한 단어씩 모두 포함)·회원번호·전화 뒷자리로 최대 10명.
--   회원 먼저, 그다음 라운드 많은 순. 고객 명부(0001) 사람에는 가장 최근 시즌 회원권(0040)을 붙이고,
--   명부에 없는 회원권 줄(`customer_ref` 가 비어 있는 새 회원)도 함께 찾는다.
--   `ratePlan` 은 회원권 종류·카트 패키지로 티시트 요금제 이름(`ReservationDetail` 의 RATE_PLANS)을 만든다.
--   0045 `pelham_tee_plan_fee` 가 이름에 "member" 가 들어간 요금제를 회원 요금으로 읽는다.
-- - `pelham_tee_player`(0026): 선수에 `customerRef`·`memberNumber` 를 받으면 그대로 남긴다.
--   선수 수정(0024 `pelham_staff_player_patch_ungated`)은 옛 선수에 고친 값을 덮어 이 함수로 다시
--   만들므로, 한 번 연결된 회원 정보는 수정 뒤에도 남는다.
--
-- 전제: 0001, 0004, 0026, 0040. 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다.

-- ===== 회원권 → 티시트 요금제 이름 ==========================================

create or replace function public.pelham_membership_rate_plan(p_type text, p_cart text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_type
    when 'full' then case when p_cart = 'unlimited_7day' then 'Full Member - Single with 7 Day Cart'
                          else 'Full Member - Single' end
    when 'weekday' then case when p_cart = 'unlimited_weekday' then 'Weekday Member - Single with Weekday Cart'
                             else 'Weekday Member - Single' end
    when 'intermediate' then 'Intermediate Member'
    when 'nine_hole' then '9 Hole Member - Single'
    when 'twilight' then 'Twilight Member - Single'
    when 'junior' then 'Junior Member'
    else ''
  end
$$;

-- ===== 검색 ============================================================

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
             (c.is_member or m.id is not null) as is_member,
             m.season,
             m.membership_type,
             m.status as membership_status,
             coalesce(nullif(public.pelham_membership_rate_plan(m.membership_type, m.cart_package), ''),
                      case when c.is_member and c.player_type ilike '%member%' then btrim(c.player_type) end,
                      '') as rate_plan,
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
             true,
             m.season,
             m.membership_type,
             m.status,
             public.pelham_membership_rate_plan(m.membership_type, m.cart_package),
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
             'rounds', h.rounds
           ))
      from hits h
  ), '[]'::jsonb);
end;
$$;

-- ===== 선수에 회원 연결 남기기 (0026 그대로 + 두 칸) ============================

create or replace function public.pelham_tee_player(p jsonb, p_holes integer, p_id text, p_now text)
returns jsonb
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_player jsonb := public.pelham_tee_player_base(p, p_holes, p_id, p_now);
begin
  if jsonb_typeof(p->'extras') = 'array' and jsonb_array_length(p->'extras') > 0 then
    v_player := v_player || jsonb_build_object('extras', p->'extras');
  end if;
  if nullif(btrim(coalesce(p->>'customerRef', '')), '') is not null then
    v_player := v_player || jsonb_build_object('customerRef', btrim(p->>'customerRef'));
  end if;
  if nullif(btrim(coalesce(p->>'memberNumber', '')), '') is not null then
    v_player := v_player || jsonb_build_object('memberNumber', btrim(p->>'memberNumber'));
  end if;
  return v_player;
end;
$$;

-- ===== 권한 ============================================================

revoke all on function public.pelham_membership_rate_plan(text, text) from public, anon, authenticated;
revoke all on function public.pelham_staff_customer_search(text) from public, anon, authenticated;
revoke all on function public.pelham_tee_player(jsonb, integer, text, text) from public, anon, authenticated;
grant execute on function public.pelham_staff_customer_search(text) to authenticated;

notify pgrst, 'reload schema';
