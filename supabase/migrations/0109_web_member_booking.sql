-- 웹사이트 티타임 예약(/book/tee-time)에서 회원 이름을 치면 찾아 고르고, 회원으로 예약되게 한다.
--
-- 왜(2026-10-25): 웹 예약은 모두 Guest · Public 요금제로 들어와서, 회원이 온라인으로 잡아도
-- 프로 샵이 티시트에서 손으로 회원을 다시 연결해야 했다.
--
-- 바꾸는 것:
-- - `pelham_tee_member_lookup(q)`(공개): 3글자 이상이면 살아 있는 회원권(취소 아님·만료 전)에서
--   이름(한 단어씩 모두 포함)으로 최대 6명. 이름·회원권 종류·시즌과 회원권 id 만 준다 —
--   공개 화면이라 전화·이메일·회원번호·고객번호는 내보내지 않는다.
-- - `pelham_tee_book_member(p, p_member)`(공개): `pelham_tee_book`(0034·0051) 으로 예약을 만든 뒤,
--   예약에 적은 이메일 또는 전화가 그 회원의 기록(회원권 줄·고객 명부)과 맞으면 첫 선수를 회원에 연결한다
--   (customerRef · memberNumber · 회원권 요금제). 그린피는 0055 트리거가 요금제로 다시 매긴다.
--   맞지 않으면 일반 예약 그대로 두고 노트에 "회원이라고 함 — 프로 샵 확인" 을 남긴다.
--   돌려주는 doc 에 `memberVerified`(참/거짓)를 붙인다(저장하지는 않는다).
--   `pelham_tee_book` 본문은 건드리지 않는다 — 0051 이 글자를 바꿔 끼운 함수라 복사하면 어긋난다.
--
-- 전제: 0034, 0053, 0069. 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다.

do $$
begin
  if to_regprocedure('public.pelham_tee_book(jsonb)') is null then
    raise exception '0109 needs 0034 first (pelham_tee_book is missing).';
  end if;
  if to_regprocedure('public.pelham_membership_rate_plan(text, text)') is null then
    raise exception '0109 needs 0053 first (pelham_membership_rate_plan is missing).';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'pelham_memberships' and column_name = 'expires_on') then
    raise exception '0109 needs 0069 first (pelham_memberships.expires_on is missing).';
  end if;
end;
$$;

-- ===== 공개 회원 검색 =====================================================

create or replace function public.pelham_tee_member_lookup(p_query text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_q text := lower(btrim(coalesce(p_query, '')));
  v_words text[];
  v_today date := public.pelham_local_now()::date;
begin
  if length(v_q) < 3 or length(v_q) > 80 then
    return '[]'::jsonb;
  end if;
  v_words := regexp_split_to_array(v_q, '\s+');

  return coalesce((
    with live as (
      -- 사람마다(명부 번호, 없으면 이름) 가장 최근 시즌 회원권 하나. 0053 검색과 같은 줄을 고른다.
      select distinct on (coalesce(m.customer_ref, lower(btrim(m.member_name))))
             m.id, m.season, m.membership_type, m.expires_on,
             coalesce(nullif(btrim(c.display_name), ''),
                      nullif(btrim(concat_ws(' ', c.first_name, c.last_name)), ''),
                      btrim(m.member_name)) as name,
             lower(concat_ws(' ', m.member_name, c.display_name, c.first_name, c.last_name)) as haystack
        from public.pelham_memberships m
        left join public.pelham_customers c on c.customer_ref = m.customer_ref
       where m.status <> 'cancelled'
       order by coalesce(m.customer_ref, lower(btrim(m.member_name))), m.season desc, m.created_at desc
    ),
    hits as (
      select l.*
        from live l
       where (l.expires_on is null or l.expires_on >= v_today)
         and (select bool_and(l.haystack like '%' || w || '%') from unnest(v_words) w)
       order by lower(l.name)
       limit 6
    )
    select jsonb_agg(jsonb_build_object(
             'ref', h.id,
             'name', h.name,
             'membershipType', h.membership_type,
             'season', h.season
           ) order by lower(h.name))
      from hits h
  ), '[]'::jsonb);
end;
$$;

-- ===== 회원으로 예약 =====================================================

create or replace function public.pelham_tee_book_member(p jsonb, p_member uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_doc jsonb := public.pelham_tee_book(p);
  v_id text := v_doc->>'id';
  v_date date := (v_doc->>'date')::date;
  v_email text := lower(btrim(coalesce(p->>'email', '')));
  v_phone text := right(regexp_replace(coalesce(p->>'phone', ''), '\D', '', 'g'), 10);
  v_m public.pelham_memberships;
  v_c public.pelham_customers;
  v_label text;
  v_plan text;
  v_ok boolean := false;
  v_players jsonb;
  v_now text := public.pelham_iso(now());
begin
  select * into v_m from public.pelham_memberships m
   where m.id = p_member and m.status <> 'cancelled'
     and (m.expires_on is null or m.expires_on >= v_date);
  if v_m.id is null then
    -- 고른 회원권이 그사이 취소·만료됐다. 예약은 일반 손님으로 그대로 둔다.
    return v_doc || jsonb_build_object('memberVerified', false);
  end if;
  if v_m.customer_ref is not null then
    select * into v_c from public.pelham_customers c where c.customer_ref = v_m.customer_ref;
  end if;

  v_label := initcap(replace(v_m.membership_type, '_', ' ')) || ' ' || v_m.season;
  v_plan := public.pelham_membership_rate_plan(v_m.membership_type, v_m.cart_package);

  -- 이메일이 같거나, 전화 끝 7자리 이상(최대 10자리)이 같으면 본인으로 본다.
  v_ok := (v_email <> '' and v_email in (lower(btrim(coalesce(v_m.email, ''))), lower(btrim(coalesce(v_c.email, '')))))
       or (length(v_phone) >= 7 and v_phone in (
             right(regexp_replace(coalesce(v_m.phone, ''), '\D', '', 'g'), 10),
             right(regexp_replace(coalesce(v_c.phone, ''), '\D', '', 'g'), 10)));

  if v_ok and v_plan <> '' then
    v_players := jsonb_set(v_doc->'players', '{0}', (v_doc->'players'->0) || jsonb_build_object(
      'type', 'Existing Customer',
      'ratePlan', v_plan,
      'customerRef', coalesce(v_m.customer_ref, ''),
      'memberNumber', coalesce(nullif(btrim(v_m.member_number), ''), nullif(btrim(v_c.member_number), ''), '')
    ));
    update public.pelham_tee_bookings t
       set doc = t.doc
                 || jsonb_build_object('players', v_players)
                 || jsonb_build_object('audit', coalesce(t.doc->'audit', '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
                      'id', gen_random_uuid()::text,
                      'ts', v_now,
                      'message', format('Booked online as member %s (%s) — %s matched the member record.',
                                        btrim(v_m.member_name), v_label,
                                        case when v_email <> '' and v_email in (lower(btrim(coalesce(v_m.email, ''))),
                                                                                lower(btrim(coalesce(v_c.email, ''))))
                                             then 'email' else 'phone' end)))),
           synced_at = now()
     where t.id = v_id
     returning doc into v_doc;
    return v_doc || jsonb_build_object('memberVerified', true);
  end if;

  update public.pelham_tee_bookings t
     set doc = t.doc || jsonb_build_object('notes', btrim(coalesce(t.doc->>'notes', '') || E'\n\n' || format(
                 'Says they are member %s (%s), but the email/phone did not match the member record — please check at the pro shop.',
                 btrim(v_m.member_name), v_label))),
         synced_at = now()
   where t.id = v_id
   returning doc into v_doc;
  return v_doc || jsonb_build_object('memberVerified', false);
end;
$$;

-- ===== 권한 ============================================================

revoke all on function public.pelham_tee_member_lookup(text) from public;
revoke all on function public.pelham_tee_book_member(jsonb, uuid) from public;
grant execute on function public.pelham_tee_member_lookup(text) to anon, authenticated;
grant execute on function public.pelham_tee_book_member(jsonb, uuid) to anon, authenticated;

notify pgrst, 'reload schema';
