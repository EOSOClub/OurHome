// Single source of truth for the string "enums" used across the schema, Zod
// validation, and UI. (The MongoDB schema stores these as plain strings —
// validated here and in src/lib/validation — see prisma/schema/models.prisma.)

// Household roles, highest authority first. There is exactly one `head` per
// household (the "Head of House"); see src/server/services/userService.ts.
// Teen and child are household members with narrower defaults; a guest is
// someone from outside the household (a sitter, a visitor).
export const USER_ROLES = ['head', 'manager', 'member', 'teen', 'child', 'guest'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const USER_ROLE_LABELS: Record<UserRole, string> = {
  head: 'Head of House',
  manager: 'Manager',
  member: 'Member',
  teen: 'Teen',
  child: 'Child',
  guest: 'Guest',
};

// Authority ranking — higher outranks lower. Used to decide who may manage whom.
export const ROLE_RANK: Record<UserRole, number> = {
  head: 6,
  manager: 5,
  member: 4,
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
  'interval',
  'cron',
] as const;
export type RecurrenceKind = (typeof RECURRENCE_KINDS)[number];

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

// EventLog discriminators (open-ended; these cover the current ingestion paths).
export const EVENT_TYPES = [
  'nfc_scan',
  'nfc_register',
  'inventory_change',
  'task_completion',
  'automation',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const EVENT_SOURCES = [
  'home_assistant',
  'web',
  'system',
  'nfc',
] as const;
export type EventSource = (typeof EVENT_SOURCES)[number];

// Activity feed verbs / subject types (open-ended, but these cover the MVP).
export const ACTIVITY_VERBS = [
  'created',
  'updated',
  'completed',
  'reopened',
  'deleted',
  'adjusted',
  'restocked',
  'consumed',
  'marked_low',
] as const;
export type ActivityVerb = (typeof ACTIVITY_VERBS)[number];

// --- Requests -------------------------------------------------------------

// What a household request is for.
export const REQUEST_CATEGORIES = ['media', 'maintenance'] as const;
export type RequestCategory = (typeof REQUEST_CATEGORIES)[number];

export const REQUEST_CATEGORY_LABELS: Record<RequestCategory, string> = {
  media: 'Media',
  maintenance: 'Maintenance',
};

// Maintenance lifecycle: asked → assignee accepts with a done-by date → done.
export const MAINTENANCE_STATUSES = ['pending', 'accepted', 'completed'] as const;
export type MaintenanceStatus = (typeof MAINTENANCE_STATUSES)[number];

/** Section headers on the requests page. */
export const MAINTENANCE_STATUS_LABELS: Record<MaintenanceStatus, string> = {
  pending: 'Waiting for acceptance',
  accepted: 'In progress',
  completed: 'Done',
};

// Media requests are one step: whoever may approve them (the Requests "Approve"
// switch in the page-access grid) marks them added, which completes them.
// "accepted" only exists on rows from the older accept → available flow and
// still counts as waiting. Requests made before statuses existed have none —
// treat a missing status as pending.
export const MEDIA_STATUS_LABELS: Record<MaintenanceStatus, string> = {
  pending: 'Waiting',
  accepted: 'Waiting',
  completed: 'Added',
};

export const MEDIA_TYPES = ['movie', 'tv'] as const;
export type MediaType = (typeof MEDIA_TYPES)[number];

/** Singular, for the "type of media" select. */
export const MEDIA_TYPE_LABELS: Record<MediaType, string> = {
  movie: 'Movie',
  tv: 'TV show',
};

/** Plural, for the section headers on the requests page. */
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
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export const NOTIFICATION_TYPE_LABELS: Record<NotificationType, string> = {
  overdue: 'Overdue',
  reminder: 'Reminder',
  low_inventory: 'Low stock',
  bill_due: 'Bill due',
  system: 'System',
  bug_report: 'Bug report',
};

// --- Bug reports ----------------------------------------------------------

export const BUG_REPORT_SOURCES = ['web', 'android'] as const;
export type BugReportSource = (typeof BUG_REPORT_SOURCES)[number];

// --- Bills & expenses -----------------------------------------------------

export const BILL_STATUSES = ['unpaid', 'paid'] as const;
export type BillStatus = (typeof BILL_STATUSES)[number];

export const BILL_STATUS_LABELS: Record<BillStatus, string> = {
  unpaid: 'Unpaid',
  paid: 'Paid',
};

// How a bill/payment entered the system. "email" and "paperless" are written by
// src/server/services/billIngestService.ts ("paperless" via paperlessSync).
export const BILL_SOURCES = ['manual', 'email', 'paperless', 'import'] as const;
export type BillSource = (typeof BILL_SOURCES)[number];

// Delivery channels. Only "in_app" is dispatched today; the rest are reserved
// for the email/push/Home Assistant seams (see notificationService).
export const NOTIFICATION_CHANNELS = [
  'in_app',
  'push',
  'home_assistant',
  'discord',
  'email',
] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export const PRIORITY_LABELS: Record<TaskPriority, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  urgent: 'Urgent',
};

export const TASK_TYPE_LABELS: Record<TaskType, string> = {
  one_time: 'One-time',
  recurring: 'Recurring',
  maintenance: 'Maintenance',
  inventory: 'Inventory',
};
