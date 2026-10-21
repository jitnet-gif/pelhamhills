-- 웹사이트 팝업(0060)에 넣을 이미지를 직원이 직접 올리는 곳. Supabase Storage 버킷 `site-images`.
--
-- 왜(2026-10-21): 이미지 주소를 붙여 넣는 방식은 직원이 쓸 수 없다 — 프로모션 포스터는 대개 휴대폰·PC 의 파일이다.
--
--   버킷 site-images  — 공개(public). 손님 브라우저가 로그인 없이 그림을 읽는다. 5MB·그림 파일만.
--   올리기·지우기      — 직원(pelham_is_staff)만. 화면이 로그인 토큰으로 Storage API 를 직접 부른다.
--   pelham_site_image_uploader() — 정책이 부르는 판정. pelham_is_staff 는 authenticated 에게 막혀 있어서
--                       (0004) 정책 안에서 바로 못 부른다 — 정책은 부르는 사람의 권한으로 돈다.
--
-- 화면은 올리기 전에 큰 사진을 1600px 로 줄인다(`lib/siteNotices.ts` 의 uploadSiteImage).
--
-- 전제: 0004. 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다.

do $$
begin
  if to_regprocedure('public.pelham_is_staff()') is null then
    raise exception '0061 needs 0004 first (pelham_is_staff is missing).';
  end if;
end;
$$;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('site-images', 'site-images', true, 5242880,
        array['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

create or replace function public.pelham_site_image_uploader()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.pelham_is_staff()
$$;

revoke all on function public.pelham_site_image_uploader() from public, anon;
grant execute on function public.pelham_site_image_uploader() to authenticated;

drop policy if exists "site images: staff upload" on storage.objects;
create policy "site images: staff upload" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'site-images' and public.pelham_site_image_uploader());

drop policy if exists "site images: staff update" on storage.objects;
create policy "site images: staff update" on storage.objects
  for update to authenticated
  using (bucket_id = 'site-images' and public.pelham_site_image_uploader());

drop policy if exists "site images: staff delete" on storage.objects;
create policy "site images: staff delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'site-images' and public.pelham_site_image_uploader());
