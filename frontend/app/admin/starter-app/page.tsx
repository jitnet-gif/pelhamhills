"use client";

/**
 * 1번 티 스타터 폰(Android) 앱 내려받기. APK 는 `public/apps/pelham-starter.apk` — `android/starter` 를
 * `./gradlew assembleDebug` 로 만든 것을 그대로 복사한다. 앱 안에는 비밀값이 없다(로그인은 직원 계정, 결제 키는 Fly).
 * 화면은 웹(`/teesheet/mobile`)이라 웹을 고치면 앱을 다시 깔 필요가 없다. 앱 자체(결제·인쇄)를 바꿨을 때만 새로 받는다.
 */
import AdminShell from "@/components/admin/AdminShell";

const APK = "/apps/pelham-starter.apk";
const VERSION = "1.0 · 2026-10-24";

const STEPS: { title: string; body: string }[] = [
  {
    title: "Download on the club phone",
    body: "Open this page on the Android phone and tap Download. Chrome may warn that the file can be harmful — tap Download anyway.",
  },
  {
    title: "Install",
    body: "Open the downloaded file. If Android blocks it, allow “Install unknown apps” for Chrome, then tap Install.",
  },
  {
    title: "Allow permissions",
    body: "On first open, allow Location and Nearby devices. Tap to Pay needs Location; Nearby devices is for the Bluetooth printer. Allow Camera when you first tap QR.",
  },
  {
    title: "Phone settings",
    body: "Turn on NFC. Set a screen lock (PIN) — Tap to Pay will not start without one. Android 11 or newer.",
  },
  {
    title: "Sign in and pick the printer",
    body: "Sign in with a pro shop account. Pair the receipt printer in Android Bluetooth settings, then tap 🖨 in the app, choose it and print a test receipt. For the TM-m30III on Wi-Fi, enter its IP address.",
  },
];

export default function StarterAppPage() {
  return (
    <AdminShell title="Starter Phone App">
      <div className="grid max-w-2xl gap-4 p-4">
        <section className="grid gap-3 border border-[#d4d4d8] bg-white p-4">
          <div className="flex items-center gap-3">
            <span aria-hidden className="grid h-12 w-12 place-items-center rounded-full bg-[#1e5a3f] text-2xl text-white">
              ⛳
            </span>
            <div>
              <h2 className="text-base font-bold">Pelham Starter (Android)</h2>
              <p className="text-xs text-[#6b7280]">
                Version {VERSION} · about 40 MB
              </p>
            </div>
          </div>
          <p className="text-sm leading-6 text-[#3f4650]">
            The 1st-tee phone: today’s tee sheet as one list, search by name, last 4 of phone, code or QR, check-in, tap
            to pay with the phone itself, and receipts on a Bluetooth or Wi-Fi printer or by text.
          </p>
          <div className="flex flex-wrap gap-2">
            <a
              className="inline-flex min-h-11 items-center bg-[#4533ff] px-5 text-sm font-bold text-white"
              download="pelham-starter.apk"
              href={APK}
            >
              Download APK
            </a>
            <a
              className="inline-flex min-h-11 items-center border border-[#4533ff] px-5 text-sm font-bold text-[#4533ff]"
              href="/teesheet/mobile"
            >
              Open the phone tee sheet in this browser
            </a>
          </div>
          <p className="text-xs text-[#6b7280]">
            Android only. iPhone is not supported. In the browser the list, search and check-in work; tap to pay and
            printing work only inside the app.
          </p>
        </section>

        <section className="grid gap-2 border border-[#d4d4d8] bg-white p-4">
          <h2 className="text-sm font-bold">Set up the phone (once)</h2>
          <ol className="grid gap-3">
            {STEPS.map((step, index) => (
              <li className="grid grid-cols-[auto_1fr] gap-3" key={step.title}>
                <span className="grid h-7 w-7 place-items-center rounded-full bg-[#eef0ff] text-xs font-bold text-[#4533ff]">
                  {index + 1}
                </span>
                <div>
                  <p className="text-sm font-bold">{step.title}</p>
                  <p className="text-xs leading-5 text-[#4e5560]">{step.body}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        <section className="grid gap-1 border border-[#d4d4d8] bg-white p-4 text-xs leading-5 text-[#4e5560]">
          <h2 className="text-sm font-bold text-[#1f2328]">Good to know</h2>
          <p>Card payments land on the same bill and close-out as the pro shop card reader, and the approval text goes out the same way.</p>
          <p>While Stripe is in test mode the app uses a simulated reader — no real card is charged.</p>
          <p>Screen changes arrive by themselves. Download a new APK only when this page shows a newer version.</p>
        </section>
      </div>
    </AdminShell>
  );
}
