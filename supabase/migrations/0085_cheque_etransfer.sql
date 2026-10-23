-- 계산대 결제 수단에 수표(cheque)와 Interac e-Transfer(e_transfer)를 더한다.
--
-- 왜(2026-10-23): 클럽이 계산대에서 수표·e-Transfer 도 받는다. 지금까지는 회원권 신청서(0041·0070)에만 있었고
-- 계산대(0005·0011·0021)에는 없어서 매출 리포트 By payment 에 나오지 않았다.
--
-- 바뀌는 것
-- 1. `pelham_bill_payments.method` 허용값에 'cheque', 'e_transfer'.
-- 2. `pelham_staff_bill_pay` 의 수단 확인 — 운영 DB 의 지금 정의를 읽어 수단 목록만 바꾼다(0051 과 같은 방법).
-- 3. `pelham_register_methods` — Close Register 표에 두 줄. 세는 줄이 아니다(Member account 처럼 기록만).
-- 4. 이미 닫은 마감의 expected 에 두 수단을 0 으로 채운다. 안 그러면 키가 늘어 옛 마감이 전부 "센 뒤에 바뀜" 이 된다.
--    그 전에는 이 수단으로 받은 결제가 없었으니 0 이 맞다.
--
-- 전제: 0011, 0021, 0023. 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다.

do $$
begin
  if to_regprocedure('public.pelham_staff_bill_pay(bigint, jsonb)') is null then
    raise exception '0085 needs 0021 first (pelham_staff_bill_pay is missing).';
  end if;
  if to_regprocedure('public.pelham_register_methods()') is null then
    raise exception '0085 needs 0023 first (pelham_register_methods is missing).';
  end if;
end;
$$;

-- ===== 테이블 ==========================================================

alter table public.pelham_bill_payments drop constraint if exists pelham_bill_payments_method_check;
alter table public.pelham_bill_payments add constraint pelham_bill_payments_method_check
  check (method in ('cash', 'card', 'debit', 'cheque', 'e_transfer', 'member_account', 'gift_card', 'rain_check'));

-- ===== 결제 ============================================================

-- 운영 DB 의 정의가 0021 글자 그대로가 아니다(2026-10-23 첫 실행에서 확인) — 목록을 모양으로 찾는다:
-- `v_method not in ('cash', ...)` 첫 번째 것의 닫는 괄호 앞에 두 수단을 붙인다.
do $$
declare
  v_def text := pg_get_functiondef('public.pelham_staff_bill_pay(bigint, jsonb)'::regprocedure);
  v_list text := (regexp_match(v_def, 'v_method\s+not\s+in\s*\(\s*''cash''[^)]*\)', 'i'))[1];
  v_at integer := position('not a payment method' in v_def);
begin
  if v_list is null then
    raise exception '0085: method list not found in pelham_staff_bill_pay. Near the check: %',
      case when v_at > 0 then substr(v_def, greatest(v_at - 400, 1), 450) else '(no "not a payment method" text)' end;
  end if;
  if v_list like '%''cheque''%' and v_list like '%''e_transfer''%' then
    return;  -- 이미 바꿨다
  end if;
  execute replace(v_def, v_list,
                  regexp_replace(v_list, '\)$', ', ''cheque'', ''e_transfer'')'));
end;
$$;

-- ===== 계산대 마감 =======================================================

-- 표의 줄 순서 = 현금 먼저, 셀 수 있는 것, 셀 수 없는 것.
create or replace function public.pelham_register_methods()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array['cash', 'card', 'debit', 'cheque', 'e_transfer', 'member_account', 'gift_card', 'rain_check']
$$;

update public.pelham_register_closes c
   set expected = jsonb_build_object('cheque', 0, 'e_transfer', 0) || c.expected
 where not (c.expected ? 'cheque' and c.expected ? 'e_transfer');

notify pgrst, 'reload schema';
