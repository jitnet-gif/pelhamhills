-- 실내 시뮬레이터 웹 예약 확정 메일(2026-10-30 클럽 요청: "실내 시뮬레이터 확정 이메일도 반영").
--
-- 왜: 확정 메일 코드는 옛 FastAPI 예약 경로에만 있었다. 웹 예약이 브라우저 → `pelham_sim_reserve` 로 옮겨 간 뒤로는
-- 서버를 거치지 않아 한 통도 나가지 않았다. 확인 문자(0032)와 같은 꼴로 서버가 1분마다 집어 보낸다.
--
-- 누가 보내나: FastAPI 의 `backend/services/booking_emails.py`. 이 파일은 "보낼 것 집기" 와 "결과 적기" 만 한다.
--
-- 왜 0032 표를 안 쓰나: pelham_booking_texts 는 번호가 없으면 no_phone 으로 닫히고 Twilio 키에 묶여 있다.
-- 이메일은 번호와 상관없이 가야 한다.
--
-- 규칙:
--   - source = 'online' 만. 전화·문자 비서 예약과 직원이 넣은 예약은 대상이 아니다.
--   - 한 예약에 한 통. reservation_id 가 유일하고 보내기 전에 줄을 먼저 만든다. 실패해도 다시 집지 않는다.
--   - 막 만든 것만: 30분 안에 만든 예약. 이 파일을 처음 돌려도 지난 예약에 메일이 쏟아지지 않는다.
--   - 취소된 예약은 집지 않는다.
--
-- 전제: 0003, 0007. 실행: SQL editor 에 이 파일 전체를 붙여 한 번. Fly 배포보다 먼저. 다시 실행해도 안전하다.

do $$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'pelham_sim_reservations'
                    and column_name = 'source') then
    raise exception '0140 needs 0007 first (pelham_sim_reservations.source is missing).';
  end if;
end;
$$;

-- ===== 테이블 ==========================================================

create table if not exists public.pelham_sim_emails (
  id              bigint generated always as identity primary key,
  reservation_id  bigint not null unique references public.pelham_sim_reservations (id) on delete cascade,
  email           text not null check (length(email) <= 254),
  -- sending: 집음 / sent·failed: 결과
  status          text not null check (status in ('sending', 'sent', 'failed')),
  error           text check (error is null or length(error) <= 300),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

alter table public.pelham_sim_emails enable row level security;
revoke all on public.pelham_sim_emails from anon, authenticated;

-- ===== 함수 (service_role) =============================================

-- 보낼 것을 집는다.
-- [{id, email, name, date, start_minutes, duration_hours, player_count, bay_number, total_price, confirmation_code}]
create or replace function public.pelham_sim_emails_claim(p_limit integer default 20)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_out jsonb := '[]'::jsonb;
  r record;
  v_id bigint;
begin
  for r in
    select s.id, s.customer_email, s.customer_name, s.booking_date, s.start_minutes, s.duration_hours,
           s.player_count, s.total_price, s.confirmation_code, b.bay_number
      from public.pelham_sim_reservations s
      join public.pelham_sim_bays b on b.id = s.bay_id
      left join public.pelham_sim_emails x on x.reservation_id = s.id
     where s.source = 'online' and s.status <> 'cancelled'
       and s.created_at > now() - interval '30 minutes'
       and x.id is null
     order by s.id
     limit greatest(coalesce(p_limit, 20), 1)
  loop
    v_id := null;
    insert into public.pelham_sim_emails (reservation_id, email, status)
    values (r.id, btrim(r.customer_email), 'sending')
    on conflict (reservation_id) do nothing
    returning id into v_id;
    if v_id is not null then
      v_out := v_out || jsonb_build_object(
        'id', v_id, 'email', btrim(r.customer_email), 'name', r.customer_name,
        'date', to_char(r.booking_date, 'YYYY-MM-DD'), 'start_minutes', r.start_minutes,
        'duration_hours', r.duration_hours, 'player_count', r.player_count, 'bay_number', r.bay_number,
        'total_price', r.total_price, 'confirmation_code', r.confirmation_code);
    end if;
  end loop;
  return v_out;
end;
$$;

-- 결과를 적는다. sending 줄만.
create or replace function public.pelham_sim_email_result(p_id bigint, p_status text, p_error text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_status not in ('sent', 'failed') then
    perform public.pelham_fail('422', 'Unknown email status.');
  end if;
  update public.pelham_sim_emails
     set status = p_status, error = left(p_error, 300), updated_at = now()
   where id = p_id and status = 'sending';
end;
$$;

-- ===== 권한 ============================================================

revoke all on function public.pelham_sim_emails_claim(integer) from public, anon, authenticated;
revoke all on function public.pelham_sim_email_result(bigint, text, text) from public, anon, authenticated;

grant execute on function public.pelham_sim_emails_claim(integer) to service_role;
grant execute on function public.pelham_sim_email_result(bigint, text, text) to service_role;

-- ===== 확인 ============================================================
-- 두 줄이 나와야 한다.
select proname from pg_proc
 where proname in ('pelham_sim_emails_claim', 'pelham_sim_email_result')
 order by proname;
