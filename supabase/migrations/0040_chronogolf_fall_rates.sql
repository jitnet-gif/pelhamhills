-- 주말·공휴일 그린피 $51.33, 풀카트 $7.08 / $3.54, 큰 바구니 $13.00 (세전).
--
-- 왜(2026-10-19): Chronogolf 에 걸린 가을 요금(10-01 부터)에 맞춘다. Chronogolf 마켓플레이스 API
-- (club 19671, Public 요금제)에서 읽은 값:
--   - 18홀: 평일 $40.71(0039 그대로), 주말 $51.33 + tax = $58.00. 0039 의 $58.41 을 대신한다.
--   - 9홀 평일 $28.31, 카트 18홀 $19.47 / 9홀 $11.50 — 지금 값과 같아 그대로 둔다.
--   - 추가 품목: Pull Cart 18홀 $7.08, 9홀 $3.54, Small Range Basket $8.00, Large Range Basket $13.00.
--
-- 규칙:
--   - 공휴일 기본 요금도 주말과 같은 $51.33. `pelham_tee_holidays.rate` 를 채운 날은 그 값이 이긴다.
--   - 새로 매기는 값만 바뀐다. 이미 적힌 예약의 rate·extras 금액은 건드리지 않는다.
--
-- 같은 값이 `backend/api/routes/tee_sheet.py`(WEEKEND_RATE), `frontend/app/golf/rates/page.tsx`
-- 에도 있다. 바꾸면 같이 고쳐라.
--
-- 전제: 0025, 0026. 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다.

do $$
begin
  if to_regclass('public.pelham_tee_holidays') is null then
    raise exception '0040 needs 0025 first (pelham_tee_holidays is missing).';
  end if;
  if to_regclass('public.pelham_tee_extras') is null then
    raise exception '0040 needs 0026 first (pelham_tee_extras is missing).';
  end if;
end;
$$;

-- 0039 그대로, 주말·공휴일 58.41 → 51.33 만.
create or replace function public.pelham_tee_rate(p_date date)
returns numeric
language sql
stable
set search_path = ''
as $$
  select coalesce(
           (select coalesce(h.rate, 51.33) from public.pelham_tee_holidays h where h.holiday_date = p_date),
           case when extract(isodow from p_date) in (6, 7) then 51.33 else 40.71 end
         )
$$;

revoke all on function public.pelham_tee_rate(date) from public, anon, authenticated;

update public.pelham_tee_extras set price = 7.08,  updated_at = now() where code = 'pull_cart_18' and price <> 7.08;
update public.pelham_tee_extras set price = 3.54,  updated_at = now() where code = 'pull_cart_9'  and price <> 3.54;
update public.pelham_tee_extras set price = 8.00,  updated_at = now() where code = 'small_basket' and price <> 8.00;
update public.pelham_tee_extras set price = 13.00, updated_at = now() where code = 'large_basket' and price <> 13.00;
