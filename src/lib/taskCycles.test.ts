import { describe, expect, it } from 'vitest';
import {
  cycleStartAt,
  elapsedDays,
  isCycleStart,
  localDateOf,
  localTimeAt,
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

describe('zones whose clocks jump from midnight to 01:00', () => {
  // America/Santiago 2026-09-06 and America/Havana 2026-03-08 have no local
  // midnight: the day starts at 01:00. Returning 23:00 the evening before made
  // nextCycleStart return the same instant again and the roll-over spin forever.
  const SANTIAGO = 'America/Santiago';
  const HAVANA = 'America/Havana';

  it('the day starts at 01:00, never on the evening before', () => {
    expect(startOfLocalDate({ year: 2026, month: 9, day: 6 }, SANTIAGO).toISOString()).toBe('2026-09-06T04:00:00.000Z');
    expect(startOfLocalDate({ year: 2026, month: 9, day: 7 }, SANTIAGO).toISOString()).toBe('2026-09-07T03:00:00.000Z');
    expect(startOfLocalDate({ year: 2026, month: 3, day: 8 }, HAVANA).toISOString()).toBe('2026-03-08T05:00:00.000Z');
    expect(localDateOf(startOfLocalDate({ year: 2026, month: 9, day: 6 }, SANTIAGO), SANTIAGO)).toEqual({ year: 2026, month: 9, day: 6 });
  });

  it('a local time inside the skipped hour lands on its own day', () => {
    expect(localTimeAt({ year: 2026, month: 9, day: 6 }, 0, 30, SANTIAGO).toISOString()).toBe('2026-09-06T04:30:00.000Z');
    // Outside the gap nothing changes.
    expect(localTimeAt({ year: 2026, month: 9, day: 6 }, 12, 0, SANTIAGO).toISOString()).toBe('2026-09-06T15:00:00.000Z');
    expect(localTimeAt({ year: 2026, month: 3, day: 8 }, 12, 0, TZ).toISOString()).toBe('2026-03-08T17:00:00.000Z');
  });

  it('daily and weekly boundaries always move forward', () => {
    const eve = at('2026-09-05T16:00:00Z'); // Sat noon local
    const first = nextCycleStart(eve, { kind: 'daily' }, SANTIAGO);
    expect(first.toISOString()).toBe('2026-09-06T04:00:00.000Z');
    expect(nextCycleStart(first, { kind: 'daily' }, SANTIAGO).toISOString()).toBe('2026-09-07T03:00:00.000Z');
    // The old wrong boundary (23:00 on the eve) still moves on to the real one.
    expect(nextCycleStart(at('2026-09-06T03:00:00Z'), { kind: 'daily' }, SANTIAGO).toISOString()).toBe('2026-09-06T04:00:00.000Z');
    const sundays = { kind: 'weekdays' as const, days: [0] };
    expect(nextCycleStart(eve, sundays, SANTIAGO).toISOString()).toBe('2026-09-06T04:00:00.000Z');
    expect(cycleStartAt(at('2026-09-06T12:00:00Z'), sundays, SANTIAGO).toISOString()).toBe('2026-09-06T04:00:00.000Z');
    const havanaEve = at('2026-03-07T17:00:00Z');
    expect(nextCycleStart(havanaEve, { kind: 'daily' }, HAVANA).toISOString()).toBe('2026-03-08T05:00:00.000Z');
  });

  it('a loop like the roll-over finishes in a few steps', () => {
    for (const [zone, start, now] of [
      [SANTIAGO, '2026-09-05T16:00:00Z', '2026-09-08T16:00:00Z'],
      [HAVANA, '2026-03-07T17:00:00Z', '2026-03-10T17:00:00Z'],
      [TZ, '2026-03-07T17:00:00Z', '2026-03-10T17:00:00Z'],
      [TZ, '2026-10-31T17:00:00Z', '2026-11-03T17:00:00Z'],
      ['Asia/Tokyo', '2026-03-07T03:00:00Z', '2026-03-10T03:00:00Z'],
    ] as const) {
      let end = nextCycleStart(at(start), { kind: 'daily' }, zone);
      let steps = 0;
      while (end <= at(now) && steps < 50) {
        end = nextCycleStart(end, { kind: 'daily' }, zone);
        steps += 1;
      }
      expect(steps, zone).toBe(3);
    }
  });

  it('Tokyo (no DST) and Chicago are unchanged', () => {
    expect(startOfLocalDate({ year: 2026, month: 3, day: 8 }, 'Asia/Tokyo').toISOString()).toBe('2026-03-07T15:00:00.000Z');
    expect(nextCycleStart(at('2026-03-08T03:00:00Z'), { kind: 'daily' }, 'Asia/Tokyo').toISOString()).toBe('2026-03-08T15:00:00.000Z');
    expect(nextCycleStart(at('2026-03-07T18:00:00Z'), { kind: 'daily' }, TZ).toISOString()).toBe('2026-03-08T06:00:00.000Z');
    expect(nextCycleStart(at('2026-03-08T18:00:00Z'), { kind: 'daily' }, TZ).toISOString()).toBe('2026-03-09T05:00:00.000Z');
    expect(nextCycleStart(at('2026-10-31T18:00:00Z'), { kind: 'daily' }, TZ).toISOString()).toBe('2026-11-01T05:00:00.000Z');
    expect(nextCycleStart(at('2026-11-01T18:00:00Z'), { kind: 'daily' }, TZ).toISOString()).toBe('2026-11-02T06:00:00.000Z');
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

describe('every n weeks or months', () => {
  // Anchored Mon 2026-11-02 at noon: the on weeks are Nov 2, Nov 16, Nov 30.
  const anchor = at('2026-11-02T18:00:00Z');
  const biweekly = { kind: 'weekdays' as const, days: [1], everyWeeks: 2, anchor };

  it('every 2 weeks skips the Mondays between', () => {
    expect(isCycleStart({ year: 2026, month: 11, day: 2 }, biweekly, TZ)).toBe(true);
    expect(isCycleStart({ year: 2026, month: 11, day: 9 }, biweekly, TZ)).toBe(false);
    expect(isCycleStart({ year: 2026, month: 11, day: 16 }, biweekly, TZ)).toBe(true);
    // Weeks before the anchor count the same way.
    expect(isCycleStart({ year: 2026, month: 10, day: 19 }, biweekly, TZ)).toBe(true);
    expect(isCycleStart({ year: 2026, month: 10, day: 26 }, biweekly, TZ)).toBe(false);
    const wed = at('2026-11-11T15:00:00Z');
    expect(cycleStartAt(wed, biweekly, TZ).toISOString()).toBe('2026-11-02T06:00:00.000Z');
    expect(nextCycleStart(wed, biweekly, TZ).toISOString()).toBe('2026-11-16T06:00:00.000Z');
  });

  it('weeks are counted from the anchor’s Sunday, as the rule counts them', () => {
    // Anchored on a Saturday: its week began the Sunday before, so the Monday
    // two days later is in the next (off) week.
    const sat = { kind: 'weekdays' as const, days: [1], everyWeeks: 2, anchor: at('2026-11-07T18:00:00Z') };
    expect(isCycleStart({ year: 2026, month: 11, day: 2 }, sat, TZ)).toBe(true);
    expect(isCycleStart({ year: 2026, month: 11, day: 9 }, sat, TZ)).toBe(false);
  });

  it('every 3 months on the 1st', () => {
    const quarterly = { kind: 'monthdays' as const, days: [1], everyMonths: 3, anchor };
    expect(nextCycleStart(at('2026-11-10T15:00:00Z'), quarterly, TZ).toISOString()).toBe('2027-02-01T06:00:00.000Z');
    expect(cycleStartAt(at('2027-01-10T15:00:00Z'), quarterly, TZ).toISOString()).toBe('2026-11-01T05:00:00.000Z');
  });

  it('every 1 is the plain rule', () => {
    const weekly = { kind: 'weekdays' as const, days: [1], everyWeeks: 1, anchor };
    expect(isCycleStart({ year: 2026, month: 11, day: 9 }, weekly, TZ)).toBe(true);
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
