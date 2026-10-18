-- 카트 요금 — 1인 18홀 $19.47, 9홀 $11.50(세전).
--
-- 왜(2026-10-18): 클럽이 카트 요금을 18홀 $19.47(Chronogolf 시절 18홀 일반 요금과 같다), 9홀 $11.50 으로
-- 확인했다. 0004 의 단일 요금 $19.00 을 대신한다.
--
-- 규칙:
--   - 카트를 새로 켤 때 채우는 기본값만 바뀐다. 이미 적힌 예약의 cartFee 는 건드리지 않는다.
--   - 직원 시트에서 홀 수를 바꾸면, 카트 요금이 옛 홀 수의 자동값일 때만 새 홀 수의 자동값을 따라간다
--     (0004 규칙 그대로). 그래서 0004 때 $19.00 으로 적힌 카트는 이제 자동값이 아니어서 홀 수를 바꿔도
--     $19.00 으로 남는다 — 그런 예약은 직원이 카트 금액을 고친다.
--   - "Cart" 가 든 회원 요금제는 여전히 0.
--
-- 같은 값이 `backend/api/routes/tee_sheet.py` 의 CART_FEE·NINE_HOLE_CART_FEE 에 있다. 바꾸면 둘을 같이 고쳐라.
--
-- 전제: 0004. 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다.

do $$
begin
  if to_regprocedure('public.pelham_tee_cart_fee(text, integer)') is null then
    raise exception '0035 needs 0004 first (pelham_tee_cart_fee is missing).';
  end if;
end;
$$;

create or replace function public.pelham_tee_cart_fee(p_rate_plan text, p_holes integer)
returns numeric
language sql
immutable
set search_path = ''
as $$
  select case when position('cart' in lower(coalesce(p_rate_plan, ''))) > 0 then 0.00
              when p_holes = 9 then 11.50
              else 19.47 end
$$;

revoke all on function public.pelham_tee_cart_fee(text, integer) from public, anon, authenticated;
