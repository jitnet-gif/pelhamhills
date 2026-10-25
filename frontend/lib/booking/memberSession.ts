/**
 * 예약 사이트 회원 로그인(0111). 직원 로그인(Supabase Auth)과 따로다 — 토큰은 0111 함수만 알아본다.
 *
 * 토큰 원문은 이 브라우저의 localStorage 에만 있다(서버에는 sha256). 열 때마다 `pelham_member_me` 로
 * 아직 살아 있는지 묻고, 죽었으면 지운다. 헤더와 예약 폼이 같은 값을 보도록 모듈 하나가 들고 알린다.
 */

import { useSyncExternalStore } from "react";

import { bookingRpc } from "@/lib/booking/rpc";

export type SignedInMember = {
  /** 회원 등록(0111) 이면 member, 일반 가입(0112) 이면 guest. 0112 전 서버면 없다 — member 로 본다. */
  kind?: "member" | "guest";
  name: string;
  email: string;
  phone: string;
  /** 오늘 살아 있는 회원권이 없으면 빠진다. */
  membershipType?: string;
  season?: number;
};

/** 로그인 실패는 오류가 아니라 `{ error }` 로 온다(0111 — 실패 횟수 기록이 되돌려지지 않게). */
type SessionDoc = { token?: string; member?: SignedInMember; error?: string };

/** `undefined` = 아직 확인 전, `null` = 로그아웃. */
type State = { token: string; member: SignedInMember } | null | undefined;

const KEY = "pelham-member-session";

let state: State = undefined;
const listeners = new Set<() => void>();

function emit(next: State) {
  state = next;
  listeners.forEach((listener) => listener());
}

function readToken(): string {
  try {
    return window.localStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
}

function writeToken(token: string) {
  try {
    if (token) window.localStorage.setItem(KEY, token);
    else window.localStorage.removeItem(KEY);
  } catch {
    // 개인 창 등 — 이번 탭에서만 로그인이 유지된다.
  }
}

let checking = false;

/** 처음 구독할 때 한 번 저장된 토큰을 확인한다. */
function check() {
  if (checking || state !== undefined) return;
  checking = true;
  const token = readToken();
  if (!token) {
    emit(null);
    return;
  }
  bookingRpc<SessionDoc | null>("pelham_member_me", { p_token: token })
    .then((doc) => {
      if (doc?.member && !doc.error) emit({ token, member: doc.member });
      else {
        writeToken("");
        emit(null);
      }
    })
    .catch(() => {
      // 0111 전이거나 연결이 끊겼다. 토큰은 두고 이번엔 로그아웃으로 보인다.
      emit(null);
    });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  check();
  return () => listeners.delete(listener);
}

export function useMemberSession(): State {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => undefined,
  );
}

function accept(doc: SessionDoc | null): SignedInMember {
  if (!doc?.token || !doc.member || doc.error)
    throw new Error(doc?.error || "Sign-in failed. Please try again.");
  writeToken(doc.token);
  emit({ token: doc.token, member: doc.member });
  return doc.member;
}

export async function memberSignIn(
  email: string,
  password: string,
): Promise<SignedInMember> {
  return accept(
    await bookingRpc<SessionDoc | null>("pelham_member_login", {
      p_email: email.trim(),
      p_password: password,
    }),
  );
}

export async function memberRegister(input: {
  membershipRef: string;
  email: string;
  phone: string;
  password: string;
}): Promise<SignedInMember> {
  return accept(
    await bookingRpc<SessionDoc | null>("pelham_member_register", {
      p_member: input.membershipRef,
      p_email: input.email.trim(),
      p_phone: input.phone.trim(),
      p_password: input.password,
    }),
  );
}

/** 일반 가입(0112) — 회원권이 없는 손님. 예약은 일반 요금 그대로다. */
export async function guestRegister(input: {
  name: string;
  email: string;
  phone: string;
  password: string;
}): Promise<SignedInMember> {
  return accept(
    await bookingRpc<SessionDoc | null>("pelham_guest_register", {
      p_name: input.name.trim(),
      p_email: input.email.trim(),
      p_phone: input.phone.trim(),
      p_password: input.password,
    }),
  );
}

export function memberSignOut() {
  const token = state?.token ?? readToken();
  writeToken("");
  emit(null);
  if (token)
    bookingRpc<boolean>("pelham_member_logout", { p_token: token }).catch(
      () => undefined,
    );
}

/** 예약 중 토큰이 지났다는 답(401)을 받았을 때. */
export function memberSessionExpired() {
  writeToken("");
  emit(null);
}
