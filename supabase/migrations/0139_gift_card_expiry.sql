-- 기프트카드 만료일을 손으로 넣는다(2026-10-30 클럽 요청: "gift card expired date Dec 31, 2027 메뉴얼로 넣는 곳",
-- "기존 발행된것도 반영").
--
-- 바꾸는 것:
--   - pelham_gift_cards.expires_on                  비면 No expiry
--   - pelham_gc_json                                expires_on, expired 를 더 돌려준다
--   - pelham_gc_on_payment                          만료된 무료 카드를 거절
--   - pelham_staff_gift_card_issue                  p.expires_on 을 받는다
--   - pelham_staff_gift_card_set_expiry(code, date) 발행한 카드의 날짜를 고친다(null = No expiry)
--   - 맨 아래: 이미 발행한 카드에 2027-12-31 일괄 적용
--
-- 날짜를 넘긴 카드를 거절하는 것은 kind = 'complimentary' 뿐이다. 온타리오 O. Reg. 17/05 s.25.3 은 돈을 받고 판
-- 카드의 만료일을 금지하고, 적혀 있어도 없는 것으로 본다. 그래서 sold 카드는 날짜가 지나도 결제가 된다.
-- 만료일 당일까지 쓸 수 있다.
--
-- 전제: 0120. 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 프론트·Fly 배포보다 먼저 —
-- 옛 발행 함수는 expires_on 을 말없이 버린다.
-- 맨 아래 일괄 적용 때문에, 다시 실행하면 No expiry 로 비워 둔 카드에도 날짜가 다시 들어간다.

do $$
begin
  if to_regprocedure('public.pelham_staff_gift_card_issue(jsonb)') is null then
    raise exception '0139 needs 0120 first.';
  end if;
end;
$$;

alter table public.pelham_gift_cards add column if not exists expires_on date;

create or replace function public.pelham_gc_json(g public.pelham_gift_cards)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', g.id,
    'code', g.code,
    'amount', g.amount,
    'used', u.used,
    'balance', g.amount - u.used,
    'kind', g.kind,
    'status', g.status,
    'recipient', g.recipient,
    'phone', g.phone,
    'email', g.email,
    'note', g.note,
    'issued_email', g.issued_email,
    'issued_on', to_char(g.issued_on, 'YYYY-MM-DD'),
    'issued_at', public.pelham_iso(g.issued_at),
    'expires_on', to_char(g.expires_on, 'YYYY-MM-DD'),
    -- 결제가 막히는가. sold 카드는 날짜가 지나도 false 다(맨 위 설명).
    'expired', coalesce(g.kind = 'complimentary' and g.expires_on < public.pelham_pos_today(), false),
    'void_reason', g.void_reason,
    'voided_at', public.pelham_iso(g.voided_at),
    'uses', coalesce((
      select jsonb_agg(jsonb_build_object(
               'receipt_no', b.receipt_no,
               'amount', p.amount,
               'status', b.status,
               'paid_at', public.pelham_iso(b.paid_at)
             ) order by p.id)
        from public.pelham_bill_payments p
        join public.pelham_bills b on b.id = p.bill_id
       where p.gift_card_id = g.id and b.status in ('paid', 'refunded')
    ), '[]'::jsonb)
  )
  from (select public.pelham_gc_used(g.id) as used) u
$$;

create or replace function public.pelham_gc_on_payment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_code text;
  g public.pelham_gift_cards;
  v_balance integer;
begin
  if new.method <> 'gift_card' then
    return new;
  end if;
  v_code := upper(btrim(coalesce(new.auth_code, '')));
  if v_code = '' then
    perform public.pelham_fail('422', 'A gift card payment needs the card number. Scan the gift card.');
  end if;
  select * into g from public.pelham_gift_cards where code = v_code for update;
  if g.id is null then
    perform public.pelham_fail('404', format('No gift card %s', v_code));
  end if;
  if g.status <> 'active' then
    perform public.pelham_fail('409', format('Gift card %s was voided.', v_code));
  end if;
  if g.kind = 'complimentary' and g.expires_on < public.pelham_pos_today() then
    perform public.pelham_fail('409', format('Gift card %s expired on %s.', v_code, to_char(g.expires_on, 'Mon FMDD, YYYY')));
  end if;
  if coalesce(new.tip, 0) > 0 then
    perform public.pelham_fail('422', 'Tips cannot be paid with a gift card.');
  end if;
  v_balance := g.amount - public.pelham_gc_used(g.id, new.bill_id);
  if new.amount > v_balance then
    perform public.pelham_fail('422', format('Gift card %s has %s left, not %s.', v_code,
                                             '$' || to_char(v_balance / 100.0, 'FM999,990.00'),
                                             '$' || to_char(new.amount / 100.0, 'FM999,990.00')));
  end if;
  new.gift_card_id := g.id;
  new.auth_code := v_code;
  new.entry := 'none';
  new.terminal := null;
  new.card_last4 := null;
  return new;
end;
$$;

-- p: {amount (센트), kind, recipient?, phone?, email?, note?, expires_on? ('YYYY-MM-DD')}
create or replace function public.pelham_staff_gift_card_issue(p jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_amount integer;
  v_kind text := coalesce(p->>'kind', '');
  v_expires date;
  v_code text;
  v_email text;
  g public.pelham_gift_cards;
begin
  perform public.pelham_require_gift_card_manager();
  p := coalesce(p, '{}'::jsonb);
  begin
    v_amount := (p->>'amount')::integer;
  exception when others then
    perform public.pelham_fail('422', 'amount must be whole cents.');
  end;
  if v_amount is null or v_amount <= 0 then
    perform public.pelham_fail('422', 'Enter an amount above $0.00.');
  end if;
  if v_amount > 500000 then
    perform public.pelham_fail('422', 'A gift card cannot be more than $5,000.00.');
  end if;
  if v_kind not in ('sold', 'complimentary') then
    perform public.pelham_fail('422', 'Choose Sold or Complimentary.');
  end if;
  if length(btrim(coalesce(p->>'note', ''))) = 0 then
    perform public.pelham_fail('422', 'Write why the card is issued (who paid and how, or what it is for).');
  end if;
  begin
    v_expires := nullif(btrim(coalesce(p->>'expires_on', '')), '')::date;
  exception when others then
    perform public.pelham_fail('422', 'Enter the expiry as a date.');
  end;
  if v_expires < public.pelham_pos_today() then
    perform public.pelham_fail('422', 'The expiry date has already passed.');
  end if;

  -- 코드: 무작위 10자(16진). 겹치면 다시 뽑는다.
  loop
    v_code := 'GIFT-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));
    exit when not exists (select 1 from public.pelham_gift_cards where code = v_code);
  end loop;
  select lower(u.email) into v_email from auth.users u where u.id = auth.uid();

  insert into public.pelham_gift_cards
    (code, amount, kind, recipient, phone, email, note, issued_by, issued_email, issued_on, expires_on)
  values
    (v_code, v_amount, v_kind,
     nullif(btrim(coalesce(p->>'recipient', '')), ''),
     nullif(btrim(coalesce(p->>'phone', '')), ''),
     nullif(lower(btrim(coalesce(p->>'email', ''))), ''),
     btrim(p->>'note'), auth.uid(), v_email, public.pelham_pos_today(), v_expires)
  returning * into g;
  return public.pelham_gc_json(g);
end;
$$;

-- 발행한 카드의 만료일. null 이면 No expiry.
create or replace function public.pelham_staff_gift_card_set_expiry(p_code text, p_expires date)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  g public.pelham_gift_cards;
begin
  perform public.pelham_require_gift_card_manager();
  select * into g from public.pelham_gift_cards where code = upper(btrim(coalesce(p_code, ''))) for update;
  if g.id is null then
    perform public.pelham_fail('404', format('No gift card %s', coalesce(p_code, '')));
  end if;
  if g.status <> 'active' then
    perform public.pelham_fail('409', format('Gift card %s was voided.', g.code));
  end if;
  if p_expires < public.pelham_pos_today() then
    perform public.pelham_fail('422', 'The expiry date has already passed.');
  end if;
  update public.pelham_gift_cards set expires_on = p_expires where id = g.id returning * into g;
  return public.pelham_gc_json(g);
end;
$$;

revoke all on function public.pelham_staff_gift_card_set_expiry(text, date) from public, anon, authenticated;
grant execute on function public.pelham_staff_gift_card_set_expiry(text, date) to authenticated;

-- ===== 이미 발행한 카드 ================================================
update public.pelham_gift_cards
   set expires_on = date '2027-12-31'
 where status = 'active' and expires_on is null;

notify pgrst, 'reload schema';

-- ===== 확인 ============================================================
-- active 카드의 expires_on 이 전부 2027-12-31 이어야 한다.
select kind, status, expires_on, count(*)
  from public.pelham_gift_cards
 group by kind, status, expires_on
 order by kind, status;
