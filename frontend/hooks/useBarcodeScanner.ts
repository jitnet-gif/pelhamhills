"use client";

/**
 * 프로 샵 카운터의 Zebra DS2208 스캐너 입력을 받는다.
 *
 * DS2208 은 결제 단말이 아니라 **USB 키보드(HID)** 다. 바코드를 읽으면 그 글자를 키보드처럼
 * 아주 빠르게 쳐 넣는다. 끝에 Enter 를 붙이는지는 스캐너 설정에 달렸다(아래 규칙이 둘 다 받는다). 그래서 드라이버도 SDK 도 없이
 * `keydown` 만으로 받는다 — 사람의 타이핑과 구분하는 기준은 **키 사이 간격** 하나다.
 * 스캐너는 글자 사이가 수 ms, 사람은 빨라도 80ms 안팎이다.
 *
 * 규칙
 * - 입력칸(input/textarea/select/contenteditable)에 포커스가 있으면 **손대지 않는다.**
 *   상품 등록의 SKU 칸처럼, 거기서 쏜 스캔은 평소처럼 글자로 들어간다.
 *   예외는 `data-scan-target` 이 붙은 칸(계산대 검색칸)이다. 거기서도 스캔을 가로채
 *   `onScan` 으로 보내고 Enter 는 막는다 — 칸의 글자는 받은 쪽이 비운다.
 *   IME 가 한글이면 그 칸에 자모가 찍히기 때문에, 칸의 값이 아니라 여기서 모은 글자를 믿는다.
 * - 끝은 Enter **또는** 짧은 공백으로 판정한다. 스캐너의 Enter 접미사가 꺼져 있어도 읽힌다.
 * - 한국어 IME 가 켜져 있으면 `key` 가 "Process" 로 온다. 그래서 글자는 `event.code`
 *   (물리 키 위치)에서 되살린다 — 카운터 PC 의 입력기가 한글이어도 스캔이 깨지지 않는다.
 *
 * 한 화면에 한 번만 건다. 같은 페이지에 두 개를 걸면 스캔 한 번이 두 번 처리된다.
 */

import { useEffect, useRef } from "react";

type Options = {
  /** false 면 듣지 않는다. 숨겨 둔 탭(리테일의 Products/Sales)에서 끄는 용도. */
  enabled?: boolean;
  /** 이 길이보다 짧은 연타는 스캔으로 보지 않는다. */
  minLength?: number;
  /** 키 사이가 이보다 길면 사람의 타이핑으로 보고 버퍼를 비운다(ms). */
  maxGapMs?: number;
  /**
   * 모든 입력칸에서도 스캔을 가로챈다. 상품 등록 창처럼 "어느 칸에 커서가 있든 스캔은 바코드"
   * 인 화면용. 이미 칸에 찍힌 글자는 받는 쪽이 지운다.
   */
  everywhere?: boolean;
};

/** 스캐너는 수 ms 간격으로 친다. 50ms 면 사람의 연타와 겹치지 않을 만큼 넉넉하다. */
const DEFAULT_MAX_GAP_MS = 50;
const DEFAULT_MIN_LENGTH = 4;

const SHIFTED_DIGITS = ")!@#$%^&*(";
const PUNCTUATION: Record<string, [string, string]> = {
  Minus: ["-", "_"],
  Equal: ["=", "+"],
  Period: [".", ">"],
  Comma: [",", "<"],
  Slash: ["/", "?"],
  Semicolon: [";", ":"],
  Quote: ["'", '"'],
  BracketLeft: ["[", "{"],
  BracketRight: ["]", "}"],
  Backslash: ["\\", "|"],
  Space: [" ", " "],
  NumpadSubtract: ["-", "-"],
  NumpadAdd: ["+", "+"],
  NumpadDecimal: [".", "."],
  NumpadDivide: ["/", "/"],
  NumpadMultiply: ["*", "*"],
};

/**
 * 키 하나를 글자 하나로. 보통은 `key` 를 믿고, IME 가 가로챈 경우("Process", 229)나
 * 한글 자모가 온 경우에만 물리 키(`code`)로 US 배열 글자를 되살린다.
 */
export function charFromKey(event: Pick<KeyboardEvent, "key" | "code" | "shiftKey">): string | null {
  const { key, code, shiftKey } = event;
  if (key.length === 1 && /[\x20-\x7e]/.test(key)) return key;

  if (/^Key[A-Z]$/.test(code)) {
    const letter = code.slice(3);
    return shiftKey ? letter : letter.toLowerCase();
  }
  if (/^Digit[0-9]$/.test(code)) {
    const digit = Number(code.slice(5));
    return shiftKey ? SHIFTED_DIGITS[digit] : String(digit);
  }
  if (/^Numpad[0-9]$/.test(code)) return code.slice(6);
  const punct = PUNCTUATION[code];
  if (punct) return shiftKey ? punct[1] : punct[0];
  return null;
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.closest("[data-scan-target]")) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

export function useBarcodeScanner(onScan: (code: string) => void, options: Options = {}): void {
  const {
    enabled = true,
    minLength = DEFAULT_MIN_LENGTH,
    maxGapMs = DEFAULT_MAX_GAP_MS,
    everywhere = false,
  } = options;

  // 콜백은 렌더마다 바뀐다. 리스너를 다시 걸면 스캔 도중에 버퍼가 날아가므로 ref 로 든다.
  const onScanRef = useRef(onScan);
  useEffect(() => {
    onScanRef.current = onScan;
  }, [onScan]);

  useEffect(() => {
    if (!enabled) return;

    let buffer = "";
    let lastAt = 0;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;

    const clearIdle = () => {
      if (idleTimer !== null) clearTimeout(idleTimer);
      idleTimer = null;
    };

    const flush = (): boolean => {
      clearIdle();
      const code = buffer.trim();
      buffer = "";
      if (code.length < minLength) return false;
      onScanRef.current(code);
      return true;
    };

    const onKeyDown = (event: KeyboardEvent) => {
      // 면허증 바코드(`@` 로 시작, `lib/pos/idCard.ts`)는 여러 줄이다. 스캐너는 줄바꿈·구분 문자를
      // Enter 나 Ctrl+글자로 보내므로, 그 스캔 도중에는 둘 다 끝이 아니라 줄바꿈으로 모은다.
      // 끝은 입력이 멈추는 것으로 본다. Ctrl+J(다운로드) 같은 브라우저 단축키가 열리지 않게 막는다.
      const licence = buffer.startsWith("@") && (event.timeStamp || performance.now()) - lastAt <= maxGapMs;
      const isEnter = event.key === "Enter" || event.code === "Enter" || event.code === "NumpadEnter";
      if (licence && (isEnter || event.ctrlKey)) {
        event.preventDefault();
        lastAt = event.timeStamp || performance.now();
        if (!buffer.endsWith("\n")) buffer += "\n";
        clearIdle();
        idleTimer = setTimeout(flush, maxGapMs * 2);
        return;
      }

      if (event.ctrlKey || event.altKey || event.metaKey) return;
      if (!everywhere && isEditable(event.target)) {
        buffer = "";
        clearIdle();
        return;
      }

      const now = event.timeStamp || performance.now();
      const gap = now - lastAt;
      lastAt = now;

      if (isEnter) {
        // 스캔이 끝났다. 포커스된 버튼이 Enter 로 눌리지 않게 막는다.
        if (buffer && gap <= maxGapMs && flush()) event.preventDefault();
        else buffer = "";
        return;
      }

      const char = charFromKey(event);
      if (char === null) return;

      // 간격이 길면 여기서부터 새로 센다. 사람의 한 글자는 다음 스캔의 첫 글자가 될 수 없다.
      if (gap > maxGapMs) buffer = "";
      buffer += char;

      // Enter 접미사가 없는 설정: 입력이 멈추면 끝난 것으로 본다.
      clearIdle();
      idleTimer = setTimeout(flush, maxGapMs * 2);
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      clearIdle();
    };
  }, [enabled, everywhere, maxGapMs, minLength]);
}
