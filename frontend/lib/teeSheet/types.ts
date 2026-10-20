// Shared tee sheet contract. Backend source of truth: backend/api/routes/tee_sheet.py
// Wire dates are ISO `YYYY-MM-DD`. `dayIndex` is NEVER sent over the wire; it is
// derived at render time from the booking date and the visible week anchor.

export type BookingStatus =
  | "reserved"
  | "checked_in"
  | "paid"
  | "cancelled"
  | "no_show"
  | "blocked";

export type PlayerType = "Existing Customer" | "Guest";

export type BookingColor = "blue" | "gold" | "gray";

/**
 * 이 예약을 누가 만들었나. 서버 `tee_sheet.py` 의 `BookingSource` 와 같은 값.
 *
 * `voice_hold` 는 음성 에이전트가 통화 중 자리를 잠가 둔 임시 레코드다. 확정되면
 * `voice` 로 바뀌고, 확정되지 않으면 `holdExpiresAt` 이 지난 뒤 사라진다.
 */
export type BookingSource = "staff" | "web" | "voice" | "voice_hold";

export type Player = {
  id: string;
  name: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  type: PlayerType;
  ratePlan: string;
  arrived: boolean;
  paid: boolean;
  cancelled: boolean;
  no_show: boolean;
  /** 이 사람이 카트를 쓰나 (1인 요금 한 줄). 예약 단위 `cartCount`(카트 대수)와는 따로다. */
  cart: boolean;
  /** 1인 카트 요금(달러, 세전 — `rate` 와 같은 단위). 켤 때 서버가 요금제·홀 수로 채운다. */
  cartFee: number;
  /** 요금제로 매긴 1인 그린피(세전, 0045). 회원 0, 시니어 40.71 … 없으면 예약 `rate`(퍼블릭가)를 낸다. */
  greenFee?: number;
  /** 결제로 표시된 시각(ISO). 서버만 찍는다. 이 필드가 생기기 전의 결제에는 없다. */
  paidAt: string | null;
  /** 이 사람 몫에 붙은 추가 품목(풀카트·레인지 바스켓, 0026). 붙일 때의 값이 복사돼 있다. 없으면 키가 없다. */
  extras?: TeeExtra[];
};

/** 선수에게 붙은 추가 품목 한 줄. price 는 세전 달러(`rate`·`cartFee` 와 같다). */
export type TeeExtra = { code: string; name: string; price: number };

/** 추가 품목 카탈로그 한 항목(0026 `pelham_staff_tee_extras`). */
export type TeeExtraItem = TeeExtra & { category: string };

export type AuditEntry = {
  id: string;
  ts: string;
  message: string;
};

export type TeeBooking = {
  id: string;
  /** 손님용 확인 코드(`T` + 16진수 9자, 0012). 0012 이전에 읽은 doc 에는 없을 수 있다. */
  confirmationCode?: string;
  /** ISO date, e.g. "2026-09-11" */
  date: string;
  /** Slot label, e.g. "6:58 AM" — always one of the slots returned by /tee-sheet/slots */
  time: string;
  holes: 9 | 18;
  rate: number;
  span: number;
  color: BookingColor;
  title: string;
  status: BookingStatus;
  cartCount: number;
  notes: string;
  players: Player[];
  audit: AuditEntry[];
  cancelReason: string | null;
  source: BookingSource;
  /** 음성 홀드에만 채워진다 (ISO 타임스탬프). 확정된 예약은 언제나 null. */
  holdExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type TeeSlot = {
  /** Slot label, e.g. "6:58 AM" */
  time: string;
  /** Minutes from midnight — stable sort key */
  minutes: number;
  rate: number;
  cartsTotal: number;
  /** 요금 구분 (0025). 옛 서버·오프라인 시드에는 없다. */
  dayType?: DayType;
  /** 공휴일 이름, 예: "Thanksgiving". 공휴일이 아니면 null. */
  holiday?: string | null;
  /** 그날 요금표의 9홀 1인 요금과 판매 시작(분), 요금표 이름 (0045). 옛 서버에는 없다. */
  rate9?: number;
  nineFrom?: number;
  rateCard?: string;
};

export type DayType = "weekday" | "weekend" | "holiday";

/** `pelham_staff_rate_days` 한 줄 — 날짜 하나의 그린피와 구분. */
export type RateDay = {
  date: string;
  rate: number;
  dayType: DayType;
  holiday: string | null;
};

export type SlotsResponse = {
  date: string;
  slots: TeeSlot[];
};

export type CreateBookingInput = {
  date: string;
  time: string;
  title: string;
  holes?: 9 | 18;
  rate?: number;
  cartCount?: number;
  color?: BookingColor;
  notes?: string;
  players?: Array<Partial<Omit<Player, "id">>>;
};

export type PatchBookingInput = Partial<{
  date: string;
  time: string;
  title: string;
  holes: 9 | 18;
  rate: number;
  cartCount: number;
  color: BookingColor;
  notes: string;
  status: BookingStatus;
  cancelReason: string | null;
}>;

export type AddPlayerInput = Partial<Omit<Player, "id" | "paidAt">>;
export type PatchPlayerInput = Partial<Omit<Player, "id" | "paidAt" | "extras">>;

// ===== Reports =====

export type DailyReport = {
  date: string;
  total_tee_times: number;
  total_slots: number;
  booked_slots: number;
  available_slots: number;
  occupancy_rate: number;
  total_revenue: number;
  collected_revenue: number;
  outstanding_revenue: number;
  checked_in: number;
  cancelled: number;
  no_show: number;
  carts: number;
  bookings: Array<{
    id: string;
    time: string;
    title: string;
    players: number;
    rate: number;
    status: BookingStatus;
  }>;
};

export type WeekReport = {
  from: string;
  to: string;
  days: DailyReport[];
  summary: {
    total_days: number;
    total_tee_times: number;
    total_booked_slots: number;
    total_revenue: number;
    collected_revenue: number;
    average_occupancy: number;
  };
};

// ===== Orchestration =====

export type TaskState = "queued" | "running" | "success" | "failed";

export type OrchestrationTask = {
  id: string;
  name: string;
  state: TaskState;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  detail: string;
  result: Record<string, unknown> | null;
  error: string | null;
};

export type OrchestrationStatus = {
  status: string;
  total_bookings: number;
  timestamp: string;
  available_tasks: Array<{ name: string; description: string; endpoint: string }>;
  tasks: OrchestrationTask[];
};

export type TaskAck = {
  accepted: boolean;
  tasks: OrchestrationTask[];
  message: string;
};

// ===== UI-side view models =====

export type ViewMode = "week" | "day";

export type ConnectionState = "connecting" | "online" | "offline";

export type Toast = { id: string; kind: "info" | "error" | "success"; text: string };

/**
 * The single controller object returned by `useTeeSheet`.
 * Every tee sheet component receives this (or a slice of it) as props — it is the
 * contract between the page shell, the grid, the detail panel and the panels.
 */
export type TeeSheetController = {
  // data
  bookings: TeeBooking[];
  /** Bookings limited to the currently visible range (day or week). */
  visibleBookings: TeeBooking[];
  slots: TeeSlot[];
  selected: TeeBooking | null;
  selectedId: string | null;

  // view state
  view: ViewMode;
  /** ISO date of the Monday anchoring the visible week. */
  weekStart: string;
  /** ISO date of the focused day. */
  focusedDate: string;
  /** 7 ISO dates, Monday..Sunday, for the visible week. */
  weekDates: string[];

  // connection + messaging
  connection: ConnectionState;
  message: string;
  toasts: Toast[];
  busy: boolean;
  dismissToast: (id: string) => void;
  /** 화면 쪽 알림(예: 스캐너가 읽은 코드에 맞는 예약이 없음). 돌려받은 id 로 지울 수 있다. */
  pushToast: (kind: Toast["kind"], text: string) => string;

  // stats for the visible range
  stats: {
    reservations: number;
    players: number;
    arrived: number;
    paid: number;
    carts: number;
    /** 체크인된 예약에 붙은 카트 수 — 지금 코스에 나가 있는 카트. */
    cartsOut: number;
    revenue: number;
    outstanding: number;
  };

  // view actions
  setView: (view: ViewMode) => void;
  setFocusedDate: (isoDate: string) => void;
  goToPreviousWeek: () => void;
  goToNextWeek: () => void;
  goToToday: () => void;
  select: (bookingId: string | null) => void;

  // booking actions
  createBooking: (input: CreateBookingInput) => Promise<TeeBooking | null>;
  patchBooking: (bookingId: string, patch: PatchBookingInput) => Promise<TeeBooking | null>;
  deleteBooking: (bookingId: string) => Promise<boolean>;
  moveBooking: (bookingId: string, date: string, time: string) => Promise<TeeBooking | null>;
  setStatus: (bookingId: string, status: BookingStatus, cancelReason?: string) => Promise<TeeBooking | null>;

  // player actions
  addPlayer: (bookingId: string, input?: AddPlayerInput) => Promise<TeeBooking | null>;
  patchPlayer: (bookingId: string, playerId: string, patch: PatchPlayerInput) => Promise<TeeBooking | null>;
  removePlayer: (bookingId: string, playerId: string) => Promise<TeeBooking | null>;
  /** 선수의 추가 품목을 통째로 바꾼다(0026). 순서대로, 같은 품목을 두 번 넣을 수 있다. */
  setPlayerExtras: (bookingId: string, playerId: string, extras: TeeExtra[]) => Promise<TeeBooking | null>;
  /** 추가 품목 카탈로그(켜진 것만). 0026 이 없으면 실패한다. */
  loadExtras: () => Promise<TeeExtraItem[]>;

  // misc
  refresh: () => Promise<void>;
};
