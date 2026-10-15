-- 결제 승인 문자(payment approval texts) — 카드가 승인되면 손님 휴대폰으로 금액·카드 끝 4자리를 보낸다.
--
-- 왜(2026-10-15): 온라인으로 낸 손님도, 계산대 단말기(Stripe Terminal)에서 낸 손님도 "얼마가 어느 카드로
-- 승인됐나" 를 바로 받아 보게 한다. 종이 영수증을 안 받아 가는 손님이 많고, 온라인 결제는 결과 화면을
-- 닫으면 남는 게 없다.
--
-- 누가 보내나: FastAPI 의 `backend/services/payment_texts.py`. 승인을 기록하는 곳(단말기 `_final`,
-- 온라인 `settle`)이 깨우고, 놓친 것은 1분마다 다시 훑는다. 이 파일은 "보낼 것 집기" 와 "결과 적기" 만 한다.
--
-- 규칙:
--   - 한 결제에 한 번. (source, source_id) 가 유일하고, 집을 때 줄을 먼저 만든다 — 웹훅과 화면 확인이
--     동시에 와도, 서버가 여러 개 떠도 두 번 가지 않는다. 실패해도 다시 집지 않는다.
--   - 막 승인된 것만: 단말기는 30분 안에 만든 판매, 온라인은 30분 안에 승인된 것. 이 파일을 처음 돌려도
--     지난 결제에 문자가 쏟아지지 않는다.
--   - 번호: 계산대에서 직원이 적은 번호(`waiting` 줄) > 계산서에 담긴 티타임 플레이어의 번호 >
--     그 예약의 첫 번호 > 시뮬레이터 예약 번호. 온라인은 예약 번호. 번호가 없으면 `no_phone` 으로 남긴다.
--   - 손으로 친 카드(keyed)는 대상이 아니다 — 우리가 승인을 직접 받은 게 아니다.
--
-- 전제: 0005, 0008, 0019, 0020, 0021. 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다.

do $$
begin
  if to_regclass('public.pelham_online_payments') is null then
    raise exception '0028 needs 0020 first (pelham_online_payments is missing).';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'pelham_terminal_transactions'
                    and column_name = 'payment_intent') then
    raise exception '0028 needs 0021 first (pelham_terminal_transactions.payment_intent is missing).';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'pelham_bill_lines'
                    and column_name = 'sim_reservation_id') then
    raise exception '0028 needs 0008 first (pelham_bill_lines.sim_reservation_id is missing).';
  end if;
end;
$$;

-- ===== 테이블 ==========================================================

-- 결제 하나 = 한 줄. terminal 은 pelham_terminal_transactions.id, online 은 pelham_online_payments.id.
create table if not exists public.pelham_payment_texts (
  id          bigint generated always as identity primary key,
  source      text not null check (source in ('terminal', 'online')),
  source_id   bigint not null,
  -- E.164 가 아니어도 된다(FastAPI 가 정규화한다). no_phone 이면 비어 있다.
  phone       text check (phone is null or length(phone) <= 40),
  -- waiting: 계산대가 번호를 적어 둠(아직 승인 전) / sending: 집음 / sent·failed·skipped: Twilio 결과
  -- no_phone: 보낼 번호가 없음
  status      text not null check (status in ('waiting', 'sending', 'sent', 'failed', 'skipped', 'no_phone')),
  error       text check (error is null or length(error) <= 300),
  twilio_sid  text check (twilio_sid is null or length(twilio_sid) <= 64),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (source, source_id)
);

alter table public.pelham_payment_texts enable row level security;
revoke all on public.pelham_payment_texts from anon, authenticated;

-- ===== 번호 찾기 =======================================================

-- 티타임 예약의 번호. p_player 가 있으면 그 사람 번호부터, 없으면 예약의 첫 번호.
create or replace function public.pelham_pt_booking_phone(p_booking text, p_player text)
returns text
language sql
stable
set search_path = ''
as $$
  select coalesce(
    (select nullif(btrim(e.value->>'phone'), '')
       from public.pelham_tee_bookings t, jsonb_array_elements(coalesce(t.doc->'players', '[]'::jsonb)) e
      where t.id = p_booking and p_player is not null and e.value->>'id' = p_player
      limit 1),
    (select nullif(btrim(e.value->>'phone'), '')
       from public.pelham_tee_bookings t,
            jsonb_array_elements(coalesce(t.doc->'players', '[]'::jsonb)) with ordinality e(value, n)
      where t.id = p_booking and nullif(btrim(e.value->>'phone'), '') is not null
      order by e.n
      limit 1));
$$;

-- 계산서에 담긴 예약에서 번호 하나. 티타임 플레이어 → 시뮬레이터 예약 순.
create or replace function public.pelham_pt_bill_phone(p_bill bigint)
returns text
language sql
stable
set search_path = ''
as $$
  select coalesce(
    (select public.pelham_pt_booking_phone(li.booking_id, li.player_id)
       from public.pelham_bill_lines li
      where li.bill_id = p_bill and li.kind = 'tee_player'
        and public.pelham_pt_booking_phone(li.booking_id, li.player_id) is not null
      order by li.id
      limit 1),
    (select nullif(btrim(r.phone), '')
       from public.pelham_bill_lines li
       join public.pelham_sim_reservations r on r.id = li.sim_reservation_id
      where li.bill_id = p_bill and li.kind = 'sim_booking' and nullif(btrim(r.phone), '') is not null
      order by li.id
      limit 1));
$$;

-- ===== 함수 (service_role) =============================================

-- 계산대가 "이 번호로 보내 달라" 고 적어 둔다(판매를 시작할 때). 승인되면 이 번호가 이긴다.
-- 이미 보냈거나 집은 줄은 바꾸지 않는다.
create or replace function public.pelham_payment_text_phone(p_txn bigint, p_phone text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_phone text := nullif(btrim(coalesce(p_phone, '')), '');
begin
  if v_phone is null or length(v_phone) > 40 then
    perform public.pelham_fail('422', 'Enter a phone number for the receipt text.');
  end if;
  if not exists (select 1 from public.pelham_terminal_transactions where id = p_txn and kind = 'sale') then
    perform public.pelham_fail('404', 'Card terminal transaction not found.');
  end if;
  insert into public.pelham_payment_texts (source, source_id, phone, status)
  values ('terminal', p_txn, v_phone, 'waiting')
  on conflict (source, source_id) do update
     set phone = excluded.phone, updated_at = now()
   where public.pelham_payment_texts.status = 'waiting';
end;
$$;

-- 보낼 것을 집는다. 집은 줄은 sending(번호 있음) 또는 no_phone 이 된다. sending 만 돌려준다.
-- [{id, source, phone, amount, tip, card_brand, card_last4, receipt_no, invoice, confirmation_code,
--   description, approved_at}]
create or replace function public.pelham_payment_texts_claim(p_limit integer default 20)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_out jsonb := '[]'::jsonb;
  r record;
  v_phone text;
  v_text public.pelham_payment_texts;
begin
  -- 단말기 판매: 승인, 아직 되돌리지 않음, 30분 안에 시작.
  for r in
    select t.id, t.bill_id, t.total_amount, t.tip, t.card_brand, t.card_last4, t.updated_at,
           b.receipt_no, w.phone as waiting_phone
      from public.pelham_terminal_transactions t
      left join public.pelham_bills b on b.id = t.bill_id
      left join public.pelham_payment_texts w on w.source = 'terminal' and w.source_id = t.id
     where t.kind = 'sale' and t.approved and t.payment_intent is not null and t.voided_at is null
       and t.created_at > now() - interval '30 minutes'
       and (w.id is null or w.status = 'waiting')
     order by t.id
     limit greatest(coalesce(p_limit, 20), 1)
  loop
    v_phone := coalesce(nullif(btrim(r.waiting_phone), ''), public.pelham_pt_bill_phone(r.bill_id));
    v_text := null;
    if r.waiting_phone is not null then
      update public.pelham_payment_texts
         set status = 'sending', updated_at = now()
       where source = 'terminal' and source_id = r.id and status = 'waiting'
      returning * into v_text;
    else
      insert into public.pelham_payment_texts (source, source_id, phone, status)
      values ('terminal', r.id, v_phone, case when v_phone is null then 'no_phone' else 'sending' end)
      on conflict (source, source_id) do nothing
      returning * into v_text;
    end if;
    if v_text.id is not null and v_text.status = 'sending' then
      v_out := v_out || jsonb_build_object(
        'id', v_text.id, 'source', 'terminal', 'phone', v_text.phone,
        'amount', r.total_amount, 'tip', r.tip, 'card_brand', r.card_brand, 'card_last4', r.card_last4,
        'receipt_no', r.receipt_no, 'approved_at', public.pelham_iso(r.updated_at));
    end if;
  end loop;

  -- 온라인: 계산서에 기록된(approved) 것, 30분 안에 승인.
  for r in
    select o.id, o.kind, o.booking_id, o.sim_reservation_id, o.amount, o.card_brand, o.card_last4,
           o.invoice, o.confirmation_code, o.description, o.approved_at, b.receipt_no
      from public.pelham_online_payments o
      left join public.pelham_bills b on b.id = o.bill_id
      left join public.pelham_payment_texts x on x.source = 'online' and x.source_id = o.id
     where o.status = 'approved' and o.approved_at > now() - interval '30 minutes'
       and x.id is null
     order by o.id
     limit greatest(coalesce(p_limit, 20), 1)
  loop
    if r.kind = 'tee' then
      v_phone := public.pelham_pt_booking_phone(r.booking_id, null);
    else
      select nullif(btrim(s.phone), '') into v_phone
        from public.pelham_sim_reservations s where s.id = r.sim_reservation_id;
    end if;
    v_text := null;
    insert into public.pelham_payment_texts (source, source_id, phone, status)
    values ('online', r.id, v_phone, case when v_phone is null then 'no_phone' else 'sending' end)
    on conflict (source, source_id) do nothing
    returning * into v_text;
    if v_text.id is not null and v_text.status = 'sending' then
      v_out := v_out || jsonb_build_object(
        'id', v_text.id, 'source', 'online', 'phone', v_text.phone,
        'amount', r.amount, 'tip', 0, 'card_brand', r.card_brand, 'card_last4', r.card_last4,
        'receipt_no', r.receipt_no, 'invoice', r.invoice, 'confirmation_code', r.confirmation_code,
        'description', r.description, 'approved_at', public.pelham_iso(r.approved_at));
    end if;
  end loop;

  return v_out;
end;
$$;

-- Twilio 결과를 적는다. sending 줄만.
create or replace function public.pelham_payment_text_result(p_id bigint, p_status text, p_error text, p_sid text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_status not in ('sent', 'failed', 'skipped') then
    perform public.pelham_fail('422', 'Unknown text status.');
  end if;
  update public.pelham_payment_texts
     set status = p_status, error = left(p_error, 300), twilio_sid = left(p_sid, 64), updated_at = now()
   where id = p_id and status = 'sending';
end;
$$;

-- ===== 권한 ============================================================

revoke all on function public.pelham_pt_booking_phone(text, text) from public, anon, authenticated;
revoke all on function public.pelham_pt_bill_phone(bigint) from public, anon, authenticated;
revoke all on function public.pelham_payment_text_phone(bigint, text) from public, anon, authenticated;
revoke all on function public.pelham_payment_texts_claim(integer) from public, anon, authenticated;
revoke all on function public.pelham_payment_text_result(bigint, text, text, text) from public, anon, authenticated;

grant execute on function public.pelham_payment_text_phone(bigint, text) to service_role;
grant execute on function public.pelham_payment_texts_claim(integer) to service_role;
grant execute on function public.pelham_payment_text_result(bigint, text, text, text) to service_role;
