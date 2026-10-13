import { describe, expect, it } from 'vitest';
import {
  USAGE_TOP_APPS,
  formatMinutes,
  isPng,
  oldestKeptDay,
  tidyApps,
  usageDayLabel,
  usageIconUrl,
} from '@/lib/appUsage';

describe('app usage', () => {
  it('knows a PNG by its first bytes', () => {
    const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    expect(isPng(new Uint8Array([...sig, 0]))).toBe(true);
    // The signature alone is no picture.
    expect(isPng(new Uint8Array(sig))).toBe(false);
    expect(isPng(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0]))).toBe(false);
  });

  it('puts the app in the icon address safely', () => {
    expect(usageIconUrl('com.google.android.youtube')).toBe('/api/supervision/usage/icon?app=com.google.android.youtube');
    expect(usageIconUrl('a&b=c')).toBe('/api/supervision/usage/icon?app=a%26b%3Dc');
  });

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

  it('names the day as Today, Yesterday, or a short date', () => {
    expect(usageDayLabel('2026-10-12', '2026-10-12')).toBe('Today');
    expect(usageDayLabel('2026-10-11', '2026-10-12')).toBe('Yesterday');
    expect(usageDayLabel('2026-09-30', '2026-10-01')).toBe('Yesterday');
    expect(usageDayLabel('2026-10-10', '2026-10-12')).toBe('Oct 10');
  });

  it('keeps two weeks, counting the newest day, across a month end', () => {
    expect(oldestKeptDay('2026-10-12')).toBe('2026-09-29');
    expect(oldestKeptDay('2026-03-01')).toBe('2026-02-16');
  });
});
