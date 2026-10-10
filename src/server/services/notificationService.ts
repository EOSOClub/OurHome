import type { Notification, Prisma } from '@prisma/client';
import { prisma } from '@/server/db/prisma';
import type { NotificationDTO } from '@/lib/types';
import type {
  ListNotificationsQuery,
  MarkReadInput,
} from '@/lib/validation/notification';
import { NotFoundError } from '@/server/services/errors';
import { MANAGED_TYPES } from '@/server/services/reminderService';
import { getHouseholdFeatures } from '@/server/services/serverAdminService';
import { hiddenSubjectTypes } from '@/lib/features';

/**
 * Matches notifications [userId] hasn't read. Read state is per person
 * (`readByUserIds`), so one member reading a household notification doesn't
 * clear it for anyone else.
 *
 * `readAt` is the old household-wide flag: rows marked read before the switch
 * stay read for everyone, and nothing sets it any more. On MongoDB a
 * `readAt: null` filter only matches an explicit null, not a document where
 * the field was never written, hence the `isSet: false` branch (the "keeps
 * coming back unread" bug).
 */
function unreadBy(userId: string): Prisma.NotificationWhereInput {
  return {
    AND: [
      { OR: [{ readAt: null }, { readAt: { isSet: false } }] },
      { NOT: { readByUserIds: { has: userId } } },
    ],
  };
}

/**
 * Notifications a user may see: those addressed to them (e.g. bug reports to
 * the head), generated reminders whose audience includes them (the people
 * tied to the task/bill/item plus that page's managers; see
 * reminderService.withManagers), and other household-wide rows (e.g. a new
 * app version). Unset is matched alongside null for the same Mongo reason as
 * in [unreadBy].
 */
export function visibleTo(
  householdId: string,
  userId: string,
  /** Subjects of features the server admin turned off (hiddenSubjectTypes). */
  hiddenSubjects: string[] = [],
): Prisma.NotificationWhereInput {
  return {
    householdId,
    // NOT-in rather than notIn: rows with no subjectType must still match.
    ...(hiddenSubjects.length ? { NOT: { subjectType: { in: hiddenSubjects } } } : {}),
    OR: [
      { userId },
      {
        AND: [
          { OR: [{ userId: null }, { userId: { isSet: false } }] },
          {
            OR: [
              { type: { notIn: MANAGED_TYPES } },
              { audienceUserIds: { has: userId } },
            ],
          },
        ],
      },
    ],
  };
}

/** Bell rows about turned-off features stay in the database but out of sight. */
async function hiddenSubjectsFor(householdId: string): Promise<string[]> {
  return hiddenSubjectTypes(await getHouseholdFeatures(householdId));
}

/** Map a Prisma notification to the serializable client DTO, as [userId] sees it. */
export function notificationToDTO(n: Notification, userId: string): NotificationDTO {
  return {
    id: n.id,
    type: n.type,
    title: n.title,
    body: n.body,
    channel: n.channel,
    subjectType: n.subjectType,
    subjectId: n.subjectId,
    read: n.readAt != null || n.readByUserIds.includes(userId),
    createdAt: n.createdAt.toISOString(),
  };
}

export interface NotificationList {
  items: NotificationDTO[];
  unreadCount: number;
  hasMore: boolean;
}

/**
 * List the notifications [userId] can see (newest first) plus their unread
 * count across ALL of them (not just this page). Pass `before` (the id of the
 * oldest already-loaded notification) to page further back; `hasMore` reports
 * whether older notifications exist past the returned page.
 */
export async function listNotifications(
  householdId: string,
  userId: string,
  query: ListNotificationsQuery & { before?: string },
): Promise<NotificationList> {
  const visible = visibleTo(householdId, userId, await hiddenSubjectsFor(householdId));
  const unread = unreadBy(userId);
  const [rows, unreadCount] = await Promise.all([
    prisma.notification.findMany({
      where: { AND: [visible, ...(query.unreadOnly ? [unread] : [])] },
      // `id` tiebreak keeps the order (and thus the cursor) stable when rows
      // share a createdAt.
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      // Fetch one extra row so hasMore needs no second count query.
      take: query.limit + 1,
      ...(query.before ? { cursor: { id: query.before }, skip: 1 } : {}),
    }),
    prisma.notification.count({ where: { AND: [visible, unread] } }),
  ]);

  const hasMore = rows.length > query.limit;
  return {
    items: rows.slice(0, query.limit).map((n) => notificationToDTO(n, userId)),
    unreadCount,
    hasMore,
  };
}

/**
 * Mark a single notification (by id) or all of the notifications [userId] can
 * see as read — for [userId] only. Scoped to what they can see, so members
 * can't touch other households' rows or notifications addressed to someone
 * else.
 */
export async function markRead(
  householdId: string,
  userId: string,
  input: MarkReadInput,
): Promise<{ updated: number }> {
  const visible = visibleTo(householdId, userId, await hiddenSubjectsFor(householdId));
  const unread = unreadBy(userId);
  const data = { readByUserIds: { push: userId } };

  if (input.all) {
    const res = await prisma.notification.updateMany({
      where: { AND: [visible, unread] },
      data,
    });
    return { updated: res.count };
  }

  const res = await prisma.notification.updateMany({
    where: { AND: [visible, unread, { id: input.id }] },
    data,
  });
  if (res.count === 0) {
    // Either already read or not visible to this user; distinguish "not found".
    const exists = await prisma.notification.findFirst({
      where: { AND: [visible, { id: input.id }] },
      select: { id: true },
    });
    if (!exists) throw new NotFoundError('Notification not found.');
  }
  return { updated: res.count };
}
