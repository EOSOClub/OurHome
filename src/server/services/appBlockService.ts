import type { Prisma } from '@prisma/client';
import { prisma } from '@/server/db/prisma';
import type { BlockedAppDTO } from '@/lib/types';

// Blocked apps (parental controls): apps a supervising adult blocked on a
// child's phone. supervisionService.setAppBlocked adds and removes them; the
// phone learns them from its check-in answer (phoneStatusService.checkIn) and
// covers a blocked app with its "blocked" screen. They go when nobody
// supervises the child any more (supervisionService.releaseIfUnsupervised).

type Db = Prisma.TransactionClient | typeof prisma;

/** What a phone needs for its blocked screen. by: who blocked it (null: they've left the household). */
export interface PhoneBlock {
  app: string;
  label: string;
  by: string | null;
}

async function namesOf(db: Db, ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const users = await db.user.findMany({ where: { id: { in: unique } }, select: { id: true, name: true } });
  return new Map(users.map((u) => [u.id, u.name]));
}

/** [userId]'s blocked apps, for their phone's check-in answer. */
export async function phoneBlocks(householdId: string, userId: string): Promise<PhoneBlock[]> {
  const rows = await prisma.blockedApp.findMany({
    where: { householdId, userId },
    orderBy: { createdAt: 'asc' },
    select: { app: true, label: true, blockedById: true },
  });
  const names = await namesOf(prisma, rows.map((r) => r.blockedById));
  return rows.map((r) => ({ app: r.app, label: r.label, by: names.get(r.blockedById) ?? null }));
}

/** Each of [userIds]' blocked apps, newest first, for People you look after. */
export async function blockedAppsByKid(householdId: string, userIds: string[]): Promise<Map<string, BlockedAppDTO[]>> {
  const out = new Map<string, BlockedAppDTO[]>();
  if (userIds.length === 0) return out;
  const rows = await prisma.blockedApp.findMany({
    where: { householdId, userId: { in: userIds } },
    orderBy: { createdAt: 'desc' },
  });
  if (rows.length === 0) return out;
  const [names, icons] = await Promise.all([
    namesOf(prisma, rows.map((r) => r.blockedById)),
    prisma.appIcon.findMany({
      where: { householdId, app: { in: [...new Set(rows.map((r) => r.app))] } },
      select: { app: true },
    }),
  ]);
  const withIcon = new Set(icons.map((i) => i.app));
  for (const row of rows) {
    const list = out.get(row.userId) ?? [];
    list.push({
      app: row.app,
      label: row.label,
      icon: withIcon.has(row.app),
      byName: names.get(row.blockedById) ?? 'Someone who has left',
      at: row.createdAt.toISOString(),
    });
    out.set(row.userId, list);
  }
  return out;
}

/** Whether [app] is blocked for any of [userIds] (its icon may then be shown to their supervisors). */
export async function isBlockedFor(userIds: string[], app: string): Promise<boolean> {
  if (userIds.length === 0) return false;
  return (await prisma.blockedApp.count({ where: { userId: { in: userIds }, app } })) > 0;
}

/** Every app blocked in the household: their icons are kept while blocked (appUsageService.pruneIcons). */
export async function blockedAppNames(db: Db, householdId: string): Promise<string[]> {
  const rows = await db.blockedApp.findMany({ where: { householdId }, select: { app: true } });
  return [...new Set(rows.map((r) => r.app))];
}
