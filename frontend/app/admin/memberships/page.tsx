"use client";

/**
 * 회원권 — 시즌별 회원 명부(0040)를 프로 샵이 보고 고치는 화면.
 *
 * 탭 둘:
 *   Roster   — 이 시즌 회원권. 줄을 누르면 고친다. "Paid in full" 로 완납·활성화를 한 번에.
 *   Renewals — 고객 명부(Lightspeed 내보내기)에서 회원이었는데 이 시즌 회원권이 아직 없는 사람.
 *              Early Bird 마감 전에 전화를 돌리는 목록이고, 지난 요금제로 새 회원권을 미리 채운다.
 *
 * 분실물 화면처럼 데모 데이터로 내려가지 않는다 — 회원 이름·연락처·결제액이 든 표다.
 */

import { useEffect, useMemo, useState, type FormEvent } from "react";

import AdminShell from "@/components/admin/AdminShell";
import {
  Button,
  Chip,
  EmptyNote,
  ErrorNote,
  Field,
  Modal,
  Select,
  SkeletonRows,
  StatCard,
  TextArea,
  TextInput,
} from "@/components/retail/ui";
import {
  CART_PACKAGES,
  CREDIT_CARD_SURCHARGE,
  EARLY_BIRD_DEADLINE,
  MEMBERSHIP_TYPES,
  PAYMENT_METHODS,
  RANGE_PASS_PRICE,
  STATUS_LABEL,
  balance,
  cartLabel,
  describeMembershipError,
  draftFromRatePlan,
  listPrice,
  membershipsApi,
  money,
  typeInfo,
  type Membership,
  type MembershipInput,
  type MembershipStatus,
  type MembershipType,
  type RenewalCandidate,
} from "@/lib/memberships";
import { CLUB_TIME_ZONE } from "@/lib/retail/receipt";

/** 클럽 현지 날짜 `YYYY-MM-DD`. */
function clubToday(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: CLUB_TIME_ZONE });
}

/** 9월부터는 다음 해 회원권을 판다(Early Bird 가 9월 15일에 열린다). */
function defaultSeason(): number {
  const [year, month] = clubToday().split("-").map(Number);
  return month >= 9 ? year + 1 : year;
}

const STATUS_FILTERS = [
  { key: "all", label: "All" },
  { key: "pending", label: "Pending" },
  { key: "active", label: "Active" },
  { key: "unpaid", label: "Balance owing" },
  { key: "cancelled", label: "Cancelled" },
] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number]["key"];

function matchesStatus(filter: StatusFilter, row: Membership): boolean {
  if (filter === "all") return row.status !== "cancelled";
  if (filter === "unpaid") return row.status !== "cancelled" && balance(row) > 0;
  return row.status === filter;
}

function matchesSearch(query: string, row: Membership): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const digits = q.replace(/\D/g, "");
  return (
    [row.member_name, row.spouse_name, row.email, row.member_number]
      .filter(Boolean)
      .some((v) => v!.toLowerCase().includes(q)) ||
    (digits.length >= 3 && (row.phone ?? "").replace(/\D/g, "").includes(digits))
  );
}

export default function MembershipsAdminPage() {
  const [season, setSeason] = useState(defaultSeason);
  const [tab, setTab] = useState<"roster" | "renewals">("roster");
  const [rows, setRows] = useState<Membership[] | null>(null);
  const [renewals, setRenewals] = useState<RenewalCandidate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [typeFilter, setTypeFilter] = useState<MembershipType | "">("");
  const [query, setQuery] = useState("");
  /** 열려 있는 편집 창. `id` 가 null 이면 새 회원권. */
  const [editing, setEditing] = useState<{ id: string | null; draft: MembershipInput } | null>(null);

  // 시즌을 바꾸면 명부와 갱신 목록을 둘 다 다시 읽는다.
  useEffect(() => {
    let cancelled = false;
    Promise.all([membershipsApi.list(season), membershipsApi.renewals(season)])
      .then(([list, candidates]) => {
        if (cancelled) return;
        setRows(list);
        setRenewals(candidates);
        setError(null);
      })
      .catch((err) => {
        if (!cancelled) setError(describeMembershipError(err));
      });
    return () => {
      cancelled = true;
    };
  }, [season]);

  const saved = (row: Membership, isNew: boolean) => {
    setRows((current) =>
      isNew ? [...(current ?? []), row] : (current ?? []).map((r) => (r.id === row.id ? row : r)),
    );
    if (isNew && row.customer_ref) {
      setRenewals((current) => (current ?? []).filter((c) => c.customer_ref !== row.customer_ref));
    }
    setEditing(null);
  };

  const live = useMemo(() => (rows ?? []).filter((r) => r.status !== "cancelled"), [rows]);
  const stats = useMemo(
    () => ({
      active: live.filter((r) => r.status === "active").length,
      pending: live.filter((r) => r.status === "pending").length,
      collected: live.reduce((sum, r) => sum + Number(r.amount_paid), 0),
      owing: live.reduce((sum, r) => sum + Math.max(0, balance(r)), 0),
      owingCount: live.filter((r) => balance(r) > 0).length,
    }),
    [live],
  );

  const statusCounts = useMemo(() => {
    const out = Object.fromEntries(STATUS_FILTERS.map((f) => [f.key, 0])) as Record<StatusFilter, number>;
    for (const row of rows ?? []) for (const f of STATUS_FILTERS) if (matchesStatus(f.key, row)) out[f.key] += 1;
    return out;
  }, [rows]);

  const visible = (rows ?? [])
    .filter((r) => matchesStatus(statusFilter, r))
    .filter((r) => !typeFilter || r.membership_type === typeFilter)
    .filter((r) => matchesSearch(query, r));

  const visibleRenewals = (renewals ?? []).filter((c) => {
    const q = query.trim().toLowerCase();
    return !q || [c.name, c.email, c.phone, c.player_type].filter(Boolean).some((v) => v!.toLowerCase().includes(q));
  });

  const today = clubToday();
  const earlyBirdDays =
    season === Number(EARLY_BIRD_DEADLINE.slice(0, 4)) + 1 && today <= EARLY_BIRD_DEADLINE
      ? Math.round((Date.parse(EARLY_BIRD_DEADLINE) - Date.parse(today)) / 86_400_000)
      : null;

  const seasons = [defaultSeason() - 1, defaultSeason(), defaultSeason() + 1];

  return (
    <AdminShell
      actions={
        <div className="flex gap-2">
          <Select
            aria-label="Season"
            className="w-28"
            onChange={(event) => {
              setRows(null);
              setRenewals(null);
              setSeason(Number(event.target.value));
            }}
            value={season}
          >
            {seasons.map((s) => (
              <option key={s} value={s}>
                {s} season
              </option>
            ))}
          </Select>
          <Button
            onClick={() =>
              setEditing({
                id: null,
                draft: { season, membership_type: "full", plan: "single", cart_package: null, range_pass: false, status: "pending" },
              })
            }
            tone="primary"
          >
            Add member
          </Button>
        </div>
      }
      title="Memberships"
    >
      <div className="grid min-w-0 gap-3 p-4">
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          <StatCard hint={`${stats.pending} pending`} label="Active members" strong value={rows ? String(stats.active) : "—"} />
          <StatCard label="Collected" value={rows ? money(stats.collected) : "—"} />
          <StatCard
            hint={`${stats.owingCount} member${stats.owingCount === 1 ? "" : "s"}`}
            label="Balance owing"
            onClick={() => {
              setTab("roster");
              setStatusFilter("unpaid");
            }}
            value={rows ? money(stats.owing) : "—"}
          />
          <StatCard
            hint={earlyBirdDays !== null ? `Early Bird ends ${EARLY_BIRD_DEADLINE.slice(5).replace("-", "/")} · ${earlyBirdDays} days` : "Last season's members"}
            label="Not renewed yet"
            onClick={() => setTab("renewals")}
            value={renewals ? String(renewals.length) : "—"}
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Chip active={tab === "roster"} onClick={() => setTab("roster")}>
            Roster
            {rows ? <span className="ml-1.5 tabular-nums opacity-70">{live.length}</span> : null}
          </Chip>
          <Chip active={tab === "renewals"} onClick={() => setTab("renewals")}>
            Renewals
            {renewals ? <span className="ml-1.5 tabular-nums opacity-70">{renewals.length}</span> : null}
          </Chip>
          <TextInput
            aria-label="Search"
            className="min-w-0 flex-1 sm:max-w-xs"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search name, phone, email, #"
            type="search"
            value={query}
          />
        </div>

        {error ? <ErrorNote>{error}</ErrorNote> : null}

        {tab === "roster" ? (
          <>
            <div className="flex gap-2 overflow-x-auto">
              {STATUS_FILTERS.map((item) => (
                <Chip active={statusFilter === item.key} key={item.key} onClick={() => setStatusFilter(item.key)}>
                  {item.label}
                  {rows ? <span className="ml-1.5 tabular-nums opacity-70">{statusCounts[item.key]}</span> : null}
                </Chip>
              ))}
              <Select
                aria-label="Membership type"
                className="w-40 shrink-0"
                onChange={(event) => setTypeFilter(event.target.value as MembershipType | "")}
                value={typeFilter}
              >
                <option value="">All types</option>
                {MEMBERSHIP_TYPES.map((t) => (
                  <option key={t.key} value={t.key}>
                    {t.label}
                  </option>
                ))}
              </Select>
            </div>

            {rows === null ? (
              error ? null : <SkeletonRows />
            ) : visible.length === 0 ? (
              <EmptyNote>
                {rows.length === 0 ? `No ${season} memberships yet. Add one, or start from Renewals.` : "No members match."}
              </EmptyNote>
            ) : (
              <div className="grid gap-2 lg:grid-cols-2">
                {visible.map((row) => (
                  <MemberCard key={row.id} onOpen={() => setEditing({ id: row.id, draft: row })} row={row} />
                ))}
              </div>
            )}
          </>
        ) : renewals === null ? (
          error ? null : <SkeletonRows />
        ) : visibleRenewals.length === 0 ? (
          <EmptyNote>
            {renewals.length === 0 ? `Every member on file has a ${season} membership.` : "No one matches."}
          </EmptyNote>
        ) : (
          <div className="grid gap-2 lg:grid-cols-2">
            {visibleRenewals.map((c) => (
              <RenewalCard
                candidate={c}
                key={c.customer_ref}
                onStart={() => {
                  const guess = draftFromRatePlan(c.player_type);
                  setEditing({
                    id: null,
                    draft: {
                      season,
                      customer_ref: c.customer_ref,
                      member_name: c.name,
                      phone: c.phone,
                      email: c.email,
                      member_number: c.member_number,
                      address: c.address,
                      postal_code: c.postal_code,
                      membership_type: guess.membership_type ?? "full",
                      plan: guess.plan,
                      cart_package: guess.cart_package,
                      range_pass: false,
                      status: "pending",
                      notes: c.player_type ? `Last plan: ${c.player_type}` : null,
                    },
                  });
                }}
              />
            ))}
          </div>
        )}
      </div>

      {editing ? (
        <MembershipModal
          draft={editing.draft}
          id={editing.id}
          onClose={() => setEditing(null)}
          onSaved={(row) => saved(row, editing.id === null)}
        />
      ) : null}
    </AdminShell>
  );
}

const BADGE: Record<MembershipStatus, string> = {
  pending: "bg-[#fff8e1] text-[#5b4708]",
  active: "bg-[#e8f5ec] text-[#1f6b3a]",
  cancelled: "bg-[#f0f0f3] text-[#6b7280]",
};

function MemberCard({ row, onOpen }: { row: Membership; onOpen: () => void }) {
  const type = typeInfo(row.membership_type);
  const owing = balance(row);
  const extras = [
    cartLabel(row.cart_package),
    type.rangeIncluded ? "Range included" : row.range_pass ? "Range pass" : null,
  ].filter(Boolean);

  return (
    <button
      className="grid min-w-0 gap-1.5 border border-[#d4d4d8] bg-white p-3 text-left hover:border-[#4533ff]"
      onClick={onOpen}
      type="button"
    >
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="min-w-0 truncate text-sm font-bold">
          {row.member_name}
          {row.plan === "spousal" && row.spouse_name ? (
            <span className="font-normal text-[#6b7280]"> &amp; {row.spouse_name}</span>
          ) : null}
        </h3>
        <span className="flex shrink-0 gap-1">
          {row.source === "online" ? (
            <span className="bg-[#eceaff] px-1.5 py-0.5 text-[10px] font-bold text-[#3626d6] uppercase">Online</span>
          ) : null}
          <span className={`px-1.5 py-0.5 text-[10px] font-bold uppercase ${BADGE[row.status]}`}>
            {STATUS_LABEL[row.status]}
          </span>
        </span>
      </div>
      <p className="text-xs text-[#3f434a]">
        <span className="font-bold">{type.label}</span> · {row.plan === "spousal" ? "Spousal" : "Single"}
        {extras.length ? ` · ${extras.join(" · ")}` : ""}
        {row.member_number ? <span className="text-[#6b7280]"> · #{row.member_number}</span> : null}
      </p>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-xs">
        <span className="tabular-nums">
          {owing > 0 ? (
            <span className="font-bold text-[#8a1f1f]">{money(owing)} owing</span>
          ) : (
            <span className="font-bold text-[#1f6b3a]">Paid {money(row.amount_paid)}</span>
          )}
          <span className="text-[#6b7280]"> of {money(row.amount_due)}</span>
        </span>
        {/* 쿠폰은 완납해야 지급된다(Early Bird 안내문). */}
        {type.simHours > 0 ? (
          <span className="tabular-nums text-[#6b7280]">
            {owing > 0 ? `Simulator ${type.simHours} h once paid` : `Simulator ${Number(row.sim_hours_used)}/${type.simHours} h`}
          </span>
        ) : null}
      </div>
      {/* 온라인 신청의 금액은 손님 화면이 낸 견적이다(0041). 요금표와 다르면 결제 전에 본다. */}
      {row.source === "online" && row.status === "pending" && Number(row.amount_due) !== listPrice(row) ? (
        <p className="text-xs font-bold text-[#8a1f1f]">Check amount — rate card says {money(listPrice(row))}</p>
      ) : null}
      {row.phone || row.email ? (
        <p className="truncate text-xs text-[#6b7280]">{[row.phone, row.email].filter(Boolean).join(" · ")}</p>
      ) : null}
    </button>
  );
}

function RenewalCard({ candidate, onStart }: { candidate: RenewalCandidate; onStart: () => void }) {
  return (
    <section className="grid min-w-0 gap-1.5 border border-[#d4d4d8] bg-white p-3">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="min-w-0 truncate text-sm font-bold">{candidate.name || "No name"}</h3>
        {candidate.member_number ? (
          <span className="shrink-0 text-xs tabular-nums text-[#6b7280]">#{candidate.member_number}</span>
        ) : null}
      </div>
      <p className="text-xs text-[#3f434a]">
        {candidate.player_type || "Member"}
        <span className="text-[#6b7280]"> · {candidate.rounds} rounds on file</span>
      </p>
      <p className="truncate text-xs">
        {candidate.phone ? (
          <a className="underline" href={`tel:${candidate.phone}`}>
            {candidate.phone}
          </a>
        ) : (
          <span className="text-[#8a1f1f]">No phone</span>
        )}
        {candidate.email ? (
          <>
            {" · "}
            <a className="underline" href={`mailto:${candidate.email}`}>
              {candidate.email}
            </a>
          </>
        ) : null}
      </p>
      <div>
        <Button onClick={onStart} tone="primary">
          Start membership
        </Button>
      </div>
    </section>
  );
}

function MembershipModal({
  id,
  draft,
  onClose,
  onSaved,
}: {
  id: string | null;
  draft: MembershipInput;
  onClose: () => void;
  onSaved: (row: Membership) => void;
}) {
  const [form, setForm] = useState<MembershipInput>(() => ({
    ...draft,
    amount_due: draft.amount_due ?? listPrice(priceKeys(draft)),
    amount_paid: draft.amount_paid ?? 0,
  }));
  /** 새 회원권은 직원이 금액을 직접 고치기 전까지 요금표를 따라간다. */
  const [dueTouched, setDueTouched] = useState(id !== null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const type = typeInfo(form.membership_type ?? "full");
  const price = listPrice(priceKeys(form));

  const set = <K extends keyof MembershipInput>(key: K, value: MembershipInput[K]) =>
    setForm((current) => {
      const next = { ...current, [key]: value };
      // 개인 전용 회원권으로 바꾸면 부부 요금이 남지 않게.
      if (key === "membership_type" && !typeInfo(value as MembershipType).spousal) next.plan = "single";
      // Full 은 연습장 포함이라 이용권을 따로 달지 않는다.
      if (key === "membership_type" && typeInfo(value as MembershipType).rangeIncluded) next.range_pass = false;
      if (!dueTouched && ["membership_type", "plan", "cart_package", "range_pass", "payment_method"].includes(key)) {
        next.amount_due = listPrice(priceKeys(next));
      }
      return next;
    });

  const text = (key: keyof MembershipInput) => (event: { target: { value: string } }) =>
    set(key, event.target.value as never);

  const submit = async (event: Pick<FormEvent, "preventDefault">, override?: MembershipInput) => {
    event.preventDefault();
    const body = { ...form, ...override };
    if (!body.member_name?.trim()) {
      setError("Enter the member's name.");
      return;
    }
    setSaving(true);
    try {
      onSaved(await membershipsApi.save(id, id ? changedKeys(draft, body) : body));
    } catch (err) {
      setError(describeMembershipError(err));
      setSaving(false);
    }
  };

  const owing = Math.max(0, Number(form.amount_due ?? 0) - Number(form.amount_paid ?? 0));

  return (
    <Modal onClose={onClose} title={id ? `Edit ${draft.member_name ?? "membership"}` : `New ${form.season} membership`}>
      <form className="grid gap-3" onSubmit={(event) => void submit(event)}>
        <Field label="Member name">
          <TextInput autoComplete="off" autoFocus={!form.member_name} onChange={text("member_name")} value={form.member_name ?? ""} />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Phone">
            <TextInput autoComplete="off" inputMode="tel" onChange={text("phone")} type="tel" value={form.phone ?? ""} />
          </Field>
          <Field label="Member #">
            <TextInput autoComplete="off" onChange={text("member_number")} value={form.member_number ?? ""} />
          </Field>
        </div>
        <Field label="Email">
          <TextInput autoComplete="off" onChange={text("email")} type="email" value={form.email ?? ""} />
        </Field>
        <div className="grid grid-cols-[minmax(0,1fr)_7rem] gap-2">
          <Field label="Address">
            <TextInput autoComplete="off" onChange={text("address")} value={form.address ?? ""} />
          </Field>
          <Field label="Postal code">
            <TextInput autoComplete="off" className="uppercase" onChange={text("postal_code")} value={form.postal_code ?? ""} />
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <Field hint={type.access} label="Membership">
            <Select onChange={(event) => set("membership_type", event.target.value as MembershipType)} value={form.membership_type}>
              {MEMBERSHIP_TYPES.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Plan">
            <Select onChange={(event) => set("plan", event.target.value as "single" | "spousal")} value={form.plan}>
              <option value="single">Single {money(type.single)}</option>
              <option disabled={!type.spousal} value="spousal">
                Spousal {type.spousal ? money(type.spousal) : "— n/a"}
              </option>
            </Select>
          </Field>
        </div>
        {form.plan === "spousal" ? (
          <Field label="Spouse name">
            <TextInput autoComplete="off" onChange={text("spouse_name")} value={form.spouse_name ?? ""} />
          </Field>
        ) : null}

        <div className="grid grid-cols-2 gap-2">
          <Field label="Cart package">
            <Select
              onChange={(event) => set("cart_package", (event.target.value || null) as MembershipInput["cart_package"])}
              value={form.cart_package ?? ""}
            >
              <option value="">None</option>
              {CART_PACKAGES.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.label} {money(c.price)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Driving range">
            {type.rangeIncluded ? (
              <Select disabled value="included">
                <option value="included">Included with Full</option>
              </Select>
            ) : (
              <Select onChange={(event) => set("range_pass", event.target.value === "yes")} value={form.range_pass ? "yes" : "no"}>
                <option value="no">No pass</option>
                <option value="yes">Range pass {money(RANGE_PASS_PRICE)}</option>
              </Select>
            )}
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <Field
            hint={
              Number(form.amount_due) === price
                ? form.payment_method === "Credit card"
                  ? `Rate card + ${CREDIT_CARD_SURCHARGE * 100}% card fee, HST incl.`
                  : "Rate card price, HST incl."
                : `Rate card: ${money(price)}`
            }
            label="Amount due"
          >
            <TextInput
              inputMode="decimal"
              min="0"
              onChange={(event) => {
                setDueTouched(true);
                set("amount_due", event.target.value as never);
              }}
              step="0.01"
              type="number"
              value={form.amount_due ?? ""}
            />
          </Field>
          <Field hint={owing > 0 ? `${money(owing)} owing` : "Paid in full"} label="Amount paid">
            <TextInput
              inputMode="decimal"
              min="0"
              onChange={text("amount_paid")}
              step="0.01"
              type="number"
              value={form.amount_paid ?? ""}
            />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Paid on">
            <TextInput onChange={text("paid_on")} type="date" value={form.paid_on ?? ""} />
          </Field>
          <Field hint={form.payment_method === "Credit card" ? `+${CREDIT_CARD_SURCHARGE * 100}% card fee` : undefined} label="Paid by">
            <Select onChange={text("payment_method")} value={form.payment_method ?? ""}>
              <option value="">—</option>
              {PAYMENT_METHODS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <Field label="Status">
            <Select onChange={(event) => set("status", event.target.value as MembershipStatus)} value={form.status}>
              {(Object.keys(STATUS_LABEL) as MembershipStatus[]).map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABEL[s]}
                </option>
              ))}
            </Select>
          </Field>
          {type.simHours > 0 ? (
            <Field hint={`Early Bird coupon: ${type.simHours} h`} label="Simulator hours used">
              <TextInput
                inputMode="decimal"
                max={type.simHours}
                min="0"
                onChange={text("sim_hours_used")}
                step="0.5"
                type="number"
                value={form.sim_hours_used ?? 0}
              />
            </Field>
          ) : null}
        </div>

        <Field label="Notes">
          <TextArea onChange={text("notes")} value={form.notes ?? ""} />
        </Field>

        {error ? <ErrorNote>{error}</ErrorNote> : null}

        <div className="grid grid-cols-2 gap-2">
          <Button
            disabled={saving || owing <= 0}
            onClick={(event) =>
              void submit(event, {
                amount_paid: Number(form.amount_due ?? 0),
                paid_on: form.paid_on || clubToday(),
                status: "active",
              })
            }
          >
            Paid in full
          </Button>
          <Button disabled={saving} tone="primary" type="submit">
            {saving ? "Saving…" : id ? "Save" : "Add member"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function priceKeys(m: MembershipInput) {
  return {
    membership_type: m.membership_type ?? "full",
    plan: m.plan ?? "single",
    cart_package: m.cart_package ?? null,
    range_pass: !!m.range_pass,
    payment_method: m.payment_method ?? null,
  };
}

/** 고칠 때는 바뀐 키만 보낸다(0040 의 save 가 `p` 에 있는 키만 바꾼다). */
function changedKeys(before: MembershipInput, after: MembershipInput): MembershipInput {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(after) as (keyof MembershipInput)[]) {
    if (["season", "customer_ref"].includes(key)) continue;
    if (String(after[key] ?? "") !== String(before[key] ?? "")) out[key] = after[key] ?? "";
  }
  return out as MembershipInput;
}
