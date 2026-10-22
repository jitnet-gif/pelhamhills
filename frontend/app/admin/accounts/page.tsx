"use client";

/**
 * 계정 설정(Account Setup) — 로그인 계정을 만들고, 이메일·비밀번호·권한을 고치고, 지운다(0074).
 *
 * 계정 관리자(지금은 Emmeline 의 admin@pelhamhills.ca)에게만 메뉴가 뜨고(`lib/accounts.ts`), 주소로 들어와도
 * 다른 계정에는 이유만 보여 준다. 막는 것은 서버다.
 *
 * 비밀번호는 보여 줄 수 없다 — 서버에 해시만 있다. 그래서 "새 비밀번호 정하기"만 있다.
 */

import { useEffect, useMemo, useState, type FormEvent } from "react";

import AdminShell from "@/components/admin/AdminShell";
import { Button, Chip, EmptyNote, ErrorNote, Field, Modal, SkeletonRows, TextInput } from "@/components/retail/ui";
import { accountsApi, describeAccountError, useAccountsAccess, type Account, type AccountInput } from "@/lib/accounts";
import { clubDateTime } from "@/lib/lostItems";
import { getSession } from "@/lib/teeSheet/session";

const FILTERS = [
  { key: "staff", label: "Staff" },
  { key: "other", label: "Other sign-ins" },
  { key: "all", label: "All" },
] as const;

type FilterKey = (typeof FILTERS)[number]["key"];

function matches(filter: FilterKey, row: Account): boolean {
  if (filter === "all") return true;
  return filter === "staff" ? row.staff : !row.staff;
}

const BLANK: AccountInput = { id: null, email: "", password: "", staff: true, reports: false };

export default function AccountsPage() {
  return (
    <AdminShell title="Account Setup">
      <AccountsGate />
    </AdminShell>
  );
}

/** AdminShell 이 로그인을 확인한 뒤에야 그려진다 — 세션의 이메일을 바로 읽어도 된다. */
function AccountsGate() {
  const allowed = useAccountsAccess(getSession()?.email ?? "");
  // 막힌 이유를 서버에게 한 번 더 묻는다 — 0074 를 아직 안 돌렸는지, 명단 밖인지가 다르다.
  const [reason, setReason] = useState<string | null>(null);

  useEffect(() => {
    if (allowed !== false) return;
    let cancelled = false;
    accountsApi
      .list()
      .then(() => {
        if (!cancelled) setReason(null);
      })
      .catch((err) => {
        if (!cancelled) setReason(describeAccountError(err));
      });
    return () => {
      cancelled = true;
    };
  }, [allowed]);

  if (allowed === null) return <p className="p-4 text-sm text-[#4e5560]">확인 중…</p>;
  if (!allowed) {
    return (
      <div className="mx-auto grid max-w-md gap-3 p-4">
        <div className="bg-white p-5 text-sm shadow-sm">
          <p className="font-bold">Account Setup is for Emmeline&apos;s account only.</p>
          <p className="mt-2 text-[#6b7280]">Sign out and sign in with Emmeline&apos;s ID to manage accounts.</p>
          {reason ? <p className="mt-3 text-[#8a1f1f]">{reason}</p> : null}
        </div>
      </div>
    );
  }
  return <AccountsManager />;
}

function AccountsManager() {
  const [rows, setRows] = useState<Account[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterKey>("staff");
  const [query, setQuery] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editing, setEditing] = useState<AccountInput | null>(null);

  // 저장하면 하나 올려서 목록을 다시 읽는다.
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    accountsApi
      .list()
      .then((value) => {
        if (cancelled) return;
        setRows(value);
        setError(null);
      })
      .catch((err) => {
        if (!cancelled) setError(describeAccountError(err));
      });
    return () => {
      cancelled = true;
    };
  }, [version]);

  const remove = async (row: Account) => {
    if (!window.confirm(`Delete ${row.email}? They won't be able to sign in. This can't be undone.`)) return;
    setBusyId(row.id);
    try {
      await accountsApi.remove(row.id);
      setRows((current) => (current ?? []).filter((item) => item.id !== row.id));
      setError(null);
    } catch (err) {
      setError(describeAccountError(err));
    } finally {
      setBusyId(null);
    }
  };

  const counts = useMemo(() => {
    const out = Object.fromEntries(FILTERS.map((f) => [f.key, 0])) as Record<FilterKey, number>;
    for (const row of rows ?? []) for (const f of FILTERS) if (matches(f.key, row)) out[f.key] += 1;
    return out;
  }, [rows]);

  const needle = query.trim().toLowerCase();
  const visible = (rows ?? []).filter((row) => matches(filter, row) && (!needle || row.email.includes(needle)));

  return (
    <div className="grid min-w-0 gap-3 p-4">
      <section className="grid gap-2 border border-[#d4d4d8] bg-white p-3 text-sm text-[#3f434a]">
        <p>
          Every sign-in for this site is listed here. <b>Staff</b> opens the admin screens; <b>Reports</b> also shows
          Reports with cash.
        </p>
        <p className="text-[#6b7280]">
          Passwords are stored encrypted and can&apos;t be shown. To give someone a password, set a new one with Edit.
        </p>
        <div>
          <Button onClick={() => setEditing({ ...BLANK })} tone="primary">
            New account
          </Button>
        </div>
      </section>

      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map((item) => (
          <Chip active={filter === item.key} key={item.key} onClick={() => setFilter(item.key)}>
            {item.label}
            {rows ? <span className="ml-1.5 tabular-nums opacity-70">{counts[item.key]}</span> : null}
          </Chip>
        ))}
        <TextInput
          aria-label="Search by email"
          className="max-w-xs"
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search email"
          type="search"
          value={query}
        />
      </div>

      {error ? <ErrorNote>{error}</ErrorNote> : null}

      {rows === null ? (
        error ? null : <SkeletonRows />
      ) : visible.length === 0 ? (
        <EmptyNote>No accounts here.</EmptyNote>
      ) : (
        <div className="grid gap-2 lg:grid-cols-2">
          {visible.map((row) => (
            <AccountRow
              busy={busyId === row.id}
              key={row.id}
              onDelete={() => void remove(row)}
              onEdit={() =>
                setEditing({ id: row.id, email: row.email, password: "", staff: row.staff, reports: row.reports })
              }
              row={row}
            />
          ))}
        </div>
      )}

      {editing ? (
        <EditorModal
          initial={editing}
          isMe={rows?.some((row) => row.id === editing.id && row.is_me) ?? false}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            setVersion((value) => value + 1);
          }}
        />
      ) : null}
    </div>
  );
}

function AccountRow({
  row,
  busy,
  onEdit,
  onDelete,
}: {
  row: Account;
  busy: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <section className="grid gap-2 border border-[#d4d4d8] bg-white p-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 font-bold break-all">{row.email}</p>
        {row.is_me ? <Badge>You</Badge> : null}
        {row.staff ? <Badge>Staff</Badge> : null}
        {row.reports ? <Badge>Reports</Badge> : null}
        {row.account_admin ? <Badge>Account manager</Badge> : null}
        {!row.confirmed ? <Badge>Email not confirmed</Badge> : null}
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-sm">
        <dt className="text-[#6b7280]">Last sign-in</dt>
        <dd>{row.last_sign_in_at ? clubDateTime(row.last_sign_in_at) : "Never"}</dd>
        <dt className="text-[#6b7280]">Created</dt>
        <dd>{clubDateTime(row.created_at)}</dd>
      </dl>
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy} onClick={onEdit} tone="primary">
          Edit
        </Button>
        {row.is_me ? null : (
          <Button disabled={busy} onClick={onDelete} tone="danger">
            Delete
          </Button>
        )}
      </div>
    </section>
  );
}

function Badge({ children }: { children: string }) {
  return <span className="bg-[#eef0ff] px-2 py-0.5 text-xs font-bold text-[#3626d6]">{children}</span>;
}

function EditorModal({
  initial,
  isMe,
  onClose,
  onSaved,
}: {
  initial: AccountInput;
  isMe: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<AccountInput>(initial);
  const [showPassword, setShowPassword] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isNew = initial.id === null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      await accountsApi.save(draft);
      onSaved();
    } catch (err) {
      setError(describeAccountError(err));
      setSaving(false);
    }
  };

  return (
    <Modal onClose={onClose} title={isNew ? "New account" : "Edit account"}>
      <form className="grid gap-3" onSubmit={submit}>
        <Field label="Email (sign-in ID)">
          <TextInput
            autoComplete="off"
            autoFocus
            onChange={(event) => setDraft({ ...draft, email: event.target.value })}
            required
            type="email"
            value={draft.email}
          />
        </Field>
        <Field
          hint={isNew ? "At least 8 characters." : "Leave blank to keep the current password. Changing it signs them out on other devices."}
          label={isNew ? "Password" : "New password"}
        >
          <div className="flex gap-2">
            <TextInput
              autoComplete="new-password"
              className="min-w-0 flex-1"
              minLength={8}
              onChange={(event) => setDraft({ ...draft, password: event.target.value })}
              required={isNew}
              type={showPassword ? "text" : "password"}
              value={draft.password}
            />
            <Button onClick={() => setShowPassword((value) => !value)} type="button">
              {showPassword ? "Hide" : "Show"}
            </Button>
          </div>
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input
            checked={draft.staff}
            disabled={isMe}
            onChange={(event) => setDraft({ ...draft, staff: event.target.checked })}
            type="checkbox"
          />
          <span>
            <b>Staff</b> — can sign in to the admin screens
          </span>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            checked={draft.reports}
            onChange={(event) => setDraft({ ...draft, reports: event.target.checked })}
            type="checkbox"
          />
          <span>
            <b>Reports</b> — sees Reports, including cash
          </span>
        </label>
        {error ? <ErrorNote>{error}</ErrorNote> : null}
        <Button disabled={saving} full tone="primary" type="submit">
          {saving ? "Saving…" : isNew ? "Create account" : "Save"}
        </Button>
      </form>
    </Modal>
  );
}
