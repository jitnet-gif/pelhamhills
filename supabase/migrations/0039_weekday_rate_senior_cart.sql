-- 평일 그린피 $40.71, Public Senior 카트 $17.70 (세전).
--
-- 왜(2026-10-19): 클럽 요금표 — 평일 18홀 그린피는 Public·Public Senior 모두 $40.71 + tax($46.00),
-- 평일 18홀 카트는 Public $19.47 + tax($22.00), Public Senior $17.70 + tax($20.00).
-- 0025 의 평일 $47.79 와 0035 의 단일 카트 요금 $19.47 을 대신한다.
--
-- 규칙:
--   - 그린피는 예약 하나에 한 금액이다. Senior 와 Public 이 평일에 같으므로 요금제를 보지 않는다.
--     주말·공휴일($58.41)과 9홀(0034·0037)은 그대로다.
--   - 카트: 요금제 이름에 "Senior" 가 들면 18홀 $17.70. 9홀은 모두 $11.50, "Cart" 가 든 회원 요금제는 0 그대로.
--     (카트 함수는 날짜를 모른다 — 지금은 요일과 무관하게 Senior 18홀 $17.70.)
--   - 새로 매기는 값만 바뀐다. 이미 적힌 예약의 rate·cartFee 는 건드리지 않는다.
--     직원 시트에서 요금제를 Public ↔ Public Senior 로 바꾸면 카트가 자동값일 때 새 값을 따라간다(0004 규칙).
--
-- 같은 값이 `backend/api/routes/tee_sheet.py`(WEEKDAY_RATE·SENIOR_CART_FEE), `frontend/app/golf/rates/page.tsx`
-- 에도 있다. 바꾸면 같이 고쳐라.
--
-- 전제: 0025, 0035. 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다.

do $$
begin
  if to_regclass('public.pelham_tee_holidays') is null then
    raise exception '0039 needs 0025 first (pelham_tee_holidays is missing).';
  end if;
  if to_regprocedure('public.pelham_tee_cart_fee(text, integer)') is null then
    raise exception '0039 needs 0004 first (pelham_tee_cart_fee is missing).';
  end if;
end;
$$;

-- 0025 그대로, 평일 47.79 → 40.71 만.
create or replace function public.pelham_tee_rate(p_date date)
returns numeric
language sql
stable
set search_path = ''
as $$
  select coalesce(
           (select coalesce(h.rate, 58.41) from public.pelham_tee_holidays h where h.holiday_date = p_date),
           case when extract(isodow from p_date) in (6, 7) then 58.41 else 40.71 end
         )
$$;

create or replace function public.pelham_tee_cart_fee(p_rate_plan text, p_holes integer)
returns numeric
language sql
immutable
set search_path = ''
as $$
  select case when position('cart' in lower(coalesce(p_rate_plan, ''))) > 0 then 0.00
              when p_holes = 9 then 11.50
              when position('senior' in lower(coalesce(p_rate_plan, ''))) > 0 then 17.70
              else 19.47 end
$$;

revoke all on function public.pelham_tee_rate(date) from public, anon, authenticated;
revoke all on function public.pelham_tee_cart_fee(text, integer) from public, anon, authenticated;
