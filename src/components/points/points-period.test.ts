import { describe, expect, it } from 'vitest';
import { nextPeriodDate } from '@/components/points/points-period';

// Today is Saturday 2026-11-07 in the household's zone.
const today = '2026-11-07';

describe('nextPeriodDate', () => {
  it('returns to now when Next reaches the current week', () => {
    // From last week (starting Sun Oct 25), Next is this week (Nov 1).
    expect(nextPeriodDate('week', '2026-11-01', today)).toBeNull();
  });

  it('keeps an earlier week dated', () => {
    expect(nextPeriodDate('week', '2026-10-25', today)).toBe('2026-10-25');
  });

  it('returns to now when Next reaches today in day view', () => {
    expect(nextPeriodDate('day', '2026-11-07', today)).toBeNull();
    expect(nextPeriodDate('day', '2026-11-06', today)).toBe('2026-11-06');
  });

  it('handles months of different lengths', () => {
    expect(nextPeriodDate('month', '2026-11-01', today)).toBeNull();
    expect(nextPeriodDate('month', '2026-10-01', today)).toBe('2026-10-01');
    // From January (31 days) to February: still a past month on March 2.
    expect(nextPeriodDate('month', '2026-02-01', '2026-03-02')).toBe('2026-02-01');
    expect(nextPeriodDate('month', '2026-12-01', '2026-12-31')).toBeNull();
  });

  it('handles years', () => {
    expect(nextPeriodDate('year', '2026-01-01', today)).toBeNull();
    expect(nextPeriodDate('year', '2025-01-01', today)).toBe('2025-01-01');
  });

  it('never moves to a future period', () => {
    expect(nextPeriodDate('week', '2026-11-08', today)).toBeNull();
  });
});
