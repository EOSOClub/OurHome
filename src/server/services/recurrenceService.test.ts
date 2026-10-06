import { describe, expect, it } from 'vitest';
import {
  computeNextRunAt,
  formatIntList,
  parseIntList,
  type NormalizedRule,
} from '@/server/services/recurrenceService';

const iso = (s: string) => new Date(s);

function rule(partial: Partial<NormalizedRule>): NormalizedRule {
  return {
    kind: 'daily',
    interval: 1,
    anchorDate: iso('2026-01-01T08:00:00.000Z'),
    ...partial,
  };
}

describe('parseIntList / formatIntList', () => {
  it('parses delimited strings into sorted unique numbers', () => {
    expect(parseIntList('5,1,3,1')).toEqual([1, 3, 5]);
  });
  it('returns undefined for empty/nullish', () => {
    expect(parseIntList('')).toBeUndefined();
    expect(parseIntList(null)).toBeUndefined();
  });
  it('round-trips through formatIntList', () => {
    expect(formatIntList([3, 1, 5])).toBe('1,3,5');
    expect(formatIntList([])).toBeNull();
    expect(formatIntList(undefined)).toBeNull();
  });
});

describe('computeNextRunAt — daily / interval', () => {
  it('daily advances one day, preserving anchor time', () => {
    const next = computeNextRunAt(
      rule({ kind: 'daily', interval: 1 }),
      iso('2026-01-01T09:00:00.000Z'),
    );
    expect(next?.toISOString()).toBe('2026-01-02T08:00:00.000Z');
  });

  it('interval of 2 days aligns to the anchor cadence', () => {
    const next = computeNextRunAt(
      rule({ kind: 'interval', interval: 2 }),
      iso('2026-01-01T09:00:00.000Z'),
    );
    expect(next?.toISOString()).toBe('2026-01-03T08:00:00.000Z');
  });

  it('returns the anchor itself when "from" is before it', () => {
    const next = computeNextRunAt(
      rule({ kind: 'daily', anchorDate: iso('2026-02-01T08:00:00.000Z') }),
      iso('2026-01-15T00:00:00.000Z'),
    );
    expect(next?.toISOString()).toBe('2026-02-01T08:00:00.000Z');
  });
});

describe('computeNextRunAt — weekly', () => {
  it('without byWeekday advances interval weeks', () => {
    const next = computeNextRunAt(
      rule({ kind: 'weekly', interval: 1 }),
      iso('2026-01-01T09:00:00.000Z'),
    );
    expect(next?.toISOString()).toBe('2026-01-08T08:00:00.000Z');
  });

  it('with byWeekday picks the next matching weekday', () => {
    // 2026-01-01 is a Thursday; next Monday (day 1) is 2026-01-05.
    const next = computeNextRunAt(
      rule({
        kind: 'weekly',
        byWeekday: [1],
        anchorDate: iso('2026-01-01T08:30:00.000Z'),
      }),
      iso('2026-01-01T10:00:00.000Z'),
    );
    expect(next?.toISOString()).toBe('2026-01-05T08:30:00.000Z');
  });

  it('with multiple weekdays picks the nearest upcoming one', () => {
    // From Thursday, set {Mon=1, Fri=5}; nearest upcoming is Friday 2026-01-02.
    const next = computeNextRunAt(
      rule({ kind: 'weekly', byWeekday: [1, 5] }),
      iso('2026-01-01T10:00:00.000Z'),
    );
    expect(next?.toISOString()).toBe('2026-01-02T08:00:00.000Z');
  });
});

describe('computeNextRunAt — monthly', () => {
  it('without byMonthday advances interval months', () => {
    const next = computeNextRunAt(
      rule({
        kind: 'monthly',
        interval: 3,
        anchorDate: iso('2026-01-15T08:00:00.000Z'),
      }),
      iso('2026-01-20T00:00:00.000Z'),
    );
    expect(next?.toISOString()).toBe('2026-04-15T08:00:00.000Z');
  });

  it('with byMonthday picks the next matching day-of-month', () => {
    const next = computeNextRunAt(
      rule({ kind: 'monthly', byMonthday: [1, 15] }),
      iso('2026-01-10T00:00:00.000Z'),
    );
    expect(next?.toISOString()).toBe('2026-01-15T08:00:00.000Z');
  });

  it('clamps by skipping months without the requested day', () => {
    // Day 31 from Feb 2026 (non-leap, 28 days) -> next valid is 2026-03-31.
    const next = computeNextRunAt(
      rule({ kind: 'monthly', byMonthday: [31] }),
      iso('2026-02-01T00:00:00.000Z'),
    );
    expect(next?.toISOString()).toBe('2026-03-31T08:00:00.000Z');
  });
});

describe('computeNextRunAt — until end date', () => {
  it('returns the next occurrence when it falls on or before until', () => {
    const next = computeNextRunAt(
      rule({ kind: 'daily', until: iso('2026-01-31T08:00:00.000Z') }),
      iso('2026-01-10T09:00:00.000Z'),
    );
    expect(next?.toISOString()).toBe('2026-01-11T08:00:00.000Z');
  });

  it('returns null once the next occurrence would be after until', () => {
    const next = computeNextRunAt(
      rule({ kind: 'daily', until: iso('2026-01-10T08:00:00.000Z') }),
      iso('2026-01-10T09:00:00.000Z'),
    );
    expect(next).toBeNull();
  });
});

describe('computeNextRunAt — unsupported', () => {
  it('returns null for cron (handled by external scheduler later)', () => {
    expect(
      computeNextRunAt(rule({ kind: 'cron', cron: '0 9 * * 1' }), new Date()),
    ).toBeNull();
  });

  it('always returns a date strictly after "from" for supported kinds', () => {
    const from = iso('2026-06-15T12:34:56.000Z');
    for (const kind of ['daily', 'interval', 'weekly', 'monthly'] as const) {
      const next = computeNextRunAt(rule({ kind }), from);
      expect(next).not.toBeNull();
      expect(next!.getTime()).toBeGreaterThan(from.getTime());
    }
  });
});
