-- 9홀 그린피 — 직원 시트에서 홀 수를 바꾸면 그린피도 따라 바뀐다.
--
-- 왜(2026-10-18): 예약 상세에서 18 → 9홀로 바꿔도 그린피가 58.41 그대로 남았다. 요금표
-- (`pelham_tee_rate`, 0025)에 홀 수가 없었기 때문이다. 클럽 결정: 9홀 = 그날 18홀 요금의 절반
-- (평일 23.90, 주말·공휴일 29.21, 공휴일 개별 요금도 절반). 확정 가격이 따로 나오면
-- `pelham_tee_rate_for` 한 곳만 고친다.
--
-- 규칙(0004 의 카트 요금과 같은 꼴):
--   - 홀 수를 바꿀 때 그린피가 아직 "옛 홀 수의 자동값" 이면 새 홀 수의 자동값으로 바꾼다.
--     사람이 손으로 고친 금액은 그대로 둔다.
--   - 결제한 사람이 한 명이라도 있으면 그대로 둔다 — 그린피는 예약 하나에 한 금액이라, 바꾸면
--     이미 받은 돈과 재인쇄 영수증이 달라진다.
--   - 같은 요청에 rate 를 직접 보냈으면 그 값이 이긴다(매니저 승인도 그대로 받는다).
--   - 자동으로 따라가는 것은 매니저 승인을 묻지 않는다. 감사 기록에는 "Rate set to $..." 가 남는다.
--
-- 손님 예약(0012 `pelham_tee_book`·`pelham_tee_guest_update`)은 아직 18홀 요금을 쓴다 — 이 파일은 직원 시트만.
--
-- 전제: 0004, 0024, 0025. 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다.

do $$
begin
  if to_regprocedure('public.pelham_staff_booking_patch_ungated(text, jsonb)') is null then
    raise exception '0033 needs 0024 first (pelham_staff_booking_patch_ungated is missing).';
  end if;
  if to_regclass('public.pelham_tee_holidays') is null then
    raise exception '0033 needs 0025 first (pelham_tee_holidays is missing).';
  end if;
end;
$$;

-- 그날, 그 홀 수의 1인 그린피(세전). 18홀은 `pelham_tee_rate` 그대로, 9홀은 그 절반(센트 반올림).
create or replace function public.pelham_tee_rate_for(p_date date, p_holes integer)
returns numeric
language sql
stable
set search_path = ''
as $$
  select case when p_holes = 9 then round(public.pelham_tee_rate(p_date) / 2, 2)
              else public.pelham_tee_rate(p_date) end
$$;

-- 0024 의 문지기 + 홀 수 변경 시 그린피 따라가기. 본문(_ungated)은 그대로다.
create or replace function public.pelham_staff_booking_patch(p_id text, p jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_doc jsonb;
  v_date date;
  v_old_holes integer;
  v_new_holes integer;
begin
  perform public.pelham_require_staff();
  -- 그린피(예약 하나에 한 금액)를 바꿀 때만. 날짜·시간·홀·메모 같은 다른 수정은 그대로 둔다.
  if p ? 'rate' and jsonb_typeof(p->'rate') = 'number' and exists (
       select 1 from public.pelham_tee_bookings t
        where t.id = p_id
          and round(coalesce((t.doc->>'rate')::numeric, 0), 2) <> round((p->>'rate')::numeric, 2)) then
    perform public.pelham_require_manager('price', coalesce(p_id, ''), 'changing the green fee');
  end if;

  -- 홀 수만 바뀌면 자동 그린피도 새 홀 수로. 잘못된 holes 값은 _ungated 가 422 로 거른다.
  if not (p ? 'rate' and jsonb_typeof(p->'rate') = 'number') and coalesce(p->>'holes', '') in ('9', '18') then
    select t.doc into v_doc from public.pelham_tee_bookings t where t.id = p_id;
    if v_doc is not null then
      v_date := (v_doc->>'date')::date;
      v_old_holes := coalesce((v_doc->>'holes')::integer, 18);
      v_new_holes := (p->>'holes')::integer;
      if v_new_holes <> v_old_holes
         and public.pelham_same_money((v_doc->>'rate')::numeric, public.pelham_tee_rate_for(v_date, v_old_holes))
         and not exists (
           select 1 from jsonb_array_elements(coalesce(v_doc->'players', '[]'::jsonb)) pl
            where coalesce((pl.value->>'paid')::boolean, false)) then
        p := p || jsonb_build_object('rate', public.pelham_tee_rate_for(v_date, v_new_holes));
      end if;
    end if;
  end if;

  return public.pelham_staff_booking_patch_ungated(p_id, p);
end;
$$;

comment on function public.pelham_staff_booking_patch(text, jsonb) is 'pelham manager gate';

-- ===== 권한 ============================================================

revoke all on function public.pelham_tee_rate_for(date, integer) from public, anon, authenticated;
revoke all on function public.pelham_staff_booking_patch(text, jsonb) from public, anon, authenticated;
grant execute on function public.pelham_staff_booking_patch(text, jsonb) to authenticated;
