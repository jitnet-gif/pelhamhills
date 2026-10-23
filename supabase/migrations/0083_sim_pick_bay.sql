-- 온라인 시뮬레이터 예약에서 손님이 Bay 1·2·3 중 하나를 고른다.
--
-- 왜(2026-10-23): 클럽이 예약 2단계(Options)에서 베이 번호를 보여 주고 고르게 해 달라고 했다.
-- 지금까지는 서버가 빈 베이 중 번호가 가장 작은 것을 골랐다.
--
-- 바뀌는 것 (0007 의 손님 함수 두 개를 다시 정의한다. 나머지는 0007 과 같다)
--   - pelham_sim_availability: 각 시간 슬롯에 'free_bays'(그 시간에 빈 베이 번호 배열),
--     응답에 'bays'(예약을 받는 베이 번호 전체)를 더한다.
--   - pelham_sim_reserve: p.bay_number 가 오면 그 베이만 잡는다. 그 베이가 그 사이 찼으면 409.
--     안 오면 예전처럼 빈 베이 중 번호가 작은 것(옛 화면·캐시된 페이지가 깨지지 않는다).
--
-- 전제: 0003, 0007, 0009. 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다.
-- 권한은 create or replace 라 0003 의 것이 그대로 남는다.

create or replace function public.pelham_sim_availability(
  p_date date,
  p_bay_type text default 'right_handed',
  p_duration_hours integer default 1
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  open_min constant integer := 14 * 60;
  close_min constant integer := 22 * 60;
  span integer;
  local_now timestamp := public.pelham_local_now();
  label text;
  total integer;
  free_bays integer;
  free_numbers jsonb;
  slots jsonb := '[]'::jsonb;
  base jsonb;
  start_min integer;
begin
  if p_date is null then
    perform public.pelham_fail('400', 'Invalid date format. Use YYYY-MM-DD');
  end if;
  if p_duration_hours is null or p_duration_hours not between 1 and 5 then
    perform public.pelham_fail('400', 'Duration must be between 1 and 5 hours.');
  end if;
  span := p_duration_hours * 60;
  label := initcap(replace(coalesce(p_bay_type, ''), '_', ' '));

  base := jsonb_build_object(
    'date', to_char(p_date, 'YYYY-MM-DD'),
    'bay_type', p_bay_type,
    'duration_hours', p_duration_hours,
    'is_closed', false,
    'available_slots', '[]'::jsonb,
    'reason', null,
    'bays', coalesce((select jsonb_agg(b.bay_number order by b.bay_number)
                        from public.pelham_sim_bays b
                       where b.is_active and b.status <> 'maintenance' and b.bay_type = p_bay_type), '[]'::jsonb)
  );

  if extract(isodow from p_date) in (1, 2) then
    return base || jsonb_build_object(
      'is_closed', true,
      'reason', 'The simulator is closed on Mondays and Tuesdays.'
    );
  end if;

  select count(*) into total
    from public.pelham_sim_bays b
   where b.is_active and b.status <> 'maintenance' and b.bay_type = p_bay_type;
  if total = 0 then
    if exists (select 1 from public.pelham_sim_bays b where b.is_active and b.bay_type = p_bay_type) then
      return base || jsonb_build_object('reason', format('%s bays are closed for maintenance.', label));
    end if;
    return base || jsonb_build_object('reason', format('No bays are configured for %s.', label));
  end if;

  start_min := open_min;
  while start_min + span <= close_min loop
    -- 오늘의 지난 시각은 팔지 않는다.
    if p_date > local_now::date
       or (p_date = local_now::date
           and start_min > extract(hour from local_now) * 60 + extract(minute from local_now)) then
      select count(*), coalesce(jsonb_agg(b.bay_number order by b.bay_number), '[]'::jsonb)
        into free_bays, free_numbers
        from public.pelham_sim_bays b
       where b.is_active and b.status <> 'maintenance' and b.bay_type = p_bay_type
         and not exists (
           select 1 from public.pelham_sim_reservations r
            where r.bay_id = b.id
              and r.booking_date = p_date
              and r.status not in ('cancelled', 'no_show')
              and r.start_minutes < start_min + span
              and r.start_minutes + r.duration_hours * 60 > start_min
         );
      if free_bays > 0 then
        slots := slots || jsonb_build_object(
          'time', lpad((start_min / 60)::text, 2, '0') || ':' || lpad((start_min % 60)::text, 2, '0'),
          'available_bays', free_bays,
          'total_bays', total,
          'free_bays', free_numbers
        );
      end if;
    end if;
    start_min := start_min + 15;
  end loop;

  if jsonb_array_length(slots) = 0 then
    return base || jsonb_build_object(
      'reason',
      case when p_date < local_now::date
           then 'That date has already passed.'
           else format('Every %s bay is booked for %s hour%s on this date.',
                       label, p_duration_hours, case when p_duration_hours > 1 then 's' else '' end)
      end
    );
  end if;
  return base || jsonb_build_object('available_slots', slots);
end;
$$;

create or replace function public.pelham_sim_reserve(p jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  open_min constant integer := 14 * 60;
  close_min constant integer := 22 * 60;
  local_now timestamp := public.pelham_local_now();
  v_date date;
  v_type text := p->>'bay_type';
  v_duration integer;
  v_players integer;
  v_name text := btrim(coalesce(p->>'customer_name', ''));
  v_email text := btrim(coalesce(p->>'customer_email', ''));
  v_phone text := btrim(coalesce(p->>'phone', ''));
  v_notes text := btrim(coalesce(p->>'notes', ''));
  v_start integer;
  v_bay public.pelham_sim_bays;
  v_bay_number integer;
  v_code text;
  v_row public.pelham_sim_reservations;
  m text[];
begin
  begin
    v_date := (p->>'date')::date;
  exception when others then
    v_date := null;
  end;
  if v_date is null or coalesce(p->>'date', '') !~ '^\d{4}-\d{2}-\d{2}$' then
    perform public.pelham_fail('400', 'Invalid date format. Use YYYY-MM-DD');
  end if;
  if extract(isodow from v_date) in (1, 2) then
    perform public.pelham_fail('400', 'The simulator is closed on Mondays and Tuesdays.');
  end if;
  if v_type is null or v_type not in ('right_handed', 'left_right', 'vip') then
    perform public.pelham_fail('400', format('Unknown bay type: %s', coalesce(v_type, '')));
  end if;
  if coalesce(p->>'duration_hours', '') !~ '^\d+$' or (p->>'duration_hours')::integer not between 1 and 5 then
    perform public.pelham_fail('400', 'Duration must be between 1 and 5 hours.');
  end if;
  v_duration := (p->>'duration_hours')::integer;
  v_players := coalesce(nullif(p->>'player_count', ''), '1')::integer;
  if v_players not between 1 and 4 then
    perform public.pelham_fail('400', 'Player count must be between 1 and 4.');
  end if;
  if v_name = '' then
    perform public.pelham_fail('400', 'Name is required');
  end if;
  if v_email = '' then
    perform public.pelham_fail('400', 'Email is required');
  end if;
  if length(v_name) > 120 or length(v_email) > 254 or length(v_phone) > 40 or length(v_notes) > 1000
     or position('@' in v_email) = 0 then
    perform public.pelham_fail('400', 'Please check your name, email, phone and notes.');
  end if;

  m := regexp_match(coalesce(p->>'start_time', ''), '^(\d{1,2}):(\d{2})$');
  if m is null or m[1]::integer > 23 or m[2]::integer > 59 then
    perform public.pelham_fail('400', 'Invalid time format. Use HH:MM');
  end if;
  v_start := m[1]::integer * 60 + m[2]::integer;
  if v_start < open_min or v_start + v_duration * 60 > close_min then
    perform public.pelham_fail('400', 'Requested time is outside operating hours (2:00 PM - 10:00 PM).');
  end if;
  if v_date < local_now::date
     or (v_date = local_now::date
         and v_start <= extract(hour from local_now) * 60 + extract(minute from local_now)) then
    perform public.pelham_fail('400', 'That time has already passed. Please pick a later time.');
  end if;

  -- 손님이 고른 베이(없으면 서버가 빈 베이 중 번호가 작은 것).
  if coalesce(p->>'bay_number', '') <> '' then
    if p->>'bay_number' !~ '^\d{1,3}$' then
      perform public.pelham_fail('400', 'Pick a bay.');
    end if;
    v_bay_number := (p->>'bay_number')::integer;
  end if;

  -- 그날의 빈 베이 확인과 기록을 한 잠금 안에서.
  perform pg_advisory_xact_lock(hashtext('pelham_sim:' || v_date::text));

  select b.* into v_bay
    from public.pelham_sim_bays b
   where b.is_active and b.status <> 'maintenance' and b.bay_type = v_type
     and (v_bay_number is null or b.bay_number = v_bay_number)
     and not exists (
       select 1 from public.pelham_sim_reservations r
        where r.bay_id = b.id
          and r.booking_date = v_date
          and r.status not in ('cancelled', 'no_show')
          and r.start_minutes < v_start + v_duration * 60
          and r.start_minutes + r.duration_hours * 60 > v_start
     )
   order by b.bay_number
   limit 1;

  if v_bay.id is null then
    if not exists (select 1 from public.pelham_sim_bays b where b.is_active and b.bay_type = v_type) then
      perform public.pelham_fail('404', format('No bays are configured for %s.', initcap(replace(v_type, '_', ' '))));
    end if;
    if not exists (select 1 from public.pelham_sim_bays b
                    where b.is_active and b.status <> 'maintenance' and b.bay_type = v_type) then
      perform public.pelham_fail('409', format('%s bays are closed for maintenance.', initcap(replace(v_type, '_', ' '))));
    end if;
    if v_bay_number is not null then
      if not exists (select 1 from public.pelham_sim_bays b
                      where b.is_active and b.status <> 'maintenance' and b.bay_type = v_type
                        and b.bay_number = v_bay_number) then
        perform public.pelham_fail('409', format('Bay %s is not taking bookings right now. Please pick another bay.', v_bay_number));
      end if;
      perform public.pelham_fail('409', format('Bay %s was just booked for part of that time. Please pick another bay or time.', v_bay_number));
    end if;
    perform public.pelham_fail('409', 'Time slot already booked');
  end if;

  loop
    v_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));
    exit when not exists (select 1 from public.pelham_sim_reservations r where r.confirmation_code = v_code);
  end loop;

  insert into public.pelham_sim_reservations
    (bay_id, booking_date, start_minutes, duration_hours, player_count,
     customer_name, customer_email, phone, notes, confirmation_code, total_price)
  values
    (v_bay.id, v_date, v_start, v_duration, v_players,
     v_name, v_email, v_phone, v_notes, v_code, v_bay.hourly_rate * v_duration)
  returning * into v_row;

  return jsonb_build_object(
    'id', v_row.id,
    'confirmation_code', v_row.confirmation_code,
    'bay_type', initcap(replace(v_bay.bay_type, '_', ' ')),
    'bay_number', v_bay.bay_number,
    'date', to_char(v_row.booking_date, 'YYYY-MM-DD'),
    'start_time', lpad((v_start / 60)::text, 2, '0') || ':' || lpad((v_start % 60)::text, 2, '0'),
    'duration_hours', v_row.duration_hours,
    'player_count', v_row.player_count,
    'total_price', v_row.total_price
  );
end;
$$;

notify pgrst, 'reload schema';
