import { prisma } from '@/server/db/prisma';
import { ConflictError } from '@/server/services/errors';
import { USAGE_CARD_APPS, oldestKeptDay, tidyApps, type AppMinutes } from '@/lib/appUsage';
import type { ReportUsageInput } from '@/lib/validation/phone';

// App usage (parental controls): a child's phone reports its screen time per
// app while a supervising adult has turned sharing it on (User.shareAppUsage,
// set in supervisionService). Read-only: nothing is limited or blocked yet.
// Only the last USAGE_KEEP_DAYS days are kept; turning sharing off deletes it.
// Rules: src/lib/appUsage.ts.

/** Whether the signed-in member's app usage is shared (their Profile, their phone). */
export async function getMyUsageSharing(userId: string): Promise<{ shared: boolean }> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { shareAppUsage: true } });
  return { shared: user?.shareAppUsage === true };
}

/**
 * The phone's report: today and yesterday as it measured them, each replacing
 * what was stored for that day. Refused (409) while sharing is off: the phone
 * then stops measuring.
 */
export async function reportUsage(
  householdId: string,
  userId: string,
  input: ReportUsageInput,
  now: Date = new Date(),
): Promise<void> {
  if (!(await getMyUsageSharing(userId)).shared) {
    throw new ConflictError('Your app usage isn’t shared.');
  }
  // Only days near the server's own date: a phone clock far off (or a bad
  // request) mustn't store a far-future day, which would push every real day
  // out of the kept window below. The phone's "today" can be a day either
  // side of the server's UTC date, and it sends yesterday too.
  const days = input.days.filter((d) => d.day >= utcDay(now, -2) && d.day <= utcDay(now, 1));
  if (days.length === 0) return;
  for (const day of days) {
    const apps = tidyApps(day.apps);
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
}

/** The UTC date [offsetDays] from [now], as "YYYY-MM-DD". */
function utcDay(now: Date, offsetDays: number): string {
  return new Date(now.getTime() + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

export interface UsageSummary {
  /** The phone's date of the latest day reported. */
  day: string;
  totalMinutes: number;
  /** The most used apps that day. */
  top: { label: string; minutes: number }[];
  /** When the phone last sent it (ISO). */
  updatedAt: string;
}

/** Each member's latest reported day, for the Map's "People you look after" card. */
export async function usageSummaries(userIds: string[]): Promise<Map<string, UsageSummary>> {
  const out = new Map<string, UsageSummary>();
  if (userIds.length === 0) return out;
  const rows = await prisma.appUsageDay.findMany({
    where: { userId: { in: userIds } },
    orderBy: { day: 'desc' },
  });
  for (const row of rows) {
    if (out.has(row.userId)) continue;
    out.set(row.userId, {
      day: row.day,
      totalMinutes: row.totalMinutes,
      top: parseApps(row.apps)
        .slice(0, USAGE_CARD_APPS)
        .map(({ label, minutes }) => ({ label, minutes })),
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
