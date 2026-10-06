import type { RecurrenceKind } from '@/lib/enums';

// Pure recurrence math. Kept free of Prisma/IO so it can be unit-tested directly.
// All arithmetic is done in UTC for determinism; the time-of-day of the anchor is
// preserved in every computed occurrence.

const DAY_MS = 24 * 60 * 60 * 1000;

export interface NormalizedRule {
  kind: RecurrenceKind;
  interval: number;
  byWeekday?: number[]; // 0=Sun .. 6=Sat
  byMonthday?: number[]; // 1..31
  cron?: string | null;
  anchorDate: Date;
  until?: Date | null; // no occurrences after this instant
}

/** Parse a delimited "1,3,5" string into a sorted unique number array. */
export function parseIntList(value: string | null | undefined): number[] | undefined {
  if (!value) return undefined;
  const nums = value
    .split(',')
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n));
  if (nums.length === 0) return undefined;
  return Array.from(new Set(nums)).sort((a, b) => a - b);
}

/** Serialize a number array back into the delimited storage form. */
export function formatIntList(values: number[] | undefined | null): string | null {
  if (!values || values.length === 0) return null;
  return Array.from(new Set(values))
    .sort((a, b) => a - b)
    .join(',');
}

function addDaysUTC(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

function withAnchorTime(date: Date, anchor: Date): Date {
  const d = new Date(date);
  d.setUTCHours(
    anchor.getUTCHours(),
    anchor.getUTCMinutes(),
    anchor.getUTCSeconds(),
    anchor.getUTCMilliseconds(),
  );
  return d;
}

function daysInMonthUTC(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

function addMonthsUTC(date: Date, months: number): Date {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + months;
  const targetYear = year + Math.floor(month / 12);
  const targetMonth = ((month % 12) + 12) % 12;
  const day = Math.min(date.getUTCDate(), daysInMonthUTC(targetYear, targetMonth));
  return new Date(
    Date.UTC(
      targetYear,
      targetMonth,
      day,
      date.getUTCHours(),
      date.getUTCMinutes(),
      date.getUTCSeconds(),
      date.getUTCMilliseconds(),
    ),
  );
}

/**
 * The next occurrence strictly after `from`. Cadence is aligned to `anchorDate`
 * (and to byWeekday/byMonthday when provided). Returns null for unsupported kinds
 * (e.g. cron, which is computed by an external scheduler in a later phase) and
 * when the computed occurrence would fall after the rule's `until` end date.
 */
export function computeNextRunAt(rule: NormalizedRule, from: Date): Date | null {
  const interval = Math.max(1, Math.floor(rule.interval || 1));
  const anchor = rule.anchorDate;

  let next: Date | null;
  switch (rule.kind) {
    case 'daily':
    case 'interval':
      next = nextAligned(anchor, from, interval, 1);
      break;

    case 'weekly': {
      next =
        rule.byWeekday && rule.byWeekday.length > 0
          ? nextByWeekday(anchor, from, rule.byWeekday)
          : nextAligned(anchor, from, interval, 7);
      break;
    }

    case 'monthly': {
      next =
        rule.byMonthday && rule.byMonthday.length > 0
          ? nextByMonthday(anchor, from, rule.byMonthday)
          : nextAlignedMonths(anchor, from, interval);
      break;
    }

    case 'cron':
    default:
      next = null;
  }

  // Honour the optional end date: nothing recurs past `until`.
  if (next && rule.until && next > rule.until) return null;
  return next;
}

/** Anchor + k*(interval*stepDays) for the smallest k≥1 that lands after `from`. */
function nextAligned(anchor: Date, from: Date, interval: number, stepDays: number): Date {
  const step = interval * stepDays;
  const aligned = withAnchorTime(anchor, anchor);
  if (from < aligned) return aligned;
  const elapsedDays = Math.floor((from.getTime() - aligned.getTime()) / DAY_MS);
  const k = Math.floor(elapsedDays / step) + 1;
  return addDaysUTC(aligned, k * step);
}

function nextAlignedMonths(anchor: Date, from: Date, interval: number): Date {
  let candidate = withAnchorTime(anchor, anchor);
  if (from < candidate) return candidate;
  // Advance in interval-month steps until strictly after `from`.
  let guard = 0;
  while (candidate <= from && guard < 1200) {
    candidate = addMonthsUTC(candidate, interval);
    guard += 1;
  }
  return candidate;
}

function nextByWeekday(anchor: Date, from: Date, weekdays: number[]): Date {
  const set = new Set(weekdays);
  // Search day-by-day for up to one week beyond `from`.
  for (let i = 1; i <= 7; i += 1) {
    const candidate = withAnchorTime(addDaysUTC(startOfDayUTC(from), i), anchor);
    if (candidate > from && set.has(candidate.getUTCDay())) {
      return candidate;
    }
  }
  // Fallback (shouldn't happen): a week out.
  return withAnchorTime(addDaysUTC(from, 7), anchor);
}

function nextByMonthday(anchor: Date, from: Date, monthdays: number[]): Date {
  const sorted = Array.from(new Set(monthdays)).sort((a, b) => a - b);
  // Scan the current and next couple of months for the next matching day.
  let cursor = new Date(
    Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1),
  );
  for (let m = 0; m < 4; m += 1) {
    const year = cursor.getUTCFullYear();
    const month = cursor.getUTCMonth();
    const dim = daysInMonthUTC(year, month);
    for (const day of sorted) {
      if (day > dim) continue; // clamp: skip days that don't exist this month
      const candidate = withAnchorTime(
        new Date(Date.UTC(year, month, day)),
        anchor,
      );
      if (candidate > from) return candidate;
    }
    cursor = addMonthsUTC(cursor, 1);
  }
  return withAnchorTime(addDaysUTC(from, 30), anchor);
}

function startOfDayUTC(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}
