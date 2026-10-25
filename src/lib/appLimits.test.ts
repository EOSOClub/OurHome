import { describe, expect, it } from 'vitest';
import { LIMIT_CHOICES, limitLabel, limitOptions, limitReachedText, limitsSummary } from './appLimits';

describe('daily limits', () => {
  it('words a limit as so much a day', () => {
    expect(limitLabel(60)).toBe('1 h a day');
    expect(limitLabel(90)).toBe('1 h 30 min a day');
    expect(limitLabel(45)).toBe('45 min a day');
  });

  it('offers the usual choices, plus a limit set to something else, in order', () => {
    expect(limitOptions()).toEqual([...LIMIT_CHOICES]);
    expect(limitOptions(60)).toEqual([...LIMIT_CHOICES]);
    expect(limitOptions(50)).toEqual([15, 30, 45, 50, 60, 90, 120, 180, 240, 300, 360]);
    expect(limitOptions(null)).toEqual([...LIMIT_CHOICES]);
  });

  it('tells a supervisor which limit was used up', () => {
    expect(limitReachedText('Riley', 'YouTube', 60)).toEqual({
      title: 'Riley used up their YouTube time for today',
      body: "Riley reached the 1 h a day limit for YouTube. It's closed on their phone until tomorrow.",
    });
    expect(limitReachedText('Riley', null, 180)).toEqual({
      title: 'Riley used up their app time for today',
      body: 'Riley reached their 3 h a day limit. Their apps are closed until tomorrow; calls and messages still work.',
    });
  });

  it('sums the limits up for the card, or nothing without any', () => {
    expect(limitsSummary(null, [])).toBeNull();
    expect(limitsSummary(180, [])).toBe('3 h a day in apps');
    expect(limitsSummary(null, [{ label: 'YouTube' }])).toBe('YouTube limited');
    expect(limitsSummary(120, [{ label: 'YouTube' }, { label: 'Roblox' }])).toBe('2 h a day in apps, 2 app limits');
  });
});
