import { prisma } from '@/server/db/prisma';
import { logActivity } from '@/server/services/activityService';
import { ForbiddenError, NotFoundError } from '@/server/services/errors';
import { ROLE_RANK, USER_ROLE_LABELS, isUserRole } from '@/lib/enums';
import {
  EDITABLE_ROLES,
  accessOverridesSchema,
  diffAccess,
  parseStoredJson,
  resolveAccess,
  roleAccessOverridesSchema,
  roleDefaultAccess,
  type AccessAction,
  type AccessMatrix,
  type AccessOverrides,
  type AccessPage,
  type EditableRole,
  type RoleAccessOverrides,
} from '@/lib/permissions';
import type { AccessSettingsMatrixDTO } from '@/lib/types';
import { ACCESS_PAGE_FEATURE, maskAccess } from '@/lib/features';
import { getHouseholdFeatures } from '@/server/services/serverAdminService';

// Page access (add / edit / delete per page) — loading someone's effective grid
// and the head's editor for role defaults and per-member overrides. The pure
// resolution rules live in src/lib/permissions.ts.

async function loadRoleOverrides(
  householdId: string,
): Promise<RoleAccessOverrides | null> {
  const household = await prisma.household.findUnique({
    where: { id: householdId },
    select: { roleAccess: true },
  });
  return parseStoredJson(household?.roleAccess, roleAccessOverridesSchema);
}

/**
 * The effective grid for a signed-in user. Read fresh from the database (not
 * the session cookie cache) so the head's changes apply on the next request.
 */
export async function getUserAccess(user: {
  id: string;
  householdId: string | null;
}): Promise<AccessMatrix> {
  const row = await prisma.user.findUnique({
    where: { id: user.id },
    select: { role: true, accessOverrides: true, householdId: true },
  });
  if (!row?.householdId) return resolveAccess('', null, null);
  const [roleOverrides, features] = await Promise.all([
    loadRoleOverrides(row.householdId),
    getHouseholdFeatures(row.householdId),
  ]);
  // A feature the server admin turned off grants nothing, even to the head.
  return maskAccess(
    resolveAccess(row.role, roleOverrides, parseStoredJson(row.accessOverrides, accessOverridesSchema)),
    features,
  );
}

/** Ids of the household's members whose grid grants `action` on `page`. */
export async function membersWithAccess(
  householdId: string,
  page: AccessPage,
  action: AccessAction,
): Promise<string[]> {
  const [roleOverrides, users, features] = await Promise.all([
    loadRoleOverrides(householdId),
    prisma.user.findMany({
      where: { householdId },
      select: { id: true, role: true, accessOverrides: true },
    }),
    getHouseholdFeatures(householdId),
  ]);
  if (!features.includes(ACCESS_PAGE_FEATURE[page])) return [];
  return users
    .filter(
      (u) =>
        resolveAccess(
          u.role,
          roleOverrides,
          parseStoredJson(u.accessOverrides, accessOverridesSchema),
        )[page][action],
    )
    .map((u) => u.id);
}

/** Everything the head's permissions editor shows. */
export async function getAccessSettings(
  householdId: string,
): Promise<AccessSettingsMatrixDTO> {
  const [roleOverrides, users] = await Promise.all([
    loadRoleOverrides(householdId),
    prisma.user.findMany({
      where: { householdId },
      select: { id: true, name: true, role: true, accessOverrides: true },
    }),
  ]);

  const roles = Object.fromEntries(
    EDITABLE_ROLES.map((r) => [r, roleDefaultAccess(r, roleOverrides)]),
  ) as Record<EditableRole, AccessMatrix>;

  const members = users
    .filter((u) => u.role !== 'head')
    .sort((a, b) => {
      const ra = isUserRole(a.role) ? ROLE_RANK[a.role] : 0;
      const rb = isUserRole(b.role) ? ROLE_RANK[b.role] : 0;
      if (ra !== rb) return rb - ra;
      return a.name.localeCompare(b.name);
    })
    .map((u) => {
      const overrides = parseStoredJson(u.accessOverrides, accessOverridesSchema);
      return {
        id: u.id,
        name: u.name,
        role: u.role,
        access: resolveAccess(u.role, roleOverrides, overrides),
        customized: !!overrides && Object.keys(overrides).length > 0,
      };
    });

  return { roles, members };
}

function serialize(overrides: AccessOverrides | RoleAccessOverrides): string | null {
  return Object.keys(overrides).length > 0 ? JSON.stringify(overrides) : null;
}

/** Replace a role's default grid. Only the cells that differ from built-in are stored. */
export async function setRoleAccess(
  householdId: string,
  actorId: string,
  role: EditableRole,
  access: AccessMatrix,
): Promise<AccessSettingsMatrixDTO> {
  const current = (await loadRoleOverrides(householdId)) ?? {};
  const diff = diffAccess(roleDefaultAccess(role, null), access);
  const next: RoleAccessOverrides = { ...current, [role]: diff };
  if (Object.keys(diff).length === 0) delete next[role];

  await prisma.household.update({
    where: { id: householdId },
    data: { roleAccess: serialize(next) },
  });
  await logActivity({
    householdId,
    actorId,
    verb: 'updated',
    subjectType: 'permissions',
    message: `changed the default permissions for ${USER_ROLE_LABELS[role]}s`,
  });
  return getAccessSettings(householdId);
}

/**
 * Set one member's grid. Stored as the cells that differ from their role's
 * default; `null` resets them to the role default.
 */
export async function setMemberAccess(
  householdId: string,
  actorId: string,
  memberId: string,
  access: AccessMatrix | null,
): Promise<AccessSettingsMatrixDTO> {
  const member = await prisma.user.findFirst({
    where: { id: memberId, householdId },
    select: { id: true, name: true, role: true },
  });
  if (!member) throw new NotFoundError(`Member ${memberId} not found.`);
  if (!(EDITABLE_ROLES as readonly string[]).includes(member.role)) {
    throw new ForbiddenError('The Head of House always has full access.');
  }

  let stored: string | null = null;
  if (access) {
    const roleOverrides = await loadRoleOverrides(householdId);
    const base = roleDefaultAccess(member.role as EditableRole, roleOverrides);
    stored = serialize(diffAccess(base, access));
  }

  await prisma.user.update({
    where: { id: member.id },
    data: { accessOverrides: stored },
  });
  await logActivity({
    householdId,
    actorId,
    verb: 'updated',
    subjectType: 'permissions',
    subjectId: member.id,
    message: access
      ? `changed ${member.name}’s permissions`
      : `reset ${member.name}’s permissions to the role default`,
  });
  return getAccessSettings(householdId);
}

// --- Record owners --------------------------------------------------------
// Who created a record, for "own" vs "others'" checks in the route handlers.
// Each throws NotFoundError when the record isn't in the household.

function found<T>(row: T | null, what: string, id: string): T {
  if (!row) throw new NotFoundError(`${what} ${id} not found.`);
  return row;
}

export const recordOwner = {
  async task(householdId: string, id: string) {
    const row = await prisma.task.findFirst({
      where: { id, householdId },
      select: { createdById: true },
    });
    return found(row, 'Task', id).createdById;
  },
  async subtask(householdId: string, id: string) {
    const row = await prisma.subtask.findFirst({
      where: { id, task: { householdId } },
      select: { task: { select: { createdById: true } } },
    });
    return found(row, 'Checklist item', id).task.createdById;
  },
  async event(householdId: string, id: string) {
    const row = await prisma.event.findFirst({
      where: { id, householdId },
      select: { createdById: true },
    });
    return found(row, 'Event', id).createdById;
  },
  async shoppingList(householdId: string, id: string) {
    const row = await prisma.shoppingList.findFirst({
      where: { id, householdId },
      select: { createdById: true },
    });
    return found(row, 'Shopping list', id).createdById;
  },
  async shoppingItem(householdId: string, id: string) {
    const row = await prisma.shoppingItem.findFirst({
      where: { id, list: { householdId } },
      select: { createdById: true },
    });
    return found(row, 'Shopping item', id).createdById;
  },
  async inventoryItem(householdId: string, id: string) {
    const row = await prisma.inventoryItem.findFirst({
      where: { id, householdId },
      select: { createdById: true },
    });
    return found(row, 'Inventory item', id).createdById;
  },
  async bill(householdId: string, id: string) {
    const row = await prisma.bill.findFirst({
      where: { id, householdId },
      select: { createdById: true },
    });
    return found(row, 'Bill', id).createdById;
  },
  async billPayment(householdId: string, id: string) {
    const row = await prisma.billPayment.findFirst({
      where: { id, householdId },
      select: { createdById: true },
    });
    return found(row, 'Payment', id).createdById;
  },
};
