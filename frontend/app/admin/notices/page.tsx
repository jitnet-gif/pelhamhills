"use client";

/**
 * 웹사이트 팝업 — 공개 사이트·예약 화면에 뜨는 공지와 프로모션을 직원이 올리고 내리는 화면(0060).
 *
 * 흔한 일은 "오늘 아침 서리로 티타임 지연" 처럼 몇 시간짜리 안내라서, 템플릿 단추가 글과 종료 시각을
 * 미리 채운다. 끝나는 시각이 지나면 손님 화면에서 저절로 사라진다 — 직원이 내리는 것을 잊어도 된다.
 *
 * 편집기 오른쪽 미리 보기는 손님 창과 같은 컴포넌트(`NoticeCard`)다.
 */

import { useEffect, useMemo, useState, type FormEvent } from "react";

import AdminShell from "@/components/admin/AdminShell";
import { Button, Chip, EmptyNote, ErrorNote, Field, Modal, Select, SkeletonRows, TextArea, TextInput } from "@/components/retail/ui";
import { NoticeCard } from "@/components/site/SiteNoticePopup";
import { clubDateTime } from "@/lib/lostItems";
import {
  KIND_LABEL,
  REPEAT_LABEL,
  SURFACE_LABEL,
  describeNoticeError,
  fromLocalInput,
  noticeState,
  siteNoticesApi,
  toLocalInput,
  todayAt,
  type NoticeKind,
  type NoticeRepeat,
  type NoticeState,
  type NoticeSurface,
  type SiteNotice,
  type SiteNoticeInput,
} from "@/lib/siteNotices";

const FILTERS = [
  { key: "current", label: "Live & scheduled" },
  { key: "live", label: "Live" },
  { key: "scheduled", label: "Scheduled" },
  { key: "past", label: "Off & ended" },
  { key: "all", label: "All" },
] as const;

type FilterKey = (typeof FILTERS)[number]["key"];

function matches(filter: FilterKey, state: NoticeState): boolean {
  if (filter === "all") return true;
  if (filter === "current") return state === "live" || state === "scheduled";
  if (filter === "past") return state === "off" || state === "ended";
  return state === filter;
}

/** 편집기 입력. 시각은 `YYYY-MM-DDTHH:mm`(기기 현지) 그대로 들고 있다가 저장할 때 ISO 로 바꾼다. */
type Draft = {
  id?: string;
  kind: NoticeKind;
  title: string;
  body: string;
  image_url: string;
  link_url: string;
  link_label: string;
  surfaces: NoticeSurface;
  repeat: NoticeRepeat;
  starts_at: string;
  ends_at: string;
  active: boolean;
};

const BLANK: Draft = {
  kind: "notice",
  title: "",
  body: "",
  image_url: "",
  link_url: "",
  link_label: "",
  surfaces: "all",
  repeat: "once",
  starts_at: "",
  ends_at: "",
  active: true,
};

/** 자주 쓰는 글. 누르면 편집기가 이 값으로 열린다 — 손님에게 나가기 전에 시각만 고치면 된다. */
const TEMPLATES: { label: string; draft: () => Partial<Draft> }[] = [
  {
    label: "Frost delay",
    draft: () => ({
      kind: "alert",
      title: "Frost Delay This Morning",
      body:
        "The course is covered in frost, so play is delayed until about 9:30 AM to protect the greens.\n\n" +
        "Early tee times will be moved back in order. If your time changes, the pro shop will call you. Thanks for your patience!",
      surfaces: "all",
      repeat: "daily",
      ends_at: todayAt(12),
    }),
  },
  {
    label: "Course closed",
    draft: () => ({
      kind: "alert",
      title: "Course Closed Today",
      body:
        "Due to weather and course conditions, the golf course is closed today.\n\n" +
        "Booked players will be contacted about a rain check. Indoor simulators remain open.",
      surfaces: "all",
      repeat: "daily",
      ends_at: todayAt(23, 59),
      link_url: "/book/indoor",
      link_label: "Book an indoor bay",
    }),
  },
  {
    label: "Cart path only",
    draft: () => ({
      kind: "alert",
      title: "Cart Path Only Today",
      body: "After the overnight rain, carts must stay on the paths today. Please allow a little extra time for your round.",
      surfaces: "all",
      repeat: "daily",
      ends_at: todayAt(23, 59),
    }),
  },
  {
    label: "Promotion",
    draft: () => ({
      kind: "promotion",
      title: "Weekday Twilight Special",
      body: "Play 18 holes after 3 PM, Monday to Thursday, for a special twilight rate.",
      surfaces: "all",
      repeat: "once",
      link_url: "/book/tee-time",
      link_label: "Book a tee time",
    }),
  },
];

function toDraft(row: SiteNotice): Draft {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    image_url: row.image_url ?? "",
    link_url: row.link_url ?? "",
    link_label: row.link_label ?? "",
    surfaces: row.surfaces,
    repeat: row.repeat,
    starts_at: toLocalInput(row.starts_at),
    ends_at: toLocalInput(row.ends_at),
    active: row.active,
  };
}

function toInput(draft: Draft): SiteNoticeInput {
  return {
    ...draft,
    starts_at: fromLocalInput(draft.starts_at),
    ends_at: fromLocalInput(draft.ends_at),
  };
}

export default function NoticesPage() {
  const [rows, setRows] = useState<SiteNotice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterKey>("current");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Draft | null>(null);
  // 상태 배지가 "Live → Ended" 로 넘어가도록 1분마다 다시 그린다.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    siteNoticesApi
      .list()
      .then((value) => {
        if (cancelled) return;
        setRows(value);
        setError(null);
      })
      .catch((err) => {
        if (!cancelled) setError(describeNoticeError(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const upsert = (next: SiteNotice) =>
    setRows((current) => {
      const list = current ?? [];
      return list.some((row) => row.id === next.id)
        ? list.map((row) => (row.id === next.id ? next : row))
        : [next, ...list];
    });

  const toggle = async (row: SiteNotice) => {
    setBusyId(row.id);
    try {
      upsert(await siteNoticesApi.save({ id: row.id, active: !row.active }));
      setError(null);
    } catch (err) {
      setError(describeNoticeError(err));
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (row: SiteNotice) => {
    if (!window.confirm(`Delete "${row.title}"? This can't be undone. To take it down for now, use Turn off.`)) return;
    setBusyId(row.id);
    try {
      await siteNoticesApi.remove(row.id);
      setRows((current) => (current ?? []).filter((item) => item.id !== row.id));
      setError(null);
    } catch (err) {
      setError(describeNoticeError(err));
    } finally {
      setBusyId(null);
    }
  };

  const counts = useMemo(() => {
    const out = Object.fromEntries(FILTERS.map((f) => [f.key, 0])) as Record<FilterKey, number>;
    for (const row of rows ?? []) {
      const state = noticeState(row, now);
      for (const f of FILTERS) if (matches(f.key, state)) out[f.key] += 1;
    }
    return out;
  }, [rows, now]);

  const visible = (rows ?? []).filter((row) => matches(filter, noticeState(row, now)));

  return (
    <AdminShell
      actions={
        <Button onClick={() => setEditing({ ...BLANK })} tone="primary">
          New pop-up
        </Button>
      }
      title="Website Pop-ups"
    >
      <div className="grid min-w-0 gap-3 p-4">
        <section className="grid gap-2 border border-[#d4d4d8] bg-white p-3">
          <p className="text-sm text-[#3f434a]">
            Pop-ups show on <b>pelhamhills.com</b> and the online booking pages. Start from a template:
          </p>
          <div className="flex flex-wrap gap-2">
            {TEMPLATES.map((template) => (
              <Button key={template.label} onClick={() => setEditing({ ...BLANK, ...template.draft() })}>
                {template.label}
              </Button>
            ))}
          </div>
        </section>

        <div className="flex gap-2 overflow-x-auto">
          {FILTERS.map((item) => (
            <Chip active={filter === item.key} key={item.key} onClick={() => setFilter(item.key)}>
              {item.label}
              {rows ? <span className="ml-1.5 tabular-nums opacity-70">{counts[item.key]}</span> : null}
            </Chip>
          ))}
        </div>

        {error ? <ErrorNote>{error}</ErrorNote> : null}

        {rows === null ? (
          error ? null : <SkeletonRows />
        ) : visible.length === 0 ? (
          <EmptyNote>
            {filter === "current" ? "Nothing is showing on the website right now." : "No pop-ups here."}
          </EmptyNote>
        ) : (
          <div className="grid gap-2 lg:grid-cols-2">
            {visible.map((row) => (
              <NoticeRow
                busy={busyId === row.id}
                key={row.id}
                now={now}
                onDelete={() => void remove(row)}
                onEdit={() => setEditing(toDraft(row))}
                onToggle={() => void toggle(row)}
                row={row}
              />
            ))}
          </div>
        )}
      </div>

      {editing ? (
        <EditorModal
          initial={editing}
          onClose={() => setEditing(null)}
          onSaved={(row) => {
            upsert(row);
            setEditing(null);
          }}
        />
      ) : null}
    </AdminShell>
  );
}

const STATE_BADGE: Record<NoticeState, { label: string; className: string }> = {
  live: { label: "Live", className: "bg-[#e8f5ec] text-[#1f6b3a]" },
  scheduled: { label: "Scheduled", className: "bg-[#fff8e1] text-[#5b4708]" },
  ended: { label: "Ended", className: "bg-[#f0f0f3] text-[#6b7280]" },
  off: { label: "Off", className: "bg-[#f0f0f3] text-[#6b7280]" },
};

function windowLine(row: SiteNotice): string {
  const from = row.starts_at ? clubDateTime(row.starts_at) : "Now";
  const to = row.ends_at ? clubDateTime(row.ends_at) : "until turned off";
  return row.ends_at ? `${from} → ${to}` : `${from}, ${to}`;
}

function NoticeRow({
  row,
  now,
  busy,
  onToggle,
  onEdit,
  onDelete,
}: {
  row: SiteNotice;
  now: number;
  busy: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const state = STATE_BADGE[noticeState(row, now)];
  return (
    <section className="grid min-w-0 gap-2 border border-[#d4d4d8] bg-white p-3">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="min-w-0 truncate text-sm font-bold">
          <span className="text-[#6b7280]">{KIND_LABEL[row.kind]}</span> · {row.title}
        </h3>
        <span className={`shrink-0 px-1.5 py-0.5 text-[10px] font-bold uppercase ${state.className}`}>{state.label}</span>
      </div>
      {row.body ? <p className="line-clamp-2 whitespace-pre-line break-words text-xs text-[#3f434a]">{row.body}</p> : null}
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-xs">
        <dt className="text-[#6b7280]">Shows</dt>
        <dd>{windowLine(row)}</dd>
        <dt className="text-[#6b7280]">Where</dt>
        <dd>{SURFACE_LABEL[row.surfaces]}</dd>
        <dt className="text-[#6b7280]">Repeat</dt>
        <dd>{REPEAT_LABEL[row.repeat]}</dd>
        <dt className="text-[#6b7280]">Updated</dt>
        <dd className="break-words">
          {clubDateTime(row.updated_at)}
          {row.updated_by ? ` · ${row.updated_by}` : ""}
        </dd>
      </dl>
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy} onClick={onEdit} tone="primary">
          Edit
        </Button>
        <Button disabled={busy} onClick={onToggle}>
          {row.active ? "Turn off" : "Turn on"}
        </Button>
        <Button disabled={busy} onClick={onDelete} tone="danger">
          Delete
        </Button>
      </div>
    </section>
  );
}

function EditorModal({
  initial,
  onClose,
  onSaved,
}: {
  initial: Draft;
  onClose: () => void;
  onSaved: (row: SiteNotice) => void;
}) {
  const [draft, setDraft] = useState<Draft>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set =
    <K extends keyof Draft>(key: K) =>
    (event: { target: { value: string } }) =>
      setDraft((current) => ({ ...current, [key]: event.target.value as Draft[K] }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft.title.trim()) {
      setError("Give the pop-up a title.");
      return;
    }
    if (draft.starts_at && draft.ends_at && draft.ends_at <= draft.starts_at) {
      setError("The end time must be after the start time.");
      return;
    }
    setSaving(true);
    try {
      onSaved(await siteNoticesApi.save(toInput(draft)));
    } catch (err) {
      setError(describeNoticeError(err));
      setSaving(false);
    }
  };

  return (
    <Modal onClose={onClose} title={draft.id ? "Edit pop-up" : "New pop-up"} wide>
      <form className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]" onSubmit={submit}>
        <div className="grid content-start gap-3">
          <div className="grid grid-cols-2 gap-2">
            <Field label="Type">
              <Select onChange={set("kind")} value={draft.kind}>
                <option value="alert">Course update</option>
                <option value="notice">Notice</option>
                <option value="promotion">Special offer</option>
              </Select>
            </Field>
            <Field label="Show on">
              <Select onChange={set("surfaces")} value={draft.surfaces}>
                {(Object.keys(SURFACE_LABEL) as NoticeSurface[]).map((key) => (
                  <option key={key} value={key}>
                    {SURFACE_LABEL[key]}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label="Title">
            <TextInput autoFocus onChange={set("title")} placeholder="Frost Delay This Morning" value={draft.title} />
          </Field>
          <Field hint="Line breaks show as typed." label="Message">
            <TextArea className="min-h-[140px]" onChange={set("body")} value={draft.body} />
          </Field>
          <WhenPicker
            empty="Right away"
            label="Start"
            onChange={(value) => setDraft((current) => ({ ...current, starts_at: value }))}
            value={draft.starts_at}
          />
          <WhenPicker
            empty="Until turned off"
            label="End"
            onChange={(value) => setDraft((current) => ({ ...current, ends_at: value }))}
            value={draft.ends_at}
          />
          <Field hint="After a visitor closes it, when it shows again. Editing the pop-up shows it to everyone again." label="Show again">
            <Select onChange={set("repeat")} value={draft.repeat}>
              {(Object.keys(REPEAT_LABEL) as NoticeRepeat[]).map((key) => (
                <option key={key} value={key}>
                  {REPEAT_LABEL[key]}
                </option>
              ))}
            </Select>
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field hint="/book/tee-time or https://…" label="Button link">
              <TextInput onChange={set("link_url")} placeholder="/book/tee-time" value={draft.link_url} />
            </Field>
            <Field label="Button text">
              <TextInput onChange={set("link_label")} placeholder="Book a tee time" value={draft.link_label} />
            </Field>
          </div>
          <Field hint="Optional. An https:// picture address, or /pelham-hills/hero-course.png" label="Image">
            <TextInput onChange={set("image_url")} placeholder="https://…" value={draft.image_url} />
          </Field>
          <label className="flex min-h-11 items-center gap-2 text-sm font-bold text-[#3f434a]">
            <input
              checked={draft.active}
              className="h-5 w-5"
              onChange={(event) => setDraft((current) => ({ ...current, active: event.target.checked }))}
              type="checkbox"
            />
            On — show it on the website
          </label>
        </div>

        <div className="grid content-start gap-2">
          <p className="text-xs font-bold uppercase tracking-wide text-[#6b7280]">Preview</p>
          {/* inert: 미리 보기 안의 단추·링크가 진짜로 눌려 편집기를 떠나지 않게. */}
          <div className="bg-[#10170f]/60 p-3" inert>
            <NoticeCard
              notice={{
                ...draft,
                image_url: draft.image_url.trim() || null,
                link_url: draft.link_url.trim() || null,
                link_label: draft.link_label.trim() || null,
              }}
              onClose={() => undefined}
            />
          </div>
        </div>

        <div className="grid gap-2 md:col-span-2">
          {error ? <ErrorNote>{error}</ErrorNote> : null}
          <Button disabled={saving} full tone="primary" type="submit">
            {saving ? "Saving…" : draft.id ? "Save changes" : draft.active ? "Publish pop-up" : "Save (off)"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ===== 날짜·시각 고르기 ====================================================
// `<input type="datetime-local">` 은 기기 언어로 그려진다(한국어 기기면 "연도. 월. 일. 오후"). 페이지가
// 영어로 바꿀 방법이 없어서 날짜·시각을 영어 목록 두 개로 고르게 한다. 값은 `YYYY-MM-DDTHH:mm` 그대로.

const DAYS_AHEAD = 60;
const TIME_STEP_MIN = 15;

function isoDay(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function dayLabel(day: string, todayIso: string, tomorrowIso: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const text = new Date(y, m - 1, d).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  if (day === todayIso) return `Today · ${text}`;
  if (day === tomorrowIso) return `Tomorrow · ${text}`;
  return text;
}

function timeLabel(time: string): string {
  const [h, m] = time.split(":").map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

const TIMES: string[] = Array.from({ length: (24 * 60) / TIME_STEP_MIN }, (_, i) => {
  const minutes = i * TIME_STEP_MIN;
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}).concat("23:59");

function WhenPicker({
  label,
  empty,
  value,
  onChange,
}: {
  label: string;
  empty: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const [day, time] = value ? value.split("T") : ["", ""];

  const now = new Date();
  const todayIso = isoDay(now);
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  const tomorrowIso = isoDay(tomorrow);

  const days = Array.from({ length: DAYS_AHEAD }, (_, i) => {
    const d = new Date(now);
    d.setDate(now.getDate() + i);
    return isoDay(d);
  });
  // 지난 날짜로 저장된 공지를 고칠 때도 그 날짜가 목록에 있어야 한다.
  if (day && !days.includes(day)) days.unshift(day);
  const times = time && !TIMES.includes(time) ? [...TIMES, time].sort() : TIMES;

  return (
    <div className="grid grid-cols-[minmax(0,3fr)_minmax(0,2fr)] gap-2">
      <Field label={label}>
        <Select
          onChange={(event) => {
            const next = event.target.value;
            onChange(next ? `${next}T${time || (label === "End" ? "23:59" : "08:00")}` : "");
          }}
          value={day}
        >
          <option value="">{empty}</option>
          {days.map((option) => (
            <option key={option} value={option}>
              {dayLabel(option, todayIso, tomorrowIso)}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Time">
        <Select disabled={!day} onChange={(event) => onChange(`${day}T${event.target.value}`)} value={time}>
          {!day ? <option value="">—</option> : null}
          {times.map((option) => (
            <option key={option} value={option}>
              {timeLabel(option)}
            </option>
          ))}
        </Select>
      </Field>
    </div>
  );
}
