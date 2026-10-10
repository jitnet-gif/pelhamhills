import os
import sys
from typing import Optional

# 프로젝트 최상단 디렉토리(AI-SERVIO)를 Python 경로에 추가
# 이 파일이 backend/core/config.py 에 위치함을 전제
sys.path.append(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
from dotenv import load_dotenv
from pydantic_settings import BaseSettings, SettingsConfigDict

# .env 파일 위치 찾기 (현재 파일에서 위로 올라가며 .env를 찾음)
def find_env_file():
    current = os.path.abspath(__file__)
    for _ in range(5): # 최대 5단계 위까지 검색
        current = os.path.dirname(current)
        potential = os.path.join(current, ".env")
        if os.path.exists(potential):
            return potential
    return None

env_path = find_env_file()
sys.stderr.write(f"🔍 [DEBUG] Resolved .env path: {env_path}\n")

if env_path:
    load_dotenv(env_path, override=True)
    sys.stderr.write(f"✅ [DEBUG] load_dotenv called with override=True\n")
else:
    sys.stderr.write(f"❌ [DEBUG] .env file NOT FOUND in ancestors!\n")

class Settings(BaseSettings):
    # (나머지 코드는 동일하게 유지)
    PROJECT_NAME: str = "BEPU API"
    API_V1_STR: str = "/api/v1"
    
    # Supabase (DB & Auth)
    NEXT_PUBLIC_SUPABASE_URL: str = ""
    SUPABASE_SERVICE_ROLE_KEY: str = ""
    SUPABASE_JWT_SECRET: str = ""
    
    # AI (Claude API)
    ANTHROPIC_API_KEY: str = ""
    CLAUDE_SONNET_MODEL: str = "claude-3-7-sonnet-20250219"
    CLAUDE_HAIKU_MODEL: str = "claude-3-5-haiku-20241022"
    
    # 임베딩 & 폴백 (OpenAI)
    OPENAI_API_KEY: str = ""
    OPENAI_API_KEYS: Optional[str] = None # 키가 여러개일 경우 (key1,key2,...)
    OPENAI_MODEL_MAIN: str = "gpt-4o"
    OPENAI_MODEL_FAST: str = "gpt-4o-mini"
    OPENAI_EMBEDDING_MODEL: str = "text-embedding-3-small"

    # Google Gemini 모델 설정 (쉼표로 구분된 다중 키 지원)
    GOOGLE_API_KEY: str = ""  
    GEMINI_API_KEYS: Optional[str] = None # 키가 여러개일 경우 (key1,key2,...)
    GEMINI_MODEL_MAIN: str = "gemini-1.5-flash"
    GEMINI_MODEL_FAST: str = "gemini-1.5-flash"

    # Groq & Mistral (신규)
    GROQ_API_KEY: str = ""
    MISTRAL_API_KEY: str = ""
    GROQ_MODEL_MAIN: str = "llama-3.3-70b-versatile"
    GROQ_MODEL_FAST: str = "llama-3.1-8b-instant"
    
    # Perplexity & Copilot (신규)
    PERPLEXITY_API_KEY: str = ""
    COPILOT_API_KEY: str = "" # GitHub 또는 Azure Copilot 용

    # localhost 와 127.0.0.1 은 브라우저가 서로 다른 오리진으로 취급하므로 둘 다 허용한다.
    # 5173/4173 은 golf-gps-app 의 Vite 개발/미리보기 서버다. GPS 앱의 티타임
    # 예약 화면(/book)이 이 백엔드의 /tee-sheet/* 를 직접 부르므로, 없으면
    # 브라우저가 CORS 로 막고 화면에는 "예약 서버에 닿지 못했다"만 남는다.
    ALLOWED_ORIGINS: str = (
        "http://localhost:3000,http://127.0.0.1:3000,"
        "http://localhost:5173,http://127.0.0.1:5173,"
        "http://localhost:4173,http://127.0.0.1:4173,"
        # 배포된 사이트. Vercel 프로젝트 golf-gps-pelhamhills(GPS 앱)와
        # pelhamhills(팀 pelhamhills, 운영 주소 pelhamhills-golf.vercel.app). pelhamhills.vercel.app 은
        # 다른 계정의 옛 배포가 붙들고 있다(2026-10-10) — 지우지 않고 남겨 둔다. 모두 이 백엔드의 /tee-sheet/* 를
        # 브라우저에서 직접 부른다. 프리뷰 배포는 매번 주소가 달라 여기 못 넣는다 —
        # 프리뷰에서 예약을 시험하려면 그 주소를 ALLOWED_ORIGINS 에 임시로 넣는다.
        "https://golf-gps-pelhamhills.vercel.app,"
        "https://golf-gps-pelhamhills-seven.vercel.app,"
        "https://pelhamhills-golf.vercel.app,"
        "https://pelhamhills.vercel.app,"
        "https://bepu.app"
    )

    # 프로 샵 대표 번호. 문자 답장으로 해결되지 않는 일은 이 번호로 안내한다.
    PROSHOP_PHONE_NUMBER: str = "+12498050556"

    # ElevenLabs 설정은 여기 없다 — `backend/api/routes/voice.py` 와
    # `backend/services/voice_agent.py` 가 환경변수를 직접 읽는다 (docs/VOICE_BOOKING.md).

    # Twilio 통화·문자
    TWILIO_ACCOUNT_SID: str = ""
    TWILIO_AUTH_TOKEN: str = ""
    TWILIO_PHONE_NUMBER: str = ""
    TWILIO_MESSAGING_SERVICE_SID: str = ""  # 있으면 From 대신 사용

    @property
    def TWILIO_ENABLED(self) -> bool:
        return bool(self.TWILIO_ACCOUNT_SID and self.TWILIO_AUTH_TOKEN and (self.TWILIO_PHONE_NUMBER or self.TWILIO_MESSAGING_SERVICE_SID))

    @property
    def OPENAI_API_KEY_LIST(self) -> list[str]:
        if self.OPENAI_API_KEYS:
            return [k.strip() for k in self.OPENAI_API_KEYS.split(",") if k.strip()]
        return [self.OPENAI_API_KEY] if self.OPENAI_API_KEY else []

    @property
    def GOOGLE_API_KEY_LIST(self) -> list[str]:
        if self.GEMINI_API_KEYS:
            return [k.strip() for k in self.GEMINI_API_KEYS.split(",") if k.strip()]
        return [self.GOOGLE_API_KEY] if self.GOOGLE_API_KEY else []

    @property
    def ANTHROPIC_API_KEY_LIST(self) -> list[str]:
        # 향후 ANTHROPIC_API_KEYS 도 지원 가능하도록 확장성 확보
        return [self.ANTHROPIC_API_KEY] if self.ANTHROPIC_API_KEY else []

    @property
    def BACKEND_CORS_ORIGINS(self) -> list[str]:
        return [origin.strip() for origin in self.ALLOWED_ORIGINS.split(",")]

    model_config = SettingsConfigDict(
        env_file=os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), ".env"),
        env_ignore_empty=True,
        extra="ignore"
    )

settings = Settings()

# 🔍 디버그용 출력 (서버 터미널에서 확인 가능)
sys.stderr.write(f"--- [DEBUG] Final Settings Check ---\n")
if not settings.NEXT_PUBLIC_SUPABASE_URL:
    sys.stderr.write("⚠️ [WARNING] NEXT_PUBLIC_SUPABASE_URL is EMPTY!\n")
else:
    sys.stderr.write(f"✅ [SUCCESS] Supabase URL: {settings.NEXT_PUBLIC_SUPABASE_URL[:20]}...\n")

if not settings.ANTHROPIC_API_KEY:
    sys.stderr.write("⚠️ [WARNING] ANTHROPIC_API_KEY is EMPTY!\n")
else:
    sys.stderr.write(f"✅ [SUCCESS] Anthropic Key: {settings.ANTHROPIC_API_KEY[:10]}...\n")

if not settings.OPENAI_API_KEY:
    sys.stderr.write("⚠️ [WARNING] OPENAI_API_KEY is EMPTY!\n")
else:
    sys.stderr.write(f"✅ [SUCCESS] OpenAI Key: {settings.OPENAI_API_KEY[:15]}...\n")

if not settings.GOOGLE_API_KEY:
    sys.stderr.write("⚠️ [WARNING] GOOGLE_API_KEY is EMPTY!\n")
else:
    sys.stderr.write(f"✅ [SUCCESS] Gemini Key: {settings.GOOGLE_API_KEY[:10]}...\n")

if not settings.GROQ_API_KEY:
    sys.stderr.write("⚠️ [WARNING] GROQ_API_KEY is EMPTY!\n")
else:
    sys.stderr.write(f"✅ [SUCCESS] Groq Key: {settings.GROQ_API_KEY[:10]}...\n")



