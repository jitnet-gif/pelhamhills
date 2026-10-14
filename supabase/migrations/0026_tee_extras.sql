-- 티 시트 추가 품목(Extras) — 선수 카드의 `+` 로 풀카트·레인지 바스켓 같은 것을 그 사람 몫에 붙인다.
--
-- 왜(2026-10-14): 레퍼런스 화면은 그린피 줄 아래 `+` 를 누르면 Cart / Extra 로 묶인 목록이 뜬다.
-- 여기까지는 그린피와 하프 카트만 있었다. 풀카트·레인지 바스켓은 프로 샵 계산서에 따로 담아야 했고,
-- 선수 카드의 Subtotal Due·영수증·결제와 따로 놀았다.
--
-- 모양: 선수 doc 에 `extras: [{code, name, price}]` 가 붙는다. price 는 세전 달러(`rate`·`cartFee` 와 같다).
-- 붙이는 순간의 카탈로그 값을 복사해 둔다 — 나중에 카탈로그 값을 바꿔도 이미 붙은 줄은 그대로다.
-- 하프 카트는 예전처럼 `cart`·`cartFee` 다(화면의 `+` 목록에 Cart 로 같이 보일 뿐이다).
--
-- 한 사람 몫 = rate + (cart 면 cartFee) + extras 의 합. `pelham_pos_tee_price` 하나를 고치면
-- 계산서·온라인 결제·레인체크가 같이 따라간다. 일일 리포트는 감싸서 더한다.
--
-- 카탈로그 값 바꾸기(화면이 없다):
--   update public.pelham_tee_extras set price = 6.00 where code = 'pull_cart_9';
--   update public.pelham_tee_extras set active = false where code = 'driving_range';
--   insert into public.pelham_tee_extras (code, name, category, price, sort) values ('towel', 'Towel', 'extra', 5, 60);
--
-- 구현: `pelham_tee_player`·`pelham_tee_daily_report` 는 0024 와 같이 `<이름>_base` 로 옮기고 얇게 감싼다.
-- **0004 를 다시 실행하면 감싼 것이 풀린다** — 그 뒤엔 이 파일을 다시 실행하면 된다(다시 실행해도 안전하다).
-- 전제: 0004, 0005. 실행: SQL editor 에 이 파일 전체를 붙여 한 번.

do $$
begin
  if to_regprocedure('public.pelham_tee_player(jsonb, integer, text, text)') is null then
    raise exception '0026 needs 0004 first (pelham_tee_player is missing).';
  end if;
  if to_regprocedure('public.pelham_pos_tee_price(jsonb, jsonb)') is null then
    raise exception '0026 needs 0005 first (pelham_pos_tee_price is missing).';
  end if;
end;
$$;

-- ===== 카탈로그 ========================================================

create table if not exists public.pelham_tee_extras (
  code        text primary key check (code ~ '^[a-z0-9_]+$'),
  name        text not null check (btrim(name) <> ''),
  category    text not null default 'extra' check (category in ('extra')),
  price       numeric(10, 2) not null check (price >= 0),
  sort        integer not null default 0,
  active      boolean not null default true,
  updated_at  timestamptz not null default now()
);

alter table public.pelham_tee_extras enable row level security;
revoke all on public.pelham_tee_extras from anon, authenticated;

-- 처음 값. 이미 있으면 건드리지 않는다(값을 바꾼 뒤 이 파일을 다시 돌려도 덮지 않게).
insert into public.pelham_tee_extras (code, name, price, sort) values
  ('pull_cart_18',  'Pull Cart (18 Holes)',          8.00, 10),
  ('small_basket',  'Small Range Basket',            8.00, 20),
  ('pull_cart_9',   'Pull Cart (9 Holes)',           5.00, 30),
  ('large_basket',  'Large Range Basket',           12.00, 40),
  ('driving_range', 'Driving Range / NonMembers',   15.00, 50)
on conflict (code) do nothing;

-- ===== 헬퍼 ============================================================

-- 선수 doc 의 extras 합(세전 달러).
create or replace function public.pelham_tee_extras_total(p_player jsonb)
returns numeric
language sql
immutable
set search_path = ''
as $$
  select coalesce(sum(coalesce((e.value->>'price')::numeric, 0)), 0)
    from jsonb_array_elements(
           case when jsonb_typeof(p_player->'extras') = 'array' then p_player->'extras' else '[]'::jsonb end
         ) as e(value)
$$;

-- 한 사람 몫(센트) — 0005 의 규칙에 extras 를 더한다.
create or replace function public.pelham_pos_tee_price(p_doc jsonb, p_player jsonb)
returns integer
language sql
immutable
set search_path = ''
as $$
  select round((coalesce((p_doc->>'rate')::numeric, 0)
                + case when coalesce((p_player->>'cart')::boolean, false)
                       then coalesce((p_player->>'cartFee')::numeric, 0) else 0 end
                + public.pelham_tee_extras_total(p_player)) * 100)::integer
$$;

-- 계산서 줄 이름: "Green fee + cart + Pull Cart (18 Holes) — Kestrel, Blake (7:43 AM)".
create or replace function public.pelham_pos_tee_line_name(p_doc jsonb, p_player jsonb)
returns text
language sql
immutable
set search_path = ''
as $$
  select format('%s%s — %s (%s)',
                case when coalesce((p_player->>'cart')::boolean, false)
                     then 'Green fee + cart' else 'Green fee' end,
                coalesce((select string_agg(' + ' || (e.value->>'name'), '' order by e.ordinality)
                            from jsonb_array_elements(
                                   case when jsonb_typeof(p_player->'extras') = 'array'
                                        then p_player->'extras' else '[]'::jsonb end
                                 ) with ordinality as e(value, ordinality)), ''),
                coalesce(nullif(btrim(p_player->>'name'), ''), 'Guest'),
                coalesce(p_doc->>'time', ''))
$$;

-- ===== 감싸기 ==========================================================
-- 0024 와 같은 방식: 지금 이름의 본문이 감싼 것이 아니면(0004 를 다시 돌림) 옛 _base 를 버리고 다시 옮긴다.

do $$
declare
  v_sig record;
  v_src text;
begin
  for v_sig in
    select * from (values
      ('pelham_tee_player', 'jsonb, integer, text, text'),
      ('pelham_tee_daily_report', 'date')
    ) as t(fn, args)
  loop
    select p.prosrc into v_src from pg_proc p
     where p.oid = to_regprocedure(format('public.%s(%s)', v_sig.fn, v_sig.args));
    if v_src like '%_base(%' then
      continue;
    end if;
    if to_regprocedure(format('public.%s_base(%s)', v_sig.fn, v_sig.args)) is not null then
      execute format('drop function public.%s_base(%s)', v_sig.fn, v_sig.args);
    end if;
    execute format('alter function public.%s(%s) rename to %s_base', v_sig.fn, v_sig.args, v_sig.fn);
  end loop;
end;
$$;

-- 선수 하나를 다시 만들 때 extras 를 잃지 않는다. 0004 의 본문은 아는 키만 남기므로 그대로 두면
-- 이름 한 글자만 고쳐도 extras 가 사라진다.
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
  return v_player;
end;
$$;

-- 일일 리포트에 extras 를 더한다. 0004 의 본문과 같은 규칙: 취소된 예약·취소된 선수는 빼고,
-- 결제된 선수의 몫은 collected 에도 들어간다.
create or replace function public.pelham_tee_daily_report(p_date date)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_report jsonb := public.pelham_tee_daily_report_base(p_date);
  v_total numeric;
  v_collected numeric;
begin
  select coalesce(sum(public.pelham_tee_extras_total(pl.value)), 0),
         coalesce(sum(public.pelham_tee_extras_total(pl.value))
                    filter (where coalesce((pl.value->>'paid')::boolean, false)), 0)
    into v_total, v_collected
    from public.pelham_tee_bookings t
    cross join lateral jsonb_array_elements(coalesce(t.doc->'players', '[]'::jsonb)) as pl(value)
   where t.booking_date = p_date
     and coalesce(t.doc->>'status', '') <> 'cancelled'
     and not coalesce((pl.value->>'cancelled')::boolean, false);
  if v_total = 0 then
    return v_report;
  end if;
  return v_report || jsonb_build_object(
    'total_revenue', round((v_report->>'total_revenue')::numeric + v_total, 2),
    'collected_revenue', round((v_report->>'collected_revenue')::numeric + v_collected, 2),
    'outstanding_revenue', round((v_report->>'outstanding_revenue')::numeric + v_total - v_collected, 2));
end;
$$;

-- ===== 직원 함수 ======================================================

-- 카탈로그(켜진 것만, 정렬 순서대로).
create or replace function public.pelham_staff_tee_extras()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.pelham_require_staff();
  return coalesce((
    select jsonb_agg(jsonb_build_object('code', x.code, 'name', x.name, 'category', x.category, 'price', x.price)
                     order by x.sort, x.name)
      from public.pelham_tee_extras x
     where x.active), '[]'::jsonb);
end;
$$;

-- 선수의 extras 를 통째로 바꾼다(p_codes 순서 그대로, 같은 품목을 두 번 넣을 수 있다).
-- 이미 붙어 있던 품목은 붙일 때의 값을 지키고, 새로 붙는 것만 지금 카탈로그 값을 쓴다.
-- 결제·취소된 선수는 바꿀 수 없다 — 받은 돈과 영수증이 달라지면 안 된다.
create or replace function public.pelham_staff_player_extras(p_id text, p_player text, p_codes text[])
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_now text := public.pelham_iso(now());
  v_doc jsonb;
  v_players jsonb := '[]'::jsonb;
  v_old jsonb;
  v_old_extras jsonb;
  v_new_extras jsonb := '[]'::jsonb;
  v_code text;
  v_item jsonb;
  v_pos integer;
  v_used integer[] := '{}';
  v_added text[] := '{}';
  v_removed text[] := '{}';
  pl jsonb;
  v_msg text;
begin
  perform public.pelham_require_staff();
  if array_length(p_codes, 1) > 12 then
    perform public.pelham_fail('422', 'Too many extras for one player.');
  end if;

  -- 0004 의 player_patch 와 같은 잠금: 티 타임 잠금을 잡고 doc 을 다시 읽는다.
  select t.doc into v_doc from public.pelham_tee_bookings t where t.id = p_id;
  if v_doc is null then
    perform public.pelham_fail('404', 'Booking not found');
  end if;
  perform public.pelham_tee_lock((v_doc->>'date')::date, v_doc->>'time');
  select t.doc into v_doc from public.pelham_tee_bookings t where t.id = p_id;
  if v_doc is null then
    perform public.pelham_fail('404', 'Booking not found');
  end if;

  select e.value into v_old
    from jsonb_array_elements(coalesce(v_doc->'players', '[]'::jsonb)) as e(value)
   where e.value->>'id' = p_player;
  if v_old is null then
    perform public.pelham_fail('404', 'Player not found');
  end if;
  if coalesce((v_old->>'paid')::boolean, false) then
    perform public.pelham_fail('409', 'Paid — mark unpaid to change the extras.');
  end if;
  if coalesce((v_old->>'cancelled')::boolean, false) then
    perform public.pelham_fail('409', 'This player is cancelled.');
  end if;
  v_old_extras := case when jsonb_typeof(v_old->'extras') = 'array' then v_old->'extras' else '[]'::jsonb end;

  foreach v_code in array coalesce(p_codes, '{}') loop
    -- 아직 짝을 안 지은 같은 코드의 옛 줄이 있으면 그 줄(값)을 그대로 쓴다.
    select e.ordinality::integer into v_pos
      from jsonb_array_elements(v_old_extras) with ordinality as e(value, ordinality)
     where e.value->>'code' = v_code and not (e.ordinality::integer = any (v_used))
     order by e.ordinality
     limit 1;
    if v_pos is not null then
      v_used := v_used || v_pos;
      v_new_extras := v_new_extras || jsonb_build_array(v_old_extras->(v_pos - 1));
      continue;
    end if;
    select jsonb_build_object('code', x.code, 'name', x.name, 'price', x.price) into v_item
      from public.pelham_tee_extras x where x.code = v_code and x.active;
    if v_item is null then
      perform public.pelham_fail('422', format('''%s'' is not an extra.', v_code));
    end if;
    v_new_extras := v_new_extras || jsonb_build_array(v_item);
    v_added := v_added || (v_item->>'name');
  end loop;

  select coalesce(array_agg(e.value->>'name' order by e.ordinality), '{}') into v_removed
    from jsonb_array_elements(v_old_extras) with ordinality as e(value, ordinality)
   where not (e.ordinality::integer = any (v_used));

  if cardinality(v_added) = 0 and cardinality(v_removed) = 0 then
    return v_doc;
  end if;

  for pl in select value from jsonb_array_elements(coalesce(v_doc->'players', '[]'::jsonb)) loop
    if pl->>'id' = p_player then
      pl := case when jsonb_array_length(v_new_extras) = 0 then pl - 'extras'
                 else pl || jsonb_build_object('extras', v_new_extras) end;
    end if;
    v_players := v_players || pl;
  end loop;
  v_doc := jsonb_set(v_doc, '{players}', v_players);

  v_msg := concat_ws(' ',
    case when cardinality(v_added) > 0
         then format('Added %s for %s.', array_to_string(v_added, ', '), v_old->>'name') end,
    case when cardinality(v_removed) > 0
         then format('Removed %s for %s.', array_to_string(v_removed, ', '), v_old->>'name') end);
  v_doc := public.pelham_tee_audit(v_doc, v_msg, v_now);

  perform public.pelham_tee_save(v_doc);
  return v_doc;
end;
$$;

-- ===== 권한 ============================================================

revoke all on function public.pelham_tee_extras_total(jsonb) from public, anon, authenticated;
revoke all on function public.pelham_pos_tee_price(jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.pelham_pos_tee_line_name(jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.pelham_tee_player(jsonb, integer, text, text) from public, anon, authenticated;
revoke all on function public.pelham_tee_player_base(jsonb, integer, text, text) from public, anon, authenticated;
revoke all on function public.pelham_tee_daily_report(date) from public, anon, authenticated;
revoke all on function public.pelham_tee_daily_report_base(date) from public, anon, authenticated;
revoke all on function public.pelham_staff_tee_extras() from public, anon, authenticated;
revoke all on function public.pelham_staff_player_extras(text, text, text[]) from public, anon, authenticated;

grant execute on function public.pelham_staff_tee_extras() to authenticated;
grant execute on function public.pelham_staff_player_extras(text, text, text[]) to authenticated;
