"use client";

/**
 * 계산대 앱의 첫 화면. 이 기기가 전에 연 계산대가 있으면 곧장 그리로 간다 —
 * 스낵바 태블릿은 늘 스낵바로, 프로 샵 PC 는 늘 프로 샵으로 열려야 한다.
 * 처음이면 고르게 하고, 브라우저에서 열었으면 "앱으로 설치" 를 안내한다.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { POS_LAST_STATION } from "@/components/pos/PosRegister";

/** Chrome·Edge 가 주는 설치 요청. 표준 타입에 아직 없다. */
type InstallPrompt = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };

const STATIONS = [
  { id: "snack-bar", href: "/pos/snack-bar", label: "Snack Bar / Bev Cart", note: "Food & Beverage only" },
  { id: "pro-shop", href: "/pos/pro-shop", label: "Pro Shop", note: "All products" },
] as const;

export default function PosHome() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [installPrompt, setInstallPrompt] = useState<InstallPrompt | null>(null);
  const [standalone, setStandalone] = useState(false);
  const [ios, setIos] = useState(false);

  useEffect(() => {
    let last: string | null = null;
    try {
      last = window.localStorage.getItem(POS_LAST_STATION);
    } catch {
      last = null;
    }
    // 계산대 첫 화면의 Switch Registers 는 `?pick=1` 로 온다 — 지난 계산대로 되돌려 보내지 않는다.
    const picking = new URLSearchParams(window.location.search).has("pick");
    const station = picking ? undefined : STATIONS.find((item) => item.id === last);
    if (station) {
      router.replace(station.href);
      return;
    }
    setStandalone(
      window.matchMedia("(display-mode: standalone)").matches ||
        (navigator as Navigator & { standalone?: boolean }).standalone === true,
    );
    setIos(/iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));
    setReady(true);
  }, [router]);

  useEffect(() => {
    const onPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as InstallPrompt);
    };
    const onInstalled = () => setInstallPrompt(null);
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  if (!ready) return <main className="min-h-[100dvh] bg-[#111315]" />;

  return (
    <main className="pt-safe pb-safe grid min-h-[100dvh] place-items-center bg-[#111315] px-4 py-10 text-white">
      <div className="grid w-full max-w-[420px] gap-6">
        <div className="grid gap-1">
          <p className="text-[11px] font-bold tracking-wide text-white/50 uppercase">Pelham Hills</p>
          <h1 className="text-2xl font-bold">Pelham POS</h1>
          <p className="text-sm text-white/70">Pick the register for this device. It opens here next time.</p>
        </div>

        <div className="grid gap-2">
          {STATIONS.map((station) => (
            <Link
              className="grid min-h-16 gap-0.5 border border-white/15 bg-white/5 px-4 py-3 hover:border-[#8b80ff] hover:bg-white/10"
              href={station.href}
              key={station.id}
            >
              <span className="text-base font-bold">{station.label}</span>
              <span className="text-xs text-white/60">{station.note}</span>
            </Link>
          ))}
        </div>

        {standalone ? null : installPrompt ? (
          <button
            className="min-h-12 bg-[#4533ff] px-4 text-sm font-bold text-white hover:bg-[#3a2ae0]"
            onClick={() => {
              void installPrompt.prompt();
              void installPrompt.userChoice.finally(() => setInstallPrompt(null));
            }}
            type="button"
          >
            Install Pelham POS on this device
          </button>
        ) : (
          <p className="border border-white/15 px-4 py-3 text-xs leading-relaxed text-white/70">
            {ios
              ? "To install: tap Share, then Add to Home Screen."
              : "To install: open the browser menu and choose Install app (or the install icon in the address bar)."}
          </p>
        )}
      </div>
    </main>
  );
}
