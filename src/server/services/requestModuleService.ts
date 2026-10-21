import { prisma } from '@/server/db/prisma';
import { pushSync } from '@/server/services/pushService';
import { ConflictError } from '@/server/services/errors';
import type { RequestCategory } from '@/lib/enums';
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

/** Head only (the route checks). Every person named must be in the household. */
export async function saveRequestModules(
  householdId: string,
  input: RequestModulesInput,
): Promise<RequestModuleSettings> {
  const members = new Set(await householdMemberIds(householdId));
  const named: [keyof RequestModulesInput, string[]][] = [
    ['media', input.media.handlerIds],
    [
      'maintenance',
      [...input.maintenance.assigneeIds, ...(input.maintenance.defaultAssigneeId ? [input.maintenance.defaultAssigneeId] : [])],
    ],
  ];
  for (const [field, ids] of named) {
    if (ids.some((id) => !members.has(id))) {
      throw new ConflictError('Someone chosen is no longer in this household. Reload and try again.', field);
    }
  }

  await prisma.household.update({
    where: { id: householdId },
    data: { requestModules: JSON.stringify(input) },
  });
  // Who handles what may have changed: phones re-check their request alerts.
  pushSync(householdId, { everyone: true }, 'request');
  return parseRequestModules(JSON.stringify(input));
}

export interface RequestHandling {
  /** The kinds that are on. */
  on: RequestCategory[];
  /** The approve-workflow kinds among them that the member handles. */
  handles: Set<RequestCategory>;
}

/** What waits on a member: the "Needs you" card and the nav badge. */
export async function getRequestHandling(
  householdId: string,
  userId: string,
  approveSwitch: boolean,
): Promise<RequestHandling> {
  const [settings, memberIds] = await Promise.all([getRequestModules(householdId), householdMemberIds(householdId)]);
  const on = enabledModules(settings);
  const members = new Set(memberIds);
  const handles = new Set(
    on.filter((id) => {
      const approve = approveSettings(settings, id);
      return approve !== null && handlesApproval(approve, userId, approveSwitch, members);
    }),
  );
  return { on, handles };
}

/** The modules that are on, as `viewer` sees them (GET /api/requests/modules and the Requests page). */
export async function getModuleViews(
  householdId: string,
  viewer: { id: string; role: string },
  access: { create: boolean; approve: boolean },
): Promise<RequestModuleView[]> {
  const [settings, memberIds] = await Promise.all([getRequestModules(householdId), householdMemberIds(householdId)]);
  return moduleViews(settings, viewer, access, memberIds);
}
