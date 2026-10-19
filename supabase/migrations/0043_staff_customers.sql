-- 고객 명부(`/admin/customers`). 0001 의 `pelham_customers` 를 직원 화면에서 읽는다.
--
-- 그 표는 RLS 에 정책이 없어 지금까지 service_role(FastAPI)만 읽었다. 프로 샵 화면은 정적 사이트라
-- 0040 의 회원권 명부처럼 직원 함수 하나로 연다 — 표는 여전히 직접 읽을 수 없다.
--
-- 고객마다 가장 최근 시즌 회원권(취소 제외)을 함께 싣는다. 회원권 줄은 본인 `customer_ref` 로 잇는다.
--
-- 전제: 0001, 0004, 0040. 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다.

create or replace function public.pelham_staff_customers()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.pelham_require_staff();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'customer_ref', c.customer_ref,
             'name', coalesce(nullif(btrim(c.display_name), ''), btrim(concat_ws(' ', c.first_name, c.last_name))),
             'phone', c.phone,
             'email', c.email,
             'address', concat_ws(', ', nullif(c.address_line1, ''), nullif(c.city, '')),
             'postal_code', c.postal_code,
             'is_member', c.is_member,
             'player_type', c.player_type,
             'member_number', c.member_number,
             'scoring_factor', c.scoring_factor,
             'activation_state', c.activation_state,
             'has_credit_card', c.has_credit_card,
             'rounds', c.rounds_booked_played,
             'user_created_on', c.user_created_on,
             'needs_review', c.needs_review,
             'review_reasons', c.review_reasons,
             'possible_duplicate_of', c.possible_duplicate_of,
             'membership', (
               select jsonb_build_object('season', m.season, 'membership_type', m.membership_type,
                                         'plan', m.plan, 'status', m.status)
                 from public.pelham_memberships m
                where m.customer_ref = c.customer_ref and m.status <> 'cancelled'
                order by m.season desc
                limit 1
             )
           ) order by c.rounds_booked_played desc, lower(c.last_name), lower(c.first_name))
      from public.pelham_customers c
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.pelham_staff_customers() from public, anon, authenticated;
grant execute on function public.pelham_staff_customers() to authenticated;

notify pgrst, 'reload schema';
