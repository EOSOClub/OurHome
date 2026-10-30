// Single source of truth for the string "enums" used across the schema, Zod
// validation, and UI. (The MongoDB schema stores these as plain strings -
// validated here and in src/lib/validation - see prisma/schema/models.prisma.)

// Household roles, most authority first. There is exactly one `head` per
// household (the "Head of House"); see src/server/services/userService.ts.
// Teen and child are household members with narrower defaults; a guest is
// someone from outside the household (a sitter, a visitor). `adult` was stored
// as `member` before 2026-10-11.
export const USER_ROLES = ['head', 'manager', 'adult', 'teen', 'child', 'guest'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const USER_ROLE_LABELS: Record<UserRole, string> = {
  head: 'Head of House',
  manager: 'Manager',
  adult: 'Adult',
  teen: 'Teen',
  child: 'Child',
  guest: 'Guest',
};

// Authority ranking - higher outranks lower. Used to decide who may manage whom.
export const ROLE_RANK: Record<UserRole, number> = {
  head: 6,
  manager: 5,
  adult: 4,
  teen: 3,
  child: 2,
  guest: 1,
};

export function isUserRole(value: string): value is UserRole {
  return (USER_ROLES as readonly string[]).includes(value);
}

// Domain a Category belongs to (matches Category.kind in the schema).
export const CATEGORY_KINDS = [
  'task',
  'shopping',
  'inventory',
  'general',
] as const;
export type CategoryKind = (typeof CATEGORY_KINDS)[number];

export const CATEGORY_KIND_LABELS: Record<CategoryKind, string> = {
  task: 'Tasks',
  shopping: 'Shopping',
  inventory: 'Inventory',
  general: 'General',
};

export const TASK_TYPES = [
  'one_time',
  'recurring',
  'maintenance',
  'inventory',
] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export const TASK_PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const TASK_STATUSES = [
  'pending',
  'in_progress',
  'completed',
  'archived',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const RECURRENCE_KINDS = [
  'daily',
  'weekly',
  'monthly',
  // Same date every N years (birthdays); Feb 29 falls on Feb 28 in other years.
  'yearly',
  'interval',
  'cron',
] as const;
export type RecurrenceKind = (typeof RECURRENCE_KINDS)[number];

// --- Calendar -------------------------------------------------------------

/**
 * What a calendar event is. The first five are picked when making one; "bill"
 * and "subscription" mark a bill's own entry on the calendar (billService).
 */
export const EVENT_KINDS = [
  'event',
  'appointment',
  'birthday',
  'anniversary',
  'reminder',
  'bill',
  'subscription',
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];
export const PICKED_EVENT_KINDS = [
  'event',
  'appointment',
  'birthday',
  'anniversary',
  'reminder',
] as const satisfies readonly EventKind[];
export type PickedEventKind = (typeof PICKED_EVENT_KINDS)[number];

// --- Shopping & grocery ---------------------------------------------------

export const SHOPPING_LIST_KINDS = [
  'grocery',
  'supplies',
  'hardware',
  'amazon',
  'general',
] as const;
export type ShoppingListKind = (typeof SHOPPING_LIST_KINDS)[number];

export const SHOPPING_PRIORITIES = ['low', 'medium', 'high'] as const;
export type ShoppingPriority = (typeof SHOPPING_PRIORITIES)[number];

export const SHOPPING_LIST_KIND_LABELS: Record<ShoppingListKind, string> = {
  grocery: 'Grocery',
  supplies: 'Supplies',
  hardware: 'Hardware',
  amazon: 'Amazon',
  general: 'General',
};

export const SHOPPING_PRIORITY_LABELS: Record<ShoppingPriority, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
};

// --- Inventory, NFC & events ----------------------------------------------

// What a physical NFC tag stands for. Inventory tags are "consumable".
export const NFC_REPRESENTS = [
  'location',
  'action',
  'consumable',
  'maintenance_point',
  'process',
] as const;
export type NfcRepresents = (typeof NFC_REPRESENTS)[number];

export const NFC_REPRESENTS_LABELS: Record<NfcRepresents, string> = {
  location: 'Location',
  action: 'Action',
  consumable: 'Consumable',
  maintenance_point: 'Maintenance point',
  process: 'Process',
};

// What the Android app does when a tag is scanned with the app closed:
// "open" shows the scan sheet; "notify" posts a quick notification (−1 /
// type an amount / add to shopping list) without opening the app.
export const NFC_SCAN_ACTIONS = ['open', 'notify'] as const;
export type NfcScanAction = (typeof NFC_SCAN_ACTIONS)[number];

// --- Requests -------------------------------------------------------------

// What a household request is for: each is a request module the head turns on
// and configures in Settings → Request types (src/lib/requestModules.ts).
export const REQUEST_CATEGORIES = ['media', 'maintenance', 'purchase', 'permission'] as const;
export type RequestCategory = (typeof REQUEST_CATEGORIES)[number];

export const REQUEST_CATEGORY_LABELS: Record<RequestCategory, string> = {
  media: 'Media',
  maintenance: 'Maintenance',
  purchase: 'Purchase',
  permission: 'Permission',
};

// Maintenance lifecycle: asked → assignee accepts with a done-by date → done.
// "declined" only where the head lets the person asked decline.
export const MAINTENANCE_STATUSES = ['pending', 'accepted', 'completed', 'declined'] as const;
export type MaintenanceStatus = (typeof MAINTENANCE_STATUSES)[number];

/** Section headers on the Requests page. */
export const MAINTENANCE_STATUS_LABELS: Record<MaintenanceStatus, string> = {
  pending: 'Waiting for acceptance',
  accepted: 'In progress',
  completed: 'Done',
  declined: 'Declined',
};

// Every status a request can have. "declined" is only possible for requests
// whose module allows declining (Settings → Request types).
export const REQUEST_STATUSES = MAINTENANCE_STATUSES;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

// Media requests are one step: whoever approves them (Settings → Request
// types; by default the Requests "Approve" switch in the page-access grid)
// marks them added (which completes them) or declines them where allowed.
// "accepted" only exists on rows from the older two-step flow (accepted, then
// available) and still counts as waiting. Requests made before statuses
// existed have none - treat a missing status as pending.
export const MEDIA_STATUS_LABELS: Record<RequestStatus, string> = {
  pending: 'Waiting',
  accepted: 'Waiting',
  completed: 'Added',
  declined: 'Declined',
};

// Purchase and Permission are yes-or-no: whoever decides approves them (which
// completes them) or declines them.
export const DECISION_STATUS_LABELS: Record<RequestStatus, string> = {
  pending: 'Waiting',
  accepted: 'Waiting',
  completed: 'Approved',
  declined: 'Declined',
};

export const MEDIA_TYPES = ['movie', 'tv'] as const;
export type MediaType = (typeof MEDIA_TYPES)[number];

/** Singular, for the "type of media" select. */
export const MEDIA_TYPE_LABELS: Record<MediaType, string> = {
  movie: 'Movie',
  tv: 'TV show',
};

/** Plural, for the section headers on the Requests page. */
export const MEDIA_TYPE_SECTION_LABELS: Record<MediaType, string> = {
  movie: 'Movies',
  tv: 'TV shows',
};

// --- Notifications --------------------------------------------------------

export const NOTIFICATION_TYPES = [
  'overdue',
  'reminder',
  'low_inventory',
  'bill_due',
  'system',
  // Sent to bugs:manage holders (the head) when someone files a bug report.
  'bug_report',
  // Sent to a task's assignee when it becomes theirs to do: assigned to them,
  // their turn in a rotation, or a new cycle/occurrence (taskReadyService).
  'task_ready',
  // Sent to a child's supervisors when their phone goes quiet, or location or
  // Usage access is turned off while needed (phoneStatusService). Removed once fixed.
  'phone_alert',
  // Sent to a child's supervisors when their phone has a new app, while their
  // app usage is shared (appUsageService.reportNewApps).
  'new_app',
  // Sent to a child's supervisors when their phone used up a daily limit, once
  // per limit and day (appLimitService.reportLimitsReached).
  'limit_reached',
  // Sent to a child's supervisors when they spend points on more screen time
  // (pointsTimeService.buyExtraTime).
  'extra_time',
  // Sent to a child's supervisors when the parent PIN was entered wrong too
  // often on their phone, opened a protected screen there, or unlocked
  // OurHome there (parentPinService.reportPinEvents).
  'parent_pin',
  // Sent to a requester when someone else approves, declines, accepts or
  // finishes their request (requestNoticeService).
  'request_update',
  // Sent to an event's attendees and creator at the reminder time they picked,
  // one per date; gone once that date's event is over (reminderService).
  'event_reminder',
  // Sent to a subscription's responsible person and Bills managers from 3 days
  // before its free trial ends until that day is over (reminderService).
  'subscription_trial',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export const NOTIFICATION_TYPE_LABELS: Record<NotificationType, string> = {
  overdue: 'Overdue',
  reminder: 'Reminder',
  low_inventory: 'Low stock',
  bill_due: 'Bill due',
  system: 'System',
  bug_report: 'Bug report',
  task_ready: 'Your turn',
  phone_alert: 'Phone',
  new_app: 'New app',
  limit_reached: 'Limit reached',
  extra_time: 'Extra time',
  parent_pin: 'Parent PIN',
  request_update: 'Request',
  event_reminder: 'Event',
  subscription_trial: 'Subscription',
};

// --- Bug reports ----------------------------------------------------------

export const BUG_REPORT_SOURCES = ['web', 'android'] as const;

// --- Bills & expenses -----------------------------------------------------

export const BILL_STATUSES = ['unpaid', 'paid'] as const;
/** A bill is a service to the home (power, water, internet); a subscription is an extra. */
export const BILL_KINDS = ['bill', 'subscription'] as const;
export type BillKind = (typeof BILL_KINDS)[number];
export type BillStatus = (typeof BILL_STATUSES)[number];

export const BILL_STATUS_LABELS: Record<BillStatus, string> = {
  unpaid: 'Unpaid',
  paid: 'Paid',
};

export const PRIORITY_LABELS: Record<TaskPriority, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  urgent: 'Urgent',
};

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  pending: 'To do',
  in_progress: 'In progress',
  completed: 'Completed',
  archived: 'Archived',
};

export const TASK_TYPE_LABELS: Record<TaskType, string> = {
  one_time: 'One-time',
  recurring: 'Recurring',
  maintenance: 'Maintenance',
  inventory: 'Inventory',
};
