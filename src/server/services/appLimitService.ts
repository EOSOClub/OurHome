import type { Prisma } from '@prisma/client';
import { prisma } from '@/server/db/prisma';
import { pushSync } from '@/server/services/pushService';
import { namesOf } from '@/server/services/appBlockService';
import { canBeSupervised, canSupervise } from '@/lib/permissions';
import { ALL_APPS, limitReachedText } from '@/lib/appLimits';
import type { AppLimitDTO } from '@/lib/types';
import type { LimitsReachedInput } from '@/lib/validation/phone';

// Daily limits (parental controls): so many minutes a day for one app, or for
// all apps together (app ALL_APPS), on a child's phone. supervisionService.setAppLimit
// sets and removes them; the phone learns them from its check-in answer
// (phoneStatusService.checkIn), counts today's minutes itself, warns the child
// 5 minutes before and then covers the app. When it covers one, it says so in
// its next check-in, and each supervisor gets one bell alert per limit and
// day (reportLimitsReached). They go when nobody supervises the child
// anymore (supervisionService.releaseIfUnsupervised). Rules: src/lib/appLimits.ts.

type Db = Prisma.TransactionClient | typeof prisma;

/** What a phone needs for one limit. by: who set it (null: they've left the household). */
export interface PhoneLimit {
  app: string;
  label: string;
  minutes: number;
  by: string | null;
}

/** [userId]'s limits, for their phone's check-in answer. */
export async function phoneLimits(householdId: string, userId: string): Promise<PhoneLimit[]> {
  const rows = await prisma.appLimit.findMany({
    where: { householdId, userId },
    orderBy: { updatedAt: 'asc' },
    select: { app: true, label: true, minutes: true, setById: true },
  });
  const names = await namesOf(prisma, rows.map((r) => r.setById));
  return rows.map((r) => ({ app: r.app, label: r.label, minutes: r.minutes, by: names.get(r.setById) ?? null }));
}

/** The limits of each of [userIds] (all apps together among them), newest first, for People you look after. */
export async function appLimitsByKid(householdId: string, userIds: string[]): Promise<Map<string, AppLimitDTO[]>> {
  const out = new Map<string, AppLimitDTO[]>();
  if (userIds.length === 0) return out;
  const rows = await prisma.appLimit.findMany({
    where: { householdId, userId: { in: userIds } },
    orderBy: { updatedAt: 'desc' },
  });
  if (rows.length === 0) return out;
  const apps = [...new Set(rows.map((r) => r.app).filter((a) => a !== ALL_APPS))];
  const [names, icons] = await Promise.all([
    namesOf(prisma, rows.map((r) => r.setById)),
    apps.length ? prisma.appIcon.findMany({ where: { householdId, app: { in: apps } }, select: { app: true } }) : [],
  ]);
  const withIcon = new Set(icons.map((i) => i.app));
  for (const row of rows) {
    const list = out.get(row.userId) ?? [];
    list.push({
      app: row.app,
      label: row.label,
      icon: withIcon.has(row.app),
      minutes: row.minutes,
      byName: names.get(row.setById) ?? 'Someone who has left',
      at: row.updatedAt.toISOString(),
    });
    out.set(row.userId, list);
  }
  return out;
}

/** Whether [app] has a limit for any of [userIds] (its icon may then be shown to their supervisors). */
export async function isLimitedFor(userIds: string[], app: string): Promise<boolean> {
  if (userIds.length === 0 || app === ALL_APPS) return false;
  return (await prisma.appLimit.count({ where: { userId: { in: userIds }, app } })) > 0;
}

/** Every app with a limit in the household: their icons are kept meanwhile (appUsageService.pruneIcons). */
export async function limitedAppNames(db: Db, householdId: string): Promise<string[]> {
  const rows = await db.appLimit.findMany({ where: { householdId, app: { not: ALL_APPS } }, select: { app: true } });
  return [...new Set(rows.map((r) => r.app))];
}

/** The bell type for a limit a child's phone used up. */
export const LIMIT_REACHED_TYPE = 'limit_reached';

/**
 * The limits [userId]'s phone covered an app for today ([input].day: the
 * phone's date; apps: package names, ALL_APPS for all apps). Each adult who
 * looks after them gets one bell alert per limit and day, which wakes their
 * phone; the phone says it again with every check-in that day, and those are
 * skipped. Only limits that still exist, and only a day near the server's.
 */
export async function reportLimitsReached(
  householdId: string,
  userId: string,
  input: LimitsReachedInput,
  now: Date = new Date(),
): Promise<{ told: number }> {
  if (input.day < utcDay(now, -1) || input.day > utcDay(now, 1) || input.apps.length === 0) return { told: 0 };
  const [user, links, limits] = await Promise.all([
    prisma.user.findFirst({ where: { id: userId, householdId }, select: { name: true } }),
    prisma.supervision.findMany({
      where: { householdId, supervisedId: userId },
      select: { supervisorId: true, supervisor: { select: { role: true } }, supervised: { select: { role: true } } },
    }),
    prisma.appLimit.findMany({
      where: { householdId, userId, app: { in: [...new Set(input.apps)] } },
      select: { app: true, label: true, minutes: true },
    }),
  ]);
  const supervisors = [
    ...new Set(
      links.filter((l) => canSupervise(l.supervisor.role) && canBeSupervised(l.supervised.role)).map((l) => l.supervisorId),
    ),
  ];
  if (!user || supervisors.length === 0 || limits.length === 0) return { told: 0 };
  const keyFor = (app: string, supervisorId: string) => `limit:${userId}:${app}:${input.day}:${supervisorId}`;
  const wanted = limits.flatMap((limit) => supervisors.map((supervisorId) => ({ limit, supervisorId })));
  const have = await prisma.notification.findMany({
    where: { householdId, dedupeKey: { in: wanted.map((w) => keyFor(w.limit.app, w.supervisorId)) } },
    select: { dedupeKey: true },
  });
  const sent = new Set(have.map((n) => n.dedupeKey));
  const fresh = wanted.filter((w) => !sent.has(keyFor(w.limit.app, w.supervisorId)));
  if (fresh.length === 0) return { told: 0 };
  await prisma.notification.createMany({
    data: fresh.map(({ limit, supervisorId }) => ({
      householdId,
      userId: supervisorId,
      type: LIMIT_REACHED_TYPE,
      ...limitReachedText(user.name, limit.app === ALL_APPS ? null : limit.label, limit.minutes),
      channel: 'in_app',
      subjectType: 'phone',
      subjectId: userId,
      dedupeKey: keyFor(limit.app, supervisorId),
      readAt: null,
      createdAt: now,
    })),
  });
  pushSync(householdId, { userIds: [...new Set(fresh.map((f) => f.supervisorId))] }, 'reminder');
  return { told: fresh.length };
}

/** The UTC date [offsetDays] from [now], as "YYYY-MM-DD". */
function utcDay(now: Date, offsetDays: number): string {
  return new Date(now.getTime() + offsetDays * 86_400_000).toISOString().slice(0, 10);
}
