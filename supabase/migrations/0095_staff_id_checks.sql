-- 담당자 이름 옆에 "ID ✓" — 그날 그 이름이 Pelham Shift ID 로 확인됐는가(2026-10-24 클럽 요청).
--
-- 왜: 모든 거래·자료에 누가 처리했는지 보이게 해 달라는 요청. 담당자(Cashier)는 이름만 남는다 — Shift ID 는
-- pelham-shift 로그인 비밀번호이기도 해서 어디에도 적지 않는다(`cashierCode.ts`). 대신 이름을 손으로 쳤는지,
-- 직원 ID 로 확인된 이름인지를 가른다.
--
-- 어떻게: FastAPI 가 Shift ID 로 이름을 찾을 때마다(`/pos/cashier-code`, `/pos/approve`) service_role 로
-- `pelham_shift_record_check(name)` 을 불러 (이름, 영업일, 시각)을 적는다. 화면은 그날 확인된 이름 목록
-- (`pelham_staff_verified_cashiers`)을 읽어, 계산서·마감·레인체크·장부의 담당자 이름이 그 목록에 있으면 ✓ 를 붙인다.
-- 뜻은 "그날 이 이름의 직원이 자기 ID 를 쳤다"이지 그 거래 하나를 그 사람이 쳤다는 증명은 아니다 —
-- 계산대는 기억한 담당자 이름으로 다음 계산서를 연다(`currentBill.ts`).
--
-- 번호는 적지 않는다. 브라우저(authenticated)는 기록 함수를 부를 수 없다 — 부를 수 있으면 아무 이름이나 ✓ 가 된다.
--
-- 바뀌는 것:
--   pelham_staff_id_checks                 — 새 표.
--   pelham_shift_record_check(text)         — service_role 만.
--   pelham_staff_verified_cashiers(date, date) — 직원. [{business_date, name}].
--
-- 전제: 0004, 0005. 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다.

create table if not exists public.pelham_staff_id_checks (
  id            bigserial primary key,
  name          text not null,
  business_date date not null default public.pelham_pos_today(),
  checked_at    timestamptz not null default now()
);

create index if not exists pelham_staff_id_checks_date on public.pelham_staff_id_checks (business_date);

alter table public.pelham_staff_id_checks enable row level security;
revoke all on table public.pelham_staff_id_checks from public, anon, authenticated;

-- FastAPI 만 부른다. 이름 공백은 계산대와 같게 정리한다.
create or replace function public.pelham_shift_record_check(p_name text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_name text := nullif(regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g'), '');
begin
  if v_name is null then
    return;
  end if;
  insert into public.pelham_staff_id_checks (name) values (left(v_name, 80));
end;
$$;

-- 그 기간에 ID 로 확인된 이름(영업일마다 한 번씩). 화면이 `cashierKey` 로 맞춘다.
create or replace function public.pelham_staff_verified_cashiers(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.pelham_require_staff();
  return coalesce((
    select jsonb_agg(jsonb_build_object('business_date', d, 'name', n) order by d, n)
      from (
        select distinct c.business_date as d, c.name as n
          from public.pelham_staff_id_checks c
         where c.business_date between p_from and p_to
      ) s
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.pelham_shift_record_check(text) from public, anon, authenticated;
grant execute on function public.pelham_shift_record_check(text) to service_role;
revoke all on function public.pelham_staff_verified_cashiers(date, date) from public, anon;
grant execute on function public.pelham_staff_verified_cashiers(date, date) to authenticated;
