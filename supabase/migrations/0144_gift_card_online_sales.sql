-- 기프트카드 온라인 판매(2026-10-30 클럽 요청: "gift 카드 웹사이트 발행, 결제는 온라인 스트라이프,
-- 바코드와 gift certificate 를 문자·이메일로").
--
-- 흐름: 손님이 `/gift-cards` 에서 금액·연락처를 넣는다 → `pelham_gift_order_start`(pending 한 줄, invoice `PHG…`)
--       → Stripe Checkout → 웹훅 또는 결과 화면(`/gift-cards/paid`)이 `pelham_gift_order_complete`
--       → 그 순간 `pelham_gift_cards` 에 kind = 'sold' 카드가 생긴다 → FastAPI 가 문자·메일을 보낸다.
--
-- 규칙은 회원권 카드 결제(0042)와 같다:
--   - 금액은 손님 주문으로 정해 여기 적어 두고, Stripe 에서 다시 읽은 금액이 같을 때만 카드를 만든다.
--   - 기록할 수 없는 승인(금액 불일치, 같은 주문을 두 번 결제)은 `needs_reversal` 로 돌려주고 FastAPI 가 곧바로 환불한다.
--   - 표는 RLS 를 켜고 정책 없음, 함수는 service_role 전용. 손님은 FastAPI 를 거쳐서만 닿는다.
--
-- 돈을 받기 전에는 카드가 없다. 코드는 승인 때 만들어진다.
-- HST 는 없다 — 기프트카드는 쓸 때 세금이 붙는다. 카드 수수료(회원권의 3%)도 붙이지 않는다.
-- 온라인 금액: $10 ~ $1,000, 달러 단위. 훔친 카드가 큰 금액의 기프트카드로 바뀌는 것을 줄이려고 발행 화면($5,000)보다 낮다.
--
-- 만료일을 넣지 않는다(No expiry). 판매한 카드의 만료일은 온타리오 O. Reg. 17/05 s.25.3 이 금지한다(0139).
-- 매니저가 Gift Cards 화면에서 날짜를 넣을 수는 있다.
--
-- 환불: Stripe 대시보드에서 환불하면 웹훅(charge.refunded)이 `pelham_gift_order_refund_finish` 를 불러 카드를 무효로
-- 한다. 금액과 상관없이 무효다 — 일부 환불이면 남길 금액으로 Gift Cards 화면에서 새로 발행한다.
--
-- 전제: 0120, 0139. 실행: SQL editor 에 이 파일 전체를 붙여 한 번. Fly 배포 전이어도 후여도 깨지지 않는다
-- (이 파일 전에는 판매 화면이 "지금은 온라인 결제가 안 된다" 고만 말한다). 다시 실행해도 안전하다.

do $$
begin
  if to_regprocedure('public.pelham_staff_gift_card_set_expiry(text,date)') is null then
    raise exception '0144 needs 0139 first.';
  end if;
end;
$$;

-- ===== 주문 =============================================================

create table if not exists public.pelham_gift_card_orders (
  id               uuid primary key default gen_random_uuid(),
  invoice          text not null unique check (invoice ~ '^PHG[0-9A-F]{12}$'),
  amount           integer not null check (amount between 1000 and 100000 and amount % 100 = 0),  -- 센트
  buyer_name       text not null check (length(buyer_name) between 1 and 120),
  buyer_email      text not null check (length(buyer_email) <= 254),
  buyer_phone      text not null check (length(buyer_phone) <= 40),
  -- 선물 받는 사람. 비면 산 사람이 쓴다.
  recipient        text check (length(recipient) <= 120),
  recipient_email  text check (length(recipient_email) <= 254),
  recipient_phone  text check (length(recipient_phone) <= 40),
  -- pending · approved · declined · error · orphaned(받았지만 기록 못 함 → 환불 대상) · refunded
  status           text not null default 'pending'
                   check (status in ('pending', 'approved', 'declined', 'error', 'orphaned', 'refunded')),
  gateway_session  text check (gateway_session is null or gateway_session ~ '^cs_[A-Za-z0-9_]{1,250}$'),
  trans_id         text check (trans_id is null or trans_id ~ '^[A-Za-z0-9_]{1,64}$'),
  refund_trans_id  text,
  auth_code        text,
  card_brand       text,
  card_last4       text,
  response_text    text,
  gift_card_id     bigint references public.pelham_gift_cards (id),
  -- 문자·메일: null(아직) · sending · sent · partial(일부만) · failed. 실패해도 다시 보내지 않는다 — 결과 화면에
  -- 바코드가 있고, 직원이 Gift Cards 화면의 Send message·Send email 로 다시 보낸다.
  delivery_status  text check (delivery_status in ('sending', 'sent', 'partial', 'failed')),
  delivery_error   text check (length(delivery_error) <= 300),
  approved_at      timestamptz,
  refunded_at      timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists pelham_gift_card_orders_trans_idx
  on public.pelham_gift_card_orders (trans_id) where trans_id is not null;

alter table public.pelham_gift_card_orders enable row level security;
revoke all on public.pelham_gift_card_orders from anon, authenticated;

comment on table public.pelham_gift_card_orders is
  '웹사이트 기프트카드 주문. service_role(FastAPI)로만 읽고 쓴다.';

-- 결과 화면과 FastAPI 가 읽는 꼴. 카드 코드는 승인된 주문에만 나간다 — 환불되면 사라진다.
create or replace function public.pelham_gift_order_json(o public.pelham_gift_card_orders)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'invoice', o.invoice,
    'amount', o.amount,
    'status', o.status,
    'card_brand', o.card_brand,
    'card_last4', o.card_last4,
    'trans_id', o.trans_id,
    'gateway_session', o.gateway_session,
    'approved_at', public.pelham_iso(o.approved_at),
    'refunded_at', public.pelham_iso(o.refunded_at),
    'created_at', public.pelham_iso(o.created_at),
    'recipient', coalesce(o.recipient, o.buyer_name),
    'code', case when o.status = 'approved'
                 then (select g.code from public.pelham_gift_cards g where g.id = o.gift_card_id) end
  )
$$;

-- 주문 시작. p: {amount(센트), buyer_name, buyer_email, buyer_phone, recipient?, recipient_email?, recipient_phone?}
create or replace function public.pelham_gift_order_start(p jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_amount integer;
  v_name text := btrim(coalesce(p->>'buyer_name', ''));
  v_email text := lower(btrim(coalesce(p->>'buyer_email', '')));
  v_phone text := btrim(coalesce(p->>'buyer_phone', ''));
  v_to text := nullif(btrim(coalesce(p->>'recipient', '')), '');
  v_to_email text := nullif(lower(btrim(coalesce(p->>'recipient_email', ''))), '');
  v_to_phone text := nullif(btrim(coalesce(p->>'recipient_phone', '')), '');
  v_invoice text;
begin
  begin
    v_amount := (p->>'amount')::integer;
  exception when others then
    perform public.pelham_fail('422', 'Choose a gift card amount.');
  end;
  if v_amount is null or v_amount < 1000 or v_amount > 100000 or v_amount % 100 <> 0 then
    perform public.pelham_fail('422', 'Gift cards are $10 to $1,000, in whole dollars.');
  end if;
  if v_name = '' or length(v_name) > 120 then
    perform public.pelham_fail('422', 'Enter your name.');
  end if;
  if length(v_email) > 254 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    perform public.pelham_fail('422', 'Enter a valid email address.');
  end if;
  if length(public.pelham_phone_key(v_phone)) <> 10 or length(v_phone) > 40 then
    perform public.pelham_fail('422', 'Enter a 10-digit mobile number.');
  end if;
  if length(v_to) > 120 then
    perform public.pelham_fail('422', 'That name is too long.');
  end if;
  if v_to_email is not null and (length(v_to_email) > 254 or v_to_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$') then
    perform public.pelham_fail('422', 'Enter a valid email address for the person receiving the gift.');
  end if;
  if v_to_phone is not null and (length(public.pelham_phone_key(v_to_phone)) <> 10 or length(v_to_phone) > 40) then
    perform public.pelham_fail('422', 'Enter a 10-digit mobile number for the person receiving the gift.');
  end if;

  loop
    v_invoice := 'PHG' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12));
    exit when not exists (select 1 from public.pelham_gift_card_orders where invoice = v_invoice);
  end loop;
  insert into public.pelham_gift_card_orders
    (invoice, amount, buyer_name, buyer_email, buyer_phone, recipient, recipient_email, recipient_phone)
  values (v_invoice, v_amount, v_name, v_email, v_phone, v_to, v_to_email, v_to_phone);

  return jsonb_build_object(
    'invoice', v_invoice,
    'amount', v_amount,
    'email', v_email,
    'description', format('Gift card %s — Pelham Hills Golf Club', '$' || to_char(v_amount / 100, 'FM999,990'))
  );
end;
$$;

create or replace function public.pelham_gift_order_session(p_invoice text, p_session text)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  update public.pelham_gift_card_orders
     set gateway_session = p_session, updated_at = now()
   where invoice = upper(btrim(p_invoice)) and status = 'pending'
$$;

-- 한 줄: invoice 또는 PaymentIntent 로. 없으면 null.
create or replace function public.pelham_gift_order(p jsonb)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select public.pelham_gift_order_json(o)
    from public.pelham_gift_card_orders o
   where (p ? 'invoice' and o.invoice = upper(btrim(p->>'invoice')))
      or (p ? 'trans_id' and o.trans_id = p->>'trans_id')
   order by o.created_at desc
   limit 1
$$;

-- Stripe 에서 다시 읽은 결과를 기록하고, 승인이면 카드를 만든다. p 는 0042 의 pay_complete 와 같다.
-- 같은 결과가 두 번 와도 카드는 한 장이다.
create or replace function public.pelham_gift_order_complete(p jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  o public.pelham_gift_card_orders;
  g public.pelham_gift_cards;
  v_trans text := nullif(btrim(coalesce(p->>'trans_id', '')), '');
  v_code text := btrim(coalesce(p->>'response_code', ''));
  v_amount integer;
  v_last4 text := nullif(right(regexp_replace(coalesce(p->>'card_last4', ''), '[^0-9]', '', 'g'), 4), '');
  v_brand text := left(nullif(btrim(coalesce(p->>'card_brand', '')), ''), 30);
  v_card text;
begin
  if v_trans is null or v_trans !~ '^[A-Za-z0-9_]{1,64}$' then
    perform public.pelham_fail('422', 'trans_id is required.');
  end if;
  begin
    v_amount := (p->>'amount')::integer;
  exception when others then
    perform public.pelham_fail('422', 'amount must be cents.');
  end;

  select * into o from public.pelham_gift_card_orders
   where invoice = upper(btrim(coalesce(p->>'invoice', ''))) for update;
  if o.id is null then
    perform public.pelham_fail('404', 'No gift card order with that invoice.');
  end if;

  -- 같은 주문의 다른 결제 = 두 탭에서 두 번 냈다. 뒤의 것을 돌려준다.
  if o.trans_id is not null and o.trans_id <> v_trans then
    return public.pelham_gift_order_json(o) || jsonb_build_object(
      'needs_reversal', v_code = '1', 'reversal_trans_id', v_trans);
  end if;
  if o.status in ('approved', 'orphaned', 'refunded') then
    return public.pelham_gift_order_json(o) || jsonb_build_object(
      'needs_reversal', o.status = 'orphaned', 'reversal_trans_id', case when o.status = 'orphaned' then o.trans_id end);
  end if;

  if v_code <> '1' then
    update public.pelham_gift_card_orders
       set status = case v_code when '2' then 'declined' else 'error' end,
           trans_id = v_trans, card_brand = v_brand, card_last4 = v_last4,
           response_text = left(p->>'response_text', 300), updated_at = now()
     where id = o.id
    returning * into o;
    return public.pelham_gift_order_json(o) || jsonb_build_object('needs_reversal', false);
  end if;

  if v_amount is distinct from o.amount then
    update public.pelham_gift_card_orders
       set status = 'orphaned', trans_id = v_trans, auth_code = left(p->>'auth_code', 12),
           card_brand = v_brand, card_last4 = v_last4,
           response_text = left(format('Not recorded: approved amount %s cents does not match %s.',
                                       coalesce(v_amount::text, '?'), o.amount), 300),
           updated_at = now()
     where id = o.id
    returning * into o;
    return public.pelham_gift_order_json(o) || jsonb_build_object('needs_reversal', true, 'reversal_trans_id', v_trans);
  end if;

  loop
    v_card := 'GIFT-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));
    exit when not exists (select 1 from public.pelham_gift_cards where code = v_card);
  end loop;
  insert into public.pelham_gift_cards
    (code, amount, kind, recipient, phone, email, note, issued_email, issued_on)
  values
    (v_card, o.amount, 'sold', coalesce(o.recipient, o.buyer_name),
     coalesce(o.recipient_phone, o.buyer_phone), coalesce(o.recipient_email, o.buyer_email),
     format('Bought online by %s · %s ending %s · %s', o.buyer_name, coalesce(v_brand, 'Card'),
            coalesce(v_last4, '????'), o.invoice),
     'online', public.pelham_pos_today())
  returning * into g;

  update public.pelham_gift_card_orders
     set status = 'approved', trans_id = v_trans, auth_code = left(p->>'auth_code', 12),
         card_brand = v_brand, card_last4 = v_last4, response_text = left(p->>'response_text', 300),
         gift_card_id = g.id, approved_at = now(), updated_at = now()
   where id = o.id
  returning * into o;
  return public.pelham_gift_order_json(o) || jsonb_build_object('needs_reversal', false);
end;
$$;

-- 환불이 끝났다(자동 되돌림, 또는 Stripe 대시보드 환불 → 웹훅). 카드를 무효로 한다. 이미 쓴 결제는 그대로 남는다.
create or replace function public.pelham_gift_order_refund_finish(p_trans text, p_refund text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  o public.pelham_gift_card_orders;
begin
  select * into o from public.pelham_gift_card_orders where trans_id = p_trans for update;
  if o.id is null then
    return null;
  end if;
  if o.status = 'refunded' then
    return public.pelham_gift_order_json(o);
  end if;
  update public.pelham_gift_cards
     set status = 'void', voided_at = now(), void_reason = format('Refunded in Stripe · %s', o.invoice)
   where id = o.gift_card_id and status = 'active';
  update public.pelham_gift_card_orders
     set status = 'refunded', refund_trans_id = nullif(p_refund, ''), refunded_at = now(), updated_at = now()
   where id = o.id
  returning * into o;
  return public.pelham_gift_order_json(o);
end;
$$;

-- ===== 문자·메일 보낼 것 집기 ============================================

-- 보낼 것을 집는다(한 주문에 한 번). 막 승인된 것만.
create or replace function public.pelham_gift_order_deliveries_claim(p_limit integer default 20)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_out jsonb := '[]'::jsonb;
  o public.pelham_gift_card_orders;
  g public.pelham_gift_cards;
begin
  for o in
    update public.pelham_gift_card_orders
       set delivery_status = 'sending', updated_at = now()
     where id in (select x.id from public.pelham_gift_card_orders x
                   where x.status = 'approved' and x.delivery_status is null
                     and x.approved_at > now() - interval '30 minutes'
                   order by x.approved_at
                   limit greatest(coalesce(p_limit, 20), 1)
                   for update skip locked)
    returning *
  loop
    select * into g from public.pelham_gift_cards where id = o.gift_card_id;
    v_out := v_out || jsonb_build_object(
      'id', o.id, 'invoice', o.invoice, 'amount', o.amount, 'buyer_name', o.buyer_name,
      'buyer_email', o.buyer_email, 'buyer_phone', o.buyer_phone,
      'recipient_email', o.recipient_email, 'recipient_phone', o.recipient_phone,
      'card_brand', o.card_brand, 'card_last4', o.card_last4,
      'approved_at', public.pelham_iso(o.approved_at), 'card', public.pelham_gc_json(g));
  end loop;
  return v_out;
end;
$$;

create or replace function public.pelham_gift_order_delivery_result(p_id uuid, p_status text, p_error text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if p_status not in ('sent', 'partial', 'failed') then
    perform public.pelham_fail('422', 'Unknown delivery status.');
  end if;
  update public.pelham_gift_card_orders
     set delivery_status = p_status, delivery_error = left(p_error, 300), updated_at = now()
   where id = p_id and delivery_status = 'sending';
end;
$$;

-- ===== Stripe 대사 =====================================================

-- 대사 화면이 "Stripe 에만 있는 돈" 으로 잡지 않게 온라인 줄과 같은 꼴로 준다(`routes/reconcile.py`).
-- 직원 확인은 대사 경로가 먼저 한다.
create or replace function public.pelham_gift_order_records(p_from timestamptz, p_to timestamptz, p_ids text[])
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', o.id,
           'invoice', o.invoice,
           'kind', 'gift card',
           'status', o.status,
           'amount', o.amount,
           'trans_id', o.trans_id,
           'refund_kind', case when o.refund_trans_id is not null then 'refund' end,
           'refund_trans_id', o.refund_trans_id,
           'card_brand', o.card_brand,
           'card_last4', o.card_last4,
           'customer_name', o.buyer_name,
           'confirmation_code', g.code,
           'created_at', public.pelham_iso(o.created_at),
           'approved_at', public.pelham_iso(o.approved_at),
           'refunded_at', public.pelham_iso(o.refunded_at)
         ) order by o.created_at), '[]'::jsonb)
    from public.pelham_gift_card_orders o
    left join public.pelham_gift_cards g on g.id = o.gift_card_id
   where (o.created_at >= p_from and o.created_at < p_to and o.status in ('approved', 'orphaned', 'refunded'))
      or o.trans_id = any (p_ids) or o.invoice = any (p_ids)
$$;

-- ===== 권한 ============================================================

revoke all on function public.pelham_gift_order_json(public.pelham_gift_card_orders) from public, anon, authenticated;
revoke all on function public.pelham_gift_order_start(jsonb) from public, anon, authenticated;
revoke all on function public.pelham_gift_order_session(text, text) from public, anon, authenticated;
revoke all on function public.pelham_gift_order(jsonb) from public, anon, authenticated;
revoke all on function public.pelham_gift_order_complete(jsonb) from public, anon, authenticated;
revoke all on function public.pelham_gift_order_refund_finish(text, text) from public, anon, authenticated;
revoke all on function public.pelham_gift_order_deliveries_claim(integer) from public, anon, authenticated;
revoke all on function public.pelham_gift_order_delivery_result(uuid, text, text) from public, anon, authenticated;
revoke all on function public.pelham_gift_order_records(timestamptz, timestamptz, text[]) from public, anon, authenticated;

grant execute on function public.pelham_gift_order_start(jsonb) to service_role;
grant execute on function public.pelham_gift_order_session(text, text) to service_role;
grant execute on function public.pelham_gift_order(jsonb) to service_role;
grant execute on function public.pelham_gift_order_complete(jsonb) to service_role;
grant execute on function public.pelham_gift_order_refund_finish(text, text) to service_role;
grant execute on function public.pelham_gift_order_deliveries_claim(integer) to service_role;
grant execute on function public.pelham_gift_order_delivery_result(uuid, text, text) to service_role;
grant execute on function public.pelham_gift_order_records(timestamptz, timestamptz, text[]) to service_role;

notify pgrst, 'reload schema';

-- ===== 확인 ============================================================
-- 8줄이 나와야 한다.
select proname from pg_proc
 where proname like 'pelham_gift_order%' and proname <> 'pelham_gift_order_json'
 order by proname;
