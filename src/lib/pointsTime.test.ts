import { describe, expect, it } from 'vitest';
import { buyOptions, costCenti, extraTimeText, rateLabel } from './pointsTime';

describe('points for screen time', () => {
  it('costs points by the rate, rounding up to the hundredth', () => {
    expect(costCenti(15, 5)).toBe(300);
    expect(costCenti(10, 3)).toBe(334);
    expect(costCenti(30, 30)).toBe(100);
    expect(rateLabel(5)).toBe('1 point = 5 min');
  });

  it('offers what fits the day’s cap and the balance, and the most they can afford below a step', () => {
    expect(buyOptions({ balanceCenti: 2000, minutesPerPoint: 5, dailyCap: 60, boughtToday: 0 })).toEqual([
      { minutes: 15, costCenti: 300 },
      { minutes: 30, costCenti: 600 },
      { minutes: 60, costCenti: 1200 },
    ]);
    // 45 minutes left of the cap: 15, 30, and 45 as the most.
    expect(buyOptions({ balanceCenti: 2000, minutesPerPoint: 5, dailyCap: 60, boughtToday: 15 }).map((o) => o.minutes)).toEqual([
      15, 30, 45,
    ]);
    // 2.5 points at 5 min a point: 12.5 minutes, so 10.
    expect(buyOptions({ balanceCenti: 250, minutesPerPoint: 5, dailyCap: 60, boughtToday: 0 })).toEqual([
      { minutes: 10, costCenti: 200 },
    ]);
    expect(buyOptions({ balanceCenti: 50, minutesPerPoint: 5, dailyCap: 60, boughtToday: 0 })).toEqual([]);
    expect(buyOptions({ balanceCenti: 2000, minutesPerPoint: 5, dailyCap: 30, boughtToday: 30 })).toEqual([]);
    expect(buyOptions({ balanceCenti: -300, minutesPerPoint: 5, dailyCap: 30, boughtToday: 0 })).toEqual([]);
  });

  it('tells a supervisor what was bought and what’s left today', () => {
    expect(extraTimeText('Riley', 15, 300, 15)).toEqual({
      title: 'Riley spent 3 points on 15 min more',
      body: 'Their daily limits are 15 min longer today. They can buy 15 min more today.',
    });
    expect(extraTimeText('Riley', 30, 100, 0)).toEqual({
      title: 'Riley spent 1 point on 30 min more',
      body: 'Their daily limits are 30 min longer today. That was the most they can buy today.',
    });
  });
});
