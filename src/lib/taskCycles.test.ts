import { describe, expect, it } from 'vitest';
import {
  cycleStartAt,
  elapsedDays,
  isCycleStart,
  nextCycleStart,
  parseLocalDate,
  periodBounds,
  startOfLocalDate,
} from '@/lib/taskCycles';

const TZ = 'America/Chicago';
const at = (iso: string) => new Date(iso);

describe('local midnight', () => {
  it('is 05:00Z in summer and 06:00Z in winter in Chicago', () => {
    expect(startOfLocalDate({ year: 2026, month: 7, day: 1 }, TZ).toISOString()).toBe('2026-07-01T05:00:00.000Z');
    expect(startOfLocalDate({ year: 2026, month: 1, day: 1 }, TZ).toISOString()).toBe('2026-01-01T06:00:00.000Z');
  });

  it('survives the DST change days', () => {
    // 2026-03-08 and 2026-11-01 are the switch days in the US.
    expect(startOfLocalDate({ year: 2026, month: 3, day: 8 }, TZ).toISOString()).toBe('2026-03-08T06:00:00.000Z');
    expect(startOfLocalDate({ year: 2026, month: 3, day: 9 }, TZ).toISOString()).toBe('2026-03-09T05:00:00.000Z');
    expect(startOfLocalDate({ year: 2026, month: 11, day: 1 }, TZ).toISOString()).toBe('2026-11-01T05:00:00.000Z');
    expect(startOfLocalDate({ year: 2026, month: 11, day: 2 }, TZ).toISOString()).toBe('2026-11-02T06:00:00.000Z');
  });
});

describe('weekday cycles (Mon + Fri)', () => {
  const spec = { kind: 'weekdays' as const, days: [1, 5] };

  it('finds the current and next boundary', () => {
    // Wed 2026-10-07 10:00 local → cycle began Mon 10-05, next is Fri 10-09.
    const now = at('2026-10-07T15:00:00Z');
    expect(cycleStartAt(now, spec, TZ).toISOString()).toBe('2026-10-05T05:00:00.000Z');
    expect(nextCycleStart(now, spec, TZ).toISOString()).toBe('2026-10-09T05:00:00.000Z');
  });

  it('a boundary instant belongs to the new cycle', () => {
    const fridayMidnight = at('2026-10-09T05:00:00Z');
    expect(cycleStartAt(fridayMidnight, spec, TZ)).toEqual(fridayMidnight);
    expect(nextCycleStart(fridayMidnight, spec, TZ).toISOString()).toBe('2026-10-12T05:00:00.000Z');
  });

  it('uses local dates, not UTC ones', () => {
    // Sun 2026-10-11 23:30 local is already Monday in UTC.
    const lateSunday = at('2026-10-12T04:30:00Z');
    expect(cycleStartAt(lateSunday, spec, TZ).toISOString()).toBe('2026-10-09T05:00:00.000Z');
  });
});

describe('month-day cycles', () => {
  it('1st and 20th', () => {
    const spec = { kind: 'monthdays' as const, days: [1, 20] };
    expect(nextCycleStart(at('2026-10-09T15:00:00Z'), spec, TZ).toISOString()).toBe('2026-10-20T05:00:00.000Z');
    expect(nextCycleStart(at('2026-10-21T15:00:00Z'), spec, TZ).toISOString()).toBe('2026-11-01T05:00:00.000Z');
  });

  it('the 31st falls back to the last day of shorter months, leap years included', () => {
    const spec = { kind: 'monthdays' as const, days: [31] };
    expect(nextCycleStart(at('2027-02-10T15:00:00Z'), spec, TZ).toISOString()).toBe('2027-02-28T06:00:00.000Z');
    expect(nextCycleStart(at('2028-02-10T15:00:00Z'), spec, TZ).toISOString()).toBe('2028-02-29T06:00:00.000Z');
    expect(nextCycleStart(at('2026-04-10T15:00:00Z'), spec, TZ).toISOString()).toBe('2026-04-30T05:00:00.000Z');
  });

  it('30 and 31 collapse to one boundary in February', () => {
    const spec = { kind: 'monthdays' as const, days: [30, 31] };
    const first = nextCycleStart(at('2027-02-10T15:00:00Z'), spec, TZ);
    expect(first.toISOString()).toBe('2027-02-28T06:00:00.000Z');
    expect(nextCycleStart(first, spec, TZ).toISOString()).toBe('2027-03-30T05:00:00.000Z');
  });
});

describe('daily and interval cycles', () => {
  it('daily starts every local midnight', () => {
    expect(nextCycleStart(at('2026-10-09T15:00:00Z'), { kind: 'daily' }, TZ).toISOString()).toBe('2026-10-10T05:00:00.000Z');
  });

  it('every 3 days from the anchor date', () => {
    const spec = { kind: 'interval' as const, everyDays: 3, anchor: at('2026-10-01T17:00:00Z') };
    expect(isCycleStart({ year: 2026, month: 10, day: 4 }, spec, TZ)).toBe(true);
    expect(isCycleStart({ year: 2026, month: 10, day: 5 }, spec, TZ)).toBe(false);
    expect(cycleStartAt(at('2026-10-09T15:00:00Z'), spec, TZ).toISOString()).toBe('2026-10-07T05:00:00.000Z');
  });
});

describe('stats periods', () => {
  const now = at('2026-10-09T15:00:00Z'); // Friday 10:00 local

  it('weeks start on Sunday by default, or Monday', () => {
    const sun = periodBounds('week', now, TZ);
    expect(sun.start.toISOString()).toBe('2026-10-04T05:00:00.000Z');
    expect(sun.days).toBe(7);
    expect(periodBounds('week', now, TZ, 1).start.toISOString()).toBe('2026-10-05T05:00:00.000Z');
  });

  it('a DST week is still 7 days and a month knows its length', () => {
    const dstWeek = periodBounds('week', at('2026-11-03T15:00:00Z'), TZ);
    expect(dstWeek.days).toBe(7);
    expect(dstWeek.end.getTime() - dstWeek.start.getTime()).toBe(7 * 86_400_000 + 3_600_000);
    expect(periodBounds('month', at('2028-02-10T15:00:00Z'), TZ).days).toBe(29);
    expect(periodBounds('year', now, TZ).days).toBe(365);
  });

  it('points-per-day divides by the days elapsed so far', () => {
    const month = periodBounds('month', now, TZ);
    expect(elapsedDays(month, now, TZ)).toBe(9);
    expect(elapsedDays(month, at('2027-01-01T00:00:00Z'), TZ)).toBe(31);
  });

  it('parses dates strictly', () => {
    expect(parseLocalDate('2026-02-29')).toBeNull();
    expect(parseLocalDate('2028-02-29')).toEqual({ year: 2028, month: 2, day: 29 });
    expect(parseLocalDate('2026-1-5')).toBeNull();
  });
});
