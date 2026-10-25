import type { Prisma } from '@prisma/client';
import { prisma } from '@/server/db/prisma';
import { ConflictError } from '@/server/services/errors';
import { logActivity } from '@/server/services/activityService';
import { pushSync } from '@/server/services/pushService';
import { isFeatureEnabled } from '@/server/services/serverAdminService';
import { NOT_VOIDED } from '@/server/services/pointsService';
import { canBeSupervised, canSupervise } from '@/lib/permissions';
import { formatMinutes } from '@/lib/appUsage';
import { formatPoints } from '@/lib/taskPoints';
import { costCenti, extraTimeText } from '@/lib/pointsTime';
import type { MyExtraTimeDTO } from '@/lib/types';
import type { BuyExtraTimeInput } from '@/lib/validation/phone';

// Points for screen time (parental controls): a child spends task points on
// extra minutes for today, at the rate a supervising adult set
// (PointsForTime, supervisionService.setPointsForTime), up to its daily cap.
// Adults can also give minutes (supervisionService.giveExtraTime). Both are
// ExtraTime rows for the phone's day; the phone adds the day's minutes to
// every daily limit it has (notifications/AppLimiter). Spending comes off the
// points balance (earned awards minus spent points); PointAward, and so the
// stats, never change. Needs the household's Points feature. Rules:
// src/lib/pointsTime.ts.

type Db = Prisma.TransactionClient | typeof prisma;

/** The bell type for minutes a child bought. */
export const EXTRA_TIME_TYPE = 'extra_time';

/** What a phone needs to offer buying minutes: the rate and cap. */
export interface PhonePointsRule {
  minutesPerPoint: number;
  dailyCap: number;
}

/** The UTC date [offsetDays] from [now], as "YYYY-MM-DD". */
function utcDay(now: Date, offsetDays: number): string {
  return new Date(now.getTime() + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

/** Whether [day] (a phone's date) is close enough to the server's to be today somewhere. */
export function nearToday(day: string, now: Date): boolean {
  return day >= utcDay(now, -1) && day <= utcDay(now, 1);
}

/** Each of [userIds]' points balance in hundredths: points earned (not voided) minus points spent. */
export async function pointsBalances(db: Db, householdId: string, userIds: string[]): Promise<Map<string, number>> {
  const out = new Map(userIds.map((id) => [id, 0]));
  if (userIds.length === 0) return out;
  const [earned, spent] = await Promise.all([
    db.pointAward.groupBy({
      by: ['userId'],
      where: { householdId, userId: { in: userIds }, ...NOT_VOIDED },
      _sum: { pointsCenti: true },
    }),
    db.extraTime.groupBy({
      by: ['userId'],
      where: { householdId, userId: { in: userIds }, pointsCenti: { gt: 0 } },
      _sum: { pointsCenti: true },
    }),
  ]);
  for (const row of earned) out.set(row.userId, (out.get(row.userId) ?? 0) + (row._sum.pointsCenti ?? 0));
  for (const row of spent) out.set(row.userId, (out.get(row.userId) ?? 0) - (row._sum.pointsCenti ?? 0));
  return out;
}

/** [userId]'s minutes bought and given on [day]. */
export async function minutesOn(db: Db, userId: string, day: string): Promise<{ bought: number; given: number }> {
  const rows = await db.extraTime.findMany({ where: { userId, day }, select: { minutes: true, pointsCenti: true } });
  return {
    bought: rows.filter((r) => r.pointsCenti > 0).reduce((sum, r) => sum + r.minutes, 0),
    given: rows.filter((r) => r.pointsCenti === 0).reduce((sum, r) => sum + r.minutes, 0),
  };
}

/** The adults who look after [userId] right now (both roles still fit). */
async function supervisorsOf(db: Db, householdId: string, userId: string): Promise<string[]> {
  const links = await db.supervision.findMany({
    where: { householdId, supervisedId: userId },
    select: { supervisorId: true, supervisor: { select: { role: true } }, supervised: { select: { role: true } } },
  });
  return [
    ...new Set(
      links.filter((l) => canSupervise(l.supervisor.role) && canBeSupervised(l.supervised.role)).map((l) => l.supervisorId),
    ),
  ];
}

/** Each day's extra minutes for [userId] around now (the phone picks its own today). */
export async function phoneExtraTime(householdId: string, userId: string, now: Date = new Date()) {
  const rows = await prisma.extraTime.findMany({
    where: { householdId, userId, day: { gte: utcDay(now, -1), lte: utcDay(now, 1) } },
    select: { day: true, minutes: true },
  });
  const byDay = new Map<string, number>();
  for (const r of rows) byDay.set(r.day, (byDay.get(r.day) ?? 0) + r.minutes);
  return [...byDay].sort(([a], [b]) => a.localeCompare(b)).map(([day, minutes]) => ({ day, minutes }));
}

/** [userId]'s rate and cap, for their phone; null when off or the household doesn't use Points. */
export async function phonePointsRule(householdId: string, userId: string): Promise<PhonePointsRule | null> {
  const rule = await prisma.pointsForTime.findUnique({ where: { userId } });
  if (!rule || rule.householdId !== householdId) return null;
  if (!(await isFeatureEnabled(householdId, 'points').catch(() => true))) return null;
  return { minutesPerPoint: rule.minutesPerPoint, dailyCap: rule.dailyCap };
}

/**
 * The signed-in member's own view (their Profile, their phone): whether they
 * can buy minutes ([available]: someone looks after them, set a rate, the
 * household uses Points, and they have a daily limit to add to), the rate,
 * cap, balance and what [day] (their phone's date) has had.
 */
export async function myExtraTime(householdId: string, userId: string, day: string): Promise<MyExtraTimeDTO> {
  const [rule, supervisors, limits, balances, today] = await Promise.all([
    phonePointsRule(householdId, userId),
    supervisorsOf(prisma, householdId, userId),
    prisma.appLimit.count({ where: { householdId, userId } }),
    pointsBalances(prisma, householdId, [userId]),
    minutesOn(prisma, userId, day),
  ]);
  const on = supervisors.length > 0 && rule !== null;
  return {
    available: on && limits > 0,
    hasLimits: limits > 0,
    minutesPerPoint: on ? rule.minutesPerPoint : null,
    dailyCap: on ? rule.dailyCap : null,
    balanceCenti: balances.get(userId) ?? 0,
    day,
    bought: today.bought,
    given: today.given,
  };
}

/**
 * The member buys [minutes] for [day] (their phone's date) with points:
 * refused (409, saying why) unless they can buy at all, it fits what's left
 * of the day's cap and their balance covers it. Each adult who looks after
 * them gets a bell alert, which wakes their phone; their own phones are woken
 * too, so every one of them adds the minutes.
 */
export async function buyExtraTime(
  householdId: string,
  userId: string,
  input: BuyExtraTimeInput,
  now: Date = new Date(),
): Promise<MyExtraTimeDTO> {
  if (!nearToday(input.day, now)) throw new ConflictError('Your phone’s date looks wrong. Check its clock, then try again.');
  const status = await myExtraTime(householdId, userId, input.day);
  if (status.minutesPerPoint === null || status.dailyCap === null) {
    throw new ConflictError('Points can’t buy screen time for you. An adult who looks after you can turn it on.');
  }
  if (!status.hasLimits) throw new ConflictError('You have no daily limits, so there’s nothing to add time to.');
  const left = status.dailyCap - status.bought;
  if (input.minutes > left) {
    throw new ConflictError(
      left > 0 ? `You can buy ${formatMinutes(left)} more today.` : 'You’ve bought all the time you can today.',
    );
  }
  const cost = costCenti(input.minutes, status.minutesPerPoint);
  if (cost > status.balanceCenti) {
    throw new ConflictError(
      `That costs ${formatPoints(cost)} points, and you have ${formatPoints(Math.max(0, status.balanceCenti))}.`,
    );
  }
  const [user, supervisors] = await Promise.all([
    prisma.user.findFirst({ where: { id: userId, householdId }, select: { name: true } }),
    supervisorsOf(prisma, householdId, userId),
  ]);
  const name = user?.name ?? 'Someone';
  await prisma.$transaction(async (tx) => {
    const row = await tx.extraTime.create({
      data: { householdId, userId, day: input.day, minutes: input.minutes, pointsCenti: cost, byId: userId },
    });
    await logActivity(
      {
        householdId,
        actorId: userId,
        verb: 'updated',
        subjectType: 'member',
        subjectId: userId,
        message: `spent ${formatPoints(cost)} ${cost === 100 ? 'point' : 'points'} on ${formatMinutes(input.minutes)} more screen time`,
      },
      tx,
    );
    if (supervisors.length > 0) {
      await tx.notification.createMany({
        data: supervisors.map((supervisorId) => ({
          householdId,
          userId: supervisorId,
          type: EXTRA_TIME_TYPE,
          ...extraTimeText(name, input.minutes, cost, left - input.minutes),
          channel: 'in_app',
          subjectType: 'phone',
          subjectId: userId,
          dedupeKey: `extra_time:${row.id}:${supervisorId}`,
          readAt: null,
          createdAt: now,
        })),
      });
    }
  });
  if (supervisors.length > 0) pushSync(householdId, { userIds: supervisors }, 'reminder');
  // Their other phones learn the new minutes too.
  pushSync(householdId, { userIds: [userId] }, 'supervision');
  return myExtraTime(householdId, userId, input.day);
}
