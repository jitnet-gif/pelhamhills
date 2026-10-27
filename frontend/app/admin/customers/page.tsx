"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import AdminShell from "@/components/admin/AdminShell";
import {
  CART_PACKAGES,
  CREDIT_CARD_SURCHARGE,
  GOLF_MEMBERSHIP_TYPES,
  MEMBERSHIP_TYPES,
  PAYMENT_METHODS,
  STATUS_LABEL,
  draftFromRatePlan,
  listPrice,
  money,
  paymentMethodLabel,
  typeInfo,
  type CartPackage,
  type MembershipPlan,
  type MembershipStatus,
  type MembershipType,
} from "@/lib/memberships";
import { billActions, getBillState, requestSaleView } from "@/lib/pos/currentBill";
import { CLUB_TIME_ZONE } from "@/lib/retail/receipt";
import { computeTax, formatMoney, TAX_RATE } from "@/lib/retail/types";
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
  /** 가장 최근 시즌 회원권(취소 제외). id 부터는 0063 이 더한 칸 — 0063 전에는 없다. */
  membership: {
    season: number;
    membership_type: MembershipType;
    plan: MembershipPlan;
    status: MembershipStatus;
    id?: string;
    cart_package?: CartPackage | null;
    /** 0072 의 고객 목록 JSON 에는 아직 없다 — 없으면 false 로 본다. */
    range_pass?: boolean;
    member_name?: string | null;
    member_number?: string | null;
    phone?: string | null;
    email?: string | null;
    address?: string | null;
    postal_code?: string | null;
    amount_due?: number;
    amount_paid?: number;
    rate_plan?: string | null;
    /** 0072. 'YYYY-MM-DD' 또는 null(시작일 없음). */
    starts_on?: string | null;
    /** 0069. 'YYYY-MM-DD' 또는 null(만료일 없음). expired 는 오늘 클럽 날짜보다 앞이면 참. */
    expires_on?: string | null;
    expired?: boolean;
    /** 0070. PAYMENT_METHODS 중 하나 또는 null. */
    payment_method?: string | null;
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

/** 폼의 회원권 칸. `pelham_staff_customer_save`(0063) 의 p.membership 과 같다. 종류 "" 는 회원권 없음. */
type MembershipInput = {
  season: number;
  membership_type: MembershipType | "";
  plan: MembershipPlan;
  cart_package: CartPackage | "";
  status: "pending" | "active";
  /** 'YYYY-MM-DD', "" 는 시작일 없음(0072). */
  starts_on: string;
  /** 'YYYY-MM-DD', "" 는 만료일 없음(0069). */
  expires_on: string;
  /** PAYMENT_METHODS 중 하나, "" 는 아직 모름(0070). */
  payment_method: string;
};

/** 클럽 현지 연도. */
function clubYear(): number {
  return Number(
    new Date()
      .toLocaleDateString("en-CA", { timeZone: CLUB_TIME_ZONE })
      .slice(0, 4),
  );
}

/** 이름이 display_name 한 칸에만 있는 옛 명부 줄은 첫 단어 / 나머지로 나눠 채운다. */
function splitName(name: string | null | undefined): [string, string] {
  const words = (name ?? "").trim().split(/\s+/).filter(Boolean);
  return [words[0] ?? "", words.slice(1).join(" ")];
}

function inputFrom(c: Customer): CustomerInput {
  const m = c.membership;
  let first = c.first_name?.trim() ?? "";
  let last = c.last_name?.trim() ?? "";
  if (!first && !last) {
    [first, last] = splitName(c.name || m?.member_name);
  }
  const hasAddress = !!(c.address_line1?.trim() || c.city?.trim());
  return {
    first_name: first,
    last_name: last,
    phone: formatPhone(c.phone || m?.phone || null),
    email: c.email || m?.email || "",
    address_line1: hasAddress ? (c.address_line1 ?? "") : (m?.address ?? ""),
    city: c.city ?? "",
    postal_code: c.postal_code || m?.postal_code || "",
    member_number: c.member_number || m?.member_number || "",
  };
}

/**
 * 폼을 열 때의 회원권. 회원권 줄이 있으면 그것, 없는데 옛 명부가 회원이면 지난 요금제 이름으로 초안을 만든다.
 * `dirty` 가 참이면 저장할 때 회원권도 보낸다 — 초안은 처음부터 참(저장하면 회원권 줄이 생긴다).
 */
function membershipFrom(c: Customer | null): {
  input: MembershipInput;
  dirty: boolean;
} {
  const m = c?.membership;
  if (m) {
    return {
      input: {
        season: m.season,
        membership_type: m.membership_type,
        plan: m.plan,
        cart_package: m.cart_package ?? "",
        status: m.status === "active" ? "active" : "pending",
        starts_on: m.starts_on ?? "",
        expires_on: m.expires_on ?? "",
        payment_method: m.payment_method ?? "",
      },
      dirty: false,
    };
  }
  const draft = c?.is_member ? draftFromRatePlan(c.player_type) : null;
  return {
    input: {
      season: clubYear(),
      membership_type: draft?.membership_type ?? "",
      plan: draft?.plan ?? "single",
      cart_package: draft?.cart_package ?? "",
      status: "active",
      starts_on: "",
      expires_on: "",
      payment_method: "",
    },
    dirty: !!draft?.membership_type,
  };
}

type Filter = "all" | "members" | "public" | "review";

const FILTER_LABEL: Record<Filter, string> = {
  all: "All",
  members: "Members",
  public: "Public",
  review: "Needs review",
};

type Sort = "rounds" | "last" | "first";

const SORT_LABEL: Record<Sort, string> = {
  rounds: "Most rounds",
  last: "Last name",
  first: "First name",
};

/** 정렬용 이름. first/last 가 비어 있는 옛 줄은 display_name 을 나눠 쓴다. */
function sortName(c: Customer, key: "last" | "first"): string {
  const [first, last] =
    c.first_name?.trim() || c.last_name?.trim()
      ? [c.first_name?.trim() ?? "", c.last_name?.trim() ?? ""]
      : splitName(c.name);
  return (key === "last" ? `${last} ${first}` : `${first} ${last}`)
    .trim()
    .toLowerCase();
}

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

/** '2026-10-31' → 'Oct 31, 2026'. */
function formatDate(iso: string): string {
  return new Date(`${iso}T12:00:00`).toLocaleDateString("en-CA", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
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
  const [sort, setSort] = useState<Sort>("rounds");
  const [selectedRef, setSelectedRef] = useState<string | null>(null);
  /** 좁은 화면에서 줄을 누르면 고객 파일을 창으로 연다(넓은 화면은 오른쪽 칸에 보인다). */
  const [viewingRef, setViewingRef] = useState<string | null>(null);
  /** 열린 폼. ref 가 null 이면 새 고객. */
  const [editing, setEditing] = useState<{
    ref: string | null;
    input: CustomerInput;
    membership: MembershipInput;
    /** 원래 회원권. 금액 안내에 쓴다. */
    current: Customer["membership"];
    membershipDirty: boolean;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  /** Sell membership 창을 연 고객. */
  const [sellingRef, setSellingRef] = useState<string | null>(null);
  /** 지우는 중인 고객. */
  const [deletingRef, setDeletingRef] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

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

  function openForm(c: Customer | null) {
    setViewingRef(null);
    const m = membershipFrom(c);
    setEditing({
      ref: c?.customer_ref ?? null,
      input: c ? inputFrom(c) : EMPTY_INPUT,
      membership: m.input,
      current: c?.membership ?? null,
      membershipDirty: m.dirty,
    });
    setSaveError(null);
  }

  function setMembership(patch: Partial<MembershipInput>) {
    setEditing(
      (cur) =>
        cur && {
          ...cur,
          membership: { ...cur.membership, ...patch },
          membershipDirty: true,
        },
    );
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
          p: editing.membershipDirty
            ? { ...editing.input, membership: editing.membership }
            : editing.input,
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

  // 매니저 PIN 은 서버가 요구한다(0071) — 수정 승인과 따로, 지울 때마다 받는다.
  async function remove(c: Customer) {
    if (deletingRef) return;
    const who = c.name || c.customer_ref;
    const note = c.membership ? " Their membership is kept as cancelled." : "";
    if (
      !window.confirm(
        `Delete ${who} (${c.customer_ref})? This cannot be undone.${note}`,
      )
    )
      return;
    setDeletingRef(c.customer_ref);
    setDeleteError(null);
    try {
      await staffRpc("pelham_staff_customer_delete", { p_ref: c.customer_ref });
      const rows = await staffRpc<Customer[]>("pelham_staff_customers");
      setCustomers(rows);
      if (selectedRef === c.customer_ref) setSelectedRef(null);
      if (viewingRef === c.customer_ref) setViewingRef(null);
    } catch (err) {
      setDeleteError(describeError(err));
    } finally {
      setDeletingRef(null);
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
    const rows = all.filter((c) => {
      if (filter === "members" && !c.is_member) return false;
      if (filter === "public" && c.is_member) return false;
      if (filter === "review" && !c.needs_review) return false;
      return matches(c, q);
    });
    if (sort === "rounds") return rows;
    // 이름 없는 줄은 맨 뒤로 보낸다.
    const keyed = rows.map((c) => ({ c, k: sortName(c, sort) }));
    keyed.sort((a, b) =>
      !a.k || !b.k
        ? Number(!a.k) - Number(!b.k)
        : a.k.localeCompare(b.k, "en", { sensitivity: "base" }),
    );
    return keyed.map((r) => r.c);
  }, [all, filter, query, sort]);

  const selected =
    all.find((c) => c.customer_ref === selectedRef) ?? visible[0] ?? null;
  const viewing = viewingRef
    ? (all.find((c) => c.customer_ref === viewingRef) ?? null)
    : null;
  const selling = sellingRef
    ? (all.find((c) => c.customer_ref === sellingRef) ?? null)
    : null;
  const totalRounds = all.reduce((sum, c) => sum + c.rounds, 0);

  return (
    <AdminShell
      actions={
        <>
          <button
            className="tap-target mr-2 border border-[#4533ff] bg-white px-4 py-1.5 text-xs font-bold text-[#4533ff]"
            onClick={() => openForm(null)}
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
              <select
                aria-label="Sort"
                className="border border-[#cfd2d8] bg-white px-2 py-1.5 text-xs font-bold outline-none focus:border-[#4533ff]"
                onChange={(event) => setSort(event.target.value as Sort)}
                value={sort}
              >
                {(Object.keys(SORT_LABEL) as Sort[]).map((item) => (
                  <option key={item} value={item}>
                    {SORT_LABEL[item]}
                  </option>
                ))}
              </select>
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
            {deleteError && (
              <p className="border-b border-[#d4d4d8] bg-[#fde8e7] px-3 py-2 text-xs text-[#b42318]">
                {deleteError}
              </p>
            )}
            <div className="min-w-[800px]">
              <div className="grid grid-cols-[1.2fr_1fr_.8fr_.5fr_80px] border-b border-[#d4d4d8] bg-[#f7f7f8] px-3 py-2 text-[11px] font-bold uppercase text-[#5d6673]">
                <span>Customer</span>
                <span>Membership</span>
                <span>Last plan</span>
                <span className="text-right">Rounds</span>
                <span />
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
                    <div
                      className={`grid grid-cols-[1fr_80px] items-center hover:bg-[#f4f5ff] ${
                        selected?.customer_ref === c.customer_ref
                          ? "bg-[#f4f5ff]"
                          : "bg-white"
                      }`}
                      key={c.customer_ref}
                    >
                      <button
                        className="grid w-full grid-cols-[1.2fr_1fr_.8fr_.5fr] items-center py-3 pl-3 text-left text-xs"
                        onClick={() => {
                          setSelectedRef(c.customer_ref);
                          if (!window.matchMedia("(min-width: 1280px)").matches)
                            setViewingRef(c.customer_ref);
                        }}
                        type="button"
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
                          {c.membership?.expired && (
                            <span className="bg-[#fde8e7] px-2 py-1 text-[11px] font-bold text-[#b42318]">
                              Expired
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
                      <span className="pr-3 text-right">
                        <button
                          className="inline-flex min-h-11 items-center border border-[#f1b8b3] bg-white px-2 text-[11px] font-bold text-[#b42318] hover:border-[#b42318] disabled:opacity-50 lg:min-h-0 lg:py-1"
                          disabled={deletingRef !== null}
                          onClick={() => void remove(c)}
                          type="button"
                        >
                          {deletingRef === c.customer_ref
                            ? "Deleting…"
                            : "Delete"}
                        </button>
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {selected && (
            <aside className="hidden border border-[#d4d4d8] bg-white p-4 xl:block">
              <CustomerFile
                customer={selected}
                onEdit={() => openForm(selected)}
                onSell={() => setSellingRef(selected.customer_ref)}
              />
            </aside>
          )}
        </section>
      </div>

      {viewing && !editing && (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setViewingRef(null)}
        >
          <div
            className="max-h-full w-full max-w-lg overflow-y-auto border border-[#d4d4d8] bg-white p-5 shadow-xl"
            onClick={(event) => event.stopPropagation()}
          >
            <CustomerFile
              customer={viewing}
              onEdit={() => openForm(viewing)}
              onSell={() => {
                setViewingRef(null);
                setSellingRef(viewing.customer_ref);
              }}
            />
            <div className="mt-4 flex justify-end">
              <button
                className="min-h-11 border border-[#cfd2d8] bg-white px-4 text-xs font-bold lg:min-h-0 lg:py-2"
                onClick={() => setViewingRef(null)}
                type="button"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {selling && (
        <SellMembershipDialog
          customer={selling}
          onClose={() => setSellingRef(null)}
        />
      )}

      {editing && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4">
          <form
            className="max-h-full w-full max-w-lg overflow-y-auto border border-[#d4d4d8] bg-white p-5 shadow-xl"
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
            <MembershipFields
              current={editing.current}
              onChange={setMembership}
              value={editing.membership}
            />
            <p className="mt-3 text-[11px] text-[#5d6673]">
              Your Pelham Shift ID is needed to save.
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

/** 고객 파일 — 넓은 화면의 오른쪽 칸과 좁은 화면의 창이 같이 쓴다. */
function CustomerFile({
  customer,
  onEdit,
  onSell,
}: {
  customer: Customer;
  onEdit: () => void;
  onSell: () => void;
}) {
  return (
    <>
      <div className="mb-4 flex items-start justify-between gap-2">
        <div>
          <p className="text-[11px] font-bold uppercase text-[#5d6673]">
            Customer File · {customer.customer_ref}
          </p>
          <p className="text-xl font-bold">
            {customer.name || customer.customer_ref}
          </p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <span
            className={`px-2 py-1 text-[11px] font-bold ${
              customer.is_member
                ? "bg-[#dff7e8] text-[#087333]"
                : "bg-[#ececf0] text-[#4e5560]"
            }`}
          >
            {customer.is_member ? "Member" : "Public"}
          </span>
          <button
            className="inline-flex min-h-11 items-center border border-[#cfd2d8] bg-white px-3 text-xs font-bold hover:border-[#4533ff] lg:min-h-0 lg:py-1.5"
            onClick={onEdit}
            type="button"
          >
            Edit
          </button>
          <button
            className="inline-flex min-h-11 items-center bg-[#4533ff] px-3 text-xs font-bold text-white hover:bg-[#3626d9] lg:min-h-0 lg:py-1.5"
            onClick={onSell}
            type="button"
          >
            Sell membership
          </button>
        </div>
      </div>
      <dl className="grid gap-3 text-xs">
        <div>
          <dt className="font-bold text-[#5d6673]">Contact</dt>
          <dd>{formatPhone(customer.phone) || "—"}</dd>
          <dd>{customer.email || "—"}</dd>
          {customer.address && (
            <dd>
              {customer.address}
              {customer.postal_code ? ` ${customer.postal_code}` : ""}
            </dd>
          )}
        </div>
        <div>
          <dt className="font-bold text-[#5d6673]">Membership</dt>
          <dd>
            {customer.membership
              ? `${membershipLabel(customer)} · ${STATUS_LABEL[customer.membership.status]}`
              : "No membership on file"}
          </dd>
          {customer.membership && (
            <dd
              className={
                customer.membership.expired
                  ? "font-bold text-[#b42318]"
                  : "text-[#5d6673]"
              }
            >
              {customer.membership.starts_on
                ? `Starts ${formatDate(customer.membership.starts_on)} · `
                : ""}
              {customer.membership.expires_on
                ? `${customer.membership.expired ? "Expired" : "Expires"} ${formatDate(customer.membership.expires_on)}`
                : "No expiry date"}
            </dd>
          )}
          {customer.membership?.payment_method && (
            <dd className="text-[#5d6673]">
              Paid by {paymentMethodLabel(customer.membership.payment_method)}
            </dd>
          )}
          {customer.player_type && (
            <dd className="text-[#5d6673]">
              Last plan: {customer.player_type}
            </dd>
          )}
        </div>
        <div className="grid grid-cols-3 gap-2">
          <div className="bg-[#f7f7f8] p-3">
            <dt className="font-bold text-[#5d6673]">Rounds</dt>
            <dd className="text-lg font-bold">{customer.rounds}</dd>
          </div>
          <div className="bg-[#f7f7f8] p-3">
            <dt className="font-bold text-[#5d6673]">Index</dt>
            <dd className="text-lg font-bold">
              {customer.scoring_factor ?? "—"}
            </dd>
          </div>
          <div className="bg-[#f7f7f8] p-3">
            <dt className="font-bold text-[#5d6673]">Card</dt>
            <dd className="text-lg font-bold">
              {customer.has_credit_card ? "On file" : "—"}
            </dd>
          </div>
        </div>
        <div>
          <dt className="font-bold text-[#5d6673]">Account</dt>
          <dd className="capitalize">{customer.activation_state ?? "—"}</dd>
          {customer.user_created_on && (
            <dd className="text-[#5d6673]">Since {customer.user_created_on}</dd>
          )}
        </div>
        {customer.needs_review && (
          <div>
            <dt className="font-bold text-[#5d6673]">Needs review</dt>
            <dd className="mt-1 border-l-4 border-[#ffd400] bg-[#fffbe6] p-3">
              {customer.review_reasons
                .map((r) => REASON_LABEL[r] ?? r)
                .join(", ") || "Check this record"}
              {customer.possible_duplicate_of.length > 0 && (
                <>
                  <br />
                  Same person as: {customer.possible_duplicate_of.join(", ")}
                </>
              )}
            </dd>
          </div>
        )}
      </dl>
    </>
  );
}

const SELECT_CLASS =
  "border border-[#cfd2d8] bg-white px-3 py-2 text-sm font-normal text-[#111315] outline-none focus:border-[#4533ff]";

/** 편집 폼의 회원권 칸. 티시트는 이 회원권으로 회원 요금제를 고른다(0053). */
function MembershipFields({
  value,
  current,
  onChange,
}: {
  value: MembershipInput;
  current: Customer["membership"];
  onChange: (patch: Partial<MembershipInput>) => void;
}) {
  const year = clubYear();
  const today = new Date().toLocaleDateString("en-CA", {
    timeZone: CLUB_TIME_ZONE,
  });
  const seasons = Array.from(
    new Set([year, year + 1, ...(current ? [current.season] : [])]),
  ).sort();
  const type = value.membership_type ? typeInfo(value.membership_type) : null;
  const price = value.membership_type
    ? listPrice({
        membership_type: value.membership_type,
        plan: value.plan,
        cart_package: value.cart_package || null,
        range_pass: false,
        payment_method: value.payment_method || null,
      })
    : null;
  const sameRow =
    current && current.season === value.season && current.id !== undefined;

  // 연습장 회원권(0125)은 골프 회원권이 아니라 이 칸(고객 저장, 0072)이 받지 않는다. Memberships 화면에서 고친다.
  if (type?.rangeOnly) {
    return (
      <fieldset className="mt-4 border-t border-[#e2e4e8] pt-4">
        <legend className="sr-only">Membership</legend>
        <p className="mb-2 text-xs font-bold text-[#111315]">Membership</p>
        <p className="text-xs text-[#5d6673]">
          {value.season} Driving Range membership (non-member) — not a golf membership, so public green fees apply.
          Change it on{" "}
          <Link className="text-[#4533ff] underline" href="/admin/memberships">
            Memberships
          </Link>
          .
        </p>
      </fieldset>
    );
  }

  return (
    <fieldset className="mt-4 border-t border-[#e2e4e8] pt-4">
      <legend className="sr-only">Membership</legend>
      <p className="mb-2 text-xs font-bold text-[#111315]">Membership</p>
      <div className="grid grid-cols-2 gap-3">
        <label className="grid gap-1 text-xs font-bold text-[#5d6673]">
          Type
          <select
            className={SELECT_CLASS}
            onChange={(event) => {
              const next = event.target.value as MembershipType | "";
              const info = next ? typeInfo(next) : null;
              onChange({
                membership_type: next,
                ...(info && !info.spousal ? { plan: "single" as const } : {}),
              });
            }}
            value={value.membership_type}
          >
            <option value="">Not a member (public)</option>
            {GOLF_MEMBERSHIP_TYPES.map((t) => (
              <option key={t.key} value={t.key}>
                {t.label} — {t.access}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-xs font-bold text-[#5d6673]">
          Season
          <select
            className={SELECT_CLASS}
            onChange={(event) =>
              onChange({ season: Number(event.target.value) })
            }
            value={value.season}
          >
            {seasons.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        {value.membership_type && (
          <>
            <label className="grid gap-1 text-xs font-bold text-[#5d6673]">
              Plan
              <select
                className={SELECT_CLASS}
                disabled={!type?.spousal}
                onChange={(event) =>
                  onChange({ plan: event.target.value as MembershipPlan })
                }
                value={value.plan}
              >
                <option value="single">Single</option>
                {type?.spousal && <option value="spousal">Spousal</option>}
              </select>
            </label>
            <label className="grid gap-1 text-xs font-bold text-[#5d6673]">
              Cart package
              <select
                className={SELECT_CLASS}
                onChange={(event) =>
                  onChange({
                    cart_package: event.target.value as CartPackage | "",
                  })
                }
                value={value.cart_package}
              >
                <option value="">No cart package</option>
                {CART_PACKAGES.map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-xs font-bold text-[#5d6673]">
              Status
              <select
                className={SELECT_CLASS}
                onChange={(event) =>
                  onChange({
                    status: event.target.value as MembershipInput["status"],
                  })
                }
                value={value.status}
              >
                <option value="active">Active — member rates</option>
                <option value="pending">Pending — not paid yet</option>
              </select>
            </label>
            <label className="grid gap-1 text-xs font-bold text-[#5d6673]">
              Starts
              <input
                className={SELECT_CLASS}
                max={value.expires_on || undefined}
                onChange={(event) =>
                  onChange({ starts_on: event.target.value })
                }
                type="date"
                value={value.starts_on}
              />
            </label>
            <label className="grid gap-1 text-xs font-bold text-[#5d6673]">
              Expires
              <input
                className={SELECT_CLASS}
                min={value.starts_on || undefined}
                onChange={(event) =>
                  onChange({ expires_on: event.target.value })
                }
                type="date"
                value={value.expires_on}
              />
            </label>
            <label className="grid gap-1 text-xs font-bold text-[#5d6673]">
              <span>
                Paid by
                {value.payment_method === "Credit card" && (
                  <span className="font-normal">
                    {" "}
                    · +{CREDIT_CARD_SURCHARGE * 100}% card fee
                  </span>
                )}
              </span>
              <select
                className={SELECT_CLASS}
                onChange={(event) =>
                  onChange({ payment_method: event.target.value })
                }
                value={value.payment_method}
              >
                <option value="">—</option>
                {PAYMENT_METHODS.map((m) => (
                  <option key={m} value={m}>
                    {paymentMethodLabel(m)}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
      </div>
      <p className="mt-2 text-[11px] text-[#5d6673]">
        {value.membership_type
          ? sameRow && current?.amount_due !== undefined
            ? `Paid ${money(current.amount_paid ?? 0)} of ${money(current.amount_due)}. `
            : `List price ${money(price ?? 0)} (HST incl.). `
          : current && current.season === value.season
            ? `Saving cancels the ${value.season} ${typeInfo(current.membership_type).label} membership. `
            : "Tee sheet charges public rates. "}
        {value.membership_type &&
          value.expires_on &&
          value.expires_on < today &&
          "This date has passed — the tee sheet charges public rates. "}
        {value.membership_type &&
          "The tee sheet uses this to charge member rates. Record payments on "}
        {value.membership_type && (
          <Link className="font-bold text-[#4533ff]" href="/admin/memberships">
            Memberships
          </Link>
        )}
        {value.membership_type && "."}
      </p>
    </fieldset>
  );
}

// ===== Sell membership (0072) ==========================================

/**
 * Lightspeed 의 회원권 상품 목록처럼 종류 × 플랜 × 카트 × 연습장 이용권을 한 줄씩 편다.
 * 요금표 ADDITIONAL GOLF SERVICES(2026-10-27): 카트 패키지, 회원 연습장 이용권(Full 은 포함이라 없음),
 * 비회원 연습장 회원권(`range`, 카트·이용권 없음).
 */
type MembershipProduct = {
  key: string;
  label: string;
  membership_type: MembershipType;
  plan: MembershipPlan;
  cart_package: CartPackage | null;
  range_pass: boolean;
  /** 요금표 금액(HST 포함). */
  price: number;
};

function productKey(m: { membership_type: string; plan: string; cart_package?: string | null; range_pass?: boolean }) {
  return `${m.membership_type}:${m.plan}:${m.cart_package ?? ""}:${m.range_pass ? "range" : ""}`;
}

const MEMBERSHIP_PRODUCTS: MembershipProduct[] = MEMBERSHIP_TYPES.flatMap((t) => {
  if (t.rangeOnly) {
    const only = { membership_type: t.key, plan: "single" as const, cart_package: null, range_pass: false };
    return [{ ...only, key: productKey(only), label: "Driving Range Membership (Non-member)", price: t.single }];
  }
  return (t.spousal ? (["single", "spousal"] as const) : (["single"] as const)).flatMap((plan) =>
    [null, ...CART_PACKAGES.map((c) => c.key)].flatMap((cart) =>
      (t.rangeIncluded ? [false] : [false, true]).map((range) => {
        const cartName = CART_PACKAGES.find((c) => c.key === cart)?.label;
        const fields = { membership_type: t.key, plan, cart_package: cart, range_pass: range };
        return {
          ...fields,
          key: productKey(fields),
          label: `${t.label} ${plan === "spousal" ? "Spousal" : "Single"} Membership${cartName ? ` with ${cartName}` : ""}${
            range ? " + Range Pass" : ""
          }`,
          price: listPrice(fields),
        };
      }),
    ),
  );
});

/** HST 포함 금액(달러) → 세전 센트. 서버(0072)와 같은 ÷1.13. */
function preTaxCents(inclusive: number): number {
  return Math.round((inclusive * 100) / (1 + TAX_RATE));
}

/**
 * 고객 파일의 Sell membership — Lightspeed 의 Subscriptions → Sell 과 같은 순서:
 * 회원권 고르기 → 기간(끝나는 날) → 요약(세전 + HST) → Register 로 보내 레지스터에서 결제.
 * 결제되면 회원권이 납부(active)로 바뀐다(0072 트리거).
 */
function SellMembershipDialog({
  customer,
  onClose,
}: {
  customer: Customer;
  onClose: () => void;
}) {
  const router = useRouter();
  const current = customer.membership;
  const year = clubYear();
  const today = new Date().toLocaleDateString("en-CA", {
    timeZone: CLUB_TIME_ZONE,
  });
  const [season, setSeason] = useState(current?.season ?? year);
  const [query, setQuery] = useState("");
  const [pick, setPick] = useState<string>(
    current ? productKey(current) : "",
  );
  const [startsOn, setStartsOn] = useState(
    current?.season === season && current.starts_on ? current.starts_on : today,
  );
  const [endsOn, setEndsOn] = useState(
    current?.season === season && current.expires_on ? current.expires_on : `${season}-12-15`,
  );
  /** 신용카드로 받으면 줄 가격에 3% 가 들어간다(신청서 규칙). 레지스터는 신용카드로만 받는다. */
  const [byCard, setByCard] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const seasons = Array.from(
    new Set([year, year + 1, ...(current ? [current.season] : [])]),
  ).sort();
  const q = query.trim().toLowerCase();
  const products = MEMBERSHIP_PRODUCTS.filter((p) => !q || p.label.toLowerCase().includes(q));
  const product = MEMBERSHIP_PRODUCTS.find((p) => p.key === pick) ?? null;
  // 같은 시즌·같은 회원권에 이미 낸 돈이 있으면 남은 금액만 받는다(서버와 같다).
  const samePaid =
    product &&
    current &&
    current.season === season &&
    current.status !== "cancelled" &&
    current.membership_type === product.membership_type &&
    current.plan === product.plan &&
    (current.cart_package ?? null) === product.cart_package &&
    Boolean(current.range_pass) === product.range_pass
      ? Number(current.amount_paid)
      : 0;
  const balanceDue = product ? Math.max(0, Number(product.price) - samePaid) : 0;
  // 서버(0072)와 같은 셈: 남은 금액 × 1.03(카드) ÷ 1.13.
  const due = byCard ? balanceDue * (1 + CREDIT_CARD_SURCHARGE) : balanceDue;
  const subtotal = preTaxCents(due);
  const tax = computeTax(subtotal);
  const cardFee = byCard ? subtotal - preTaxCents(balanceDue) : 0;

  async function send() {
    if (!product) return;
    setSending(true);
    setError(null);
    const bill = await billActions.addMembership({
      customer_ref: customer.customer_ref,
      season,
      membership_type: product.membership_type,
      plan: product.plan,
      cart_package: product.cart_package,
      range_pass: product.range_pass,
      starts_on: startsOn,
      expires_on: endsOn,
      card_fee: byCard,
    });
    setSending(false);
    if (!bill) {
      setError(getBillState().error || "Could not add the membership to the register.");
      return;
    }
    requestSaleView();
    router.push("/admin/retail");
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4">
      <div className="flex max-h-full w-full max-w-2xl flex-col overflow-y-auto border border-[#d4d4d8] bg-white p-5 shadow-xl">
        <p className="text-[11px] font-bold uppercase text-[#5d6673]">Sell membership</p>
        <p className="mb-4 text-xl font-bold">{customer.name || customer.customer_ref}</p>

        <div className="grid gap-3 sm:grid-cols-3">
          <label className="grid gap-1 text-xs font-bold text-[#5d6673]">
            Season
            <select
              className={SELECT_CLASS}
              onChange={(event) => {
                const next = Number(event.target.value);
                setSeason(next);
                setStartsOn(next > year ? `${next}-04-01` : today);
                setEndsOn(`${next}-12-15`);
              }}
              value={season}
            >
              {seasons.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-xs font-bold text-[#5d6673]">
            Start
            <input
              className={SELECT_CLASS}
              max={endsOn || undefined}
              onChange={(event) => setStartsOn(event.target.value)}
              type="date"
              value={startsOn}
            />
          </label>
          <label className="grid gap-1 text-xs font-bold text-[#5d6673]">
            End
            <input
              className={SELECT_CLASS}
              min={startsOn > today ? startsOn : today}
              onChange={(event) => setEndsOn(event.target.value)}
              type="date"
              value={endsOn}
            />
          </label>
        </div>

        <p className="mt-4 mb-1 text-xs font-bold text-[#5d6673]">Membership</p>
        <input
          className={`${SELECT_CLASS} w-full`}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search"
          type="search"
          value={query}
        />
        <ul className="mt-2 max-h-64 overflow-y-auto border border-[#e2e4e8]" role="listbox">
          {products.map((p) => (
            <li key={p.key}>
              <button
                aria-selected={p.key === pick}
                className={`flex w-full items-center justify-between gap-3 border-b border-[#eef0f2] px-3 py-2 text-left text-sm ${
                  p.key === pick ? "bg-[#4533ff] font-bold text-white" : "hover:bg-[#f4f4ff]"
                }`}
                onClick={() => setPick(p.key)}
                role="option"
                type="button"
              >
                <span>{p.label}</span>
                <span className="shrink-0 tabular-nums">{formatMoney(preTaxCents(p.price))}</span>
              </button>
            </li>
          ))}
          {products.length === 0 && <li className="px-3 py-2 text-sm text-[#5d6673]">No match</li>}
        </ul>

        <fieldset className="mt-4 grid gap-1">
          <legend className="mb-1 text-xs font-bold text-[#5d6673]">Paying by</legend>
          <div className="grid grid-cols-2 gap-2">
            {[
              { card: false, label: "Cash, debit or cheque" },
              { card: true, label: "Credit card (+3%)" },
            ].map((option) => (
              <button
                aria-pressed={byCard === option.card}
                className={`min-h-11 border px-3 text-xs font-bold lg:min-h-0 lg:py-2 ${
                  byCard === option.card
                    ? "border-[#4533ff] bg-[#4533ff] text-white"
                    : "border-[#cfd2d8] bg-white hover:border-[#4533ff]"
                }`}
                key={option.label}
                onClick={() => setByCard(option.card)}
                type="button"
              >
                {option.label}
              </button>
            ))}
          </div>
        </fieldset>

        <dl className="mt-4 grid gap-1 border-t border-[#e2e4e8] pt-3 text-sm">
          {cardFee > 0 && (
            <div className="flex justify-between text-[#5d6673]">
              <dt>Includes 3% credit card fee</dt>
              <dd className="tabular-nums">{formatMoney(cardFee)}</dd>
            </div>
          )}
          <div className="flex justify-between">
            <dt>Subtotal</dt>
            <dd className="tabular-nums">{formatMoney(subtotal)}</dd>
          </div>
          <div className="flex justify-between">
            <dt>HST</dt>
            <dd className="tabular-nums">{formatMoney(tax)}</dd>
          </div>
          <div className="flex justify-between text-base font-bold">
            <dt>Total</dt>
            <dd className="tabular-nums">{formatMoney(subtotal + tax)}</dd>
          </div>
          {samePaid > 0 && (
            <dd className="text-xs text-[#5d6673]">
              {money(samePaid)} already paid on this membership — only the balance goes to the register.
            </dd>
          )}
        </dl>

        {error && (
          <p className="mt-3 border-l-4 border-[#b42318] bg-[#fff1f0] p-3 text-xs text-[#b42318]">{error}</p>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button
            className="min-h-11 border border-[#cfd2d8] bg-white px-4 text-xs font-bold lg:min-h-0 lg:py-2"
            onClick={onClose}
            type="button"
          >
            Cancel
          </button>
          <button
            className="min-h-11 bg-[#4533ff] px-4 text-xs font-bold text-white disabled:opacity-50 lg:min-h-0 lg:py-2"
            disabled={!product || due <= 0 || !endsOn || !startsOn || startsOn > endsOn || sending}
            onClick={() => void send()}
            type="button"
          >
            {sending ? "Adding…" : "Send to register"}
          </button>
        </div>
        <p className="mt-2 text-right text-[11px] text-[#5d6673]">
          Paid at the register, the membership turns Active. You can still add or remove the card fee on the register line.
        </p>
      </div>
    </div>
  );
}
