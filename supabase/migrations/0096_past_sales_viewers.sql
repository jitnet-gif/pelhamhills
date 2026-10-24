-- 계산대 Refund 창의 "지난 날 영수증 목록" — 매니저와 아래 명단만.
--
-- 왜(2026-10-24): Refund 창에서 날짜를 골라 지난 날 영수증을 모두 훑어볼 수 있었다. 클럽이
-- 매니저(현금 리포트 명단 `pelham_cash_viewers`, 0046)와 admin@, proshop@, analysis@ 만 지난 날을
-- 보게 하자고 했다. 나머지 계정은 오늘 목록만 보고, 지난 영수증은 종이 영수증을 쏘거나 번호를 쳐서 연다.
--
-- 명단은 SQL editor 에서 바꾼다:
--   insert into public.pelham_past_sales_viewers (email) values ('someone@pelhamhills.ca') on conflict do nothing;
--   delete from public.pelham_past_sales_viewers where email = 'someone@pelhamhills.ca';
--
-- 화면만 막는다. 계산서 목록 함수(pelham_staff_bills)는 티 시트 예약 창이 지난 날 결제를 읽느라
-- 쓰고 있어 서버에서 막지 않는다.
--
-- 전제: 0004, 0046. 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다.

do $$
begin
  if to_regprocedure('public.pelham_is_cash_viewer()') is null then
    raise exception '0096 needs 0046 first (pelham_is_cash_viewer is missing).';
  end if;
end;
$$;

create table if not exists public.pelham_past_sales_viewers (
  email       text primary key check (email = lower(btrim(email)) and email <> ''),
  created_at  timestamptz not null default now()
);

insert into public.pelham_past_sales_viewers (email) values
  ('admin@pelhamhills.ca'),
  ('proshop@pelhamhills.ca'),
  ('analysis@pelhamhills.ca')
on conflict do nothing;

alter table public.pelham_past_sales_viewers enable row level security;
revoke all on public.pelham_past_sales_viewers from anon, authenticated;

-- 지금 계정이 Refund 창에서 지난 날을 고를 수 있는가. 명단 밖이면 false(에러 아님).
create or replace function public.pelham_staff_past_sales_access()
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.pelham_require_staff();
  return public.pelham_is_cash_viewer()
      or exists (select 1
                   from auth.users u
                   join public.pelham_past_sales_viewers v on v.email = lower(u.email)
                  where u.id = auth.uid());
end;
$$;

revoke all on function public.pelham_staff_past_sales_access() from public, anon, authenticated;
grant execute on function public.pelham_staff_past_sales_access() to authenticated;

notify pgrst, 'reload schema';

select count(*) as viewers from public.pelham_past_sales_viewers;  -- 3 이상
