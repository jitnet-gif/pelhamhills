import asyncio
import sys
import os
import logging
from importlib import import_module
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware

# 로깅 설정 (INFO 레벨 이상의 로그를 터미널로 출력)
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    stream=sys.stdout
)
logger = logging.getLogger(__name__)

# 프로젝트 내 모듈 임포트
from backend.core.config import settings

app = FastAPI(
    title=settings.PROJECT_NAME,
    description="BEPU AI Assistant Backend API",
    version="1.0.0",
)

# CORS Middleware 설정 (프론트엔드 URL 접근 허용)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.BACKEND_CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

def include_route_module(module_name: str, prefix: str, tags: list[str]) -> None:
    try:
        module = import_module(module_name)
        app.include_router(module.router, prefix=prefix, tags=tags)
    except Exception as exc:
        logger.error("라우터 등록 실패: %s (%s)", module_name, exc)


# ===== 공개 표면 =======================================================
#
# `PUBLIC_SURFACE=voice` 면 **음성 에이전트와 Twilio 웹훅만** 연다. 공개 배포가
# 이 값을 쓴다 (`fly.toml`).
#
# 왜: `/tee-sheet/*` 에는 인증이 없다. 관리자 화면이 브라우저에서 직접 부르던
# 구조였기 때문인데, 2026-09 에 그 화면들이 전부 Supabase 로 옮겨갔다
# (`supabase/migrations/0004_staff_tee_sheet.sql` — 직원 함수 11개, 함수마다 직원
# 확인). 지금 `frontend/lib/teeSheet/api.ts` 는 FastAPI 를 **한 번도** 부르지 않고
# 전부 RPC 로 간다. 그래서 공개 서버가 이 경로를 열어 둘 이유가 더는 없고, 열어 두면
# 실제 고객 이름과 전화번호가 주소만 알면 읽힌다.
#
# 이식되지 않은 것이 음성 에이전트다. 그것이 이 서버가 공개로 떠 있어야 하는
# 유일한 이유이므로, 공개 표면도 거기까지만 둔다.
#
# 로컬 개발은 기본값(`all`)이라 예전처럼 전부 뜬다.
PUBLIC_SURFACE = os.getenv("PUBLIC_SURFACE", "all").strip().lower()
VOICE_ONLY = PUBLIC_SURFACE == "voice"

# 공개 배포에서도 여는 것: 에이전트 도구와 Twilio 가 직접 부르는 경로.
include_route_module("backend.api.routes.voice", f"{settings.API_V1_STR}", ["Voice Booking"])
include_route_module("backend.api.routes.voice_sim", f"{settings.API_V1_STR}", ["Voice Booking"])
include_route_module("backend.api.routes.sms", f"{settings.API_V1_STR}", ["SMS (Twilio)"])
# 손님 온라인 결제(Stripe Checkout). 예약 사이트는 정적 export 라 카드사 키를 둘 곳이 이 서버뿐이다.
# 본인 확인(확인 코드 + 이메일)과 금액은 SQL 함수(0020·0021, service_role 전용)가 정한다.
include_route_module("backend.api.routes.payments", f"{settings.API_V1_STR}", ["Online Payments"])
# 계산대 카드 단말기(Stripe Terminal)와 Stripe 웹훅. 직원 확인은 요청의 Supabase 토큰으로 SQL 이 한다
# (`pelham_staff_terminal_*`, 0021) — 그래서 공개 배포에서도 연다.
include_route_module("backend.api.routes.terminal", f"{settings.API_V1_STR}", ["Card Terminal"])

if VOICE_ONLY:
    logger.warning(
        "PUBLIC_SURFACE=voice — 음성/SMS 만 연다. 티 시트·리테일·시뮬레이터 라우터는 "
        "등록하지 않는다 (인증이 없어 공개하면 고객 개인정보가 노출된다)."
    )
else:
    include_route_module("backend.api.routes.tee_sheet", f"{settings.API_V1_STR}", ["Tee Sheet"])
    include_route_module("backend.api.routes.chat", f"{settings.API_V1_STR}/chat", ["Chat"])
    include_route_module("backend.api.routes.agents", f"{settings.API_V1_STR}/agents", ["Agents"])
    include_route_module("backend.api.routes.onboarding", f"{settings.API_V1_STR}/onboarding", ["Onboarding"])
    include_route_module("backend.api.routes.simulator", f"{settings.API_V1_STR}", ["Simulator"])
    include_route_module("backend.api.routes.retail", f"{settings.API_V1_STR}", ["Retail"])
    include_route_module("backend.api.routes.simulator_admin", f"{settings.API_V1_STR}", ["Simulator Admin"])


async def _reminder_loop() -> None:
    """1분마다 티타임 리마인더 문자를 보내고 (`routes/sms.py` 의 `run_reminders`),
    빈자리를 대기자에게 걸고 (`services/waitlist_offers.py`),
    찾은 분실물을 손님에게 알린다 (`services/lost_item_notices.py`)."""
    from backend.api.routes.sms import run_reminders
    from backend.services import lost_item_notices, waitlist_offers

    while True:
        try:
            await run_reminders()
        except Exception as exc:
            logger.error("리마인더 작업 실패: %s", exc)
        await waitlist_offers.run()  # 오류는 안에서 삼킨다
        await lost_item_notices.run()  # 마찬가지
        await asyncio.sleep(60)


@app.on_event("startup")
async def start_reminder_loop() -> None:
    # Twilio 키가 없으면 돌리지 않는다. 보내지도 못할 문자 때문에 1분마다 티 시트를
    # 읽고 감사 로그에 "보냈다" 고 적으면 나중에 키를 넣었을 때 리마인더가 빠진다.
    if settings.TWILIO_ENABLED:
        app.state.reminder_loop = asyncio.create_task(_reminder_loop())

@app.get("/")
def read_root():
    """서버 헬스 체크 엔드포인트"""
    return {
        "status": "online",
        "service": settings.PROJECT_NAME,
        "message": "BEPU Backend is running smoothly 🐰"
    }

if __name__ == "__main__":
    import uvicorn
    # 로컬 테스트용 직접 실행 설정
    # 실행 예시: python backend/main.py
    uvicorn.run("backend.main:app", host="0.0.0.0", port=8000, reload=True)
