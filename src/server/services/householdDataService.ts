import { prisma } from '@/server/db/prisma';
import { ConflictError, NotFoundError } from '@/server/services/errors';
import { assertServerAdmin, clearHouseholdCaches } from '@/server/services/serverAdminService';

// Everything a household owns, for its export (Head of House) and for
// deleting it (server admin). Mongo has no foreign keys and several models
// point at their household or parent by a plain id (points ledger, pending
// credits, notification subjects), so both walk an explicit list instead of
// trusting cascades. `HOUSEHOLD_MODELS` / `SERVER_MODELS` must name every
// model in the schema — src/server/services/householdDataService.test.ts
// fails when a new one is added without deciding how it's exported and deleted.

/** Every model that belongs to a household, directly or through a parent. */
export const HOUSEHOLD_MODELS = [
  'Household',
  'User',
  'Session',
  'Account',
  'Category',
  'Task',
  'RecurrenceRule',
  'TaskCompletion',
  'Subtask',
  'PendingCredit',
  'PointAward',
  'ActivityEntry',
  'Event',
  'EventAttendee',
  'Bill',
  'BillPayment',
  'ShoppingList',
  'ShoppingItem',
  'Request',
  'BugReport',
  'InventoryItem',
  'Purchase',
  'Notification',
  'PaperlessSync',
  'PaperlessConnection',
  'PushDevice',
  'EventLog',
  'NfcTag',
  'HomeAssistantIntegration',
] as const;

/** Server-wide models no household owns (kept when a household goes). */
export const SERVER_MODELS = ['Verification', 'ContactMessage', 'ServerSettings'] as const;

// --- Export -----------------------------------------------------------------------------

export const EXPORT_VERSION = 1;

/**
 * The household's data as one JSON document (Head of House, Settings →
 * Export). Credentials are left out: passwords, sessions, the Home Assistant
 * and Paperless tokens, phone push tokens. The request log (EventLog) is left
 * out too: it's operational, not the household's records.
 */
export async function exportHousehold(householdId: string) {
  const where = { householdId };
  const household = await prisma.household.findUnique({ where: { id: householdId } });
  if (!household) throw new NotFoundError('Household not found.');

  const [
    members,
    categories,
    tasks,
    pendingCredits,
    pointAwards,
    activity,
    events,
    bills,
    billPayments,
    shoppingLists,
    requests,
    bugReports,
    inventoryItems,
    purchases,
    notifications,
    nfcTags,
    integrations,
    paperless,
  ] = await Promise.all([
    prisma.user.findMany({
      where,
      select: {
        id: true,
        name: true,
        email: true,
        username: true,
        displayUsername: true,
        role: true,
        bio: true,
        avatarEmoji: true,
        profileColor: true,
        birthday: true,
        accessOverrides: true,
        createdAt: true,
      },
    }),
    prisma.category.findMany({ where }),
    prisma.task.findMany({ where, include: { subtasks: true, completions: true, recurrence: true } }),
    prisma.pendingCredit.findMany({ where }),
    prisma.pointAward.findMany({ where }),
    prisma.activityEntry.findMany({ where, orderBy: { createdAt: 'asc' } }),
    prisma.event.findMany({ where, include: { attendees: true, recurrence: true } }),
    prisma.bill.findMany({ where, include: { recurrence: true } }),
    prisma.billPayment.findMany({ where }),
    prisma.shoppingList.findMany({ where, include: { items: true } }),
    prisma.request.findMany({ where }),
    prisma.bugReport.findMany({ where }),
    prisma.inventoryItem.findMany({ where }),
    prisma.purchase.findMany({ where }),
    prisma.notification.findMany({ where }),
    prisma.nfcTag.findMany({ where }),
    prisma.homeAssistantIntegration.findMany({
      where,
      select: { id: true, name: true, active: true, createdAt: true },
    }),
    prisma.paperlessConnection.findUnique({ where, select: { url: true, publicUrl: true, createdAt: true } }),
  ]);

  return {
    format: 'ourhome-household-export',
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    household: {
      id: household.id,
      name: household.name,
      timezone: household.timezone,
      weekStartsOn: household.weekStartsOn,
      minutesPerPoint: household.minutesPerPoint,
      roleAccess: household.roleAccess,
      createdAt: household.createdAt,
    },
    members,
    categories,
    tasks,
    points: { awards: pointAwards, pending: pendingCredits },
    activity,
    calendar: events,
    bills,
    billPayments,
    shoppingLists,
    requests,
    bugReports,
    inventory: { items: inventoryItems, purchases },
    notifications,
    nfcTags,
    homeAssistant: integrations,
    paperless,
  };
}

// --- Delete -----------------------------------------------------------------------------

/** Rows removed per model, for the confirmation and the server log. */
export type DeleteReport = Record<string, number>;

/**
 * Permanently delete a household and everything it owns, members included
 * (server admin). Only a household that's turned off, never the admin's own,
 * and only with its exact name typed as confirmation. One transaction: all of
 * it goes, or none.
 */
export async function deleteHousehold(adminId: string, householdId: string, confirmName: string): Promise<DeleteReport> {
  await assertServerAdmin(adminId);
  const [household, admin] = await Promise.all([
    prisma.household.findUnique({ where: { id: householdId }, select: { id: true, name: true, disabledAt: true } }),
    prisma.user.findUnique({ where: { id: adminId }, select: { householdId: true } }),
  ]);
  if (!household) throw new NotFoundError('Household not found.');
  if (admin?.householdId === householdId) throw new ConflictError('You can’t delete your own household.');
  if (!household.disabledAt) throw new ConflictError('Turn the household off before deleting it.');
  if (confirmName.trim() !== household.name.trim()) {
    throw new ConflictError('Type the household’s name exactly to confirm.');
  }

  const report: DeleteReport = {};
  const count = (model: string, n: { count: number }) => {
    report[model] = (report[model] ?? 0) + n.count;
  };
  const where = { householdId };

  await prisma.$transaction(
    async (tx) => {
      // Ids the children hang off (and rules shared by nothing else).
      const [tasks, events, bills, lists, users] = await Promise.all([
        tx.task.findMany({ where, select: { id: true, recurrenceId: true } }),
        tx.event.findMany({ where, select: { id: true, recurrenceId: true } }),
        tx.bill.findMany({ where, select: { recurrenceId: true } }),
        tx.shoppingList.findMany({ where, select: { id: true } }),
        tx.user.findMany({ where, select: { id: true } }),
      ]);
      const taskIds = tasks.map((t) => t.id);
      const eventIds = events.map((e) => e.id);
      const listIds = lists.map((l) => l.id);
      const userIds = users.map((u) => u.id);
      const ruleIds = [...tasks, ...events, ...bills]
        .map((r) => r.recurrenceId)
        .filter((id): id is string => !!id);

      // Children first, so nothing is left pointing at a deleted parent.
      count('Subtask', await tx.subtask.deleteMany({ where: { taskId: { in: taskIds } } }));
      count('TaskCompletion', await tx.taskCompletion.deleteMany({ where: { taskId: { in: taskIds } } }));
      count('PendingCredit', await tx.pendingCredit.deleteMany({ where }));
      count('PointAward', await tx.pointAward.deleteMany({ where }));
      count('Task', await tx.task.deleteMany({ where }));
      count('EventAttendee', await tx.eventAttendee.deleteMany({ where: { eventId: { in: eventIds } } }));
      count('Event', await tx.event.deleteMany({ where }));
      count('BillPayment', await tx.billPayment.deleteMany({ where }));
      count('Bill', await tx.bill.deleteMany({ where }));
      count('RecurrenceRule', await tx.recurrenceRule.deleteMany({ where: { id: { in: ruleIds } } }));
      count('ShoppingItem', await tx.shoppingItem.deleteMany({ where: { listId: { in: listIds } } }));
      count('ShoppingList', await tx.shoppingList.deleteMany({ where }));
      count('Purchase', await tx.purchase.deleteMany({ where }));
      count('InventoryItem', await tx.inventoryItem.deleteMany({ where }));
      count('Request', await tx.request.deleteMany({ where }));
      count('BugReport', await tx.bugReport.deleteMany({ where }));
      count('Notification', await tx.notification.deleteMany({ where }));
      count('ActivityEntry', await tx.activityEntry.deleteMany({ where }));
      count('EventLog', await tx.eventLog.deleteMany({ where }));
      count('NfcTag', await tx.nfcTag.deleteMany({ where }));
      count('HomeAssistantIntegration', await tx.homeAssistantIntegration.deleteMany({ where }));
      count('PaperlessSync', await tx.paperlessSync.deleteMany({ where }));
      count('PaperlessConnection', await tx.paperlessConnection.deleteMany({ where }));
      count('PushDevice', await tx.pushDevice.deleteMany({ where }));
      count('Category', await tx.category.deleteMany({ where }));
      // Members last: their sign-ins, then the accounts themselves.
      count('Session', await tx.session.deleteMany({ where: { userId: { in: userIds } } }));
      count('Account', await tx.account.deleteMany({ where: { userId: { in: userIds } } }));
      count('User', await tx.user.deleteMany({ where: { id: { in: userIds } } }));
      count('Household', await tx.household.deleteMany({ where: { id: householdId } }));
    },
    // Big households take a while; the default 5 s would abort half way.
    { timeout: 120_000, maxWait: 10_000 },
  );

  clearHouseholdCaches();
  console.log(`[server] household "${household.name}" (${householdId}) deleted by ${adminId}:`, JSON.stringify(report));
  return report;
}
