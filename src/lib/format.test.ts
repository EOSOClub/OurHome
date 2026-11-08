import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  APP_LOCALE,
  dateKey,
  dueIsAllDay,
  formatDate,
  formatDueDate,
  formatMoney,
  formatRelativeTime,
  isDateOnly,
  isOverdue,
  timeKey,
  zonedInstant,
} from '@/lib/format';

// Chicago is UTC-5 in March 2026 (after the DST change on Mar 8).
const tz = 'America/Chicago';
const at = (s: string) => new Date(s);

describe('zonedInstant / timeKey', () => {
  it('reads date and time inputs in the given zone', () => {
    expect(zonedInstant('2026-03-10', '09:30', tz).toISOString()).toBe('2026-03-10T14:30:00.000Z');
    // January is CST (UTC-6).
    expect(zonedInstant('2026-01-10', '00:00', tz).toISOString()).toBe('2026-01-10T06:00:00.000Z');
    expect(zonedInstant('2026-03-10', '09:30', 'Asia/Tokyo').toISOString()).toBe('2026-03-10T00:30:00.000Z');
  });

  it('round-trips through dateKey and timeKey', () => {
    const d = zonedInstant('2026-11-01', '23:45', tz);
    expect(dateKey(d, tz)).toBe('2026-11-01');
    expect(timeKey(d, tz)).toBe('23:45');
  });

  // The forms store a date picked without a time as 12:00 household time
  // (the "no time" mark) and prefill an edit with dateKey/timeKey.
  it('keeps a date-only pick at 12:00 household time across DST changes', () => {
    const cases: [string, string, string][] = [
      ['2026-03-07', tz, '2026-03-07T18:00:00.000Z'], // CST, day before spring forward
      ['2026-03-08', tz, '2026-03-08T17:00:00.000Z'], // CDT, the change day
      ['2026-10-31', tz, '2026-10-31T17:00:00.000Z'], // CDT, day before fall back
      ['2026-11-01', tz, '2026-11-01T18:00:00.000Z'], // CST, the change day
      ['2026-11-10', 'Asia/Tokyo', '2026-11-10T03:00:00.000Z'], // ahead of UTC
    ];
    for (const [day, zone, iso] of cases) {
      const d = zonedInstant(day, '12:00', zone);
      expect(d.toISOString()).toBe(iso);
      expect(isDateOnly(d, zone)).toBe(true);
      expect(dateKey(d, zone)).toBe(day);
      expect(timeKey(d, zone)).toBe('12:00');
    }
  });

  it('round-trips a timed pick on the DST change days', () => {
    for (const [day, time] of [['2026-03-08', '09:15'], ['2026-11-01', '01:30'], ['2026-11-01', '18:45']]) {
      const d = zonedInstant(day, time, tz);
      expect(dateKey(d, tz)).toBe(day);
      expect(timeKey(d, tz)).toBe(time);
      expect(isDateOnly(d, tz)).toBe(false);
    }
    const tokyo = zonedInstant('2026-11-10', '00:30', 'Asia/Tokyo');
    expect(tokyo.toISOString()).toBe('2026-11-09T15:30:00.000Z');
    expect(dateKey(tokyo, 'Asia/Tokyo')).toBe('2026-11-10');
    expect(timeKey(tokyo, 'Asia/Tokyo')).toBe('00:30');
  });

  it('formats midnight as 00:00', () => {
    expect(timeKey(at('2026-03-10T05:00:00Z'), tz)).toBe('00:00');
  });
});

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

  it('a task’s own all-day flag wins over the 12:00 marker (owner, 2026-11-08)', () => {
    // Really due at 12:00: overdue from 12:00 that day, not the next day.
    expect(isOverdue(dueNoon, tz, at('2026-03-10T17:30:00Z'), false)).toBe(true);
    expect(isOverdue(dueNoon, tz, at('2026-03-10T16:30:00Z'), false)).toBe(false);
    // All day at another stored time still counts by the day.
    const due9 = at('2026-03-10T14:00:00Z');
    expect(isOverdue(due9, tz, at('2026-03-10T22:00:00Z'), true)).toBe(false);
    // No flag (older tasks, older apps): the 12:00 marker, as before.
    expect(isOverdue(dueNoon, tz, at('2026-03-10T22:00:00Z'), null)).toBe(false);
  });
});

describe('dueIsAllDay', () => {
  it('reads the flag, else the 12:00 marker; nothing is all day without a date', () => {
    const dueNoon = at('2026-03-10T17:00:00Z');
    expect(dueIsAllDay(dueNoon, false, tz)).toBe(false);
    expect(dueIsAllDay(dueNoon, null, tz)).toBe(true);
    expect(dueIsAllDay(dueNoon, undefined, tz)).toBe(true);
    expect(dueIsAllDay(at('2026-03-10T14:00:00Z'), true, tz)).toBe(true);
    expect(dueIsAllDay(at('2026-03-10T14:00:00Z'), null, tz)).toBe(false);
    expect(dueIsAllDay(null, true, tz)).toBe(false);
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

// The server and the browser must print the same text, whatever locale the
// browser is set to, or React reports a hydration mismatch.
describe('one fixed locale', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('formats money and dates in APP_LOCALE, not the runtime default', () => {
    vi.useFakeTimers();
    vi.setSystemTime(at('2026-11-07T12:00:00Z'));
    expect(APP_LOCALE).toBe('en-US');
    const dates = vi.spyOn(Date.prototype, 'toLocaleDateString');
    const RealNumberFormat = Intl.NumberFormat;
    const numbers = vi
      .spyOn(Intl, 'NumberFormat')
      .mockImplementation(function (locale, options) {
        return new RealNumberFormat(locale, options);
      } as typeof Intl.NumberFormat);

    expect(formatMoney(12)).toBe('$12.00');
    expect(formatMoney(12, 'EUR')).toBe('€12.00');
    expect(formatDate(at('2026-11-07T18:00:00Z'), 'UTC')).toBe('Nov 7, 2026');
    expect(formatDueDate(at('2027-01-20T18:00:00Z'), 'UTC')).toBe('Due Jan 20');
    expect(formatRelativeTime(at('2020-01-05T18:00:00Z'), 'UTC')).toBe('Jan 5');

    expect(numbers.mock.calls.length).toBe(2);
    expect(numbers.mock.calls.every(([locale]) => locale === APP_LOCALE)).toBe(true);
    expect(dates.mock.calls.length).toBeGreaterThan(0);
    expect(dates.mock.calls.every(([locale]) => locale === APP_LOCALE)).toBe(true);
  });
});
