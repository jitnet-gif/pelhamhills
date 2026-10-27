-- AI Manager — **Hope 기록 비우기**. 지금까지 쌓인 Hope reports 를 한 번 모두 지운다.
--
-- 왜(2026-10-26): 사용자 요청 "ai manager 의 hope 의 hope 보고기록 삭제해줘". 0119 의 표는 트리거로
-- 지우지 못하게 막혀 있으므로, 이 파일 안에서만 트리거를 잠깐 끄고 지운 뒤 다시 켠다. 앞으로 쌓이는 기록은
-- 0119 그대로 지우지도 고치지도 못한다.
--
-- 전제: 0119. 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행하면 그때까지의 기록을 또 지운다.

begin;

alter table public.pelham_ai_manager_log disable trigger pelham_ai_manager_log_keep;
delete from public.pelham_ai_manager_log;
alter table public.pelham_ai_manager_log enable trigger pelham_ai_manager_log_keep;

commit;
