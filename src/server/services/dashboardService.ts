import { prisma } from '@/server/db/prisma';
import { dateBefore, dateOnOrBefore } from '@/server/db/dateFilters';
import { listRecentActivity } from '@/server/services/activityService';
import { listOccurrences } from '@/server/services/calendarService';

const ACTIVE_STATUSES = ['pending', 'in_progress'];

/**
 * Aggregates everything the dashboard renders in one place.
 */
export async function getDashboard(householdId: string) {
  const now = new Date();
  const inSevenDays = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  const [
    overdue,
    upcoming,
    pendingCount,
    recurringCount,
    recentActivity,
    lowInventoryCount,
    openShoppingCount,
    shoppingLists,
    billsDueCount,
    upcomingBills,
    upcomingEvents,
  ] = await Promise.all([
    prisma.task.findMany({
      where: {
        householdId,
        status: { in: ACTIVE_STATUSES },
        dueDate: dateBefore(now),
      },
      include: { assignee: { select: { id: true, name: true } } },
      orderBy: { dueDate: 'asc' },
      take: 25,
    }),
    prisma.task.findMany({
      where: {
        householdId,
        status: { in: ACTIVE_STATUSES },
        dueDate: { gte: now, lte: inSevenDays },
      },
      include: { assignee: { select: { id: true, name: true } } },
      orderBy: { dueDate: 'asc' },
      take: 25,
    }),
    prisma.task.count({
      where: { householdId, status: { in: ACTIVE_STATUSES } },
    }),
    prisma.task.count({
      where: { householdId, type: 'recurring', status: { in: ACTIVE_STATUSES } },
    }),
    listRecentActivity(householdId, 15),
    prisma.inventoryItem.count({ where: { householdId, isLow: true } }),
    prisma.shoppingItem.count({
      where: { list: { householdId }, purchased: false },
    }),
    prisma.shoppingList.findMany({
      where: { householdId },
      select: {
        id: true,
        name: true,
        _count: { select: { items: { where: { purchased: false } } } },
      },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.bill.count({
      where: { householdId, status: 'unpaid', dueDate: dateOnOrBefore(inSevenDays) },
    }),
    prisma.bill.findMany({
      where: { householdId, status: 'unpaid' },
      select: {
        id: true,
        name: true,
        amount: true,
        currency: true,
        dueDate: true,
      },
      orderBy: { dueDate: 'asc' },
      take: 5,
    }),
    listOccurrences(householdId, now, inSevenDays),
  ]);

  return {
    counts: {
      pending: pendingCount,
      overdue: overdue.length,
      recurring: recurringCount,
      lowInventory: lowInventoryCount,
      openShopping: openShoppingCount,
      billsDue: billsDueCount,
    },
    overdue,
    upcoming,
    upcomingBills,
    upcomingEvents: upcomingEvents.slice(0, 6),
    recentActivity,
    shoppingLists: shoppingLists.map((l) => ({
      id: l.id,
      name: l.name,
      openCount: l._count.items,
    })),
  };
}

export type DashboardData = Awaited<ReturnType<typeof getDashboard>>;
