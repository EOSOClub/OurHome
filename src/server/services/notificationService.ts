import type { Notification, Prisma } from '@prisma/client';
import { prisma } from '@/server/db/prisma';
import type { NotificationDTO } from '@/lib/types';
import type {
  ListNotificationsQuery,
  MarkReadInput,
} from '@/lib/validation/notification';
import { NotFoundError } from '@/server/services/errors';

/**
 * Matches unread notifications. On MongoDB a `readAt: null` filter only matches
 * an explicit null, not a document where the field was never written — and
 * rows created without `readAt` have no such field. Without the `isSet: false`
 * branch those rows could never be marked read and were never counted as
 * unread (the "keeps coming back unread" bug).
 */
const UNREAD = {
  OR: [{ readAt: null }, { readAt: { isSet: false } }],
} satisfies Prisma.NotificationWhereInput;

/**
 * Notifications a user may see: household-wide ones (no userId — the reminder
 * generator's rows) plus those addressed to them (e.g. bug reports to the
 * head). Unset is matched alongside null for the same Mongo reason as UNREAD.
 */
function visibleTo(householdId: string, userId: string): Prisma.NotificationWhereInput {
  return {
    householdId,
    OR: [{ userId: null }, { userId: { isSet: false } }, { userId }],
  };
}

/** Map a Prisma notification to the serializable client DTO. */
export function notificationToDTO(n: Notification): NotificationDTO {
  return {
    id: n.id,
    type: n.type,
    title: n.title,
    body: n.body,
    channel: n.channel,
    subjectType: n.subjectType,
    subjectId: n.subjectId,
    read: n.readAt != null,
    createdAt: n.createdAt.toISOString(),
  };
}

export interface NotificationList {
  items: NotificationDTO[];
  unreadCount: number;
  hasMore: boolean;
}

/**
 * List the notifications [userId] can see (newest first) plus the unread count
 * across ALL of them (not just this page). Pass `before` (the id of the oldest
 * already-loaded notification) to page further back; `hasMore` reports whether
 * older notifications exist past the returned page.
 */
export async function listNotifications(
  householdId: string,
  userId: string,
  query: ListNotificationsQuery & { before?: string },
): Promise<NotificationList> {
  const visible = visibleTo(householdId, userId);
  const [rows, unreadCount] = await Promise.all([
    prisma.notification.findMany({
      where: { AND: [visible, ...(query.unreadOnly ? [UNREAD] : [])] },
      // `id` tiebreak keeps the order (and thus the cursor) stable when rows
      // share a createdAt.
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      // Fetch one extra row so hasMore needs no second count query.
      take: query.limit + 1,
      ...(query.before ? { cursor: { id: query.before }, skip: 1 } : {}),
    }),
    prisma.notification.count({ where: { AND: [visible, UNREAD] } }),
  ]);

  const hasMore = rows.length > query.limit;
  return {
    items: rows.slice(0, query.limit).map(notificationToDTO),
    unreadCount,
    hasMore,
  };
}

/**
 * Mark a single notification (by id) or all of the notifications [userId] can
 * see as read. Scoped to what they can see, so members can't touch other
 * households' rows or notifications addressed to someone else.
 */
export async function markRead(
  householdId: string,
  userId: string,
  input: MarkReadInput,
): Promise<{ updated: number }> {
  const now = new Date();
  const visible = visibleTo(householdId, userId);

  if (input.all) {
    const res = await prisma.notification.updateMany({
      where: { AND: [visible, UNREAD] },
      data: { readAt: now },
    });
    return { updated: res.count };
  }

  const res = await prisma.notification.updateMany({
    where: { AND: [visible, UNREAD, { id: input.id }] },
    data: { readAt: now },
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
