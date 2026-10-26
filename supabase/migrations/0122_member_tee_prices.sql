-- 웹 티타임 예약(/book/tee-time)에서 회원에게 **그 회원권의 요금**으로 티타임을 보여 준다.
--
-- 왜(2026-10-26): 회원이 로그인(0111)하거나 이름으로 골라도(0109) 목록 카드에는 퍼블릭 요금이 떴고,
-- 예약 요약에는 "Member rate" 글자만 있었다. 트와일라잇 회원은 오후 3시 전엔 퍼블릭가를 내고,
-- 9홀 회원은 주말 오전에 퍼블릭가를 내는데(0045 `pelham_tee_plan_fee`), 화면은 그걸 알려 주지 않았다.
--
-- 바꾸는 것:
-- - `pelham_tee_member_prices(p_date, p_token, p_member)`(공개): 그날 열린 티타임마다 회원 본인의
--   18홀·9홀 그린피와 카트 1인 요금(세전). 회원 판정은 로그인 토큰(0111·0112, 손님 계정은 없음)을 먼저,
--   없으면 이름으로 고른 회원권 id(0109 lookup 이 주는 ref). 그날 살아 있는 회원권이 없으면 `{}`.
--   요금은 예약 때 서버가 매기는 것과 같은 함수(pelham_tee_plan_fee · pelham_tee_cart_fee_on)로 낸다.
--   돌려주는 것은 요금제 이름·회원권 이름과 값뿐 — 연락처·회원번호는 내보내지 않는다.
--
-- 예약·요금 매기기는 그대로다(0109·0112 + 0055 트리거). 이건 미리 보여 주기만 한다.
--
-- 전제: 0045, 0051, 0109, 0112. 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다.

do $$
begin
  if to_regprocedure('public.pelham_member_live_membership(public.pelham_member_logins, date)') is null then
    raise exception '0122 needs 0111/0112 first (pelham_member_live_membership is missing).';
  end if;
  if to_regprocedure('public.pelham_tee_plan_fee(text, date, integer, integer, numeric)') is null then
    raise exception '0122 needs 0045 first (pelham_tee_plan_fee is missing).';
  end if;
end;
$$;

create or replace function public.pelham_tee_member_prices(p_date date, p_token text, p_member uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_l public.pelham_member_logins;
  v_m public.pelham_memberships;
  v_plan text;
  v_times jsonb;
begin
  if p_date is null then
    return '{}'::jsonb;
  end if;

  if coalesce(p_token, '') <> '' then
    v_l := public.pelham_member_from_token(p_token);
    if v_l.id is not null then
      v_m := public.pelham_member_live_membership(v_l, p_date);
    end if;
  elsif p_member is not null then
    select * into v_m from public.pelham_memberships m
     where m.id = p_member and m.status <> 'cancelled'
       and (m.expires_on is null or m.expires_on >= p_date);
  end if;

  if v_m.id is null then
    return '{}'::jsonb;
  end if;
  v_plan := public.pelham_membership_rate_plan(v_m.membership_type, v_m.cart_package);
  if v_plan = '' then
    return '{}'::jsonb;
  end if;

  -- 열린 시각은 손님 목록(pelham_tee_availability)과 똑같이. 요금제가 그 시각에 안 맞으면 퍼블릭가.
  select coalesce(jsonb_agg(jsonb_build_object(
           'time', s->>'time',
           'rate', coalesce(public.pelham_tee_plan_fee(v_plan, p_date, (s->>'minutes')::int, 18, (s->>'rate')::numeric),
                            (s->>'rate')::numeric),
           'rate9', coalesce(public.pelham_tee_plan_fee(v_plan, p_date, (s->>'minutes')::int, 9, (s->>'rate9')::numeric),
                             (s->>'rate9')::numeric),
           'cart', public.pelham_tee_cart_fee_on(v_plan, 18, p_date),
           'cart9', public.pelham_tee_cart_fee_on(v_plan, 9, p_date)
         )), '[]'::jsonb)
    into v_times
    from jsonb_array_elements(public.pelham_tee_availability(p_date)->'times') s;

  return jsonb_build_object(
    'plan', v_plan,
    'label', initcap(replace(v_m.membership_type, '_', ' ')) || ' Member ' || v_m.season,
    'times', v_times
  );
end;
$$;

revoke all on function public.pelham_tee_member_prices(date, text, uuid) from public;
grant execute on function public.pelham_tee_member_prices(date, text, uuid) to anon, authenticated;

notify pgrst, 'reload schema';
