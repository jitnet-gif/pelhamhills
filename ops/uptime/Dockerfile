# 시스템 멈춤 감시 앱. 표준 라이브러리만 쓴다. 빌드 컨텍스트는 이 폴더(ops/uptime).
FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 UPTIME_STATE=/tmp/uptime/state.json
WORKDIR /app
COPY uptime_watch.py .
CMD ["python", "uptime_watch.py", "--loop", "120"]
