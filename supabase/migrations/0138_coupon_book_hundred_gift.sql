-- 쿠폰북 라운드 100번 = 기념품 하나를 티 시트 계산서에 보인다(2026-10-29 클럽 요청 "쿠폰북 100회 라운드시 기념품 증정").
--
-- 셈은 GPS 0029: 라운드 = 도장(유료) + 쓴 무료 라운드, 100·200·300 ... 마다 기념품 하나.
-- 기념품은 물건이라 계산서 금액은 그대로다. 그린피 줄 아래에 "Souvenir due" 가 뜨고, 직원이 건네고
-- "Gave souvenir" 를 누르면 GPS 장부(coupon_entries)에 kind = 'gift' 한 줄이 그 예약·선수와 묶여 남는다.
-- 잘못 눌렀으면 같은 줄의 Undo 가 그 한 줄을 지운다.
--
-- 바꾸는 것:
--   - pelham_staff_bill_coupons(p_bill)            0137 의 것 + rounds, gift_due, rounds_to_gift, gift_given
--   - pelham_staff_bill_give_gift(p_bill, p_line)  기념품 줬다 → 바뀐 쿠폰 목록
--   - pelham_staff_bill_undo_gift(p_bill, p_line)  되돌리기 → 바뀐 쿠폰 목록
--
-- 전제: 0137 / GPS 0029.
-- 실행: GPS 0029 다음에 SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다.

do $$
begin
  if to_regprocedure('public.coupon_give_gift(uuid, text, text)') is null then
    raise exception '0138 needs golf-gps 0029_coupon_hundred_gift.sql first.';
  end if;
  if to_regprocedure('public.pelham_coupon_line_player(public.pelham_bill_lines)') is null then
    raise exception '0138 needs 0137 first.';
  end if;
end;
$$;

-- 살아 있는 그린피 줄마다(쿠폰북을 찾은 선수만):
--   {line_id, name, free_left, on_card, is_member, applied, amount, rounds, gift_due, rounds_to_gift, gift_given}
-- gift_given 이면 이 예약 자리로 기념품을 이미 줬다(Undo 를 보인다).
create or replace function public.pelham_staff_bill_coupons(p_bill bigint)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  l public.pelham_bill_lines;
  v_player jsonb;
  v_owner uuid;
  v_sum jsonb;
  v_out jsonb := '[]'::jsonb;
begin
  perform public.pelham_require_staff();
  for l in
    select * from public.pelham_bill_lines
     where bill_id = p_bill and kind = 'tee_player' and active
     order by id
  loop
    v_player := public.pelham_coupon_line_player(l);
    if v_player is null then
      continue;
    end if;
    v_owner := public.coupon_owner_for_player(v_player);
    if v_owner is null then
      continue;
    end if;
    v_sum := public.coupon_summary(v_owner);
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'line_id', l.id,
      'name', coalesce(nullif(btrim(v_player->>'name'), ''), 'Guest'),
      'free_left', (v_sum->>'free_left')::integer,
      'on_card', (v_sum->>'on_card')::integer,
      'is_member', coalesce((v_sum->>'is_member')::boolean, false),
      'applied', exists (select 1 from public.coupon_entries e where e.bill_line_id = l.id),
      'amount', l.discount,
      'rounds', coalesce((v_sum->>'rounds')::integer, 0),
      'gift_due', coalesce((v_sum->>'gift_due')::integer, 0),
      'rounds_to_gift', coalesce((v_sum->>'rounds_to_gift')::integer, 100),
      'gift_given', exists (select 1 from public.coupon_entries e
                             where e.kind = 'gift' and e.booking_id = l.booking_id and e.player_id = l.player_id)
    ));
  end loop;
  return v_out;
end;
$$;

create or replace function public.pelham_staff_bill_give_gift(p_bill bigint, p_line bigint)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  l public.pelham_bill_lines;
  v_owner uuid;
begin
  perform public.pelham_require_staff();
  select * into l from public.pelham_bill_lines
   where id = p_line and bill_id = p_bill and kind = 'tee_player' and active;
  if l.id is null then
    perform public.pelham_fail('404', 'That green fee is not on this bill.');
  end if;
  v_owner := public.coupon_owner_for_player(coalesce(public.pelham_coupon_line_player(l), '{}'::jsonb));
  if v_owner is null then
    perform public.pelham_fail('404', 'No coupon book for this player.');
  end if;
  begin
    perform public.coupon_give_gift(v_owner, l.booking_id, l.player_id);
  exception when sqlstate 'P0001' then
    perform public.pelham_fail('409', sqlerrm);
  end;
  return public.pelham_staff_bill_coupons(p_bill);
end;
$$;

create or replace function public.pelham_staff_bill_undo_gift(p_bill bigint, p_line bigint)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  l public.pelham_bill_lines;
begin
  perform public.pelham_require_staff();
  select * into l from public.pelham_bill_lines
   where id = p_line and bill_id = p_bill and kind = 'tee_player';
  if l.id is null then
    perform public.pelham_fail('404', 'That green fee is not on this bill.');
  end if;
  delete from public.coupon_entries x
   where x.id = (select e.id from public.coupon_entries e
                  where e.kind = 'gift' and e.booking_id = l.booking_id and e.player_id = l.player_id
                  order by e.created_at desc
                  limit 1);
  return public.pelham_staff_bill_coupons(p_bill);
end;
$$;

revoke all on function public.pelham_staff_bill_coupons(bigint) from public, anon, authenticated;
revoke all on function public.pelham_staff_bill_give_gift(bigint, bigint) from public, anon, authenticated;
revoke all on function public.pelham_staff_bill_undo_gift(bigint, bigint) from public, anon, authenticated;
grant execute on function public.pelham_staff_bill_coupons(bigint) to authenticated;
grant execute on function public.pelham_staff_bill_give_gift(bigint, bigint) to authenticated;
grant execute on function public.pelham_staff_bill_undo_gift(bigint, bigint) to authenticated;

notify pgrst, 'reload schema';

-- ===== 확인 ============================================================
-- 두 함수가 나와야 한다.
select proname from pg_proc
 where proname in ('pelham_staff_bill_give_gift', 'pelham_staff_bill_undo_gift')
 order by proname;
