-- 문자 기록: 보낸 문자·받은 문자·전달 상태를 DB 에 남긴다. 어드민 "Calls & SMS" 의 문자 탭이 읽는다.
--
-- 왜(2026-10-20): 지금까지 문자 기록은 FastAPI(Fly) 프로세스 메모리(`twilio_sms.sms_messages`)에만 있었다.
-- 재배포·재시작하면 사라지고, 머신이 둘이면 서로 다른 기록을 가진다. 그래서 화면에 붙일 수 없었다.
-- 수신 거부(STOP)도 메모리뿐이라 재시작 뒤에는 STOP 한 손님에게 다시 문자가 갈 수 있었다 —
-- 이제 백엔드가 0047 `pelham_marketing_optouts`(source = 'reply')를 진실로 읽는다. 그 표는 이미 있다.
--
-- 쓰는 쪽은 백엔드뿐이다(service_role). 화면은 FastAPI `/sms/messages` 가 직원 확인 뒤 대신 읽는다
-- (`/calls` 와 같은 방식). 그래서 anon·authenticated 에는 아무 권한도 주지 않는다.
--
-- 전제: 0047(수신 거부 표). 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다.

do $$
begin
  if to_regclass('public.pelham_marketing_optouts') is null then
    raise exception '0058 needs 0047 first (pelham_marketing_optouts is missing).';
  end if;
end;
$$;

create table if not exists public.pelham_sms_messages (
  id           uuid primary key default gen_random_uuid(),
  direction    text not null check (direction in ('in', 'out')),
  to_phone     text not null default '',
  from_phone   text not null default '',
  -- 손님 번호(E.164). 보낸 문자는 to, 받은 문자는 from. 번호별 대화를 묶는 열쇠.
  phone        text not null default '',
  body         text not null default '',
  template     text,
  booking_ref  text,
  media_url    text,
  status       text not null default 'queued',
  twilio_sid   text,
  error        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists pelham_sms_messages_created_idx on public.pelham_sms_messages (created_at desc);
create index if not exists pelham_sms_messages_phone_idx on public.pelham_sms_messages (phone, created_at desc);
create unique index if not exists pelham_sms_messages_sid_idx
  on public.pelham_sms_messages (twilio_sid) where twilio_sid is not null;

alter table public.pelham_sms_messages enable row level security;
revoke all on public.pelham_sms_messages from public, anon, authenticated;

notify pgrst, 'reload schema';
