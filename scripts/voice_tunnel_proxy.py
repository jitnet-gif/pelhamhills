"""ElevenLabs 가 부를 엔드포인트만 공개로 내보내는 좁은 프록시.

왜 필요한가
-----------
에이전트의 도구는 HTTPS 웹훅이라 백엔드가 공개 주소에 있어야 한다. 그런데 백엔드를
터널에 통째로 걸면 `/api/v1/tee-sheet/*` 와 `/api/v1/customers*` 까지 같이 열린다.
그쪽은 인증이 없고, 지금 저장소는 `TEE_SHEET_BACKEND=supabase` 라 **실제 고객의
예약과 연락처**가 인터넷에 그대로 노출된다. 터널 주소가 길고 임의라는 것은 보호가
아니다.

그래서 이 프록시는 **아래 목록에 있는 경로만** 뒤로 넘기고 나머지는 전부 404 를
돌려준다. 404 로 돌려주는 이유는, 403 이면 "거기 뭔가 있다"는 사실을 알려주기 때문이다.

도구 호출 자체의 인증은 백엔드의 `VOICE_TOOL_SECRET` 이 한다. 이 프록시는 그 헤더를
그대로 전달할 뿐 검사하지 않는다 — 검사가 두 곳에 있으면 한쪽만 고치는 사고가 난다.

쓰는 법
-------
    python scripts/voice_tunnel_proxy.py            # 8099 에서 127.0.0.1:8000 으로 전달
    cloudflared tunnel --url http://localhost:8099  # 이 주소를 공개로

환경변수: VOICE_PROXY_PORT (기본 8099), VOICE_PROXY_TARGET (기본 http://127.0.0.1:8000)
"""
from __future__ import annotations

import os
import sys
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TARGET = os.environ.get("VOICE_PROXY_TARGET", "http://127.0.0.1:8000").rstrip("/")
PORT = int(os.environ.get("VOICE_PROXY_PORT", "8099"))

#: 공개로 내보낼 경로. `ops/elevenlabs/agent.json` 의 도구 6개 + post-call 웹훅.
#: `/voice/session` 은 **일부러 뺐다** — 브라우저 위젯용이고, 호출 한 번이 ElevenLabs
#: 대화 크레딧을 태우는 티켓을 만든다. 전화 통화에는 필요 없다.
ALLOW = {
    "/api/v1/voice/tools/identify-caller",
    "/api/v1/voice/tools/send-info-sms",
    "/api/v1/voice/tools/report-lost-item",
    "/api/v1/voice/tools/request-callback",
    "/api/v1/voice/tools/join-waitlist",
    "/api/v1/voice/tools/get-rates",
    "/api/v1/voice/tools/modify-booking",
    "/api/v1/voice/tools/find-tee-times",
    "/api/v1/voice/tools/hold-tee-time",
    "/api/v1/voice/tools/release-hold",
    "/api/v1/voice/tools/confirm-booking",
    "/api/v1/voice/tools/lookup-booking",
    "/api/v1/voice/tools/cancel-booking",
    # 실내 골프 (`backend/api/routes/voice_sim.py`)
    "/api/v1/voice/tools/find-sim-times",
    "/api/v1/voice/tools/book-sim-bay",
    "/api/v1/voice/tools/lookup-sim-booking",
    "/api/v1/voice/tools/cancel-sim-booking",
}

# post-call 웹훅은 `VOICE_TOOL_SECRET` 이 아니라 ElevenLabs 의 HMAC 서명으로 검증한다.
# 그런데 `_verify_webhook` 은 `ELEVENLABS_WEBHOOK_SECRET` 이 비면 검증을 건너뛴다.
# 그 상태로 공개하면 통화 세션의 conversation_id 를 아는 사람이 남의 예약 감사 로그에
# 가짜 메모를 붙일 수 있다 (예약을 만들거나 지우지는 못한다 — 이 프로세스의 활성
# 세션에서 이미 확인된 예약에만 쓴다). 시크릿이 생기면 그때 열린다.
if os.environ.get("ELEVENLABS_WEBHOOK_SECRET", "").strip():
    ALLOW.add("/api/v1/voice/post-call")

#: 뒤로 넘길 헤더. 그 밖의 것(쿠키, 호스트 등)은 넘기지 않는다.
FORWARD = ("content-type", "x-voice-tool-secret", "elevenlabs-signature", "user-agent")

MAX_BODY = 256 * 1024


class Handler(BaseHTTPRequestHandler):
    server_version = "pelham-voice-proxy"

    def _deny(self) -> None:
        self.send_response(404)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"detail":"Not Found"}')

    def do_GET(self) -> None:  # noqa: N802
        # 살아 있는지 확인용. 어떤 경로를 여는지는 알려주지 않는다.
        if self.path == "/healthz":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"ok":true}')
            return
        self._deny()

    def do_POST(self) -> None:  # noqa: N802
        path = self.path.split("?", 1)[0]
        if path not in ALLOW:
            self.log_message("차단 %s", path)
            self._deny()
            return

        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY:
            self.send_response(413)
            self.end_headers()
            return
        body = self.rfile.read(length) if length else b""

        headers = {k: v for k, v in ((h, self.headers.get(h)) for h in FORWARD) if v}
        req = urllib.request.Request(TARGET + self.path, data=body, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=30) as res:
                payload, status, ctype = res.read(), res.status, res.headers.get("Content-Type", "application/json")
        except urllib.error.HTTPError as e:
            payload, status, ctype = e.read(), e.code, e.headers.get("Content-Type", "application/json")
        except Exception as e:  # 백엔드가 꺼져 있는 경우
            self.log_message("백엔드 연결 실패: %s", e)
            self.send_response(502)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"detail":"backend unreachable"}')
            return

        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, fmt: str, *args) -> None:
        # 본문은 절대 찍지 않는다 — 고객 이름과 전화번호가 들어 있다.
        sys.stderr.write(f"[proxy] {fmt % args}\n")


if __name__ == "__main__":
    print(f"[proxy] {PORT} -> {TARGET} · 공개 경로 {len(ALLOW)}개, 나머지는 404")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
