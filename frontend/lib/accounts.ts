/**
 * 계정 설정(Account Setup) — 로그인 계정을 만들고, 고치고, 지운다(0074).
 *
 * 계정 관리자 명단(`pelham_account_admins`, 지금은 Emmeline 의 admin@pelhamhills.ca 하나)만 쓴다.
 * 메뉴를 가리는 것은 여기(`useAccountsAccess`), 막는 것은 서버(0074)다.
 *
 * 비밀번호는 읽을 수 없다 — 서버에는 해시만 있다. 화면은 새 비밀번호를 정하는 것만 한다.
 */

import { useEffect, useState } from "react";

import { ApiError } from "@/lib/teeSheet/api";
import { staffRpc } from "@/lib/teeSheet/staffRpc";

export type Account = {
  id: string;
  email: string;
  created_at: string;
  last_sign_in_at: string | null;
  confirmed: boolean;
  /** 직원 명단(scorecard_admins). 꺼져 있으면 어드민이 열리지 않는다. */
  staff: boolean;
  /** Reports·현금 리포트 명단(0046). */
  reports: boolean;
  /** 이 화면을 쓰는 계정. SQL 에서만 바꾼다. */
  account_admin: boolean;
  is_me: boolean;
};

export type AccountInput = {
  id: string | null;
  email: string;
  /** 비우면 그대로 둔다(새 계정은 필수). */
  password: string;
  staff: boolean;
  reports: boolean;
};

export const accountsApi = {
  access: async (): Promise<boolean> => {
    try {
      return await staffRpc<boolean>("pelham_staff_accounts_access");
    } catch (cause) {
      if (isMissingFunction(cause)) return false;
      throw cause;
    }
  },
  list: () => staffRpc<Account[]>("pelham_staff_accounts_list"),
  save: (input: AccountInput) =>
    staffRpc<{ id: string; email: string }>("pelham_staff_account_save", {
      p_id: input.id,
      p_email: input.email,
      p_password: input.password,
      p_staff: input.staff,
      p_reports: input.reports,
    }),
  remove: (id: string) => staffRpc<void>("pelham_staff_account_delete", { p_id: id }),
};

function isMissingFunction(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404 && /function|PGRST202|schema cache/i.test(error.message);
}

export function describeAccountError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 0) return "Can't reach the server. Check the connection and try again.";
    if (isMissingFunction(error)) return "Account functions are missing — run migration 0074 in the Supabase SQL Editor.";
    return error.message;
  }
  return (error as Error)?.message ?? "Something went wrong.";
}

const known = new Map<string, boolean>();

/** 메뉴에 Account Setup 을 띄울지. null = 아직 모른다(숨긴 채로 둔다). `lib/reports/access.ts` 와 같은 방식. */
export function useAccountsAccess(email: string): boolean | null {
  const [allowed, setAllowed] = useState<boolean | null>(() => known.get(email) ?? null);

  useEffect(() => {
    if (known.has(email)) return;
    let cancelled = false;
    accountsApi
      .access()
      .then((value) => {
        known.set(email, value);
        if (!cancelled) setAllowed(value);
      })
      .catch(() => {
        if (!cancelled) setAllowed(false);
      });
    return () => {
      cancelled = true;
    };
  }, [email]);

  return allowed;
}
