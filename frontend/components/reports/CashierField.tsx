"use client";

/**
 * 담당자 칸 — Pelham Shift ID(숫자 4~8자리)를 치면 칸을 떠날 때 그 직원 이름으로 바뀐다. 이름을 쳐도 된다.
 * 번호는 pelham-shift 로그인 비밀번호이기도 하므로 이름으로 바꾼 뒤에는 칸에도 남기지 않는다(`cashierCode.ts`).
 * 계산대 마감(`RegisterClose`)과 Daily close 의 Print 창이 같이 쓴다.
 */

import { useState } from "react";

import { cashierName, isShiftCode } from "@/lib/pos/cashierCode";

import { Field, TextInput } from "@/components/retail/ui";

export default function CashierField({
  value,
  onChange,
  label = "Cashier",
}: {
  value: string;
  onChange: (value: string) => void;
  label?: string;
}) {
  const [checking, setChecking] = useState(false);
  const [problem, setProblem] = useState("");

  async function resolve() {
    if (!isShiftCode(value)) return;
    setChecking(true);
    setProblem("");
    try {
      onChange(await cashierName(value));
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : "That staff ID didn't work.");
      onChange("");
    } finally {
      setChecking(false);
    }
  }

  return (
    <Field hint={checking ? "Checking the staff ID…" : problem || "Pelham Shift ID (4 digits) or name"} label={label}>
      <TextInput
        autoComplete="off"
        onBlur={() => void resolve()}
        onChange={(event) => {
          setProblem("");
          onChange(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") void resolve();
        }}
        placeholder="e.g. 1234"
        // 번호를 치는 동안은 가린다(로그인 비밀번호다). 이름이 되면 보인다.
        style={isShiftCode(value) ? { WebkitTextSecurity: "disc" } as React.CSSProperties : undefined}
        value={value}
      />
    </Field>
  );
}
