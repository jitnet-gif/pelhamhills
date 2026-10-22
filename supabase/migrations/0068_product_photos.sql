-- 상품 사진 — 계산대 카메라가 바코드 없이 **사진으로** 상품을 알아보게 한다.
--
-- 왜(2026-10-22): 로고 셔츠·스낵바 음식·렌탈처럼 포장 바코드가 없는 물건은 지금 손으로 찾아 누르거나
-- 클럽 바코드 스티커를 붙여야 한다. 상품마다 사진을 한 장 찍어 두면, 계산대 카메라에서 셔터를 눌러
-- 찍은 사진을 그 사진들과 비교해(FastAPI → Claude, `backend/api/routes/product_photo.py`) 계산서에 담는다.
--
--   photo_url                       — 상품 사진의 공개 주소(Supabase Storage `product-photos`). 비우면 null.
--   버킷 product-photos             — 공개(public). 2MB·그림 파일만. 화면이 올리기 전에 800px 로 줄인다.
--   올리기·지우기                    — 직원만. 0061 의 `pelham_site_image_uploader()` 판정을 같이 쓴다.
--   pelham_staff_pos_product_photo  — 사진 주소를 적거나(null 이면) 지운다. 상품의 다른 칸은 건드리지 않는다.
--
-- 상품 저장 함수(0030)를 다시 쓰지 않고 사진만 따로 적는다 — 사진은 저장 버튼과 상관없이 올린 즉시 바뀐다.
--
-- 전제: 0030, 0061. 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다.

do $$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'pelham_retail_products' and column_name = 'menu_group') then
    raise exception '0068 needs 0030 first (pelham_retail_products.menu_group is missing).';
  end if;
  if to_regprocedure('public.pelham_site_image_uploader()') is null then
    raise exception '0068 needs 0061 first (pelham_site_image_uploader is missing).';
  end if;
end;
$$;

alter table public.pelham_retail_products add column if not exists photo_url text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'pelham_retail_products_photo_url_check') then
    alter table public.pelham_retail_products add constraint pelham_retail_products_photo_url_check
      check (photo_url is null or photo_url ~ '^https://[^[:space:]]{1,500}$');
  end if;
end;
$$;

-- 0030 과 같고, 사진 주소 한 줄만 더했다.
create or replace function public.pelham_pos_product_json(p public.pelham_retail_products)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', p.id,
    'sku', p.sku,
    'barcode', p.barcode,
    'name', p.name,
    'category', p.category,
    'menu_group', p.menu_group,
    'photo_url', p.photo_url,
    'price', p.price,
    'cost', p.cost,
    'stock', p.stock,
    'reorder_point', p.reorder_point,
    'is_active', p.is_active,
    'created_at', public.pelham_iso(p.created_at),
    'updated_at', public.pelham_iso(p.updated_at)
  )
$$;

create or replace function public.pelham_staff_pos_product_photo(p_id integer, p_url text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v public.pelham_retail_products;
  v_url text := nullif(btrim(coalesce(p_url, '')), '');
begin
  perform public.pelham_require_staff();
  if v_url is not null and v_url !~ '^https://[^[:space:]]{1,500}$' then
    perform public.pelham_fail('422', 'The photo address must be an https link.');
  end if;
  update public.pelham_retail_products
     set photo_url = v_url, updated_at = now()
   where id = p_id
  returning * into v;
  if v.id is null then
    perform public.pelham_fail('404', 'Product not found');
  end if;
  return public.pelham_pos_product_json(v);
end;
$$;

revoke all on function public.pelham_staff_pos_product_photo(integer, text) from public, anon, authenticated;
grant execute on function public.pelham_staff_pos_product_photo(integer, text) to authenticated;

-- ===== 사진 보관함 =====================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('product-photos', 'product-photos', true, 2097152,
        array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "product photos: staff upload" on storage.objects;
create policy "product photos: staff upload" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'product-photos' and public.pelham_site_image_uploader());

drop policy if exists "product photos: staff update" on storage.objects;
create policy "product photos: staff update" on storage.objects
  for update to authenticated
  using (bucket_id = 'product-photos' and public.pelham_site_image_uploader());

drop policy if exists "product photos: staff delete" on storage.objects;
create policy "product photos: staff delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'product-photos' and public.pelham_site_image_uploader());

notify pgrst, 'reload schema';
