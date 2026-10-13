import { describe, expect, it } from 'vitest';
import { USAGE_TOP_APPS, formatMinutes, oldestKeptDay, tidyApps } from '@/lib/appUsage';

describe('app usage', () => {
  it('says minutes the way people do', () => {
    expect(formatMinutes(0)).toBe('under a minute');
    expect(formatMinutes(45)).toBe('45 min');
    expect(formatMinutes(60)).toBe('1 h');
    expect(formatMinutes(125)).toBe('2 h 5 min');
  });

  it('merges an app reported twice, drops empty ones, and keeps the top ones', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ app: `a${i}`, label: `App ${i}`, minutes: i + 1 }));
    const tidy = tidyApps([...many, { app: 'a0', label: 'App 0', minutes: 100 }, { app: 'z', label: 'Z', minutes: 0 }]);
    expect(tidy).toHaveLength(USAGE_TOP_APPS);
    expect(tidy[0]).toEqual({ app: 'a0', label: 'App 0', minutes: 101 });
    expect(tidy.some((a) => a.app === 'z')).toBe(false);
  });

  it('keeps two weeks, counting the newest day, across a month end', () => {
    expect(oldestKeptDay('2026-10-12')).toBe('2026-09-29');
    expect(oldestKeptDay('2026-03-01')).toBe('2026-02-16');
  });
});
