import type { RecurrenceKind } from '@/lib/enums';

// Pure recurrence math. Kept free of Prisma/IO so it can be unit-tested directly.
// The arithmetic runs on "wall clock" dates - fake-UTC dates whose UTC fields
// are the local date and time in the rule's time zone - so an occurrence keeps
// its local time of day across daylight-saving changes (noon stays noon) and
// weekdays are local weekdays. With no zone (or UTC) wall time is UTC.

const DAY_MS = 24 * 60 * 60 * 1000;

export interface NormalizedRule {
  kind: RecurrenceKind;
  interval: number;
  byWeekday?: number[]; // 0=Sun .. 6=Sat
  byMonthday?: number[]; // 1..31
  cron?: string | null;
  anchorDate: Date;
  until?: Date | null; // no occurrences after this instant
  /** IANA zone whose local time the rule follows (the household's). */
  timeZone?: string | null;
}

/** `d` as a wall-clock date in `timeZone` (see the note at the top). */
export function toWall(d: Date, timeZone: string): Date {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(d);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return new Date(
    Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'), d.getUTCMilliseconds()),
  );
}

/** The real instant of a wall-clock date in `timeZone`. */
export function fromWall(wall: Date, timeZone: string): Date {
  // Offset-correct twice: the second pass settles dates next to a DST change.
  let guess = new Date(wall.getTime());
  for (let i = 0; i < 2; i += 1) {
    const offset = toWall(guess, timeZone).getTime() - guess.getTime();
    guess = new Date(wall.getTime() - offset);
  }
  return guess;
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
 * The occurrence after the current one (`current`, e.g. a bill's or task's due
 * date), when that one is being paid/completed. Counted from the current due
 * date while it's still ahead: picked dates sit at 12:00, so counting from
 * "now" on the morning of (or days before) the due date would land on that
 * same occurrence and nothing would move on.
 */
export function nextAfterOccurrence(rule: NormalizedRule, current: Date | null, now = new Date()): Date | null {
  return computeNextRunAt(rule, current && current > now ? current : now);
}

/**
 * The next occurrence strictly after `from`. Cadence is aligned to `anchorDate`
 * (and to byWeekday/byMonthday when provided). Returns null for unsupported kinds
 * (e.g. cron, which is computed by an external scheduler in a later phase) and
 * when the computed occurrence would fall after the rule's `until` end date.
 */
export function computeNextRunAt(rule: NormalizedRule, from: Date): Date | null {
  const tz = rule.timeZone;
  if (!tz || tz === 'UTC') return nextWall(rule, from);
  const next = nextWall(
    {
      ...rule,
      anchorDate: toWall(rule.anchorDate, tz),
      until: rule.until ? toWall(rule.until, tz) : null,
    },
    toWall(from, tz),
  );
  return next ? fromWall(next, tz) : null;
}

/** computeNextRunAt on wall-clock dates. */
function nextWall(rule: NormalizedRule, from: Date): Date | null {
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
          ? nextByWeekday(anchor, from, rule.byWeekday, interval)
          : nextAligned(anchor, from, interval, 7);
      break;
    }

    case 'monthly': {
      next =
        rule.byMonthday && rule.byMonthday.length > 0
          ? nextByMonthday(anchor, from, rule.byMonthday, interval)
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

/** Nothing occurs before the rule starts: search from just before the anchor. */
function notBefore(anchor: Date, from: Date): Date {
  return from < anchor ? new Date(anchor.getTime() - 1) : from;
}

/** Days since the epoch of a (wall) date's calendar day. */
function dayNumber(d: Date): number {
  return Math.floor(startOfDayUTC(d).getTime() / DAY_MS);
}

/**
 * The next listed weekday after `from`, in weeks that are a multiple of
 * `interval` weeks from the anchor's week (Sunday-based), never before the
 * anchor: "every other Tuesday from Dec 2" skips the Tuesdays between.
 */
function nextByWeekday(anchor: Date, fromIn: Date, weekdays: number[], interval = 1): Date {
  const set = new Set(weekdays);
  const from = notBefore(anchor, fromIn);
  const anchorWeek = dayNumber(anchor) - anchor.getUTCDay();
  for (let i = 0; i <= 7 * interval + 7; i += 1) {
    const candidate = withAnchorTime(addDaysUTC(startOfDayUTC(from), i), anchor);
    if (candidate <= from || !set.has(candidate.getUTCDay())) continue;
    const week = Math.floor((dayNumber(candidate) - anchorWeek) / 7);
    if (week % interval === 0) return candidate;
  }
  // Fallback (shouldn't happen): a week out.
  return withAnchorTime(addDaysUTC(from, 7), anchor);
}

/**
 * The next listed day of the month after `from`, in months that are a
 * multiple of `interval` from the anchor's month, never before the anchor.
 * Days a month doesn't have are skipped in that month.
 */
function nextByMonthday(anchor: Date, fromIn: Date, monthdays: number[], interval = 1): Date {
  const sorted = Array.from(new Set(monthdays)).sort((a, b) => a - b);
  const from = notBefore(anchor, fromIn);
  const anchorMonth = anchor.getUTCFullYear() * 12 + anchor.getUTCMonth();
  let cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
  for (let m = 0; m < 3 * interval + 3; m += 1) {
    const year = cursor.getUTCFullYear();
    const month = cursor.getUTCMonth();
    if ((year * 12 + month - anchorMonth) % interval === 0) {
      const dim = daysInMonthUTC(year, month);
      for (const day of sorted) {
        if (day > dim) continue; // skip days that don't exist this month
        const candidate = withAnchorTime(new Date(Date.UTC(year, month, day)), anchor);
        if (candidate > from) return candidate;
      }
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
