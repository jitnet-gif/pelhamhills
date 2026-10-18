-- 홀 수를 바꾸면 그린피를 늘 새 홀 수의 요금표 값으로 — 아무도 결제하지 않았을 때.
--
-- 왜(2026-10-18): 0033 은 그린피가 "옛 홀 수의 자동값" 일 때만 따라갔다. 그런데 0033 때 9홀로 바꾼
-- 예약은 18홀의 절반(평일 $23.90)이 적혀 있고, 0034 부터 9홀 자동값은 $28.31 이라 그 예약은 "손으로
-- 고친 금액" 으로 보여 18 ↔ 9 를 바꿔도 그린피가 그대로 남았다. 손으로 고친 예약도 마찬가지였다.
-- 홀 수를 바꾸는 것은 요금표를 다시 적용하라는 뜻이므로 이제는 늘 다시 채운다.
--
-- 규칙:
--   - 결제한 사람이 한 명이라도 있으면 그대로 둔다 — 이미 받은 돈과 재인쇄 영수증이 달라진다.
--   - 같은 요청에 rate 를 직접 보냈으면 그 값이 이긴다(매니저 승인도 그대로 받는다).
--   - 자동으로 채우는 것은 매니저 승인을 묻지 않는다. 특별 금액은 홀 수를 바꾼 뒤 다시 적는다.
--   - 카트 요금은 0004·0035 규칙 그대로(자동값일 때만 따라간다).
--
-- 같은 규칙이 `backend/api/routes/tee_sheet.py` 의 holes 변경에 있다. 바꾸면 둘을 같이 고쳐라.
--
-- 전제: 0033, 0034. 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다.

do $$
begin
  if to_regprocedure('public.pelham_tee_rate_for(date, integer)') is null then
    raise exception '0036 needs 0033 first (pelham_tee_rate_for is missing).';
  end if;
  if to_regprocedure('public.pelham_tee_nine_from(date)') is null then
    raise exception '0036 needs 0034 first (pelham_tee_nine_from is missing).';
  end if;
end;
$$;

-- 0033 의 문지기에서 "옛 홀 수의 자동값일 때만" 조건 하나만 뺐다. 본문(_ungated)은 그대로다.
create or replace function public.pelham_staff_booking_patch(p_id text, p jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_doc jsonb;
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

  -- 홀 수가 바뀌면 그린피를 새 홀 수의 요금표 값으로. 잘못된 holes 값은 _ungated 가 422 로 거른다.
  if not (p ? 'rate' and jsonb_typeof(p->'rate') = 'number') and coalesce(p->>'holes', '') in ('9', '18') then
    select t.doc into v_doc from public.pelham_tee_bookings t where t.id = p_id;
    if v_doc is not null then
      v_new_holes := (p->>'holes')::integer;
      if v_new_holes <> coalesce((v_doc->>'holes')::integer, 18)
         and not exists (
           select 1 from jsonb_array_elements(coalesce(v_doc->'players', '[]'::jsonb)) pl
            where coalesce((pl.value->>'paid')::boolean, false)) then
        p := p || jsonb_build_object('rate', public.pelham_tee_rate_for((v_doc->>'date')::date, v_new_holes));
      end if;
    end if;
  end if;

  return public.pelham_staff_booking_patch_ungated(p_id, p);
end;
$$;

comment on function public.pelham_staff_booking_patch(text, jsonb) is 'pelham manager gate';

revoke all on function public.pelham_staff_booking_patch(text, jsonb) from public, anon, authenticated;
grant execute on function public.pelham_staff_booking_patch(text, jsonb) to authenticated;
