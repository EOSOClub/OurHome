import type { Prisma } from '@prisma/client';
import { prisma } from '@/server/db/prisma';
import { namesOf } from '@/server/services/appBlockService';
import type { ScheduleDTO } from '@/lib/types';

// Schedules (parental controls): time windows on a child's phone, like
// Bedtime 21:00 to 07:00, when every app is closed apart from the ones their
// phone always keeps open and the ones the schedule still allows.
// supervisionService.saveSchedule and removeSchedule change them; the phone
// learns them from its check-in answer (phoneStatusService.checkIn), warns
// the child 5 minutes before the start and covers apps meanwhile. They go when
// nobody supervises the child anymore (supervisionService.releaseIfUnsupervised).
// Rules: src/lib/appSchedules.ts.

type Db = Prisma.TransactionClient | typeof prisma;

/** A schedule as stored: its still-allowed apps are JSON. */
interface ScheduleRow {
  id: string;
  name: string;
  days: number[];
  start: number;
  end: number;
  allowed: string;
}

/** What a phone needs for one schedule. allowed: package names. by: who saved it (null: they've left). */
export interface PhoneSchedule {
  id: string;
  name: string;
  days: number[];
  start: number;
  end: number;
  allowed: string[];
  by: string | null;
}

/** A schedule's still-allowed apps; nothing for a broken value. */
export function allowedApps(raw: string): { app: string; label: string }[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((a): a is { app: string; label: string } => typeof a?.app === 'string' && typeof a?.label === 'string')
      : [];
  } catch {
    return [];
  }
}

const schedulePart = (row: ScheduleRow) => ({
  id: row.id,
  name: row.name,
  days: [...row.days].sort((a, b) => a - b),
  start: row.start,
  end: row.end,
});

/** [userId]'s schedules, for their phone's check-in answer. */
export async function phoneSchedules(householdId: string, userId: string): Promise<PhoneSchedule[]> {
  const rows = await prisma.appSchedule.findMany({ where: { householdId, userId }, orderBy: { start: 'asc' } });
  const names = await namesOf(prisma, rows.map((r) => r.setById));
  return rows.map((r) => ({
    ...schedulePart(r),
    allowed: allowedApps(r.allowed).map((a) => a.app),
    by: names.get(r.setById) ?? null,
  }));
}

/** The schedules of each of [userIds], earliest start first, for People you look after. */
export async function schedulesByKid(householdId: string, userIds: string[]): Promise<Map<string, ScheduleDTO[]>> {
  const out = new Map<string, ScheduleDTO[]>();
  if (userIds.length === 0) return out;
  const rows = await prisma.appSchedule.findMany({
    where: { householdId, userId: { in: userIds } },
    orderBy: { start: 'asc' },
  });
  if (rows.length === 0) return out;
  const apps = [...new Set(rows.flatMap((r) => allowedApps(r.allowed).map((a) => a.app)))];
  const [names, icons] = await Promise.all([
    namesOf(prisma, rows.map((r) => r.setById)),
    apps.length ? prisma.appIcon.findMany({ where: { householdId, app: { in: apps } }, select: { app: true } }) : [],
  ]);
  const withIcon = new Set(icons.map((i) => i.app));
  for (const row of rows) {
    const list = out.get(row.userId) ?? [];
    list.push({
      ...schedulePart(row),
      allowed: allowedApps(row.allowed).map((a) => ({ ...a, icon: withIcon.has(a.app) })),
      byName: names.get(row.setById) ?? 'Someone who has left',
      at: row.updatedAt.toISOString(),
    });
    out.set(row.userId, list);
  }
  return out;
}

/** Every app a schedule still allows in the household: their icons are kept meanwhile (appUsageService.pruneIcons). */
export async function scheduledAppNames(db: Db, householdId: string): Promise<string[]> {
  const rows = await db.appSchedule.findMany({ where: { householdId }, select: { allowed: true } });
  return [...new Set(rows.flatMap((r) => allowedApps(r.allowed).map((a) => a.app)))];
}

/** Whether any schedule of [userIds] still allows [app] (its icon may then be shown to their supervisors). */
export async function isScheduledFor(userIds: string[], app: string): Promise<boolean> {
  if (userIds.length === 0) return false;
  const rows = await prisma.appSchedule.findMany({ where: { userId: { in: userIds } }, select: { allowed: true } });
  return rows.some((r) => allowedApps(r.allowed).some((a) => a.app === app));
}
