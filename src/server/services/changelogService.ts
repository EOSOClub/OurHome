import { prisma } from '@/server/db/prisma';
import { CHANGELOG, unseenChangelog, type ChangelogEntry } from '@/lib/changelog';
import { NotFoundError } from '@/server/services/errors';

/** The "What's new" entries this member hasn't closed yet, newest first. */
export async function unseenFor(userId: string): Promise<ChangelogEntry[]> {
  const me = await prisma.user.findUnique({
    where: { id: userId },
    select: { changelogSeen: true, createdAt: true },
  });
  if (!me) return [];
  return unseenChangelog(me.changelogSeen, me.createdAt);
}

/**
 * They closed "What's new" showing `id` as its newest entry: it won't show
 * again on any device. Never moves back, so an older device closing an
 * older list doesn't bring a newer entry back.
 */
export async function markChangelogSeen(userId: string, id: string): Promise<void> {
  if (!CHANGELOG.some((e) => e.id === id)) throw new NotFoundError('That update note is gone.');
  await prisma.user.updateMany({
    where: { id: userId, OR: [{ changelogSeen: null }, { changelogSeen: { isSet: false } }, { changelogSeen: { lt: id } }] },
    data: { changelogSeen: id },
  });
}
