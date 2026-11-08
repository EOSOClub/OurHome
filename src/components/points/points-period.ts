// Plain helpers for the Points page's period stepper. No React here, so they
// can be tested.

import { addDays, parseLocalDate, type LocalDate } from '@/lib/taskCycles';
import type { PointsSummaryDTO } from '@/lib/types';

type Period = PointsSummaryDTO['period'];

export function iso(d: LocalDate): string {
  return `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
}

/** The first day after the period that starts on `start`. */
function periodEnd(period: Period, start: LocalDate): LocalDate {
  switch (period) {
    case 'day':
      return addDays(start, 1);
    case 'week':
      return addDays(start, 7);
    case 'month':
      return start.month === 12
        ? { year: start.year + 1, month: 1, day: start.day }
        : { year: start.year, month: start.month + 1, day: start.day };
    case 'year':
      return { year: start.year + 1, month: start.month, day: start.day };
  }
}

/**
 * What the Next button moves to: `next` (the start of the following period),
 * or null ("now") once that period is the current one, i.e. it holds `today`
 * ("YYYY-MM-DD" in the household's zone), or would start in the future.
 * Comparing the period's start with now kept the current period as a dated
 * past one, since its start has nearly always passed.
 */
export function nextPeriodDate(period: Period, next: string, today: string): string | null {
  const start = parseLocalDate(next);
  if (!start || next > today) return null;
  return today < iso(periodEnd(period, start)) ? null : next;
}
