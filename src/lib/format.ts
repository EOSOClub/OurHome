import { localTimeAt, parseLocalDate } from '@/lib/taskCycles';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The one locale every label is formatted in. Pages render on the server and
 * then hydrate in the browser; with the runtime's default locale a browser set
 * to another one (e.g. en-GB) produced different text ("US$12.00",
 * "7 Nov 2026") and React reported a hydration mismatch.
 */
export const APP_LOCALE = 'en-US';

/** `url` if it is http(s), else undefined: safe to put in an `href`. */
export function safeHref(url: string | null | undefined): string | undefined {
  return url && /^https?:\/\//i.test(url) ? url : undefined;
}

/** Format a monetary amount in the bill's currency (falls back to USD). */
export function formatMoney(
  amount: number,
  currency?: string | null,
): string {
  const format = (code: string) =>
    new Intl.NumberFormat(APP_LOCALE, { style: 'currency', currency: code }).format(amount);
  try {
    return format(currency || 'USD');
  } catch {
    // A stored currency that isn't a 3-letter code ("US$") throws a
    // RangeError, which took the whole page down. Show the amount anyway.
    return format('USD');
  }
}

/**
 * The currency for a total over several amounts: the one they all share
 * (none set counts as USD), or undefined when they differ. A household whose
 * bills are all in euros gets its totals in euros; mixed currencies keep the
 * dollar total they always had.
 */
export function sharedCurrency(
  currencies: (string | null | undefined)[],
): string | undefined {
  const codes = new Set(currencies.map((c) => (c || 'USD').toUpperCase()));
  return codes.size === 1 ? [...codes][0] : undefined;
}

/** Absolute calendar date label, e.g. "Jul 2, 2026". */
export function formatDate(date: Date | string | null | undefined, timeZone?: string): string {
  if (!date) return '-';
  return new Date(date).toLocaleDateString(APP_LOCALE, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone,
  });
}

/**
 * The calendar day (as a UTC midnight timestamp, for differences) and clock
 * time of `d` as seen in `timeZone` (default: wherever this code runs). The
 * dashboard renders on the server, so it passes the household's zone.
 */
function zoned(d: Date, timeZone?: string) {
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
  return {
    day: Date.UTC(get('year'), get('month') - 1, get('day')),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

/** "YYYY-MM-DD" of `date` in `timeZone` (default: wherever this runs). */
export function dateKey(date: Date | string, timeZone?: string): string {
  return new Date(zoned(new Date(date), timeZone).day).toISOString().slice(0, 10);
}

/**
 * Every day ("YYYY-MM-DD", in `timeZone`) something from `start` to `end`
 * is on: one day without an end, else each day through the end's. A timed
 * end exactly at midnight belongs to the day before (a party ending at 12:00
 * AM isn't on the next day). Capped at a year.
 */
export function coveredDayKeys(
  start: Date | string,
  end: Date | string | null | undefined,
  allDay: boolean,
  timeZone?: string,
): string[] {
  const first = dateKey(start, timeZone);
  if (!end) return [first];
  const endAt = new Date(end);
  const atMidnight = !allDay && timeKey(endAt, timeZone) === '00:00' && endAt > new Date(start);
  const last = dateKey(atMidnight ? new Date(endAt.getTime() - 1) : endAt, timeZone);
  const keys = [first];
  // Day keys are plain calendar dates, so they are stepped in UTC.
  const day = new Date(`${first}T00:00:00.000Z`);
  while (keys[keys.length - 1] < last && keys.length < 366) {
    day.setUTCDate(day.getUTCDate() + 1);
    keys.push(day.toISOString().slice(0, 10));
  }
  return keys;
}

/** "HH:MM" (24-hour) of `date` in `timeZone`, for a time input. */
export function timeKey(date: Date | string, timeZone?: string): string {
  const t = zoned(new Date(date), timeZone);
  return `${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}`;
}

/**
 * The instant a date input ("YYYY-MM-DD") and time input ("HH:MM") name in
 * `timeZone`: the household's, so a form means the same moment the pages
 * show, whatever zone the browser is in. With no zone, the browser's.
 */
export function zonedInstant(date: string, time: string, timeZone?: string): Date {
  const local = parseLocalDate(date);
  const m = /^(\d{2}):(\d{2})$/.exec(time);
  if (!timeZone || !local || !m) return new Date(`${date}T${time}`);
  return localTimeAt(local, Number(m[1]), Number(m[2]), timeZone);
}

/**
 * The last millisecond of a date input's day ("YYYY-MM-DD") in `timeZone`.
 * A repeat's "Ends on" date is sent as this, so the repeat on that day still
 * happens whatever its time (12:00 dropped every repeat after noon).
 * `dateKey` of the result reads back the same date.
 */
export function endOfDayInstant(date: string, timeZone?: string): Date {
  const local = parseLocalDate(date);
  if (!local) return new Date(`${date}T23:59:59.999`);
  const next = new Date(Date.UTC(local.year, local.month - 1, local.day + 1)).toISOString().slice(0, 10);
  return new Date(zonedInstant(next, '00:00', timeZone).getTime() - 1);
}

/**
 * What an event or task form sends for its repeat's "Ends on" date: the end
 * of that day, or the stored value untouched when the date wasn't changed.
 * Untouched matters: "This and following" ends the earlier part of a series
 * just before the split, and re-saving that as the whole day brought back the
 * date the later part starts with.
 */
export function repeatUntil(
  date: string,
  original: Date | string | null | undefined,
  timeZone?: string,
): string | null {
  if (!date) return null;
  if (original && dateKey(original, timeZone) === date) return new Date(original).toISOString();
  return endOfDayInstant(date, timeZone).toISOString();
}

/** Human-friendly due-date label, worded from today's point of view. */
export function formatDueDate(date: Date | string | null | undefined, timeZone?: string): string {
  if (!date) return 'No due date';
  const due = new Date(date);
  const diffDays = Math.round((zoned(due, timeZone).day - zoned(new Date(), timeZone).day) / DAY_MS);

  if (diffDays === 0) return 'Due today';
  if (diffDays === 1) return 'Due tomorrow';
  if (diffDays === -1) return 'Overdue by 1 day';
  if (diffDays < -1) return `Overdue by ${Math.abs(diffDays)} days`;
  if (diffDays <= 7) return `Due in ${diffDays} days`;

  return `Due ${due.toLocaleDateString(APP_LOCALE, {
    month: 'short',
    day: 'numeric',
    timeZone,
  })}`;
}

/**
 * A due date picked without a time is stored at 12:00 local; such a date is
 * due all day. (A task given an explicit due time keeps that exact time.)
 * Tasks now say so themselves (Task.dueAllDay, [dueIsAllDay]); this marker
 * still decides for bills, requests, and tasks saved without the flag.
 */
export function isDateOnly(date: Date | string, timeZone?: string): boolean {
  const t = zoned(new Date(date), timeZone);
  return t.hour === 12 && t.minute === 0 && t.second === 0;
}

/**
 * Whether a task's due date is all day: its own flag when it has one (so a
 * task really due at 12:00 keeps that time, owner 2026-11-08), else the 12:00
 * marker. Never without a date.
 */
export function dueIsAllDay(
  date: Date | string | null | undefined,
  allDay: boolean | null | undefined,
  timeZone?: string,
): boolean {
  if (!date) return false;
  return allDay ?? isDateOnly(date, timeZone);
}

/**
 * Past due: a date-only due date from the next day on (not from noon on the
 * day itself - that showed "Overdue" next to "Due today"); a timed one once
 * its time has passed. [allDay]: a task's own flag (Task.dueAllDay); left
 * out or null, the 12:00 marker decides.
 */
export function isOverdue(
  date: Date | string | null | undefined,
  timeZone?: string,
  now: Date = new Date(),
  allDay?: boolean | null,
): boolean {
  if (!date) return false;
  const due = new Date(date);
  if (!dueIsAllDay(due, allDay, timeZone)) return due.getTime() < now.getTime();
  return zoned(due, timeZone).day < zoned(now, timeZone).day;
}

/**
 * True when `date` falls on today or one of the next `days` days, as days in
 * `timeZone` (the household's). Whole days, not exact times: a bill is stored
 * at 12:00 on its due date, so comparing instants dropped a bill due today
 * from "Due this week" from noon on, while it still showed as "Due today".
 */
export function isDueWithinDays(
  date: Date | string | null | undefined,
  days: number,
  timeZone?: string,
  now: Date = new Date(),
): boolean {
  if (!date) return false;
  const day = zoned(new Date(date), timeZone).day;
  const today = zoned(now, timeZone).day;
  return day >= today && day <= today + days * DAY_MS;
}

/** Compact "time ago" label for the activity feed. */
export function formatRelativeTime(date: Date | string, timeZone?: string): string {
  const then = new Date(date).getTime();
  const diff = Date.now() - then;
  const mins = Math.round(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(date).toLocaleDateString(APP_LOCALE, {
    month: 'short',
    day: 'numeric',
    timeZone,
  });
}
