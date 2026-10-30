-- 실내 골프 온라인 예약이 안 열린다: "column b.status does not exist" (2026-10-29 확인).
--
-- 왜: 0083(Bay 1·2·3 고르기)의 pelham_sim_availability·pelham_sim_reserve 는 점검 중인 베이를
--   빼려고 pelham_sim_bays.status 를 본다. 이 칸은 0007 이 더하는데, 운영 DB 에는 없다.
--   그래서 /book/indoor 가 시간 슬롯도, Bay 1·2·3 단추도 못 받고 예약도 실패한다.
--
-- 바꾸는 것: 0007 의 칸·제약만 다시 더한다(함수는 건드리지 않는다 — 0083 것이 그대로 산다).
--   - pelham_sim_bays.status (open / cleaning / maintenance, 기본 open), status_updated_at
--   - pelham_sim_reservations.source (기본 online) — 0083 은 안 쓰지만 직원 Bay Sheet 가 쓴다.
--   - 0007 의 check 제약 세 개.
--
-- 전제: 0003, 0083. 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다.

alter table public.pelham_sim_bays
  add column if not exists status text not null default 'open',
  add column if not exists status_updated_at timestamptz;

alter table public.pelham_sim_reservations
  add column if not exists source text not null default 'online';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'pelham_sim_bays_status_check') then
    alter table public.pelham_sim_bays add constraint pelham_sim_bays_status_check
      check (status in ('open', 'cleaning', 'maintenance'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'pelham_sim_reservations_source_check') then
    alter table public.pelham_sim_reservations add constraint pelham_sim_reservations_source_check
      check (source in ('online', 'phone', 'walk_in', 'voice_ai'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'pelham_sim_reservations_status_check') then
    alter table public.pelham_sim_reservations add constraint pelham_sim_reservations_status_check
      check (status in ('confirmed', 'checked_in', 'paid', 'no_show', 'cancelled'));
  end if;
end;
$$;

notify pgrst, 'reload schema';

-- ===== 확인 ============================================================
-- 1) 베이: Bay 1·2·3 이 left_right · is_active true · status open 이어야 한다(0009).
--    아니면 0009 를 붙여 실행한다.
select bay_number, bay_type, is_active, status from public.pelham_sim_bays order by bay_number;

-- 2) 손님 화면이 받는 값: 'bays' 에 [1, 2, 3], 슬롯마다 'free_bays' 가 보여야 한다.
select public.pelham_sim_availability(
  (public.pelham_local_now()::date + 1), 'left_right', 1
) -> 'bays' as bays;
