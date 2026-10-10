// Features the server admin can turn off per household (Server → Households →
// Features), so a household that only needs tasks and a calendar doesn't see
// shopping, stock, bills or requests. Stored as the *turned-off* list
// (Household.disabledFeatures), so a household created before this — or a
// feature added later — starts with everything on.
//
// Pure, shared by the server (API guard, pages, reminder sweep) and the client
// (nav, menus). Dashboard, activity, notifications, profile, members and
// settings are always on.

import { ACCESS_PAGES, type AccessMatrix, type AccessPage } from '@/lib/permissions';

export const FEATURES = [
  'tasks',
  'points',
  'calendar',
  'shopping',
  'inventory',
  'bills',
  'requests',
] as const;
export type Feature = (typeof FEATURES)[number];

export const FEATURE_LABELS: Record<Feature, string> = {
  tasks: 'Tasks',
  points: 'Points',
  calendar: 'Calendar',
  shopping: 'Shopping',
  inventory: 'Inventory',
  bills: 'Bills',
  requests: 'Requests',
};

export const FEATURE_DESCRIPTIONS: Record<Feature, string> = {
  tasks: 'Chores and checklists, with reminders.',
  points: 'Points for finished tasks and the weekly leaderboard. Needs Tasks.',
  calendar: 'Household events.',
  shopping: 'Shopping lists.',
  inventory: 'Stock levels, low-stock alerts and NFC tags.',
  bills: 'Bills, payments and the Paperless import.',
  requests: 'Media and maintenance requests.',
};

export function isFeature(value: string): value is Feature {
  return (FEATURES as readonly string[]).includes(value);
}

/** The features that are on, from the stored turned-off list. */
export function enabledFeatures(disabled: readonly string[] | null | undefined): Feature[] {
  const off = new Set(disabled ?? []);
  // Points are earned on tasks: without Tasks there's nothing to score.
  if (off.has('tasks')) off.add('points');
  return FEATURES.filter((f) => !off.has(f));
}

/** Which feature each access-grid page belongs to. */
export const ACCESS_PAGE_FEATURE: Record<AccessPage, Feature> = {
  tasks: 'tasks',
  calendar: 'calendar',
  shopping: 'shopping',
  shoppingLists: 'shopping',
  inventory: 'inventory',
  bills: 'bills',
  requests: 'requests',
};

/** Pages of a turned-off feature grant nothing, so their add buttons and
 *  managers' alerts disappear along with the page. */
export function maskAccess(access: AccessMatrix, features: readonly Feature[]): AccessMatrix {
  const on = new Set(features);
  const out = { ...access };
  for (const p of ACCESS_PAGES) {
    if (!on.has(ACCESS_PAGE_FEATURE[p])) {
      out[p] = Object.fromEntries(Object.keys(access[p]).map((a) => [a, false])) as AccessMatrix[AccessPage];
    }
  }
  return out;
}

// First path segment (pages and /api alike) → the feature it belongs to.
// Anything not listed (dashboard, activity, notifications, profile, members,
// settings, auth, push, app, server, ...) is always available.
const SEGMENT_FEATURE: Record<string, Feature> = {
  tasks: 'tasks',
  subtasks: 'tasks',
  points: 'points',
  calendar: 'calendar',
  shopping: 'shopping',
  inventory: 'inventory',
  nfc: 'inventory',
  bills: 'bills',
  requests: 'requests',
};

// Deeper paths inside an always-on area that still belong to a feature: the
// Paperless connection (Settings) only feeds Bills.
const NESTED_FEATURE: Record<string, Feature> = {
  'integrations/paperless': 'bills',
};

/** The feature a page or API path belongs to, or null when it's always on. */
export function featureForPath(pathname: string): Feature | null {
  const parts = pathname.split('/').filter(Boolean);
  const rest = parts[0] === 'api' ? parts.slice(1) : parts;
  const nested = NESTED_FEATURE[rest.slice(0, 2).join('/')];
  if (nested) return nested;
  return (rest[0] && SEGMENT_FEATURE[rest[0]]) || null;
}

/** Notification subjects that belong to a feature, so a turned-off feature's
 *  old notifications leave the bell. */
export const SUBJECT_TYPE_FEATURE: Record<string, Feature> = {
  task: 'tasks',
  event: 'calendar',
  shopping_list: 'shopping',
  shopping_item: 'shopping',
  inventory_item: 'inventory',
  nfc_tag: 'inventory',
  bill: 'bills',
  request: 'requests',
};

export function hiddenSubjectTypes(features: readonly Feature[]): string[] {
  const on = new Set(features);
  return Object.entries(SUBJECT_TYPE_FEATURE)
    .filter(([, f]) => !on.has(f))
    .map(([t]) => t);
}
