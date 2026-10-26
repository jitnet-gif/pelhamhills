-- AI Manager — **Hope 기록**. AI 매니저 화면의 Hope(음성 비서)와 주고받은 것을 모두 남긴다.
--
-- 왜(2026-10-26): Hope 에게 "오늘 예약·매출" 을 묻고, 전략을 만들게 하고, "문자로 보내 줘" 로 손님 문자와
-- 웹사이트 팝업까지 실행한다. 사용자 요청: "결과는 항상 레포트로 남겨 두고". 전략 보고서(0113)는 전략만
-- 담으므로, 대화와 실행 결과는 이 표에 남긴다.
--
-- - `pelham_ai_manager_log`: 한 줄 = 언제·누가·언어·종류(chat 대화 / launch 실행 / present 프레젠테이션 등) +
--   물은 말·Hope 의 답 + detail(찾아본 숫자, 화면에 넘긴 동작, 만든 캠페인·팝업 번호와 결과).
-- - **지우지 못한다, 고치지 못한다** — 0113 과 같은 트리거.
-- - `pelham_staff_ai_manager_log_save(...)`: Fly(`/ai-marketing/chat`)와 화면이 직원 토큰으로 저장한다.
-- - `pelham_staff_ai_manager_log(p_limit)`: 최근 것부터. AI 매니저 화면의 "Hope reports" 가 읽는다.
--
-- 명단은 0094 와 같다(매니저 + pelham_ai_marketing_viewers). 전제: 0094. 실행: SQL editor 에 이 파일 전체를
-- 붙여 한 번. 다시 실행해도 안전하다.

do $$
begin
  if to_regprocedure('public.pelham_require_ai_marketing_viewer()') is null then
    raise exception '0119 needs 0094 first (pelham_require_ai_marketing_viewer is missing).';
  end if;
end;
$$;

create table if not exists public.pelham_ai_manager_log (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  created_by text not null default '',
  lang text not null check (lang in ('en', 'ko')),
  kind text not null check (kind in ('chat', 'launch', 'strategy', 'present')),
  question text not null default '',
  answer text not null default '',
  detail jsonb not null default '{}'::jsonb
);

create index if not exists pelham_ai_manager_log_created on public.pelham_ai_manager_log (created_at desc);

alter table public.pelham_ai_manager_log enable row level security;
revoke all on public.pelham_ai_manager_log from public, anon, authenticated;

create or replace function public.pelham_ai_manager_log_keep()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'Hope reports are kept for good and cannot be changed or deleted.';
end;
$$;

drop trigger if exists pelham_ai_manager_log_keep on public.pelham_ai_manager_log;
create trigger pelham_ai_manager_log_keep
  before update or delete or truncate on public.pelham_ai_manager_log
  for each statement execute function public.pelham_ai_manager_log_keep();

create or replace function public.pelham_staff_ai_manager_log_save(
  p_kind text, p_lang text, p_question text, p_answer text, p_detail jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_email text;
begin
  perform public.pelham_require_ai_marketing_viewer();
  if coalesce(p_kind, '') not in ('chat', 'launch', 'strategy', 'present') or coalesce(p_lang, '') not in ('en', 'ko') then
    perform public.pelham_fail('400', 'Unknown kind or language.');
  end if;
  if p_detail is not null and jsonb_typeof(p_detail) <> 'object' then
    perform public.pelham_fail('400', 'detail must be an object.');
  end if;
  select lower(u.email) into v_email from auth.users u where u.id = auth.uid();
  insert into public.pelham_ai_manager_log (created_by, lang, kind, question, answer, detail)
  values (coalesce(v_email, ''), p_lang, p_kind, left(coalesce(p_question, ''), 2000), left(coalesce(p_answer, ''), 4000),
          coalesce(p_detail, '{}'::jsonb))
  returning id into v_id;
  return jsonb_build_object('id', v_id);
end;
$$;

create or replace function public.pelham_staff_ai_manager_log(p_limit integer default 50)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.pelham_require_ai_marketing_viewer();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', id, 'created_at', created_at, 'created_by', created_by, 'lang', lang, 'kind', kind,
             'question', question, 'answer', answer, 'detail', detail) order by created_at desc)
      from (select * from public.pelham_ai_manager_log
             order by created_at desc
             limit least(greatest(coalesce(p_limit, 50), 1), 500)) s
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.pelham_staff_ai_manager_log_save(text, text, text, text, jsonb) from public, anon;
revoke all on function public.pelham_staff_ai_manager_log(integer) from public, anon;
grant execute on function public.pelham_staff_ai_manager_log_save(text, text, text, text, jsonb) to authenticated;
grant execute on function public.pelham_staff_ai_manager_log(integer) to authenticated;

notify pgrst, 'reload schema';
