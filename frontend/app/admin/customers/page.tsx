"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import AdminShell from "@/components/admin/AdminShell";
import {
  STATUS_LABEL,
  typeInfo,
  type MembershipStatus,
  type MembershipType,
} from "@/lib/memberships";
import { ADMIN_HOME } from "@/lib/nav";
import { ApiError } from "@/lib/teeSheet/api";
import { staffRpc } from "@/lib/teeSheet/staffRpc";

/** `pelham_staff_customers()`(0043) 한 줄. 고객 명부(0001) + 가장 최근 시즌 회원권. */
type Customer = {
  customer_ref: string;
  name: string;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  address_line1: string | null;
  city: string | null;
  postal_code: string | null;
  is_member: boolean;
  /** 지난 요금제 이름 그대로("Weekday Member - Single with Weekday Cart"). */
  player_type: string | null;
  member_number: string | null;
  scoring_factor: number | null;
  activation_state: string | null;
  has_credit_card: boolean;
  rounds: number;
  user_created_on: string | null;
  needs_review: boolean;
  review_reasons: string[];
  possible_duplicate_of: string[];
  membership: {
    season: number;
    membership_type: MembershipType;
    plan: "single" | "spousal";
    status: MembershipStatus;
  } | null;
};

/** 폼 칸. `pelham_staff_customer_save`(0054) 의 p 와 같다. */
type CustomerInput = {
  first_name: string;
  last_name: string;
  phone: string;
  email: string;
  address_line1: string;
  city: string;
  postal_code: string;
  member_number: string;
};

const EMPTY_INPUT: CustomerInput = {
  first_name: "",
  last_name: "",
  phone: "",
  email: "",
  address_line1: "",
  city: "",
  postal_code: "",
  member_number: "",
};

const FIELDS: {
  key: keyof CustomerInput;
  label: string;
  wide?: boolean;
  type?: string;
}[] = [
  { key: "first_name", label: "First name" },
  { key: "last_name", label: "Last name" },
  { key: "phone", label: "Phone", type: "tel" },
  { key: "email", label: "Email", type: "email" },
  { key: "address_line1", label: "Address", wide: true },
  { key: "city", label: "City" },
  { key: "postal_code", label: "Postal code" },
  { key: "member_number", label: "Member number" },
];

function inputFrom(c: Customer): CustomerInput {
  return {
    first_name: c.first_name ?? "",
    last_name: c.last_name ?? "",
    phone: formatPhone(c.phone),
    email: c.email ?? "",
    address_line1: c.address_line1 ?? "",
    city: c.city ?? "",
    postal_code: c.postal_code ?? "",
    member_number: c.member_number ?? "",
  };
}

type Filter = "all" | "members" | "public" | "review";

const FILTER_LABEL: Record<Filter, string> = {
  all: "All",
  members: "Members",
  public: "Public",
  review: "Needs review",
};

const REASON_LABEL: Record<string, string> = {
  possible_duplicate: "Possible duplicate",
  duplicate_account: "Duplicate account",
  first_name_missing: "First name missing",
  last_name_missing: "Last name missing",
  email_unparsed: "Email unreadable",
  phone_unparsed: "Phone unreadable",
  postal_unparsed: "Postal code unreadable",
  dob_unparsed: "Birth date unreadable",
};

function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 0)
      return "Can't reach the server. Check the connection and try again.";
    if (
      error.status === 404 &&
      /function|PGRST202|schema cache/i.test(error.message)
    ) {
      return "Customer database function is missing — run migration 0054 in the Supabase SQL Editor.";
    }
    return error.message;
  }
  return (error as Error)?.message ?? "Something went wrong.";
}

function formatPhone(phone: string | null): string {
  const d = (phone ?? "").replace(/\D/g, "");
  return d.length === 10
    ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`
    : (phone ?? "");
}

function membershipLabel(c: Customer): string | null {
  const m = c.membership;
  if (!m) return null;
  return `${m.season} ${typeInfo(m.membership_type)?.label ?? m.membership_type}${m.plan === "spousal" ? " · Spousal" : ""}`;
}

function matches(c: Customer, q: string): boolean {
  if (!q) return true;
  const digits = q.replace(/\D/g, "");
  return (
    [c.name, c.email, c.player_type, c.customer_ref, c.member_number]
      .filter(Boolean)
      .some((v) => v!.toLowerCase().includes(q)) ||
    (digits.length >= 3 && (c.phone ?? "").includes(digits))
  );
}

export default function CustomersPage() {
  const [customers, setCustomers] = useState<Customer[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [selectedRef, setSelectedRef] = useState<string | null>(null);
  /** 열린 폼. ref 가 null 이면 새 고객. */
  const [editing, setEditing] = useState<{
    ref: string | null;
    input: CustomerInput;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    staffRpc<Customer[]>("pelham_staff_customers")
      .then((rows) => {
        if (cancelled) return;
        setCustomers(rows);
        setError(null);
      })
      .catch((err) => {
        if (!cancelled) setError(describeError(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function openForm(ref: string | null, input: CustomerInput) {
    setEditing({ ref, input });
    setSaveError(null);
  }

  // 매니저 PIN 은 서버가 요구한다(0054) — staffRpc 가 PIN 창을 띄우고 승인 뒤 다시 보낸다.
  async function save() {
    if (!editing || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const saved = await staffRpc<{ customer_ref: string }>(
        "pelham_staff_customer_save",
        {
          p_ref: editing.ref,
          p: editing.input,
        },
      );
      const rows = await staffRpc<Customer[]>("pelham_staff_customers");
      setCustomers(rows);
      setSelectedRef(saved.customer_ref);
      if (!editing.ref) {
        setFilter("all");
        setQuery("");
      }
      setEditing(null);
    } catch (err) {
      setSaveError(describeError(err));
    } finally {
      setSaving(false);
    }
  }

  const all = useMemo(() => customers ?? [], [customers]);
  const counts = useMemo(
    () => ({
      all: all.length,
      members: all.filter((c) => c.is_member).length,
      public: all.filter((c) => !c.is_member).length,
      review: all.filter((c) => c.needs_review).length,
    }),
    [all],
  );

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return all.filter((c) => {
      if (filter === "members" && !c.is_member) return false;
      if (filter === "public" && c.is_member) return false;
      if (filter === "review" && !c.needs_review) return false;
      return matches(c, q);
    });
  }, [all, filter, query]);

  const selected =
    all.find((c) => c.customer_ref === selectedRef) ?? visible[0] ?? null;
  const totalRounds = all.reduce((sum, c) => sum + c.rounds, 0);

  return (
    <AdminShell
      actions={
        <>
          <button
            className="tap-target mr-2 border border-[#4533ff] bg-white px-4 py-1.5 text-xs font-bold text-[#4533ff]"
            onClick={() => openForm(null, EMPTY_INPUT)}
            type="button"
          >
            + New customer
          </button>
          <Link
            className="tap-target bg-[#4533ff] px-4 py-1.5 text-xs font-bold text-white"
            href={ADMIN_HOME}
          >
            Tee Sheet
          </Link>
        </>
      }
      title="Customers"
    >
      <div className="grid min-w-0 grid-rows-[auto_1fr]">
        <section className="border-b border-[#d4d4d8] bg-white px-4 py-3">
          <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
            <div className="flex flex-wrap items-center gap-3 text-xs">
              <span className="rounded bg-[#111315] px-2 py-1 text-white">
                {counts.all} Customers
              </span>
              <span>{counts.members} Members</span>
              <span>{totalRounds.toLocaleString()} Rounds</span>
              <span>{visible.length} Visible</span>
            </div>
            <div className="flex flex-wrap gap-2">
              <input
                className="w-72 border border-[#cfd2d8] bg-white px-3 py-1.5 text-xs outline-none focus:border-[#4533ff]"
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search name, phone, email, plan"
                value={query}
              />
              {(Object.keys(FILTER_LABEL) as Filter[]).map((item) => (
                <button
                  className={`inline-flex min-h-11 items-center border px-3 text-xs font-bold lg:min-h-0 lg:py-1.5 ${
                    filter === item
                      ? "border-[#4533ff] bg-[#4533ff] text-white"
                      : "border-[#cfd2d8] bg-white"
                  }`}
                  key={item}
                  onClick={() => setFilter(item)}
                >
                  {FILTER_LABEL[item]} {counts[item]}
                </button>
              ))}
            </div>
          </div>
        </section>

        <section className="grid min-h-0 gap-4 p-4 xl:grid-cols-[1fr_360px]">
          <div className="min-w-0 overflow-x-auto border border-[#d4d4d8] bg-white">
            <div className="min-w-[720px]">
              <div className="grid grid-cols-[1.2fr_1fr_.8fr_.5fr] border-b border-[#d4d4d8] bg-[#f7f7f8] px-3 py-2 text-[11px] font-bold uppercase text-[#5d6673]">
                <span>Customer</span>
                <span>Membership</span>
                <span>Last plan</span>
                <span className="text-right">Rounds</span>
              </div>
              {error ? (
                <p className="px-3 py-8 text-center text-sm text-[#b42318]">
                  {error}
                </p>
              ) : customers === null ? (
                <p className="px-3 py-8 text-center text-sm text-[#5d6673]">
                  Loading customers…
                </p>
              ) : visible.length === 0 ? (
                <p className="px-3 py-8 text-center text-sm text-[#5d6673]">
                  {all.length === 0
                    ? "No customers on file yet."
                    : "No one matches."}
                </p>
              ) : (
                <div className="divide-y divide-[#e2e4e8]">
                  {visible.map((c) => (
                    <button
                      className={`grid w-full grid-cols-[1.2fr_1fr_.8fr_.5fr] items-center px-3 py-3 text-left text-xs hover:bg-[#f4f5ff] ${
                        selected?.customer_ref === c.customer_ref
                          ? "bg-[#f4f5ff]"
                          : "bg-white"
                      }`}
                      key={c.customer_ref}
                      onClick={() => setSelectedRef(c.customer_ref)}
                    >
                      <span className="min-w-0">
                        <strong className="block text-sm">
                          {c.name || c.customer_ref}
                        </strong>
                        <span className="block text-[#5d6673]">
                          {formatPhone(c.phone)}
                        </span>
                        <span className="block truncate text-[#5d6673]">
                          {c.email}
                        </span>
                      </span>
                      <span className="flex flex-wrap gap-1">
                        <span
                          className={`px-2 py-1 text-[11px] font-bold ${
                            c.is_member
                              ? "bg-[#dff7e8] text-[#087333]"
                              : "bg-[#ececf0] text-[#4e5560]"
                          }`}
                        >
                          {c.is_member ? "Member" : "Public"}
                        </span>
                        {membershipLabel(c) && (
                          <span className="border border-[#d4d4d8] px-2 py-1 text-[11px]">
                            {membershipLabel(c)}
                          </span>
                        )}
                        {c.needs_review && (
                          <span className="bg-[#ffd400] px-2 py-1 text-[11px] font-bold text-[#1d232b]">
                            Review
                          </span>
                        )}
                      </span>
                      <span className="pr-2 text-[#5d6673]">
                        {c.is_member ? c.player_type : ""}
                      </span>
                      <span className="text-right text-sm font-bold">
                        {c.rounds}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {selected && (
            <aside className="border border-[#d4d4d8] bg-white p-4">
              <div className="mb-4 flex items-start justify-between gap-2">
                <div>
                  <p className="text-[11px] font-bold uppercase text-[#5d6673]">
                    Customer File · {selected.customer_ref}
                  </p>
                  <p className="text-xl font-bold">
                    {selected.name || selected.customer_ref}
                  </p>
                </div>
                <div className="flex flex-col items-end gap-2">
                  <span
                    className={`px-2 py-1 text-[11px] font-bold ${
                      selected.is_member
                        ? "bg-[#dff7e8] text-[#087333]"
                        : "bg-[#ececf0] text-[#4e5560]"
                    }`}
                  >
                    {selected.is_member ? "Member" : "Public"}
                  </span>
                  <button
                    className="inline-flex min-h-11 items-center border border-[#cfd2d8] bg-white px-3 text-xs font-bold hover:border-[#4533ff] lg:min-h-0 lg:py-1.5"
                    onClick={() =>
                      openForm(selected.customer_ref, inputFrom(selected))
                    }
                    type="button"
                  >
                    Edit
                  </button>
                </div>
              </div>
              <dl className="grid gap-3 text-xs">
                <div>
                  <dt className="font-bold text-[#5d6673]">Contact</dt>
                  <dd>{formatPhone(selected.phone) || "—"}</dd>
                  <dd>{selected.email || "—"}</dd>
                  {selected.address && (
                    <dd>
                      {selected.address}
                      {selected.postal_code ? ` ${selected.postal_code}` : ""}
                    </dd>
                  )}
                </div>
                <div>
                  <dt className="font-bold text-[#5d6673]">Membership</dt>
                  <dd>
                    {selected.membership
                      ? `${membershipLabel(selected)} · ${STATUS_LABEL[selected.membership.status]}`
                      : "No membership on file"}
                  </dd>
                  {selected.player_type && (
                    <dd className="text-[#5d6673]">
                      Last plan: {selected.player_type}
                    </dd>
                  )}
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <div className="bg-[#f7f7f8] p-3">
                    <dt className="font-bold text-[#5d6673]">Rounds</dt>
                    <dd className="text-lg font-bold">{selected.rounds}</dd>
                  </div>
                  <div className="bg-[#f7f7f8] p-3">
                    <dt className="font-bold text-[#5d6673]">Index</dt>
                    <dd className="text-lg font-bold">
                      {selected.scoring_factor ?? "—"}
                    </dd>
                  </div>
                  <div className="bg-[#f7f7f8] p-3">
                    <dt className="font-bold text-[#5d6673]">Card</dt>
                    <dd className="text-lg font-bold">
                      {selected.has_credit_card ? "On file" : "—"}
                    </dd>
                  </div>
                </div>
                <div>
                  <dt className="font-bold text-[#5d6673]">Account</dt>
                  <dd className="capitalize">
                    {selected.activation_state ?? "—"}
                  </dd>
                  {selected.user_created_on && (
                    <dd className="text-[#5d6673]">
                      Since {selected.user_created_on}
                    </dd>
                  )}
                </div>
                {selected.needs_review && (
                  <div>
                    <dt className="font-bold text-[#5d6673]">Needs review</dt>
                    <dd className="mt-1 border-l-4 border-[#ffd400] bg-[#fffbe6] p-3">
                      {selected.review_reasons
                        .map((r) => REASON_LABEL[r] ?? r)
                        .join(", ") || "Check this record"}
                      {selected.possible_duplicate_of.length > 0 && (
                        <>
                          <br />
                          Same person as:{" "}
                          {selected.possible_duplicate_of.join(", ")}
                        </>
                      )}
                    </dd>
                  </div>
                )}
              </dl>
            </aside>
          )}
        </section>
      </div>

      {editing && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4">
          <form
            className="w-full max-w-lg border border-[#d4d4d8] bg-white p-5 shadow-xl"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <p className="text-[11px] font-bold uppercase text-[#5d6673]">
              {editing.ref ? `Customer File · ${editing.ref}` : "New customer"}
            </p>
            <p className="mb-4 text-lg font-bold">
              {editing.ref ? "Edit customer" : "Add a customer"}
            </p>
            <div className="grid grid-cols-2 gap-3">
              {FIELDS.map((f) => (
                <label
                  className={`grid gap-1 text-xs font-bold text-[#5d6673] ${f.wide ? "col-span-2" : ""}`}
                  key={f.key}
                >
                  {f.label}
                  <input
                    autoFocus={f.key === "first_name"}
                    className="border border-[#cfd2d8] bg-white px-3 py-2 text-sm font-normal text-[#111315] outline-none focus:border-[#4533ff]"
                    onChange={(event) =>
                      setEditing(
                        (cur) =>
                          cur && {
                            ...cur,
                            input: {
                              ...cur.input,
                              [f.key]: event.target.value,
                            },
                          },
                      )
                    }
                    type={f.type ?? "text"}
                    value={editing.input[f.key]}
                  />
                </label>
              ))}
            </div>
            <p className="mt-3 text-[11px] text-[#5d6673]">
              A manager PIN is needed to save.
            </p>
            {saveError && (
              <p className="mt-2 text-xs text-[#b42318]">{saveError}</p>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button
                className="min-h-11 border border-[#cfd2d8] bg-white px-4 text-xs font-bold lg:min-h-0 lg:py-2"
                disabled={saving}
                onClick={() => setEditing(null)}
                type="button"
              >
                Cancel
              </button>
              <button
                className="min-h-11 bg-[#4533ff] px-4 text-xs font-bold text-white disabled:opacity-50 lg:min-h-0 lg:py-2"
                disabled={saving}
                type="submit"
              >
                {saving
                  ? "Saving…"
                  : editing.ref
                    ? "Save changes"
                    : "Add customer"}
              </button>
            </div>
          </form>
        </div>
      )}
    </AdminShell>
  );
}
