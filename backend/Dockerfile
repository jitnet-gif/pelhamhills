# 예약 API 이미지. 빌드 컨텍스트는 **저장소 루트**다 (앱이 `backend.main:app`
# 이라, `backend/` 가 패키지로 보이는 자리에서 임포트해야 한다).
#
#   docker build -t pelhamhills-api -f backend/Dockerfile .
#
# 무엇이 이미지에 들어가는지는 루트의 `.dockerignore` 가 정한다. 특히
# `backend/data/` (고객 정보가 든 백업·CSV)는 절대 들어가면 안 된다.
#
# 파이썬 3.12 를 쓴다. 개발 머신은 3.14 지만 여기 고정된 fastapi 0.109 /
# pydantic 2.6 은 3.14 보다 앞선 세대라 휠이 없을 수 있다.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

# 의존성을 먼저 깔아 레이어를 캐시한다. 코드만 바뀌면 pip 는 다시 돌지 않는다.
COPY backend/requirements-api.txt ./backend/requirements-api.txt
RUN pip install --no-cache-dir -r backend/requirements-api.txt

COPY backend/ ./backend/
# 에이전트 동기화 스크립트(.dockerignore 참고). 서버는 쓰지 않는다.
COPY scripts/attach_voice_tools.py scripts/elevenlabs_sync_agent.py ./scripts/
COPY ops/elevenlabs/agent.json ./ops/elevenlabs/agent.json

# 윈도우에서 편집된 스크립트가 CRLF 로 들어오면 `exec: sh\r: not found` 로 죽는다.
# 한 줄로 막아 둔다 - .gitattributes 설정에 기대지 않기 위해서다.
RUN sed -i 's/\r$//' /app/backend/docker-entrypoint.sh \
    && chmod +x /app/backend/docker-entrypoint.sh

EXPOSE 8080

ENTRYPOINT ["/app/backend/docker-entrypoint.sh"]
CMD ["uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8080"]
