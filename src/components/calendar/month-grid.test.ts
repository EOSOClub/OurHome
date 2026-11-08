import { describe, expect, it } from 'vitest';
import { gridDayKey, monthGridBounds } from './month-grid';

const bounds = (year: number, month: number) => {
  const { first, afterLast } = monthGridBounds({ year, month });
  return [gridDayKey(first), gridDayKey(afterLast)];
};

describe('monthGridBounds', () => {
  it('pads to whole Sunday-first weeks, into the next month', () => {
    // November 2026 starts on a Sunday; Dec 1 to 5 are the greyed days.
    expect(bounds(2026, 10)).toEqual(['2026-11-01', '2026-12-06']);
  });

  it('pads back into the previous year', () => {
    // January 2026 starts on a Thursday.
    expect(bounds(2026, 0)).toEqual(['2025-12-28', '2026-02-01']);
  });

  it('pads forward into the next year', () => {
    expect(bounds(2026, 11)).toEqual(['2026-11-29', '2027-01-03']);
  });

  it('is exactly four weeks for a February starting on a Sunday', () => {
    expect(bounds(2026, 1)).toEqual(['2026-02-01', '2026-03-01']);
  });

  it('is six weeks when the month needs them', () => {
    // August 2026 starts on a Saturday.
    expect(bounds(2026, 7)).toEqual(['2026-07-26', '2026-09-06']);
  });

  it('always starts on a Sunday, covers the month, and spans whole weeks', () => {
    for (let month = 0; month < 12; month += 1) {
      const { first, afterLast } = monthGridBounds({ year: 2027, month });
      const days = (afterLast.getTime() - first.getTime()) / 86_400_000;
      expect(first.getUTCDay()).toBe(0);
      expect(days % 7).toBe(0);
      expect(first.getTime()).toBeLessThanOrEqual(Date.UTC(2027, month, 1));
      expect(afterLast.getTime()).toBeGreaterThan(Date.UTC(2027, month + 1, 0));
      expect(days).toBeLessThan(7 * 7);
    }
  });
});
