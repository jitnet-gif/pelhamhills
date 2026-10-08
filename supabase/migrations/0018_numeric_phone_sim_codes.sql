-- 전화·문자로 잡은 실내 골프 예약의 확인 번호를 **숫자 10자리**로 바꾼다.
--
-- 왜(2026-10-08): 확정 문자의 확인 번호를 손님이 숫자 자판으로 바로 "C 0123456789" 를 쳐서
-- 취소할 수 있게, 그리고 그 번호를 확정 문자(MMS)에 바코드로 붙이기 위해서다
-- (`backend/services/barcode_png.py`). 티타임 번호도 같은 날 6자리 숫자로 바뀌었다
-- (`voice._confirmation_code`).
--
-- - 바뀌는 것은 `pelham_sim_phone_reserve`(0016)가 매기는 코드 한 줄뿐이다. 나머지 본문은
--   0016 과 같다.
-- - 웹 예약(`pelham_sim_reserve`, 0003)은 16진수 10자 그대로다. 손님은 이메일로 받는다.
-- - 이미 나간 16진수 코드는 그대로 둔다. `pelham_sim_phone_find` 는 코드 꼴을 따지지 않으므로
--   "C <옛 코드>" 취소도 계속 된다. 문자 쪽(`sms.SIM_CODE_RE`)도 둘 다 받는다.
-- - 숫자 10자리는 티타임 6자리와 길이로 갈린다.
--
-- 전제: 0016. 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다.

create or replace function public.pelham_sim_phone_reserve(p jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  local_now timestamp := public.pelham_local_now();
  v_date date;
  v_start integer;
  v_duration integer;
  v_players integer;
  v_name text := btrim(coalesce(p->>'customer_name', ''));
  v_phone text := btrim(coalesce(p->>'phone', ''));
  v_via text := coalesce(p->>'via', 'phone');
  v_bay public.pelham_sim_bays;
  v_code text;
  v_row public.pelham_sim_reservations;
  m text[];
begin
  if coalesce(p->>'date', '') !~ '^\d{4}-\d{2}-\d{2}$' then
    perform public.pelham_fail('422', 'A date is required, as YYYY-MM-DD.');
  end if;
  v_date := (p->>'date')::date;

  m := regexp_match(coalesce(p->>'start_time', ''), '^(\d{1,2}):(\d{2})$');
  if m is null or m[1]::integer > 23 or m[2]::integer > 59 then
    perform public.pelham_fail('422', 'The start time must be HH:MM.');
  end if;
  v_start := m[1]::integer * 60 + m[2]::integer;

  if coalesce(p->>'duration_hours', '') !~ '^\d+$' or (p->>'duration_hours')::integer not between 1 and 5 then
    perform public.pelham_fail('422', 'Simulator bookings are 1 to 5 hours.');
  end if;
  v_duration := (p->>'duration_hours')::integer;

  if coalesce(p->>'player_count', '') !~ '^\d+$' or (p->>'player_count')::integer not between 1 and 4 then
    perform public.pelham_fail('422', 'A bay takes 1 to 4 players.');
  end if;
  v_players := (p->>'player_count')::integer;

  if v_name = '' or length(v_name) > 120 then
    perform public.pelham_fail('422', 'The booking needs the guest''s name.');
  end if;
  if length(public.pelham_phone_key(v_phone)) <> 10 or length(v_phone) > 40 then
    perform public.pelham_fail('422', 'The booking needs a 10-digit phone number.');
  end if;
  if v_via not in ('phone', 'text') then
    perform public.pelham_fail('422', format('''%s'' is not a booking channel', v_via));
  end if;

  if extract(isodow from v_date) in (1, 2) then
    perform public.pelham_fail('422', 'The simulator is closed on Mondays and Tuesdays.');
  end if;
  if v_start % 15 <> 0 or v_start < 14 * 60 or v_start + v_duration * 60 > 22 * 60 then
    perform public.pelham_fail('422', 'Simulator bookings run 2:00 PM to 10:00 PM, starting on the quarter hour.');
  end if;
  if v_date < local_now::date
     or (v_date = local_now::date
         and v_start <= extract(hour from local_now) * 60 + extract(minute from local_now)) then
    perform public.pelham_fail('409', 'That time has already passed.');
  end if;

  perform pg_advisory_xact_lock(hashtext('pelham_sim:' || v_date::text));

  select b.* into v_bay
    from public.pelham_sim_bays b
   where b.is_active and b.status <> 'maintenance'
     and not public.pelham_sim_bay_busy(b.id, v_date, v_start, v_duration, null)
   order by b.bay_number
   limit 1;
  if v_bay.id is null then
    perform public.pelham_fail('409', 'Every bay is booked for that time.');
  end if;

  loop
    -- uuid 의 무작위 60비트를 10자리 숫자로. random() 보다 예측하기 어렵다.
    v_code := lpad((('x' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 15))::bit(60)::bigint % 10000000000)::text, 10, '0');
    exit when not exists (select 1 from public.pelham_sim_reservations r where r.confirmation_code = v_code);
  end loop;

  insert into public.pelham_sim_reservations
    (bay_id, booking_date, start_minutes, duration_hours, player_count,
     customer_name, customer_email, phone, notes, confirmation_code, total_price, source)
  values
    (v_bay.id, v_date, v_start, v_duration, v_players,
     v_name, '', v_phone,
     case when v_via = 'text' then 'Booked by text message with the booking assistant.'
          else 'Booked by phone with the voice assistant.' end,
     v_code, v_bay.hourly_rate * v_duration, 'voice_ai')
  returning * into v_row;

  return public.pelham_sim_phone_json(v_row);
end;
$$;

revoke all on function public.pelham_sim_phone_reserve(jsonb) from public, anon, authenticated;
grant execute on function public.pelham_sim_phone_reserve(jsonb) to service_role;
