-- 웹 예약 확인 문자(booking confirmation texts) — 고객 사이트에서 예약한 손님에게도 확인 문자를 보낸다.
--
-- 왜(2026-10-18): 전화·문자 비서로 한 예약은 FastAPI 가 확정하면서 바로 확인 문자를 보낸다
-- (`voice.confirm_booking`, `voice_sim.book_sim_bay`). 그런데 웹 예약은 브라우저가 `pelham_tee_book`·
-- `pelham_sim_reserve`(0003)를 직접 불러 Supabase 에서 끝나므로, Twilio 키가 있는 서버를 한 번도 거치지
-- 않아 문자가 나간 적이 없다.
--
-- 누가 보내나: FastAPI 의 `backend/services/booking_texts.py` 가 1분마다 이 파일의 claim 을 부르고,
-- 전화 예약과 같은 문장으로 보낸 뒤 결과를 적는다. 이 파일은 "보낼 것 집기" 와 "결과 적기" 만 한다(0028 과 같은 꼴).
--
-- 규칙:
--   - 웹 예약만: 티타임은 source = 'web', 실내 골프는 source = 'online'. 직원이 시트에 넣은 예약과
--     전화·문자 비서 예약(이미 보낸다)은 대상이 아니다.
--   - 한 예약에 한 번. (kind, ref) 가 유일하고, 집을 때 줄을 먼저 만든다. 실패해도 다시 집지 않는다.
--   - 막 만든 것만: 30분 안에 만든 예약. 이 파일을 처음 돌려도 지난 예약에 문자가 쏟아지지 않는다.
--   - 취소된 예약은 집지 않는다. 번호가 없으면 `no_phone` 으로 남긴다.
--
-- 전제: 0003, 0007, 0028(pelham_pt_booking_phone). 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다.

do $$
begin
  if to_regprocedure('public.pelham_pt_booking_phone(text, text)') is null then
    raise exception '0032 needs 0028 first (pelham_pt_booking_phone is missing).';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'pelham_sim_reservations'
                    and column_name = 'source') then
    raise exception '0032 needs 0007 first (pelham_sim_reservations.source is missing).';
  end if;
end;
$$;

-- ===== 테이블 ==========================================================

-- 예약 하나 = 한 줄. tee 는 pelham_tee_bookings.id, sim 은 pelham_sim_reservations.id(문자로).
create table if not exists public.pelham_booking_texts (
  id          bigint generated always as identity primary key,
  kind        text not null check (kind in ('tee', 'sim')),
  ref         text not null check (length(ref) <= 64),
  -- E.164 가 아니어도 된다(FastAPI 가 정규화한다). no_phone 이면 비어 있다.
  phone       text check (phone is null or length(phone) <= 40),
  -- sending: 집음 / sent·failed·skipped: Twilio 결과 / no_phone: 보낼 번호가 없음
  status      text not null check (status in ('sending', 'sent', 'failed', 'skipped', 'no_phone')),
  error       text check (error is null or length(error) <= 300),
  twilio_sid  text check (twilio_sid is null or length(twilio_sid) <= 64),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (kind, ref)
);

alter table public.pelham_booking_texts enable row level security;
revoke all on public.pelham_booking_texts from anon, authenticated;

-- ===== 함수 (service_role) =============================================

-- 보낼 것을 집는다. 집은 줄은 sending(번호 있음) 또는 no_phone 이 된다. sending 만 돌려준다.
-- tee: [{id, kind, ref, phone, date, time, party_size, holes, rate, name, status}]
-- sim: [{id, kind, ref, phone, date, start_minutes, duration_hours, confirmation_code}]
create or replace function public.pelham_booking_texts_claim(p_limit integer default 20)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_out jsonb := '[]'::jsonb;
  r record;
  v_phone text;
  v_text public.pelham_booking_texts;
begin
  -- 티타임 웹 예약.
  for r in
    select t.id, t.doc
      from public.pelham_tee_bookings t
      left join public.pelham_booking_texts x on x.kind = 'tee' and x.ref = t.id
     where t.source = 'web' and coalesce(t.status, '') <> 'cancelled'
       and t.created_at > now() - interval '30 minutes'
       and x.id is null
     order by t.created_at
     limit greatest(coalesce(p_limit, 20), 1)
  loop
    v_phone := public.pelham_pt_booking_phone(r.id, null);
    v_text := null;
    insert into public.pelham_booking_texts (kind, ref, phone, status)
    values ('tee', r.id, v_phone, case when v_phone is null then 'no_phone' else 'sending' end)
    on conflict (kind, ref) do nothing
    returning * into v_text;
    if v_text.id is not null and v_text.status = 'sending' then
      v_out := v_out || jsonb_build_object(
        'id', v_text.id, 'kind', 'tee', 'ref', r.id, 'phone', v_text.phone,
        'date', r.doc->>'date', 'time', r.doc->>'time',
        'party_size', jsonb_array_length(coalesce(r.doc->'players', '[]'::jsonb)),
        'holes', coalesce((r.doc->>'holes')::integer, 18),
        'rate', coalesce((r.doc->>'rate')::numeric, 0),
        'name', coalesce(r.doc->>'title', ''),
        'status', coalesce(r.doc->>'status', 'reserved'));
    end if;
  end loop;

  -- 실내 골프 웹 예약.
  for r in
    select s.id, s.phone, s.booking_date, s.start_minutes, s.duration_hours, s.confirmation_code
      from public.pelham_sim_reservations s
      left join public.pelham_booking_texts x on x.kind = 'sim' and x.ref = s.id::text
     where s.source = 'online' and s.status <> 'cancelled'
       and s.created_at > now() - interval '30 minutes'
       and x.id is null
     order by s.id
     limit greatest(coalesce(p_limit, 20), 1)
  loop
    v_phone := nullif(btrim(r.phone), '');
    v_text := null;
    insert into public.pelham_booking_texts (kind, ref, phone, status)
    values ('sim', r.id::text, v_phone, case when v_phone is null then 'no_phone' else 'sending' end)
    on conflict (kind, ref) do nothing
    returning * into v_text;
    if v_text.id is not null and v_text.status = 'sending' then
      v_out := v_out || jsonb_build_object(
        'id', v_text.id, 'kind', 'sim', 'ref', r.id::text, 'phone', v_text.phone,
        'date', to_char(r.booking_date, 'YYYY-MM-DD'), 'start_minutes', r.start_minutes,
        'duration_hours', r.duration_hours, 'confirmation_code', r.confirmation_code);
    end if;
  end loop;

  return v_out;
end;
$$;

-- Twilio 결과를 적는다. sending 줄만.
create or replace function public.pelham_booking_text_result(p_id bigint, p_status text, p_error text, p_sid text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_status not in ('sent', 'failed', 'skipped') then
    perform public.pelham_fail('422', 'Unknown text status.');
  end if;
  update public.pelham_booking_texts
     set status = p_status, error = left(p_error, 300), twilio_sid = left(p_sid, 64), updated_at = now()
   where id = p_id and status = 'sending';
end;
$$;

-- ===== 권한 ============================================================

revoke all on function public.pelham_booking_texts_claim(integer) from public, anon, authenticated;
revoke all on function public.pelham_booking_text_result(bigint, text, text, text) from public, anon, authenticated;

grant execute on function public.pelham_booking_texts_claim(integer) to service_role;
grant execute on function public.pelham_booking_text_result(bigint, text, text, text) to service_role;
