// Plain serializable shapes shared between the API responses and the client.
// (Dates are ISO strings, matching JSON serialization.)

import type { AccessMatrix, EditableRole } from '@/lib/permissions';
import type { Feature } from '@/lib/features';
import type { BatteryReading, LocationSharing } from '@/lib/location';
import type { PhoneProblem, PhoneRules, PhoneSetupStep } from '@/lib/phoneHealth';
import type { RingPhase } from '@/lib/ring';
import type { WebFilter } from '@/lib/webFilter';

export interface CategoryDTO {
  id: string;
  name: string;
  color: string | null;
}

// Fuller shape for the category-management screen.
export interface CategoryAdminDTO {
  id: string;
  name: string;
  kind: string;
  color: string | null;
  icon: string | null;
}

export interface MemberDTO {
  id: string;
  name: string;
}

// Richer shape for the member-management screen (the lightweight MemberDTO above
// is what tasks/etc. embed as an assignee).
export interface HouseholdMemberDTO {
  id: string;
  name: string;
  email: string;
  username: string | null;
  role: string;
  mustChangePassword: boolean;
  createdAt: string;
}

export interface RecurrenceDTO {
  kind: string;
  interval: number;
  byWeekday: string | null;
  byMonthday: string | null;
  timezone: string;
  until: string | null;
  nextRunAt: string | null;
  // Tasks only (bills/events leave these out):
  /** Runs in cycles that roll over at local midnight (see src/lib/taskCycles.ts). */
  rollover?: boolean;
  /** Weekly cycle start days, "1,5" (0 = Sunday). */
  cycleWeekdays?: string | null;
  /** Monthly cycle start days, "1,20". */
  cycleMonthdays?: string | null;
}

export interface SubtaskDTO {
  id: string;
  title: string;
  done: boolean;
  // When the item was last checked (null when unchecked).
  doneAt: string | null;
  /** Who checked it. */
  doneBy: MemberDTO | null;
  /** Who its points are queued for this cycle (survives the step's own reset). */
  queuedFor: MemberDTO | null;
  // Auto-uncheck cadence in days; null = resets only with the parent task.
  resetIntervalDays: number | null;
  position: number;
  /** This step's share: whole minutes and points (2 decimals). */
  minutes: number;
  points: number;
  /** Time set by hand. */
  minutesCustom: boolean;
  /** false = points set by hand. */
  pointsFollowTime: boolean;
}

export interface TaskCompletionDTO {
  id: string;
  note: string | null;
  completedAt: string;
  user: MemberDTO | null;
  /** "completed" | "missed" (a cycle ran out unfinished). */
  outcome: string;
  undoneAt: string | null;
  /** Points paid by this completion (not counting voided ones). */
  points: number;
  /** The caller may undo it now (completer within 10 min, or the head). */
  canUndo: boolean;
}

export interface PointsSettingsDTO {
  timezone: string;
  /** 0 = Sunday. */
  weekStartsOn: number;
  minutesPerPoint: number;
}

export interface PointAwardDTO {
  id: string;
  userId: string;
  userName: string | null;
  taskId: string;
  subtaskId: string | null;
  /** "task" | "step" | "step_repeat" */
  kind: string;
  points: number;
  taskTitle: string;
  stepTitle: string | null;
  earnedAt: string;
  awardedAt: string;
  voided: boolean;
  voidReason: string | null;
}

export interface PointsSummaryDTO {
  period: 'day' | 'week' | 'month' | 'year';
  start: string;
  end: string;
  /** First local date of the period, "YYYY-MM-DD". */
  startDate: string;
  days: number;
  /** Days of the period started so far: the per-day divisor. */
  elapsedDays: number;
  timezone: string;
  members: {
    userId: string;
    name: string;
    points: number;
    perDay: number;
    awards: number;
    /** Checked steps waiting for their task to be completed (any period). */
    queued: number;
  }[];
  householdTotal: number;
  averagePerPerson: number;
  averagePerPersonPerDay: number;
}

export interface PlaceRefDTO {
  id: string;
  name: string;
}

export interface FloorDTO {
  id: string;
  name: string;
  position: number;
}

export interface RoomDTO {
  id: string;
  name: string;
  /** null = not on any floor. */
  floorId: string | null;
  position: number;
}

/** One of a task's places: a room (and its floor), or a whole floor (room null). */
export interface TaskPlaceDTO {
  room: PlaceRefDTO | null;
  floor: PlaceRefDTO | null;
}

/** GET /api/places: every floor and room, each in its hand-set order. */
export interface PlacesDTO {
  floors: FloorDTO[];
  rooms: RoomDTO[];
}

/** GET /api/map-places: a spot on the map (home first, then by name). */
export interface MapPlaceDTO {
  id: string;
  name: string;
  /** MapPlaceKind: "home" | "store" | "other". */
  kind: string;
  lat: number;
  lng: number;
  radiusM: number;
  /** Stores: the shopping lists reminded about on arrival (existing ones only). */
  shoppingListIds: string[];
}

/** GET /api/location/presence: one member who shares their location. */
export interface MemberPresenceDTO {
  userId: string;
  name: string;
  /** PresenceState: "place" | "away". */
  state: string;
  /** The map place they're at; null when away. */
  place: { id: string; name: string; kind: string } | null;
  /** When their phone noticed it (ISO). */
  since: string;
  /** Away: where the phone was when they left, or a live check's last fix if
   *  that came later (`at` says when). Null at a place (the place is where they
   *  are) or when the phone sent no fix. */
  point: { lat: number; lng: number; accuracyM: number | null; at: string } | null;
  /** Their phone's last battery reading; null before it sent one. */
  battery: BatteryReading | null;
}

/** A live location check, as the person checking and the person checked see it. */
export interface LiveCheckDTO {
  id: string;
  requesterId: string;
  requesterName: string;
  targetId: string;
  targetName: string;
  startedAt: string;
  endsAt: string;
  intervalSec: number;
  /** LiveCheckState: "waiting" | "live" | "no_answer" | "ended". */
  state: string;
  /** The latest fix; null before the first and once the check has closed. */
  fix: { lat: number; lng: number; accuracyM: number | null; at: string } | null;
  /** For the person checked: whether they may stop it (not a supervisor's
   *  check under required sharing). Only set when they're the one asking. */
  canStopOnMe?: boolean;
}

/** One check in the checked person's log (Profile → Location). */
export interface LiveCheckLogDTO {
  id: string;
  requesterName: string;
  startedAt: string;
  /** When it closed; null while it's running. */
  endedAt: string | null;
  /** "requester" | "me" (stopped early by them or by me) | null (ran its time). */
  stoppedBy: string | null;
  /** Their phone sent at least one fix. */
  answered: boolean;
}

/** GET /api/location/checks: everything about live checks for the signed-in member. */
export interface LiveChecksOverviewDTO {
  /** A check running on me right now (my phone keeps it going). */
  onMe: LiveCheckDTO | null;
  /** Checks I started that are still running. */
  started: LiveCheckDTO[];
  /** Checks on me in the last 30 days, newest first. */
  log: LiveCheckLogDTO[];
  /** Who I may start a check on: others who share and allow it. Empty below adult. */
  checkable: { id: string; name: string }[];
  settings: { maxMinutes: number; minIntervalSec: number };
  choices: { minutes: number[]; intervals: number[]; defaultMinutes: number; defaultIntervalSec: number };
  /** False when this server can't reach phones instantly (no Firebase): checks can't start. */
  available: boolean;
}

/** POST /api/location/presence: what the phone shows after reporting. */
export interface PresenceReportDTO {
  /** Arrived at a store with lists still to buy: the phone posts a reminder. */
  reminder: {
    placeId: string;
    placeName: string;
    lists: { id: string; name: string; openItems: number }[];
  } | null;
  /** Arrived home with tasks of theirs due today or overdue: "You're home: 3 chores due". */
  home: {
    /** How many are due. */
    count: number;
    /** The first few, soonest due first. */
    titles: string[];
  } | null;
}

/** GET /api/map-places/search: one address match for the pin picker. */
export interface AddressMatchDTO {
  label: string;
  lat: number;
  lng: number;
}

export interface TaskDTO {
  id: string;
  /** Who created it (user id); null = nobody recorded. Drives own vs others' access. */
  createdById: string | null;
  title: string;
  notes: string | null;
  type: string;
  priority: string;
  status: string;
  dueDate: string | null;
  completedAt: string | null;
  createdAt: string;
  /** Live time to complete: the sum of the steps (or the base without steps). */
  estimatedMinutes: number | null;
  /** Live points, same rule. 2 decimals. */
  points: number;
  /** Task-level values the user set (they define the task's rate). */
  baseMinutes: number | null;
  basePoints: number | null;
  pointsFollowTime: boolean;
  /** Household rate, so editors can compute live. */
  minutesPerPoint: number;
  /** Current cycle window (rollover tasks). Completed inside it = done this cycle. */
  cycleStartedAt: string | null;
  cycleEndsAt: string | null;
  /** Recurring tasks without cycles: done for this occurrence, it can't be
   *  completed again before this time. Null or past = open. */
  opensAt: string | null;
  category: CategoryDTO | null;
  /** Its first place (src/lib/places.ts). Both null = the whole house. */
  room: PlaceRefDTO | null;
  /** The whole floor it covers, or its room's floor. */
  floor: PlaceRefDTO | null;
  /** Every place it's done in, in the household's order ([] = the whole house). */
  places: TaskPlaceDTO[];
  /** Hand-set order within its places (null = by due date, after the ordered ones). */
  position: number | null;
  assignee: MemberDTO | null;
  /** Rotating assignees in turn order ([] = no rotation; src/lib/taskRotation.ts). */
  rotation: MemberDTO[];
  /** Whose turn comes after the current assignee (null without a rotation). */
  nextAssignee: MemberDTO | null;
  recurrence: RecurrenceDTO | null;
  subtasks: SubtaskDTO[];
}

export interface ShoppingItemDTO {
  id: string;
  /** Who created it (user id); null = nobody recorded. Drives own vs others' access. */
  createdById: string | null;
  listId: string;
  name: string;
  quantity: number;
  priority: string;
  notes: string | null;
  url: string | null;
  imageUrl: string | null;
  estimatedPrice: number | null;
  recurring: boolean;
  purchased: boolean;
  purchasedAt: string | null;
  category: CategoryDTO | null;
}

// Best-effort Open Graph metadata pulled from a pasted product link. Any field
// may be null when the page can't be read (e.g. Amazon's bot wall) - the UI then
// falls back to manual entry.
export interface LinkPreviewDTO {
  title: string | null;
  imageUrl: string | null;
  price: number | null;
}

export interface ShoppingListDTO {
  id: string;
  /** Who created it (user id); null = nobody recorded. Drives own vs others' access. */
  createdById: string | null;
  name: string;
  kind: string;
  items: ShoppingItemDTO[];
  openCount: number;
  purchasedCount: number;
}

export interface InventoryItemDTO {
  id: string;
  /** Who created it (user id); null = nobody recorded. Drives own vs others' access. */
  createdById: string | null;
  name: string;
  unit: string | null;
  quantity: number;
  lowThreshold: number;
  isLow: boolean;
  reorderIntervalDays: number | null;
  lastRestockedAt: string | null;
  predictedDepletionAt: string | null;
  category: CategoryDTO | null;
  /** Where it's kept (src/lib/places.ts). Both null = not set. */
  room: PlaceRefDTO | null;
  /** The whole floor it's kept on, or its room's floor. */
  floor: PlaceRefDTO | null;
}

export interface NfcTagDTO {
  id: string;
  tagId: string;
  label: string;
  represents: string;
  item: { id: string; name: string } | null;
  /** Location tags: the room a scan opens (null = none set). */
  room: PlaceRefDTO | null;
  /** Android app behaviour on scan: "open" | "notify" (NFC_SCAN_ACTIONS). */
  scanAction: string;
  /** Where "Add to shopping list" puts the item; null = first grocery list. */
  shoppingListId: string | null;
}

/** What a scanned tag resolves to (Android app lookup). */
export interface NfcLookupDTO {
  tagId: string;
  /** Null when the tag isn't set up yet. */
  tag: NfcTagDTO | null;
  /** The bound item, or null (unknown tag, or a tag bound to nothing). */
  item: InventoryItemDTO | null;
}

/** One entry of the scan history (EventLog nfc_scan / nfc_register). */
export interface NfcScanDTO {
  id: string;
  kind: 'scan' | 'register';
  tagId: string;
  itemId: string | null;
  itemName: string | null;
  /** Signed delta applied; null for a setup that set no quantity change. */
  amount: number | null;
  resultQuantity: number | null;
  /** "home_assistant" (HA webhook) or "nfc" (Android app). */
  source: string;
  actorName: string | null;
  createdAt: string;
}

export interface IntegrationDTO {
  id: string;
  name: string;
  active: boolean;
  createdAt: string;
}

// One occurrence of a calendar event (recurring events expand into several).
// baseStart/baseEnd describe the underlying event so the edit form can prefill.
export interface EventOccurrenceDTO {
  eventId: string;
  /** Who created it (user id); null = nobody recorded. Drives own vs others' access. */
  createdById: string | null;
  title: string;
  description: string | null;
  location: string | null;
  allDay: boolean;
  start: string;
  end: string | null;
  baseStart: string;
  baseEnd: string | null;
  recurring: boolean;
  recurrence: RecurrenceDTO | null;
  attendees: MemberDTO[];
}

export interface BillDTO {
  id: string;
  /** Who created it (user id); null = nobody recorded. Drives own vs others' access. */
  createdById: string | null;
  name: string;
  amount: number;
  currentCharges: number | null;
  currency: string | null;
  dueDate: string | null;
  status: string;
  category: string | null;
  autoPay: boolean;
  notes: string | null;
  source: string;
  // Cross-document link key (invoice # > confirmation # > generated) for
  // email-ingested bills; null for manually entered ones.
  reference: string | null;
  recurrence: RecurrenceDTO | null;
  assignee: MemberDTO | null;
  // Paid toward the current balance (fees excluded - `amount` is the portion
  // applied to the balance). For a recurring bill that is only its current
  // cycle's payments. Drives totals, progress and "partially paid".
  paidTotal: number;
  // Every payment the bill has ever had.
  paymentCount: number;
}

export interface BillPaymentDTO {
  id: string;
  /** Who created it (user id); null = nobody recorded. Drives own vs others' access. */
  createdById: string | null;
  billId: string | null;
  // Portion applied to the bill's balance; `fee` is any card surcharge on top.
  amount: number;
  fee: number | null;
  paidAt: string;
  notes: string | null;
  source: string;
  confirmationNo: string | null;
  paidBy: MemberDTO | null;
}

// A bill plus everything the detail page shows: the email-linkage fields the
// list DTO omits, the full payment history, and derived totals.
export interface BillDetailDTO extends BillDTO {
  invoiceNo: string | null;
  accountNo: string | null;
  confirmationNo: string | null;
  billerEmail: string | null;
  /** The original document (Paperless), for "Open in Paperless". */
  sourceUrl: string | null;
  feeTotal: number;
  remaining: number;
  payments: BillPaymentDTO[];
}

// Paperless bill import status (paperlessSync), for the Settings card.
export interface PaperlessSkippedDTO {
  id: number;
  title: string;
  reason: string;
  /** Link to the document in Paperless, when `paperless.public_url` is set. */
  url: string | null;
}

export interface PaperlessSyncResultDTO {
  checked: number;
  /** Count per importer outcome: created / updated / linked / duplicate / skipped. */
  imported: Partial<Record<'created' | 'updated' | 'linked' | 'duplicate' | 'skipped', number>>;
  /** Recent skipped documents, newest first (kept across runs). */
  skipped: PaperlessSkippedDTO[];
}

export interface PaperlessStatusDTO {
  configured: boolean;
  /**
   * Where this household imports from: its own saved Paperless, or the
   * server-wide settings.yml/.env one. null = none. The token is never sent.
   */
  connection: { source: 'household' | 'server'; url: string; publicUrl: string | null } | null;
  /** The viewer may change the connection (Head of House). */
  canEdit: boolean;
  /** Its Paperless may be on the server's private network (else public addresses only). */
  privateNetworkAllowed: boolean;
  /** When the import was switched on; nothing older is imported. */
  since: string | null;
  lastRunAt: string | null;
  lastError: string | null;
  lastResult: PaperlessSyncResultDTO | null;
}

// A stored contact-form submission (global, not household-scoped).
// status: "received" | "emailed" | "email_failed" - see contactService.
export interface ContactMessageDTO {
  id: string;
  name: string;
  email: string;
  description: string;
  status: string;
  createdAt: string;
}

export interface RequestDTO {
  id: string;
  category: string;
  title: string;
  // media
  mediaType: string | null;
  year: number | null;
  season: number | null;
  /** A problem with something the household already has, not a request to add it. */
  issue: boolean;
  /** TV problem reports: the episode within `season`; null is the whole season. */
  episode: number | null;
  // maintenance; also a media problem report's "what's wrong", a purchase's
  // why and a permission's details
  details: string | null;
  // purchase
  url: string | null;
  imageUrl: string | null;
  /** Estimated price of one. */
  price: number | null;
  quantity: number | null;
  /** Approved and put on this shopping list (its name then). */
  addedToList: string | null;
  // permission
  startsAt: string | null;
  endsAt: string | null;
  assignee: MemberDTO | null;
  status: string | null;
  /** Done-by date the assignee committed to (the deadline). */
  dueAt: string | null;
  acceptedAt: string | null;
  completedAt: string | null;
  declinedAt: string | null;
  /** Approve workflow: who marked it done or declined it. */
  decidedBy: MemberDTO | null;
  /** Approve workflow: what they said (a decline's reason). */
  reply: string | null;
  requester: MemberDTO;
  createdAt: string;
  updatedAt: string;
}

export interface NotificationDTO {
  id: string;
  type: string;
  title: string;
  body: string | null;
  channel: string;
  subjectType: string | null;
  subjectId: string | null;
  read: boolean;
  createdAt: string;
}

/** How the site may be reached (Server → Security, and the post-setup prompt). */
export interface AccessSettingsDTO {
  /** Sign-in over plain HTTP on the home network is allowed. */
  allowHttp: boolean;
  /** The Head of House has made a choice (the prompt stops appearing). */
  reviewed: boolean;
  /** The https:// public address, when `better_auth.url` is set. */
  publicUrl: string | null;
  /** How the viewer is connected right now. */
  connection: 'https' | 'localhost' | 'http';
}

/** The head's page-permissions editor (Members → Permissions). */
export interface AccessSettingsMatrixDTO {
  /** Each editable role's default grid (built-in plus the head's edits). */
  roles: Record<EditableRole, AccessMatrix>;
  /** Everyone except the head, with their effective grid. */
  members: {
    id: string;
    name: string;
    role: string;
    access: AccessMatrix;
    /** Has per-member overrides on top of the role default. */
    customized: boolean;
  }[];
}

/** The head's supervision list (the Members page, GET /api/supervision). */
export interface SupervisionDTO {
  /** Everyone who may supervise (adults and up), highest role first. */
  supervisors: { id: string; name: string; role: string }[];
  /** Every child and teen, with who supervises them. */
  supervised: { id: string; name: string; role: string; supervisorIds: string[] }[];
}

/**
 * POST /api/members/setup-link: a link (and its QR code) for putting the app
 * on a child's phone without signing in first. qr.rows: one string of '1'
 * (dark) and '0' per row of modules, size x size, quiet zone not included.
 */
export interface SetupLinkDTO {
  url: string;
  expiresAt: string;
  qr: { size: number; rows: string[] };
}

/** GET /api/supervision/mine: the children and teens the viewer supervises. */
export interface LookAfterDTO {
  /** false when the server can't push (no Firebase): nobody can be rung. */
  canRing: boolean;
  /** sharing: their LocationSharing ("off" | "on" | "required"). phone: their
   *  freshest phone's last check-in and what's wrong with it; null before
   *  any phone of theirs checked in. */
  people: {
    id: string;
    name: string;
    sharing: LocationSharing;
    /** lastPushAt: when an instant alert last reached it (null: none yet, or an
     *  older app). stayConnected: turned on in the app; connected: holding its
     *  connection to this server right now. */
    phone: {
      lastSeenAt: string;
      deviceName: string | null;
      problems: PhoneProblem[];
      lastPushAt: string | null;
      stayConnected: boolean;
      connected: boolean;
    } | null;
    /** shared: a supervisor turned app usage sharing on. latest: the newest day
     *  their phone reported (the phone's own date), with the top apps (app:
     *  the package name; icon: whether /api/supervision/usage/icon has it). */
    appUsage: {
      shared: boolean;
      latest: {
        day: string;
        totalMinutes: number;
        top: UsageAppDTO[];
        updatedAt: string;
      } | null;
    };
    /** The protections their phone must have on (POST /api/supervision/phone-rules). */
    rules: PhoneRules;
    /** The web filter on their phone (POST /api/supervision/web-filter). filter:
     *  the one chosen (null: none). on: whether their phone's Private DNS is set
     *  to it (null: none chosen, no phone checked in yet, or an app too old to say). */
    webFilter: { filter: WebFilter | null; on: boolean | null };
    /** Apps blocked on their phone (POST /api/supervision/blocked-apps), newest
     *  first. alwaysAllowed: package names their phone never blocks (its phone,
     *  messages, home screen and OurHome), so they get no Block. works: whether
     *  "Keep Our Home running" is on there, which does the blocking (null: no
     *  phone checked in yet, or an app too old to say). */
    blocking: {
      apps: BlockedAppDTO[];
      alwaysAllowed: string[];
      works: boolean | null;
    };
    /** The apps in their stored usage (any day kept), by name, apart from the
     *  ones their phone always keeps open: what a limit or a schedule can name. */
    usageApps: { app: string; label: string; icon: boolean }[];
    /** Daily limits on their phone (POST /api/supervision/app-limits). total:
     *  all apps together (null: none). apps: one app each, newest first.
     *  counts: whether Usage access is on there, which counts the minutes
     *  (null: no phone checked in yet, or an app too old to say); the covering
     *  also needs Keep Our Home running (blocking.works). */
    limits: {
      total: AppLimitDTO | null;
      apps: AppLimitDTO[];
      counts: boolean | null;
    };
    /** Schedules on their phone (POST /api/supervision/schedules), earliest start
     *  first. They need Keep Our Home running there (blocking.works). */
    schedules: ScheduleDTO[];
    /** Points for screen time (POST /api/supervision/points-time, /extra-time).
     *  available: the household uses Points. rule: what a point buys and the
     *  most minutes a day (null: they can't buy time). balanceCenti: points they
     *  can spend (earned minus spent), in hundredths. day: today in the
     *  household's time zone; bought and given: its extra minutes. */
    pointsTime: {
      available: boolean;
      rule: { minutesPerPoint: number; dailyCap: number; byName: string; at: string } | null;
      balanceCenti: number;
      day: string;
      bought: number;
      given: number;
    };
    /** How far Set up this phone has got. passwordChosen: they replaced their
     *  temporary password. steps: what their phone must do, in the app's
     *  order; done is null until a phone of theirs that can say checks in. */
    setup: {
      passwordChosen: boolean;
      steps: { step: PhoneSetupStep; done: boolean | null }[];
    };
    /** The viewer's own last ring of their phone and how it went (lib/ring.ts),
     *  for RING_SHOWN_MS; null when they haven't rung it lately. */
    ring: RingDTO | null;
  }[];
}

/** A ring and what the phone said back. stoppedAfterSec: only for "stopped",
 *  when the phone also said it started ringing. */
export interface RingDTO {
  sentAt: string;
  phase: RingPhase;
  stoppedAfterSec: number | null;
}

/** One app's time on a day of someone's app usage. app: the package name; icon: whether /api/supervision/usage/icon has it. */
export interface UsageAppDTO {
  app: string;
  label: string;
  minutes: number;
  icon: boolean;
}

/** An app blocked on a child's phone: who blocked it (byName) and when (at). */
export interface BlockedAppDTO {
  app: string;
  label: string;
  icon: boolean;
  byName: string;
  at: string;
}

/** A daily limit on a child's phone: app "*" (ALL_APPS) is all apps together. byName: who set it last; at: when. */
export interface AppLimitDTO {
  app: string;
  label: string;
  icon: boolean;
  minutes: number;
  byName: string;
  at: string;
}

/**
 * GET/POST /api/phone/extra-time: the member's own points for screen time.
 * available: they can buy minutes now (someone looks after them, set a rate,
 * the household uses Points, and they have a daily limit). minutesPerPoint and
 * dailyCap: null when off. balanceCenti: points they can spend, in hundredths.
 * day: their phone's date; bought and given: that day's extra minutes.
 */
export interface MyExtraTimeDTO {
  available: boolean;
  hasLimits: boolean;
  minutesPerPoint: number | null;
  dailyCap: number | null;
  balanceCenti: number;
  day: string;
  bought: number;
  given: number;
}

/**
 * A schedule on a child's phone: days 0 (Sunday) to 6, start and end in
 * minutes after midnight on their phone's clock (end before start: past
 * midnight). allowed: the apps still open meanwhile. byName: who saved it
 * last; at: when.
 */
export interface ScheduleDTO {
  id: string;
  name: string;
  days: number[];
  start: number;
  end: number;
  allowed: { app: string; label: string; icon: boolean }[];
  byName: string;
  at: string;
}

/**
 * Every stored day of a member's app usage, newest first, each with all its
 * kept apps (GET /api/supervision/usage/history for a supervisor, GET
 * /api/phone/usage/history for the member themself).
 */
export interface UsageHistoryDTO {
  days: { day: string; totalMinutes: number; apps: UsageAppDTO[]; updatedAt: string }[];
}

/**
 * GET /api/phone/setup: what the signed-in member's phone must have on.
 * webFilter: the web filter chosen for them and the hostname their phone's
 * Private DNS needs (lib/webFilter.ts); null: none.
 */
export interface PhoneSetupDTO {
  /** An adult looks after them; while not, nothing is required. */
  supervised: boolean;
  required: { notifications: boolean; location: boolean; usageAccess: boolean; webFilter: boolean } & PhoneRules;
  webFilter: { filter: WebFilter; label: string; hostname: string } | null;
}

/** The signed-in user's own page access (GET /api/permissions/me). */
export interface MyAccessDTO {
  userId: string;
  role: string;
  /** Already empty on the pages of turned-off features. */
  access: AccessMatrix;
  /** The features the household has on (the server admin turns the rest off). */
  features: Feature[];
}
