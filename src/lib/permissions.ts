// Central capability matrix mapping household roles to permissions. Kept as
// pure functions so it can be reused on the server (route guards, services) and
// the client (hiding controls a role can't use) and unit-tested in isolation.
//
// Roles (highest first): head > manager > member > teen > child > guest. See
// src/lib/enums.ts.

import { z } from 'zod';
import { ROLE_RANK, isUserRole, type UserRole } from '@/lib/enums';

export const PERMISSIONS = [
  // Rename the household, transfer Head of House.
  'household:manage',
  // Create/edit/remove members, change roles, reset passwords.
  'members:manage',
  // Home Assistant connections, NFC tags, integrations.
  'settings:manage',
  // Add/edit/delete on the feature pages (tasks, calendar, shopping, inventory,
  // bills) is NOT a role permission: it is the per-page access grid below
  // (resolveAccess), which the head edits per role and per member.
  // Mark a task done. Guests may only complete tasks assigned to them — that
  // narrower scope is enforced in taskService.completeTask, not here.
  'tasks:complete',
  // Work with requests: edit/delete your own (requestService), accept and
  // finish ones assigned to you. Everyone. *Submitting* a new request is the
  // Requests "Add" switch in the page-access grid below, and marking media
  // requests added is its "Approve" switch.
  'requests:write',
  // File a bug report about the website or app. Everyone may.
  'bugs:report',
  // Receive bug reports (bell + phone notification). Head-only.
  'bugs:manage',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

// Everyday abilities everyone below manager shares.
const WRITE_MODULES: Permission[] = [
  'tasks:complete',
  'requests:write',
  'bugs:report',
];

const ROLE_PERMISSIONS: Record<UserRole, Permission[]> = {
  head: [...PERMISSIONS],
  manager: ['members:manage', 'settings:manage', ...WRITE_MODULES],
  member: [...WRITE_MODULES],
  teen: [...WRITE_MODULES],
  child: [...WRITE_MODULES],
  guest: [...WRITE_MODULES],
};

/** True when the role grants the permission. Unknown role strings get nothing. */
export function can(role: string, permission: Permission): boolean {
  if (!isUserRole(role)) return false;
  return ROLE_PERMISSIONS[role].includes(permission);
}

/**
 * Whether an actor may administer a member who currently holds `targetRole`.
 * The head may manage anyone; a manager may only manage ranks below their own
 * (members, teens, children and guests), never another manager or the head.
 */
export function canManageMember(
  actorRole: string,
  targetRole: string,
): boolean {
  if (!isUserRole(actorRole) || !isUserRole(targetRole)) return false;
  if (actorRole === 'head') return true;
  if (actorRole === 'manager') return ROLE_RANK[targetRole] < ROLE_RANK.manager;
  return false;
}

/**
 * Whether an actor may assign `targetRole` to a member. The head may assign any
 * role; a manager may only assign the ranks below their own. Assigning `head`
 * is never done here — headship moves via transferHeadship to preserve the
 * single-head invariant.
 */
export function canAssignRole(actorRole: string, targetRole: string): boolean {
  if (!isUserRole(actorRole) || !isUserRole(targetRole)) return false;
  if (targetRole === 'head') return false;
  if (actorRole === 'head') return true;
  if (actorRole === 'manager') return ROLE_RANK[targetRole] < ROLE_RANK.manager;
  return false;
}

// ---------------------------------------------------------------------------
// Page access: what someone may add, edit and delete on each feature page.
//
// Resolution (resolveAccess): the head always has everything. Everyone else
// starts from the built-in default for their role, then the household's edited
// role defaults (Household.roleAccess), then their own per-member overrides
// (User.accessOverrides). "Own" means a record they created (createdById);
// records with no creator (imported bills, email events) count as others'.
// ---------------------------------------------------------------------------

// "shopping" is the items on the lists (and ticking them off); "shoppingLists"
// is adding, renaming and deleting the lists themselves.
export const ACCESS_PAGES = [
  'tasks',
  'calendar',
  'shopping',
  'shoppingLists',
  'inventory',
  'bills',
  'requests',
] as const;
export type AccessPage = (typeof ACCESS_PAGES)[number];

export const ACCESS_PAGE_LABELS: Record<AccessPage, string> = {
  tasks: 'Tasks',
  calendar: 'Calendar',
  shopping: 'Shopping items',
  shoppingLists: 'Shopping lists',
  inventory: 'Inventory',
  bills: 'Bills',
  requests: 'Requests',
};

export const ACCESS_ACTIONS = [
  'create',
  'editOwn',
  'deleteOwn',
  'editOthers',
  'deleteOthers',
  'approve',
] as const;
export type AccessAction = (typeof ACCESS_ACTIONS)[number];

export const ACCESS_ACTION_LABELS: Record<AccessAction, string> = {
  create: 'Add',
  editOwn: 'Edit own',
  deleteOwn: 'Delete own',
  editOthers: "Edit others'",
  deleteOthers: "Delete others'",
  approve: 'Approve',
};

/** Add / edit / delete — what every record page offers. */
const RECORD_ACTIONS = [
  'create',
  'editOwn',
  'deleteOwn',
  'editOthers',
  'deleteOthers',
] as const satisfies readonly AccessAction[];

/**
 * The switches that mean something on each page. Requests has "Add" (submit)
 * and "Approve" (mark media requests added): editing/deleting stays limited to
 * the requester and accepting maintenance to the assignee (requestService),
 * whatever the grid says.
 */
export const PAGE_ACTIONS: Record<AccessPage, readonly AccessAction[]> = {
  tasks: RECORD_ACTIONS,
  calendar: RECORD_ACTIONS,
  shopping: RECORD_ACTIONS,
  shoppingLists: RECORD_ACTIONS,
  inventory: RECORD_ACTIONS,
  bills: RECORD_ACTIONS,
  requests: ['create', 'approve'],
};

export type PageAccess = Record<AccessAction, boolean>;
export type AccessMatrix = Record<AccessPage, PageAccess>;
/** Sparse: only the cells that differ from the layer below. */
export type AccessOverrides = Partial<Record<AccessPage, Partial<PageAccess>>>;

/** Roles whose access the head can edit (the head itself is always full). */
export const EDITABLE_ROLES = ['manager', 'member', 'teen', 'child', 'guest'] as const;
export type EditableRole = (typeof EDITABLE_ROLES)[number];
export type RoleAccessOverrides = Partial<Record<EditableRole, AccessOverrides>>;

const ALL: PageAccess = {
  create: true,
  editOwn: true,
  deleteOwn: true,
  editOthers: true,
  deleteOthers: true,
  approve: true,
};
const NONE: PageAccess = {
  create: false,
  editOwn: false,
  deleteOwn: false,
  editOthers: false,
  deleteOthers: false,
  approve: false,
};

function matrix(fill: (page: AccessPage) => PageAccess): AccessMatrix {
  return Object.fromEntries(
    ACCESS_PAGES.map((p) => [p, { ...fill(p) }]),
  ) as AccessMatrix;
}

const SUBMIT_ONLY: PageAccess = { ...NONE, create: true };
const SUBMIT_AND_APPROVE: PageAccess = { ...NONE, create: true, approve: true };
const OWN_ONLY: PageAccess = { ...NONE, create: true, editOwn: true, deleteOwn: true };
const ADD_ONLY: PageAccess = { ...NONE, create: true };

/**
 * Out-of-the-box defaults. Tasks are head-only; managers and members can
 * change anything on the other pages; managers (and the head) mark media
 * requests added; teens add and change their own calendar, shopping and
 * inventory entries; children can add shopping items; guests change nothing;
 * and everyone may submit requests.
 */
export const BUILTIN_ROLE_ACCESS: Record<EditableRole, AccessMatrix> = {
  manager: matrix((p) =>
    p === 'tasks' ? NONE : p === 'requests' ? SUBMIT_AND_APPROVE : ALL,
  ),
  member: matrix((p) => (p === 'tasks' ? NONE : p === 'requests' ? SUBMIT_ONLY : ALL)),
  teen: matrix((p) =>
    p === 'requests'
      ? SUBMIT_ONLY
      : p === 'calendar' || p === 'shopping' || p === 'inventory'
        ? OWN_ONLY
        : NONE,
  ),
  child: matrix((p) =>
    p === 'requests' ? SUBMIT_ONLY : p === 'shopping' ? ADD_ONLY : NONE,
  ),
  guest: matrix((p) => (p === 'requests' ? SUBMIT_ONLY : NONE)),
};

export const FULL_ACCESS: AccessMatrix = matrix(() => ALL);
export const NO_ACCESS: AccessMatrix = matrix(() => NONE);

function applyOverrides(
  base: AccessMatrix,
  overrides: AccessOverrides | null | undefined,
): AccessMatrix {
  if (!overrides) return base;
  return matrix((p) => ({ ...base[p], ...overrides[p] }));
}

/** A role's default grid: built-in, then the household's edits. */
export function roleDefaultAccess(
  role: EditableRole,
  roleOverrides: RoleAccessOverrides | null | undefined,
): AccessMatrix {
  return applyOverrides(BUILTIN_ROLE_ACCESS[role], roleOverrides?.[role]);
}

/** Someone's effective grid. Unknown roles get nothing. */
export function resolveAccess(
  role: string,
  roleOverrides: RoleAccessOverrides | null | undefined,
  memberOverrides: AccessOverrides | null | undefined,
): AccessMatrix {
  if (role === 'head') return FULL_ACCESS;
  if (!(EDITABLE_ROLES as readonly string[]).includes(role)) return NO_ACCESS;
  return applyOverrides(
    roleDefaultAccess(role as EditableRole, roleOverrides),
    memberOverrides,
  );
}

/**
 * Whether `access` lets `userId` edit or delete a record created by `ownerId`.
 * A null owner (no creator recorded) is always someone else's.
 */
export function canModify(
  access: PageAccess,
  kind: 'edit' | 'delete',
  ownerId: string | null | undefined,
  userId: string,
): boolean {
  const own = !!ownerId && ownerId === userId;
  if (kind === 'edit') return own ? access.editOwn : access.editOthers;
  return own ? access.deleteOwn : access.deleteOthers;
}

/** True when the page grants anything at all (used for check-off style actions). */
export function hasAnyAccess(access: PageAccess): boolean {
  return ACCESS_ACTIONS.some((a) => access[a]);
}

/**
 * The cells of `next` that differ from `base` — what gets stored, so later
 * changes to the layer below still flow through to untouched cells.
 */
export function diffAccess(
  base: AccessMatrix,
  next: AccessMatrix,
): AccessOverrides {
  const out: AccessOverrides = {};
  for (const p of ACCESS_PAGES) {
    for (const a of PAGE_ACTIONS[p]) {
      if (next[p][a] !== base[p][a]) (out[p] ??= {})[a] = next[p][a];
    }
  }
  return out;
}

const pageAccessSchema = z
  .object(
    Object.fromEntries(ACCESS_ACTIONS.map((a) => [a, z.boolean()])) as Record<
      AccessAction,
      z.ZodBoolean
    >,
  )
  .partial();

export const accessOverridesSchema = z
  .object(
    Object.fromEntries(ACCESS_PAGES.map((p) => [p, pageAccessSchema])) as Record<
      AccessPage,
      typeof pageAccessSchema
    >,
  )
  .partial();

export const roleAccessOverridesSchema = z
  .object({
    manager: accessOverridesSchema,
    member: accessOverridesSchema,
    teen: accessOverridesSchema,
    child: accessOverridesSchema,
    guest: accessOverridesSchema,
  })
  .partial();

/** Parse a stored JSON column; anything unreadable is treated as no overrides. */
export function parseStoredJson<T>(
  raw: string | null | undefined,
  schema: z.ZodType<T>,
): T | null {
  if (!raw) return null;
  try {
    const parsed = schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
