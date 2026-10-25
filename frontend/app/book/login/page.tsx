"use client";

/**
 * 회원 로그인 · 등록(0111).
 *
 * 등록은 세 걸음: 이름으로 자기 회원권을 찾아 고르고(0109 `pelham_tee_member_lookup`),
 * 기록에 있는 이메일 또는 전화로 본인 확인을 하고, 비밀번호를 정한다. 확인은 서버가 한다 —
 * 화면은 회원의 연락처를 받지 않는다(공개 화면이라 이름·회원권 종류만 온다).
 *
 * 일반 가입(0112)은 회원권 없이 이름·이메일·전화·비밀번호로 만든다. 요금은 일반 그대로이고,
 * 나중에 같은 이메일로 회원 등록을 하면 그 계정이 회원 계정으로 바뀐다.
 *
 * 로그인하면 티타임 예약 폼이 이름·이메일·전화를 채운다(`pelham_tee_book_signed_in`). 회원이면 회원 요금.
 * 로그인 없이 예약하는 길은 그대로 열려 있다.
 */

import Link from "next/link";
import { useState, type ReactNode } from "react";

import BookingShell from "@/components/booking/BookingShell";
import {
  MemberLookupList,
  memberLabel,
  usePublicMemberSearch,
  type PublicMember,
} from "@/components/booking/MemberLookup";
import { describeFailure } from "@/components/booking/availability";
import {
  guestRegister,
  memberRegister,
  memberSignIn,
  memberSignOut,
  useMemberSession,
} from "@/lib/booking/memberSession";
import { BOOK_TEE_TIME, CLUB } from "@/lib/nav";
import { ApiError } from "@/lib/teeSheet/api";

type Tab = "signin" | "register" | "guest";

export default function MemberLoginPage() {
  const session = useMemberSession();
  const [tab, setTab] = useState<Tab>("signin");
  // 손님 계정으로 로그인한 채 "회원권 연결" 을 눌렀을 때 회원 등록 폼을 연다.
  const [linking, setLinking] = useState(false);

  if (session) {
    const guest = session.member.kind === "guest";
    return (
      <BookingShell
        subtitle={
          guest ? "You are signed in." : "You are signed in as a member."
        }
        title={guest ? "My Account" : "Member"}
      >
        <div className="rounded-sm border border-[#d8d1c3] bg-white p-6">
          <p className="text-xl font-semibold">{session.member.name}</p>
          {session.member.membershipType && session.member.season ? (
            <p className="mt-2">
              <span className="rounded-full bg-[#e3f0e6] px-3 py-0.5 text-sm font-semibold text-[#2f7d4f]">
                {memberLabel({
                  membershipType: session.member.membershipType,
                  season: session.member.season,
                })}
              </span>
            </p>
          ) : guest ? (
            <p className="mt-2 text-sm text-[#5c6459]">
              Guest account — tee times book at the regular rate.
            </p>
          ) : (
            <p className="mt-2 text-sm text-[#8a6f30]">
              We don&apos;t see an active membership today. Tee times book at
              the regular rate until the pro shop renews it.
            </p>
          )}
          <p className="mt-3 text-sm text-[#5c6459]">{session.member.email}</p>
          <div className="mt-5 grid grid-cols-[minmax(0,1fr)] gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <Link
              className="tap-target flex items-center justify-center rounded-sm bg-[#214d2f] px-5 text-base font-bold text-white transition hover:bg-[#163820]"
              href={BOOK_TEE_TIME}
            >
              Book a tee time
            </Link>
            <button
              className="tap-target rounded-sm border border-[#d8d1c3] bg-white px-5 text-base font-bold text-[#214d2f] transition hover:bg-[#f7f4ed]"
              onClick={memberSignOut}
              type="button"
            >
              Sign out
            </button>
          </div>
          {guest && !linking ? (
            <p className="mt-4 text-sm text-[#5c6459]">
              Are you a member?{" "}
              <button
                className="font-semibold text-[#214d2f] underline"
                onClick={() => setLinking(true)}
                type="button"
              >
                Link your membership
              </button>{" "}
              to book at your member rate.
            </p>
          ) : null}
        </div>
        {guest && linking ? (
          <div className="mt-4 rounded-sm border border-[#d8d1c3] bg-white p-5">
            <p className="mb-4 text-sm text-[#5c6459]">
              Use the email {session.member.email} to keep this account — it
              becomes your member sign-in.
            </p>
            <RegisterForm />
          </div>
        ) : null}
      </BookingShell>
    );
  }

  return (
    <BookingShell
      subtitle="Sign in to book faster. Members book at their member rate."
      title="Sign In"
    >
      <div className="mx-auto max-w-lg">
        <div
          className="flex overflow-hidden rounded-md border border-[#d8d1c3]"
          role="tablist"
        >
          {(
            [
              ["signin", "Sign in"],
              ["register", "Member sign-up"],
              ["guest", "Guest sign-up"],
            ] as const
          ).map(([key, label]) => (
            <button
              aria-selected={tab === key}
              className={`tap-target min-w-0 flex-1 border-l border-[#d8d1c3] text-base font-semibold transition first:border-l-0 ${
                tab === key
                  ? "bg-[#214d2f] text-white"
                  : "bg-white text-[#182118] hover:bg-[#f2f6f2]"
              }`}
              key={key}
              onClick={() => setTab(key)}
              role="tab"
              type="button"
            >
              {label}
            </button>
          ))}
        </div>

        <div className="mt-4 rounded-sm border border-[#d8d1c3] bg-white p-5">
          {session === undefined ? (
            <p className="text-sm text-[#5c6459]">Checking…</p>
          ) : tab === "signin" ? (
            <SignInForm
              onRegister={() => setTab("register")}
              onGuest={() => setTab("guest")}
            />
          ) : tab === "register" ? (
            <RegisterForm />
          ) : (
            <GuestForm onMember={() => setTab("register")} />
          )}
        </div>

        <p className="mt-4 text-center text-sm text-[#5c6459]">
          You can also{" "}
          <Link
            className="font-semibold text-[#214d2f] underline"
            href={BOOK_TEE_TIME}
          >
            book a tee time
          </Link>{" "}
          without signing in.
        </p>
      </div>
    </BookingShell>
  );
}

// ===== 로그인 ===========================================================

function SignInForm({
  onGuest,
  onRegister,
}: {
  onGuest: () => void;
  onRegister: () => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const ready = email.trim().length > 0 && password.length > 0 && !busy;

  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      await memberSignIn(email, password);
      window.location.assign(BOOK_TEE_TIME);
    } catch (failure) {
      setError(failureText(failure, "Sign-in failed."));
      setBusy(false);
    }
  };

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) void submit();
      }}
    >
      <Field htmlFor="ml-email" label="Email">
        <input
          autoComplete="email"
          className="w-full rounded-sm border border-[#d8d1c3] px-4 py-3 text-base"
          id="ml-email"
          inputMode="email"
          onChange={(event) => setEmail(event.target.value)}
          type="email"
          value={email}
        />
      </Field>
      <Field htmlFor="ml-password" label="Password">
        <input
          autoComplete="current-password"
          className="w-full rounded-sm border border-[#d8d1c3] px-4 py-3 text-base"
          id="ml-password"
          onChange={(event) => setPassword(event.target.value)}
          type="password"
          value={password}
        />
      </Field>
      {error ? <ErrorBox message={error} /> : null}
      <SubmitButton busy={busy} label="Sign in" ready={ready} />
      <p className="text-center text-sm text-[#5c6459]">
        First time?{" "}
        <button
          className="font-semibold text-[#214d2f] underline"
          onClick={onRegister}
          type="button"
        >
          Member sign-up
        </button>{" "}
        or{" "}
        <button
          className="font-semibold text-[#214d2f] underline"
          onClick={onGuest}
          type="button"
        >
          guest sign-up
        </button>
        . Forgot your password? Call the pro shop at {CLUB.phone}.
      </p>
    </form>
  );
}

// ===== 등록 ============================================================

function RegisterForm() {
  const [name, setName] = useState("");
  const [focused, setFocused] = useState(false);
  const [activeHit, setActiveHit] = useState(0);
  const [member, setMember] = useState<PublicMember | null>(null);
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const { hits, loading } = usePublicMemberSearch(
    name,
    focused && member === null,
  );
  const listOpen = focused && member === null && hits.length > 0;
  const activeIndex = activeHit < hits.length ? activeHit : 0;
  const nothingFound =
    member === null && name.trim().length >= 3 && !loading && hits.length === 0;

  const mismatch = confirm.length > 0 && confirm !== password;
  const ready =
    member !== null &&
    email.trim().length > 0 &&
    password.length >= 8 &&
    confirm === password &&
    !busy;

  const pickMember = (hit: PublicMember) => {
    setMember(hit);
    setName(hit.name);
    setError("");
    window.setTimeout(() => document.getElementById("mr-email")?.focus(), 50);
  };

  const submit = async () => {
    if (!member) return;
    setBusy(true);
    setError("");
    try {
      await memberRegister({
        membershipRef: member.ref,
        email,
        phone,
        password,
      });
      window.location.assign(BOOK_TEE_TIME);
    } catch (failure) {
      setError(failureText(failure, "Registration failed."));
      setBusy(false);
    }
  };

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) void submit();
      }}
    >
      <Step done={member !== null} number={1} title="Find your membership">
        <div className="relative">
          <input
            aria-activedescendant={
              listOpen ? `mr-members-${activeIndex}` : undefined
            }
            aria-autocomplete="list"
            aria-controls="mr-members"
            aria-expanded={listOpen}
            aria-label="Your name"
            autoComplete="name"
            className="w-full rounded-sm border border-[#d8d1c3] px-4 py-3 text-base"
            id="mr-name"
            onBlur={() => setFocused(false)}
            onChange={(event) => {
              setName(event.target.value);
              setMember(null);
              setActiveHit(0);
            }}
            onFocus={() => setFocused(true)}
            onKeyDown={(event) => {
              if (!listOpen) return;
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setActiveHit((activeIndex + 1) % hits.length);
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setActiveHit((activeIndex - 1 + hits.length) % hits.length);
              } else if (event.key === "Enter") {
                event.preventDefault();
                pickMember(hits[activeIndex]);
              } else if (event.key === "Escape") {
                setFocused(false);
              }
            }}
            placeholder="Start typing your name"
            role="combobox"
            type="text"
            value={name}
          />
          {listOpen ? (
            <MemberLookupList
              active={activeIndex}
              hits={hits}
              id="mr-members"
              onHover={setActiveHit}
              onPick={pickMember}
            />
          ) : null}
        </div>
        {member ? (
          <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            <span className="rounded-full bg-[#e3f0e6] px-3 py-0.5 font-semibold text-[#2f7d4f]">
              {memberLabel(member)}
            </span>
            <button
              className="font-semibold text-[#214d2f] underline"
              onClick={() => {
                setMember(null);
                setName("");
                window.setTimeout(
                  () => document.getElementById("mr-name")?.focus(),
                  50,
                );
              }}
              type="button"
            >
              Not me
            </button>
          </p>
        ) : nothingFound ? (
          <p className="mt-2 text-sm text-[#8a6f30]">
            No active membership found under that name. Try your last name, or
            call the pro shop at {CLUB.phone}.
          </p>
        ) : (
          <p className="mt-2 text-xs text-[#5c6459]">
            Type at least 3 letters and pick your name from the list.
          </p>
        )}
      </Step>

      {member ? (
        <>
          <Step done={false} number={2} title="Confirm it's you">
            <p className="mb-3 text-sm text-[#5c6459]">
              Use the email or the phone number the pro shop has on file for
              your membership. Your email becomes your sign-in.
            </p>
            <div className="space-y-3">
              <Field htmlFor="mr-email" label="Email">
                <input
                  autoComplete="email"
                  className="w-full rounded-sm border border-[#d8d1c3] px-4 py-3 text-base"
                  id="mr-email"
                  inputMode="email"
                  onChange={(event) => setEmail(event.target.value)}
                  type="email"
                  value={email}
                />
              </Field>
              <Field
                htmlFor="mr-phone"
                label="Phone (if your email isn't on file)"
              >
                <input
                  autoComplete="tel"
                  className="w-full rounded-sm border border-[#d8d1c3] px-4 py-3 text-base"
                  id="mr-phone"
                  inputMode="tel"
                  onChange={(event) => setPhone(event.target.value)}
                  placeholder="(905) 123-4567"
                  type="tel"
                  value={phone}
                />
              </Field>
            </div>
          </Step>

          <Step done={false} number={3} title="Choose a password">
            <div className="space-y-3">
              <Field
                htmlFor="mr-password"
                label="Password (8 or more characters)"
              >
                <input
                  autoComplete="new-password"
                  className="w-full rounded-sm border border-[#d8d1c3] px-4 py-3 text-base"
                  id="mr-password"
                  onChange={(event) => setPassword(event.target.value)}
                  type="password"
                  value={password}
                />
              </Field>
              <Field htmlFor="mr-confirm" label="Password again">
                <input
                  autoComplete="new-password"
                  className="w-full rounded-sm border border-[#d8d1c3] px-4 py-3 text-base"
                  id="mr-confirm"
                  onChange={(event) => setConfirm(event.target.value)}
                  type="password"
                  value={confirm}
                />
              </Field>
              {mismatch ? (
                <p className="text-sm text-[#8a2f2f]">
                  The two passwords are different.
                </p>
              ) : null}
            </div>
          </Step>

          {error ? <ErrorBox message={error} /> : null}
          <SubmitButton
            busy={busy}
            label="Complete registration"
            ready={ready}
          />
        </>
      ) : null}
    </form>
  );
}

// ===== 일반 가입 =========================================================

function GuestForm({ onMember }: { onMember: () => void }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const mismatch = confirm.length > 0 && confirm !== password;
  const ready =
    name.trim().length >= 2 &&
    email.trim().length > 0 &&
    password.length >= 8 &&
    confirm === password &&
    !busy;

  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      await guestRegister({ name, email, phone, password });
      window.location.assign(BOOK_TEE_TIME);
    } catch (failure) {
      setError(failureText(failure, "Sign-up failed."));
      setBusy(false);
    }
  };

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) void submit();
      }}
    >
      <p className="rounded-sm bg-[#f3ead2] p-3 text-sm text-[#5c4a1c]">
        Have a membership?{" "}
        <button
          className="font-semibold underline"
          onClick={onMember}
          type="button"
        >
          Use member sign-up
        </button>{" "}
        to get your member rate.
      </p>
      <Field htmlFor="mg-name" label="Full name">
        <input
          autoComplete="name"
          className="w-full rounded-sm border border-[#d8d1c3] px-4 py-3 text-base"
          id="mg-name"
          onChange={(event) => setName(event.target.value)}
          type="text"
          value={name}
        />
      </Field>
      <Field htmlFor="mg-email" label="Email (your sign-in)">
        <input
          autoComplete="email"
          className="w-full rounded-sm border border-[#d8d1c3] px-4 py-3 text-base"
          id="mg-email"
          inputMode="email"
          onChange={(event) => setEmail(event.target.value)}
          type="email"
          value={email}
        />
      </Field>
      <Field htmlFor="mg-phone" label="Phone (optional)">
        <input
          autoComplete="tel"
          className="w-full rounded-sm border border-[#d8d1c3] px-4 py-3 text-base"
          id="mg-phone"
          inputMode="tel"
          onChange={(event) => setPhone(event.target.value)}
          placeholder="(905) 123-4567"
          type="tel"
          value={phone}
        />
      </Field>
      <Field htmlFor="mg-password" label="Password (8 or more characters)">
        <input
          autoComplete="new-password"
          className="w-full rounded-sm border border-[#d8d1c3] px-4 py-3 text-base"
          id="mg-password"
          onChange={(event) => setPassword(event.target.value)}
          type="password"
          value={password}
        />
      </Field>
      <Field htmlFor="mg-confirm" label="Password again">
        <input
          autoComplete="new-password"
          className="w-full rounded-sm border border-[#d8d1c3] px-4 py-3 text-base"
          id="mg-confirm"
          onChange={(event) => setConfirm(event.target.value)}
          type="password"
          value={confirm}
        />
      </Field>
      {mismatch ? (
        <p className="text-sm text-[#8a2f2f]">
          The two passwords are different.
        </p>
      ) : null}
      {error ? <ErrorBox message={error} /> : null}
      <SubmitButton busy={busy} label="Create account" ready={ready} />
    </form>
  );
}

// ===== 조각 ============================================================

/** 0111 은 사람이 읽는 문장을 보낸다(409 = 이미 등록됨 — 티타임의 "자리가 나갔다" 가 아니다). 연결 실패만 공용 문구로. */
function failureText(failure: unknown, action: string): string {
  return failure instanceof ApiError && failure.status !== 0
    ? failure.message
    : describeFailure(failure, action).message;
}

function Step({
  children,
  done,
  number,
  title,
}: {
  children: ReactNode;
  done: boolean;
  number: number;
  title: string;
}) {
  return (
    <section className="min-w-0">
      <h2 className="mb-2 flex items-center gap-2 text-base font-semibold">
        <span
          aria-hidden
          className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
            done ? "bg-[#2f8a4f] text-white" : "bg-[#ece7da] text-[#3d453d]"
          }`}
        >
          {done ? "✓" : number}
        </span>
        {title}
      </h2>
      {children}
    </section>
  );
}

function Field({
  children,
  htmlFor,
  label,
}: {
  children: ReactNode;
  htmlFor: string;
  label: string;
}) {
  return (
    <div className="min-w-0">
      {/* 입력 글자는 iOS 확대를 막으려고 `text-base` 다(티타임 폼과 같다). */}
      <label
        className="mb-2 block text-sm font-semibold text-[#3d453d]"
        htmlFor={htmlFor}
      >
        {label}
      </label>
      {children}
    </div>
  );
}

function ErrorBox({ message }: { message: string }) {
  return (
    <div className="rounded-sm border border-[#e0b3b3] bg-[#fbeeee] p-4 text-sm font-semibold text-[#8a2f2f]">
      {message}
    </div>
  );
}

function SubmitButton({
  busy,
  label,
  ready,
}: {
  busy: boolean;
  label: string;
  ready: boolean;
}) {
  return (
    <button
      className={`tap-target w-full rounded-full py-3 text-base font-bold text-white transition ${
        ready
          ? "bg-[#2f8a4f] hover:bg-[#256f3f]"
          : "cursor-not-allowed bg-[#a9b0a6]"
      }`}
      disabled={!ready}
      type="submit"
    >
      {busy ? "Please wait…" : label}
    </button>
  );
}
