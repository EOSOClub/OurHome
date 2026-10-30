import { prisma } from '@/server/db/prisma';
import { dateBefore, dateOnOrBefore } from '@/server/db/dateFilters';
import { isOverdue } from '@/lib/format';
import { listOccurrences } from '@/server/services/calendarService';
import { getPointsSettings, pointsSummary } from '@/server/services/pointsService';
import { addDays, localDateOf, startOfLocalDate } from '@/lib/taskCycles';
import { attentionReason, type RequestAttentionReason } from '@/lib/requestAttention';
import type { AccessMatrix } from '@/lib/permissions';
import type { Feature } from '@/lib/features';
import { placesLabel } from '@/lib/places';
import { loadPlaceIndex, resolveTaskPlaces, type PlaceIndex } from '@/server/services/taskPlaces';
import { getHouseholdFeatures } from '@/server/services/serverAdminService';
import { getRequestHandling, type RequestHandling } from '@/server/services/requestModuleService';
import { REQUEST_MODULE_WORKFLOWS } from '@/lib/requestModules';
import { countTasksToCheck } from '@/server/services/taskSubmissionService';

// Not awaiting_review: a task sent for a check is done on the child's side,
// so it is never overdue, due or open here while it waits for an adult's OK.
const ACTIVE_STATUSES = ['pending', 'in_progress'];

const taskSelect = {
  id: true,
  title: true,
  priority: true,
  dueDate: true,
  type: true,
  assignee: { select: { id: true, name: true } },
  roomId: true,
  floorId: true,
  extraRoomIds: true,
  extraFloorIds: true,
} as const;

type SelectedTask = {
  roomId: string | null;
  floorId: string | null;
  extraRoomIds: string[];
  extraFloorIds: string[];
};

/**
 * Each task with `place` ("Upstairs · Bedroom", or all its places) instead
 * of its raw place ids.
 */
function withPlace<T extends SelectedTask>(tasks: T[], places: PlaceIndex) {
  return tasks.map(({ roomId, floorId, extraRoomIds, extraFloorIds, ...t }) => {
    const list = resolveTaskPlaces({ roomId, floorId, extraRoomIds, extraFloorIds }, places);
    return { ...t, place: placesLabel({ room: null, floor: null, places: list }) };
  });
}

/**
 * Requests that may wait on `userId` (attentionReason makes the final call):
 * open requests of the approve-workflow kinds they may decide (media,
 * purchase, permission: ones they handle, or where supervisors decide, if
 * they supervise someone), plus assign-workflow ones (maintenance) assigned to
 * them - kinds that are on only.
 */
function waitingRequestsWhere(householdId: string, userId: string, handling: RequestHandling) {
  const mayDecide = handling.on.filter(
    (category) =>
      handling.handles.has(category) || (handling.bySupervisors.has(category) && handling.supervising.size > 0),
  );
  return {
    householdId,
    OR: [
      ...mayDecide.map((category) => ({
        category,
        OR: [{ status: null }, { status: { isSet: false } }, { status: { in: ['pending', 'accepted'] } }],
      })),
      ...handling.on
        .filter((category) => REQUEST_MODULE_WORKFLOWS[category] === 'assign')
        .map((category) => ({ category, assigneeId: userId, status: { in: ['pending', 'accepted'] } })),
    ],
  };
}

/**
 * The member's own tasks due by the end of today, overdue included: the
 * dashboard's "today" list, counted for the "You're home" reminder.
 * `titles` holds the first few, soonest due first.
 */
export async function myTasksDueToday(
  householdId: string,
  userId: string,
  now: Date = new Date(),
): Promise<{ count: number; titles: string[] }> {
  const { timezone } = await getPointsSettings(householdId);
  const endOfToday = startOfLocalDate(addDays(localDateOf(now, timezone), 1), timezone);
  const where = { householdId, assigneeId: userId, status: { in: ACTIVE_STATUSES }, dueDate: dateBefore(endOfToday) };
  const [count, first] = await Promise.all([
    prisma.task.count({ where }),
    prisma.task.findMany({ where, select: { title: true }, orderBy: { dueDate: 'asc' }, take: 3 }),
  ]);
  return { count, titles: first.map((t) => t.title) };
}

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
  const [{ timezone }, features, requestHandling] = await Promise.all([
    getPointsSettings(householdId),
    getHouseholdFeatures(householdId),
    getRequestHandling(householdId, user.id, access.requests.approve),
  ]);
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
    places,
    tasksToCheck,
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
      where: waitingRequestsWhere(householdId, user.id, requestHandling),
      select: {
        id: true,
        category: true,
        title: true,
        mediaType: true,
        year: true,
        season: true,
        issue: true,
        episode: true,
        status: true,
        requesterId: true,
        assigneeId: true,
        dueAt: true,
        startsAt: true,
        createdAt: true,
        requester: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'asc' },
      take: 20,
    }),
    pointsSummary(householdId, 'week', undefined, now),
    prisma.taskCompletion.count({ where: completedToday }),
    prisma.taskCompletion.count({ where: { ...completedToday, userId: user.id } }),
    loadPlaceIndex(prisma, householdId),
    countTasksToCheck(householdId, user.id, now),
  ]);

  // The query finds anything due before now; date-only due dates (12:00
  // local) only count as overdue from the next day, like everywhere else.
  const overdueNow = overdue.filter((t) => isOverdue(t.dueDate, timezone, now));

  const myRow = points.members.find((m) => m.userId === user.id);
  const myRank = myRow && myRow.points > 0 ? points.members.indexOf(myRow) + 1 : null;

  // Features the server admin turned off show nothing here - also for app
  // builds that don't know about `features` yet (they just see empty lists).
  const on = (f: Feature) => features.includes(f);
  const tasksOn = on('tasks');

  return {
    timezone,
    /** The features the household has on, so clients can drop whole cards. */
    features,
    counts: {
      pending: tasksOn ? pendingCount : 0,
      overdue: tasksOn ? overdueNow.length : 0,
      recurring: tasksOn ? recurringCount : 0,
      lowInventory: on('inventory') ? lowInventoryCount : 0,
      openShopping: on('shopping') ? openShoppingCount : 0,
      billsDue: on('bills') ? billsDueCount : 0,
    },
    overdue: tasksOn ? withPlace(overdueNow, places) : [],
    upcoming: tasksOn ? withPlace(upcoming, places) : [],
    upcomingBills: on('bills') ? upcomingBills : [],
    upcomingEvents: on('calendar') ? upcomingEvents.slice(0, 6) : [],
    me: {
      /** Mine, overdue or due today. */
      today: tasksOn ? withPlace(myTasks.filter((t) => t.dueDate && t.dueDate < endOfToday), places) : [],
      /** Mine, due later this week. */
      later: tasksOn ? withPlace(myTasks.filter((t) => t.dueDate && t.dueDate >= endOfToday), places) : [],
      /** Unassigned, overdue or due today. */
      openToAnyone: tasksOn ? withPlace(openTasks, places) : [],
      requests: on('requests')
        ? requests.flatMap((r) => {
            const reason = attentionReason(r, user.id, requestHandling, endOfToday);
            return reason ? [{ ...r, reason: reason satisfies RequestAttentionReason }] : [];
          })
        : [],
      /** Task checks waiting in their To check (children they look after). */
      tasksToCheck: tasksOn ? tasksToCheck : 0,
      points: {
        week: on('points') ? (myRow?.points ?? 0) : 0,
        queued: on('points') ? (myRow?.queued ?? 0) : 0,
        rank: on('points') ? myRank : null,
        leaders: on('points')
          ? points.members
              .filter((m) => m.points > 0)
              .slice(0, 3)
              .map((m) => ({ userId: m.userId, name: m.name, points: m.points }))
          : [],
      },
    },
    doneToday: tasksOn ? { total: doneToday, mine: doneTodayByMe } : { total: 0, mine: 0 },
  };
}

export type DashboardData = Awaited<ReturnType<typeof getDashboard>>;
