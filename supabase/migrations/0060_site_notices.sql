-- 웹사이트 팝업 공지·프로모션(`/admin/notices`). 직원이 글을 적어 두면 공개 사이트·예약 사이트에 창으로 뜬다.
--
-- 왜(2026-10-21): "서리 때문에 오늘 아침 티타임이 9시 30분까지 늦어집니다", "주중 트와일라잇 할인" 같은 말을
-- 손님이 예약하기 전에 보게 하고 싶다. 지금은 사이트 문구를 고치려면 코드를 배포해야 한다.
--
--   pelham_site_notices                      — 공지 표. 공개 키로는 읽히지 않는다(아래 함수로만).
--   pelham_site_notices_now(p_surface)       — 손님용. 지금 떠야 하는 것만(켜짐 + 기간 안 + 그 표면). anon 가능.
--   pelham_staff_site_notices()              — 직원용 목록(전부, 최근 200건).
--   pelham_staff_site_notice_save(p)         — p.id 가 있으면 고치고, 없으면 새로 만든다.
--   pelham_staff_site_notice_delete(p_id)    — 지운다. 잠깐 내리려면 지우지 말고 active=false.
--
-- 표면(surfaces): all · site(공개 사이트 pelhamhills.com) · book(/book/* 예약 화면).
-- 다시 보이기(repeat): once(닫으면 그 공지가 고쳐질 때까지 다시 안 뜸) · daily(하루 한 번) · every_visit(창을 열 때마다).
-- 닫은 기록은 손님 브라우저(localStorage)에만 있다 — `version`(updated_at)이 바뀌면 다시 뜬다.
--
-- 전제: 0004(pelham_require_staff·pelham_fail).
-- 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다.

do $$
begin
  if to_regprocedure('public.pelham_require_staff()') is null then
    raise exception '0060 needs 0004 first (pelham_require_staff is missing).';
  end if;
end;
$$;

create table if not exists public.pelham_site_notices (
  id          uuid primary key default gen_random_uuid(),
  -- notice: 일반 안내 · alert: 코스 상황(서리 지연·휴장 등, 먼저 뜬다) · promotion: 할인·행사
  kind        text not null default 'notice' check (kind in ('notice', 'alert', 'promotion')),
  title       text not null check (btrim(title) <> ''),
  body        text not null default '',
  image_url   text,
  link_url    text,
  link_label  text,
  surfaces    text not null default 'all' check (surfaces in ('all', 'site', 'book')),
  repeat      text not null default 'once' check (repeat in ('once', 'daily', 'every_visit')),
  starts_at   timestamptz,           -- 비면 지금부터
  ends_at     timestamptz,           -- 비면 끄기 전까지
  active      boolean not null default true,
  sort        integer not null default 0,   -- 같은 종류끼리 작은 수가 먼저
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  updated_by  text,
  check (ends_at is null or starts_at is null or ends_at > starts_at)
);

alter table public.pelham_site_notices enable row level security;
revoke all on public.pelham_site_notices from anon, authenticated;

-- ===== 헬퍼 ==============================================================

create or replace function public.pelham_site_notice_json(r public.pelham_site_notices)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', r.id,
    'kind', r.kind,
    'title', r.title,
    'body', r.body,
    'image_url', r.image_url,
    'link_url', r.link_url,
    'link_label', r.link_label,
    'surfaces', r.surfaces,
    'repeat', r.repeat,
    'starts_at', r.starts_at,
    'ends_at', r.ends_at,
    'active', r.active,
    'sort', r.sort,
    'created_at', r.created_at,
    'updated_at', r.updated_at,
    'updated_by', r.updated_by
  )
$$;

-- ===== 손님용 ============================================================

-- 지금 떠야 하는 공지. 손님에게는 직원 정보(updated_by 등)를 주지 않는다.
-- `version` 은 손님 브라우저가 "이미 닫은 그 글인가" 를 가리는 값이다.
create or replace function public.pelham_site_notices_now(p_surface text default 'site')
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', n.id,
           'kind', n.kind,
           'title', n.title,
           'body', n.body,
           'image_url', n.image_url,
           'link_url', n.link_url,
           'link_label', n.link_label,
           'repeat', n.repeat,
           'version', floor(extract(epoch from n.updated_at))::bigint
         ) order by (n.kind = 'alert') desc, n.sort, n.created_at desc), '[]'::jsonb)
    from (
      select * from public.pelham_site_notices s
       where s.active
         and (s.starts_at is null or s.starts_at <= now())
         and (s.ends_at is null or s.ends_at > now())
         and (s.surfaces = 'all' or s.surfaces = coalesce(p_surface, 'site'))
       order by (s.kind = 'alert') desc, s.sort, s.created_at desc
       limit 5
    ) n
$$;

-- ===== 직원 함수 =========================================================

create or replace function public.pelham_staff_site_notices()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.pelham_require_staff();
  return coalesce((
    select jsonb_agg(public.pelham_site_notice_json(r) order by r.created_at desc)
      from (select * from public.pelham_site_notices order by created_at desc limit 200) r
  ), '[]'::jsonb);
end;
$$;

-- 만들기·고치기. `p` 에 있는 키만 바꾼다(새로 만들 때는 없는 키가 기본값).
create or replace function public.pelham_staff_site_notice_save(p jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  r public.pelham_site_notices;
  v_id uuid := nullif(btrim(coalesce(p->>'id', '')), '')::uuid;
  v_by text;
  v_link text := nullif(btrim(coalesce(p->>'link_url', '')), '');
  v_image text := nullif(btrim(coalesce(p->>'image_url', '')), '');
begin
  perform public.pelham_require_staff();
  select u.email into v_by from auth.users u where u.id = auth.uid();

  if p ? 'title' and btrim(coalesce(p->>'title', '')) = '' then
    perform public.pelham_fail('422', 'Give the pop-up a title.');
  end if;
  if p ? 'kind' and p->>'kind' not in ('notice', 'alert', 'promotion') then
    perform public.pelham_fail('422', format('''%s'' is not a pop-up kind', p->>'kind'));
  end if;
  if p ? 'surfaces' and p->>'surfaces' not in ('all', 'site', 'book') then
    perform public.pelham_fail('422', format('''%s'' is not a place to show pop-ups', p->>'surfaces'));
  end if;
  if p ? 'repeat' and p->>'repeat' not in ('once', 'daily', 'every_visit') then
    perform public.pelham_fail('422', format('''%s'' is not a repeat setting', p->>'repeat'));
  end if;
  -- 링크·이미지는 사이트 안 주소(/...)나 https 만. javascript: 같은 것을 손님 화면에 심지 못하게.
  if v_link is not null and v_link !~* '^(https://|/)' then
    perform public.pelham_fail('422', 'Links must start with https:// or / (a page on this site).');
  end if;
  if v_image is not null and v_image !~* '^(https://|/)' then
    perform public.pelham_fail('422', 'Image addresses must start with https:// or /.');
  end if;

  if v_id is null then
    if btrim(coalesce(p->>'title', '')) = '' then
      perform public.pelham_fail('422', 'Give the pop-up a title.');
    end if;
    insert into public.pelham_site_notices
      (kind, title, body, image_url, link_url, link_label, surfaces, repeat, starts_at, ends_at, active, sort, updated_by)
    values (
      coalesce(p->>'kind', 'notice'),
      btrim(p->>'title'),
      coalesce(p->>'body', ''),
      v_image,
      v_link,
      nullif(btrim(coalesce(p->>'link_label', '')), ''),
      coalesce(p->>'surfaces', 'all'),
      coalesce(p->>'repeat', 'once'),
      nullif(p->>'starts_at', '')::timestamptz,
      nullif(p->>'ends_at', '')::timestamptz,
      coalesce((p->>'active')::boolean, true),
      coalesce((p->>'sort')::integer, 0),
      v_by
    )
    returning * into r;
    return public.pelham_site_notice_json(r);
  end if;

  update public.pelham_site_notices
     set kind       = case when p ? 'kind' then p->>'kind' else kind end,
         title      = case when p ? 'title' then btrim(p->>'title') else title end,
         body       = case when p ? 'body' then coalesce(p->>'body', '') else body end,
         image_url  = case when p ? 'image_url' then v_image else image_url end,
         link_url   = case when p ? 'link_url' then v_link else link_url end,
         link_label = case when p ? 'link_label' then nullif(btrim(coalesce(p->>'link_label', '')), '') else link_label end,
         surfaces   = case when p ? 'surfaces' then p->>'surfaces' else surfaces end,
         repeat     = case when p ? 'repeat' then p->>'repeat' else repeat end,
         starts_at  = case when p ? 'starts_at' then nullif(p->>'starts_at', '')::timestamptz else starts_at end,
         ends_at    = case when p ? 'ends_at' then nullif(p->>'ends_at', '')::timestamptz else ends_at end,
         active     = case when p ? 'active' then coalesce((p->>'active')::boolean, active) else active end,
         sort       = case when p ? 'sort' then coalesce((p->>'sort')::integer, sort) else sort end,
         updated_at = now(),
         updated_by = v_by
   where id = v_id
  returning * into r;
  if r.id is null then
    perform public.pelham_fail('404', 'No such pop-up');
  end if;
  return public.pelham_site_notice_json(r);
exception
  when check_violation then
    perform public.pelham_fail('422', 'The end time must be after the start time.');
end;
$$;

create or replace function public.pelham_staff_site_notice_delete(p_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform public.pelham_require_staff();
  delete from public.pelham_site_notices where id = p_id;
end;
$$;

-- ===== 권한 ============================================================

revoke all on function public.pelham_site_notice_json(public.pelham_site_notices) from public, anon, authenticated;
revoke all on function public.pelham_site_notices_now(text) from public;
revoke all on function public.pelham_staff_site_notices() from public, anon;
revoke all on function public.pelham_staff_site_notice_save(jsonb) from public, anon;
revoke all on function public.pelham_staff_site_notice_delete(uuid) from public, anon;

grant execute on function public.pelham_site_notices_now(text) to anon, authenticated;
grant execute on function public.pelham_staff_site_notices() to authenticated;
grant execute on function public.pelham_staff_site_notice_save(jsonb) to authenticated;
grant execute on function public.pelham_staff_site_notice_delete(uuid) to authenticated;

notify pgrst, 'reload schema';
