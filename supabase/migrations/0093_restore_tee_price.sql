-- 계산서의 그린피가 회원에게도 퍼블릭 요금으로 붙던 것을 바로잡는다.
--
-- 왜(2026-10-24): Tom Neilson(Twilight Member, 3:04 PM)의 카드는 그린피 $0 · 소계 $19.47 인데 계산서 줄은 $65.49 였다.
-- 운영 DB 의 `pelham_pos_tee_price` 가 0026 의 옛 정의(예약 rate + 카트 + 추가품목)로 돌아가 있어서, 0045 가 선수마다
-- 매기는 `greenFee` 를 읽지 않았다. 그래서 계산서·온라인 결제·레인 체크가 회원·할인 요금제를 무시하고 예약 rate
-- (이날은 주말 숄더 14:00 이후 $46.02)를 받았다. 0026 을 다시 실행한 것으로 보인다 — 그러면 0053 의
-- `pelham_tee_player`(회원 연결 customerRef·memberNumber 를 남기는 것)도 같이 0026 으로 돌아가므로 함께 되돌린다.
--
-- 바뀌는 것(두 함수 모두 마지막 정의 그대로, 본문은 바꾸지 않았다):
-- 1. `pelham_pos_tee_price` — 0045. 선수의 greenFee 가 있으면 그것, 없으면 예약 rate. + 카트 + 추가품목.
-- 2. `pelham_tee_player` — 0053. 0026 + customerRef · memberNumber.
-- 열린 계산서는 다음에 읽힐 때 `pelham_pos_recalc`(0080)가 이 함수로 다시 매긴다. 결제된 계산서는 그대로다.
--
-- **0005 · 0026 을 다시 실행하면 또 옛 정의로 돌아간다** — 그 뒤엔 이 파일을 다시 실행.
--
-- 전제: 0026, 0045, 0053. 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다.

do $$
begin
  if to_regprocedure('public.pelham_tee_extras_total(jsonb)') is null then
    raise exception '0093 needs 0026 first (pelham_tee_extras_total is missing).';
  end if;
  if to_regprocedure('public.pelham_tee_player_base(jsonb, integer, text, text)') is null then
    raise exception '0093 needs 0026 first (pelham_tee_player_base is missing).';
  end if;
  if to_regprocedure('public.pelham_tee_plan_fee(text, date, integer, integer, numeric)') is null then
    raise exception '0093 needs 0045 first (pelham_tee_plan_fee is missing).';
  end if;
end;
$$;

-- ===== 한 사람 몫 (0045 그대로) =============================================

create or replace function public.pelham_pos_tee_price(p_doc jsonb, p_player jsonb)
returns integer
language sql
immutable
set search_path = ''
as $$
  select round((coalesce(case when jsonb_typeof(p_player->'greenFee') = 'number'
                              then (p_player->>'greenFee')::numeric end,
                         (p_doc->>'rate')::numeric, 0)
                + case when coalesce((p_player->>'cart')::boolean, false)
                       then coalesce((p_player->>'cartFee')::numeric, 0) else 0 end
                + public.pelham_tee_extras_total(p_player)) * 100)::integer
$$;

-- ===== 선수에 회원 연결 남기기 (0053 그대로) ================================

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

revoke all on function public.pelham_pos_tee_price(jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.pelham_tee_player(jsonb, integer, text, text) from public, anon, authenticated;

notify pgrst, 'reload schema';

-- ===== 확인 ============================================================

-- Tom: 트와일라잇 회원 그린피 $0 + 하프카트 $19.47 → 1947 이어야 한다.
select public.pelham_pos_tee_price('{"rate": 46.02}'::jsonb,
                                   '{"greenFee": 0, "cart": true, "cartFee": 19.47}'::jsonb) as tom_price_cents;
