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
 * open requests of the approve-workflow kinds they handle (media), plus
 * assign-workflow ones (maintenance) assigned to them - kinds that are on only.
 */
function waitingRequestsWhere(householdId: string, userId: string, handling: RequestHandling) {
  return {
    householdId,
    OR: [
      ...[...handling.handles].map((category) => ({
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
 * How many requests wait on the user right now: the dashboard's "Needs you"
 * rule, shown as the badge on the phone nav's "More" button (Requests lives
 * there). `approveSwitch`: their Requests "Approve" switch.
 */
export async function countRequestsWaitingOn(
  user: { id: string; householdId: string },
  approveSwitch: boolean,
  timezone: string,
) {
  const endOfToday = startOfLocalDate(addDays(localDateOf(new Date(), timezone), 1), timezone);
  const handling = await getRequestHandling(user.householdId, user.id, approveSwitch);
  // Nothing on: an empty OR would match nothing anyway, but skip the query.
  if (handling.on.length === 0) return 0;
  const rows = await prisma.request.findMany({
    where: waitingRequestsWhere(user.householdId, user.id, handling),
    select: { category: true, status: true, assigneeId: true, dueAt: true },
  });
  return rows.filter((r) => attentionReason(r, user.id, handling.handles, endOfToday)).length;
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
    loadPlaceIndex(prisma, householdId),
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
            const reason = attentionReason(r, user.id, requestHandling.handles, endOfToday);
            return reason ? [{ ...r, reason: reason satisfies RequestAttentionReason }] : [];
          })
        : [],
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
