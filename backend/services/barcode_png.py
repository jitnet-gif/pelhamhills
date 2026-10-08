"""예약 확정 문자에 붙이는 바코드 그림 (Code 128, PNG).

음성이든 문자든 예약이 확정되면 확인 문자를 MMS 로 보내고 이 그림을 붙인다
(`voice.confirm_booking`, `voice_sim.book_sim_bay`, 대기자 YES 답장). 프로 샵은
체크인 때 손님 휴대폰 화면을 스캐너로 읽으면 확인 번호가 그대로 입력된다.

그림에는 확인 번호 말고는 아무것도 없다 — 이름·시간·전화번호를 담지 않으므로
주소만 알면 누구나 열 수 있어도 새는 것이 없다. 막대 패턴은 python-barcode 가
만들고, PNG 는 여기서 직접 쓴다 (Pillow 를 이미지에 넣지 않으려고).
"""

from __future__ import annotations

import re
import struct
import zlib

import barcode

from backend.services.twilio_sms import public_api_base

#: 바코드로 만들어 주는 코드 꼴. 티타임 6자리, 시뮬레이터 10자리 숫자 확인 번호.
BARCODE_CODE_RE = re.compile(r"\d{6}|\d{10}")

MODULE_PX = 4  # 막대 한 칸의 폭. 휴대폰 화면에서 스캐너가 읽기 넉넉한 굵기.
HEIGHT_PX = 160
QUIET_MODULES = 12  # 양옆 여백. Code 128 은 최소 10칸을 요구한다.


def _chunk(kind: bytes, data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))


def code128_png(code: str) -> bytes:
    """`code` 를 Code 128 로 그린 흑백 PNG."""
    modules = "0" * QUIET_MODULES + barcode.get("code128", code).build()[0] + "0" * QUIET_MODULES
    width = len(modules) * MODULE_PX
    # 1비트 회색조: 1 = 흰색, 0 = 검정. 막대('1')가 검정이므로 뒤집어 넣는다.
    bits = "".join(("0" if m == "1" else "1") * MODULE_PX for m in modules)
    bits += "1" * (-len(bits) % 8)
    row = b"\x00" + int(bits, 2).to_bytes(len(bits) // 8, "big")  # 앞의 0 은 필터 없음
    header = struct.pack(">IIBBBBB", width, HEIGHT_PX, 1, 0, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + _chunk(b"IHDR", header)
        + _chunk(b"IDAT", zlib.compress(row * HEIGHT_PX, 9))
        + _chunk(b"IEND", b"")
    )


def barcode_url(code: str) -> str | None:
    """Twilio 가 받아 갈 바코드 주소. 공개 https 주소가 없으면(로컬 개발) None.

    Twilio 는 MediaUrl 을 직접 내려받으므로 localhost 를 주면 문자 자체가 실패한다.
    그럴 바에는 그림 없이 글만 보내는 편이 낫다.
    """
    base = public_api_base()
    if not BARCODE_CODE_RE.fullmatch(code) or not base.startswith("https://"):
        return None
    return f"{base}/sms/barcode/{code}.png"
