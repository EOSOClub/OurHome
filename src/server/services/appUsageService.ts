import type { Prisma } from '@prisma/client';
import { prisma } from '@/server/db/prisma';
import { ConflictError } from '@/server/services/errors';
import {
  USAGE_CARD_APPS,
  USAGE_ICON_MAX_BYTES,
  isPng,
  oldestKeptDay,
  tidyApps,
  type AppMinutes,
} from '@/lib/appUsage';
import type { ReportUsageIconsInput, ReportUsageInput } from '@/lib/validation/phone';

// App usage (parental controls): a child's phone reports its screen time per
// app while a supervising adult has turned sharing it on (User.shareAppUsage,
// set in supervisionService). Read-only: nothing is limited or blocked yet.
// Only the last USAGE_KEEP_DAYS days are kept; turning sharing off deletes it.
// The phone also sends each app's icon once (AppIcon), when the server says
// it has none; an icon goes when no stored day names its app any more.
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

/** Deletes [userIds]' stored usage, and the icons nobody's usage names any more. */
export async function forgetUsage(db: Db, householdId: string, userIds: string[]): Promise<void> {
  await db.appUsageDay.deleteMany({ where: { userId: { in: userIds } } });
  await pruneIcons(db, householdId);
}

/** Deletes the household's icons that no stored usage day names. */
export async function pruneIcons(db: Db, householdId: string): Promise<void> {
  const rows = await db.appUsageDay.findMany({ where: { householdId }, select: { apps: true } });
  const named = [...new Set(rows.flatMap((r) => parseApps(r.apps).map((a) => a.app)))];
  await db.appIcon.deleteMany({ where: { householdId, app: { notIn: named } } });
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

function parseApps(raw: string): AppMinutes[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as AppMinutes[]) : [];
  } catch {
    return [];
  }
}
