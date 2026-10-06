// Central capability matrix mapping household roles to permissions. Kept as
// pure functions so it can be reused on the server (route guards, services) and
// the client (hiding controls a role can't use) and unit-tested in isolation.
//
// Roles (highest first): head > manager > member > guest. See src/lib/enums.ts.

import { ROLE_RANK, isUserRole, type UserRole } from '@/lib/enums';

export const PERMISSIONS = [
  // Rename the household, transfer Head of House.
  'household:manage',
  // Create/edit/remove members, change roles, reset passwords.
  'members:manage',
  // Home Assistant connections, NFC tags, integrations.
  'settings:manage',
  // Create/edit/delete and assign work across the shared feature modules.
  // tasks:write (create/edit/delete tasks and their checklists) is head-only;
  // everyone else works tasks through tasks:complete. See docs/permissions.md.
  'tasks:write',
  'shopping:write',
  'inventory:write',
  'calendar:write',
  'bills:write',
  // Mark a task done. Guests may only complete tasks assigned to them — that
  // narrower scope is enforced in taskService.completeTask, not here.
  'tasks:complete',
  // Make requests (e.g. movies/TV). Everyone may; editing or deleting is
  // limited to the requester's own requests in requestService.
  'requests:write',
  // Accept media (movie/TV) requests and mark them available. Head-only; the
  // app sends the "waiting for you" reminders to whoever holds this.
  'requests:manage_media',
  // File a bug report about the website or app. Everyone may.
  'bugs:report',
  // Receive bug reports (bell + phone notification). Head-only.
  'bugs:manage',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

// Shared module writes for manager/member. tasks:write is deliberately absent:
// only the head creates, edits or deletes tasks.
const WRITE_MODULES: Permission[] = [
  'shopping:write',
  'inventory:write',
  'calendar:write',
  'bills:write',
  'tasks:complete',
  'requests:write',
  'bugs:report',
];

const ROLE_PERMISSIONS: Record<UserRole, Permission[]> = {
  head: [...PERMISSIONS],
  manager: ['members:manage', 'settings:manage', ...WRITE_MODULES],
  member: [...WRITE_MODULES],
  guest: ['tasks:complete', 'requests:write', 'bugs:report'],
};

/** True when the role grants the permission. Unknown role strings get nothing. */
export function can(role: string, permission: Permission): boolean {
  if (!isUserRole(role)) return false;
  return ROLE_PERMISSIONS[role].includes(permission);
}

/**
 * Whether an actor may administer a member who currently holds `targetRole`.
 * The head may manage anyone; a manager may only manage ranks below their own
 * (members and guests), never another manager or the head.
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
 * role; a manager may only assign member or guest. Assigning `head` is never
 * done here — headship moves via transferHeadship to preserve the single-head
 * invariant.
 */
export function canAssignRole(actorRole: string, targetRole: string): boolean {
  if (!isUserRole(actorRole) || !isUserRole(targetRole)) return false;
  if (targetRole === 'head') return false;
  if (actorRole === 'head') return true;
  if (actorRole === 'manager')
    return targetRole === 'member' || targetRole === 'guest';
  return false;
}
