import { formatMinutes } from '@/lib/appUsage';
import { formatPoints } from '@/lib/taskPoints';

// Points for screen time (parental controls; pointsTimeService): a child
// spends task points on extra minutes for today, at the rate their supervising
// adult set, up to a daily cap. The minutes go on top of every daily limit
// they have today (all apps, and each app's own); schedules aren't touched.
// Spending comes off their points balance (earned minus spent); what they
// earned, and the stats, stay as they were. Adults can also give extra
// minutes themselves. The Android app has the same rules (data/PointsTime.kt).

/** What one point can buy, in minutes (the server takes 1 to 60). */
export const RATE_CHOICES = [1, 2, 5, 10, 15, 30] as const;
export const RATE_MAX = 60;

/** The most minutes a day they can buy (the server takes 5 to 240). */
export const CAP_CHOICES = [15, 30, 45, 60, 90, 120] as const;
export const CAP_MIN = 5;
export const CAP_MAX = 240;

/** What a child is offered to buy, and an adult to give, in minutes. */
export const BUY_STEPS = [15, 30, 60] as const;
export const GIVE_STEPS = [15, 30, 60] as const;

/** The points (hundredths) [minutes] cost at [minutesPerPoint], rounded up. */
export function costCenti(minutes: number, minutesPerPoint: number): number {
  return Math.ceil((minutes * 100) / minutesPerPoint);
}

/** "1 point = 5 min". */
export function rateLabel(minutesPerPoint: number): string {
  return `1 point = ${formatMinutes(minutesPerPoint)}`;
}

/**
 * What a child can buy now: BUY_STEPS that fit what's left of today's cap and
 * their balance, plus the most they can afford when that's less than a step
 * (in 5-minute steps). Each with its cost.
 */
export function buyOptions(input: {
  balanceCenti: number;
  minutesPerPoint: number;
  dailyCap: number;
  boughtToday: number;
}): { minutes: number; costCenti: number }[] {
  const left = Math.max(0, input.dailyCap - input.boughtToday);
  const affordable = Math.floor((Math.max(0, input.balanceCenti) * input.minutesPerPoint) / 100);
  const most = Math.floor(Math.min(left, affordable) / 5) * 5;
  const minutes = [...new Set([...BUY_STEPS.filter((m) => m <= most), most])].filter((m) => m >= 5);
  return minutes.sort((a, b) => a - b).map((m) => ({ minutes: m, costCenti: costCenti(m, input.minutesPerPoint) }));
}

/** The bell alert to a supervisor when [name] bought minutes. */
export function extraTimeText(name: string, minutes: number, pointsCenti: number, leftToday: number) {
  return {
    title: `${name} spent ${formatPoints(pointsCenti)} ${pointsCenti === 100 ? 'point' : 'points'} on ${formatMinutes(minutes)} more`,
    body:
      `Their daily limits are ${formatMinutes(minutes)} longer today.` +
      (leftToday > 0 ? ` They can buy ${formatMinutes(leftToday)} more today.` : ' That was the most they can buy today.'),
  };
}
