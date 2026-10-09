import { prisma } from '@/server/db/prisma';
import { dateBefore, dateOnOrBefore } from '@/server/db/dateFilters';
import { listOccurrences } from '@/server/services/calendarService';
import { getPointsSettings, pointsSummary } from '@/server/services/pointsService';
import { addDays, localDateOf, startOfLocalDate } from '@/lib/taskCycles';
import { attentionReason, type RequestAttentionReason } from '@/lib/requestAttention';
import type { AccessMatrix } from '@/lib/permissions';

const ACTIVE_STATUSES = ['pending', 'in_progress'];

const taskSelect = {
  id: true,
  title: true,
  priority: true,
  dueDate: true,
  type: true,
  assignee: { select: { id: true, name: true } },
} as const;

/**
 * Everything the dashboard renders, from the viewer's side: "me" is what is on
 * them today (their tasks, requests waiting on them, their points), the rest
 * is a short household glance. The activity log lives on its own page now
 * (activityService.listActivity).
 *
 * `counts`, `overdue`, `upcoming`, `upcomingBills` and `upcomingEvents` keep
 * their old household-wide meaning: app builds from before the redesign read
 * them.
 */
export async function getDashboard(
  user: { id: string; householdId: string },
  access: AccessMatrix,
) {
  const { householdId } = user;
  const now = new Date();
  const inSevenDays = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  // "Today" is the household's day (Points settings), not the server's.
  const { timezone } = await getPointsSettings(householdId);
  const today = localDateOf(now, timezone);
  const startOfToday = startOfLocalDate(today, timezone);
  const endOfToday = startOfLocalDate(addDays(today, 1), timezone);

  const completedToday = {
    completedAt: { gte: startOfToday },
    task: { householdId },
    AND: [
      { OR: [{ outcome: null }, { outcome: { isSet: false } }, { outcome: 'completed' }] },
      { OR: [{ undoneAt: null }, { undoneAt: { isSet: false } }] },
    ],
  };

  const [
    overdue,
    upcoming,
    pendingCount,
    recurringCount,
    lowInventoryCount,
    openShoppingCount,
    billsDueCount,
    upcomingBills,
    upcomingEvents,
    myTasks,
    openTasks,
    requests,
    points,
    doneToday,
    doneTodayByMe,
  ] = await Promise.all([
    prisma.task.findMany({
      where: { householdId, status: { in: ACTIVE_STATUSES }, dueDate: dateBefore(now) },
      select: taskSelect,
      orderBy: { dueDate: 'asc' },
      take: 25,
    }),
    prisma.task.findMany({
      where: { householdId, status: { in: ACTIVE_STATUSES }, dueDate: { gte: now, lte: inSevenDays } },
      select: taskSelect,
      orderBy: { dueDate: 'asc' },
      take: 25,
    }),
    prisma.task.count({ where: { householdId, status: { in: ACTIVE_STATUSES } } }),
    prisma.task.count({
      where: { householdId, type: 'recurring', status: { in: ACTIVE_STATUSES } },
    }),
    prisma.inventoryItem.count({ where: { householdId, isLow: true } }),
    prisma.shoppingItem.count({ where: { list: { householdId }, purchased: false } }),
    prisma.bill.count({
      where: { householdId, status: 'unpaid', dueDate: dateOnOrBefore(inSevenDays) },
    }),
    prisma.bill.findMany({
      where: { householdId, status: 'unpaid' },
      select: { id: true, name: true, amount: true, currency: true, dueDate: true },
      orderBy: { dueDate: 'asc' },
      take: 5,
    }),
    listOccurrences(householdId, now, inSevenDays),
    // Mine, due within the next week (overdue included); split below.
    prisma.task.findMany({
      where: {
        householdId,
        assigneeId: user.id,
        status: { in: ACTIVE_STATUSES },
        dueDate: dateBefore(inSevenDays),
      },
      select: taskSelect,
      orderBy: { dueDate: 'asc' },
      take: 30,
    }),
    // Nobody's in particular, due by the end of today: anyone can pick these up.
    prisma.task.findMany({
      where: {
        householdId,
        status: { in: ACTIVE_STATUSES },
        OR: [{ assigneeId: null }, { assigneeId: { isSet: false } }],
        dueDate: dateBefore(endOfToday),
      },
      select: taskSelect,
      orderBy: { dueDate: 'asc' },
      take: 10,
    }),
    prisma.request.findMany({
      where: {
        householdId,
        OR: [
          ...(access.requests.approve
            ? [{ category: 'media', OR: [{ status: null }, { status: { isSet: false } }, { status: { in: ['pending', 'accepted'] } }] }]
            : []),
          { category: 'maintenance', assigneeId: user.id, status: { in: ['pending', 'accepted'] } },
        ],
      },
      select: {
        id: true,
        category: true,
        title: true,
        mediaType: true,
        year: true,
        season: true,
        status: true,
        assigneeId: true,
        dueAt: true,
        createdAt: true,
        requester: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'asc' },
      take: 20,
    }),
    pointsSummary(householdId, 'week', undefined, now),
    prisma.taskCompletion.count({ where: completedToday }),
    prisma.taskCompletion.count({ where: { ...completedToday, userId: user.id } }),
  ]);

  const myRow = points.members.find((m) => m.userId === user.id);
  const myRank = myRow && myRow.points > 0 ? points.members.indexOf(myRow) + 1 : null;

  return {
    timezone,
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
    me: {
      /** Mine, overdue or due today. */
      today: myTasks.filter((t) => t.dueDate && t.dueDate < endOfToday),
      /** Mine, due later this week. */
      later: myTasks.filter((t) => t.dueDate && t.dueDate >= endOfToday),
      /** Unassigned, overdue or due today. */
      openToAnyone: openTasks,
      requests: requests.flatMap((r) => {
        const reason = attentionReason(r, user.id, access.requests.approve, endOfToday);
        return reason ? [{ ...r, reason: reason satisfies RequestAttentionReason }] : [];
      }),
      points: {
        week: myRow?.points ?? 0,
        queued: myRow?.queued ?? 0,
        rank: myRank,
        leaders: points.members
          .filter((m) => m.points > 0)
          .slice(0, 3)
          .map((m) => ({ userId: m.userId, name: m.name, points: m.points })),
      },
    },
    doneToday: { total: doneToday, mine: doneTodayByMe },
  };
}

export type DashboardData = Awaited<ReturnType<typeof getDashboard>>;
