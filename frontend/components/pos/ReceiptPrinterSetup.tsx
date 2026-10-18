"use client";

/**
 * 계산대의 영수증 프린터 설정(이 기기에만). 브라우저 인쇄 또는 블루투스 TM-m30.
 * 연결·전송은 `lib/retail/receiptPrinter.ts`, 설치 절차는 `docs/pro-shop-receipt-printing-2026-09-12.md`.
 */

import { useEffect, useState, useSyncExternalStore } from "react";

import { CLUB } from "@/lib/nav";
import type { ReceiptBlock } from "@/lib/retail/receipt";
import {
  bluetoothPrintingSupported,
  choosePrinter,
  hasChosenPrinter,
  printBluetooth,
  readReceiptPrinterMode,
  subscribeReceiptPrinter,
  writeReceiptPrinterMode,
  type ReceiptPrinterMode,
} from "@/lib/retail/receiptPrinter";

import { Button, Field, Select } from "@/components/retail/ui";

const MODE_LABELS: Record<ReceiptPrinterMode, string> = {
  browser: "Print dialog — printer installed on this computer or AirPrint",
  bluetooth: "Bluetooth — Epson TM-m30 paired with this computer",
};

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
  const mode = useSyncExternalStore(subscribeReceiptPrinter, readReceiptPrinterMode, () => "browser" as const);
  const supported = useSyncExternalStore(noSubscribe, bluetoothPrintingSupported, () => false);
  const [chosen, setChosen] = useState(false);
  const [message, setMessage] = useState("");
  const [working, setWorking] = useState(false);

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
      if (error instanceof DOMException && error.name === "NotFoundError") return;
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setWorking(false);
      setChosen(await hasChosenPrinter());
    }
  }

  const summary = mode === "bluetooth" ? (chosen ? "Bluetooth" : "Bluetooth — no printer chosen") : "print dialog";

  return (
    <details className="border border-[#e4e4e8] p-2 text-sm">
      <summary className="cursor-pointer font-bold">Receipt printer: {summary}</summary>
      <div className="mt-2 grid gap-2">
        <Field hint="Each register computer has its own setting" label="Send receipts to">
          <Select
            onChange={(event) => writeReceiptPrinterMode(event.target.value as ReceiptPrinterMode)}
            value={mode}
          >
            {(Object.keys(MODE_LABELS) as ReceiptPrinterMode[]).map((key) => (
              <option disabled={key === "bluetooth" && !supported} key={key} value={key}>
                {MODE_LABELS[key]}
              </option>
            ))}
          </Select>
        </Field>
        {!supported ? (
          <p className="text-xs text-[#6b7280]">
            This browser cannot reach Bluetooth printers. Use Chrome or Edge on a Mac or PC. On iPad, receipts go
            through the print dialog.
          </p>
        ) : null}
        {supported && mode === "bluetooth" ? (
          <>
            <p className="text-xs text-[#6b7280]">
              Pair the printer in the computer&apos;s Bluetooth settings first, then choose it here (it is listed as a
              serial port, e.g. &quot;TM-m30III&quot;).
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
                    return "Test page sent.";
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
    </details>
  );
}
