-- 온라인 결제 이메일 영수증 자동 발송(2026-10-30 클럽 요청: "온라인 결제 이메일 영수증 자동 발송").
--
-- 왜: 온라인 결제는 승인 문자(0028)뿐이라 STOP 번호이거나 번호가 없는 손님은 받는 것이 없었다. 회원권 온라인 결제는
-- 그 문자도 없다. 계산대처럼 직원이 결제 끝 화면에서 보내 줄 수도 없다.
--
-- 누가 보내나: FastAPI 의 `backend/services/payment_emails.py`. 이 파일은 "보낼 것 집기" 와 "결과 적기" 만 한다.
--
-- 왜 표를 새로 만드나: 0028 표는 번호에 묶여 있고(no_phone), 0140 표는 시뮬레이터 예약 하나당 한 줄이다.
-- 온라인 결제 표 둘의 id 형식이 달라서(bigint, uuid) 둘 다 유일한 invoice(PHW…, PHM…)로 줄을 잡는다.
--
-- 규칙:
--   - 대상: pelham_online_payments(티타임·시뮬레이터)와 pelham_membership_payments(회원권)의 approved.
--   - 한 결제에 한 통. invoice 가 유일하고 보내기 전에 줄을 먼저 만든다. 실패해도 다시 집지 않는다.
--   - 막 승인된 것만: 30분 안에 승인. 이 파일을 처음 돌려도 지난 결제에 메일이 쏟아지지 않는다.
--   - 이메일이 없으면 no_email 로 닫는다.
--   - 환불로 approved 가 아니게 된 결제는 집지 않는다.
--
-- 전제: 0021, 0042. 실행: SQL editor 에 이 파일 전체를 붙여 한 번. Fly 배포보다 먼저. 다시 실행해도 안전하다.

do $$
begin
  if to_regclass('public.pelham_online_payments') is null then
    raise exception '0141 needs 0020 first (pelham_online_payments is missing).';
  end if;
  if to_regclass('public.pelham_membership_payments') is null then
    raise exception '0141 needs 0042 first (pelham_membership_payments is missing).';
  end if;
end;
$$;

-- ===== 테이블 ==========================================================

create table if not exists public.pelham_payment_emails (
  id          bigint generated always as identity primary key,
  invoice     text not null unique check (invoice ~ '^PH[WM][0-9A-F]{12}$'),
  email       text check (email is null or length(email) <= 254),
  -- sending: 집음 / sent·failed: 결과 / no_email: 보낼 주소가 없음
  status      text not null check (status in ('sending', 'sent', 'failed', 'no_email')),
  error       text check (error is null or length(error) <= 300),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

alter table public.pelham_payment_emails enable row level security;
revoke all on public.pelham_payment_emails from anon, authenticated;

-- ===== 함수 (service_role) =============================================

-- 보낼 것을 집는다. sending 만 돌려준다.
-- 예약: {id, kind: 'booking', email, bill}  bill = pelham_pos_bill_json (계산대 영수증과 같은 값)
-- 회원권: {id, kind: 'membership', email, invoice, amount, card_brand, card_last4, approved_at, reference,
--          member_name, season, membership_type, plan, balance}   amount 는 센트, balance 는 달러
create or replace function public.pelham_payment_emails_claim(p_limit integer default 20)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_out jsonb := '[]'::jsonb;
  r record;
  v_email text;
  v_row public.pelham_payment_emails;
begin
  for r in
    select o.invoice, o.customer_email, o.bill_id
      from public.pelham_online_payments o
      left join public.pelham_payment_emails x on x.invoice = o.invoice
     where o.status = 'approved' and o.approved_at > now() - interval '30 minutes'
       and x.id is null
     order by o.id
     limit greatest(coalesce(p_limit, 20), 1)
  loop
    v_email := nullif(btrim(coalesce(r.customer_email, '')), '');
    v_row := null;
    insert into public.pelham_payment_emails (invoice, email, status)
    values (r.invoice, v_email, case when v_email is null then 'no_email' else 'sending' end)
    on conflict (invoice) do nothing
    returning * into v_row;
    if v_row.id is not null and v_row.status = 'sending' then
      v_out := v_out || jsonb_build_object(
        'id', v_row.id, 'kind', 'booking', 'email', v_email, 'bill', public.pelham_pos_bill_json(r.bill_id));
    end if;
  end loop;

  for r in
    select o.invoice, coalesce(nullif(btrim(o.email), ''), nullif(btrim(m.email), '')) as email, o.amount,
           o.card_brand, o.card_last4, o.approved_at, m.id as membership_id, m.member_name, m.season,
           m.membership_type, m.plan, greatest(m.amount_due - m.amount_paid, 0) as balance
      from public.pelham_membership_payments o
      join public.pelham_memberships m on m.id = o.membership_id
      left join public.pelham_payment_emails x on x.invoice = o.invoice
     where o.status = 'approved' and o.approved_at > now() - interval '30 minutes'
       and x.id is null
     order by o.approved_at
     limit greatest(coalesce(p_limit, 20), 1)
  loop
    v_row := null;
    insert into public.pelham_payment_emails (invoice, email, status)
    values (r.invoice, r.email, case when r.email is null then 'no_email' else 'sending' end)
    on conflict (invoice) do nothing
    returning * into v_row;
    if v_row.id is not null and v_row.status = 'sending' then
      v_out := v_out || jsonb_build_object(
        'id', v_row.id, 'kind', 'membership', 'email', r.email, 'invoice', r.invoice, 'amount', r.amount,
        'card_brand', r.card_brand, 'card_last4', r.card_last4, 'approved_at', public.pelham_iso(r.approved_at),
        'reference', upper(left(r.membership_id::text, 8)), 'member_name', r.member_name, 'season', r.season,
        'membership_type', r.membership_type, 'plan', r.plan, 'balance', r.balance);
    end if;
  end loop;

  return v_out;
end;
$$;

-- 결과를 적는다. sending 줄만.
create or replace function public.pelham_payment_email_result(p_id bigint, p_status text, p_error text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_status not in ('sent', 'failed') then
    perform public.pelham_fail('422', 'Unknown email status.');
  end if;
  update public.pelham_payment_emails
     set status = p_status, error = left(p_error, 300), updated_at = now()
   where id = p_id and status = 'sending';
end;
$$;

-- ===== 권한 ============================================================

revoke all on function public.pelham_payment_emails_claim(integer) from public, anon, authenticated;
revoke all on function public.pelham_payment_email_result(bigint, text, text) from public, anon, authenticated;

grant execute on function public.pelham_payment_emails_claim(integer) to service_role;
grant execute on function public.pelham_payment_email_result(bigint, text, text) to service_role;

-- ===== 확인 ============================================================
-- 두 줄이 나와야 한다.
select proname from pg_proc
 where proname in ('pelham_payment_emails_claim', 'pelham_payment_email_result')
 order by proname;
