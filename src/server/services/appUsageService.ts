import type { Prisma } from '@prisma/client';
import { prisma } from '@/server/db/prisma';
import { createHash } from 'node:crypto';
import { ConflictError } from '@/server/services/errors';
import { pushSync } from '@/server/services/pushService';
import { blockedAppNames } from '@/server/services/appBlockService';
import { limitedAppNames } from '@/server/services/appLimitService';
import { scheduledAppNames } from '@/server/services/appScheduleService';
import { canBeSupervised, canSupervise } from '@/lib/permissions';
import {
  USAGE_CARD_APPS,
  USAGE_ICON_MAX_BYTES,
  isPng,
  newAppText,
  oldestKeptDay,
  tidyApps,
  type AppMinutes,
} from '@/lib/appUsage';
import type { ReportNewAppsInput, ReportUsageIconsInput, ReportUsageInput } from '@/lib/validation/phone';
import type { UsageHistoryDTO } from '@/lib/types';

// App usage (parental controls): a child's phone reports its screen time per
// app while a supervising adult has turned sharing it on (User.shareAppUsage,
// set in supervisionService). Their supervisors block apps from the usage lists
// (appBlockService), give apps a daily limit (appLimitService) and still
// allow apps in a schedule (appScheduleService).
// Only the last USAGE_KEEP_DAYS days are kept; turning sharing off deletes it.
// The phone also sends each app's icon once (AppIcon), when the server says
// it has none; an icon goes when no stored day names its app anymore.
// The child sees their own numbers too, on their Profile (myUsageHistory).
// While it's shared, their supervisors are also told about new apps on their
// phone (reportNewApps).
// Rules: src/lib/appUsage.ts.

type Db = Prisma.TransactionClient | typeof prisma;

/** Whether the signed-in member's app usage is shared (their Profile, their phone). */
export async function getMyUsageSharing(userId: string): Promise<{ shared: boolean }> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { shareAppUsage: true } });
  return { shared: user?.shareAppUsage === true };
}

/**
 * The phone's report: today and yesterday as it measured them, each replacing
 * what was stored for that day. Refused (409) while sharing is off: the phone
 * then stops measuring. Answers which of the stored apps have no icon yet, so
 * the phone sends those (reportIcons).
 */
export async function reportUsage(
  householdId: string,
  userId: string,
  input: ReportUsageInput,
  now: Date = new Date(),
): Promise<{ missingIcons: string[] }> {
  if (!(await getMyUsageSharing(userId)).shared) {
    throw new ConflictError('Your app usage isn’t shared.');
  }
  // Only days near the server's own date: a phone clock far off (or a bad
  // request) mustn't store a far-future day, which would push every real day
  // out of the kept window below. The phone's "today" can be a day either
  // side of the server's UTC date, and it sends yesterday too.
  const days = input.days.filter((d) => d.day >= utcDay(now, -2) && d.day <= utcDay(now, 1));
  if (days.length === 0) return { missingIcons: [] };
  const stored = new Set<string>();
  for (const day of days) {
    const apps = tidyApps(day.apps);
    for (const a of apps) stored.add(a.app);
    const data = {
      householdId,
      totalMinutes: Math.min(1440, Math.max(day.totalMinutes, 0)),
      apps: JSON.stringify(apps),
    };
    await prisma.appUsageDay.upsert({
      where: { userId_day: { userId, day: day.day } },
      update: data,
      create: { userId, day: day.day, ...data },
    });
  }
  const newest = days.map((d) => d.day).sort().at(-1)!;
  await prisma.appUsageDay.deleteMany({ where: { userId, day: { lt: oldestKeptDay(newest) } } });
  // Also catches icons left by a member who has since been removed.
  await pruneIcons(prisma, householdId);
  if (stored.size === 0) return { missingIcons: [] };
  const have = await prisma.appIcon.findMany({
    where: { householdId, app: { in: [...stored] } },
    select: { app: true },
  });
  const known = new Set(have.map((i) => i.app));
  return { missingIcons: [...stored].filter((app) => !known.has(app)) };
}

/**
 * The icons the phone was asked for. Only for apps in the member's own stored
 * days (so a phone can't fill the store with anything else), and only real
 * PNGs no bigger than USAGE_ICON_MAX_BYTES; anything else is skipped. 409
 * while their usage isn't shared.
 */
export async function reportIcons(
  householdId: string,
  userId: string,
  input: ReportUsageIconsInput,
): Promise<{ saved: number }> {
  if (!(await getMyUsageSharing(userId)).shared) {
    throw new ConflictError('Your app usage isn’t shared.');
  }
  const rows = await prisma.appUsageDay.findMany({ where: { userId }, select: { apps: true } });
  const theirs = new Set(rows.flatMap((r) => parseApps(r.apps).map((a) => a.app)));
  let saved = 0;
  for (const icon of input.icons) {
    if (!theirs.has(icon.app)) continue;
    const png = new Uint8Array(Buffer.from(icon.png, 'base64'));
    if (png.length > USAGE_ICON_MAX_BYTES || !isPng(png)) continue;
    await prisma.appIcon.upsert({
      where: { householdId_app: { householdId, app: icon.app } },
      update: { png },
      create: { householdId, app: icon.app, png },
    });
    saved++;
  }
  return { saved };
}

/** An app's stored icon (PNG), or null. Callers check who may see it. */
export async function findIcon(householdId: string, app: string): Promise<Uint8Array | null> {
  const row = await prisma.appIcon.findUnique({
    where: { householdId_app: { householdId, app } },
    select: { png: true },
  });
  return row ? new Uint8Array(row.png) : null;
}

/** Whether any of [userIds]' stored days names [app]. */
export async function usageNamesApp(userIds: string[], app: string): Promise<boolean> {
  if (userIds.length === 0) return false;
  const rows = await prisma.appUsageDay.findMany({ where: { userId: { in: userIds } }, select: { apps: true } });
  return rows.some((r) => parseApps(r.apps).some((a) => a.app === app));
}

/** Deletes [userIds]' stored usage, and the icons nobody's usage names anymore. */
export async function forgetUsage(db: Db, householdId: string, userIds: string[]): Promise<void> {
  await db.appUsageDay.deleteMany({ where: { userId: { in: userIds } } });
  await pruneIcons(db, householdId);
}

/**
 * The name [userId]'s newest stored day gives [app], or null when no stored
 * day names it (blocking an app takes its name from here).
 */
export async function usageLabel(userId: string, app: string): Promise<string | null> {
  const rows = await prisma.appUsageDay.findMany({ where: { userId }, orderBy: { day: 'desc' }, select: { apps: true } });
  for (const row of rows) {
    const found = parseApps(row.apps).find((a) => a.app === app);
    if (found) return found.label || found.app;
  }
  return null;
}

/**
 * Deletes the household's icons that no stored usage day names, keeping the
 * icons of blocked, limited and schedule-allowed apps (their lists show them).
 */
export async function pruneIcons(db: Db, householdId: string): Promise<void> {
  const [rows, blocked, limited, scheduled] = await Promise.all([
    db.appUsageDay.findMany({ where: { householdId }, select: { apps: true } }),
    blockedAppNames(db, householdId),
    limitedAppNames(db, householdId),
    scheduledAppNames(db, householdId),
  ]);
  const named = [
    ...new Set([
      ...rows.flatMap((r) => parseApps(r.apps).map((a) => a.app)),
      ...blocked,
      ...limited,
      ...scheduled,
    ]),
  ];
  await db.appIcon.deleteMany({ where: { householdId, app: { notIn: named } } });
}

/** The bell type for an app new on a child's phone. */
export const NEW_APP_TYPE = 'new_app';

/**
 * Apps the phone found since its last look (it compares the apps that can be
 * opened, every 15 minutes; its first look only remembers them). Each adult
 * who looks after the member gets one bell alert, which wakes their phone.
 * The same report sent twice the same day (an answer lost on the way) alerts
 * once. 409 while their usage isn't shared, like the usage itself.
 */
export async function reportNewApps(
  householdId: string,
  userId: string,
  input: ReportNewAppsInput,
  now: Date = new Date(),
): Promise<{ told: number }> {
  const user = await prisma.user.findFirst({
    where: { id: userId, householdId },
    select: { name: true, shareAppUsage: true },
  });
  if (user?.shareAppUsage !== true) throw new ConflictError('Your app usage isn’t shared.');
  const links = await prisma.supervision.findMany({
    where: { householdId, supervisedId: userId },
    select: { supervisorId: true, supervisor: { select: { role: true } }, supervised: { select: { role: true } } },
  });
  const supervisors = [
    ...new Set(
      links.filter((l) => canSupervise(l.supervisor.role) && canBeSupervised(l.supervised.role)).map((l) => l.supervisorId),
    ),
  ];
  const byApp = new Map(input.apps.map((a) => [a.app, a.label || a.app]));
  if (supervisors.length === 0 || byApp.size === 0) return { told: 0 };
  const labels = [...byApp.values()].sort((a, b) => a.localeCompare(b));
  const which = createHash('sha256').update([...byApp.keys()].sort().join('\n')).digest('hex').slice(0, 16);
  const keyFor = (supervisorId: string) => `new_app:${userId}:${supervisorId}:${utcDay(now, 0)}:${which}`;
  const have = await prisma.notification.findMany({
    where: { householdId, dedupeKey: { in: supervisors.map(keyFor) } },
    select: { dedupeKey: true },
  });
  const sent = new Set(have.map((n) => n.dedupeKey));
  const fresh = supervisors.filter((s) => !sent.has(keyFor(s)));
  if (fresh.length === 0) return { told: 0 };
  await prisma.notification.createMany({
    data: fresh.map((supervisorId) => ({
      householdId,
      userId: supervisorId,
      type: NEW_APP_TYPE,
      ...newAppText(user.name, labels),
      channel: 'in_app',
      subjectType: 'phone',
      subjectId: userId,
      dedupeKey: keyFor(supervisorId),
      readAt: null,
      createdAt: now,
    })),
  });
  pushSync(householdId, { userIds: fresh }, 'reminder');
  return { told: fresh.length };
}

/** The UTC date [offsetDays] from [now], as "YYYY-MM-DD". */
function utcDay(now: Date, offsetDays: number): string {
  return new Date(now.getTime() + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

export interface UsageSummary {
  /** The phone's date of the latest day reported. */
  day: string;
  totalMinutes: number;
  /** The most used apps that day. app: the package name; icon: whether its icon is stored. */
  top: { app: string; label: string; minutes: number; icon: boolean }[];
  /** When the phone last sent it (ISO). */
  updatedAt: string;
}

/** Each member's latest reported day, for the "People you look after" page. */
export async function usageSummaries(householdId: string, userIds: string[]): Promise<Map<string, UsageSummary>> {
  const out = new Map<string, UsageSummary>();
  if (userIds.length === 0) return out;
  const rows = await prisma.appUsageDay.findMany({
    where: { userId: { in: userIds } },
    orderBy: { day: 'desc' },
  });
  const latest = new Map<string, (typeof rows)[number]>();
  for (const row of rows) if (!latest.has(row.userId)) latest.set(row.userId, row);
  const tops = new Map([...latest].map(([userId, row]) => [userId, parseApps(row.apps).slice(0, USAGE_CARD_APPS)]));
  const shown = [...new Set([...tops.values()].flat().map((a) => a.app))];
  const icons = shown.length
    ? await prisma.appIcon.findMany({ where: { householdId, app: { in: shown } }, select: { app: true } })
    : [];
  const withIcon = new Set(icons.map((i) => i.app));
  for (const [userId, row] of latest) {
    out.set(userId, {
      day: row.day,
      totalMinutes: row.totalMinutes,
      top: tops.get(userId)!.map(({ app, label, minutes }) => ({ app, label, minutes, icon: withIcon.has(app) })),
      updatedAt: row.updatedAt.toISOString(),
    });
  }
  return out;
}

/**
 * Every stored day of [userId]'s usage, newest first, with all the apps kept
 * for each (up to USAGE_TOP_APPS): the chart and the full list. Callers check
 * who may see it.
 */
export async function usageHistory(householdId: string, userId: string): Promise<UsageHistoryDTO> {
  const rows = await prisma.appUsageDay.findMany({ where: { userId }, orderBy: { day: 'desc' } });
  const days = rows.map((row) => ({ row, apps: parseApps(row.apps) }));
  const named = [...new Set(days.flatMap((d) => d.apps.map((a) => a.app)))];
  const icons = named.length
    ? await prisma.appIcon.findMany({ where: { householdId, app: { in: named } }, select: { app: true } })
    : [];
  const withIcon = new Set(icons.map((i) => i.app));
  return {
    days: days.map(({ row, apps }) => ({
      day: row.day,
      totalMinutes: row.totalMinutes,
      apps: apps.map(({ app, label, minutes }) => ({ app, label, minutes, icon: withIcon.has(app) })),
      updatedAt: row.updatedAt.toISOString(),
    })),
  };
}

/**
 * Every app in each of [userIds]' stored days, once, by name, with the name
 * from the newest day naming it: the apps a supervisor can give a limit.
 */
export async function usageApps(
  householdId: string,
  userIds: string[],
): Promise<Map<string, { app: string; label: string; icon: boolean }[]>> {
  const out = new Map<string, { app: string; label: string; icon: boolean }[]>();
  if (userIds.length === 0) return out;
  const rows = await prisma.appUsageDay.findMany({
    where: { userId: { in: userIds } },
    orderBy: { day: 'desc' },
    select: { userId: true, apps: true },
  });
  const byKid = new Map<string, Map<string, string>>();
  for (const row of rows) {
    const named = byKid.get(row.userId) ?? new Map<string, string>();
    for (const a of parseApps(row.apps)) if (!named.has(a.app)) named.set(a.app, a.label || a.app);
    byKid.set(row.userId, named);
  }
  const all = [...new Set([...byKid.values()].flatMap((m) => [...m.keys()]))];
  const icons = all.length
    ? await prisma.appIcon.findMany({ where: { householdId, app: { in: all } }, select: { app: true } })
    : [];
  const withIcon = new Set(icons.map((i) => i.app));
  for (const [userId, named] of byKid) {
    out.set(
      userId,
      [...named]
        .map(([app, label]) => ({ app, label, icon: withIcon.has(app) }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    );
  }
  return out;
}

/** The signed-in member's own usage history (their Profile). 409 while it isn't shared. */
export async function myUsageHistory(householdId: string, userId: string): Promise<UsageHistoryDTO> {
  if (!(await getMyUsageSharing(userId)).shared) {
    throw new ConflictError('Your app usage isn’t shared.');
  }
  return usageHistory(householdId, userId);
}

function parseApps(raw: string): AppMinutes[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as AppMinutes[]) : [];
  } catch {
    return [];
  }
}
