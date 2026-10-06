const DAY_MS = 24 * 60 * 60 * 1000;

/** Format a monetary amount in the bill's currency (falls back to USD). */
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
export function formatDate(date: Date | string | null | undefined): string {
  if (!date) return '—';
  return new Date(date).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Human-friendly due-date label relative to today. */
export function formatDueDate(date: Date | string | null | undefined): string {
  if (!date) return 'No due date';
  const due = new Date(date);
  const diffDays = Math.round((startOfDay(due) - startOfDay(new Date())) / DAY_MS);

  if (diffDays === 0) return 'Due today';
  if (diffDays === 1) return 'Due tomorrow';
  if (diffDays === -1) return 'Overdue by 1 day';
  if (diffDays < -1) return `Overdue by ${Math.abs(diffDays)} days`;
  if (diffDays <= 7) return `Due in ${diffDays} days`;

  return `Due ${due.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  })}`;
}

export function isOverdue(date: Date | string | null | undefined): boolean {
  if (!date) return false;
  return new Date(date).getTime() < Date.now();
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
export function formatRelativeTime(date: Date | string): string {
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
  });
}
