-- 2026-10-24 낮에 한 마감을 Shift 1(morning)으로 옮긴다.
--
-- 왜(2026-10-24): Dustin Lariviere 가 07:28–13:17 근무를 13:23 에 마감했는데, 그때는 0092 전이라 근무 칸이 없었고
-- 0092 가 옛 마감을 전부 'dinner' 로 채웠다. 그래서 화면에 Shift 1 은 안 닫힌 것으로, Shift 2 는 Dustin 이 닫은 것으로
-- 나왔다. 이날 오후 4시 전에 끝난 'dinner' 마감을, 같은 서랍에 morning 마감이 없을 때만 'morning' 으로 바꾼다.
-- 그 뒤 Shift 2 는 13:17 이후 판매를 새로 센다.
--
-- 전제: 0092. 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다.

update public.pelham_register_closes c
   set shift = 'morning'
 where c.business_date = date '2026-10-24'
   and c.shift = 'dinner'
   and c.shift_end is not null
   and c.shift_end < time '16:00'
   and not exists (select 1 from public.pelham_register_closes m
                    where m.business_date = c.business_date
                      and m.station = c.station
                      and m.shift = 'morning');

select business_date, station, shift, cashier, shift_start, shift_end
  from public.pelham_register_closes
 where business_date = date '2026-10-24'
 order by station, shift;
