"use client";

/**
 * 계산대의 영수증 프린터 설정(이 기기에만). 브라우저 인쇄, 블루투스 TM-m30, 네트워크 TM-m30III,
 * 또는 iPad 의 Epson TM Print Assistant 앱(블루투스 TM-m30).
 * 계산대 첫 화면(`RegisterHome`)의 Receipt Printer 타일이 창 안에 연다.
 * 연결·전송은 `lib/retail/receiptPrinter.ts`, 설치 절차는 `docs/pro-shop-receipt-printing-2026-09-12.md`.
 */

import { useEffect, useState, useSyncExternalStore } from "react";

import { CLUB } from "@/lib/nav";
import type { ReceiptBlock } from "@/lib/retail/receipt";
import {
  bluetoothPrinterStatus,
  bluetoothPrintingSupported,
  choosePrinter,
  hasChosenPrinter,
  printBluetooth,
  printEpsonApp,
  printNetwork,
  readReceiptPrinterHost,
  readReceiptPrinterMode,
  subscribeReceiptPrinter,
  writeReceiptPrinterHost,
  writeReceiptPrinterMode,
  type ReceiptPrinterMode,
} from "@/lib/retail/receiptPrinter";

import { Button, Field, Select, TextInput } from "@/components/retail/ui";

const MODE_LABELS: Record<ReceiptPrinterMode, string> = {
  browser: "Print dialog — printer installed on this computer or AirPrint",
  bluetooth: "Bluetooth — Epson TM-m30 paired with this computer",
  network: "Network — Epson TM-m30III on the shop Wi-Fi or Ethernet",
  app: "iPad — Bluetooth printer through the Epson TM Print Assistant app",
};

const EPSON_APP_STORE = "https://apps.apple.com/app/id1324935555";

const TEST_SHEET: ReceiptBlock[] = [
  { kind: "logo" },
  { kind: "text", text: CLUB.name, align: "center", bold: true, large: true },
  { kind: "text", text: "Printer test", align: "center", gap: true },
  { kind: "itemsHead" },
  { kind: "item", name: "Test item", detail: "TEST", qty: 1, amount: "$0.00" },
  { kind: "rule" },
  { kind: "total", label: "Total", amount: "$0.00", bold: true },
  { kind: "barcode", value: "PH-TEST-0001" },
];

const noSubscribe = () => () => undefined;

export function ReceiptPrinterSetup() {
  const mode = useSyncExternalStore(
    subscribeReceiptPrinter,
    readReceiptPrinterMode,
    () => "browser" as const,
  );
  const savedHost = useSyncExternalStore(
    subscribeReceiptPrinter,
    readReceiptPrinterHost,
    () => "",
  );
  const supported = useSyncExternalStore(
    noSubscribe,
    bluetoothPrintingSupported,
    () => false,
  );
  const [chosen, setChosen] = useState(false);
  const [hostDraft, setHostDraft] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [working, setWorking] = useState(false);
  const host = hostDraft ?? savedHost;

  useEffect(() => {
    void hasChosenPrinter().then(setChosen);
  }, [mode]);

  async function run(action: () => Promise<string>) {
    setWorking(true);
    setMessage("");
    try {
      setMessage(await action());
    } catch (error) {
      // 고르기 창을 닫은 것은 오류가 아니다.
      if (error instanceof DOMException && error.name === "NotFoundError")
        return;
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setWorking(false);
      setChosen(await hasChosenPrinter());
    }
  }

  return (
    <div className="grid gap-2 text-sm">
      <Field
        hint="Each register computer has its own setting"
        label="Send receipts to"
      >
        <Select
          onChange={(event) =>
            writeReceiptPrinterMode(event.target.value as ReceiptPrinterMode)
          }
          value={mode}
        >
          {(Object.keys(MODE_LABELS) as ReceiptPrinterMode[]).map((key) => (
            <option
              disabled={key === "bluetooth" && !supported}
              key={key}
              value={key}
            >
              {MODE_LABELS[key]}
            </option>
          ))}
        </Select>
      </Field>
      {!supported && mode === "browser" ? (
        <p className="text-xs text-[#6b7280]">
          On iPad, choose &quot;iPad — Bluetooth printer through the Epson TM
          Print Assistant app&quot; to print to a Bluetooth receipt printer.
        </p>
      ) : null}
      {mode === "app" ? (
        <>
          <ol className="list-decimal pl-5 text-xs text-[#6b7280]">
            <li>
              Install{" "}
              <a
                className="font-bold underline"
                href={EPSON_APP_STORE}
                rel="noopener"
                target="_blank"
              >
                Epson TM Print Assistant
              </a>{" "}
              from the App Store.
            </li>
            <li>
              Pair the printer in iPad Settings → Bluetooth (PIN is usually
              0000).
            </li>
            <li>
              Open the Epson app → Printer settings → choose the printer
              (e.g. &quot;TM-m30III&quot;).
            </li>
            <li>
              Come back here and tap Print test. The first time, Safari asks to
              open the Epson app — tap Open.
            </li>
          </ol>
          <div className="flex gap-2">
            <Button
              disabled={working}
              onClick={() =>
                void run(async () => {
                  await printEpsonApp([TEST_SHEET]);
                  return "Test page sent to the Epson app. If nothing happened, check the app is installed.";
                })
              }
            >
              Print test
            </Button>
          </div>
        </>
      ) : null}
      {supported && mode === "bluetooth" ? (
        <>
          <p className="text-xs text-[#6b7280]">
            Pair the printer in the computer&apos;s Bluetooth settings first,
            then choose it here (it is listed as a serial port, e.g.
            &quot;TM-m30III&quot;).
          </p>
          <div className="flex gap-2">
            <Button
              disabled={working}
              onClick={() =>
                void run(async () => {
                  await choosePrinter();
                  return "Printer chosen. Print a test page to check.";
                })
              }
            >
              {chosen ? "Change printer" : "Choose printer"}
            </Button>
            <Button
              disabled={working || !chosen}
              onClick={() =>
                void run(async () => {
                  await printBluetooth([TEST_SHEET]);
                  return `Test page sent. ${await bluetoothPrinterStatus()}`;
                })
              }
            >
              Print test
            </Button>
          </div>
        </>
      ) : null}
      {mode === "network" ? (
        <>
          <Field
            hint="Hold the printer's feed button at power-on to print it"
            label="Printer IP address"
          >
            <TextInput
              inputMode="url"
              onChange={(event) => setHostDraft(event.target.value)}
              placeholder="192.168.0.50"
              value={host}
            />
          </Field>
          <p className="text-xs text-[#6b7280]">
            Once on each device: open the printer page below and accept the
            certificate warning (Advanced → Proceed). Chrome may also ask to
            allow access to devices on the local network — allow it.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={working || !host.trim()}
              onClick={() =>
                void run(async () => {
                  const saved = writeReceiptPrinterHost(host);
                  setHostDraft(null);
                  window.open(`https://${saved}/`, "_blank", "noopener");
                  return "Accept the certificate in the new tab, close it, then print a test page.";
                })
              }
            >
              Save &amp; open printer page
            </Button>
            <Button
              disabled={working || !host.trim()}
              onClick={() =>
                void run(async () => {
                  writeReceiptPrinterHost(host);
                  setHostDraft(null);
                  await printNetwork([TEST_SHEET]);
                  return "Test page printed.";
                })
              }
            >
              Print test
            </Button>
          </div>
        </>
      ) : null}
      {message ? <p className="text-xs font-bold">{message}</p> : null}
    </div>
  );
}
