// Calendar maths in the household's time zone: recurring-task cycle
// boundaries (when an unfinished cycle rolls over) and the day / week / month
// / year periods the point statistics use. Pure and IO-free; uses Intl only
// (the project has no date library), so DST is handled by the platform's tz
// data.
//
// A boundary is always local midnight (or the day's first instant, 01:00, on a
// day whose clocks jump past midnight). Monthly cycle days are 1-31; in a
// month without that day the cycle starts on the month's last day instead
// (30 and 31 both land on Feb 28/29 and fire once).

export const DEFAULT_TIMEZONE = 'America/Chicago';
const DAY_MS = 86_400_000;

/** A calendar date (no time, no zone). month is 1-12. */
export interface LocalDate {
  year: number;
  month: number;
  day: number;
}

export type CycleSpec =
  | { kind: 'daily' }
  /** Every `everyDays` days counted from the anchor's local date. */
  | { kind: 'interval'; everyDays: number; anchor: Date }
  /** 0 = Sunday … 6 = Saturday. With everyWeeks > 1, only in weeks that are a
   *  multiple of it from the anchor's week (Sunday-based, as the rule counts). */
  | { kind: 'weekdays'; days: number[]; everyWeeks?: number; anchor?: Date }
  /** 1-31. With everyMonths > 1, only in months that are a multiple of it
   *  from the anchor's month. */
  | { kind: 'monthdays'; days: number[]; everyMonths?: number; anchor?: Date };

export type Period = 'day' | 'week' | 'month' | 'year';

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** True when `timeZone` is an IANA zone this runtime knows. */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

function zonedFields(instant: Date, timeZone: string) {
  const parts = formatter(timeZone).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

/** The calendar date `instant` falls on in `timeZone`. */
export function localDateOf(instant: Date, timeZone: string): LocalDate {
  const { year, month, day } = zonedFields(instant, timeZone);
  return { year, month, day };
}

/** Offset of `timeZone` from UTC at `instant`, in ms (Chicago CDT = −5h). */
function offsetMs(instant: Date, timeZone: string): number {
  const f = zonedFields(instant, timeZone);
  const asUtc = Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second);
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

function sameDate(a: LocalDate, b: LocalDate): boolean {
  return a.year === b.year && a.month === b.month && a.day === b.day;
}

/** Turns the naive UTC reading of a local wall time on `date` into an instant. */
function wallTimeToInstant(date: LocalDate, naive: number, timeZone: string): Date {
  // Two passes settle the offset even when the time sits next to a DST change.
  let guess = naive - offsetMs(new Date(naive), timeZone);
  guess = naive - offsetMs(new Date(guess), timeZone);
  // A wall time the clocks skip (Santiago and Havana jump from 00:00 straight
  // to 01:00) settles on the evening before. Read it with the offset in force
  // before the jump instead, which lands just after the jump on the right day.
  // Without this, local midnight on such a day was 23:00 the day before and
  // the cycle roll-over never moved past it.
  if (!sameDate(localDateOf(new Date(guess), timeZone), date)) {
    const before = naive - offsetMs(new Date(guess), timeZone);
    if (sameDate(localDateOf(new Date(before), timeZone), date)) guess = before;
  }
  return new Date(guess);
}

/** The first instant of `date` in `timeZone`: local midnight, or 01:00 on a
 *  day whose clocks jump past midnight. */
export function startOfLocalDate(date: LocalDate, timeZone: string): Date {
  return wallTimeToInstant(date, Date.UTC(date.year, date.month - 1, date.day), timeZone);
}

/** The instant the local time `hour:minute` on `date` happens in `timeZone`. */
export function localTimeAt(date: LocalDate, hour: number, minute: number, timeZone: string): Date {
  return wallTimeToInstant(date, Date.UTC(date.year, date.month - 1, date.day, hour, minute), timeZone);
}

export function addDays(date: LocalDate, days: number): LocalDate {
  const d = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** 0 = Sunday … 6 = Saturday. */
export function weekdayOf(date: LocalDate): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

/** Whole days from a to b (b - a). */
export function daysBetween(a: LocalDate, b: LocalDate): number {
  return Math.round(
    (Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / DAY_MS,
  );
}

/** Does a new cycle start on this calendar date? */
export function isCycleStart(date: LocalDate, spec: CycleSpec, timeZone: string): boolean {
  switch (spec.kind) {
    case 'daily':
      return true;
    case 'interval': {
      const every = Math.max(1, Math.floor(spec.everyDays));
      const diff = daysBetween(localDateOf(spec.anchor, timeZone), date);
      return ((diff % every) + every) % every === 0;
    }
    case 'weekdays': {
      if (!spec.days.includes(weekdayOf(date))) return false;
      // "Every 2 weeks": the weeks between are part of the cycle before them.
      const every = Math.max(1, Math.floor(spec.everyWeeks ?? 1));
      if (every === 1 || !spec.anchor) return true;
      const anchor = localDateOf(spec.anchor, timeZone);
      const week = Math.floor(daysBetween(addDays(anchor, -weekdayOf(anchor)), date) / 7);
      return ((week % every) + every) % every === 0;
    }
    case 'monthdays': {
      const every = Math.max(1, Math.floor(spec.everyMonths ?? 1));
      if (every > 1 && spec.anchor) {
        const anchor = localDateOf(spec.anchor, timeZone);
        const months = (date.year - anchor.year) * 12 + (date.month - anchor.month);
        if (((months % every) + every) % every !== 0) return false;
      }
      if (spec.days.includes(date.day)) return true;
      // Short month: a later configured day starts on the last day instead.
      const last = daysInMonth(date.year, date.month);
      return date.day === last && spec.days.some((d) => d > last);
    }
  }
}

// A year covers every spec with no interval (the sparsest is one monthday, or
// an interval of up to 365 days), so a search this long always finds a
// boundary; "every n weeks / months" searches n of them, plus one.
const SEARCH_DAYS = 400;

function searchDays(spec: CycleSpec): number {
  if (spec.kind === 'weekdays' && (spec.everyWeeks ?? 1) > 1) return Math.max(SEARCH_DAYS, 7 * (spec.everyWeeks! + 1));
  if (spec.kind === 'monthdays' && (spec.everyMonths ?? 1) > 1) return Math.max(SEARCH_DAYS, 31 * (spec.everyMonths! + 1));
  return SEARCH_DAYS;
}

/** Start of the cycle containing `instant` (the latest boundary at or before it). */
export function cycleStartAt(instant: Date, spec: CycleSpec, timeZone: string): Date {
  const today = localDateOf(instant, timeZone);
  const search = searchDays(spec);
  for (let i = 0; i <= search; i += 1) {
    const date = addDays(today, -i);
    if (isCycleStart(date, spec, timeZone)) return startOfLocalDate(date, timeZone);
  }
  return startOfLocalDate(today, timeZone);
}

/** The first boundary strictly after `instant`. */
export function nextCycleStart(instant: Date, spec: CycleSpec, timeZone: string): Date {
  const today = localDateOf(instant, timeZone);
  const search = searchDays(spec);
  for (let i = 1; i <= search; i += 1) {
    const date = addDays(today, i);
    if (!isCycleStart(date, spec, timeZone)) continue;
    const start = startOfLocalDate(date, timeZone);
    // "Strictly after" is a promise the roll-over loop relies on to finish, so
    // a boundary that is not later (odd tz data) is skipped, never returned.
    if (start > instant) return start;
  }
  const fallback = startOfLocalDate(addDays(today, 1), timeZone);
  return fallback > instant ? fallback : new Date(instant.getTime() + DAY_MS);
}

/** Bounds of the statistics period containing `instant`: [start, end) and its
 *  length in days. Weeks start on `weekStartsOn` (0 = Sunday). */
export function periodBounds(
  period: Period,
  instant: Date,
  timeZone: string,
  weekStartsOn = 0,
): { start: Date; end: Date; startDate: LocalDate; days: number } {
  const today = localDateOf(instant, timeZone);
  let first: LocalDate;
  let next: LocalDate;
  switch (period) {
    case 'day':
      first = today;
      next = addDays(today, 1);
      break;
    case 'week': {
      const back = (weekdayOf(today) - weekStartsOn + 7) % 7;
      first = addDays(today, -back);
      next = addDays(first, 7);
      break;
    }
    case 'month':
      first = { year: today.year, month: today.month, day: 1 };
      next = today.month === 12 ? { year: today.year + 1, month: 1, day: 1 } : { year: today.year, month: today.month + 1, day: 1 };
      break;
    case 'year':
      first = { year: today.year, month: 1, day: 1 };
      next = { year: today.year + 1, month: 1, day: 1 };
      break;
  }
  return {
    start: startOfLocalDate(first, timeZone),
    end: startOfLocalDate(next, timeZone),
    startDate: first,
    days: daysBetween(first, next),
  };
}

/** Days of the period that have started by `now` (at least 1): the divisor
 *  for points-per-day, so a period in progress isn't averaged over its future. */
export function elapsedDays(
  bounds: { startDate: LocalDate; days: number; end: Date },
  now: Date,
  timeZone: string,
): number {
  if (now >= bounds.end) return bounds.days;
  const elapsed = daysBetween(bounds.startDate, localDateOf(now, timeZone)) + 1;
  return Math.min(bounds.days, Math.max(1, elapsed));
}

/** Parses "2026-10-09" into a LocalDate (null if malformed or impossible). */
export function parseLocalDate(value: string): LocalDate | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const date = { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
  if (date.month < 1 || date.month > 12) return null;
  if (date.day < 1 || date.day > daysInMonth(date.year, date.month)) return null;
  return date;
}
