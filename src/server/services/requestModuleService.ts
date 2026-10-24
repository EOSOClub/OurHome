import { prisma } from '@/server/db/prisma';
import { pushSync } from '@/server/services/pushService';
import { ConflictError } from '@/server/services/errors';
import { isFeatureEnabled } from '@/server/services/serverAdminService';
import { canBeSupervised, canSupervise } from '@/lib/permissions';
import type { RequestCategory } from '@/lib/enums';
import type { RequestDeciding } from '@/lib/requestAttention';
import {
  approveSettings,
  enabledModules,
  handlesApproval,
  moduleViews,
  parseRequestModules,
  type RequestModuleSettings,
  type RequestModuleView,
  type RequestModulesInput,
} from '@/lib/requestModules';

// The household's request modules (Settings → Request types): which kinds of
// request are on and how each works. The rules themselves are pure, in
// src/lib/requestModules.ts; this loads and saves them.

export async function getRequestModules(householdId: string): Promise<RequestModuleSettings> {
  const household = await prisma.household.findUnique({
    where: { id: householdId },
    select: { requestModules: true },
  });
  return parseRequestModules(household?.requestModules);
}

/** Ids of everyone in the household, for the modules' people lists. */
export async function householdMemberIds(householdId: string): Promise<string[]> {
  const members = await prisma.user.findMany({ where: { householdId }, select: { id: true } });
  return members.map((m) => m.id);
}

/**
 * Each supervised member's supervisors, while both roles still fit (the
 * People you look after list): who decides their requests where the head
 * chose `bySupervisors`.
 */
export async function supervisorsByMember(householdId: string): Promise<Map<string, string[]>> {
  const links = await prisma.supervision.findMany({
    where: { householdId },
    select: {
      supervisorId: true,
      supervisedId: true,
      supervisor: { select: { role: true } },
      supervised: { select: { role: true } },
    },
  });
  const map = new Map<string, string[]>();
  for (const l of links) {
    if (!canSupervise(l.supervisor.role) || !canBeSupervised(l.supervised.role)) continue;
    map.set(l.supervisedId, [...(map.get(l.supervisedId) ?? []), l.supervisorId]);
  }
  return map;
}

/**
 * Head only (the route checks). Every person named must be in the household.
 * A module the caller didn't send (app builds from before Purchase and
 * Permission) keeps what's stored.
 */
export async function saveRequestModules(
  householdId: string,
  input: RequestModulesInput,
): Promise<RequestModuleSettings> {
  const stored = await getRequestModules(householdId);
  const settings: RequestModuleSettings = {
    media: input.media,
    maintenance: input.maintenance,
    purchase: input.purchase ?? stored.purchase,
    permission: input.permission ?? stored.permission,
  };
  const members = new Set(await householdMemberIds(householdId));
  const named: [keyof RequestModuleSettings, string[]][] = [
    ['media', settings.media.handlerIds],
    [
      'maintenance',
      [...settings.maintenance.assigneeIds, ...(settings.maintenance.defaultAssigneeId ? [settings.maintenance.defaultAssigneeId] : [])],
    ],
    // Only what was sent: a stored list may name someone who has left since.
    ['purchase', input.purchase?.handlerIds ?? []],
    ['permission', input.permission?.handlerIds ?? []],
  ];
  for (const [field, ids] of named) {
    if (ids.some((id) => !members.has(id))) {
      throw new ConflictError('Someone chosen is no longer in this household. Reload and try again.', field);
    }
  }

  await prisma.household.update({
    where: { id: householdId },
    data: { requestModules: JSON.stringify(settings) },
  });
  // Who handles what may have changed: phones re-check their request alerts.
  pushSync(householdId, { everyone: true }, 'request');
  return parseRequestModules(JSON.stringify(settings));
}

export interface RequestHandling extends RequestDeciding {
  /** The kinds that are on. */
  on: RequestCategory[];
}

/** What waits on a member: the "Needs you" card and the nav badge. */
export async function getRequestHandling(
  householdId: string,
  userId: string,
  approveSwitch: boolean,
): Promise<RequestHandling> {
  const [settings, memberIds, supervisors] = await Promise.all([
    getRequestModules(householdId),
    householdMemberIds(householdId),
    supervisorsByMember(householdId),
  ]);
  const on = enabledModules(settings);
  const members = new Set(memberIds);
  const approveKinds = on.filter((id) => approveSettings(settings, id) !== null);
  const handles = new Set(
    approveKinds.filter((id) => handlesApproval(approveSettings(settings, id)!, userId, approveSwitch, members)),
  );
  const bySupervisors = new Set(approveKinds.filter((id) => approveSettings(settings, id)!.bySupervisors));
  const supervised = new Set<string>();
  const supervising = new Set<string>();
  for (const [kid, sups] of supervisors) {
    const here = sups.filter((s) => members.has(s));
    if (!members.has(kid) || here.length === 0) continue;
    supervised.add(kid);
    if (here.includes(userId)) supervising.add(kid);
  }
  return { on, handles, bySupervisors, supervised, supervising };
}

/**
 * The modules that are on, as `viewer` sees them (GET /api/requests/modules
 * and the Requests page). `shoppingCreate`: their Shopping "Add" switch; with
 * the Shopping feature on, they may put an approved purchase on a list.
 */
export async function getModuleViews(
  householdId: string,
  viewer: { id: string; role: string },
  access: { create: boolean; approve: boolean },
  shoppingCreate = false,
): Promise<RequestModuleView[]> {
  const [settings, memberIds, supervisors, shoppingOn] = await Promise.all([
    getRequestModules(householdId),
    householdMemberIds(householdId),
    supervisorsByMember(householdId),
    shoppingCreate ? isFeatureEnabled(householdId, 'shopping') : false,
  ]);
  const shoppingLists =
    shoppingOn && settings.purchase.enabled
      ? await prisma.shoppingList.findMany({
          where: { householdId },
          select: { id: true, name: true },
          orderBy: { createdAt: 'asc' },
        })
      : [];
  return moduleViews(settings, viewer, access, memberIds, { supervisors, shoppingLists });
}
