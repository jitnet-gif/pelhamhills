-- AI Manager 프레젠테이션 나레이션 mp3 보관 — 비공개 버킷 `ai-narration`.
--
-- 왜(2026-10-26): 사용자 요청 "나레이션은 mp3로 다운 받아놔줘 매번 일레븐 랩스 호출하지 말고". 지금까지는
-- Fly 서버 메모리에만 두어서 재시작·배포 때마다 ElevenLabs 를 다시 불렀다. 이제 처음 만든 mp3 를
-- 이 버킷(파일 이름 = 글·톤·속도의 sha256)에 넣고, 다음부터는 여기서 꺼낸다(`backend/api/routes/ai_marketing.py`).
--
-- 비공개: 정책을 두지 않는다 — 서버(service role)만 읽고 쓴다. 화면은 지금처럼 `/ai-marketing/narrate` 로 받는다.
--
-- 실행: SQL editor 에 이 파일 전체를 붙여 한 번. 다시 실행해도 안전하다.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('ai-narration', 'ai-narration', false, 10485760, array['audio/mpeg'])
on conflict (id) do nothing;
