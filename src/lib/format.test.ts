import { afterEach, describe, expect, it, vi } from 'vitest';
import { dateKey, formatDueDate, isDateOnly, isOverdue } from '@/lib/format';

// Chicago is UTC-5 in March 2026 (after the DST change on Mar 8).
const tz = 'America/Chicago';
const at = (s: string) => new Date(s);

describe('isOverdue', () => {
  const dueNoon = at('2026-03-10T17:00:00Z'); // Mar 10, 12:00 Chicago: a date-only pick

  it('treats a date-only due date as due all day', () => {
    expect(isDateOnly(dueNoon, tz)).toBe(true);
    expect(isOverdue(dueNoon, tz, at('2026-03-10T22:00:00Z'))).toBe(false); // 5 pm that day
    expect(isOverdue(dueNoon, tz, at('2026-03-11T06:00:00Z'))).toBe(true); // 1 am next day
  });

  it('uses the exact time for a timed due date', () => {
    const due = at('2026-03-10T14:00:00Z'); // 9:00 Chicago
    expect(isDateOnly(due, tz)).toBe(false);
    expect(isOverdue(due, tz, at('2026-03-10T15:00:00Z'))).toBe(true);
    expect(isOverdue(due, tz, at('2026-03-10T13:00:00Z'))).toBe(false);
  });

  it('is false without a date', () => {
    expect(isOverdue(null, tz)).toBe(false);
  });
});

describe('formatDueDate in a zone', () => {
  afterEach(() => vi.useRealTimers());

  it('counts days in the given zone, not the runtime one', () => {
    // 8 pm Chicago on Mar 10 is already Mar 11 in UTC.
    vi.useFakeTimers();
    vi.setSystemTime(at('2026-03-11T01:00:00Z'));
    expect(formatDueDate(at('2026-03-10T17:00:00Z'), tz)).toBe('Due today');
    expect(formatDueDate(at('2026-03-11T17:00:00Z'), tz)).toBe('Due tomorrow');
  });
});

describe('dateKey', () => {
  it('gives the calendar day in the zone', () => {
    // 8 pm Chicago on Mar 10 is Mar 11 in UTC.
    expect(dateKey(at('2026-03-11T01:00:00Z'), tz)).toBe('2026-03-10');
    expect(dateKey(at('2026-03-11T01:00:00Z'), 'UTC')).toBe('2026-03-11');
  });
});
