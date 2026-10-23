-- ============================================================================
-- 0082 예약 신분증 사진 (ID scan)
-- ============================================================================
--
-- 온라인 예약을 마친 손님이 확정 화면에서 신분증 사진을 올립니다. 그 사진은
-- 골프 GPS 앱(같은 Supabase 프로젝트)이 NFC 체크인 순간 카운터 직원 화면에
-- 띄워 본인 확인에 씁니다(GPS 저장소 0024_nfc_checkin.sql).
--
-- ## 왜 Storage 버킷이 아니라 표인가
-- 손님은 로그인하지 않습니다(코드 + 이메일이 본인 확인). 버킷에 올리게 하려면
-- anon 에게 쓰기 정책을 열어야 하고, 그러면 누구든 아무 파일이나 올릴 수
-- 있습니다. 표에 두면 아래 함수 하나만 통하고, 그 함수가 코드와 이메일을 먼저
-- 확인합니다. 사진은 브라우저가 1280px JPEG 로 줄여 보내므로 한 장이 수백 KB 입니다.
--
-- ## 누가 보는가
-- 손님 자신도 다시 받아 갈 수 없습니다(올리기만). 읽는 길은 직원 확인을 거치는
-- GPS 쪽 함수뿐입니다. 신분증은 유출되면 되돌릴 수 없는 자료라, 보여 줄 곳을
-- 늘리지 않습니다.
--
-- ## 얼마나 두는가
-- 티타임 날짜로부터 30일. 올릴 때마다 지난 것을 지웁니다(따로 크론을 두지 않음).
--
-- 먼저: 0003(pelham_fail), 0012(pelham_tee_guest_row). 여러 번 실행해도 안전합니다.
-- ============================================================================

create table if not exists public.pelham_id_scans (
  booking_id   text primary key references public.pelham_tee_bookings (id) on delete cascade,
  -- 사진을 올린 사람(예약 연락처) 이름. 직원 화면 제목줄에 씁니다.
  holder_name  text,
  holder_email text not null,
  mime         text not null check (mime in ('image/jpeg', 'image/png', 'image/webp')),
  image        bytea not null,
  booking_date date not null,
  uploaded_at  timestamptz not null default now()
);

create index if not exists pelham_id_scans_email
  on public.pelham_id_scans (lower(holder_email), booking_date desc);

alter table public.pelham_id_scans enable row level security;
revoke all on public.pelham_id_scans from anon, authenticated;

-- 손님: 코드 + 이메일로 예약을 확인한 뒤 사진을 저장(덮어쓰기)합니다.
-- p_image 는 base64 (data: 접두어 없이). 돌려주는 값은 저장 시각뿐입니다.
create or replace function public.pelham_id_scan_upload(
  p_code text, p_email text, p_mime text, p_image text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  t public.pelham_tee_bookings := public.pelham_tee_guest_row(p_code, p_email);
  v_bytes bytea;
  v_contact jsonb;
begin
  if t.id is null then
    perform public.pelham_guest_not_found();
  end if;
  if t.status in ('cancelled', 'no_show') then
    perform public.pelham_fail('409', 'This tee time is no longer active.');
  end if;
  if p_mime not in ('image/jpeg', 'image/png', 'image/webp') then
    perform public.pelham_fail('400', 'Upload a JPEG, PNG or WebP photo.');
  end if;

  begin
    v_bytes := decode(p_image, 'base64');
  exception when others then
    perform public.pelham_fail('400', 'The photo could not be read. Try again.');
  end;
  if length(v_bytes) < 2000 or length(v_bytes) > 2 * 1024 * 1024 then
    perform public.pelham_fail('400', 'The photo must be under 2 MB.');
  end if;

  v_contact := t.doc->'players'->public.pelham_tee_contact_index(t.doc);

  insert into public.pelham_id_scans
    (booking_id, holder_name, holder_email, mime, image, booking_date, uploaded_at)
  values
    (t.id, v_contact->>'name', lower(btrim(p_email)), p_mime, v_bytes, t.booking_date, now())
  on conflict (booking_id) do update
    set holder_name = excluded.holder_name,
        holder_email = excluded.holder_email,
        mime = excluded.mime,
        image = excluded.image,
        uploaded_at = excluded.uploaded_at;

  -- 30일이 지난 사진은 여기서 같이 지웁니다.
  delete from public.pelham_id_scans where booking_date < current_date - 30;

  return jsonb_build_object('uploadedAt', now());
end;
$$;

-- 손님: 이 예약에 사진이 이미 있는지만(사진은 돌려주지 않음).
create or replace function public.pelham_id_scan_exists(p_code text, p_email text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.pelham_id_scans s
     where s.booking_id = (public.pelham_tee_guest_row(p_code, p_email)).id
  )
$$;

revoke all on function public.pelham_id_scan_upload(text, text, text, text) from public;
revoke all on function public.pelham_id_scan_exists(text, text) from public;
grant execute on function public.pelham_id_scan_upload(text, text, text, text) to anon, authenticated;
grant execute on function public.pelham_id_scan_exists(text, text) to anon, authenticated;
