"use client";

/**
 * "앱으로 설치" 상태. 계산대 첫 화면과 어드민 사이드바가 같이 쓴다.
 *
 * Chrome·Edge(맥·윈도우)는 설치 조건이 맞으면 `beforeinstallprompt` 를 **한 번** 쏜다.
 * 어드민은 로그인 문을 지난 뒤에야 사이드바를 그리므로, 컴포넌트 안에서 듣기 시작하면
 * 이미 지나간 뒤다. 그래서 이 모듈이 읽히는 순간부터 듣고 붙잡아 둔다.
 *
 * 아이패드·아이폰은 Chrome 이라도 WebKit 이라 이 이벤트가 없다 — 공유 → 홈 화면에 추가
 * 로 안내할 수밖에 없다.
 */

import { useSyncExternalStore } from "react";

/** Chrome·Edge 가 주는 설치 요청. 표준 타입에 아직 없다. */
type InstallPromptEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };

let captured: InstallPromptEvent | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    captured = event as InstallPromptEvent;
    notify();
  });
  window.addEventListener("appinstalled", () => {
    captured = null;
    notify();
  });
}

export type InstallState = {
  /** 판단이 끝났는가. 정적 export 의 프리렌더(서버)에서는 false — hydration 이 어긋나지 않는다. */
  ready: boolean;
  /** 이미 설치된 앱 창에서 열렸다. 안내를 띄우지 않는다. */
  standalone: boolean;
  /** 아이패드·아이폰(데스크톱 모드 아이패드 포함). */
  ios: boolean;
  /** 브라우저 설치 창을 띄운다. 이벤트가 없으면 null — 메뉴로 안내한다. */
  install: (() => void) | null;
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const noop = () => () => {};

/** 기기·창 모드는 한 번 정해지면 바뀌지 않는다 — 처음 읽은 값을 그대로 쓴다. */
let env: Omit<InstallState, "install"> | null = null;
const readEnv = () =>
  (env ??= {
    ready: true,
    standalone:
      window.matchMedia("(display-mode: standalone)").matches ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true,
    ios: /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1),
  });
const SERVER_ENV = { ready: false, standalone: false, ios: false };

export function useInstallPrompt(): InstallState {
  const prompt = useSyncExternalStore(subscribe, () => captured, () => null);
  const device = useSyncExternalStore(noop, readEnv, () => SERVER_ENV);

  return {
    ...device,
    install: prompt
      ? () => {
          void prompt.prompt();
          // 한 번 쓴 요청은 다시 못 쓴다. 거절해도 버리고 메뉴 안내로 돌아간다.
          void prompt.userChoice.finally(() => {
            captured = null;
            notify();
          });
        }
      : null,
  };
}
