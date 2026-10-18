"use client";

/**
 * 휴대폰·아이패드 카메라를 **마트 계산대 스캐너**처럼 쓴다. 켜 둔 채로 물건을 비추면
 * 읽을 때마다 `onCode` 가 불리고, 받는 쪽이 계산서에 담는다. 결제 버튼을 누를 때까지 닫히지 않는다.
 *
 * 왜 ZXing 인가: 브라우저 내장 `BarcodeDetector` 는 안드로이드 Chrome 에만 있고
 * 아이폰·아이패드 Safari 에는 없다. 카운터 밖의 실사용 기기가 아이패드라 라이브러리로 읽는다.
 * 무거워서(수백 KB) 이 화면이 열릴 때만 `import()` 로 부른다.
 *
 * 카메라는 1초에 수십 번 읽는다. 들고 있는 동안 같은 물건이 계속 담기지 않도록
 * **같은 코드는 한 번 담은 뒤 화면에서 사라졌다가 다시 보여야** 또 담는다(아래 `SAME_CODE_GAP_MS`).
 * 같은 물건 두 개는 하나 찍고, 치웠다가, 다시 비추면 된다.
 *
 * 카메라는 HTTPS(또는 localhost)에서만 켜진다. 배포 주소는 HTTPS 다.
 *
 * 전면/후면은 헤더의 ⇄ 버튼으로 바꾼다. 거치대에 세운 아이패드는 화면이 손님 쪽을 보므로
 * 전면 카메라에 물건을 대는 편이 편하다. 고른 쪽은 기기에 기억해 두고 다음에도 그쪽으로 연다.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";

export type ScanOutcome = { ok: boolean; message: string };

type Props = {
  /** 읽은 코드. 담았으면 ok, 모르는 코드면 ok:false 와 이유. */
  onCode: (code: string) => Promise<ScanOutcome>;
  /** "결제" — 카메라를 닫고 계산서 결제 칸으로. */
  onDone: () => void;
  /** 결제 없이 닫기. */
  onClose: () => void;
  /** 화면 아래 줄에 보일 계산서 요약(줄 수·합계). */
  summary: ReactNode;
  /** 결제 버튼을 누를 수 있는가(담긴 게 있는가). */
  canPay: boolean;
  /** 아래 버튼 글자. 계산대는 Pay, 상품 등록 창처럼 하나만 읽는 곳은 Cancel. */
  doneLabel?: string;
};

/**
 * 같은 코드가 이 시간 동안 **보이지 않아야** 다시 담는다. 카메라가 같은 바코드를
 * 계속 읽는 동안에는 시계가 갱신되므로, 들고만 있으면 절대 두 번 담기지 않는다.
 */
const SAME_CODE_GAP_MS = 1200;

/** 매장에서 붙는 1D 바코드 + 영수증의 Code 128 + QR. 형식을 좁히면 읽는 속도가 빨라진다. */
const FORMAT_NAMES = ["EAN_13", "EAN_8", "UPC_A", "UPC_E", "CODE_128", "CODE_39", "ITF", "QR_CODE"] as const;

type Flash = { ok: boolean; message: string; at: number };

/** environment = 후면, user = 전면(셀카). */
type Facing = "environment" | "user";

const FACING_KEY = "pelham.cameraScan.facing";

function readFacing(): Facing {
  try {
    return window.localStorage.getItem(FACING_KEY) === "user" ? "user" : "environment";
  } catch {
    return "environment";
  }
}

function currentDeviceId(video: HTMLVideoElement): string {
  const stream = video.srcObject instanceof MediaStream ? video.srcObject : null;
  return stream?.getVideoTracks()[0]?.getSettings().deviceId ?? "";
}

export default function CameraScanner({ onCode, onDone, onClose, summary, canPay, doneLabel = "Pay" }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [status, setStatus] = useState<"starting" | "live" | "error">("starting");
  const [problem, setProblem] = useState("");
  const [flash, setFlash] = useState<Flash | null>(null);
  const [facing, setFacing] = useState<Facing>(readFacing);
  /** 카메라가 둘 이상일 때만 전환 버튼을 보인다. 권한을 받기 전에는 개수를 알 수 없다. */
  const [cameraCount, setCameraCount] = useState(0);
  /** 지금 켜진 카메라. 전환했는데 같은 것이 다시 열렸는지 알아보는 데 쓴다. */
  const deviceIdRef = useRef("");

  function switchCamera() {
    const next: Facing = facing === "user" ? "environment" : "user";
    try {
      window.localStorage.setItem(FACING_KEY, next);
    } catch {
      // 기억 못 해도 지금 전환은 된다.
    }
    setStatus("starting");
    setFlash(null);
    setFacing(next);
  }

  // 콜백은 매 렌더 바뀐다. 카메라를 다시 켜지 않도록 ref 로 최신 것만 들고 있는다.
  const onCodeRef = useRef(onCode);
  useEffect(() => {
    onCodeRef.current = onCode;
  }, [onCode]);

  const audioRef = useRef<AudioContext | null>(null);

  /**
   * 아이폰은 사용자가 화면을 한 번 건드려야 소리를 허락한다. 스캔 모드를 연 버튼의 탭으로
   * 대개 충분하지만, 바로가기 주소로 바로 열린 경우를 위해 화면 어디든 누르면 다시 깨운다.
   */
  function unlockAudio() {
    try {
      if (!audioRef.current) {
        const Ctor =
          window.AudioContext ??
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (Ctor) audioRef.current = new Ctor();
      }
      void audioRef.current?.resume();
    } catch {
      // 소리가 안 나도 스캔은 된다.
    }
  }

  function beep(ok: boolean) {
    const ctx = audioRef.current;
    if (ctx && ctx.state === "running") {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = ok ? "sine" : "square";
      osc.frequency.value = ok ? 1760 : 220;
      gain.gain.value = 0.15;
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + (ok ? 0.09 : 0.35));
    }
    // 안드로이드만. 아이폰 Safari 에는 진동 API 가 없다.
    navigator.vibrate?.(ok ? 40 : [80, 60, 80]);
  }

  // 소리는 카메라를 바꿔도 이어 쓴다. 화면이 닫힐 때만 놓는다.
  useEffect(() => {
    unlockAudio();
    return () => {
      void audioRef.current?.close().catch(() => undefined);
      audioRef.current = null;
    };
    // 한 번만.
  }, []);

  useEffect(() => {
    let stopped = false;
    let controls: { stop: () => void } | null = null;
    let lastCode = "";
    let lastSeen = 0;
    let busy = false;

    async function start() {
      if (!navigator.mediaDevices?.getUserMedia) {
        setStatus("error");
        setProblem("This browser cannot open the camera. Use Safari or Chrome over https.");
        return;
      }
      try {
        const [{ BrowserMultiFormatReader }, { BarcodeFormat, DecodeHintType }] = await Promise.all([
          import("@zxing/browser"),
          import("@zxing/library"),
        ]);
        if (stopped) return;
        const hints = new Map();
        hints.set(
          DecodeHintType.POSSIBLE_FORMATS,
          FORMAT_NAMES.map((name) => BarcodeFormat[name]),
        );
        const reader = new BrowserMultiFormatReader(hints, {
          delayBetweenScanAttempts: 80,
          delayBetweenScanSuccess: 80,
        });
        const video = videoRef.current;
        if (!video) return;
        // 아이폰은 이 둘이 없으면 전체 화면 플레이어로 튀어나가거나 재생을 거부한다.
        video.muted = true;
        video.setAttribute("playsinline", "true");

        const constraints = (mode: "exact" | "ideal"): MediaStreamConstraints => ({
          audio: false,
          video: {
            facingMode: { [mode]: facing },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
        });
        const onResult: Parameters<typeof reader.decodeFromConstraints>[2] = (result) => {
          if (!result) return;
          const code = result.getText().trim();
          const now = Date.now();
          const repeat = code === lastCode && now - lastSeen < SAME_CODE_GAP_MS;
          lastSeen = now;
          if (repeat || busy || !code) return;
          lastCode = code;
          busy = true;
          void onCodeRef
            .current(code)
            .then((outcome) => {
              beep(outcome.ok);
              setFlash({ ...outcome, at: now });
            })
            .finally(() => {
              busy = false;
              // 담는 동안(서버 왕복) 계속 비추고 있었다면 그 시간도 "보이는 중" 으로 친다.
              lastSeen = Date.now();
            });
        };
        // `exact` 로 먼저 청한다. `ideal` 만 주면 일부 기기는 전면을 골라도 후면을 준다.
        // 그 방향 카메라가 아예 없는 기기(카메라 하나짜리 노트북 등)면 있는 것으로 연다.
        let started;
        try {
          started = await reader.decodeFromConstraints(constraints("exact"), video, onResult);
        } catch (cause) {
          const name = (cause as { name?: string })?.name ?? "";
          if (name !== "OverconstrainedError" && name !== "NotFoundError") throw cause;
          if (stopped) return;
          started = await reader.decodeFromConstraints(constraints("ideal"), video, onResult);
        }
        if (stopped) {
          started.stop();
          return;
        }
        controls = started;

        // 권한을 받은 뒤라야 장치 목록이 나온다.
        let cameras: MediaDeviceInfo[] = [];
        try {
          cameras = (await navigator.mediaDevices.enumerateDevices()).filter(
            (device) => device.kind === "videoinput",
          );
        } catch {
          // 목록을 못 읽으면 버튼을 숨긴 채로 둔다.
        }
        if (stopped) return;
        setCameraCount(cameras.length);

        // 전환했는데 같은 카메라가 다시 열렸다 — 방향 정보가 없는 카메라(노트북의 외장 웹캠 등)다.
        // 그때는 방향 대신 장치를 직접 골라 다른 카메라로 연다.
        const previous = deviceIdRef.current;
        const other = cameras.find((camera) => camera.deviceId && camera.deviceId !== previous);
        if (previous && currentDeviceId(video) === previous && other) {
          started.stop();
          started = await reader.decodeFromConstraints(
            {
              audio: false,
              video: { deviceId: { exact: other.deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } },
            },
            video,
            onResult,
          );
          if (stopped) {
            started.stop();
            return;
          }
          controls = started;
        }
        deviceIdRef.current = currentDeviceId(video);
        setStatus("live");
      } catch (cause) {
        if (stopped) return;
        const name = (cause as { name?: string })?.name ?? "";
        setStatus("error");
        setProblem(
          name === "NotAllowedError"
            ? "Camera permission was denied. Allow the camera for this site in the browser settings, then try again."
            : name === "NotFoundError" || name === "OverconstrainedError"
              ? "No camera was found on this device."
              : "The camera could not start. Close other apps using the camera and try again.",
        );
      }
    }

    void start();
    return () => {
      stopped = true;
      controls?.stop();
    };
    // 방향이 바뀔 때만 다시 켠다. 콜백은 ref 로 최신을 쓴다.
  }, [facing]);

  // 결과 문구는 잠깐만 보인다.
  useEffect(() => {
    if (!flash) return;
    const timer = window.setTimeout(() => setFlash(null), flash.ok ? 1600 : 3500);
    return () => window.clearTimeout(timer);
  }, [flash]);

  // Esc 로 닫기(블루투스 키보드를 붙인 아이패드).
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    const { overflow } = document.body.style;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
    };
  }, [onClose]);

  return (
    // z-[60]: 어드민 서랍(z-50)과 계산서 시트(z-40) 위.
    <div
      className="fixed inset-0 z-[60] flex flex-col bg-black text-white"
      onPointerDown={unlockAudio}
      role="dialog"
      aria-label="Camera barcode scanner"
    >
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {/* 전면은 거울처럼 보여야 물건을 어느 쪽으로 옮길지 헷갈리지 않는다. 읽기는 원본 프레임으로 한다. */}
        <video
          className={`absolute inset-0 h-full w-full object-cover ${facing === "user" ? "-scale-x-100" : ""}`}
          ref={videoRef}
        />

        {/* 조준 틀. 휴대폰이든 아이패드든 **화면 거의 전체**를 덮는다 — 작은 틀은 바코드를
            그 안에 맞추느라 시간이 걸리고, 읽기는 어차피 화면 전체에서 한다.
            네 모서리만 그려서 가운데 물건을 가리지 않는다. 가운데 가로줄은 1D 바코드를 눕힐 방향. */}
        <div
          className={`pointer-events-none absolute inset-x-[4%] top-[calc(max(env(safe-area-inset-top),0.5rem)+3.25rem)] bottom-[4%] transition-colors ${
            flash ? (flash.ok ? "text-[#3ddc84]" : "text-[#ff5a5a]") : "text-white/90"
          }`}
        >
          <span className="absolute top-0 left-0 h-[18%] max-h-24 w-[18%] max-w-24 border-t-4 border-l-4 border-current" />
          <span className="absolute top-0 right-0 h-[18%] max-h-24 w-[18%] max-w-24 border-t-4 border-r-4 border-current" />
          <span className="absolute bottom-0 left-0 h-[18%] max-h-24 w-[18%] max-w-24 border-b-4 border-l-4 border-current" />
          <span className="absolute right-0 bottom-0 h-[18%] max-h-24 w-[18%] max-w-24 border-r-4 border-b-4 border-current" />
          <span className="absolute inset-x-[6%] top-1/2 h-0.5 -translate-y-1/2 bg-current opacity-70" />
        </div>

        {/* 머리줄은 영상 위에 겹친다. 따로 한 줄을 차지하면 그만큼 영상과 틀이 줄어든다. */}
        <header className="absolute inset-x-0 top-0 flex items-center justify-between gap-2 bg-gradient-to-b from-black/70 to-transparent px-3 pt-[max(env(safe-area-inset-top),0.5rem)] pb-3">
          <h2 className="text-sm font-bold">Camera scan</h2>
          <div className="flex items-center gap-1">
            {cameraCount > 1 ? (
              <button
                aria-label={facing === "user" ? "Switch to back camera" : "Switch to front camera"}
                className="inline-flex min-h-11 items-center gap-1.5 border border-white/40 bg-black/30 px-3 text-xs font-bold"
                onClick={switchCamera}
                type="button"
              >
                <span aria-hidden>⇄</span>
                {facing === "user" ? "Front" : "Back"}
              </button>
            ) : null}
            <button
              aria-label="Close camera"
              className="flex min-h-11 min-w-11 items-center justify-center text-2xl leading-none"
              onClick={onClose}
              type="button"
            >
              <span aria-hidden>×</span>
            </button>
          </div>
        </header>

        {status === "starting" ? (
          <p className="absolute inset-x-0 top-1/2 text-center text-sm">Starting camera…</p>
        ) : null}
        {status === "error" ? (
          <div className="absolute inset-x-4 top-1/3 bg-[#1f1f23] p-4 text-sm">
            <p className="font-bold">Camera unavailable</p>
            <p className="mt-1 text-[#d4d4d8]">{problem}</p>
          </div>
        ) : null}
        {status === "live" && !flash ? (
          <p className="absolute inset-x-[8%] bottom-[calc(4%+0.75rem)] bg-black/45 px-3 py-1.5 text-center text-sm text-white/90">
            Fill the screen with the barcode. Same item again? Move it away, then back.
          </p>
        ) : null}

        {flash ? (
          <div
            aria-live="assertive"
            className={`absolute inset-x-[6%] bottom-[calc(4%+0.75rem)] px-3 py-2.5 text-sm font-bold ${
              flash.ok ? "bg-[#12713a]" : "bg-[#8a1f1f]"
            }`}
            key={flash.at}
          >
            {flash.ok ? "✓ " : "✕ "}
            {flash.message}
          </div>
        ) : null}
      </div>

      <footer className="flex items-center justify-between gap-3 bg-white px-4 pt-2.5 pb-[max(env(safe-area-inset-bottom),0.625rem)] text-[#111]">
        <div className="min-w-0">{summary}</div>
        <button
          className="min-h-12 shrink-0 bg-[#4533ff] px-5 text-sm font-bold text-white disabled:opacity-40"
          disabled={!canPay}
          onClick={onDone}
          type="button"
        >
          {doneLabel}
        </button>
      </footer>
    </div>
  );
}
