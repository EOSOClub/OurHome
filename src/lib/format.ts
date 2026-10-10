const DAY_MS = 24 * 60 * 60 * 1000;

/** Format a monetary amount in the bill's currency (falls back to USD). */
/** `url` if it is http(s), else undefined: safe to put in an href. */
export function safeHref(url: string | null | undefined): string | undefined {
  return url && /^https?:\/\//i.test(url) ? url : undefined;
}

export function formatMoney(
  amount: number,
  currency?: string | null,
): string {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: currency || 'USD',
  }).format(amount);
}

/** Absolute calendar date label, e.g. "Jul 2, 2026". */
export function formatDate(date: Date | string | null | undefined, timeZone?: string): string {
  if (!date) return '—';
  return new Date(date).toLocaleDateString(undefined, {
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

/** Human-friendly due-date label relative to today. */
export function formatDueDate(date: Date | string | null | undefined, timeZone?: string): string {
  if (!date) return 'No due date';
  const due = new Date(date);
  const diffDays = Math.round((zoned(due, timeZone).day - zoned(new Date(), timeZone).day) / DAY_MS);

  if (diffDays === 0) return 'Due today';
  if (diffDays === 1) return 'Due tomorrow';
  if (diffDays === -1) return 'Overdue by 1 day';
  if (diffDays < -1) return `Overdue by ${Math.abs(diffDays)} days`;
  if (diffDays <= 7) return `Due in ${diffDays} days`;

  return `Due ${due.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    timeZone,
  })}`;
}

/**
 * A due date picked without a time is stored at 12:00 local; such a date is
 * due all day. (A task given an explicit due time keeps that exact time.)
 */
export function isDateOnly(date: Date | string, timeZone?: string): boolean {
  const t = zoned(new Date(date), timeZone);
  return t.hour === 12 && t.minute === 0 && t.second === 0;
}

/**
 * Past due: a date-only due date from the next day on (not from noon on the
 * day itself — that showed "Overdue" next to "Due today"); a timed one once
 * its time has passed.
 */
export function isOverdue(
  date: Date | string | null | undefined,
  timeZone?: string,
  now: Date = new Date(),
): boolean {
  if (!date) return false;
  const due = new Date(date);
  if (!isDateOnly(due, timeZone)) return due.getTime() < now.getTime();
  return zoned(due, timeZone).day < zoned(now, timeZone).day;
}

/** True when `date` is now-or-future and within `days` days from now. */
export function isDueWithinDays(
  date: Date | string | null | undefined,
  days: number,
): boolean {
  if (!date) return false;
  const t = new Date(date).getTime();
  const now = Date.now();
  return t >= now && t <= now + days * DAY_MS;
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
  return new Date(date).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    timeZone,
  });
}
